import { describe, it, expect } from 'vitest';
import { renderRecordsText, compactLine } from '../../src/utils/render.js';

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
});
