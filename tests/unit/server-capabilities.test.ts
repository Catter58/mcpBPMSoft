import { describe, it, expect, beforeEach } from 'vitest';
import { BpmApiError, isQueryUnsupportedError } from '../../src/utils/errors.js';
import {
  isTolowerSupported,
  markTolowerUnsupported,
  resetServerCapabilities,
} from '../../src/utils/server-capabilities.js';
import { containsExpression } from '../../src/utils/odata.js';

beforeEach(() => resetServerCapabilities());

describe('isQueryUnsupportedError', () => {
  it('400/405/501 — сервер не разобрал саму конструкцию', () => {
    expect(isQueryUnsupportedError(new BpmApiError('bad request', 400))).toBe(true);
    expect(isQueryUnsupportedError(new BpmApiError('method not allowed', 405))).toBe(true);
    expect(isQueryUnsupportedError(new BpmApiError('not implemented', 501))).toBe(true);
  });

  it('права, отсутствие коллекции и нагрузка отказом конструкции не считаются', () => {
    expect(isQueryUnsupportedError(new BpmApiError('forbidden', 403))).toBe(false);
    expect(isQueryUnsupportedError(new BpmApiError('not found', 404))).toBe(false);
    expect(isQueryUnsupportedError(new BpmApiError('too many requests', 429))).toBe(false);
  });

  it('5xx — это сбой сервера, а не отказ от конструкции', () => {
    expect(isQueryUnsupportedError(new BpmApiError('boom', 500))).toBe(false);
  });

  it('обрыв потока при status=0 — тоже отказ (BPMSoft отдаёт 200 и рвёт тело)', () => {
    expect(isQueryUnsupportedError(new BpmApiError('Сетевая ошибка: terminated', 0))).toBe(true);
    expect(isQueryUnsupportedError(new BpmApiError('Сетевая ошибка: other side closed', 0))).toBe(true);
    expect(isQueryUnsupportedError(new BpmApiError('Сетевая ошибка: ECONNRESET', 0))).toBe(true);
  });

  it('прочие сетевые ошибки отказом не считаются', () => {
    expect(isQueryUnsupportedError(new BpmApiError('Сетевая ошибка: ENOTFOUND', 0))).toBe(false);
    expect(isQueryUnsupportedError(new BpmApiError('Превышен таймаут запроса (30000ms)', 408))).toBe(false);
  });
});

describe('латч tolower', () => {
  it('по умолчанию tolower разрешён и попадает в выражение', () => {
    expect(isTolowerSupported()).toBe(true);
    expect(containsExpression('Name', 'Иванов', 4, { caseInsensitive: true })).toBe(
      "contains(tolower(Name), 'иванов')"
    );
  });

  it('после отказа выражение строится без tolower и без порчи регистра значения', () => {
    markTolowerUnsupported();
    expect(isTolowerSupported()).toBe(false);
    expect(containsExpression('Name', 'Иванов', 4, { caseInsensitive: true })).toBe(
      "contains(Name, 'Иванов')"
    );
  });

  it('латч общий для v3-синтаксиса', () => {
    markTolowerUnsupported();
    expect(containsExpression('Name', 'Иванов', 3, { caseInsensitive: true })).toBe(
      "substringof('Иванов', Name)"
    );
  });
});
