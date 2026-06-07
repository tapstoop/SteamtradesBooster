/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { applyResolvedRow } from '../content/resolution-helpers.js';

describe('applyResolvedRow', () => {
  function makeRowEl() {
    const el = document.createElement('span');
    el.dataset.stptTitle = 'Normalized Title';
    return el;
  }

  it('updates the matching row and leaves other rows unchanged', () => {
    const elA = makeRowEl();
    const elB = makeRowEl();
    const rowData = [
      { el: elA, appId: null, type: 'app', title: 'Old A', cacheKey: 'ckA', fuzzy: true, resolution: { status: 'ambiguous' } },
      { el: elB, appId: '999', type: 'sub', title: 'Old B', cacheKey: 'ckB', fuzzy: false, resolution: { status: 'hit', appId: '999', type: 'sub' } },
    ];

    const result = applyResolvedRow(rowData, elA, { appId: '456', type: 'bundle', title: 'New A', cacheKey: 'new-ck' });

    expect(result).toBe(rowData[0]);
    expect(rowData[0].appId).toBe('456');
    expect(rowData[0].type).toBe('bundle');
    expect(rowData[0].title).toBe('New A');
    expect(rowData[0].cacheKey).toBe('new-ck');
    expect(rowData[0].fuzzy).toBe(false);
    expect(rowData[0].resolution).toEqual({ status: 'resolved', appId: '456', type: 'bundle' });

    expect(rowData[1].appId).toBe('999');
    expect(rowData[1].type).toBe('sub');
    expect(rowData[1].fuzzy).toBe(false);
  });

  it('returns null when no row matches', () => {
    const rowData = [{ el: makeRowEl(), appId: '1', type: 'app' }];
    const result = applyResolvedRow(rowData, document.createElement('span'), { appId: '2', type: 'app', title: 'X' });
    expect(result).toBeNull();
  });

  it('preserves the existing cacheKey when the incoming one is nullish', () => {
    const el = makeRowEl();
    const rowData = [{ el, appId: null, type: 'app', cacheKey: 'original-ck', title: 'Old', fuzzy: true }];

    applyResolvedRow(rowData, el, { appId: '123', type: 'app', title: 'New', cacheKey: null });

    expect(rowData[0].cacheKey).toBe('original-ck');
  });

  it('defaults type to app when neither resolution nor row provides it', () => {
    const el = makeRowEl();
    const rowData = [{ el, appId: null, title: 'Old' }];

    applyResolvedRow(rowData, el, { appId: '789' });

    expect(rowData[0].type).toBe('app');
    expect(rowData[0].resolution).toEqual({ status: 'resolved', appId: '789', type: 'app' });
  });

  it('makes the updated row discoverable by appId for later rowData consumers', () => {
    const el = makeRowEl();
    const rowData = [{ el, appId: null, title: 'Old' }];

    applyResolvedRow(rowData, el, { appId: '555', type: 'sub', title: 'New' });

    const found = rowData.find(r => r.appId === '555');
    expect(found).toBe(rowData[0]);
    expect(found.title).toBe('New');
    expect(found.type).toBe('sub');
  });

  it('sets manuallyResolved: true and preserves originalTitle when provided', () => {
    const el = makeRowEl();
    const rowData = [{ el, appId: null, type: 'app', title: 'Old Title', cacheKey: 'ck' }];

    applyResolvedRow(rowData, el, { appId: '123', type: 'app', title: 'New Steam Title', originalTitle: 'Old Title' });

    expect(rowData[0].manuallyResolved).toBe(true);
    expect(rowData[0].originalTitle).toBe('Old Title');
    expect(rowData[0].title).toBe('New Steam Title');
  });

  it('uses current row.title as originalTitle when not explicitly provided', () => {
    const el = makeRowEl();
    const rowData = [{ el, appId: null, type: 'app', title: 'Fallback Title' }];

    applyResolvedRow(rowData, el, { appId: '456', type: 'app', title: 'Resolved' });

    expect(rowData[0].manuallyResolved).toBe(true);
    expect(rowData[0].originalTitle).toBe('Fallback Title');
    expect(rowData[0].title).toBe('Resolved');
  });
});
