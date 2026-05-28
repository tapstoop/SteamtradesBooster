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

const { getPrices, getCachedPrices, getPriceCacheKeys } = await import('../background/ggdeals.js');

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
    expect(prices['10'].eu.prices.currentRetail).toBe(100);
    expect(prices['232'].eu.prices.currentRetail).toBe(1000);

    const cached = await getCachedPrices([{ id: '232', type: 'bundle' }], ['eu']);
    expect(cached['232'].eu.title).toBe('Valve Complete Pack');
    expect(store['bundle-price:232:eu']).toBeTruthy();
    expect(store['price:232:eu']).toBeFalsy();
  });

  it('returns typed refresh cache keys', () => {
    expect(getPriceCacheKeys([{ id: '10', type: 'app' }, { id: '232', type: 'bundle' }], ['eu']))
      .toEqual(['price:10:eu', 'bundle-price:232:eu']);
  });
});
