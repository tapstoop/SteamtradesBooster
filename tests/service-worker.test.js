import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const storageStore = {};
const failGetKeys = new Set();
const failSetKeys = new Set();

global.chrome = {
  runtime: {
    getManifest: vi.fn(() => ({ version: 'test' })),
    lastError: null,
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(() => Promise.resolve()),
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  tabs: {
    onRemoved: { addListener: vi.fn() },
    query: vi.fn(),
    sendMessage: vi.fn((tabId, message, optionsOrCallback) => {
      const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : undefined;
      cb?.();
    }),
  },
  storage: {
    local: {
      get: vi.fn((keys, cb) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        const failedKey = keyList.find(key => failGetKeys.has(key));
        if (failedKey) {
          chrome.runtime.lastError = { message: `read failed: ${failedKey}` };
          cb({});
          chrome.runtime.lastError = null;
          return;
        }
        if (Array.isArray(keys)) {
          cb(Object.fromEntries(keys.map(key => [key, storageStore[key]])));
          return;
        }
        if (typeof keys === 'string') {
          cb({ [keys]: storageStore[keys] });
          return;
        }
        cb({ ...storageStore });
      }),
      set: vi.fn((obj, cb) => {
        const keyList = Object.keys(obj);
        const failedKey = keyList.find(key => failSetKeys.has(key));
        if (failedKey) {
          chrome.runtime.lastError = { message: `write failed: ${failedKey}` };
          cb?.();
          chrome.runtime.lastError = null;
          return;
        }
        Object.assign(storageStore, obj);
        if (cb) cb();
      }),
      clear: vi.fn(cb => { Object.keys(storageStore).forEach(key => delete storageStore[key]); cb?.(); }),
      remove: vi.fn((keys, cb) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storageStore[key];
        cb?.();
      }),
    },
  },
  notifications: {
    create: vi.fn(),
  },
};

let normalizePriceMessageItems;
let normalizeTradablesList;
let handleMessage;

beforeAll(async () => {
  const mod = await import('../background/service-worker.js');
  normalizePriceMessageItems = mod.normalizePriceMessageItems;
  normalizeTradablesList = mod.normalizeTradablesList;
  handleMessage = mod.handleMessage;
});

beforeEach(() => {
  Object.keys(storageStore).forEach(key => delete storageStore[key]);
  failGetKeys.clear();
  failSetKeys.clear();
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe('normalizePriceMessageItems', () => {
  it('handles legacy appIds format', () => {
    const result = normalizePriceMessageItems({ appIds: ['123', '456'] });
    expect(result).toEqual([
      { id: '123', type: 'app' },
      { id: '456', type: 'app' },
    ]);
  });

  it('handles new items format with types', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: '123', type: 'bundle' },
      { id: '456', type: 'app' },
    ] });
    expect(result).toEqual([
      { id: '123', type: 'bundle' },
      { id: '456', type: 'app' },
    ]);
  });

  it('handles items with appId field (legacy item shape)', () => {
    const result = normalizePriceMessageItems({ items: [
      { appId: '789', type: 'sub' },
    ] });
    expect(result).toEqual([
      { id: '789', type: 'sub' },
    ]);
  });

  it('defaults unknown type to app', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: '123', type: 'unknown' },
    ] });
    expect(result).toEqual([
      { id: '123', type: 'app' },
    ]);
  });

  it('deduplicates by type:id', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: '123', type: 'app' },
      { id: '123', type: 'app' },
    ] });
    expect(result).toHaveLength(1);
  });

  it('filters out undefined ids', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: undefined, type: 'app' },
      { id: '123', type: 'app' },
    ] });
    expect(result).toEqual([{ id: '123', type: 'app' }]);
  });
});

describe('bundle title resolution contract', () => {
  it('returns an exact discovered bundle through RESOLVE_TITLES', async () => {
    fetch.mockImplementation(async url => {
      if (url.includes('/api/storesearch/')) {
        const term = new URL(url).searchParams.get('term');
        return {
          ok: true,
          json: async () => ({
            items: term === 'Asterix & Obelix XXL'
              ? [{ id: '887060', name: 'Asterix & Obelix XXL 2', type: 'app' }]
              : [],
          }),
        };
      }
      if (url.includes('/app/887060/')) {
        return { ok: true, text: async () => '<a href="/bundle/16628/Asterix__Obelix_XXL_Collection/">Bundle</a>' };
      }
      if (url.includes('/bundle/16628/')) {
        return { ok: true, text: async () => '<div class="pageheader">Asterix &amp; Obelix XXL Collection</div>' };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await handleMessage({
      type: 'RESOLVE_TITLES',
      titles: ['Asterix & Obelix XXL Collection'],
    });

    expect(result).toEqual([{
      appId: '16628',
      type: 'bundle',
      status: 'resolved',
      cacheKey: 'resolve:asterix & obelix xxl collection',
    }]);
  });
});

describe('deals refresh transactions', () => {
  it('writes an incomplete marker at refresh start and commits only the matching token', async () => {
    const begin = await handleMessage({
      type: 'BEGIN_DEALS_REFRESH',
      cacheIdentity: 'steam:one',
      refreshToken: 'token-a',
    });

    expect(begin).toEqual({ ok: true });
    expect(storageStore.deals_cards_cache).toMatchObject({
      profileComplete: false,
      cacheIdentity: 'steam:one',
      refreshToken: 'token-a',
      previousComplete: null,
    });
    expect(storageStore.deals_cards_cache.cards).toBeUndefined();

    const stale = await handleMessage({
      type: 'COMMIT_DEALS_REFRESH',
      cacheIdentity: 'steam:one',
      refreshToken: 'token-b',
      cards: [{ title: 'Old' }],
      savedAt: 1,
    });

    expect(stale).toEqual({ ok: false, code: 'STALE_REFRESH' });
    expect(storageStore.deals_cards_cache.profileComplete).toBe(false);

    const commit = await handleMessage({
      type: 'COMMIT_DEALS_REFRESH',
      cacheIdentity: 'steam:one',
      refreshToken: 'token-a',
      cards: [{ title: 'Fresh' }],
      savedAt: 2,
    });

    expect(commit).toEqual({ ok: true });
    expect(storageStore.deals_cards_cache).toMatchObject({
      profileComplete: true,
      cacheIdentity: 'steam:one',
      savedAt: 2,
      cards: [{ title: 'Fresh' }],
    });
    expect(storageStore.deals_cards_cache.previousComplete).toBeUndefined();
  });

  it('does not let an older refresh replace a newer marker', async () => {
    await handleMessage({ type: 'BEGIN_DEALS_REFRESH', cacheIdentity: 'steam:one', refreshToken: 'old' });
    await handleMessage({ type: 'BEGIN_DEALS_REFRESH', cacheIdentity: 'steam:one', refreshToken: 'new' });

    const stale = await handleMessage({
      type: 'COMMIT_DEALS_REFRESH',
      cacheIdentity: 'steam:one',
      refreshToken: 'old',
      cards: [{ title: 'Old' }],
      savedAt: 10,
    });

    expect(stale).toEqual({ ok: false, code: 'STALE_REFRESH' });
    expect(storageStore.deals_cards_cache).toMatchObject({
      profileComplete: false,
      refreshToken: 'new',
    });
  });

  it('stores partial deals cards only for the active incomplete marker', async () => {
    await handleMessage({ type: 'BEGIN_DEALS_REFRESH', cacheIdentity: 'steam:one', refreshToken: 'current' });

    const stale = await handleMessage({
      type: 'UPDATE_DEALS_REFRESH_PROGRESS',
      cacheIdentity: 'steam:one',
      refreshToken: 'old',
      cards: [{ title: 'Old Partial' }],
      savedAt: 1,
    });

    expect(stale).toEqual({ ok: false, code: 'STALE_REFRESH' });
    expect(storageStore.deals_cards_cache.partialCards).toBeUndefined();

    const current = await handleMessage({
      type: 'UPDATE_DEALS_REFRESH_PROGRESS',
      cacheIdentity: 'steam:one',
      refreshToken: 'current',
      cards: [{ title: 'Current Partial' }],
      savedAt: 2,
    });

    expect(current).toEqual({ ok: true });
    expect(storageStore.deals_cards_cache).toMatchObject({
      profileComplete: false,
      refreshToken: 'current',
      partialCards: [{ title: 'Current Partial' }],
      partialSavedAt: 2,
    });
  });

  it('preserves a completed deals cache under an incomplete marker for the same identity', async () => {
    storageStore.deals_cards_cache = {
      profileComplete: true,
      cacheIdentity: 'steam:one',
      savedAt: 111,
      cards: [{ title: 'Kept' }],
      failedAppIds: ['42'],
    };

    await handleMessage({ type: 'BEGIN_DEALS_REFRESH', cacheIdentity: 'steam:one', refreshToken: 'next' });

    expect(storageStore.deals_cards_cache).toMatchObject({
      profileComplete: false,
      cacheIdentity: 'steam:one',
      refreshToken: 'next',
      previousComplete: {
        cacheIdentity: 'steam:one',
        savedAt: 111,
        cards: [{ title: 'Kept' }],
        failedAppIds: ['42'],
      },
    });
    expect(storageStore.deals_cards_cache.cards).toBeUndefined();
  });

  it('carries previousComplete forward across repeated incomplete refresh starts', async () => {
    storageStore.deals_cards_cache = {
      profileComplete: false,
      cacheIdentity: 'steam:one',
      refreshToken: 'old',
      previousComplete: {
        cacheIdentity: 'steam:one',
        savedAt: 111,
        cards: [{ title: 'Kept' }],
        failedAppIds: [],
      },
    };

    await handleMessage({ type: 'BEGIN_DEALS_REFRESH', cacheIdentity: 'steam:one', refreshToken: 'new' });

    expect(storageStore.deals_cards_cache).toMatchObject({
      profileComplete: false,
      refreshToken: 'new',
      previousComplete: {
        cacheIdentity: 'steam:one',
        savedAt: 111,
        cards: [{ title: 'Kept' }],
      },
    });
  });

  it('does not preserve a completed deals cache for another identity', async () => {
    storageStore.deals_cards_cache = {
      profileComplete: true,
      cacheIdentity: 'steam:old',
      savedAt: 111,
      cards: [{ title: 'Wrong Profile' }],
    };

    await handleMessage({ type: 'BEGIN_DEALS_REFRESH', cacheIdentity: 'steam:new', refreshToken: 'next' });

    expect(storageStore.deals_cards_cache).toMatchObject({
      profileComplete: false,
      cacheIdentity: 'steam:new',
      refreshToken: 'next',
      previousComplete: null,
    });
  });
});

describe('normalizeTradablesList', () => {
  it('filters invalid stored tradables without mutating valid entries', () => {
    const bundle = { appId: 232, name: 'Valve Complete Pack', type: 'bundle' };
    expect(normalizeTradablesList([null, '', '  ', 'Gift Game', { name: '' }, bundle, { title: 'Missing Name' }]))
      .toEqual(['Gift Game', bundle]);
    expect(normalizeTradablesList({ value: [] })).toEqual([]);
  });
});

describe('settings and cache safety', () => {
  it('preserves user data while clearing cache entries', async () => {
    storageStore.settings = { value: { steamId: '76561198000000000', apiKey: 'KEY' }, cachedAt: Date.now(), expiresAt: 0 };
    storageStore.tradables_list = { value: [{ name: 'Gift', appId: '10' }], cachedAt: Date.now(), expiresAt: 0 };
    storageStore.tradables_snapshots_index = { value: [{ id: 'snap_1' }], cachedAt: Date.now(), expiresAt: 0 };
    storageStore['tradables_snapshot:snap_1'] = { value: { id: 'snap_1', tradables: [] }, cachedAt: Date.now(), expiresAt: 0 };
    storageStore.excluded_pages = { value: ['/trade/abc/test'], cachedAt: Date.now(), expiresAt: 0 };
    storageStore['acq:app:10'] = { value: 123, cachedAt: Date.now(), expiresAt: 0 };
    storageStore['price:10:eu'] = { value: { prices: {} }, cachedAt: Date.now(), expiresAt: 0 };
    storageStore['resolve:test'] = { value: { appId: '10' }, cachedAt: Date.now(), expiresAt: 0 };

    const result = await handleMessage({ type: 'CLEAR_CACHE' });

    expect(result).toEqual({ ok: true });
    expect(storageStore.settings?.value.apiKey).toBe('KEY');
    expect(storageStore.tradables_list?.value[0].name).toBe('Gift');
    expect(storageStore.tradables_snapshots_index?.value).toEqual([{ id: 'snap_1' }]);
    expect(storageStore['tradables_snapshot:snap_1']?.value.id).toBe('snap_1');
    expect(storageStore.excluded_pages?.value).toEqual(['/trade/abc/test']);
    expect(storageStore['acq:app:10']?.value).toBe(123);
    expect(storageStore['price:10:eu']).toBeUndefined();
    expect(storageStore['resolve:test']).toBeUndefined();
  });

  it('broadcasts TRADABLES_UPDATED after a successful tradables save', async () => {
    storageStore.tradables_list = { value: [], cachedAt: Date.now(), expiresAt: 0, revision: 'tradables-1' };

    const result = await handleMessage({
      type: 'SAVE_TRADABLES',
      tradables: [{ name: 'Gift', appId: '10', type: 'app' }],
      expectedRevision: 'tradables-1',
    });

    expect(result.ok).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'TRADABLES_UPDATED',
      count: 1,
      tradables: [{ name: 'Gift', appId: '10', type: 'app' }],
      revision: result.revision,
    }));
  });

  it('does not migrate legacy tradables when tradables_list read fails', async () => {
    storageStore.settings = {
      value: {
        steamId: '76561198000000000',
        tradables: ['Legacy Game'],
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = {
      value: ['Modern Game'],
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    failGetKeys.add('tradables_list');

    const settings = await handleMessage({ type: 'GET_SETTINGS' });

    expect(settings.tradables).toEqual(['Legacy Game']);
    expect(settings.storageError).toBe(true);
    expect(storageStore.tradables_list.value).toEqual(['Modern Game']);
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(expect.objectContaining({
      tradables_list: expect.objectContaining({ value: ['Legacy Game'] }),
    }), expect.any(Function));
  });

  it('blocks SAVE_SETTINGS after migration read failure (storageError propagates)', async () => {
    storageStore.settings = {
      value: {
        steamId: '76561198000000000',
        tradables: ['Legacy Game'],
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = {
      value: ['Modern Game'],
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    failGetKeys.add('tradables_list');

    await handleMessage({ type: 'GET_SETTINGS' });

    // Storage still broken — SAVE_SETTINGS should be refused
    const blocked = await handleMessage({
      type: 'SAVE_SETTINGS',
      settings: { steamId: '76561198000000000', currency: 'EUR', tradables: [] },
    });
    expect(blocked.ok).toBe(false);
    // Legacy tradables preserved
    expect(storageStore.settings.value.tradables).toEqual(['Legacy Game']);
  });

  it('blocks SAVE_SETTINGS after migration cacheSet failure (storageError propagates)', async () => {
    storageStore.settings = {
      value: {
        steamId: '76561198000000000',
        tradables: ['Legacy Game'],
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    // tradables_list key is empty so migration runs, but the cacheSet will fail
    storageStore.tradables_list = undefined;
    failSetKeys.add('tradables_list');

    const settings = await handleMessage({ type: 'GET_SETTINGS' });
    expect(settings.storageError).toBe(true);

    // SAVE_SETTINGS should be refused
    const blocked = await handleMessage({
      type: 'SAVE_SETTINGS',
      settings: { steamId: '76561198000000000', currency: 'EUR' },
    });
    expect(blocked.ok).toBe(false);
    // Legacy tradables preserved (migration write never committed)
    expect(storageStore.settings.value.tradables).toEqual(['Legacy Game']);
  });

  it('coalesces concurrent legacy migrations onto one current revision', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000', tradables: ['Legacy Game'] },
      cachedAt: Date.now(),
      expiresAt: 0,
    };

    const [first, second] = await Promise.all([
      handleMessage({ type: 'GET_SETTINGS' }),
      handleMessage({ type: 'GET_SETTINGS' }),
    ]);

    expect(first.settingsRevision).toBe(second.settingsRevision);
    expect(first.tradables).toBeUndefined();
    expect(second.tradables).toBeUndefined();
    expect(storageStore.tradables_list.value).toEqual(['Legacy Game']);
    expect(storageStore.settings.value.tradables).toBeUndefined();
  });

  it('blocks SAVE_SETTINGS while settings storage is still broken', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000', currency: 'EUR' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    failGetKeys.add('settings');

    const blocked = await handleMessage({
      type: 'SAVE_SETTINGS',
      settings: { steamId: '', currency: 'USD' },
    });
    expect(blocked.ok).toBe(false);
    expect(storageStore.settings.value.steamId).toBe('76561198000000000');

    failGetKeys.clear();
    const current = await handleMessage({ type: 'GET_SETTINGS' });
    const saved = await handleMessage({
      type: 'SAVE_SETTINGS',
      settings: { steamId: '76561198000000001', currency: 'USD' },
      expectedRevision: current.settingsRevision,
    });
    expect(saved.ok).toBe(true);
    expect(storageStore.settings.value.steamId).toBe('76561198000000001');
  });

  it('blocks SAVE_TRADABLES while tradables storage is still broken', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = {
      value: ['Modern Game'],
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    failGetKeys.add('tradables_list');

    const blocked = await handleMessage({ type: 'SAVE_TRADABLES', tradables: [] });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/read failed/i);
    expect(storageStore.tradables_list.value).toEqual(['Modern Game']);

    failGetKeys.clear();
    const current = await handleMessage({ type: 'GET_TRADABLES' });
    const saved = await handleMessage({
      type: 'SAVE_TRADABLES',
      tradables: ['Saved Game'],
      expectedRevision: current.tradablesRevision,
    });
    expect(saved.ok).toBe(true);
    expect(storageStore.tradables_list.value).toEqual(['Saved Game']);
  });

  it('rejects a stale settings save after another client writes', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000', currency: 'EUR' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    const clientA = await handleMessage({ type: 'GET_SETTINGS' });
    const clientB = await handleMessage({ type: 'GET_SETTINGS' });
    const saved = await handleMessage({
      type: 'SAVE_SETTINGS',
      settings: { steamId: '76561198000000001', currency: 'USD' },
      expectedRevision: clientB.settingsRevision,
    });
    expect(saved.ok).toBe(true);

    const stale = await handleMessage({
      type: 'SAVE_SETTINGS',
      settings: { steamId: '76561198000000099', currency: 'GBP' },
      expectedRevision: clientA.settingsRevision,
    });
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(storageStore.settings.value.steamId).toBe('76561198000000001');
  });

  it('rejects a stale tradables save after another client writes', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = {
      value: ['Real Game'],
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    const clientA = await handleMessage({ type: 'GET_TRADABLES' });
    const clientB = await handleMessage({ type: 'GET_TRADABLES' });
    expect(clientA.tradables).toEqual(['Real Game']);
    const saved = await handleMessage({
      type: 'SAVE_TRADABLES',
      tradables: ['New Game'],
      expectedRevision: clientB.tradablesRevision,
    });
    expect(saved.ok).toBe(true);

    const stale = await handleMessage({
      type: 'SAVE_TRADABLES',
      tradables: ['Stale Game'],
      expectedRevision: clientA.tradablesRevision,
    });
    expect(stale).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(storageStore.tradables_list.value).toEqual(['New Game']);
  });

  it('allows only one concurrent settings save for the same revision', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000', currency: 'EUR' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    const current = await handleMessage({ type: 'GET_SETTINGS' });

    const results = await Promise.all([
      handleMessage({
        type: 'SAVE_SETTINGS',
        settings: { steamId: '76561198000000001', currency: 'USD' },
        expectedRevision: current.settingsRevision,
      }),
      handleMessage({
        type: 'SAVE_SETTINGS',
        settings: { steamId: '76561198000000002', currency: 'EUR' },
        expectedRevision: current.settingsRevision,
      }),
    ]);

    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => result.code === 'CONFLICT')).toHaveLength(1);
  });

  it('allows only one concurrent tradables save for the same revision', async () => {
    storageStore.tradables_list = {
      value: ['Original Game'],
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    const current = await handleMessage({ type: 'GET_TRADABLES' });

    const results = await Promise.all([
      handleMessage({
        type: 'SAVE_TRADABLES',
        tradables: ['First Game'],
        expectedRevision: current.tradablesRevision,
      }),
      handleMessage({
        type: 'SAVE_TRADABLES',
        tradables: ['Second Game'],
        expectedRevision: current.tradablesRevision,
      }),
    ]);

    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => result.code === 'CONFLICT')).toHaveLength(1);
  });

  it('rejects restoring a snapshot over a newer tradables revision', async () => {
    storageStore.tradables_list = {
      value: ['Original Game'],
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore['tradables_snapshot:snap_1'] = {
      value: { tradables: ['Snapshot Game'] },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    const original = await handleMessage({ type: 'GET_TRADABLES' });
    const saved = await handleMessage({
      type: 'SAVE_TRADABLES',
      tradables: ['Newer Game'],
      expectedRevision: original.tradablesRevision,
    });
    expect(saved.ok).toBe(true);

    const restored = await handleMessage({
      type: 'RESTORE_TRADABLES_SNAPSHOT',
      id: 'snap_1',
      expectedRevision: original.tradablesRevision,
    });

    expect(restored).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(storageStore.tradables_list.value).toEqual(['Newer Game']);
  });

  it('returns a normally completed uncached profile', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000', regions: ['eu'], currency: 'EUR' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = { value: [], cachedAt: Date.now(), expiresAt: 0 };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [] } }),
      headers: { get: () => null },
    });

    const profile = await handleMessage({ type: 'GET_PROFILE', requestId: 'normal-profile' });

    expect(profile.error).toBeUndefined();
    expect(profile.profileComplete).toBe(true);
    expect(profile.profileRequestId).toBe('normal-profile');
  });

  it('coalesces concurrent profile requests without invalidating either response', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000003', regions: ['eu'], currency: 'EUR' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = { value: [], cachedAt: Date.now(), expiresAt: 0 };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [] } }),
      headers: { get: () => null },
    });

    const [first, second] = await Promise.all([
      handleMessage({ type: 'GET_PROFILE', requestId: 'profile-a' }),
      handleMessage({ type: 'GET_PROFILE', requestId: 'profile-b' }),
    ]);

    expect(first.error).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(first.profileGeneration).toBe(second.profileGeneration);
    expect(first.profileRequestId).toBe('profile-a');
    expect(second.profileRequestId).toBe('profile-b');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not let an in-flight profile repopulate cache after CLEAR_CACHE', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000', regions: ['eu'], currency: 'EUR' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = { value: [], cachedAt: Date.now(), expiresAt: 0 };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }] } }),
      headers: { get: () => null },
    });
    fetch.mockImplementationOnce(() => new Promise(() => {}));

    const profilePromise = handleMessage({ type: 'GET_PROFILE', requestId: 'profile-under-clear' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    await handleMessage({ type: 'CLEAR_CACHE' });
    const profile = await profilePromise;

    expect(profile.error).toBe('Profile request invalidated');
    expect(Object.keys(storageStore).filter(key => (
      key.startsWith('wishlist:')
      || key.startsWith('wishlist-progress:')
      || key.startsWith('appname:')
      || key.startsWith('resolve:')
    ))).toEqual([]);
  });

  it('returns { ok: false } when SAVE_SETTINGS storage write fails', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000', currency: 'EUR' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = { value: [], cachedAt: Date.now(), expiresAt: 0 };
    failSetKeys.add('settings');
    const current = await handleMessage({ type: 'GET_SETTINGS' });

    const result = await handleMessage({
      type: 'SAVE_SETTINGS',
      settings: { steamId: '76561198000000000', currency: 'USD' },
      expectedRevision: current.settingsRevision,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/settings save failed/i);
    expect(storageStore.settings.value.currency).toBe('EUR');
  });

  it('returns { ok: false } when SAVE_TRADABLES storage write fails', async () => {
    storageStore.settings = {
      value: { steamId: '76561198000000000' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    storageStore.tradables_list = { value: ['Old Game'], cachedAt: Date.now(), expiresAt: 0 };
    failSetKeys.add('tradables_list');
    const current = await handleMessage({ type: 'GET_TRADABLES' });

    const result = await handleMessage({
      type: 'SAVE_TRADABLES',
      tradables: ['New Game'],
      expectedRevision: current.tradablesRevision,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/tradables save failed/i);
    expect(storageStore.tradables_list.value).toEqual(['Old Game']);
  });
});

describe('GG.deals rate-limit broadcasts', () => {
  it('broadcasts reset information when a price request hits 429', async () => {
    const resetAt = Math.floor(Date.now() / 1000);
    storageStore.settings = {
      value: {
        apiKey: 'KEY',
        regions: ['eu'],
        currency: 'EUR',
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    global.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Too many requests' }), {
        status: 429,
        headers: {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(resetAt),
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          123: {
            title: 'Rate Limited Game',
            url: 'https://gg.deals/game/rate-limited-game/',
            prices: {
              currentRetail: '1.23',
              historicalRetail: '2.34',
              currency: 'EUR',
            },
          },
        },
      }), {
        status: 200,
        headers: {
          'x-ratelimit-limit': '100',
          'x-ratelimit-remaining': '99',
          'x-ratelimit-reset': String(resetAt + 60),
        },
      }));

    await handleMessage({
      type: 'GET_PRICES',
      items: [{ id: '123', type: 'app' }],
      regions: ['eu'],
    });

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'GGDEALS_RATE_LIMITED',
      items: [{ id: '123', type: 'app' }],
      regions: ['eu'],
      resetAt: resetAt * 1000,
    }));
  });
});
