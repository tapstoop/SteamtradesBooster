import { describe, it, expect, vi } from 'vitest';

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn(),
  },
  storage: {
    local: {
      get: vi.fn(),
      set: vi.fn(),
    },
  },
};

const {
  formatRefreshDate,
  getCardRefreshTimestamp,
  getStaleAppIds,
  getDealsCacheIdentity,
} = await import('../popup/deals.js');

describe('formatRefreshDate', () => {
  it('formats cached price timestamps as day/month/year', () => {
    expect(formatRefreshDate(Date.UTC(2026, 4, 12))).toBe('12/05/2026');
  });

  it('returns an empty string for missing timestamps', () => {
    expect(formatRefreshDate(null)).toBe('');
  });
});

describe('getCardRefreshTimestamp', () => {
  it('uses the display region timestamp first', () => {
    const card = {
      pricesPerRegion: {
        eu: { cachedAt: 100 },
        us: { cachedAt: 200 },
      },
    };

    expect(getCardRefreshTimestamp(card, { currency: 'USD', regions: ['eu', 'us'] })).toBe(200);
  });

  it('falls back to another configured region when the display region is missing', () => {
    const card = {
      pricesPerRegion: {
        eu: { cachedAt: 100 },
      },
    };

    expect(getCardRefreshTimestamp(card, { currency: 'USD', regions: ['us', 'eu'] })).toBe(100);
  });
});

describe('getStaleAppIds', () => {
  it('selects missing prices and prices older than the age threshold', () => {
    const now = Date.UTC(2026, 4, 12);
    const day = 24 * 60 * 60 * 1000;
    const prices = {
      fresh: { eu: { cachedAt: now - day } },
      stale: { eu: { cachedAt: now - (8 * day) } },
      partial: { us: { cachedAt: now - day } },
    };

    expect(getStaleAppIds(['fresh', 'stale', 'missing', 'partial'], prices, ['eu'], 7 * day, now))
      .toEqual(['stale', 'missing', 'partial']);
  });

  it('selects only app IDs missing any configured region for forever', () => {
    const prices = {
      complete: {
        eu: { cachedAt: 100 },
        us: { cachedAt: 100 },
      },
      missingRegion: {
        eu: { cachedAt: 100 },
      },
    };

    expect(getStaleAppIds(['complete', 'missingRegion', 'missing'], prices, ['eu', 'us'], Infinity))
      .toEqual(['missingRegion', 'missing']);
  });

  it('supports typed price keys with app-id fallback', () => {
    const now = Date.UTC(2026, 4, 12);
    const day = 24 * 60 * 60 * 1000;
    const prices = {
      'bundle:232': { eu: { cachedAt: now - day } },
      10: { eu: { cachedAt: now - day } },
    };
    expect(getStaleAppIds(['bundle:232', 'app:10', 'app:999'], prices, ['eu'], 7 * day, now))
      .toEqual(['app:999']);
  });
});

describe('getDealsCacheIdentity', () => {
  it('normalizes steamId values into stable cache identity keys', () => {
    expect(getDealsCacheIdentity({ steamId: '  76561198000000000 ' })).toBe('steam:76561198000000000');
  });

  it('returns steam:none when steamId is missing', () => {
    expect(getDealsCacheIdentity({})).toBe('steam:none');
  });
});
