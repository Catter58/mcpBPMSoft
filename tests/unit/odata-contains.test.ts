import { describe, it, expect } from 'vitest';
import { containsExpression } from '../../src/utils/odata.js';

describe('containsExpression', () => {
  it('v4 без CI', () => {
    expect(containsExpression('Name', "O'Neil", 4)).toBe("contains(Name, 'O''Neil')");
  });
  it('v4 с CI оборачивает поле в tolower', () => {
    expect(containsExpression('Name', 'ланит', 4, { caseInsensitive: true })).toBe(
      "contains(tolower(Name), 'ланит')"
    );
  });
  it('v3 использует substringof', () => {
    expect(containsExpression('Name', 'x', 3)).toBe("substringof('x', Name)");
  });
  it('v3 с CI', () => {
    expect(containsExpression('Name', 'x', 3, { caseInsensitive: true })).toBe(
      "substringof('x', tolower(Name))"
    );
  });
});
