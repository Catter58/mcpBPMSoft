/**
 * Компактный вид записи BPMSoft для текстового ответа модели: сырая запись — это ~80
 * полей, большая часть которых пустые ссылки и значения по умолчанию.
 */

import { displayKeyFor } from './display.js';

const NOISE_COLUMNS = new Set(['ProcessListeners', 'Data', 'MailHash', 'HeaderProperties']);
const EMPTY_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * Только содержательные поля: без @odata.*, служебных колонок, вложенных объектов и значений
 * «по умолчанию» (null, '', нулевой guid, 0001-01-01, false, 0). Uuid связи убирается, если
 * рядом есть её имя (CreatedById при CreatedByName) — полная запись есть в bpm_get_record.
 */
export function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const isDefault = (value: unknown) =>
    value === null ||
    value === undefined ||
    value === '' ||
    value === false ||
    value === 0 ||
    value === EMPTY_GUID ||
    (typeof value === 'string' && value.startsWith('0001-01-01'));
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key, value]) =>
        !key.startsWith('@odata.') &&
        !NOISE_COLUMNS.has(key) &&
        typeof value !== 'object' &&
        !isDefault(value) &&
        !(key.endsWith('Id') && key !== 'Id' && !isDefault(record[displayKeyFor(key)]))
    )
  );
}
