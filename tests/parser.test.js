import { describe, it, expect } from 'vitest';
import { cleanGameTitle, stripParentheses } from '../content/parser.js';

describe('cleanGameTitle', () => {
  it('preserves numeric commas in titles', () => {
    expect(cleanGameTitle('Warhammer 40,000')).toBe('Warhammer 40,000');
  });

  it('removes table/list noise without losing the title', () => {
    expect(cleanGameTitle('1. Hollow Knight (Steam Key) - 2.00€')).toBe('Hollow Knight');
  });

  it('keeps anchor text style titles clean for table rows', () => {
    expect(cleanGameTitle('  DARK SOULS™: REMASTERED  ')).toBe('DARK SOULS™: REMASTERED');
  });
});

describe('stripParentheses', () => {
  it('removes region annotations', () => {
    expect(stripParentheses('My Little Universe (region lock)')).toBe('My Little Universe');
  });
});
