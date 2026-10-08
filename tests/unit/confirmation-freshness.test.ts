import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import { runWithAuth } from '../../src/auth/request-context.js';
import { consumeConfirmationPlan, createConfirmationPlan } from '../../src/utils/confirm.js';

const service = (name: string): ServiceContainer =>
  ({
    config: { bpmsoft_url: `https://${name}.example`, username: name },
  }) as ServiceContainer;

const auth = (tenantId: string) => ({
  tenantId,
  csrfToken: `csrf-${tenantId}`,
  cookies: new Map([['.ASPXAUTH', `cookie-${tenantId}`]]),
});

const snapshot = (id = 'record-a', values: Record<string, unknown> = { Score: 5 }) => ({
  index: 0,
  id,
  values,
});

describe('confirmation freshness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts only the previously approved normalized intent and returns stale field detail', () => {
    const services = service('fresh-accepted');
    const relativeIntent = {
      tool: 'bpm_update_record',
      collection: 'Account',
      match_by: [{ field: 'ExternalCode', value: 'A-17' }],
      operations: [{ field: 'Score', op: 'increment', amount: 1 }],
    };
    const normalizedIntent = {
      tool: 'bpm_update_record',
      collection: 'Account',
      id: 'record-a',
      data: { Score: 6 },
    };
    const token = createConfirmationPlan(
      services,
      { preview: true },
      {
        intent: relativeIntent,
        acceptedIntents: [normalizedIntent],
        snapshots: [snapshot()],
      }
    );

    const conflict = consumeConfirmationPlan(
      services,
      token,
      { execution: normalizedIntent },
      {
        intent: normalizedIntent,
        snapshots: [snapshot('record-a', { Score: 4 })],
      }
    );

    expect(conflict?.changed).toEqual([
      {
        index: 0,
        id: 'record-a',
        fields: [{ field: 'Score', before: 5, current: 4 }],
      },
    ]);
  });

  it('distinguishes added and removed fields even when an added value is undefined', () => {
    const services = service('fresh-fields');
    const intent = { tool: 'bpm_update_by_filter', collection: 'Account', expected_count: 1 };
    const token = createConfirmationPlan(
      services,
      { preview: 1 },
      {
        intent,
        snapshots: [snapshot('record-a', { Kept: 'same', Removed: 'old' })],
      }
    );

    const conflict = consumeConfirmationPlan(
      services,
      token,
      { preview: 2 },
      {
        intent,
        snapshots: [snapshot('record-a', { Kept: 'same', Added: undefined })],
      }
    );

    expect(conflict?.changed[0].fields.map((field) => field.field)).toEqual(['Removed', 'Added']);
    expect(conflict?.changed[0].fields).toEqual([
      { field: 'Removed', before: 'old', current: undefined },
      { field: 'Added', before: undefined, current: undefined },
    ]);
  });

  it('rejects changed tool or collection intent even when an accepted normalized payload is unchanged', () => {
    const services = service('fresh-intent');
    const operationIntent = {
      tool: 'bpm_update_record',
      collection: 'Account',
      id: 'record-a',
      data: { Score: 6 },
    };
    const acceptedNormalized = {
      tool: 'bpm_update_record',
      collection: 'Account',
      id: 'record-a',
      data: { Score: 6 },
    };
    for (const changedIntent of [
      { ...operationIntent, tool: 'bpm_delete_record' },
      { ...operationIntent, collection: 'Contact' },
    ]) {
      const token = createConfirmationPlan(
        services,
        { preview: true },
        {
          intent: { operations: [{ field: 'Score', op: 'increment', amount: 1 }] },
          acceptedIntents: [acceptedNormalized],
          snapshots: [snapshot()],
        }
      );
      expect(() =>
        consumeConfirmationPlan(
          services,
          token,
          { preview: false },
          {
            intent: changedIntent,
            snapshots: [snapshot('record-a', { Score: 4 })],
          }
        )
      ).toThrow(/изменил|небходим|новый план/i);
    }
  });

  it('rejects added or removed targets instead of returning a freshness conflict', () => {
    const services = service('fresh-targets');
    const intent = { tool: 'bpm_batch_update', collection: 'Account', updates: [{ id: 'record-a' }] };
    for (const current of [
      [snapshot()],
      [snapshot(), { index: 1, id: 'record-b', values: { Score: 5 } }],
      [{ index: 0, id: 'record-b', values: { Score: 5 } }],
    ]) {
      const token = createConfirmationPlan(services, { preview: true }, { intent, snapshots: [snapshot()] });
      expect(() =>
        consumeConfirmationPlan(services, token, { preview: false }, { intent, snapshots: current })
      ).toThrow(/целев|операци|план/i);
    }
  });

  it('never returns freshness details for another auth scope, an expired token, or a reused token', () => {
    const services = service('fresh-scope');
    const intent = { tool: 'bpm_update_record', collection: 'Account', id: 'record-a', data: { Score: 6 } };
    const freshness = { intent, snapshots: [snapshot()] };
    const token = runWithAuth(auth('tenant-a'), () =>
      createConfirmationPlan(services, { preview: true }, freshness)
    );

    expect(() =>
      runWithAuth(auth('tenant-b'), () =>
        consumeConfirmationPlan(
          services,
          token,
          { preview: false },
          { intent, snapshots: [snapshot('record-a', { Score: 4 })] }
        )
      )
    ).toThrow(/пользователь|подключение/i);

    const consumed = runWithAuth(auth('tenant-a'), () =>
      consumeConfirmationPlan(services, token, { preview: true })
    );
    expect(consumed).toBeUndefined();
    expect(() =>
      runWithAuth(auth('tenant-a'), () =>
        consumeConfirmationPlan(
          services,
          token,
          { preview: false },
          {
            intent,
            snapshots: [snapshot('record-a', { Score: 4 })],
          }
        )
      )
    ).toThrow(/отсутствует|использовано|истекло/i);

    vi.useFakeTimers();
    const expiredToken = runWithAuth(auth('tenant-a'), () =>
      createConfirmationPlan(services, { preview: true }, freshness)
    );
    vi.advanceTimersByTime(10 * 60_000 + 1);
    expect(() =>
      runWithAuth(auth('tenant-a'), () =>
        consumeConfirmationPlan(
          services,
          expiredToken,
          { preview: false },
          {
            intent,
            snapshots: [snapshot('record-a', { Score: 4 })],
          }
        )
      )
    ).toThrow(/истекло|отсутствует/i);
  });

  it('compares against a cloned preview snapshot after the caller mutates its input', () => {
    const services = service('fresh-clone');
    const intent = { tool: 'bpm_update_record', collection: 'Account', id: 'record-a', data: { Score: 6 } };
    const values = { Score: 5 };
    const before = snapshot('record-a', values);
    const token = createConfirmationPlan(services, { preview: true }, { intent, snapshots: [before] });
    values.Score = 999;

    const conflict = consumeConfirmationPlan(
      services,
      token,
      { preview: false },
      {
        intent,
        snapshots: [snapshot('record-a', { Score: 4 })],
      }
    );

    expect(conflict?.changed[0].fields).toEqual([{ field: 'Score', before: 5, current: 4 }]);
  });
});
