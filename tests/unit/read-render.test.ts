import { describe, it, expect } from 'vitest';
import { renderRecordsText, compactLine } from '../../src/utils/render.js';
import { presentRecords } from '../../src/read/record-presentation.js';

describe('renderRecordsText: compact — строка на запись', () => {
  it('Id первым, колонка отображения вторым, пустые и заменённые именем uuid убраны', () => {
    const line = compactLine({
      '@odata.etag': 'x',
      Email: 'a@b.c',
      Name: 'Иван',
      Id: 'id-1',
      Notes: '',
      OwnerId: 'u-1',
      OwnerName: 'Петров',
      Amount: 0,
    });
    expect(line).toBe('Id=id-1; Name=Иван; Email=a@b.c; OwnerName=Петров');
  });

  it('показывает все записи до 50, остаток — одной строкой', () => {
    const records = Array.from({ length: 60 }, (_, i) => ({ Id: `id-${i}`, Title: `Задача ${i}` }));
    const text = renderRecordsText(records, { collection: 'Activity' });
    expect(text).toContain('Id=id-0; Title=Задача 0');
    expect(text).toContain('Id=id-49; Title=Задача 49');
    expect(text).not.toContain('id-50');
    expect(text).toContain('…и ещё 10 записей');
    expect(text).not.toContain('{');
  });

  it('format=full — прежний полный JSON', () => {
    const text = renderRecordsText([{ Id: 'id-1', Notes: '' }], { collection: 'Contact', format: 'full' });
    expect(text).toContain('"Notes": ""');
  });

  it('format=summary returns only collection, counts, and continuation status', () => {
    const text = renderRecordsText(
      [
        { Id: 'secret-id', Name: 'Sensitive record name' },
        { Id: 'another-id', Name: 'Another sensitive value' },
      ],
      {
        collection: 'Account',
        totalCount: 12,
        cursor: 'signed-cursor',
        format: 'summary',
      }
    );

    expect(text).toContain('Коллекция: Account');
    expect(text).toContain('Получено записей: 2');
    expect(text).toContain('Всего записей: 12');
    expect(text).toContain('Доступна следующая страница');
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('Sensitive record name');
    expect(text).not.toContain('signed-cursor');
  });

  it('format=summary stays concise for an empty page and reports the bounded continuation', () => {
    const text = renderRecordsText([], {
      collection: 'Contact',
      truncated: true,
      format: 'summary',
    });

    expect(text).toContain('Получено записей: 0');
    expect(text).toContain('Достигнут лимит max_records');
    expect(text).not.toContain('Данные:');
  });
});

describe('record presentation', () => {
  it('uses metadata captions and BPMSoft user timezone without changing raw records', async () => {
    const record = { Id: 'id-1', Name: 'Пример', CreatedOn: '2026-01-01T00:00:00.000Z' };
    const services = {
      metadataManager: {
        getEntityMetadata: async () => ({
          collectionName: 'Account',
          properties: [
            { name: 'Id', caption: 'Идентификатор', type: 'Edm.Guid' },
            { name: 'Name', caption: 'Название', type: 'Edm.String' },
            { name: 'CreatedOn', caption: 'Создано', type: 'Edm.DateTime' },
          ],
        }),
      },
      currentUser: { get: async () => ({ timeZoneId: 'America/Los_Angeles' }) },
    } as never;

    const result = await presentRecords(services, 'Account', [record], false);

    expect(record.CreatedOn).toBe('2026-01-01T00:00:00.000Z');
    expect(result.displayRecords[0]).toMatchObject({
      Название: 'Пример',
      Создано: expect.stringContaining('31.12.2025'),
    });
    expect(result.displayRecords[0].Создано).toContain('America/Los_Angeles');
    expect(result.fieldLabels).toMatchObject({ Name: 'Название', CreatedOn: 'Создано' });
  });
});
