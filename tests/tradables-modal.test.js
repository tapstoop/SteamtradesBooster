import { describe, it, expect } from 'vitest';
import {
  categorizeResults,
  filterVisible,
  getAddCount,
  toggleAllVisible
} from '../popup/tradables-bulk-modal.js';

describe('categorizeResults', () => {
  it('categorizes exact matches as exact', () => {
    const results = [
      { raw: 'Hollow Knight', status: 'hit', appId: '367520', matchedName: 'Hollow Knight' }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('exact');
    expect(categorized[0].checked).toBe(true);
  });

  it('categorizes appId resolved', () => {
    const results = [
      { raw: '236850', status: 'appid-resolved', appId: '236850', matchedName: 'Europa Universalis IV' }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('appid');
    expect(categorized[0].checked).toBe(true);
  });

  it('auto-checks fuzzy >= 90', () => {
    const results = [
      { raw: 'Hollow Kni', status: 'ambiguous', appId: '367520', matchedName: 'Hollow Knight', confidence: 92 }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('fuzzy-auto');
    expect(categorized[0].checked).toBe(true);
  });

  it('checks fuzzy < 90 by default (all categories checked)', () => {
    const results = [
      { raw: 'Celest', status: 'ambiguous', appId: null, matchedName: 'Celeste', confidence: 85 }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('fuzzy-manual');
    expect(categorized[0].checked).toBe(true);
  });

  it('checks not-found by default (all categories checked)', () => {
    const results = [
      { raw: 'asdfghjkl', status: 'not-found', appId: null, matchedName: null }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('notfound');
    expect(categorized[0].checked).toBe(true);
  });
});

describe('filterVisible', () => {
  it('shows only categories in active filter set', () => {
    const entries = [
      { category: 'exact', visible: true },
      { category: 'notfound', visible: true }
    ];
    const filters = new Set(['exact']);
    const result = filterVisible(entries, filters);
    expect(result[0].visible).toBe(true);
    expect(result[1].visible).toBe(false);
  });
});

describe('getAddCount', () => {
  it('counts only checked and visible entries', () => {
    const entries = [
      { category: 'exact', checked: true, visible: true },
      { category: 'notfound', checked: false, visible: true },
      { category: 'exact', checked: true, visible: false }
    ];
    expect(getAddCount(entries)).toBe(1);
  });
});

describe('toggleAllVisible', () => {
  it('checks all visible entries', () => {
    const entries = [
      { category: 'exact', checked: false, visible: true },
      { category: 'notfound', checked: false, visible: false }
    ];
    const result = toggleAllVisible(entries, true);
    expect(result[0].checked).toBe(true);
    expect(result[1].checked).toBe(false); // invisible, unchanged
  });

  it('unchecks all visible entries', () => {
    const entries = [
      { category: 'exact', checked: true, visible: true },
      { category: 'appid', checked: true, visible: true }
    ];
    const result = toggleAllVisible(entries, false);
    expect(result[0].checked).toBe(false);
    expect(result[1].checked).toBe(false);
  });
});
