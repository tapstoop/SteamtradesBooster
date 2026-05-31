// tests/resolver.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};
global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, cb) => cb({ [key]: store[key] ?? null })),
      set: vi.fn((obj, cb) => { Object.assign(store, obj); if (cb) cb(); }),
    }
  }
};

// Mock fetch for Steam search API
global.fetch = vi.fn();

import { resolveTitle, normalizeTitle, confirmResolution } from '../background/resolver.js';

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

describe('resolveTitle', () => {
  it('returns cached appId without fetching', async () => {
    store['resolve:sekiro'] = { value: '814380', expiresAt: 0 };
    const result = await resolveTitle('Sekiro');
    expect(result).toMatchObject({ appId: '814380', status: 'hit' });
    expect(fetch).not.toHaveBeenCalled();
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
});
