/** Register a contact only after validating every supplied field and relation. */
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { BpmApiError, LookupResolutionError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';
import { executeFindOrCreate, prepareFindOrCreate, type FindOrCreatePlan } from './find-or-create.js';
import { escapeODataString, guidLiteral } from '../utils/odata.js';
import { assertPreparedCreate, prepareCreateIntent } from './create-preparation.js';
import {
  creationRecordIdWithScope,
  validateIdempotencyKey,
  MissingRequiredFieldsError,
  writeToolError,
  recordId,
  writeFailureState,
  type WriteState,
} from '../utils/write-safety.js';

interface Step {
  step: string;
  collection: string;
  id: string | null;
  state: WriteState;
  error?: string;
}
const stepShape = z.object({
  step: z.string(),
  collection: z.string(),
  id: z.string().nullable(),
  state: z.enum(['succeeded', 'failed', 'not_executed', 'outcome_unknown']),
  error: z.string().optional(),
});

async function findExistingContact(
  services: ServiceContainer,
  filter: string
): Promise<Record<string, unknown> | undefined> {
  const result = await services.odataClient.getRecords<Record<string, unknown>>(
    'Contact',
    { $filter: filter, $top: 2, $count: true },
    true,
    2
  );
  if (
    result['@odata.nextLink'] ||
    result.value.length > 1 ||
    (result['@odata.count'] !== undefined && result['@odata.count'] > 1)
  )
    throw new LookupResolutionError(
      'Contact',
      filter,
      Math.max(result.value.length, result['@odata.count'] ?? 2),
      result.value.map((row) => ({ id: recordId(row), displayValue: String(row.Name ?? recordId(row)) })),
      { lookupCollection: 'Contact', displayColumn: 'Name' }
    );
  return result.value[0];
}
function existingContactResult(
  record: Record<string, unknown>,
  accountId: string | null = null
): CallToolResult {
  const id = recordId(record);
  const output = {
    contact_id: id,
    contact_name: String(record.Name ?? id),
    account_id: accountId,
    account_created: false,
    contact_created: false,
    already_exists: true,
    warnings: [],
    outcomes: [{ step: 'contact', collection: 'Contact', id, state: 'succeeded' }],
  };
  return {
    content: [
      {
        type: 'text',
        text: `Контакт уже существует: ${output.contact_name} (${id}). Новый не создан; для отдельного контакта передайте force=true.`,
      },
    ],
    structuredContent: output,
  };
}

export function registerRegisterContactTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_register_contact');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      annotations: meta.annotations,
      inputSchema: {
        name: z.string().trim().min(1),
        email: z.string().optional(),
        phone: z.string().optional(),
        account_name: z.string().trim().min(1).optional(),
        account_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            'UUID существующего контрагента, в том числе из результата частично выполненного вызова.'
          ),
        position: z.string().optional(),
        force: z
          .boolean()
          .optional()
          .describe('Разрешить отдельную запись при совпадении Email или ФИО и контрагента.'),
        extra: z.record(z.string(), z.unknown()).optional(),
        idempotency_key: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Ключ одного намерения регистрации. Повтор использует те же UUID; при ошибке сначала проверьте outcomes.'
          ),
        idempotency_scope: z
          .enum(['session', 'user'])
          .optional()
          .describe(
            'user сохраняет UUID по tenant, адресу инстанса и подтверждённому пользователю BPMSoft; требует idempotency_key.'
          ),
      },
      outputSchema: {
        contact_id: z.string().nullable(),
        account_id: z.string().nullable(),
        account_created: z
          .boolean()
          .nullable()
          .describe(
            'true — создан этим вызовом, false — использован существующий; null — запись подтверждена после неопределённого ответа, факт создания этим вызовом неизвестен. При ошибке смотрите outcomes.'
          ),
        contact_created: z
          .boolean()
          .nullable()
          .describe(
            'true — создан этим вызовом, false — использован существующий или создание не выполнено; null — факт создания неизвестен. Состояние записи уточняется в outcomes.'
          ),
        warnings: z.array(z.string()),
        already_exists: z.boolean().optional(),
        contact_name: z.string().optional(),
        outcomes: z.array(stepShape),
      },
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      let accountId: string | null = null;
      let accountCreated: boolean | null = false;
      let contactCreated: boolean | null = false;
      let contactId: string | null = null;
      const outcomes: Step[] = [];
      let current: Step | undefined;
      let accountPlan: FindOrCreatePlan | undefined;
      try {
        await services.authManager.ensureAuthenticated();
        validateIdempotencyKey(params.idempotency_key);
        if (params.idempotency_scope === 'user' && params.idempotency_key === undefined)
          throw new BpmApiError('idempotency_scope=user требует idempotency_key.', 400, 'Contact');
        // All lookup and date coercion in this composite write uses one user,
        // timezone, and clock snapshot.
        const context = services.lookupResolver.createResolutionContext();
        const contactMeta = await services.metadataManager.getEntityMetadata('Contact');
        const warnings: string[] = [];
        if (typeof params.name !== 'string' || !params.name.trim()) {
          const field = contactMeta.properties.find((property) => property.name === 'Name');
          throw new MissingRequiredFieldsError('Contact', [
            { name: 'Name', caption: field?.caption ?? 'Name', type: field?.type ?? 'Edm.String' },
          ]);
        }
        if (params.account_name && params.account_id)
          throw new BpmApiError('Передайте account_name или account_id.', 400, 'Contact');
        if (params.email && !params.force) {
          const existing = await findExistingContact(
            services,
            `Email eq '${escapeODataString(params.email)}'`
          );
          if (existing) return existingContactResult(existing);
        }
        let accountField: string | undefined;
        if (params.account_name || params.account_id) {
          const fields = contactMeta.properties.filter((p) => p.isLookup && p.lookupCollection === 'Account');
          const primary = fields.find((field) => field.name === 'AccountId' || field.name === 'Account');
          if (!primary && fields.length !== 1)
            throw new BpmApiError(
              `Невозможно однозначно определить связь Contact → Account (${fields.length} полей). Ничего не создано.`,
              400,
              'Contact'
            );
          accountField = (primary ?? fields[0]).name;
          if (params.account_id) {
            await services.odataClient.getRecord('Account', params.account_id);
            accountId = params.account_id;
          } else {
            accountPlan = await prepareFindOrCreate(
              services,
              'Account',
              { field: 'Name', value: params.account_name! },
              { Name: params.account_name! },
              params.idempotency_key ? `${params.idempotency_key}:account` : undefined,
              context,
              params.idempotency_scope ?? 'session'
            );
            accountId = accountPlan.id;
          }
        }
        if (!params.email && !params.force && !accountPlan?.created) {
          const filter = `Name eq '${escapeODataString(params.name)}'${accountField && accountId ? ` and ${accountField} eq ${guidLiteral(accountId, services.config.odata_version)}` : ''}`;
          const existing = await findExistingContact(services, filter);
          if (existing) return existingContactResult(existing, accountId);
        }
        // Resolve extras first so alias collisions cannot silently override explicit intent.
        const extras = params.extra
          ? (await services.lookupResolver.resolveDataLookups('Contact', params.extra, context)).data
          : {};
        const explicit: Record<string, unknown> = { Name: params.name };
        if (params.email !== undefined) explicit.Email = params.email;
        if (params.phone !== undefined) explicit.Phone = params.phone;
        if (params.position !== undefined) {
          explicit.Job = params.position;
          const jobField = contactMeta.properties.find(
            (field) => field.name === 'Job' || field.name === 'JobId'
          );
          if (
            jobField?.isLookup &&
            jobField.lookupCollection &&
            contactMeta.properties.some((field) => field.name === 'JobTitle')
          ) {
            const job = await services.lookupResolver.resolve(
              jobField.lookupCollection,
              params.position,
              jobField.lookupDisplayColumn ?? 'Name',
              { fuzzy: true }
            );
            if (job.matchCount === 0) {
              delete explicit.Job;
              explicit.JobTitle = params.position;
              warnings.push(
                `Должность «${params.position}» не найдена в ${jobField.lookupCollection}; сохранена в JobTitle.`
              );
            }
          }
        }
        const base = await services.lookupResolver.resolveDataLookups('Contact', explicit, context);
        for (const [field, value] of Object.entries(extras)) {
          if (field in base.data && base.data[field] !== value)
            throw new BpmApiError(
              `Поле ${field} задано противоречиво через extra и явный параметр.`,
              400,
              'Contact'
            );
        }
        const contactData = { ...extras, ...base.data };
        if (accountField && accountId) {
          if (accountField in contactData && contactData[accountField] !== accountId)
            throw new BpmApiError(
              'Контрагент в extra конфликтует с account_name/account_id.',
              400,
              'Contact'
            );
          contactData[accountField] = accountId;
        }
        const contactPrepared = await prepareCreateIntent(services, 'Contact', contactData, context);
        assertPreparedCreate(contactPrepared, 'Contact');
        const normalizedContactData = contactPrepared.data;
        contactId = await creationRecordIdWithScope(
          services,
          normalizedContactData,
          params.idempotency_key,
          'register-contact:contact',
          params.idempotency_scope ?? 'session',
          context
        );
        if (accountPlan) {
          current = { step: 'account', collection: 'Account', id: accountPlan.id, state: 'not_executed' };
          const account = await executeFindOrCreate(services, accountPlan);
          accountId = account.id;
          accountCreated = account.created;
          outcomes.push({ ...current, state: 'succeeded' });
          current = undefined;
        } else if (accountId)
          outcomes.push({ step: 'account', collection: 'Account', id: accountId, state: 'succeeded' });
        current = { step: 'contact', collection: 'Contact', id: contactId, state: 'not_executed' };
        const result = await services.odataClient.createRecordWithOutcome<Record<string, unknown>>(
          'Contact',
          normalizedContactData,
          { id: contactId }
        );
        contactId = recordId(result.record);
        contactCreated = result.created;
        outcomes.push({ ...current, id: contactId, state: 'succeeded' });
        current = undefined;
        const output = {
          contact_id: contactId,
          account_id: accountId,
          account_created: accountCreated,
          contact_created: contactCreated,
          warnings: [
            ...warnings,
            ...(accountCreated === null
              ? ['Контрагент подтверждён по UUID, но неизвестно, создан ли он этим вызовом или ранее.']
              : []),
            ...(contactCreated === null
              ? ['Контакт подтверждён по UUID, но неизвестно, создан ли он этим вызовом или ранее.']
              : []),
          ],
          outcomes,
        };
        return {
          content: [
            {
              type: 'text',
              text: `Контакт зарегистрирован: ${params.name} (${contactId})${contactCreated === false ? ' — использован существующий' : contactCreated === null ? ' — запись подтверждена; факт создания неизвестен' : ' — создан'}${accountId ? `\nКонтрагент: ${accountId}${accountCreated === true ? ' — создан' : accountCreated === false ? ' — найден' : ' — запись подтверждена; факт создания неизвестен'}` : ''}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        if (current) {
          if (writeFailureState(error) === 'outcome_unknown') {
            if (current.step === 'account') accountCreated = null;
            if (current.step === 'contact') contactCreated = null;
          }
          outcomes.push({
            ...current,
            state: writeFailureState(error),
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (accountId && !outcomes.some((o) => o.step === 'account')) {
          outcomes.unshift({
            step: 'account',
            collection: 'Account',
            id: accountId,
            state: accountPlan?.created ? 'not_executed' : 'succeeded',
          });
        }
        if (!outcomes.some((o) => o.step === 'contact'))
          outcomes.push({ step: 'contact', collection: 'Contact', id: contactId, state: 'not_executed' });
        const formatted = writeToolError(error, 'Contact');
        const output = {
          ...formatted,
          contact_id: contactId,
          account_id: accountId,
          account_created: accountCreated,
          contact_created: contactCreated,
          warnings: [],
          outcomes,
          next_steps: outcomes.some((outcome) => outcome.step === 'account' && outcome.state === 'succeeded')
            ? [
                'Контрагент уже подтверждён. Используйте account_id из результата для продолжения; не создавайте его повторно.',
                'При неопределённом исходе создания контакта сначала проверьте contact_id. Повтор с тем же idempotency_key безопасен.',
              ]
            : formatted.next_steps,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: true,
        };
      }
    }
  );
}
