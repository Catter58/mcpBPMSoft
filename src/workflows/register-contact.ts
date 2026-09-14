/**
 * MCP Tool: bpm_register_contact
 *
 * Composite workflow: optional Account find-or-create + Contact creation
 * with auto-detected Contact->Account lookup field.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from '../tools/registry.js';
import { notInitialized } from '../tools/_guards.js';
import { escapeODataString, guidLiteral } from '../utils/odata.js';
import { findOrCreate } from './find-or-create.js';

async function findExistingContact(
  services: ServiceContainer,
  filter: string
): Promise<{ id: string; name: string } | null> {
  const res = await services.odataClient.getRecords<Record<string, unknown>>('Contact', {
    $filter: filter,
    $select: 'Id,Name',
    $top: 1,
  });
  const rec = res.value[0];
  return rec ? { id: String(rec.Id ?? ''), name: String(rec.Name ?? '') } : null;
}

function alreadyExists(
  existing: { id: string; name: string },
  by: string,
  accountId: string | null = null
): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `Контакт уже существует: ${existing.name} (${existing.id}), совпадение по ${by}. Новый не создан; чтобы создать всё равно, передайте force=true.`,
      },
    ],
    structuredContent: {
      contact_id: existing.id,
      contact_name: existing.name,
      account_id: accountId,
      account_created: false,
      contact_created: false,
      already_exists: true,
      warnings: [],
    },
  };
}

export function registerRegisterContactTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_register_contact');
  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        name: z.string().describe('ФИО контакта (обязательное поле Name)'),
        email: z.string().optional().describe('Email контакта'),
        phone: z.string().optional().describe('Телефон контакта'),
        account_name: z
          .string()
          .optional()
          .describe(
            'Название контрагента. Если указано — будет найден или создан Account и привязан к контакту.'
          ),
        position: z
          .string()
          .optional()
          .describe(
            'Должность контакта. Ищется в справочнике Job; если такой должности нет — сохраняется текстом в JobTitle.'
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            'Создать контакт, даже если уже есть контакт с тем же Email (или, без email, с тем же ФИО и контрагентом).'
          ),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Дополнительные поля контакта. Имена полей могут быть на русском (caption) или латинице.'
          ),
      },
      outputSchema: {
        contact_id: z.string(),
        account_id: z.string().nullable(),
        account_created: z.boolean(),
        contact_created: z.boolean(),
        already_exists: z.boolean().optional(),
        contact_name: z.string().optional(),
        warnings: z.array(z.string()),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const warnings: string[] = [];

        // Дубль по Email (сортировка БД регистронезависима) проверяем до find-or-create
        // контрагента, чтобы не создать лишний Account под уже существующий контакт.
        if (params.email && !params.force) {
          const existing = await findExistingContact(
            services,
            `Email eq '${escapeODataString(params.email)}'`
          );
          if (existing) return alreadyExists(existing, `Email "${params.email}"`);
        }

        let accountId: string | null = null;
        let accountCreated = false;
        if (params.account_name) {
          const accountResult = await findOrCreate(
            services,
            'Account',
            { field: 'Name', value: params.account_name },
            { Name: params.account_name }
          );
          accountId = accountResult.id;
          accountCreated = accountResult.created;
        }

        let accountField: string | null = null;
        if (accountId) {
          const contactMeta = await services.metadataManager.getEntityMetadata('Contact');
          const accountLookup = contactMeta.properties.find(
            (p) => p.isLookup && p.lookupCollection === 'Account'
          );
          if (accountLookup) {
            accountField = accountLookup.name;
          } else {
            warnings.push(
              'Не найдено связи Contact -> Account в метаданных; контакт создан без привязки к контрагенту.'
            );
          }
        }

        // Без email дубль ищем по ФИО (+ контрагент). Только что созданный контрагент
        // контактов иметь не может — проверку пропускаем.
        if (!params.email && !params.force && !accountCreated) {
          let filter = `Name eq '${escapeODataString(params.name)}'`;
          if (accountField && accountId) {
            filter += ` and ${accountField} eq ${guidLiteral(accountId, services.config.odata_version)}`;
          }
          const existing = await findExistingContact(services, filter);
          if (existing) {
            return alreadyExists(existing, accountField ? 'ФИО и контрагенту' : 'ФИО', accountId);
          }
        }

        const contactData: Record<string, unknown> = { Name: params.name };
        if (params.email !== undefined) contactData.Email = params.email;
        if (params.phone !== undefined) contactData.Phone = params.phone;
        if (params.position !== undefined) {
          contactData.Job = params.position;
          const jobRef = await services.metadataManager.resolveFieldReference('Contact', 'Job');
          const jobLookup = jobRef.name
            ? await services.metadataManager.getLookupInfo('Contact', jobRef.name)
            : null;
          const contactMeta = await services.metadataManager.getEntityMetadata('Contact');
          if (jobLookup && contactMeta.properties.some((p) => p.name === 'JobTitle')) {
            const job = await services.lookupResolver.resolve(
              jobLookup.lookupCollection,
              params.position,
              jobLookup.displayColumn,
              { fuzzy: true }
            );
            // Должности нет в справочнике — сохраняем текстом, а не падаем.
            // Неоднозначность (несколько кандидатов) остаётся ошибкой в resolveDataLookups.
            if (job.matchCount === 0) {
              delete contactData.Job;
              contactData.JobTitle = params.position;
              warnings.push(
                `Должность "${params.position}" не найдена в справочнике ${jobLookup.lookupCollection} — сохранена текстом в JobTitle.`
              );
            }
          }
        }
        if (accountField && accountId) contactData[accountField] = accountId;
        if (params.extra) {
          for (const [k, v] of Object.entries(params.extra)) {
            // explicit fields take precedence over `extra`
            if (k in contactData) continue;
            contactData[k] = v;
          }
        }

        const resolved = await services.lookupResolver.resolveDataLookups('Contact', contactData);
        for (const n of resolved.notes) {
          warnings.push(`Поле ${n.field}: "${n.input}" разрешено неточно как "${n.matchedValue}"`);
        }
        const created = await services.odataClient.createRecord<Record<string, unknown>>(
          'Contact',
          resolved.data
        );
        const contactId = String(
          (created as { Id?: unknown; id?: unknown }).Id ?? (created as { id?: unknown }).id ?? ''
        );

        return {
          content: [
            {
              type: 'text',
              text: [
                `Контакт зарегистрирован: ${params.name} (${contactId})`,
                accountId
                  ? `Контрагент: ${params.account_name} (${accountId})${accountCreated ? ' — создан' : ' — найден'}`
                  : '',
                warnings.length ? `Предупреждения: ${warnings.join('; ')}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
          structuredContent: {
            contact_id: contactId,
            account_id: accountId,
            account_created: accountCreated,
            contact_created: true,
            warnings,
          },
        };
      } catch (error) {
        const toolError = formatToolError(error, 'Contact');
        return {
          content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
          isError: true,
        };
      }
    }
  );
}
