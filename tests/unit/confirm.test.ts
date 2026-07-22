import { describe, it, expect } from 'vitest';
import { confirmationRequired, confirmationResponse, previewIdList } from '../../src/utils/confirm.js';

describe('confirmationRequired', () => {
  it('is true when confirm is absent', () => {
    expect(confirmationRequired({})).toBe(true);
  });

  it('is true when confirm is false', () => {
    expect(confirmationRequired({ confirm: false })).toBe(true);
  });

  it('is false when confirm is true', () => {
    expect(confirmationRequired({ confirm: true })).toBe(false);
  });
});

describe('previewIdList', () => {
  it('joins all ids when under the cap', () => {
    expect(previewIdList(['a', 'b', 'c'])).toBe('a, b, c');
  });

  it('caps long lists and appends a count of the remainder', () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    const result = previewIdList(ids, 20);
    expect(result).toBe(`${ids.slice(0, 20).join(', ')}, и ещё 5`);
  });
});

describe('confirmationResponse', () => {
  it('marks structuredContent.requires_confirmation and merges extras', () => {
    const result = confirmationResponse('bpm_delete_record', ['line one', 'line two'], {
      collection: 'Contact',
      id: 'abc',
    });

    expect(result.structuredContent).toEqual({
      requires_confirmation: true,
      collection: 'Contact',
      id: 'abc',
    });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('line one');
    expect(result.content[0].text).toContain('line two');
    expect(result.content[0].text).toContain('bpm_delete_record с параметром confirm=true');
  });
});
