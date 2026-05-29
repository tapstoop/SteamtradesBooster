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
});
