import { describe, it, expect } from 'vitest';
import { TOOLS } from '../../src/tools/registry.js';

describe('tool conventions', () => {
  it('every tool name <=64 chars with title + annotations', () => {
    for (const t of TOOLS) {
      expect(t.name.length, t.name).toBeLessThanOrEqual(64);
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations, t.name).toBeTruthy();
    }
  });

  it('bulk-write tools are destructive', () => {
    for (const n of ['bpm_update_by_filter', 'bpm_batch_update', 'bpm_delete_by_filter', 'bpm_batch_delete', 'bpm_delete_record', 'bpm_update_record']) {
      const t = TOOLS.find((x) => x.name === n);
      expect(t, n).toBeTruthy();
      expect(t!.annotations.destructiveHint, n).toBe(true);
    }
  });

  it('descriptions do not instruct the model', () => {
    const banned = [/Должен быть вызван/i, /\bИспользуйте\b/, /\bвсегда вызыв/i, /you must/i, /always call/i];
    for (const t of TOOLS) {
      for (const re of banned) {
        expect(re.test(t.description), `${t.name}: ${t.description}`).toBe(false);
      }
    }
  });
});
