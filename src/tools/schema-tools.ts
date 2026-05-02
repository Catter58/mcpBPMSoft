/**
 * MCP Tools: Schema & Lookup utilities
 *
 * bpm_get_collections — list available entity sets
 * bpm_get_schema      — schema for a collection
 * bpm_lookup_value    — manual lookup resolution (with optional fuzzy fallback)
 * bpm_find_field      — find field by caption
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized } from './_guards.js';

export function registerSchemaTools(server: McpServer, services: ServiceContainer): void {
  // bpm_get_collections
  {
    const meta = getTool('bpm_get_collections');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          pattern: z.string().optional().describe('Фильтр по имени (поиск подстроки, регистронезависимый)'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const sets = await services.metadataManager.getEntitySets(params.pattern);
          if (sets.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: params.pattern
                    ? `Коллекции по запросу "${params.pattern}" не найдены.`
                    : 'Список коллекций пуст.',
                },
              ],
              structuredContent: { count: 0, sets: [] },
            };
          }
          const list = sets.map((s) => `  - ${s.name} (${s.entityType})`).join('\n');
          return {
            content: [{ type: 'text', text: `Найдено коллекций: ${sets.length}\n\n${list}` }],
            structuredContent: { count: sets.length, sets },
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

  // bpm_get_schema
  {
    const meta = getTool('bpm_get_schema');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Имя коллекции (EntitySet)'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const metadata = await services.metadataManager.getEntityMetadata(params.collection);

          const lines: string[] = [
            `Схема коллекции: ${metadata.name}`,
            `Endpoint: ${metadata.collectionName}`,
            `Всего полей: ${metadata.properties.length}`,
            `Lookup-полей: ${metadata.lookupFields.length}`,
            '',
            'Поля:',
          ];

          const hasCaptions = metadata.properties.some((p) => p.caption);

          for (const prop of metadata.properties) {
            const parts = [`  - ${prop.name}`];
            if (prop.caption) parts.push(`[${prop.caption}]`);
            parts.push(`: ${prop.type}`);
            if (!prop.nullable) parts.push('(обязательное)');
            if (prop.isLookup) parts.push(`→ lookup на ${prop.lookupCollection || '?'}`);
            lines.push(parts.join(' '));
          }

          if (!hasCaptions) {
            lines.push('');
            lines.push('Примечание: локализованные названия колонок недоступны на этом экземпляре.');
            lines.push('Используйте английские имена полей для запросов.');
          }

          if (metadata.lookupFields.length > 0) {
            lines.push('');
            lines.push('Lookup-поля (поддерживают текстовый резолвинг):');
            for (const lf of metadata.lookupFields) {
              const prop = metadata.properties.find((p) => p.name === lf);
              const captionPart = prop?.caption ? ` [${prop.caption}]` : '';
              lines.push(`  - ${lf}${captionPart} → ${prop?.lookupCollection || '?'}.${prop?.lookupDisplayColumn || 'Name'}`);
            }
          }

          const propertyPairs = metadata.properties.map((p) => ({
            name: p.name,
            caption: p.caption ?? null,
            type: p.type,
            required: !p.nullable,
            isLookup: p.isLookup,
            lookupCollection: p.lookupCollection ?? null,
            lookupDisplayColumn: p.lookupDisplayColumn ?? null,
          }));

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: {
              collection: metadata.collectionName,
              entity: metadata.name,
              property_count: metadata.properties.length,
              lookup_count: metadata.lookupFields.length,
              has_captions: hasCaptions,
              properties: propertyPairs,
              hint:
                'В bpm_create_record/bpm_update_record/bpm_search_records можно передавать ключи как на латинице (name), так и на русском (caption).',
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // bpm_lookup_value
  {
    const meta = getTool('bpm_lookup_value');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          collection: z.string().describe('Коллекция-справочник для поиска'),
          field: z.string().optional().describe('Поле для поиска (по умолчанию Name)'),
          value: z.string().describe('Искомое значение'),
          fuzzy: z
            .boolean()
            .optional()
            .describe('При отсутствии точного совпадения повторять поиск через contains() (default: false)'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          const result = await services.lookupResolver.lookupValue(
            params.collection,
            params.field || 'Name',
            params.value,
            { fuzzy: params.fuzzy }
          );

          if (result.resolved) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Найдено: ${params.collection}.${params.field || 'Name'} = "${params.value}"\nUUID: ${result.id}`,
                },
              ],
              structuredContent: { resolved: true, id: result.id, candidates: result.candidates },
            };
          }

          if (result.matchCount === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Значение "${params.value}" не найдено в ${params.collection}.${params.field || 'Name'}${params.fuzzy ? ' (даже при нечётком поиске)' : ''}`,
                },
              ],
              isError: true,
              structuredContent: { resolved: false, matchCount: 0 },
            };
          }

          const candidateList = result.candidates
            .map((c, i) => `  ${i + 1}. "${c.displayValue}" (ID: ${c.id})`)
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `Найдено ${result.matchCount} ${params.fuzzy ? 'нечёткое' : ''} совпадений для "${params.value}" в ${params.collection}.${params.field || 'Name'}:\n${candidateList}\n\nУточните значение для точного совпадения.`,
              },
            ],
            structuredContent: {
              resolved: false,
              matchCount: result.matchCount,
              candidates: result.candidates,
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            isError: true,
          };
        }
      }
    );
  }

  // bpm_find_field
  {
    const meta = getTool('bpm_find_field');
    server.registerTool(
      meta.name,
      {
        title: meta.title,
        description: meta.description,
        inputSchema: {
          search: z.string().describe('Текст для поиска по русскому или английскому названию'),
          collection: z.string().optional().describe('Коллекция для поиска (если опущена — по уже загруженным схемам)'),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();

          if (params.collection) {
            await services.metadataManager.getEntityMetadata(params.collection);
          }

          const results = await services.metadataManager.findFieldByCaption(params.search, params.collection);

          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: params.collection
                    ? `Поле "${params.search}" не найдено в коллекции ${params.collection}.\nУбедитесь, что схема загружена (bpm_get_schema).`
                    : `Поле "${params.search}" не найдено.\nСначала загрузите нужные схемы через bpm_get_schema.`,
                },
              ],
              structuredContent: { count: 0, results: [] },
            };
          }

          const lines = [`Найдено полей по запросу "${params.search}": ${results.length}`, ''];
          for (const r of results) {
            const captionPart = r.caption ? ` [${r.caption}]` : '';
            const lookupPart = r.isLookup ? ' (lookup)' : '';
            lines.push(`  ${r.collection}.${r.fieldName}${captionPart}: ${r.type}${lookupPart}`);
          }
          lines.push('');
          lines.push('Используйте английское имя поля (fieldName) в OData-запросах.');

          return {
            content: [{ type: 'text', text: lines.join('\n') }],
            structuredContent: { count: results.length, results },
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
}
