import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  readOwnerFile,
  writeOwnerState,
} from './ux-harness.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAGES = new Set(['schema', 'exercise', 'inspect', 'cleanup']);

export function parseSixOptions(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error('Options must start with --.');
    const key = token.slice(2);
    if (STAGES.has(key)) {
      if (result.stage) throw new Error('Choose exactly one stage.');
      result.stage = key;
    } else if (['auth', 'state', 'marker'].includes(key)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
      result[key] = value;
    } else throw new Error(`Unsupported option: ${token}`);
  }
  if (!result.stage) throw new Error('Choose one stage.');
  if (!result.auth) throw new Error('Every stage requires --auth.');
  if (result.stage !== 'schema' && (!result.state || !result.marker))
    throw new Error('This stage requires --state and --marker.');
  if (result.marker && !/^[A-Za-z0-9_-]{8,64}$/.test(result.marker))
    throw new Error('Marker must be 8–64 safe ASCII characters.');
  return result;
}

export function createSixState(marker) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(marker ?? '')) throw new Error('Marker is invalid.');
  const ids = Array.from({ length: 4 }, () => randomUUID());
  return {
    version: 1,
    marker,
    account_ids: ids.slice(0, 3),
    activity_id: ids[3],
    account_names: ['A', 'B', 'C'].map((suffix) => `MCP SIX ${marker} ${suffix}`),
    shared_notes: `MCP SIX ${marker} shared-key`,
    activity_title: `MCP SIX ${marker} Activity`,
    baseline: [5, 7, 11],
    target: [6, 8, 12],
    stage_started: false,
    stage_completed: false,
    cleanup_started: false,
    cleanup_completed: false,
    plans: [],
    batch_plan: null,
    activity_plan: null,
    schema: null,
    evidence: null,
  };
}

export async function readSixState(path, marker) {
  let state;
  try {
    state = JSON.parse(await readOwnerFile(resolve(path)));
  } catch {
    throw new Error('Owner state is unavailable or is not valid private JSON.');
  }
  validateSixState(state, marker);
  return state;
}

export function validateSixState(state, marker) {
  const allowed = new Set([
    'version', 'marker', 'account_ids', 'activity_id', 'account_names', 'shared_notes',
    'activity_title', 'baseline', 'target', 'stage_started', 'stage_completed',
    'cleanup_started', 'cleanup_completed', 'plans', 'batch_plan', 'activity_plan', 'activity_expected', 'schema', 'evidence',
  ]);
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      Object.keys(state).some((key) => !allowed.has(key))) throw new Error('Owner state shape is invalid.');
  if (state.version !== 1 || state.marker !== marker || !/^[A-Za-z0-9_-]{8,64}$/.test(marker ?? ''))
    throw new Error('Owner state does not match this marker or version.');
  if (!Array.isArray(state.account_ids) || state.account_ids.length !== 3 || state.account_ids.some((id) => !UUID.test(id)) ||
      !UUID.test(state.activity_id) || new Set([...state.account_ids, state.activity_id].map((id) => id.toLowerCase())).size !== 4)
    throw new Error('Owner state fixture IDs are invalid.');
  if (JSON.stringify(state.account_names) !== JSON.stringify(['A', 'B', 'C'].map((suffix) => `MCP SIX ${marker} ${suffix}`)) ||
      state.shared_notes !== `MCP SIX ${marker} shared-key` || state.activity_title !== `MCP SIX ${marker} Activity` ||
      JSON.stringify(state.baseline) !== '[5,7,11]' || JSON.stringify(state.target) !== '[6,8,12]')
    throw new Error('Owner state fixture values do not match the marker and profile.');
  for (const key of ['stage_started', 'stage_completed', 'cleanup_started', 'cleanup_completed'])
    if (typeof state[key] !== 'boolean') throw new Error(`Owner state stage flag is invalid: ${key}.`);
  if (!Array.isArray(state.plans)) throw new Error('Owner state plans are invalid.');
  return state;
}

export async function startSixState(path, marker) {
  try {
    await lstat(resolve(path));
    throw new Error('Exercise state already exists; refusing to replay fixture writes.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const state = createSixState(marker);
  state.stage_started = true;
  await writeOwnerState(path, state);
  return state;
}

export function safeRecord(collection, id) {
  if (!['Account', 'Activity'].includes(collection) || !UUID.test(id ?? ''))
    throw new Error('Mutation requires an exact Account or Activity fixture ID.');
  return { collection, id: id.toLowerCase() };
}

export function fixtureProfile() {
  return {
    baseline: [5, 7, 11],
    target: [6, 8, 12],
    names: ['A', 'B', 'C'],
  };
}

export function inverseRelationEvidence(accountSchema, activitySchema, graphEdges = []) {
  const collectionNavigation = (accountSchema?.collection_navigations ?? [])
    .find((item) => item.name === 'ActivityCollectionByAccount' && item.target_collection === 'Activity');
  const accountLookup = (activitySchema?.properties ?? [])
    .find((property) => property.name === 'AccountId' && property.lookupCollection === 'Account');
  const edge = graphEdges.find((item) => item.from === 'Activity' && item.to === 'Account' && item.field === 'AccountId');
  return {
    collection_navigation: collectionNavigation
      ? { name: collectionNavigation.name, target_collection: collectionNavigation.target_collection }
      : null,
    lookup: accountLookup
      ? { field: accountLookup.name, lookup_collection: accountLookup.lookupCollection }
      : null,
    metadata_edge: edge ? { from: edge.from, field: edge.field, navigation: edge.nav, to: edge.to } : null,
    raw_edmx: { exposed: false, note: 'The public schema and lookup graph expose identifiers only; Partner/ReferentialConstraint were not returned.' },
  };
}

export { readOwnerFile, writeOwnerState };
