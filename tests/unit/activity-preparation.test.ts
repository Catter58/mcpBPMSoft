import { describe, expect, it, vi } from 'vitest';
import type { ServiceContainer } from '../../src/tools/init-tool.js';
import type { EntityMetadata, EntityProperty } from '../../src/types/index.js';
import type { ResolutionContext } from '../../src/lookup/resolution-context.js';
import { coerceValue } from '../../src/utils/coerce.js';
import { prepareActivityData, reservePreparedActivity } from '../../src/workflows/activity-preparation.js';

const OWNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-07T11:42:00.000Z');

function property(
  name: string,
  type = 'Edm.String',
  lookupCollection?: string,
  navigationProperty?: string
): EntityProperty {
  return {
    name,
    type,
    nullable: true,
    isLookup: Boolean(lookupCollection),
    lookupCollection,
    navigationProperty,
  };
}

function setup(busy: Array<{ StartDate: string | null; DueDate: string | null }> = []) {
  const activity: EntityMetadata = {
    name: 'Activity',
    collectionName: 'Activity',
    properties: [
      property('Title'),
      property('Notes'),
      property('StartDate', 'Edm.DateTimeOffset'),
      property('DueDate', 'Edm.DateTimeOffset'),
      property('OwnerId', 'Edm.Guid', 'Contact', 'Owner'),
      property('TypeId', 'Edm.Guid', 'ActivityType'),
      property('ActivityCategoryId', 'Edm.Guid', 'ActivityCategory'),
      property('StatusId', 'Edm.Guid', 'ActivityStatus'),
    ],
    lookupFields: ['OwnerId', 'TypeId', 'ActivityCategoryId', 'StatusId'],
  };
  const getRecords = vi.fn(async () => ({
    value: busy.map((row, index) => ({ Id: String(index), ...row })),
  }));
  const context: ResolutionContext = {
    now: NOW,
    getCurrentUser: vi.fn(async () => ({
      userId: OWNER,
      contactId: OWNER,
      timeZoneId: 'Europe/Moscow',
      userName: 'Tester',
    })),
    getTimeZone: vi.fn(async () => ({ timeZone: 'Europe/Moscow', source: 'profile' as const })),
  };
  const services = {
    config: { odata_version: 4 },
    metadataManager: { getEntityMetadata: vi.fn(async () => activity) },
    odataClient: { getRecords },
    lookupResolver: {
      resolveDataLookups: vi.fn(async (_collection: string, data: Record<string, unknown>) => {
        const output = { ...data };
        for (const key of ['StartDate', 'DueDate']) {
          if (output[key] !== undefined)
            output[key] = coerceValue(key, output[key], 'Edm.DateTimeOffset', 'Europe/Moscow', {
              now: NOW,
              defaultHour: 12,
            }).value;
        }
        return { data: output, notes: [], coerced: [] };
      }),
      resolve: vi.fn(),
    },
  } as unknown as ServiceContainer;
  return { services, context, getRecords };
}

describe('prepareActivityData', () => {
  it('preserves native defaults when no date or type fields are supplied', async () => {
    const { services, context, getRecords } = setup();
    const prepared = await prepareActivityData(services, { title: 'Call' }, context);
    expect(prepared.data).toEqual({ Title: 'Call' });
    expect(getRecords).not.toHaveBeenCalled();
    expect(context.getTimeZone).not.toHaveBeenCalled();
  });

  it('retains value origins for current-user lookup and normalized relative dates', async () => {
    const { services, context } = setup();
    const prepared = await prepareActivityData(
      services,
      { title: 'Call', owner_name: 'я', start_date: 'завтра 15:00', end_date: 'завтра 15:30' },
      context
    );
    expect(prepared.origins).toEqual([
      { field: 'Title', source: 'caller' },
      { field: 'StartDate', source: 'normalized' },
      { field: 'DueDate', source: 'normalized' },
      { field: 'OwnerId', source: 'current_user' },
    ]);
  });

  it('chooses the first free 30-minute slot on the local target date', async () => {
    const { services, context, getRecords } = setup([
      { StartDate: '2026-10-08T06:00:00Z', DueDate: '2026-10-08T06:30:00Z' },
    ]);
    const prepared = await prepareActivityData(
      services,
      { title: 'Call', start_date: '2026-10-08' },
      context
    );
    expect(prepared.data.StartDate).toBe('2026-10-08T06:30:00.000Z');
    expect(prepared.data.DueDate).toBe('2026-10-08T07:00:00.000Z');
    expect(prepared.reservation?.ownerId).toBe(OWNER);
    expect(getRecords).toHaveBeenCalledOnce();
  });

  it('does not require a profile timezone or run availability reads for explicit-offset intervals', async () => {
    const { services, context, getRecords } = setup();
    context.getTimeZone = vi.fn(async () => {
      throw new Error('timezone should not be requested');
    });
    const prepared = await prepareActivityData(
      services,
      {
        title: 'Call',
        start_date: '2026-10-08T10:00:00+03:00',
        end_date: '2026-10-08T10:30:00+03:00',
      },
      context
    );
    expect(prepared.data.StartDate).toBe('2026-10-08T10:00:00+03:00');
    expect(prepared.data.DueDate).toBe('2026-10-08T10:30:00+03:00');
    expect(getRecords).not.toHaveBeenCalled();
  });

  it('reserves validated explicit intervals so later auto slots skip them', async () => {
    const { services, context } = setup();
    const fixed = await prepareActivityData(
      services,
      {
        title: 'Fixed',
        start_date: '2026-10-08T09:00:00+03:00',
        end_date: '2026-10-08T09:30:00+03:00',
      },
      context
    );
    reservePreparedActivity(context, fixed);
    const automatic = await prepareActivityData(
      services,
      { title: 'Auto', start_date: '2026-10-08' },
      context
    );
    expect(automatic.data.StartDate).toBe('2026-10-08T06:30:00.000Z');
    expect(automatic.data.DueDate).toBe('2026-10-08T07:00:00.000Z');
  });

  it('treats owner GUIDs case-insensitively in batch reservations', async () => {
    const { services, context } = setup();
    const fixed = await prepareActivityData(
      services,
      {
        title: 'Fixed',
        start_date: '2026-10-08T09:00:00+03:00',
        end_date: '2026-10-08T09:30:00+03:00',
        owner_name: OWNER.toUpperCase(),
      },
      context
    );
    reservePreparedActivity(context, fixed);
    const automatic = await prepareActivityData(
      services,
      { title: 'Auto', start_date: '2026-10-08' },
      context
    );
    expect(automatic.data.StartDate).toBe('2026-10-08T06:30:00.000Z');
  });

  it('rejects date-only bounds on different days and contradictory explicit durations', async () => {
    const { services, context } = setup();
    await expect(
      prepareActivityData(services, { start_date: '2026-10-08', end_date: '2026-10-09' }, context)
    ).rejects.toThrow(/должны совпадать/);
    await expect(
      prepareActivityData(
        services,
        {
          start_date: '2026-10-08T09:00:00+03:00',
          end_date: '2026-10-08T10:00:00+03:00',
          duration_minutes: 30,
        },
        context
      )
    ).rejects.toThrow(/противоречит/);
  });
});
