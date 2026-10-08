import { describe, expect, it } from 'vitest';
import { planBatchCreateSteps } from '../../src/tools/batch-step-references.js';

describe('batch create step references', () => {
  it('topologically orders dependencies while retaining their input indexes', () => {
    const plan = planBatchCreateSteps(
      [
        { alias: 'contact', collection: 'Contact', record: { AccountId: { $ref: 'account' } } },
        { alias: 'account', collection: 'Account', record: { Name: 'A' } },
        { alias: 'activity', collection: 'Activity', record: { ContactId: { $ref: 'contact' } } },
      ],
      ['Contact', 'Account', 'Activity']
    );
    expect(plan.order).toEqual([1, 0, 2]);
    expect([...plan.references.get(0)!]).toEqual([
      { field: 'AccountId', alias: 'account', targetCollection: 'Account' },
    ]);
  });

  it('rejects duplicate aliases, missing aliases, malformed reference objects, and cycles', () => {
    expect(() =>
      planBatchCreateSteps(
        [
          { alias: 'same', collection: 'Account', record: {} },
          { alias: 'same', collection: 'Account', record: {} },
        ],
        ['Account', 'Account']
      )
    ).toThrow(/несколько раз/);
    expect(() =>
      planBatchCreateSteps(
        [{ alias: 'a', collection: 'Account', record: { ParentId: { $ref: 'missing' } } }],
        ['Account']
      )
    ).toThrow(/Неизвестный alias/);
    expect(() =>
      planBatchCreateSteps(
        [{ alias: 'a', collection: 'Account', record: { ParentId: { $ref: 'a', extra: true } } }],
        ['Account']
      )
    ).toThrow(/иметь вид/);
    expect(() =>
      planBatchCreateSteps(
        [
          { alias: 'a', collection: 'Account', record: { ParentId: { $ref: 'b' } } },
          { alias: 'b', collection: 'Account', record: { ParentId: { $ref: 'a' } } },
        ],
        ['Account', 'Account']
      )
    ).toThrow(/цикл/);
  });
});
