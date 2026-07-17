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
      remove: vi.fn((key, callback) => { delete store[key]; callback?.(); }),
    },
  },
};

vi.mock('../background/steam-rate-limiter.js', () => ({
  steamFetch: vi.fn((...args) => fetch(...args)),
}));

const { cancelSteamSearch, searchSteam } = await import('../background/steam-search.js');
const { RESOLUTION_SEARCH_INDEX_KEY } = await import('../background/resolution-search-index.js');

function cache(value) {
  return { value, cachedAt: Date.now(), expiresAt: 0 };
}

function steamResponse(items, ok = true) {
  return { ok, json: async () => ({ items }) };
}

function htmlResponse(html, ok = true) {
  return { ok, text: async () => html };
}

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe('resolver-aware Steam search', () => {
  it('returns an exact cached bundle when storesearch is empty', async () => {
    store['resolve:asterix & obelix xxl collection'] = cache({ appId: '123', type: 'bundle' });
    fetch.mockResolvedValue(steamResponse([]));

    const result = await searchSteam({ query: 'Asterix & Obelix XXL Collection' });

    expect(result.items[0]).toMatchObject({ id: '123', type: 'bundle', source: 'resolver-cache' });
  });

  it('prefers the confirmed resolution and title over the automatic value', async () => {
    store['resolve:known pack'] = cache({ appId: '1', type: 'app' });
    store['resolve:known pack:confirmed'] = cache({ appId: '2', type: 'sub' });
    store['resolve:known pack:confirmed:title'] = cache('Known Package');
    fetch.mockResolvedValue(steamResponse([]));

    const result = await searchSteam({ query: 'Known Pack' });

    expect(result.items[0]).toMatchObject({ id: '2', name: 'Known Package', type: 'sub', confirmed: true });
  });

  it('merges exact store results before other store results', async () => {
    fetch.mockResolvedValue(steamResponse([
      { id: '1', name: 'Other Game', type: 'app' },
      { id: '2', name: 'Target Game', type: 'app' },
    ]));

    const result = await searchSteam({ query: 'Target Game' });

    expect(result.items.map(item => item.id)).toEqual(['2', '1']);
  });

  it('deduplicates by type and id rather than numeric id alone', async () => {
    store['resolve:shared title'] = cache({ appId: '7', type: 'bundle' });
    fetch.mockResolvedValue(steamResponse([{ id: '7', name: 'Shared Title', type: 'app' }]));

    const result = await searchSteam({ query: 'Shared Title' });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '7', type: 'bundle' }),
      expect.objectContaining({ id: '7', type: 'app' }),
    ]));
  });

  it('uses indexed fuzzy candidates when the network fails', async () => {
    store[RESOLUTION_SEARCH_INDEX_KEY] = cache({
      version: 1,
      entries: [{
        normalizedTitle: 'metal gear solid v definitive experience',
        displayTitle: 'METAL GEAR SOLID V: The Definitive Experience',
        id: '287700',
        type: 'sub',
        source: 'confirmed',
        updatedAt: Date.now(),
      }],
    });
    fetch.mockRejectedValue(new Error('offline'));

    const result = await searchSteam({ query: 'Metal Gear Solid V Definitive Experience' });

    expect(result.items).toEqual([
      expect.objectContaining({ id: '287700', type: 'sub', source: 'resolver-cache' }),
    ]);
  });

  it('does no work for short queries', async () => {
    const result = await searchSteam({ query: 'a' });

    expect(result).toEqual({ items: [] });
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stops expanded searches once the limit is reached', async () => {
    fetch.mockResolvedValueOnce(steamResponse([
      { id: '1', name: 'Deluxe Edition One', type: 'app' },
      { id: '2', name: 'Deluxe Edition Two', type: 'app' },
    ]));

    const result = await searchSteam({ query: 'Example Deluxe Edition', limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('discovers the Asterix bundle through related app store pages', async () => {
    fetch.mockImplementation(async url => {
      if (url.includes('/api/storesearch/')) {
        const term = new URL(url).searchParams.get('term');
        if (term !== 'Asterix & Obelix XXL') return steamResponse([]);
        return steamResponse([
          { id: '887060', name: 'Asterix & Obelix XXL 2', type: 'app' },
          { id: '1261520', name: 'Asterix & Obelix XXL: Romastered', type: 'app' },
          { id: '1109690', name: 'Asterix & Obelix XXL 3 - The Crystal Menhir', type: 'app' },
        ]);
      }
      if (url.includes('/app/')) {
        return htmlResponse([
          '<a href="https://store.steampowered.com/bundle/16628/Asterix__Obelix_XXL_Collection/">Bundle info</a>',
          '<a href="https://store.steampowered.com/bundle/48499/Asterix_Maxi_Collection/">Bundle info</a>',
        ].join(''));
      }
      if (url.includes('/bundle/16628/')) {
        return htmlResponse('<div class="pageheader">Asterix &amp; Obelix XXL Collection</div>');
      }
      if (url.includes('/bundle/48499/')) {
        return htmlResponse('<div class="pageheader">Asterix Maxi Collection</div>');
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await searchSteam({ query: 'Asterix & Obelix XXL Collection', requestId: 'asterix-1' });

    expect(result.items[0]).toMatchObject({
      id: '16628',
      name: 'Asterix & Obelix XXL Collection',
      type: 'bundle',
      source: 'steam-related-bundle',
    });
    expect(fetch.mock.calls.some(([url]) => new URL(url).searchParams.get('term') === 'Asterix & Obelix XXL')).toBe(true);
    expect(fetch.mock.calls.filter(([url]) => url.includes('/bundle/16628/'))).toHaveLength(1);

    fetch.mockClear();
    const cached = await searchSteam({ query: 'Asterix & Obelix XXL Collection', requestId: 'asterix-2' });
    expect(cached.items[0]).toMatchObject({ id: '16628', type: 'bundle' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('includes a bundle whose word similarity is exactly 75%', async () => {
    fetch.mockImplementation(async url => {
      if (url.includes('/api/storesearch/')) {
        const term = new URL(url).searchParams.get('term');
        return steamResponse(term === 'Asterix & Obelix'
          ? [{ id: '887060', name: 'Asterix & Obelix XXL 2', type: 'app' }]
          : []);
      }
      if (url.includes('/app/887060/')) {
        return htmlResponse('<a href="/bundle/16628/Asterix__Obelix_XXL_Collection/">Bundle</a>');
      }
      if (url.includes('/bundle/16628/')) {
        return htmlResponse('<div class="pageheader">Asterix &amp; Obelix XXL Collection</div>');
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await searchSteam({ query: 'Asterix & Obelix Collection', requestId: 'asterix-fuzzy' });

    expect(result.items[0]).toMatchObject({ id: '16628', type: 'bundle', source: 'steam-related-bundle' });
  });

  it('does not inspect store pages for ordinary app searches', async () => {
    fetch.mockResolvedValue(steamResponse([{ id: '10', name: 'Regular Game', type: 'app' }]));

    await searchSteam({ query: 'Regular Game', requestId: 'regular' });

    expect(fetch.mock.calls.every(([url]) => url.includes('/api/storesearch/'))).toBe(true);
  });

  it('coalesces concurrent bundle discovery for the same normalized query', async () => {
    fetch.mockImplementation(async url => {
      if (url.includes('/api/storesearch/')) return steamResponse([{ id: '1', name: 'Shared Collection Game', type: 'app' }]);
      if (url.includes('/app/1/')) return htmlResponse('<a href="/bundle/99/shared/">Bundle</a>');
      if (url.includes('/bundle/99/')) return htmlResponse('<div class="pageheader">Shared Collection</div>');
      throw new Error(`Unexpected URL: ${url}`);
    });

    const [first, second] = await Promise.all([
      searchSteam({ query: 'Shared Collection', requestId: 'shared-1' }),
      searchSteam({ query: 'Shared Collection', requestId: 'shared-2' }),
    ]);

    expect(first.items[0]).toMatchObject({ id: '99', type: 'bundle' });
    expect(second.items[0]).toMatchObject({ id: '99', type: 'bundle' });
    expect(fetch.mock.calls.filter(([url]) => url.includes('/app/1/'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => url.includes('/bundle/99/'))).toHaveLength(1);
  });

  it('aborts discovery when its last search subscriber is cancelled', async () => {
    fetch.mockImplementation((url, options = {}) => {
      if (url.includes('/api/storesearch/')) return Promise.resolve(steamResponse([{ id: '2', name: 'Cancelled Collection Game', type: 'app' }]));
      if (url.includes('/app/2/')) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const pending = searchSteam({ query: 'Cancelled Collection', requestId: 'cancel-discovery' });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes('/app/2/'))).toBe(true));
    cancelSteamSearch('cancel-discovery');

    await expect(pending).resolves.toEqual({ items: [], cancelled: true });
  });

  it('does not cache a failed app-page lookup as an empty discovery', async () => {
    fetch.mockImplementation(url => {
      if (url.includes('/api/storesearch/')) return Promise.resolve(steamResponse([{ id: '3', name: 'Retry Collection Game', type: 'app' }]));
      if (url.includes('/app/3/')) return Promise.reject(new Error('temporary Steam failure'));
      throw new Error(`Unexpected URL: ${url}`);
    });

    await searchSteam({ query: 'Retry Collection', requestId: 'retry-1' });
    await searchSteam({ query: 'Retry Collection', requestId: 'retry-2' });

    expect(fetch.mock.calls.filter(([url]) => url.includes('/app/3/'))).toHaveLength(2);
  });
});
