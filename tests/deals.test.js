import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';

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
  mergePriceResponse,
  normalizeGgDealsUrl,
  steamStoreUrl,
  createGgDealsLinkElement,
  renderGgDealsLink,
  createDealsGameListElement,
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

  it('does not use raw app prices as fallback for bundle/sub typed keys', () => {
    const now = Date.UTC(2026, 4, 12);
    const prices = {
      232: { eu: { cachedAt: now } },
      500: { eu: { cachedAt: now } },
    };

    expect(getStaleAppIds(['bundle:232', 'sub:500'], prices, ['eu'], 7 * 24 * 60 * 60 * 1000, now))
      .toEqual(['bundle:232', 'sub:500']);
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

describe('mergePriceResponse', () => {
  it('merges successful price keys when a partial response includes an error', () => {
    const cached = {
      'app:9': { eu: { title: 'Cached Game' } },
    };
    const live = {
      'app:10': { eu: { title: 'Live Game' } },
      error: 'Some prices failed',
    };

    const result = mergePriceResponse(cached, live);

    expect(result.prices['app:9'].eu.title).toBe('Cached Game');
    expect(result.prices['app:10'].eu.title).toBe('Live Game');
    expect(result.error).toBe('Some prices failed');
  });

  it('preserves existing prices when the response only contains an error', () => {
    const cached = {
      'app:9': { eu: { title: 'Cached Game' } },
    };

    const result = mergePriceResponse(cached, { error: 'All failed' });

    expect(result.prices).toBe(cached);
    expect(result.prices['app:9'].eu.title).toBe('Cached Game');
    expect(result.error).toBe('All failed');
  });
});

describe('normalizeGgDealsUrl', () => {
  it('accepts HTTPS gg.deals URLs and true subdomains', () => {
    expect(normalizeGgDealsUrl('https://gg.deals/game/hollow-knight/')).toBe('https://gg.deals/game/hollow-knight/');
    expect(normalizeGgDealsUrl('https://www.gg.deals/game/hollow-knight/')).toBe('https://www.gg.deals/game/hollow-knight/');
    expect(normalizeGgDealsUrl('https://store.gg.deals/us/game/hollow-knight/')).toBe('https://store.gg.deals/us/game/hollow-knight/');
  });

  it('rejects non-HTTPS, lookalike, non-GG.deals, and credentialed URLs', () => {
    expect(normalizeGgDealsUrl('http://gg.deals/game/hollow-knight/')).toBeNull();
    expect(normalizeGgDealsUrl('https://gg.deals.evil.test/game/hollow-knight/')).toBeNull();
    expect(normalizeGgDealsUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeGgDealsUrl('https://user@gg.deals/game/hollow-knight/')).toBeNull();
  });
});

describe('renderGgDealsLink', () => {
  it('renders safe GG.deals links with noopener noreferrer', () => {
    const html = renderGgDealsLink('https://gg.deals/game/hollow-knight/?q=a%22b');

    expect(html).toContain('href="https://gg.deals/game/hollow-knight/?q=a%22b"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('does not render invalid GG.deals links', () => {
    expect(renderGgDealsLink('https://evil.test/game/hollow-knight/')).toBe('');
  });
});

describe('steamStoreUrl', () => {
  it('builds typed app, sub, and bundle URLs and falls back to app', () => {
    expect(steamStoreUrl('10', 'app')).toBe('https://store.steampowered.com/app/10');
    expect(steamStoreUrl('20', 'sub')).toBe('https://store.steampowered.com/sub/20');
    expect(steamStoreUrl('30', 'bundle')).toBe('https://store.steampowered.com/bundle/30');
    expect(steamStoreUrl('40', 'unknown')).toBe('https://store.steampowered.com/app/40');
  });

  it('rejects invalid IDs', () => {
    expect(steamStoreUrl('10.5', 'app')).toBeNull();
    expect(steamStoreUrl('10" onclick="alert(1)', 'app')).toBeNull();
    expect(steamStoreUrl('', 'app')).toBeNull();
  });
});

describe('createGgDealsLinkElement', () => {
  it('creates a safe external link with shared link attributes and text', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    globalThis.document = dom.window.document;

    const link = createGgDealsLinkElement('https://store.gg.deals/us/game/example/');

    expect(link).not.toBeNull();
    expect(link.textContent).toBe('GG.deals ↗');
    expect(link.href).toBe('https://store.gg.deals/us/game/example/');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('rejects unsafe URLs and keeps supplied text out of the DOM', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    globalThis.document = dom.window.document;

    expect(createGgDealsLinkElement('http://gg.deals/game/example/')).toBeNull();
    expect(createGgDealsLinkElement('https://gg.deals.evil.test/game/example/')).toBeNull();
    expect(createGgDealsLinkElement('javascript:alert(1)')).toBeNull();
    expect(createGgDealsLinkElement('https://user@gg.deals/game/example/')).toBeNull();
  });
});

describe('createDealsGameListElement', () => {
  it('renders valid wishlist deal links and normal price card elements', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    globalThis.document = dom.window.document;

    const cards = [
      {
        title: 'A Game',
        appId: '10',
        type: 'app',
        bestCurrent: null,
        currency: 'EUR',
      },
      {
        title: 'Z Hollow Knight',
        appId: '367520',
        type: 'app',
        bestCurrent: 749,
        bestAtl: 399,
        pctAboveAtl: 88,
        currency: 'EUR',
        usedRegion: 'eu',
        url: 'https://store.gg.deals/us/game/hollow-knight/',
      },
    ];
    const originalOrder = cards.map(card => card.title);
    const list = createDealsGameListElement(cards, { dealThresholdPct: 10 }, 'name-desc');

    const gameCard = list.querySelector('.game-card');
    const title = list.querySelector('.game-card-title');
    const meta = list.querySelector('.game-card-meta');
    const atl = list.querySelector('.atl');

    expect(gameCard).not.toBeNull();
    expect(title).not.toBeNull();
    expect(meta).not.toBeNull();
    expect(atl).not.toBeNull();
    expect(meta.textContent).toContain('€7.49');
    expect(meta.textContent).toContain('€3.99');

    const steamLink = title.querySelector('a');
    expect(steamLink.textContent).toBe('Z Hollow Knight');
    expect(steamLink.href).toMatch(/^https:\/\/store\.steampowered\.com\/app\/367520/);
    expect(steamLink.target).toBe('_blank');
    expect(steamLink.rel).toBe('noopener noreferrer');

    const ggDealsLink = [...meta.querySelectorAll('a')]
      .find(link => link.textContent === 'GG.deals ↗');
    expect(ggDealsLink.href).toBe('https://store.gg.deals/us/game/hollow-knight/');
    expect(ggDealsLink.target).toBe('_blank');
    expect(ggDealsLink.rel).toBe('noopener noreferrer');
    expect(cards.map(card => card.title)).toEqual(originalOrder);
  });

  it('renders malicious wishlist deal data as inert text and omits unsafe links', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    globalThis.document = dom.window.document;

    const list = createDealsGameListElement([
      {
        title: 'Game <script>alert(1)</script>',
        appId: '10" onclick="alert(1)',
        type: 'app',
        bestCurrent: 499,
        bestAtl: 299,
        pctAboveAtl: 40,
        currency: 'EUR',
        url: 'javascript:alert(1)',
        ggdealsUrl: 'https://gg.deals.evil.test/game/<img src=x onerror=alert(1)>',
      },
    ], { dealThresholdPct: 10 }, 'best-deal');

    expect(list.querySelector('script')).toBeNull();
    expect(list.querySelector('img')).toBeNull();
    expect(list.textContent).toContain('Game <script>alert(1)</script>');
    expect(list.innerHTML).not.toMatch(/\son(?:error|click|focus)=/i);

    const links = [...list.querySelectorAll('a')];
    expect(links).toHaveLength(0);
  });
});
