import { describe, expect, it } from 'vitest';

import { deriveLevel } from '../../src/modules/risk/risk.service.js';

describe('deriveLevel (niveau de risque par score)', () => {
  it('0 signal → none', () => {
    expect(deriveLevel(0)).toBe('none');
  });

  it('1 signal → attention', () => {
    expect(deriveLevel(1)).toBe('attention');
  });

  it('2 signaux → warning', () => {
    expect(deriveLevel(2)).toBe('warning');
  });

  it('3 signaux → critical', () => {
    expect(deriveLevel(3)).toBe('critical');
    expect(deriveLevel(4)).toBe('critical');
  });
});
