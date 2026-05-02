/**
 * MCP Resources registration.
 *
 * URI scheme:
 *   bpmsoft://collections                  — list of all EntitySet names
 *   bpmsoft://collection/{name}            — collection card (schema + record_count)
 *   bpmsoft://schema/{name}                — schema only (faster, no count)
 *   bpmsoft://entity/{collection}/{id}     — single record (JSON + markdown card)
 *
 * All callbacks require services.initialized — otherwise they throw a
 * Russian-language error pointing the user at bpm_init.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from '../tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../types/index.js';

const NOT_INITIALIZED_MSG = 'Сервер не инициализирован, вызовите bpm_init';

function ensureInit(services: ServiceContainer): void {
  if (!services.initialized) {
    throw new Error(NOT_INITIALIZED_MSG);
  }
}

function jsonContent(uri: string, payload: unknown): ReadResourceResult['contents'][number] {
  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify(payload, null, 2),
  };
}

function markdownContent(uri: string, text: string): ReadResourceResult['contents'][number] {
  return {
    uri,
    mimeType: 'text/markdown',
    text,
  };
}

function summarizeProperty(p: EntityProperty): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: p.name,
    type: p.type,
    required: !p.nullable,
    isLookup: p.isLookup,
  };
  if (p.caption) out.caption = p.caption;
  if (p.isLookup) {
    out.lookup = {
      collection: p.lookupCollection,
      displayColumn: p.lookupDisplayColumn || 'Name',
    };
  }
  return out;
}

function buildSchemaCard(metadata: EntityMetadata): Record<string, unknown> {
  return {
    collection: metadata.collectionName,
    entity: metadata.name,
    properties: metadata.properties.map(summarizeProperty),
  };
}

function buildEntityMarkdown(collection: string, id: string, record: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`# ${collection} ${id}`);
  lines.push('');
  const name = (record['Name'] ?? record['Title'] ?? record['Subject']) as string | undefined;
  if (name) lines.push(`**${name}**`);
  lines.push('');
  lines.push('| Поле | Значение |');
  lines.push('| --- | --- |');
  const keys = Object.keys(record).filter((k) => !k.startsWith('@odata.'));
  for (const key of keys.slice(0, 30)) {
    const value = record[key];
    const display =
      value === null || value === undefined
        ? '—'
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    lines.push(`| ${key} | ${display} |`);
  }
  if (keys.length > 30) {
    lines.push('');
    lines.push(`_... и ещё ${keys.length - 30} полей в JSON-content._`);
  }
  return lines.join('\n');
}

export function registerResources(server: McpServer, services: ServiceContainer): void {
  // bpmsoft://collections — static
  server.registerResource(
    'bpmsoft_collections',
    'bpmsoft://collections',
    {
      title: 'Список коллекций BPMSoft',
      description:
        'Перечень всех доступных EntitySet (коллекций) BPMSoft с типами сущностей. Источник — $metadata.',
      mimeType: 'application/json',
    },
    async (uri) => {
      ensureInit(services);
      const sets = await services.metadataManager.getEntitySets();
      const payload = {
        count: sets.length,
        collections: sets,
      };
      return {
        contents: [jsonContent(uri.href, payload)],
      };
    }
  );

  // bpmsoft://collection/{name}
  server.registerResource(
    'bpmsoft_collection',
    new ResourceTemplate('bpmsoft://collection/{name}', { list: undefined }),
    {
      title: 'Карточка коллекции BPMSoft',
      description:
        'Структура коллекции: поля (имя, caption, тип, обязательность, lookup) и количество записей.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      ensureInit(services);
      const rawName = variables.name;
      const name = Array.isArray(rawName) ? rawName[0] : rawName;
      if (!name) {
        throw new Error('В URI bpmsoft://collection/{name} не указано имя коллекции');
      }

      try {
        const metadata = await services.metadataManager.getEntityMetadata(name);
        let recordCount: number | null = null;
        try {
          recordCount = await services.odataClient.getCount(metadata.collectionName);
        } catch (countErr) {
          console.error(
            `[resources] getCount failed for ${name}: ${countErr instanceof Error ? countErr.message : String(countErr)}`
          );
        }
        const payload = {
          ...buildSchemaCard(metadata),
          record_count: recordCount,
        };
        return {
          contents: [jsonContent(uri.href, payload)],
        };
      } catch {
        const resolved = await services.metadataManager.resolveCollectionReference(name);
        const suggestions =
          'suggestions' in resolved && resolved.suggestions ? resolved.suggestions : [];
        const lines = [
          `# Коллекция \`${name}\` не найдена`,
          '',
          'Проверьте имя EntitySet через ресурс `bpmsoft://collections` или инструмент `bpm_get_collections`.',
        ];
        if (suggestions.length > 0) {
          lines.push('', 'Похожие имена:');
          for (const s of suggestions) lines.push(`  • ${s}`);
        }
        return {
          contents: [markdownContent(uri.href, lines.join('\n'))],
        };
      }
    }
  );

  // bpmsoft://schema/{name} — schema only, no count
  server.registerResource(
    'bpmsoft_schema',
    new ResourceTemplate('bpmsoft://schema/{name}', { list: undefined }),
    {
      title: 'Схема коллекции BPMSoft',
      description:
        'Только схема коллекции (без подсчёта записей) — быстрее, чем bpmsoft://collection/{name}.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      ensureInit(services);
      const rawName = variables.name;
      const name = Array.isArray(rawName) ? rawName[0] : rawName;
      if (!name) {
        throw new Error('В URI bpmsoft://schema/{name} не указано имя коллекции');
      }
      const metadata = await services.metadataManager.getEntityMetadata(name);
      return {
        contents: [jsonContent(uri.href, buildSchemaCard(metadata))],
      };
    }
  );

  // bpmsoft://entity/{collection}/{id}
  server.registerResource(
    'bpmsoft_entity',
    new ResourceTemplate('bpmsoft://entity/{collection}/{id}', { list: undefined }),
    {
      title: 'Запись BPMSoft',
      description:
        'Полная запись по UUID. Возвращает JSON-содержимое и markdown-карточку с ключевыми полями.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      ensureInit(services);
      const rawCollection = variables.collection;
      const rawId = variables.id;
      const collection = Array.isArray(rawCollection) ? rawCollection[0] : rawCollection;
      const id = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!collection || !id) {
        throw new Error('В URI bpmsoft://entity/{collection}/{id} не указаны collection и/или id');
      }
      const record = await services.odataClient.getRecord<Record<string, unknown>>(collection, id);
      return {
        contents: [
          jsonContent(uri.href, record),
          markdownContent(uri.href, buildEntityMarkdown(collection, id, record)),
        ],
      };
    }
  );
}
