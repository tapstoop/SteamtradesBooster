import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};
global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, cb) => cb({ [key]: store[key] ?? null })),
      set: vi.fn((obj, cb) => { Object.assign(store, obj); if (cb) cb(); }),
      remove: vi.fn((key, cb) => { delete store[key]; if (cb) cb(); }),
    }
  }
};

global.fetch = vi.fn();

import { fetchProfile } from '../background/profile.js';

const STEAM_ID = `76561198${'0'.repeat(9)}`;

function mockEmptyWishlist() {
  fetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => ({ response: { items: [] } }),
  });
}

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
  vi.clearAllMocks();
});

describe('fetchProfile tradable resolution cache', () => {
  it('reports wishlist progress after each appdetails response', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }, { appid: 43 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'First Game' } } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 43: { success: true, data: { name: 'Second Game' } } }),
    });
    const progress = [];

    await fetchProfile(STEAM_ID, [], { onWishlistProgress: value => progress.push(value) });

    expect(progress).toHaveLength(3);
    expect(progress.slice(0, 2).map(item => item.completed)).toEqual([1, 2]);
    expect(progress.at(-1).wishlist).toEqual(['First Game', 'Second Game']);
    expect(progress.slice(0, 2).every(item => item.done === false)).toBe(true);
    expect(progress.at(-1).done).toBe(true);
  });

  it('returns fetched names when profile cache writes fail', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'Cache Failure Game' } } }),
    });
    const originalSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn((obj, cb) => {
      chrome.runtime.lastError = { message: 'quota exceeded' };
      cb?.();
      chrome.runtime.lastError = null;
    });

    try {
      const result = await fetchProfile(STEAM_ID, []);
      expect(result.wishlist).toEqual(['Cache Failure Game']);
    } finally {
      chrome.storage.local.set = originalSet;
      chrome.runtime.lastError = null;
    }
  });

  it('does not promote an incomplete appdetails batch to the final cache', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }, { appid: 43 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'Only Complete Game' } } }),
    });
    fetch.mockRejectedValueOnce(new Error('offline'));

    const result = await fetchProfile(STEAM_ID, []);

    expect(result.wishlist).toEqual(['Only Complete Game']);
    expect(result.profileComplete).toBe(false);
    expect(result.failedAppIds).toContain('43');
    expect(store[`wishlist:${STEAM_ID}`]).toBeUndefined();
    expect(store[`wishlist-progress:${STEAM_ID}`].value.complete).toBe(false);
    expect(store[`wishlist-progress:${STEAM_ID}`].value.schemaVersion).toBe(2);
    expect(store[`wishlist-progress:${STEAM_ID}`].value.failedAppIds).toContain('43');
  });

  it('caches an empty public wishlist as complete and reuses it on reopen', async () => {
    mockEmptyWishlist();

    const first = await fetchProfile(STEAM_ID, []);
    expect(first.wishlist).toEqual([]);
    expect(first.profileComplete).toBe(true);
    expect(first.wishlistTotal).toBe(0);
    expect(store[`wishlist:${STEAM_ID}`]?.value?.complete).toBe(true);
    expect(store[`wishlist:${STEAM_ID}`]?.value?.wishlist).toEqual([]);
    expect(store[`wishlist:${STEAM_ID}`]?.value?.total).toBe(0);

    // Reopen: should use cache, no wishlist API call
    fetch.mockClear();
    const second = await fetchProfile(STEAM_ID, []);
    expect(second.wishlist).toEqual([]);
    expect(second.profileComplete).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses a pre-existing empty final wishlist cache without refetching', async () => {
    store[`wishlist:${STEAM_ID}`] = {
      value: {
        schemaVersion: 2,
        complete: true,
        wishlist: [],
        total: 0,
        failedAppIds: [],
        updatedAt: Date.now(),
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };

    const result = await fetchProfile(STEAM_ID, []);
    expect(result.wishlist).toEqual([]);
    expect(result.profileComplete).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('ignores a corrupt wishlist cache entry with missing wishlist array and refetches', async () => {
    store[`wishlist:${STEAM_ID}`] = {
      value: {
        schemaVersion: 2,
        complete: true,
        total: 5,
        failedAppIds: [],
        updatedAt: Date.now(),
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 100 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 100: { success: true, data: { name: 'Refetched Game' } } }),
    });

    const result = await fetchProfile(STEAM_ID, []);
    expect(result.wishlist).toEqual(['Refetched Game']);
    expect(result.profileComplete).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not promote appdetails not-found results to a complete final wishlist cache', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }, { appid: 43 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'Resolved Game' } } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 43: { success: false } }),
    });

    const result = await fetchProfile(STEAM_ID, []);

    expect(result.wishlist).toEqual(['Resolved Game']);
    expect(result.profileComplete).toBe(false);
    expect(result.failedAppIds).toContain('43');
    expect(store[`wishlist:${STEAM_ID}`]).toBeUndefined();
    expect(store[`wishlist-progress:${STEAM_ID}`].value.failedAppIds).toContain('43');
  });

  it('caches negative appdetails results so they are not refetched on reopen', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 43 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 43: { success: false } }),
    });

    const first = await fetchProfile(STEAM_ID, []);
    expect(first.failedAppIds).toContain('43');
    expect(first.profileComplete).toBe(false);
    expect(store['appname:43']?.value?.status).toBe('not-found');

    // Second call: wishlist returns again, but appdetails should hit negative cache (no network)
    fetch.mockClear();
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 43 }] } }),
    });
    // No appdetails mock — if it tries to fetch, it'll fail
    const second = await fetchProfile(STEAM_ID, []);
    expect(second.failedAppIds).toContain('43');
    const appdetailsCalls = fetch.mock.calls.filter(call =>
      String(call[0]).includes('/api/appdetails')
    );
    expect(appdetailsCalls).toHaveLength(0);
  });

  it('caches negative appdetails result on 404 without retrying', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 44 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({}),
    });

    const first = await fetchProfile(STEAM_ID, []);
    expect(first.failedAppIds).toContain('44');
    expect(store['appname:44']?.value?.status).toBe('not-found');

    // Reopen: appdetails should not be fetched
    fetch.mockClear();
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 44 }] } }),
    });
    const second = await fetchProfile(STEAM_ID, []);
    expect(second.failedAppIds).toContain('44');
    const appdetailsCalls = fetch.mock.calls.filter(call =>
      String(call[0]).includes('/api/appdetails')
    );
    expect(appdetailsCalls).toHaveLength(0);
  });

  it('does not cache negative result on network error (transient failure retries)', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 45 }] } }),
    });
    fetch.mockRejectedValueOnce(new Error('network down'));

    const first = await fetchProfile(STEAM_ID, []);
    expect(first.failedAppIds).toContain('45');
    // Network errors should not be cached
    expect(store['appname:45']).toBeUndefined();

    // Reopen: appdetails should be fetched again
    fetch.mockClear();
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 45 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 45: { success: true, data: { name: 'Recovered Game' } } }),
    });
    const second = await fetchProfile(STEAM_ID, []);
    expect(second.wishlist).toContain('Recovered Game');
  });

  it('ignores malformed cached app names and fetches appdetails instead', async () => {
    store['appname:42'] = {
      value: { name: 'Invalid Object' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'Fetched Game' } } }),
    });

    const result = await fetchProfile(STEAM_ID, []);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.wishlist).toEqual(['Fetched Game']);
    expect(result.profileComplete).toBe(true);
  });

  it('resumes schema v2 wishlist progress without refetching resolved appdetails', async () => {
    store[`wishlist-progress:${STEAM_ID}`] = {
      value: {
        schemaVersion: 2,
        complete: false,
        wishlist: ['Resolved Game'],
        resolved: [{ appId: '42', name: 'Resolved Game' }],
        failedAppIds: ['43'],
        completed: 1,
        total: 2,
        updatedAt: Date.now(),
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }, { appid: 43 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 43: { success: true, data: { name: 'Retried Game' } } }),
    });
    const progress = [];

    const result = await fetchProfile(STEAM_ID, [], { onWishlistProgress: value => progress.push(value) });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain('appids=43');
    expect(result.wishlist).toEqual(['Resolved Game', 'Retried Game']);
    expect(result.profileComplete).toBe(true);
    expect(store[`wishlist:${STEAM_ID}`].value).toMatchObject({
      schemaVersion: 2,
      complete: true,
      wishlist: ['Resolved Game', 'Retried Game'],
      total: 2,
    });
    expect(store[`wishlist-progress:${STEAM_ID}`]).toBeUndefined();
    expect(progress.some(item => item.resumed)).toBe(true);
  });

  it('retries when a legacy final wishlist cache exists alongside incomplete progress', async () => {
    store[`wishlist:${STEAM_ID}`] = {
      value: ['Legacy Partial Game'],
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    store[`wishlist-progress:${STEAM_ID}`] = {
      value: {
        schemaVersion: 2,
        complete: false,
        wishlist: ['Resolved Game'],
        resolved: [{ appId: '42', name: 'Resolved Game' }],
        failedAppIds: ['43'],
        completed: 1,
        total: 2,
        updatedAt: Date.now(),
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }, { appid: 43 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 43: { success: true, data: { name: 'Recovered Game' } } }),
    });

    const result = await fetchProfile(STEAM_ID, []);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain('appids=43');
    expect(result.wishlist).toEqual(['Resolved Game', 'Recovered Game']);
    expect(result.profileComplete).toBe(true);
    expect(store[`wishlist:${STEAM_ID}`].value).toMatchObject({
      schemaVersion: 2,
      complete: true,
      wishlist: ['Resolved Game', 'Recovered Game'],
    });
  });

  it('uses schema v2 final wishlist cache without network work', async () => {
    store[`wishlist:${STEAM_ID}`] = {
      value: {
        schemaVersion: 2,
        complete: true,
        wishlist: ['Cached Complete Game'],
        total: 1,
        failedAppIds: [],
        updatedAt: Date.now(),
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };

    const result = await fetchProfile(STEAM_ID, []);

    expect(fetch).not.toHaveBeenCalled();
    expect(result.wishlist).toEqual(['Cached Complete Game']);
    expect(result.profileComplete).toBe(true);
  });

  it('does not write wishlist caches when the active profile run is invalidated', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'Invalidated Game' } } }),
    });
    const shouldCommit = vi.fn(() => false);

    const result = await fetchProfile(STEAM_ID, [], { shouldCommit });

    expect(result.wishlist).toEqual(['Invalidated Game']);
    expect(store[`wishlist:${STEAM_ID}`]).toBeUndefined();
    expect(store[`wishlist-progress:${STEAM_ID}`]).toBeUndefined();
    expect(store['appname:42']).toBeUndefined();
    expect(store['resolve:invalidated game']).toBeUndefined();
  });

  it('does not use schema v1 progress as resolved appdetails source', async () => {
    store[`wishlist-progress:${STEAM_ID}`] = {
      value: {
        schemaVersion: 1,
        complete: false,
        wishlist: ['Old Partial Name'],
        resolvedAppIds: ['42'],
        failedAppIds: [],
        completed: 1,
        total: 1,
      },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'Fresh Game' } } }),
    });

    const result = await fetchProfile(STEAM_ID, []);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.wishlist).toEqual(['Fresh Game']);
  });

  it('deduplicates duplicate wishlist appIds before appdetails requests', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ response: { items: [{ appid: 42 }, { appid: 42 }] } }),
    });
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ 42: { success: true, data: { name: 'Duplicate Safe Game' } } }),
    });

    const result = await fetchProfile(STEAM_ID, []);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.wishlist).toEqual(['Duplicate Safe Game']);
  });

  it('caches tradable resolutions with Steam type', async () => {
    mockEmptyWishlist();

    await fetchProfile(STEAM_ID, [
      { appId: 232, name: 'Valve Complete Pack', type: 'bundle' },
      { appId: 123, name: 'Some Sub Package', type: 'sub' },
    ]);

    expect(store['resolve:valve complete pack'].value).toEqual({ appId: '232', type: 'bundle' });
    expect(store['resolve:some sub package'].value).toEqual({ appId: '123', type: 'sub' });
  });

  it('does not downgrade an existing typed resolution', async () => {
    store['resolve:valve complete pack'] = {
      value: { appId: '232', type: 'bundle' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    mockEmptyWishlist();

    await fetchProfile(STEAM_ID, [
      { appId: 232, name: 'Valve Complete Pack', type: 'app' },
    ]);

    expect(store['resolve:valve complete pack'].value).toEqual({ appId: '232', type: 'bundle' });
  });

  it('upgrades an existing app resolution when the tradable is typed as a bundle', async () => {
    store['resolve:valve complete pack'] = {
      value: { appId: '232', type: 'app' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    mockEmptyWishlist();

    await fetchProfile(STEAM_ID, [
      { appId: 232, name: 'Valve Complete Pack', type: 'bundle' },
    ]);

    expect(store['resolve:valve complete pack'].value).toEqual({ appId: '232', type: 'bundle' });
  });

  it('does not overwrite a confirmed typed resolution', async () => {
    store['resolve:valve complete pack:confirmed'] = {
      value: { appId: '232', type: 'bundle' },
      cachedAt: Date.now(),
      expiresAt: 0,
    };
    mockEmptyWishlist();

    await fetchProfile(STEAM_ID, [
      { appId: 999, name: 'Valve Complete Pack', type: 'app' },
    ]);

    expect(store['resolve:valve complete pack']).toBeUndefined();
    expect(store['resolve:valve complete pack:confirmed'].value).toEqual({ appId: '232', type: 'bundle' });
  });

  it('does not commit tradable resolutions after the active run becomes stale', async () => {
    mockEmptyWishlist();
    const shouldCommit = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await fetchProfile(STEAM_ID, [
      { appId: 232, name: 'Valve Complete Pack', type: 'bundle' },
    ], { shouldCommit });

    expect(store['resolve:valve complete pack']).toBeUndefined();
  });
});
