/**
 * MCP Tools: BPMSoft outside OData.
 *
 * bpm_run_process          — execute a business process via ProcessEngineService.svc
 * bpm_exec_process_element — resume a paused process element by its UID
 * bpm_post_feed            — publish a message to a record's feed (SocialMessage)
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { BpmApiError, formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';

export function registerProcessTools(server: McpServer, services: ServiceContainer): void {
  // bpm_run_process
  {
    const meta = getTool('bpm_run_process');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          process_name: z
            .string()
            .describe('Имя процесса (схема), например: UsrCalculateLeadScore'),
          parameters: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional()
            .describe('Входные параметры процесса (передаются как query-string).'),
          result_parameter_name: z
            .string()
            .optional()
            .describe(
              'Имя выходного параметра процесса. Если задано — сервер вернёт его значение в поле result.'
            ),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const outcome = await services.processEngine.execute(
            params.process_name,
            params.parameters ?? {},
            { resultParameterName: params.result_parameter_name }
          );

          const lines: string[] = [
            `Процесс ${params.process_name} запущен (HTTP ${outcome.status}).`,
          ];
          if (params.result_parameter_name) {
            lines.push(`Результат (${params.result_parameter_name}):`);
            lines.push(
              outcome.result === undefined
                ? '(пусто)'
                : typeof outcome.result === 'string'
                  ? outcome.result
                  : JSON.stringify(outcome.result, null, 2)
            );
          } else if (outcome.raw) {
            lines.push('Сырое тело ответа:');
            lines.push(outcome.raw);
          }

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              process_name: params.process_name,
              status: outcome.status,
              result: outcome.result,
              raw: outcome.raw,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // bpm_exec_process_element
  {
    const meta = getTool('bpm_exec_process_element');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          element_uid: z
            .string()
            .describe('UID элемента процесса (GUID 8-4-4-4-12) для возобновления.'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const outcome = await services.processEngine.execProcElByUId(params.element_uid);

          return {
            content: [
              {
                type: 'text',
                text: [
                  `Элемент процесса ${params.element_uid} запущен (HTTP ${outcome.status}).`,
                  outcome.raw ? `Тело ответа: ${outcome.raw}` : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
              },
            ],
            structuredContent: {
              element_uid: params.element_uid,
              status: outcome.status,
              raw: outcome.raw,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // bpm_post_feed
  {
    const meta = getTool('bpm_post_feed');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z
            .string()
            .describe('Имя коллекции записи, к которой публикуется сообщение (например: Contact).'),
          id: z.string().describe('UUID записи, в ленте которой публикуется сообщение.'),
          message: z.string().describe('Текст сообщения.'),
          parent_id: z
            .string()
            .optional()
            .describe('UUID родительского сообщения (если это ответ на существующее).'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const collRef = await services.metadataManager.resolveCollectionReference(
            params.collection
          );
          if (collRef.name === null) {
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    `Коллекция "${params.collection}" не найдена в схеме.`,
                    collRef.suggestions.length
                      ? `Похоже на: ${collRef.suggestions.join(', ')}`
                      : 'Запросите список через bpm_get_collections.',
                  ].join('\n'),
                },
              ],
              isError: true,
            };
          }

          const body: Record<string, unknown> = {
            Message: params.message,
            EntitySchemaName: collRef.name,
            EntityId: params.id,
          };
          if (params.parent_id) {
            body.ParentId = params.parent_id;
          }

          let created: Record<string, unknown>;
          try {
            created = await services.odataClient.createRecord<Record<string, unknown>>(
              'SocialMessage',
              body
            );
          } catch (error) {
            if (error instanceof BpmApiError && error.httpStatus === 404) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'На этом инстансе нет коллекции SocialMessage; функция ленты не настроена.',
                  },
                ],
                isError: true,
              };
            }
            throw error;
          }

          return {
            content: [
              {
                type: 'text',
                text: `Сообщение опубликовано в ленту ${collRef.name}(${params.id}).`,
              },
            ],
            structuredContent: {
              collection: collRef.name,
              entity_id: params.id,
              parent_id: params.parent_id,
              social_message: created,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, 'SocialMessage');
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }
}
