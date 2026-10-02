/** Process execution requires a single-use plan; feed creation uses a durable UUID. */
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { BpmApiError, UnknownCollectionError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized, resolveRecordId } from './_guards.js';
import { assertGuid, isSafeIdentifier } from '../utils/odata.js';
import {
  confirmParam,
  confirmationTokenParam,
  confirmationResponse,
  createConfirmationPlan,
  consumeConfirmationPlan,
} from '../utils/confirm.js';
import {
  operationRecordId,
  writeToolError,
  writeFailureState,
  validateIdempotencyKey,
  validateRequiredCreateFields,
} from '../utils/write-safety.js';

function failure(error: unknown, collection?: string, extra: Record<string, unknown> = {}): CallToolResult {
  const output = { ...writeToolError(error, collection), ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
    isError: true,
  };
}
const planShape = {
  requires_confirmation: z.boolean().optional(),
  code: z.string().optional(),
  confirmation_token: z.string().optional(),
  state: z.enum(['succeeded', 'failed', 'outcome_unknown']).optional(),
};

export function registerProcessTools(server: McpServer, services: ServiceContainer): void {
  {
    const meta = getTool('bpm_run_process');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          process_name: z.string(),
          parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
          result_parameter_name: z.string().optional(),
          confirm: confirmParam,
          confirmation_token: confirmationTokenParam,
        },
        outputSchema: {
          ...planShape,
          process_name: z.string(),
          parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
          result_parameter_name: z.string().optional(),
          status: z.number().int().optional(),
          result: z.unknown().optional(),
          raw: z.string().optional(),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let started = false;
        try {
          await services.authManager.ensureAuthenticated();
          if (!isSafeIdentifier(params.process_name))
            throw new BpmApiError('Некорректное имя процесса.', 400);
          for (const [key, value] of Object.entries(params.parameters ?? {})) {
            if (
              !isSafeIdentifier(key) ||
              !['string', 'boolean', 'number'].includes(typeof value) ||
              (typeof value === 'number' && !Number.isFinite(value))
            )
              throw new BpmApiError(`Некорректный параметр процесса: ${key}.`, 400);
          }
          if (params.result_parameter_name !== undefined && !isSafeIdentifier(params.result_parameter_name))
            throw new BpmApiError('Некорректное имя выходного параметра.', 400);
          const operation = {
            tool: meta.name,
            process_name: params.process_name,
            parameters: params.parameters ?? {},
            result_parameter_name: params.result_parameter_name,
          };
          if (params.confirm !== true)
            return confirmationResponse(
              meta.name,
              [
                `Будет запущен процесс ${params.process_name}.`,
                JSON.stringify(operation.parameters, null, 2),
              ],
              {
                process_name: params.process_name,
                parameters: operation.parameters,
                result_parameter_name: params.result_parameter_name,
                confirmation_token: createConfirmationPlan(services, operation),
              }
            );
          consumeConfirmationPlan(services, params.confirmation_token, operation);
          started = true;
          const outcome = await services.processEngine.execute(params.process_name, operation.parameters, {
            resultParameterName: params.result_parameter_name,
          });
          const output = {
            process_name: params.process_name,
            status: outcome.status,
            state: 'succeeded' as const,
            result: outcome.result,
            raw: outcome.raw,
          };
          return {
            content: [
              {
                type: 'text',
                text: `Процесс ${params.process_name} запущен.\n${JSON.stringify(outcome.result ?? {}, null, 2)}`,
              },
            ],
            structuredContent: output,
          };
        } catch (error) {
          return failure(error, undefined, {
            process_name: params.process_name,
            ...(started
              ? {
                  state: writeFailureState(error),
                  next_steps: [
                    'Проверьте состояние процесса в BPMSoft. При неопределённом исходе не запускайте процесс повторно без проверки: платформа не предоставляет ключ повторяемости.',
                  ],
                }
              : {}),
          });
        }
      }
    );
  }
  {
    const meta = getTool('bpm_exec_process_element');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          element_uid: z.string().uuid(),
          confirm: confirmParam,
          confirmation_token: confirmationTokenParam,
        },
        outputSchema: {
          ...planShape,
          element_uid: z.string(),
          status: z.number().int().optional(),
          raw: z.string().optional(),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let started = false;
        try {
          await services.authManager.ensureAuthenticated();
          assertGuid(params.element_uid, 'element_uid');
          const operation = { tool: meta.name, element_uid: params.element_uid };
          if (params.confirm !== true)
            return confirmationResponse(
              meta.name,
              [`Будет возобновлён элемент процесса ${params.element_uid}.`],
              {
                element_uid: params.element_uid,
                confirmation_token: createConfirmationPlan(services, operation),
              }
            );
          consumeConfirmationPlan(services, params.confirmation_token, operation);
          started = true;
          const outcome = await services.processEngine.execProcElByUId(params.element_uid);
          return {
            content: [{ type: 'text', text: `Элемент процесса ${params.element_uid} возобновлён.` }],
            structuredContent: {
              element_uid: params.element_uid,
              status: outcome.status,
              raw: outcome.raw,
              state: 'succeeded',
            },
          };
        } catch (error) {
          return failure(error, undefined, {
            element_uid: params.element_uid,
            ...(started
              ? {
                  state: writeFailureState(error),
                  next_steps: ['Проверьте состояние элемента процесса в BPMSoft до повторного запуска.'],
                }
              : {}),
          });
        }
      }
    );
  }
  {
    const meta = getTool('bpm_post_feed');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        annotations: meta.annotations,
        inputSchema: {
          collection: z.string(),
          id: z.string(),
          message: z.string().trim().min(1),
          parent_id: z.string().uuid().optional(),
          idempotency_key: z.string().min(1).max(200).optional(),
        },
        outputSchema: {
          collection: z.string(),
          entity_id: z.string(),
          parent_id: z.string().optional(),
          social_message: z.record(z.string(), z.unknown()),
        },
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        let messageId: string | undefined;
        let started = false;
        try {
          await services.authManager.ensureAuthenticated();
          validateIdempotencyKey(params.idempotency_key);
          if (!params.message.trim())
            throw new BpmApiError('Сообщение не может быть пустым.', 400, 'SocialMessage');
          const ref = await services.metadataManager.resolveCollectionReference(params.collection);
          if (ref.name === null) throw new UnknownCollectionError(params.collection, ref.suggestions);
          const target = await resolveRecordId(services, ref.name, params.id);
          await services.odataClient.getRecord(ref.name, target.id);
          const schemaUId = await services.metadataManager.getEntitySchemaUId(ref.name);
          if (!schemaUId)
            throw new BpmApiError(
              `Не удалось определить UId схемы ${ref.name}. Сообщение не опубликовано.`,
              400,
              'SocialMessage'
            );
          if (params.parent_id) {
            assertGuid(params.parent_id, 'parent_id');
            const parent = await services.odataClient.getRecord<Record<string, unknown>>(
              'SocialMessage',
              params.parent_id
            );
            if (
              String(parent.EntityId).toLowerCase() !== target.id.toLowerCase() ||
              String(parent.EntitySchemaUId).toLowerCase() !== schemaUId.toLowerCase()
            )
              throw new BpmApiError(
                'Родительское сообщение относится к другой записи. Ответ не опубликован.',
                400,
                'SocialMessage'
              );
          }
          const body = {
            Message: params.message,
            EntitySchemaUId: schemaUId,
            EntityId: target.id,
            ...(params.parent_id ? { ParentId: params.parent_id } : {}),
          };
          const resolved = await services.lookupResolver.resolveDataLookups('SocialMessage', body);
          await validateRequiredCreateFields(services, 'SocialMessage', resolved.data);
          messageId = operationRecordId(services, params.idempotency_key, 'post-feed');
          started = true;
          const created = await services.odataClient.createRecord<Record<string, unknown>>(
            'SocialMessage',
            resolved.data,
            { id: messageId }
          );
          return {
            content: [{ type: 'text', text: `Сообщение опубликовано в ленту ${ref.name}(${target.id}).` }],
            structuredContent: {
              collection: ref.name,
              entity_id: target.id,
              parent_id: params.parent_id,
              social_message: created,
            },
          };
        } catch (error) {
          return failure(error, 'SocialMessage', {
            ...(messageId ? { message_id: messageId } : {}),
            ...(started ? { state: writeFailureState(error) } : {}),
          });
        }
      }
    );
  }
}
