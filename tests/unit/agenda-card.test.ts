import { describe, it, expect } from 'vitest';
import { splitAgenda, type AgendaItem } from '../../src/workflows/my-agenda.js';
import { compactRecord } from '../../src/utils/compact.js';

const item = (id: string, due: string | null): AgendaItem => ({
  id,
  title: id,
  due,
  start: null,
  status: null,
  category: null,
});

describe('bpm_my_agenda: splitAgenda', () => {
  it('делит по сроку относительно «сейчас» и конца сегодняшнего дня', () => {
    const now = new Date('2026-09-14T09:00:00Z'); // 12:00 по Москве
    const todayEnd = new Date('2026-09-14T21:00:00Z'); // полночь по Москве
    const result = splitAgenda(
      [
        item('вчера', '2026-09-13T10:00:00Z'),
        item('утром сегодня', '2026-09-14T06:00:00Z'),
        item('вечером сегодня', '2026-09-14T18:00:00Z'),
        item('завтра', '2026-09-15T08:00:00Z'),
        item('без срока', null),
      ],
      now,
      todayEnd
    );
    expect(result.overdue.map((i) => i.id)).toEqual(['вчера', 'утром сегодня']);
    expect(result.today.map((i) => i.id)).toEqual(['вечером сегодня']);
    expect(result.upcoming.map((i) => i.id)).toEqual(['завтра', 'без срока']);
  });
});

describe('bpm_record_card: compactRecord', () => {
  it('оставляет только заполненные поля без служебных', () => {
    expect(
      compactRecord({
        '@odata.context': 'x',
        Id: '410006e1-ca4e-4502-a9ec-e54d922d2c00',
        Name: 'Supervisor',
        Email: '',
        OwnerId: '00000000-0000-0000-0000-000000000000',
        AccountId: 'c131eaff-d637-4863-bc64-363ff8a4bc4d',
        AccountName: 'ООО «Ромашка»',
        ProcessListeners: 0,
        Notes: null,
        DoNotUseEmail: false,
        DoNotUseSms: true,
        Age: 0,
        BirthDate: '0001-01-01T00:00:00Z',
        TypeId: '60733efc-f36b-1410-a883-16d83cab0980',
        Account: { Name: 'ООО «Ромашка»' },
      })
    ).toEqual({
      Id: '410006e1-ca4e-4502-a9ec-e54d922d2c00',
      Name: 'Supervisor',
      AccountName: 'ООО «Ромашка»',
      DoNotUseSms: true,
      TypeId: '60733efc-f36b-1410-a883-16d83cab0980',
    });
  });
});
