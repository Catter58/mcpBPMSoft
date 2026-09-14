/**
 * MCP Tool: bpm_get_relations — связи объекта и пути между объектами.
 *
 * Отвечает на «как связаны Контакт и Сделка» без чтения схемы целиком: граф
 * lookup-связей строится один раз на EDMX (MetadataManager.getLookupGraph),
 * пути ищутся BFS по нему в обе стороны.
 */

import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ServiceContainer } from './init-tool.js';
import type { LookupEdge, LookupGraph } from '../metadata/metadata-manager.js';
import { formatToolError } from '../utils/errors.js';
import { getTool } from './registry.js';
import { notInitialized, resolveCollectionName } from './_guards.js';

const DEFAULT_LIMIT = 50;
const MAX_DEPTH = 3;
const MAX_PATHS = 5;
/** Сколько путей одной длины собирать перед сортировкой — страховка от хабов вроде Contact. */
const PATH_CANDIDATES_CAP = 200;

/** Бизнес-объекты, которые чаще всего нужны в запросах, — в порядке важности. */
const BUSINESS_ORDER = [
  'Contact',
  'Account',
  'Activity',
  'Opportunity',
  'Lead',
  'Case',
  'Contract',
  'Invoice',
  'Order',
  'Project',
  'Document',
];

export type Direction = 'out' | 'in';

export interface PathStep {
  from: string;
  field: string;
  nav: string;
  to: string;
  direction: Direction;
}

export interface RelationPath {
  length: number;
  steps: PathStep[];
  /** С какой коллекции строить запрос; null — путь смешанный, нужны два запроса. */
  query_collection: string | null;
  criteria_field: string | null;
  odata_path: string | null;
  hint: string;
}

/** Имя сущности по имени коллекции: в v3 у всех EntitySet суффикс `Collection`. */
function entityName(graph: LookupGraph, set: string): string {
  return graph.odataVersion === 3 ? set.replace(/Collection$/, '') : set;
}

/** Системные и вспомогательные коллекции (Sys*, Vw*, ...Collection); для v3 — без суффикса. */
export function isAuxCollection(name: string): boolean {
  return /^(Sys|Vw)[A-Z0-9_]/.test(name) || /.Collection$/.test(name);
}

/** Чем меньше, тем выше в выдаче: бизнес-объекты, затем <Base>File / <Base>InTag, затем остальное. */
export function collectionRank(name: string, base?: string): number {
  const i = BUSINESS_ORDER.indexOf(name);
  if (i >= 0) return i;
  if (base && name === `${base}File`) return 100;
  if (base && name === `${base}InTag`) return 101;
  return 1000;
}

interface Neighbor {
  node: string;
  edge: LookupEdge;
  direction: Direction;
}

function neighbors(graph: LookupGraph, node: string): Neighbor[] {
  const out = (graph.outgoing.get(node) ?? []).map((edge) => ({
    node: edge.to,
    edge,
    direction: 'out' as const,
  }));
  const inc = (graph.incoming.get(node) ?? []).map((edge) => ({
    node: edge.from,
    edge,
    direction: 'in' as const,
  }));
  return [...out, ...inc];
}

/**
 * До 5 кратчайших путей source → target длиной ≤ 3 по lookup-рёбрам в обе стороны.
 * Сначала BFS от target даёт расстояния, затем DFS от source идёт только туда,
 * откуда target ещё достижим в оставшиеся шаги.
 */
export function findPaths(
  graph: LookupGraph,
  source: string,
  target: string,
  includeSystem = false
): RelationPath[] {
  const allowed = (n: string) =>
    n === source || n === target || includeSystem || !isAuxCollection(entityName(graph, n));

  const dist = new Map<string, number>([[target, 0]]);
  let frontier = [target];
  for (let d = 1; d <= MAX_DEPTH && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const u of frontier) {
      for (const { node } of neighbors(graph, u)) {
        if (dist.has(node) || !allowed(node)) continue;
        dist.set(node, d);
        next.push(node);
      }
    }
    frontier = next;
  }

  const result: RelationPath[] = [];
  const startLength = Math.max(1, dist.get(source) ?? MAX_DEPTH + 1);
  for (let length = startLength; length <= MAX_DEPTH && result.length < MAX_PATHS; length++) {
    const found: PathStep[][] = [];
    const visited = new Set([source]);
    const steps: PathStep[] = [];

    const walk = (u: string): void => {
      if (found.length >= PATH_CANDIDATES_CAP) return;
      const remaining = length - steps.length;
      for (const { node, edge, direction } of neighbors(graph, u)) {
        const last = remaining === 1;
        if (last ? node !== target : node === target || visited.has(node) || !allowed(node)) continue;
        if ((dist.get(node) ?? Infinity) > remaining - 1) continue;
        steps.push({ from: u, field: edge.field, nav: edge.nav, to: node, direction });
        if (last) {
          found.push([...steps]);
        } else {
          visited.add(node);
          walk(node);
          visited.delete(node);
        }
        steps.pop();
        if (found.length >= PATH_CANDIDATES_CAP) return;
      }
    };
    walk(source);

    const score = (p: PathStep[]) => {
      const reverse = p.filter((s) => s.direction === 'in').length;
      const middle = p.slice(0, -1).reduce((sum, s) => sum + collectionRank(entityName(graph, s.to)), 0);
      return reverse * 10000 + middle;
    };
    found.sort((a, b) => score(a) - score(b));
    for (const p of found.slice(0, MAX_PATHS - result.length)) {
      result.push(describePath(p, graph.odataVersion === 3));
    }
  }
  return result;
}

/**
 * Сегменты пути в порядке от коллекции запроса. v4: только навигации (`Account/Owner`).
 * v3: последним сегментом — FK-колонка (`Account/OwnerId`) — это обычное свойство
 * EntityType, фильтр по нему с `guid'…'` валиден в v3 без обращения к навигации.
 */
function pathSegments(ordered: PathStep[], v3: boolean): string[] {
  const navs = ordered.map((s) => s.nav);
  if (v3) navs[navs.length - 1] = ordered[ordered.length - 1].field;
  return navs;
}

/** Готовые criteria/OData-пути и подсказка на русском для одного пути. */
export function describePath(steps: PathStep[], v3 = false): RelationPath {
  const source = steps[0].from;
  const target = steps[steps.length - 1].to;
  const base = { length: steps.length, steps };

  if (steps.every((s) => s.direction === 'out')) {
    const segs = pathSegments(steps, v3);
    return {
      ...base,
      query_collection: source,
      criteria_field: segs.join('.'),
      odata_path: segs.join('/'),
      hint: `ищите в ${source} по полю ${segs.join('.')} = <Id ${target}>`,
    };
  }
  if (steps.every((s) => s.direction === 'in')) {
    const segs = pathSegments([...steps].reverse(), v3);
    return {
      ...base,
      query_collection: target,
      criteria_field: segs.join('.'),
      odata_path: segs.join('/'),
      hint: `ищите в ${target} по полю ${segs.join('.')} = <Id ${source}>`,
    };
  }

  // Смешанный путь: одним фильтром не выразить — разбиваем на отрезки одного направления.
  const parts: string[] = [];
  let i = 0;
  while (i < steps.length) {
    let j = i;
    while (j + 1 < steps.length && steps[j + 1].direction === steps[i].direction) j++;
    const run = steps.slice(i, j + 1);
    const from = run[0].from;
    const to = run[run.length - 1].to;
    if (run[0].direction === 'out') {
      parts.push(`возьмите у записи ${from} значение ${pathSegments(run, v3).join('.')} (Id ${to})`);
    } else {
      const segs = pathSegments([...run].reverse(), v3);
      parts.push(`ищите в ${to} по полю ${segs.join('.')} = <Id ${from}>`);
    }
    i = j + 1;
  }
  return {
    ...base,
    query_collection: null,
    criteria_field: null,
    odata_path: null,
    hint: parts.join(', затем '),
  };
}

function pathText(p: RelationPath): string {
  const chain = p.steps.map((s) => (s.direction === 'out' ? ` -${s.nav}-> ${s.to}` : ` <-${s.nav}- ${s.to}`));
  return `${p.steps[0].from}${chain.join('')}`;
}

export function registerRelationsTool(server: McpServer, services: ServiceContainer): void {
  const meta = getTool('bpm_get_relations');
  const stepShape = z.object({
    from: z.string(),
    field: z.string(),
    nav: z.string(),
    to: z.string(),
    direction: z.enum(['out', 'in']),
  });

  server.registerTool(
    meta.name,
    {
      title: meta.title,
      description: meta.description,
      inputSchema: {
        collection: z.string().describe('Коллекция: имя EntitySet или русская подпись («Контакт»)'),
        target: z
          .string()
          .optional()
          .describe('Вторая коллекция — тогда в ответе будут пути между ними (глубина до 3)'),
        direction: z
          .enum(['out', 'in', 'both'])
          .optional()
          .describe('out — lookup-поля коллекции, in — кто ссылается на неё, both (по умолчанию) — оба'),
        include_system: z
          .boolean()
          .optional()
          .describe('Показывать Sys*/Vw*-коллекции во входящих связях и путях (по умолчанию false)'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Сколько входящих связей вернуть (по умолчанию ${DEFAULT_LIMIT})`),
      },
      outputSchema: {
        collection: z.string(),
        target: z.string().optional(),
        outgoing: z
          .array(
            z.object({
              field: z.string(),
              nav: z.string(),
              target: z.string(),
              display_column: z.string().nullable(),
              caption: z.string().optional(),
            })
          )
          .optional(),
        incoming: z
          .array(z.object({ collection: z.string(), field: z.string(), nav: z.string() }))
          .optional(),
        incoming_total: z.number().int().optional(),
        paths: z
          .array(
            z.object({
              length: z.number().int(),
              steps: z.array(stepShape),
              query_collection: z.string().nullable(),
              criteria_field: z.string().nullable(),
              odata_path: z.string().nullable(),
              hint: z.string(),
            })
          )
          .optional(),
        note: z.string().optional(),
      },
      annotations: meta.annotations,
    },
    async (params): Promise<CallToolResult> => {
      if (!services.initialized) return notInitialized();
      try {
        await services.authManager.ensureAuthenticated();
        const graph = await services.metadataManager.getLookupGraph();
        // v3: «Contact» → «ContactCollection», если такой EntitySet есть.
        const resolve = (input: string) =>
          resolveCollectionName(
            services,
            graph.odataVersion === 3 && graph.displayColumns.has(`${input}Collection`)
              ? `${input}Collection`
              : input
          );
        const collection = await resolve(params.collection);
        const target = params.target ? await resolve(params.target) : undefined;
        const direction = params.direction ?? 'both';
        const includeSystem = params.include_system ?? false;
        const limit = params.limit ?? DEFAULT_LIMIT;

        const structured: Record<string, unknown> = { collection };
        const lines: string[] = [];

        if (graph.edgeCount === 0) {
          structured.note = 'В $metadata не найдено lookup-связей — смотрите bpm_get_schema.';
          lines.push(structured.note as string);
        }

        if (direction !== 'in') {
          let captions = new Map<string, string>();
          try {
            const entity = await services.metadataManager.getEntityMetadata(collection);
            captions = new Map(entity.properties.flatMap((p) => (p.caption ? [[p.name, p.caption]] : [])));
          } catch {
            // Подписи — только украшение; без них связи всё равно полезны.
          }
          const outgoing = (graph.outgoing.get(collection) ?? []).map((e) => ({
            field: e.field,
            nav: e.nav,
            target: e.to,
            display_column: graph.displayColumns.get(e.to) ?? null,
            ...(captions.has(e.field) ? { caption: captions.get(e.field) } : {}),
          }));
          structured.outgoing = outgoing;
          lines.push(`Исходящие связи ${collection} (${outgoing.length}):`);
          for (const o of outgoing) {
            lines.push(`  ${o.field} -> ${o.target}${o.caption ? ` «${o.caption}»` : ''}`);
          }
        }

        if (direction !== 'out') {
          const all = (graph.incoming.get(collection) ?? [])
            .filter((e) => includeSystem || !isAuxCollection(entityName(graph, e.from)))
            .sort(
              (a, b) =>
                collectionRank(entityName(graph, a.from), entityName(graph, collection)) -
                  collectionRank(entityName(graph, b.from), entityName(graph, collection)) ||
                a.from.localeCompare(b.from) ||
                a.field.localeCompare(b.field)
            );
          const incoming = all
            .slice(0, limit)
            .map((e) => ({ collection: e.from, field: e.field, nav: e.nav }));
          structured.incoming = incoming;
          structured.incoming_total = all.length;
          const shown = all.length > incoming.length ? `, показано ${incoming.length}` : '';
          lines.push(`Входящие связи на ${collection} (${all.length}${shown}):`);
          if (incoming.length > 0)
            lines.push(`  ${incoming.map((i) => `${i.collection}.${i.nav}`).join(', ')}`);
        }

        if (target) {
          structured.target = target;
          const paths = findPaths(graph, collection, target, includeSystem);
          structured.paths = paths;
          if (paths.length === 0) {
            lines.push(`Пути ${collection} -> ${target} длиной до ${MAX_DEPTH} не найдены.`);
          } else {
            lines.push(`Пути ${collection} -> ${target}:`);
            paths.forEach((p, n) => lines.push(`  ${n + 1}. ${pathText(p)}: ${p.hint}`));
          }
        }

        return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: structured };
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify(formatToolError(error), null, 2) }],
          isError: true,
        };
      }
    }
  );
}
