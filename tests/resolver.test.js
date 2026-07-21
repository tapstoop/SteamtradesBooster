// tests/resolver.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};
global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, cb) => cb({ [key]: store[key] ?? null })),
      set: vi.fn((obj, cb) => { Object.assign(store, obj); if (cb) cb(); }),
      remove: vi.fn((key, cb) => { delete store[key]; cb?.(); }),
    }
  }
};

// Mock fetch for Steam search API
global.fetch = vi.fn();

import { confirmResolution, getSearchTerms, normalizeTitle, readResolutionValue, resolveTitle } from '../background/resolver.js';

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
  vi.clearAllMocks();
});

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTitle("Dark Souls™: Remastered")).toBe('dark souls remastered');
  });

  it('collapses whitespace', () => {
    expect(normalizeTitle('  Elden  Ring  ')).toBe('elden ring');
  });
});

describe('resolver search helpers', () => {
  it('deduplicates title variants while retaining useful expansions', () => {
    const terms = getSearchTerms('Example™ Deluxe Edition');
    expect(terms[0]).toBe('Example™ Deluxe Edition');
    expect(terms).toContain('Example');
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('searches the base title before replacing a bundle keyword', () => {
    const terms = getSearchTerms('Asterix & Obelix XXL Collection');

    expect(terms).toContain('Asterix & Obelix XXL');
    expect(terms.indexOf('Asterix & Obelix XXL')).toBeLessThan(terms.indexOf('Asterix & Obelix XXL bundle'));
  });

  it('decodes scalar and typed resolution values and rejects malformed values', () => {
    expect(readResolutionValue('42')).toEqual({ appId: '42', type: 'app' });
    expect(readResolutionValue({ appId: 7, type: 'bundle' })).toEqual({ appId: '7', type: 'bundle' });
    expect(readResolutionValue({ id: '9', type: 'sub' })).toEqual({ appId: '9', type: 'sub' });
    expect(readResolutionValue({ appId: 'invalid', type: 'bundle' })).toBeNull();
    expect(readResolutionValue(null)).toBeNull();
  });
});

describe('resolveTitle', () => {
  function mockAsterixBundlePages(searchTerm = 'Asterix & Obelix XXL') {
    fetch.mockImplementation(async url => {
      if (url.includes('/api/storesearch/')) {
        const term = new URL(url).searchParams.get('term');
        if (term !== searchTerm) return { ok: true, json: async () => ({ items: [] }) };
        return { ok: true, json: async () => ({ items: [
          { id: '777777', name: searchTerm, type: 'app' },
          { id: '887060', name: 'Asterix & Obelix XXL 2', type: 'app' },
          { id: '1261520', name: 'Asterix & Obelix XXL: Romastered', type: 'app' },
        ] }) };
      }
      if (url.includes('/app/')) {
        return { ok: true, text: async () => '<a href="https://store.steampowered.com/bundle/16628/Asterix__Obelix_XXL_Collection/">Bundle</a>' };
      }
      if (url.includes('/bundle/16628/')) {
        return { ok: true, text: async () => '<div class="pageheader">Asterix &amp; Obelix XXL Collection</div>' };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
  }

  it('automatically resolves an exact bundle discovered through app pages', async () => {
    mockAsterixBundlePages();

    const result = await resolveTitle('Asterix & Obelix XXL Collection');

    expect(result).toEqual({
      appId: '16628',
      type: 'bundle',
      status: 'resolved',
      cacheKey: 'resolve:asterix & obelix xxl collection',
    });
    expect(store['resolve:asterix & obelix xxl collection'].value).toMatchObject({
      appId: '16628',
      type: 'bundle',
      resolverVersion: 2,
      match: 'exact',
      source: 'steam-related-bundle',
    });
  });

  it('returns a 75% bundle match as fuzzy without persisting a direct resolution', async () => {
    mockAsterixBundlePages('Asterix & Obelix');

    const result = await resolveTitle('Asterix & Obelix Collection');

    expect(result).toMatchObject({
      appId: '16628',
      type: 'bundle',
      status: 'resolved',
      fuzzy: true,
      similarity: 75,
      title: 'Asterix & Obelix XXL Collection',
    });
    expect(store['resolve:asterix & obelix collection']).toBeUndefined();
  });

  it('revalidates a legacy automatic app cache for a bundle title', async () => {
    store['resolve:asterix & obelix xxl collection'] = {
      value: { appId: '887060', type: 'app' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    mockAsterixBundlePages();

    const result = await resolveTitle('Asterix & Obelix XXL Collection');

    expect(chrome.storage.local.remove).toHaveBeenCalledWith('resolve:asterix & obelix xxl collection', expect.any(Function));
    expect(result).toMatchObject({ appId: '16628', type: 'bundle' });
    expect(result.fuzzy).toBeUndefined();
  });

  it('keeps a confirmed choice ahead of legacy automatic bundle-title caches', async () => {
    store['resolve:asterix & obelix xxl collection'] = { value: { appId: '887060', type: 'app' }, expiresAt: 0 };
    store['resolve:asterix & obelix xxl collection:confirmed'] = { value: { appId: '16628', type: 'bundle' }, expiresAt: 0 };
    store['resolve:asterix & obelix xxl collection:confirmed:title'] = { value: 'Asterix & Obelix XXL Collection', expiresAt: 0 };

    const result = await resolveTitle('Asterix & Obelix XXL Collection');

    expect(result).toMatchObject({ appId: '16628', type: 'bundle', status: 'hit', confirmed: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });

  it('keeps the 85% threshold for non-bundle app matches', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: '10', name: 'Alpha Beta Gamma Delta', type: 'app' }] }),
    });

    const result = await resolveTitle('Alpha Beta Gamma');

    expect(result.status).toBe('ambiguous');
    expect(result.fuzzy).toBeUndefined();
  });

  it('returns cached appId without fetching', async () => {
    store['resolve:sekiro'] = { value: '814380', expiresAt: 0 };
    const result = await resolveTitle('Sekiro');
    expect(result).toMatchObject({ appId: '814380', status: 'hit' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bypasses cached appId when forceRefresh is enabled', async () => {
    store['resolve:sekiro'] = { value: '814380', expiresAt: 0 };
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ id: 999999, name: 'Sekiro', type: 'app' }]
      })
    });

    const result = await resolveTitle('Sekiro', { forceRefresh: true });

    expect(result).toMatchObject({ appId: '999999', status: 'resolved' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fetches Steam search and returns single match', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ id: 1245620, name: 'Elden Ring', type: 'app' }]
      })
    });
    const result = await resolveTitle('Elden Ring');
    expect(result).toMatchObject({ appId: '1245620', type: 'app', status: 'resolved' });
  });

  it('preserves bundle result type', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ id: 232, name: 'Valve Complete Pack', type: 'bundle' }]
      })
    });
    const result = await resolveTitle('Valve Complete Pack');
    expect(result).toMatchObject({ appId: '232', type: 'bundle', status: 'resolved' });
  });

  it('returns confirmed resolution type from cache', async () => {
    await confirmResolution('resolve:valve complete pack', '232', 'Valve Complete Pack', 'bundle');
    const result = await resolveTitle('Valve Complete Pack');
    expect(result).toMatchObject({ appId: '232', type: 'bundle', status: 'hit', title: 'Valve Complete Pack' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('auto-resolves when top result exactly matches normalized title', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { id: 570940, name: 'Dark Souls' },
          { id: 211420, name: 'Dark Souls PTD Edition' },
        ]
      })
    });
    const result = await resolveTitle('Dark Souls');
    expect(result).toMatchObject({ appId: '570940', status: 'resolved' });
  });

  it('returns ambiguous status when multiple close matches', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { id: 570940, name: 'Dark Souls Remastered' },
          { id: 211420, name: 'Dark Souls PTD Edition' },
        ]
      })
    });
    const result = await resolveTitle('Dark Souls');
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.length).toBe(2);
  });

  it('falls back to simplified edition titles after empty search results', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [{ id: 367520, name: 'Hollow Knight', type: 'app' }] })
      });

    const result = await resolveTitle('Hollow Knight - Deluxe Edition');
    expect(result).toMatchObject({ appId: '367520', status: 'resolved', type: 'app' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('tries fallback search terms when primary results are ambiguous and unconfident', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [
            { id: 999001, name: 'Random Edition Game', type: 'app' },
            { id: 999002, name: 'Another Unrelated Game', type: 'app' },
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 367520, name: 'Hollow Knight', type: 'app' }]
        })
      });

    const result = await resolveTitle('Hollow Knight - Deluxe Edition');
    expect(result).toMatchObject({ appId: '367520', status: 'resolved', type: 'app' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps earlier ambiguous candidates when a later fallback search fails', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 999001, name: 'Random Edition Game', type: 'app' }]
        })
      })
      .mockRejectedValueOnce(new Error('network down'));

    const result = await resolveTitle('Hollow Knight - Deluxe Edition');
    expect(result).toMatchObject({
      status: 'ambiguous',
      candidates: [{ id: '999001', name: 'Random Edition Game', type: 'app' }],
    });
  });

  it('tries fallback search terms when a single primary result is unconfident', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 999001, name: 'Random Edition Game', type: 'app' }]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{ id: 367520, name: 'Hollow Knight', type: 'app' }]
        })
      });

    const result = await resolveTitle('Hollow Knight - Deluxe Edition');
    expect(result).toMatchObject({ appId: '367520', status: 'resolved', type: 'app' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns a single unconfident result as ambiguous after fallbacks are exhausted', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: 999001, name: 'Random Edition Game', type: 'app' }]
      })
    });

    const result = await resolveTitle('Hollow Knight');
    expect(result).toMatchObject({
      status: 'ambiguous',
      candidates: [{ id: '999001', name: 'Random Edition Game', type: 'app' }],
    });
  });

  it('prefers exact match on original title over stripped title', async () => {
    global.fetch = vi.fn(async (url) => {
      const term = new URL(url).searchParams.get('term');
      if (term === 'Hollow Knight Deluxe Edition') {
        return { ok: true, json: async () => ({ items: [
          { id: '1', name: 'Hollow Knight Deluxe Edition', type: 'app' },
          { id: '2', name: 'Hollow Knight', type: 'app' },
        ]}) };
      }
      if (term === 'Hollow Knight') {
        return { ok: true, json: async () => ({ items: [
          { id: '2', name: 'Hollow Knight', type: 'app' },
        ]}) };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    });

    const result = await resolveTitle('Hollow Knight Deluxe Edition');
    expect(result.status).toBe('resolved');
    expect(result.appId).toBe('1');
    expect(result.fuzzy).toBeUndefined();
  });

  it('returns ambiguous when no term produces a confident match', async () => {
    global.fetch = vi.fn(async (url) => {
      const term = new URL(url).searchParams.get('term');
      if (term === 'Obscure Game Title') {
        return { ok: true, json: async () => ({ items: [
          { id: '99', name: 'Some Other Game', type: 'app' },
        ]}) };
      }
      return { ok: true, json: async () => ({ items: [] }) };
    });

    const result = await resolveTitle('Obscure Game Title');
    expect(result.status).toBe('ambiguous');
    expect(result.candidates).toBeDefined();
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('rate-limits Steam API calls with minimum delay between requests', async () => {
    let callCount = 0;
    global.fetch = vi.fn(async (url) => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ items: [{ id: '1', name: 'Test Game', type: 'app' }] }),
      };
    });

    const start = Date.now();
    await resolveTitle('Game Alpha');
    await resolveTitle('Game Beta');
    const elapsed = Date.now() - start;

    expect(callCount).toBeGreaterThanOrEqual(2);
  }, 15000);

  it('returns not-found when Steam returns empty', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    });
    const result = await resolveTitle('Nonexistent Game XYZ');
    expect(result).toMatchObject({ status: 'not-found' });
  });

  it('confirmed cache hit exposes confirmed: true and the chosen title', async () => {
    await confirmResolution('resolve:my test game', '456', 'My Test Game', 'bundle');
    const result = await resolveTitle('My Test Game');
    expect(result).toMatchObject({
      appId: '456',
      type: 'bundle',
      status: 'hit',
      confirmed: true,
      title: 'My Test Game',
    });
  });

  it('ignores a legacy manual-delisted flag and keeps a confirmed resolution', async () => {
    await confirmResolution('resolve:delisted test', '789', 'Delisted Test', 'app');
    // Legacy flags are no longer part of resolution semantics.
    await global.chrome.storage.local.set({ 'resolve:delisted test:delisted': { value: '1' } });
    const result = await resolveTitle('Delisted Test');
    expect(result).toMatchObject({
      appId: '789',
      type: 'app',
      status: 'hit',
      confirmed: true,
      title: 'Delisted Test',
    });
  });

  it('automatic resolution does not expose confirmed', async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ id: '999', name: 'Auto Game', type: 'app' }] }),
    });
    const result = await resolveTitle('Auto Game');
    expect(result).toMatchObject({ appId: '999', status: 'resolved' });
    expect(result.confirmed).toBeUndefined();
  });

  it('plain cache hit does not expose confirmed', async () => {
    store['resolve:cache test'] = { value: '555', expiresAt: 0 };
    const result = await resolveTitle('Cache Test');
    expect(result).toMatchObject({ appId: '555', status: 'hit' });
    expect(result.confirmed).toBeUndefined();
  });
});
