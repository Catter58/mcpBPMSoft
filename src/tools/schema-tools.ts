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
import { notInitialized, resolveCollectionName } from './_guards.js';
import { lookupCandidateShape } from './_schemas.js';
import { classifyRequiredCreateField } from '../utils/write-safety.js';

/** Сколько имён коллекций отдавать без явного limit. */
const COLLECTIONS_LIMIT = 100;
const defaultHintShape = z.object({
  source: z.enum(['none', 'constant', 'system_setting', 'runtime', 'unknown']),
  providedByServer: z.boolean().optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
});
const requiredFieldShape = z.object({
  name: z.string(),
  caption: z.string().nullable(),
  type: z.string(),
  provided_by_server: z.boolean(),
  default_hint: defaultHintShape.nullable(),
});

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
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              `Сколько имён вернуть (по умолчанию ${COLLECTIONS_LIMIT}). На типовом стенде коллекций больше тысячи — ` +
                'без pattern полный список только зря съест контекст.'
            ),
        },
        outputSchema: {
          count: z.number().int(),
          total: z.number().int(),
          has_more: z.boolean(),
          sets: z.array(z.object({ name: z.string(), entityType: z.string() })),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const all = await services.metadataManager.getEntitySets(params.pattern);
          if (all.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: params.pattern
                    ? `Коллекции по запросу "${params.pattern}" не найдены.`
                    : 'Список коллекций пуст.',
                },
              ],
              structuredContent: { count: 0, total: 0, has_more: false, sets: [] },
            };
          }

          const limit = params.limit ?? COLLECTIONS_LIMIT;
          const sets = all.slice(0, limit);
          const hasMore = all.length > sets.length;

          const list = sets.map((s) => `  - ${s.name} (${s.entityType})`).join('\n');
          const header = hasMore
            ? `Коллекций всего: ${all.length}, показано ${sets.length}. Сузьте выборку параметром pattern или поднимите limit.`
            : `Найдено коллекций: ${all.length}`;
          return {
            content: [{ type: 'text', text: `${header}\n\n${list}` }],
            structuredContent: { count: sets.length, total: all.length, has_more: hasMore, sets },
          };
        } catch (error) {
          const toolError = formatToolError(error);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            structuredContent: toolError as unknown as Record<string, unknown>,
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
        outputSchema: {
          collection: z.string(),
          entity: z.string(),
          property_count: z.number().int(),
          lookup_count: z.number().int(),
          collection_navigation_count: z.number().int(),
          collection_navigations: z.array(z.object({ name: z.string(), target_collection: z.string() })),
          has_captions: z.boolean(),
          required_fields: z.array(requiredFieldShape),
          caller_required_fields: z.array(requiredFieldShape),
          requirements_complete: z.boolean(),
          requirement_source: z.enum(['entity_schema_designer', 'unavailable']),
          unknown_requirement_fields: z.array(z.string()),
          requirement_notes: z.array(z.string()),
          properties: z.array(
            z.object({
              name: z.string(),
              caption: z.string().nullable(),
              type: z.string(),
              required: z.boolean().nullable(),
              nullable: z.boolean(),
              requirement_source: z.literal('entity_schema_designer').nullable(),
              default_hint: defaultHintShape.nullable(),
              isLookup: z.boolean(),
              lookupCollection: z.string().nullable(),
              lookupDisplayColumn: z.string().nullable(),
            })
          ),
          hint: z.string(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);
          const metadata = await services.metadataManager.getEntityMetadata(collection);

          const lines: string[] = [
            `Схема коллекции: ${metadata.name}`,
            `Endpoint: ${metadata.collectionName}`,
            `Всего полей: ${metadata.properties.length}`,
            `Lookup-полей: ${metadata.lookupFields.length}`,
            '',
            'Поля:',
          ];

          const hasCaptions = metadata.properties.some((p) => p.caption);
          const collectionNavigations = (metadata.navigationProperties ?? [])
            .filter((navigation) => navigation.isCollection)
            .map((navigation) => ({ name: navigation.name, target_collection: navigation.targetCollection }));
          const unknownRequirements = metadata.properties
            .filter((p) => p.required === undefined)
            .map((p) => p.name);
          const requirementSource = metadata.properties.some(
            (p) => p.requirementSource === 'entity_schema_designer'
          )
            ? ('entity_schema_designer' as const)
            : ('unavailable' as const);
          const requiredFields = metadata.properties
            .filter((p) => p.required === true)
            .map((p) => ({
              name: p.name,
              caption: p.caption ?? null,
              type: p.type,
              provided_by_server:
                classifyRequiredCreateField(p, {}) === 'provided_by_server' ||
                ((metadata.keyFields ?? ['Id']).includes(p.name) && p.type === 'Edm.Guid'),
              default_hint: p.defaultHint ?? null,
            }));
          const callerRequiredFields = requiredFields.filter((p) => !p.provided_by_server);
          const requirementNotes = [
            requirementSource === 'entity_schema_designer'
              ? 'Обязательность взята из requirementType схемы BPMSoft и отличается от допустимости null в OData.'
              : 'Описание обязательности полей BPMSoft недоступно. Допустимость null в OData не доказывает обязательность при создании.',
            'Системные настройки и runtime-значения по умолчанию вычисляет BPMSoft; возвращённые подсказки не нужно подставлять или исполнять.',
            'Условные правила страницы, процессы и серверные обработчики могут предъявлять дополнительные требования при сохранении.',
            ...(unknownRequirements.length
              ? [
                  `Для ${unknownRequirements.length} полей сведения об обязательности недоступны; required=null означает неизвестность.`,
                ]
              : []),
          ];

          for (const prop of metadata.properties) {
            const parts = [`  - ${prop.name}`];
            if (prop.caption) parts.push(`[${prop.caption}]`);
            parts.push(`: ${prop.type}`);
            if (prop.required === true) parts.push('(обязательное по схеме)');
            if (prop.required === undefined) parts.push('(обязательность неизвестна)');
            if (prop.defaultHint?.providedByServer === true)
              parts.push(`(значение по умолчанию: ${prop.defaultHint.source}, вычисляет сервер)`);
            if (prop.isLookup) parts.push(`→ lookup на ${prop.lookupCollection || '?'}`);
            lines.push(parts.join(' '));
          }
          lines.push(
            '',
            `Обязательные поля для данных пользователя: ${callerRequiredFields.map((p) => `${p.caption || p.name} (${p.name})`).join(', ') || 'не выявлены по доступному описанию'}`,
            ...requirementNotes
          );

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
              lines.push(
                `  - ${lf}${captionPart} → ${prop?.lookupCollection || '?'}.${prop?.lookupDisplayColumn || 'Name'}`
              );
            }
          }
          if (collectionNavigations.length > 0) {
            lines.push('', 'Коллекционные навигации (для criteria exists/not_exists в OData v4):');
            for (const navigation of collectionNavigations)
              lines.push(`  - ${navigation.name} → ${navigation.target_collection}`);
          }

          const propertyPairs = metadata.properties.map((p) => ({
            name: p.name,
            caption: p.caption ?? null,
            type: p.type,
            required: p.required ?? null,
            nullable: p.nullable,
            requirement_source: p.requirementSource ?? null,
            default_hint: p.defaultHint ?? null,
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
              collection_navigation_count: collectionNavigations.length,
              collection_navigations: collectionNavigations,
              has_captions: hasCaptions,
              required_fields: requiredFields,
              caller_required_fields: callerRequiredFields,
              requirements_complete: requirementSource !== 'unavailable' && unknownRequirements.length === 0,
              requirement_source: requirementSource,
              unknown_requirement_fields: unknownRequirements,
              requirement_notes: requirementNotes,
              properties: propertyPairs,
              hint: 'В bpm_create_record/bpm_update_record/bpm_search_records можно передавать ключи как на латинице (name), так и на русском (caption).',
            },
          };
        } catch (error) {
          const toolError = formatToolError(error, params.collection);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            structuredContent: toolError as unknown as Record<string, unknown>,
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
            .describe(
              'Каскадный нечёткий поиск при отсутствии точного совпадения: игнорирует кавычки/орг-формы/регистр («Ланит» найдёт «АО «ЛАНИТ»»). Default: true. false — только точный eq.'
            ),
        },
        outputSchema: {
          resolved: z.boolean(),
          id: z.string().optional(),
          fuzzy: z.boolean().optional(),
          match_type: z.enum(['exact', 'contains', 'core']).optional(),
          matched_value: z.string().optional(),
          matchCount: z.number().int().optional(),
          candidates: z.array(lookupCandidateShape).optional(),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          const collection = await resolveCollectionName(services, params.collection);

          const result = await services.lookupResolver.lookupValue(
            collection,
            params.field || 'Name',
            params.value,
            { fuzzy: params.fuzzy ?? true }
          );

          if (result.resolved) {
            const fuzzyNote =
              result.fuzzy && result.matchedValue ? `\n(неточное совпадение: "${result.matchedValue}")` : '';
            return {
              content: [
                {
                  type: 'text',
                  text: `Найдено: ${collection}.${params.field || 'Name'} = "${params.value}"\nUUID: ${result.id}${fuzzyNote}`,
                },
              ],
              structuredContent: {
                resolved: true,
                id: result.id,
                fuzzy: result.fuzzy ?? false,
                match_type: result.matchType,
                matched_value: result.matchedValue,
                candidates: result.candidates,
              },
            };
          }

          if (result.matchCount === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Значение "${params.value}" не найдено в ${collection}.${params.field || 'Name'}${(params.fuzzy ?? true) ? ' (даже при нечётком поиске)' : ''}`,
                },
              ],
              isError: true,
              structuredContent: { resolved: false, matchCount: 0 },
            };
          }

          const candidateList = result.candidates
            .map(
              (c, i) =>
                `  ${i + 1}. "${c.displayValue}"${c.score !== undefined ? ` [score ${c.score}]` : ''} (ID: ${c.id})`
            )
            .join('\n');

          return {
            content: [
              {
                type: 'text',
                text: `Найдено ${result.matchCount} совпадений для "${params.value}" в ${collection}.${params.field || 'Name'}:\n${candidateList}\n\nУточните значение (кандидаты отранжированы по релевантности) или передайте UUID напрямую.`,
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
            structuredContent: toolError as unknown as Record<string, unknown>,
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
          collection: z
            .string()
            .optional()
            .describe('Коллекция для поиска (если опущена — по уже загруженным схемам)'),
        },
        outputSchema: {
          count: z.number().int(),
          has_more: z.boolean(),
          results: z.array(
            z.object({
              collection: z.string(),
              fieldName: z.string(),
              caption: z.string(),
              type: z.string(),
              isLookup: z.boolean(),
            })
          ),
        },
        annotations: meta.annotations,
      },
      async (params): Promise<CallToolResult> => {
        if (!services.initialized) return notInitialized();
        try {
          await services.authManager.ensureAuthenticated();
          // Коллекция здесь необязательна: без неё ищем по всем загруженным схемам.
          const collection = params.collection
            ? await resolveCollectionName(services, params.collection)
            : undefined;

          if (collection) {
            await services.metadataManager.getEntityMetadata(collection);
          }

          const results = await services.metadataManager.findFieldByCaption(params.search, collection);

          if (results.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: collection
                    ? `Поле "${params.search}" не найдено в коллекции ${collection}.\nУбедитесь, что схема загружена (bpm_get_schema).`
                    : `Поле "${params.search}" не найдено.\nСначала загрузите нужные схемы через bpm_get_schema.`,
                },
              ],
              structuredContent: { count: 0, has_more: false, results: [] },
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
            structuredContent: { count: results.length, has_more: false, results },
          };
        } catch (error) {
          const toolError = formatToolError(error);
          return {
            content: [{ type: 'text', text: JSON.stringify(toolError, null, 2) }],
            structuredContent: toolError as unknown as Record<string, unknown>,
            isError: true,
          };
        }
      }
    );
  }
}
