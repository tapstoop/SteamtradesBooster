import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = {};

global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, callback) => callback({ [key]: store[key] })),
      set: vi.fn((value, callback) => {
        Object.assign(store, value);
        callback?.();
      }),
    },
  },
};

const {
  RESOLUTION_SEARCH_INDEX_KEY,
  getResolutionSearchEntries,
  searchResolutionIndex,
  upsertResolutionSearchEntry,
} = await import('../background/resolution-search-index.js');

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.clearAllMocks();
});

describe('resolution search index', () => {
  it('serializes concurrent writes without losing entries', async () => {
    await Promise.all([
      upsertResolutionSearchEntry({ displayTitle: 'Alpha Game', id: '1', type: 'app', source: 'automatic', updatedAt: 1 }),
      upsertResolutionSearchEntry({ displayTitle: 'Beta Bundle', id: '2', type: 'bundle', source: 'confirmed', updatedAt: 2 }),
    ]);

    expect(await getResolutionSearchEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedTitle: 'alpha game', id: '1', type: 'app' }),
      expect.objectContaining({ normalizedTitle: 'beta bundle', id: '2', type: 'bundle' }),
    ]));
  });

  it('overwrites a normalized title and prunes oldest entries', async () => {
    await upsertResolutionSearchEntry({ displayTitle: 'Same Game', id: '1', type: 'app', source: 'automatic', updatedAt: 1 }, { limit: 2 });
    await upsertResolutionSearchEntry({ displayTitle: 'Other Game', id: '2', type: 'app', source: 'profile', updatedAt: 2 }, { limit: 2 });
    await upsertResolutionSearchEntry({ displayTitle: 'Same Game', id: '3', type: 'sub', source: 'confirmed', updatedAt: 3 }, { limit: 2 });
    await upsertResolutionSearchEntry({ displayTitle: 'Newest Game', id: '4', type: 'bundle', source: 'tradable', updatedAt: 4 }, { limit: 2 });

    const entries = await getResolutionSearchEntries();
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ normalizedTitle: 'same game', id: '3', type: 'sub' }),
      expect.objectContaining({ normalizedTitle: 'newest game', id: '4', type: 'bundle' }),
    ]));
  });

  it('ignores corrupt state and malformed entries', async () => {
    store[RESOLUTION_SEARCH_INDEX_KEY] = {
      value: { version: 1, entries: [{ displayTitle: '', id: 'bad' }] },
      expiresAt: 0,
    };
    expect(await getResolutionSearchEntries()).toEqual([]);

    store[RESOLUTION_SEARCH_INDEX_KEY].value.version = 999;
    expect(await getResolutionSearchEntries()).toEqual([]);
  });

  it('returns only fuzzy matches at or above the threshold', async () => {
    await upsertResolutionSearchEntry({ displayTitle: 'Metal Gear Solid V Definitive Experience', id: '10', type: 'sub', source: 'confirmed' });
    await upsertResolutionSearchEntry({ displayTitle: 'Unrelated Game', id: '20', type: 'app', source: 'automatic' });

    const matches = await searchResolutionIndex('Metal Gear Solid V: Definitive Experience');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ id: '10', type: 'sub', similarity: 1 });
  });
});
