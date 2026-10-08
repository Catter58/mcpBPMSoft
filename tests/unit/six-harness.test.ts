import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSixState,
  inverseRelationEvidence,
  parseSixOptions,
  readSixState,
  safeRecord,
  startSixState,
  validateSixState,
} from '../../scripts/lib/six-harness.mjs';

const MARKER = 'six-test_2026';
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), 'six-harness-'));
  dirs.push(path);
  return path;
}

describe('Six fixture harness', () => {
  it('requires one fixed stage and private state credentials outside schema discovery', () => {
    expect(parseSixOptions(['--schema', '--auth', '/tmp/auth'])).toEqual({
      stage: 'schema',
      auth: '/tmp/auth',
    });
    expect(() =>
      parseSixOptions(['--exercise', '--auth', '/tmp/auth', '--state', '/tmp/state', '--marker', MARKER])
    ).not.toThrow();
    expect(() =>
      parseSixOptions([
        '--exercise',
        '--inspect',
        '--auth',
        '/tmp/auth',
        '--state',
        '/tmp/state',
        '--marker',
        MARKER,
      ])
    ).toThrow(/exactly one/);
    expect(() => parseSixOptions(['--schema', '--auth', '/tmp/auth', '--marker', 'unsafe marker'])).toThrow(
      /Marker/
    );
  });

  it('uses a complete, unique synthetic fixture and rejects altered owner state', () => {
    const state = createSixState(MARKER);
    expect(state.baseline).toEqual([5, 7, 11]);
    expect(state.target).toEqual([6, 8, 12]);
    expect(new Set([...state.account_ids, state.activity_id]).size).toBe(4);
    expect(() => validateSixState({ ...state, activity_title: 'another record' }, MARKER)).toThrow(
      /fixture values/
    );
    expect(() => validateSixState({ ...state, unexpected: true }, MARKER)).toThrow(/shape/);
    expect(safeRecord('Account', state.account_ids[0])).toMatchObject({ collection: 'Account' });
    expect(() => safeRecord('Contact', state.account_ids[0])).toThrow(/exact Account or Activity/);
    expect(() => safeRecord('Account', 'name')).toThrow(/exact Account or Activity/);
  });

  it('writes private state atomically and refuses to restart a started exercise', async () => {
    const dir = await tempDir();
    const path = join(dir, 'fixture-state.json');
    const state = await startSixState(path, MARKER);
    expect(state.stage_started).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readSixState(path, MARKER)).account_ids).toEqual(state.account_ids);
    await expect(startSixState(path, MARKER)).rejects.toThrow(/refusing to replay/);
    await chmod(path, 0o644);
    await expect(readSixState(path, MARKER)).rejects.toThrow(/Owner state is unavailable/);
  });

  it('reports inverse relationship identifiers without leaking the raw EDMX document', () => {
    const evidence = inverseRelationEvidence(
      { collection_navigations: [{ name: 'ActivityCollectionByAccount', target_collection: 'Activity' }] },
      { properties: [{ name: 'AccountId', lookupCollection: 'Account' }] },
      [{ from: 'Activity', field: 'AccountId', nav: 'Account', to: 'Account' }]
    );
    expect(evidence).toMatchObject({
      collection_navigation: { name: 'ActivityCollectionByAccount', target_collection: 'Activity' },
      lookup: { field: 'AccountId', lookup_collection: 'Account' },
      metadata_edge: { from: 'Activity', field: 'AccountId', navigation: 'Account', to: 'Account' },
    });
    expect(JSON.stringify(evidence)).not.toContain('<edmx');
  });
});
