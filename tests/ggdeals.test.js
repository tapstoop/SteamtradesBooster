import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};

global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, cb) => cb({ [key]: store[key] ?? null })),
      set: vi.fn((obj, cb) => { Object.assign(store, obj); if (cb) cb(); }),
    },
  },
};

global.fetch = vi.fn();

const { getPrices, getCachedPrices, getPriceCacheKeys, getPriceResult } = await import('../background/ggdeals.js');

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

  it('aggregates sub prices from contained apps and caches the aggregate by sub id', async () => {
    fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          500: {
            success: true,
            data: {
              apps: [{ id: 10 }, { id: 20 }],
            },
          },
        }),
      })
      .mockResolvedValueOnce(apiResponse({
        10: {
          title: 'Game 10',
          url: 'https://gg.deals/game/game-10/',
          prices: { currentRetail: '1.00', currentKeyshops: null, historicalRetail: '0.50', historicalKeyshops: null, currency: 'EUR' },
        },
        20: {
          title: 'Game 20',
          url: 'https://gg.deals/game/game-20/',
          prices: { currentRetail: '2.00', currentKeyshops: null, historicalRetail: '1.00', historicalKeyshops: null, currency: 'EUR' },
        },
      }));

    const prices = await getPrices('key', [{ id: '500', type: 'sub' }], ['eu']);
    expect(fetch.mock.calls[0][0]).toContain('/api/packagedetails?packageids=500');
    expect(fetch.mock.calls[1][0]).toContain('/prices/by-steam-app-id/');
    expect(getPriceResult(prices, '500', 'sub').eu.prices.currentRetail).toBe(300);
    expect(store['sub-price:500:eu']).toBeTruthy();

    const cached = await getCachedPrices([{ id: '500', type: 'sub' }], ['eu']);
    expect(getPriceResult(cached, '500', 'sub').eu.prices.historicalRetail).toBe(150);
  });

  it('fails closed for sub ids when packagedetails cannot be expanded', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ 500: { success: false } }),
    });

    const prices = await getPrices('key', [{ id: '500', type: 'sub' }], ['eu']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).not.toContain('/prices/by-steam-app-id/');
    expect(prices['500']).toBeUndefined();
    expect(prices['sub:500']).toEqual({});
    expect(store['sub-price:500:eu']).toBeFalsy();
  });

  it('returns typed refresh cache keys', () => {
    expect(getPriceCacheKeys([{ id: '10', type: 'app' }, { id: '232', type: 'bundle' }, { id: '500', type: 'sub' }], ['eu']))
      .toEqual(['price:10:eu', 'bundle-price:232:eu', 'sub-price:500:eu']);
  });
});
