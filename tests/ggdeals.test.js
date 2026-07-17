import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};

global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, cb) => cb({ [key]: store[key] ?? null })),
      set: vi.fn((obj, cb) => { Object.assign(store, obj); if (cb) cb(); }),
      remove: vi.fn((key, cb) => { delete store[key]; cb?.(); }),
    },
  },
};

global.fetch = vi.fn();

const { DIAGNOSTICS_KEY } = await import('../background/diagnostics.js');
const { getPrices, getCachedPrices, getPriceCacheKeys, getPriceResult, isRefreshFallbackPrice } = await import('../background/ggdeals.js');

function apiResponse(data, headers = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    json: async () => ({ success: true, data }),
  };
}

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
  vi.clearAllMocks();
});

describe('gg.deals typed prices', () => {
  it('routes app and bundle IDs to separate endpoints and cache keys', async () => {
    fetch
      .mockResolvedValueOnce(apiResponse({
        10: {
          title: 'App Game',
          url: 'https://gg.deals/game/app-game/',
          prices: { currentRetail: '1.00', currentKeyshops: null, historicalRetail: '0.50', historicalKeyshops: null, currency: 'EUR' },
        },
      }))
      .mockResolvedValueOnce(apiResponse({
        232: {
          title: 'Valve Complete Pack',
          url: 'https://gg.deals/pack/valve-complete-pack/',
          prices: { currentRetail: '10.00', currentKeyshops: null, historicalRetail: '5.00', historicalKeyshops: null, currency: 'EUR' },
        },
      }));

    const prices = await getPrices('key', [
      { id: '10', type: 'app' },
      { id: '232', type: 'bundle' },
    ], ['eu']);

    expect(fetch.mock.calls[0][0]).toContain('/prices/by-steam-app-id/');
    expect(fetch.mock.calls[1][0]).toContain('/prices/by-steam-bundle-id/');
    expect(getPriceResult(prices, '10', 'app').eu.prices.currentRetail).toBe(100);
    expect(getPriceResult(prices, '232', 'bundle').eu.prices.currentRetail).toBe(1000);

    const cached = await getCachedPrices([{ id: '232', type: 'bundle' }], ['eu']);
    expect(getPriceResult(cached, '232', 'bundle').eu.title).toBe('Valve Complete Pack');
    expect(store['bundle-price:232:eu']).toBeTruthy();
    expect(store['price:232:eu']).toBeFalsy();
  });

  it('persists API call and rate-limit diagnostics from GG.deals headers', async () => {
    fetch.mockResolvedValueOnce(apiResponse({
      10: {
        title: 'App Game',
        url: 'https://gg.deals/game/app-game/',
        prices: { currentRetail: '1.00', currentKeyshops: null, historicalRetail: '0.50', historicalKeyshops: null, currency: 'EUR' },
      },
    }, {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '88',
      'x-ratelimit-reset': '1780000000',
    }));

    await getPrices('key', [{ id: '10', type: 'app' }], ['eu']);

    expect(store[DIAGNOSTICS_KEY].rateLimit.limit).toBe(100);
    expect(store[DIAGNOSTICS_KEY].rateLimit.remaining).toBe(88);
    expect(store[DIAGNOSTICS_KEY].lastApiCalls[0]).toMatchObject({
      type: 'app',
      count: 1,
      region: 'eu',
      status: 200,
    });
  });

  it('keeps app and bundle prices distinct when numeric IDs collide', async () => {
    fetch
      .mockResolvedValueOnce(apiResponse({
        123: {
          title: 'App 123',
          url: 'https://gg.deals/game/app-123/',
          prices: { currentRetail: '1.11', currentKeyshops: null, historicalRetail: '1.00', historicalKeyshops: null, currency: 'EUR' },
        },
      }))
      .mockResolvedValueOnce(apiResponse({
        123: {
          title: 'Bundle 123',
          url: 'https://gg.deals/pack/bundle-123/',
          prices: { currentRetail: '9.99', currentKeyshops: null, historicalRetail: '5.00', historicalKeyshops: null, currency: 'EUR' },
        },
      }));

    const prices = await getPrices('key', [
      { id: '123', type: 'app' },
      { id: '123', type: 'bundle' },
    ], ['eu']);

    expect(prices['app:123'].eu.title).toBe('App 123');
    expect(prices['bundle:123'].eu.title).toBe('Bundle 123');
    expect(prices['123'].eu.title).toBe('App 123');
  });

  it('does not fall back from bundle/sub typed reads to raw app prices', async () => {
    const prices = {
      123: { eu: { title: 'Raw app price' } },
      'app:123': { eu: { title: 'Typed app price' } },
    };

    expect(getPriceResult(prices, '123', 'app').eu.title).toBe('Typed app price');
    expect(getPriceResult(prices, '123', 'bundle')).toBeNull();
    expect(getPriceResult(prices, '123', 'sub')).toBeNull();
  });

  it('force refresh bypasses existing cache without deleting the last known good value', async () => {
    store['price:10:eu'] = {
      value: {
        title: 'Cached Game',
        url: 'https://gg.deals/game/cached-game/',
        prices: { currentRetail: 100, currentKeyshops: null, historicalRetail: 50, historicalKeyshops: null, currency: 'EUR' },
      },
      cachedAt: 111,
    };

    fetch.mockResolvedValueOnce(apiResponse({}));

    const prices = await getPrices('key', [{ id: '10', type: 'app' }], ['eu'], { forceRefresh: true });

    expect(getPriceResult(prices, '10', 'app')).toBeNull();
    expect(store['price:10:eu'].value.title).toBe('Cached Game');
  });

  it('keeps successful price batches when another batch fails', async () => {
    fetch
      .mockResolvedValueOnce(apiResponse({
        10: {
          title: 'App Game',
          url: 'https://gg.deals/game/app-game/',
          prices: { currentRetail: '1.00', currentKeyshops: null, historicalRetail: '0.50', historicalKeyshops: null, currency: 'EUR' },
        },
      }))
      .mockRejectedValueOnce(new Error('bundle batch failed'));

    const prices = await getPrices('key', [
      { id: '10', type: 'app' },
      { id: '232', type: 'bundle' },
    ], ['eu']);

    expect(getPriceResult(prices, '10', 'app').eu.title).toBe('App Game');
    expect(prices.error).toContain('1 GG.deals price batch failed');
  });

  it('fetches sub prices directly and preserves the pack URL', async () => {
    fetch.mockResolvedValueOnce(apiResponse({
      132479: {
        title: 'METAL GEAR SOLID V: The Definitive Experience',
        url: 'https://gg.deals/pack/metal-gear-solid-v-the-definitive-experience/',
        prices: { currentRetail: '16.10', currentKeyshops: null, historicalRetail: '9.99', historicalKeyshops: null, currency: 'EUR' },
      },
    }));

    const prices = await getPrices('key', [{ id: '132479', type: 'sub' }], ['eu']);
    const sub = getPriceResult(prices, '132479', 'sub').eu;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('/prices/by-steam-sub-id/');
    expect(sub.prices.currentRetail).toBe(1610);
    expect(sub.url).toContain('/pack/metal-gear-solid-v-the-definitive-experience/');
    expect(sub.priceOrigin).toBe('ggdeals-sub-api-v1');
    expect(store['sub-price:132479:eu'].value.priceOrigin).toBe('ggdeals-sub-api-v1');
  });

  it('invalidates legacy calculated sub caches and replaces them from the API', async () => {
    store['sub-price:500:eu'] = {
      value: { title: 'Calculated total', isSub: true, containedApps: ['10'], prices: { currentRetail: 4498 } },
      cachedAt: 222,
    };
    fetch.mockResolvedValueOnce(apiResponse({
      500: {
        title: 'Official Package',
        url: 'https://gg.deals/pack/official-package/',
        prices: { currentRetail: '16.10', currentKeyshops: null, historicalRetail: '10.00', historicalKeyshops: null, currency: 'EUR' },
      },
    }));

    const prices = await getPrices('key', [{ id: '500', type: 'sub' }], ['eu']);

    expect(chrome.storage.local.remove).toHaveBeenCalledWith('sub-price:500:eu', expect.any(Function));
    expect(getPriceResult(prices, '500', 'sub').eu.title).toBe('Official Package');
  });

  it('uses only an official sub cache as a failed refresh fallback', async () => {
    store['sub-price:500:eu'] = {
      value: {
        title: 'Last Official Package',
        url: 'https://gg.deals/pack/last-official-package/',
        priceOrigin: 'ggdeals-sub-api-v1',
        prices: { currentRetail: 1610, currentKeyshops: null, historicalRetail: 999, historicalKeyshops: null, currency: 'EUR' },
      },
      cachedAt: 222,
      expiresAt: 0,
    };
    fetch.mockRejectedValueOnce(new Error('sub endpoint unavailable'));

    const prices = await getPrices('key', [{ id: '500', type: 'sub' }], ['eu'], { forceRefresh: true });
    const sub = getPriceResult(prices, '500', 'sub').eu;

    expect(sub.title).toBe('Last Official Package');
    expect(sub.refreshFallback).toBe(true);
    expect(sub.cachedAt).toBe(222);
    expect(prices.error).toContain('last official cached response');
  });

  it('returns an empty typed result when a sub has no API response or official cache', async () => {
    fetch.mockResolvedValueOnce(apiResponse({}));

    const prices = await getPrices('key', [{ id: '500', type: 'sub' }], ['eu']);

    expect(prices['sub:500']).toEqual({});
    expect(store['sub-price:500:eu']).toBeFalsy();
  });

  it('keeps same numeric app and sub requests independent', async () => {
    fetch
      .mockResolvedValueOnce(apiResponse({
        500: { title: 'App 500', url: 'https://gg.deals/game/app-500/', prices: { currentRetail: '4.00', currency: 'EUR' } },
      }))
      .mockResolvedValueOnce(apiResponse({
        500: { title: 'Sub 500', url: 'https://gg.deals/pack/sub-500/', prices: { currentRetail: '1.00', currency: 'EUR' } },
      }));

    const prices = await getPrices('key', [{ id: '500', type: 'app' }, { id: '500', type: 'sub' }], ['eu']);

    expect(getPriceResult(prices, '500', 'app').eu.title).toBe('App 500');
    expect(getPriceResult(prices, '500', 'sub').eu.title).toBe('Sub 500');
  });

  it('returns typed refresh cache keys', () => {
    expect(getPriceCacheKeys([{ id: '10', type: 'app' }, { id: '232', type: 'bundle' }, { id: '500', type: 'sub' }], ['eu']))
      .toEqual(['price:10:eu', 'bundle-price:232:eu', 'sub-price:500:eu']);
  });

  it('identifies refresh fallback prices for broadcast suppression', () => {
    expect(isRefreshFallbackPrice({ refreshFallback: true })).toBe(true);
    expect(isRefreshFallbackPrice({ title: 'Fresh price' })).toBe(false);
    expect(isRefreshFallbackPrice(null)).toBe(false);
  });

  it('persists rateLimitState to chrome.storage after API calls', async () => {
    fetch.mockResolvedValueOnce(apiResponse({
      '123': {
        title: 'Test',
        url: 'https://gg.deals/test/',
        prices: { currentRetail: '5.00', currentKeyshops: '3.00', historicalRetail: '4.00', historicalKeyshops: '2.00', currency: 'EUR' },
      },
    }, {
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '75',
      'x-ratelimit-reset': '60',
    }));

    await getPrices('test-key', [{ id: '123', type: 'app' }], ['eu']);

    expect(store.ggdeals_rate_limit_state).toBeDefined();
    expect(store.ggdeals_rate_limit_state.remaining).toBe(75);
    expect(store.ggdeals_rate_limit_state.limit).toBe(100);
    expect(store.ggdeals_rate_limit_state.lastUpdatedAt).toBeGreaterThan(0);
  });
});
