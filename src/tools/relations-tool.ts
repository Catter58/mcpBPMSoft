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
import { getAuthCacheScope } from '../auth/request-context.js';
import { getRelationshipReadSupport, setRelationshipReadSupport } from '../utils/server-capabilities.js';
import { getTool } from './registry.js';
import { compileCriteria, notInitialized, resolveCollectionName } from './_guards.js';

const DEFAULT_LIMIT = 50;
const MAX_DEPTH = 3;
const MAX_PATHS = 5;
/** Сколько путей одной длины собирать перед сортировкой — страховка от хабов вроде Contact. */
const PATH_CANDIDATES_CAP = 200;
const MAX_READ_PROBES = 8;
const MAX_READ_ROUTES = 8;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

type ReadProbeCapability = 'supported' | 'unsupported' | 'inconclusive' | 'not_probed';
type ReadProbeObservation = 'related_record_found' | 'no_related_record' | 'root_absent' | 'inconclusive';
type ReadProbeAttempt = {
  strategy: 'lookup_id' | 'filter' | 'expand' | 'exists';
  capability: ReadProbeCapability;
  cached?: boolean;
  http_status?: number;
  observation?: ReadProbeObservation;
  matched_count?: number;
  has_more?: boolean;
};

function queryStatus(error: unknown): number | undefined {
  const status =
    (error as { httpStatus?: unknown; status?: unknown } | null)?.httpStatus ??
    (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function isExplicitQueryRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /unknown (?:property|field|navigation)|invalid (?:property|field|navigation)|could not find (?:a )?(?:property|field|navigation)|not a valid (?:property|field|navigation)/i.test(
    message
  );
}

function readCapabilityKey(
  services: ServiceContainer,
  collection: string,
  edge: LookupEdge,
  strategy: string
): string {
  let instance = services.config.bpmsoft_url;
  try {
    instance = new URL(instance).origin;
    const configured = new URL(services.config.bpmsoft_url);
    instance = `${configured.origin}${configured.pathname.replace(/\/+$/, '')}`;
  } catch {
    /* Configuration validation reports invalid URLs elsewhere. */
  }
  const identity = getAuthCacheScope() || services.config.username || 'anonymous';
  return `${instance}:${identity}:v${services.config.odata_version}:${services.config.platform}:${collection}:${edge.from}:${edge.field}:${edge.nav}:${edge.to}:${strategy}`;
}

async function probeReadPath(
  services: ServiceContainer,
  collection: string,
  recordId: string,
  edge: LookupEdge,
  strategy: ReadProbeAttempt['strategy'],
  action: () => Promise<{
    observation: ReadProbeObservation;
    matched_count?: number;
    has_more?: boolean;
    next_read_args?: Record<string, unknown>;
  }>
): Promise<{ attempt: ReadProbeAttempt; next_read_args?: Record<string, unknown> }> {
  const key = readCapabilityKey(services, collection, edge, strategy);
  const known = getRelationshipReadSupport(key);
  if (known === false) return { attempt: { strategy, capability: 'unsupported', cached: true } };
  try {
    const observed = await action();
    const meaningful = observed.observation !== 'inconclusive';
    if (meaningful) setRelationshipReadSupport(key, true);
    return {
      attempt: {
        strategy,
        capability: meaningful ? 'supported' : 'inconclusive',
        ...(meaningful && known === true ? { cached: true } : {}),
        observation: observed.observation,
        ...(observed.matched_count === undefined ? {} : { matched_count: observed.matched_count }),
        ...(observed.has_more === undefined ? {} : { has_more: observed.has_more }),
      },
      ...(meaningful && observed.next_read_args ? { next_read_args: observed.next_read_args } : {}),
    };
  } catch (error) {
    const status = queryStatus(error);
    // Only a concrete 400 from this exact metadata-derived request marks this route unsupported.
    if (status === 400 && isExplicitQueryRejection(error)) {
      setRelationshipReadSupport(key, false);
      return { attempt: { strategy, capability: 'unsupported', http_status: status } };
    }
    return {
      attempt: {
        strategy,
        capability: 'inconclusive',
        ...(status === undefined ? {} : { http_status: status }),
        observation: 'inconclusive',
      },
    };
  }
}

async function probeReadPaths(
  services: ServiceContainer,
  graph: LookupGraph,
  collection: string,
  recordId: string,
  direction: 'out' | 'in' | 'both',
  target?: string,
  requestedLimit = MAX_READ_ROUTES
): Promise<Record<string, unknown>> {
  const allRoutes = [
    ...(direction !== 'in'
      ? (graph.outgoing.get(collection) ?? []).map((edge) => ({ edge, direction: 'out' as const }))
      : []),
    ...(direction !== 'out'
      ? (graph.incoming.get(collection) ?? []).map((edge) => ({ edge, direction: 'in' as const }))
      : []),
  ];
  const matchingRoutes = allRoutes.filter(
    ({ edge, direction: routeDirection }) =>
      !target || (routeDirection === 'out' ? edge.to === target : edge.from === target)
  );
  const routes = matchingRoutes.slice(0, Math.min(MAX_READ_ROUTES, Math.max(0, requestedLimit)));
  const result: Record<string, unknown> = {
    record_id: recordId,
    root_record: 'inconclusive',
    probe_limit: MAX_READ_PROBES,
    declared_direct_routes: matchingRoutes.length,
    probed_routes: 0,
    omitted_routes: Math.max(0, matchingRoutes.length - routes.length),
    routes: [],
    multi_hop: 'metadata_only_unverified',
  };
  let probesMade = 1;
  result.probes_made = probesMade;
  try {
    const root = await services.odataClient.getRecord<Record<string, unknown>>(collection, recordId, {
      $select: 'Id',
    });
    result.root_record =
      root?.Id && String(root.Id).toLowerCase() === recordId.toLowerCase() ? 'found' : 'inconclusive';
  } catch (error) {
    result.probes_made = probesMade;
    if (queryStatus(error) === 404) result.root_record = 'absent';
    else if (queryStatus(error) !== undefined) result.root_http_status = queryStatus(error);
    if (result.root_record !== 'found') return result;
  }
  if (result.root_record !== 'found') return result;

  const inspected: Array<Record<string, unknown>> = [];
  for (const { edge, direction } of routes.slice(0, MAX_READ_ROUTES)) {
    const attempts: ReadProbeAttempt[] = [];
    let nextRead: Record<string, unknown> | undefined;
    let reportedCollectionNavigation: string | undefined;
    let probesForRoute = 0;
    const run = async (
      strategy: ReadProbeAttempt['strategy'],
      action: () => Promise<{
        observation: ReadProbeObservation;
        matched_count?: number;
        has_more?: boolean;
        next_read_args?: Record<string, unknown>;
      }>,
      capabilityEdge: LookupEdge = edge
    ) => {
      if (probesMade >= MAX_READ_PROBES) return;
      const known = getRelationshipReadSupport(
        readCapabilityKey(services, collection, capabilityEdge, strategy)
      );
      if (known === false) {
        attempts.push({ strategy, capability: 'unsupported', cached: true });
        return;
      }
      probesMade++;
      probesForRoute++;
      const outcome = await probeReadPath(services, collection, recordId, capabilityEdge, strategy, action);
      attempts.push(outcome.attempt);
      if (outcome.next_read_args) nextRead = outcome.next_read_args;
    };

    if (direction === 'out') {
      await run('lookup_id', async () => {
        const row = await services.odataClient.getRecord<Record<string, unknown>>(collection, recordId, {
          $select: `Id,${edge.field}`,
        });
        const targetId = row?.[edge.field];
        if (targetId === null || targetId === '' || targetId === EMPTY_GUID)
          return { observation: 'no_related_record' };
        if (typeof targetId !== 'string' || !UUID_RE.test(targetId)) return { observation: 'inconclusive' };
        return {
          observation: 'related_record_found',
          matched_count: 1,
          next_read_args: {
            tool: 'bpm_get_record',
            arguments: {
              collection,
              id: recordId,
              select: `Id,${edge.field}`,
              resolve_lookups: false,
            },
          },
        };
      });
      if (
        services.config.odata_version === 4 &&
        !attempts.some((attempt) => attempt.capability === 'supported') &&
        probesMade < MAX_READ_PROBES
      ) {
        await run('expand', async () => {
          const row = await services.odataClient.getRecord<Record<string, unknown>>(collection, recordId, {
            $select: 'Id',
            $expand: `${edge.nav}($select=Id;$top=1)`,
          });
          const related = row?.[edge.nav];
          if (related === undefined) return { observation: 'inconclusive' };
          if (related === null) return { observation: 'no_related_record' };
          if (typeof related !== 'object' || Array.isArray(related)) return { observation: 'inconclusive' };
          const relatedId = (related as Record<string, unknown>).Id;
          if (typeof relatedId !== 'string' || !UUID_RE.test(relatedId) || relatedId === EMPTY_GUID)
            return { observation: 'inconclusive' };
          return {
            observation: 'related_record_found',
            matched_count: 1,
            next_read_args: {
              tool: 'bpm_get_record',
              arguments: {
                collection,
                id: recordId,
                select: 'Id',
                expand: `${edge.nav}($select=Id;$top=1)`,
                resolve_lookups: false,
              },
            },
          };
        });
      }
    } else {
      let collectionNavigation: string | undefined;
      try {
        const metadata = await services.metadataManager.getEntityMetadata(collection);
        collectionNavigation = metadata.navigationProperties?.find(
          (property) =>
            property.isCollection && property.targetCollection === edge.from && property.partner === edge.nav
        )?.name;
        reportedCollectionNavigation = collectionNavigation;
      } catch {
        // The child FK filter still provides a direct probe without inverse-navigation metadata.
      }
      await run('filter', async () => {
        const criteria = [{ field: edge.field, op: 'eq', value: recordId }];
        const compiled = await compileCriteria(services, edge.from, criteria, 'and', { autoCorrect: true });
        const response = await services.odataClient.getRecords<Record<string, unknown>>(
          edge.from,
          {
            $filter: compiled.filter,
            $select: `Id,${edge.field}`,
            $top: 1,
            $orderby: 'Id',
          },
          false,
          1
        );
        const hasMore = Boolean(response['@odata.nextLink']);
        const child = response.value[0];
        const observation: ReadProbeObservation =
          response.value.length === 0
            ? 'no_related_record'
            : child &&
                typeof child.Id === 'string' &&
                UUID_RE.test(child.Id) &&
                String(child[edge.field]).toLowerCase() === recordId.toLowerCase()
              ? 'related_record_found'
              : 'inconclusive';
        return {
          observation,
          ...(observation === 'inconclusive' ? {} : { matched_count: response.value.length }),
          has_more: hasMore,
          next_read_args: {
            tool: 'bpm_search_records',
            arguments: {
              collection: edge.from,
              criteria,
              join: 'and',
              select: `Id,${edge.field}`,
              top: 1,
              orderby: 'Id asc',
              auto_paginate: false,
              resolve_lookups: false,
            },
          },
        };
      });
      if (
        services.config.odata_version === 4 &&
        collectionNavigation &&
        !attempts.some((attempt) => attempt.capability === 'supported') &&
        probesMade < MAX_READ_PROBES
      ) {
        const collectionEdge: LookupEdge = { ...edge, nav: collectionNavigation };
        await run(
          'expand',
          async () => {
            const row = await services.odataClient.getRecord<Record<string, unknown>>(collection, recordId, {
              $select: 'Id',
              $expand: `${collectionNavigation}($select=Id;$top=1)`,
            });
            const related = row?.[collectionNavigation];
            if (related === undefined) return { observation: 'inconclusive' };
            if (!Array.isArray(related)) return { observation: 'inconclusive' };
            const first = related[0] as Record<string, unknown> | undefined;
            if (
              related.length > 0 &&
              (!first || typeof first.Id !== 'string' || !UUID_RE.test(first.Id) || first.Id === EMPTY_GUID)
            )
              return { observation: 'inconclusive' };
            return {
              observation: related.length ? 'related_record_found' : 'no_related_record',
              matched_count: related.length,
              has_more: related.length === 1,
              next_read_args: {
                tool: 'bpm_get_record',
                arguments: {
                  collection,
                  id: recordId,
                  select: 'Id',
                  expand: `${collectionNavigation}($select=Id;$top=1)`,
                  resolve_lookups: false,
                },
              },
            };
          },
          collectionEdge
        );
      }
      if (
        collectionNavigation &&
        !attempts.some((attempt) => attempt.capability === 'supported') &&
        probesMade < MAX_READ_PROBES
      ) {
        const collectionEdge: LookupEdge = { ...edge, nav: collectionNavigation };
        await run(
          'exists',
          async () => {
            const criteria = [
              { field: 'Id', op: 'eq', value: recordId },
              { field: collectionNavigation, op: 'exists' },
            ];
            const compiled = await compileCriteria(services, collection, criteria, 'and', {
              autoCorrect: true,
            });
            const response = await services.odataClient.getRecords<Record<string, unknown>>(
              collection,
              {
                $filter: compiled.filter,
                $select: 'Id',
                $top: 1,
                $orderby: 'Id',
              },
              false,
              1
            );
            const first = response.value[0];
            const observation: ReadProbeObservation =
              response.value.length === 0
                ? 'no_related_record'
                : first && typeof first.Id === 'string' && first.Id.toLowerCase() === recordId.toLowerCase()
                  ? 'related_record_found'
                  : 'inconclusive';
            return {
              observation,
              ...(observation === 'inconclusive' ? {} : { matched_count: response.value.length }),
              next_read_args: {
                tool: 'bpm_search_records',
                arguments: {
                  collection,
                  criteria,
                  join: 'and',
                  select: 'Id',
                  top: 1,
                  orderby: 'Id asc',
                  auto_paginate: false,
                  resolve_lookups: false,
                },
              },
            };
          },
          collectionEdge
        );
      }
    }
    const supported = attempts.some((attempt) => attempt.capability === 'supported');
    const allUnsupported =
      attempts.length > 0 && attempts.every((attempt) => attempt.capability === 'unsupported');
    inspected.push({
      declared: true,
      direction,
      collection: direction === 'out' ? edge.to : edge.from,
      field: edge.field,
      navigation: edge.nav,
      ...(reportedCollectionNavigation ? { collection_navigation: reportedCollectionNavigation } : {}),
      capability: supported ? 'supported' : allUnsupported ? 'unsupported' : 'inconclusive',
      observation:
        attempts.find((attempt) => attempt.capability === 'supported' && attempt.observation)?.observation ??
        attempts.find((attempt) => attempt.observation)?.observation ??
        'inconclusive',
      attempts,
      ...(nextRead ? { next_read: nextRead } : {}),
      ...(probesForRoute === 0 ? { note: 'probe_limit_reached_before_this_route' } : {}),
    });
  }
  result.probes_made = probesMade;
  result.probed_routes = inspected.filter((route) => !('note' in route)).length;
  result.routes = inspected;
  return result;
}

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
        probe_record_id: z
          .string()
          .optional()
          .describe(
            'Точный UUID записи collection для безопасной проверки поддерживаемых read paths; проверяются только ограниченные прямые связи.'
          ),
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
        read_probe: z.record(z.string(), z.unknown()).optional(),
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

        if (params.probe_record_id !== undefined) {
          if (!UUID_RE.test(params.probe_record_id))
            throw new Error('probe_record_id должен быть точным UUID.');
          structured.read_probe = await probeReadPaths(
            services,
            graph,
            collection,
            params.probe_record_id,
            direction,
            target,
            limit
          );
          const multiHopCount = target
            ? (structured.paths as RelationPath[]).filter((path) => path.length > 1).length
            : 0;
          (structured.read_probe as Record<string, unknown>).unverified_multi_hop_paths = multiHopCount;
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
