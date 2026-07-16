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
  renderGgDealsLink,
  createDealsGameListElement,
  initDeals,
} = await import('../popup/deals.js');

function createDealsContainer() {
  const dom = new JSDOM('<!doctype html><body><div id="tab-deals"></div></body>', { url: 'https://extension.test/popup.html' });
  globalThis.document = dom.window.document;
  return dom.window.document.querySelector('#tab-deals');
}

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

  it('renders GG.deals rate-limit status instead of generic price unavailable', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    globalThis.document = dom.window.document;
    const resetAt = Date.UTC(2026, 6, 16, 14, 45);

    const list = createDealsGameListElement([
      {
        title: 'Rate Limited Game',
        appId: '444',
        type: 'app',
        bestCurrent: null,
        currency: 'EUR',
        priceStatus: { type: 'rate-limited', resetAt },
      },
    ], { dealThresholdPct: 10 }, 'best-deal');

    expect(list.textContent).toContain('GG.deals API limit reached');
    expect(list.textContent).toContain('resets at');
    expect(list.textContent).not.toContain('Price unavailable');
  });

  it('keeps generic price unavailable for unpriced cards without rate-limit status', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    globalThis.document = dom.window.document;

    const list = createDealsGameListElement([
      {
        title: 'Normally Missing Price',
        appId: '445',
        type: 'app',
        bestCurrent: null,
        currency: 'EUR',
      },
    ], { dealThresholdPct: 10 }, 'best-deal');

    expect(list.textContent).toContain('Price unavailable');
    expect(list.textContent).not.toContain('GG.deals API limit reached');
  });
});

describe('wishlist progress loading', () => {
  it('renders only matching wishlist progress messages', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({ steamId: '76561198000000000', regions: ['eu'], currency: 'EUR' });
      else if (message.type === 'GET_CACHED_PROFILE') callback({
        wishlist: [],
        partialWishlist: ['Cached Partial'],
        partialMeta: { completed: 1, total: 2 },
      });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000000',
      requestId: 'wrong',
      generation: 1,
      wishlist: ['Wrong Game'],
    });
    expect(container.querySelector('#deals-summary').textContent).not.toContain('Wrong Game');

    const profileRequest = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === 'GET_PROFILE')[0];
    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000000',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Live Game'],
      done: false,
    });
    expect(container.querySelector('#deals-body').textContent).toContain('Live Game');

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000000',
      requestId: profileRequest.requestId,
      generation: 2,
      wishlist: ['Stale Generation'],
      done: false,
    });
    expect(container.querySelector('#deals-body').textContent).not.toContain('Stale Generation');

    profileCallback({ wishlist: [], tradables: [], profileComplete: true });
    await loadPromise;
  });

  it('hydrates wishlist progress cards with cached prices before the full profile finishes', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000003',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else if (message.type === 'GET_CACHED_RESOLUTIONS') callback({
        'Live Game': { appId: '42', type: 'app', status: 'hit' },
        'Second Game': { appId: '43', type: 'app', status: 'hit' },
      });
      else if (message.type === 'GET_CACHED_PRICES') callback({
        '42': {
          eu: {
            prices: {
              currentRetail: 499,
              historicalRetail: 999,
              currency: 'EUR',
            },
            cachedAt: Date.now(),
            url: 'https://gg.deals/game/live-game/',
          },
        },
        '43': {
          eu: {
            prices: {
              currentRetail: 799,
              historicalRetail: 999,
              currency: 'EUR',
            },
            cachedAt: Date.now(),
            url: 'https://gg.deals/game/second-game/',
          },
        },
      });
      else if (message.type === 'COMMIT_DEALS_REFRESH') callback({ ok: true });
      else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));
    const profileRequest = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === 'GET_PROFILE')[0];

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000003',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Live Game'],
      done: false,
    });

    await vi.waitFor(() => expect(container.querySelector('#deals-body').textContent).toContain('€4.99'));
    expect(container.querySelector('#deals-body').textContent).toContain('GG.deals');

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000003',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Live Game', 'Second Game'],
      done: false,
    });

    expect(container.querySelector('#deals-body').textContent).toContain('Live Game');
    expect(container.querySelector('#deals-body').textContent).toContain('€4.99');
    await vi.waitFor(() => expect(container.querySelector('#deals-body').textContent).toContain('€7.99'));

    profileCallback({ wishlist: ['Live Game', 'Second Game'], tradables: [], profileComplete: true });
    await loadPromise;
    expect(container.querySelector('#deals-summary').textContent).not.toContain('resolving');
    expect(container.querySelector('#deals-body').textContent).toContain('€4.99');
    expect(container.querySelector('#deals-body').textContent).toContain('€7.99');
  });

  it('starts GG.deals prices for a resolved wishlist batch before the full profile finishes', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000004',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else if (message.type === 'GET_CACHED_PRICES') callback({});
      else if (message.type === 'COMMIT_DEALS_REFRESH') callback({ ok: true });
      else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));
    const profileRequest = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === 'GET_PROFILE')[0];

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000004',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Immediate Game'],
      resolved: [{ appId: '44', name: 'Immediate Game', type: 'app' }],
      done: false,
    });

    await vi.waitFor(() => expect(container.querySelector('.game-card-title a')?.href)
      .toBe('https://store.steampowered.com/app/44'));
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'GET_PRICES',
        items: [{ id: '44', type: 'app' }],
      }),
      expect.any(Function),
    ));

    expect(profileCallback).toBeTypeOf('function');
    profileCallback({ wishlist: ['Immediate Game'], tradables: [], profileComplete: true });
    await loadPromise;
  });

  it('keeps earlier batch price responses valid after a later wishlist batch arrives', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    const priceCallbacks = new Map();
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000005',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else if (message.type === 'GET_CACHED_PRICES') callback({});
      else if (message.type === 'GET_PRICES') {
        priceCallbacks.set(String(message.items[0].id), callback);
      } else if (message.type === 'COMMIT_DEALS_REFRESH') callback({ ok: true });
      else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));
    const profileRequest = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === 'GET_PROFILE')[0];

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000005',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['First Game'],
      resolved: [{ appId: '44', name: 'First Game', type: 'app' }],
      done: false,
    });
    await vi.waitFor(() => expect(priceCallbacks.get('44')).toBeTypeOf('function'));

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000005',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['First Game', 'Second Game'],
      resolved: [
        { appId: '44', name: 'First Game', type: 'app' },
        { appId: '45', name: 'Second Game', type: 'app' },
      ],
      done: false,
    });
    await vi.waitFor(() => expect(priceCallbacks.get('45')).toBeTypeOf('function'));

    priceCallbacks.get('44')({
      '44': {
        eu: {
          prices: {
            currentRetail: 444,
            historicalRetail: 999,
            currency: 'EUR',
          },
          cachedAt: Date.now(),
          url: 'https://gg.deals/game/first-game/',
        },
      },
    });

    await vi.waitFor(() => expect(container.querySelector('#deals-body').textContent).toContain('€4.44'));

    profileCallback({ wishlist: [], tradables: [], profileComplete: true });
    await loadPromise;
  });

  it('keeps progressive wishlist cards visible when the tab is reopened during final updating', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    let cachedResolutionCallback;
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000008',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: '',
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else if (message.type === 'GET_CACHED_RESOLUTIONS') cachedResolutionCallback = callback;
      else if (message.type === 'COMMIT_DEALS_REFRESH') callback({ ok: true });
      else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));
    const profileRequest = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === 'GET_PROFILE')[0];

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000008',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Visible During Updating'],
      resolved: [{ appId: '88', name: 'Visible During Updating', type: 'app' }],
      done: false,
    });
    expect(container.textContent).toContain('Visible During Updating');

    profileCallback({ wishlist: ['Visible During Updating'], tradables: [], profileComplete: true });
    await vi.waitFor(() => expect(cachedResolutionCallback).toBeTypeOf('function'));

    await initDeals(container);
    expect(container.textContent).toContain('Visible During Updating');
    expect(container.textContent).not.toContain('Loading wishlist');

    cachedResolutionCallback({});
    await loadPromise;
  });

  it('ignores late final wishlist work after CACHE_CLEARED during final updating', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    let cachedResolutionCallback;
    let commitCalled = false;
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000009',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: '',
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else if (message.type === 'GET_CACHED_RESOLUTIONS') cachedResolutionCallback = callback;
      else if (message.type === 'COMMIT_DEALS_REFRESH') {
        commitCalled = true;
        callback({ ok: true });
      } else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));
    const profileRequest = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === 'GET_PROFILE')[0];

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000009',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Cleared Late Game'],
      resolved: [{ appId: '99', name: 'Cleared Late Game', type: 'app' }],
      done: false,
    });
    profileCallback({ wishlist: ['Cleared Late Game'], tradables: [], profileComplete: true });
    await vi.waitFor(() => expect(cachedResolutionCallback).toBeTypeOf('function'));

    listener({ type: 'CACHE_CLEARED' });
    expect(container.textContent).toContain('Cache cleared. Reload wishlist to fetch again.');

    cachedResolutionCallback({});
    await loadPromise;

    expect(container.textContent).toContain('Cache cleared. Reload wishlist to fetch again.');
    expect(container.textContent).not.toContain('Cleared Late Game');
    expect(commitCalled).toBe(false);
  });

  it('does not persist deals cards for incomplete profiles', async () => {
    const container = createDealsContainer();
    const writes = [];
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => { writes.push(obj); cb?.(); });
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({ steamId: '76561198000000001', regions: ['eu'], currency: 'EUR', apiKey: '' });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'GET_PROFILE') callback({
        wishlist: ['Partial Game'],
        tradables: [],
        profileComplete: false,
        failedAppIds: ['43'],
        wishlistTotal: 2,
      });
      else if (message.type === 'GET_CACHED_RESOLUTIONS') callback({ 'Partial Game': { appId: '42', type: 'app', status: 'hit' } });
      else callback({});
    });

    await initDeals(container);

    expect(container.textContent).toContain('Partial Game');
    expect(container.textContent).toContain('Wishlist partially loaded');
    expect(writes.some(item => item.deals_cards_cache)).toBe(false);
  });

  it('refreshes prices without reloading the Steam wishlist profile', async () => {
    const container = createDealsContainer();
    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'deals_cards_cache') {
        cb({
          deals_cards_cache: {
            profileComplete: true,
            cacheIdentity: 'steam:76561198000000006',
            savedAt: 1,
            cards: [{
              title: 'Cached Price Game',
              appId: '66',
              type: 'app',
              pricesPerRegion: null,
              currency: 'EUR',
            }],
          },
        });
      } else cb({});
    });
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000006',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else if (message.type === 'REFRESH_PRICES') callback({
        '66': {
          eu: {
            prices: {
              currentRetail: 666,
              historicalRetail: 999,
              currency: 'EUR',
            },
            cachedAt: Date.now(),
            url: 'https://gg.deals/game/cached-price-game/',
          },
        },
      });
      else callback({});
    });

    await initDeals(container);
    container.querySelector('#deals-refresh').click();

    await vi.waitFor(() => expect(container.textContent).toContain('€6.66'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'REFRESH_PRICES' }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BEGIN_DEALS_REFRESH' }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_PROFILE' }),
      expect.any(Function),
    );
  });

  it('reload wishlist rebuilds from Steam and GG.deals without resolution or price cache reads', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'deals_cards_cache') {
        cb({
          deals_cards_cache: {
            profileComplete: true,
            cacheIdentity: 'steam:76561198000000012',
            savedAt: 1,
            cards: [{ title: 'Old Cached Game', appId: '1', type: 'app', pricesPerRegion: null }],
          },
        });
      } else cb({});
    });
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000012',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else if (message.type === 'RESOLVE_TITLES') callback([
        { appId: '1201', type: 'app', status: 'hit' },
        { appId: '1202', type: 'app', status: 'hit' },
      ]);
      else if (message.type === 'REFRESH_PRICES') callback({
        1201: {
          eu: {
            prices: {
              currentRetail: 1201,
              historicalRetail: 1500,
              currency: 'EUR',
            },
            cachedAt: Date.now(),
            url: 'https://gg.deals/game/fresh-reload-a/',
          },
        },
        1202: {
          eu: {
            prices: {
              currentRetail: 1202,
              historicalRetail: 1500,
              currency: 'EUR',
            },
            cachedAt: Date.now(),
            url: 'https://gg.deals/game/fresh-reload-b/',
          },
        },
      });
      else if (message.type === 'UPDATE_DEALS_REFRESH_PROGRESS') callback({ ok: true });
      else if (message.type === 'COMMIT_DEALS_REFRESH') callback({ ok: true });
      else callback({});
    });

    await initDeals(container);
    expect(container.textContent).toContain('Old Cached Game');

    container.querySelector('#deals-reload').click();
    expect(container.textContent).not.toContain('Old Cached Game');
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));
    const profileRequests = chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.type === 'GET_PROFILE');
    const profileRequest = profileRequests.at(-1);

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000012',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Fresh Reload A'],
      done: false,
    });

    await vi.waitFor(() => expect(container.textContent).toContain('Fresh Reload A'));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RESOLVE_TITLES',
        titles: ['Fresh Reload A'],
        forceRefresh: true,
      }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'REFRESH_PRICES',
        items: [{ id: '1201', type: 'app' }],
      }),
      expect.any(Function),
    );

    profileCallback({
      wishlist: ['Fresh Reload A', 'Fresh Reload B'],
      tradables: [],
      profileComplete: true,
    });

    await vi.waitFor(() => expect(container.textContent).toContain('Fresh Reload A'));
    await vi.waitFor(() => expect(container.textContent).toContain('€12.01'));
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'REFRESH_PRICES',
        items: [
          { id: '1201', type: 'app' },
          { id: '1202', type: 'app' },
        ],
      }),
      expect.any(Function),
    ));
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'COMMIT_DEALS_REFRESH',
        cards: expect.arrayContaining([
          expect.objectContaining({ title: 'Fresh Reload A', appId: '1201' }),
          expect.objectContaining({ title: 'Fresh Reload B', appId: '1202' }),
        ]),
      }),
      expect.any(Function),
    ));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_PROFILE', forceRefresh: true }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'RESOLVE_TITLES',
        titles: ['Fresh Reload A', 'Fresh Reload B'],
        forceRefresh: true,
      }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_CACHED_RESOLUTIONS' }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_CACHED_PRICES' }),
      expect.any(Function),
    );
  });

  it('force reload ignores persisted partial wishlist cards from an abandoned refresh', async () => {
    const container = createDealsContainer();
    const profileCallbacks = [];
    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'deals_cards_cache') {
        cb({
          deals_cards_cache: {
            profileComplete: false,
            cacheIdentity: 'steam:76561198000000013',
            refreshToken: 'old-refresh',
            partialCards: [{ title: 'Abandoned Partial', appId: '1300', type: 'app', pricesPerRegion: null }],
          },
        });
      } else cb({});
    });
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000013',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: '',
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallbacks.push(callback);
      else if (message.type === 'RESOLVE_TITLES') callback([{ appId: '1301', type: 'app', status: 'hit' }]);
      else if (message.type === 'COMMIT_DEALS_REFRESH') callback({ ok: true });
      else callback({});
    });

    const initialLoad = initDeals(container);
    await vi.waitFor(() => expect(profileCallbacks).toHaveLength(1));
    expect(container.textContent).toContain('Abandoned Partial');

    container.querySelector('#deals-reload').click();
    await vi.waitFor(() => expect(profileCallbacks).toHaveLength(2));
    profileCallbacks[1]({
      wishlist: ['Fresh Only'],
      tradables: [],
      profileComplete: true,
    });

    await vi.waitFor(() => expect(container.textContent).toContain('Fresh Only'));
    expect(container.textContent).not.toContain('Abandoned Partial');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_PROFILE', forceRefresh: true }),
      expect.any(Function),
    );
    profileCallbacks[0]({ wishlist: [], tradables: [], profileComplete: false });
    await initialLoad;
  });

  it('clears session-rendered wishlist cards when CACHE_CLEARED is received', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'deals_cards_cache') {
        cb({
          deals_cards_cache: {
            profileComplete: true,
            cacheIdentity: 'steam:76561198000000007',
            savedAt: 1,
            cards: [{ title: 'Old Session Game', appId: '77', type: 'app', pricesPerRegion: null }],
          },
        });
      } else cb({});
    });
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({ steamId: '76561198000000007', regions: ['eu'], currency: 'EUR', apiKey: '' });
      else callback({});
    });

    await initDeals(container);
    expect(container.textContent).toContain('Old Session Game');

    listener({ type: 'CACHE_CLEARED' });

    expect(container.textContent).not.toContain('Old Session Game');
    expect(container.textContent).toContain('Cache cleared. Reload wishlist to fetch again.');
  });

  it('marks only matching unpriced wishlist cards when GG.deals is rate-limited', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'deals_cards_cache') {
        cb({
          deals_cards_cache: {
            profileComplete: true,
            cacheIdentity: 'steam:76561198000000011',
            savedAt: 1,
            cards: [
              { title: 'Limited Game', appId: '111', type: 'app', pricesPerRegion: null, currency: 'EUR' },
              {
                title: 'Already Priced Game',
                appId: '222',
                type: 'app',
                currency: 'EUR',
                pricesPerRegion: {
                  eu: {
                    prices: {
                      currentRetail: 222,
                      historicalRetail: 333,
                      currency: 'EUR',
                    },
                    cachedAt: Date.now(),
                  },
                },
              },
            ],
          },
        });
      } else cb({});
    });
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000011',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else callback({});
    });

    await initDeals(container);
    listener({
      type: 'GGDEALS_RATE_LIMITED',
      items: [{ id: '111', type: 'app' }, { id: '222', type: 'app' }],
      regions: ['eu'],
      resetAt: Date.now() + 60_000,
    });

    const limitedCard = [...container.querySelectorAll('.game-card')]
      .find(card => card.textContent.includes('Limited Game'));
    const pricedCard = [...container.querySelectorAll('.game-card')]
      .find(card => card.textContent.includes('Already Priced Game'));

    expect(container.querySelector('#deals-summary').textContent).toContain('GG.deals API limit reached');
    expect(container.querySelector('#deals-summary').textContent).toContain('resets at');
    expect(limitedCard.textContent).toContain('GG.deals API limit reached');
    expect(limitedCard.textContent).not.toContain('Price unavailable');
    expect(pricedCard.textContent).toContain('€2.22');
    expect(pricedCard.textContent).not.toContain('GG.deals API limit reached');
  });

  it('shows GG.deals rate-limit status in the progressive wishlist summary', async () => {
    const container = createDealsContainer();
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    let profileCallback;
    chrome.storage.local.get.mockImplementation((key, cb) => cb({}));
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000012',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else if (message.type === 'GET_CACHED_PRICES') callback({});
      else if (message.type === 'GET_PRICES') callback({});
      else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));
    const profileRequest = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === 'GET_PROFILE')[0];

    listener({
      type: 'WISHLIST_PROGRESS',
      steamId: '76561198000000012',
      requestId: profileRequest.requestId,
      generation: 1,
      wishlist: ['Progress Limited Game'],
      resolved: [{ appId: '1212', name: 'Progress Limited Game', type: 'app' }],
      done: false,
    });

    await vi.waitFor(() => expect(container.querySelector('.game-card-title a')?.href)
      .toBe('https://store.steampowered.com/app/1212'));

    listener({
      type: 'GGDEALS_RATE_LIMITED',
      items: [{ id: '1212', type: 'app' }],
      regions: ['eu'],
      resetAt: Date.now() + 60_000,
    });

    const summaryText = container.querySelector('#deals-summary').textContent;
    expect(summaryText).toContain('1 games received');
    expect(summaryText).toContain('GG.deals API limit reached');
    expect(summaryText).toContain('resets at');
    expect(summaryText).toContain('loading…');

    profileCallback({ wishlist: [], tradables: [], profileComplete: true });
    await loadPromise;
  });

  it('renders persisted partial wishlist cards while an incomplete refresh resumes', async () => {
    const container = createDealsContainer();
    let profileCallback;
    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'deals_cards_cache') {
        cb({
          deals_cards_cache: {
            profileComplete: false,
            cacheIdentity: 'steam:76561198000000010',
            refreshToken: 'incomplete',
            partialCards: [{
              title: 'Persisted Partial Price',
              appId: '1010',
              type: 'app',
              pricesPerRegion: {
                eu: {
                  prices: {
                    currentRetail: 1010,
                    historicalRetail: 2020,
                    currency: 'EUR',
                  },
                  cachedAt: Date.now(),
                  url: 'https://gg.deals/game/persisted-partial-price/',
                },
              },
              currency: 'EUR',
            }, {
              title: 'Persisted Rate Limited',
              appId: '1011',
              type: 'app',
              pricesPerRegion: null,
              currency: 'EUR',
              priceStatus: { type: 'rate-limited', resetAt: Date.now() + 60_000 },
            }],
          },
        });
      } else cb({});
    });
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockClear();
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({
        steamId: '76561198000000010',
        regions: ['eu'],
        currency: 'EUR',
        apiKey: 'KEY',
        keyshopsEnabled: true,
      });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_PROFILE') profileCallback = callback;
      else callback({});
    });

    const loadPromise = initDeals(container);
    await vi.waitFor(() => expect(profileCallback).toBeTypeOf('function'));

    expect(container.textContent).toContain('Persisted Partial Price');
    expect(container.textContent).toContain('€10.10');
    expect(container.textContent).toContain('Persisted Rate Limited');
    expect(container.textContent).toContain('GG.deals API limit reached');
    expect(container.textContent).not.toContain('Loading wishlist');

    profileCallback({ wishlist: [], tradables: [], profileComplete: true });
    await loadPromise;
  });

  it('does not render previousComplete from an incomplete deals marker as authoritative cache', async () => {
    const container = createDealsContainer();
    const marker = {
      profileComplete: false,
      cacheIdentity: 'steam:76561198000000002',
      refreshToken: 'abandoned',
      previousComplete: {
        cacheIdentity: 'steam:76561198000000002',
        savedAt: 123,
        cards: [{
          title: 'Old Cached Game',
          appId: '10',
          type: 'app',
          pricesPerRegion: null,
          currency: 'EUR',
        }],
      },
    };
    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'deals_cards_cache') cb({ deals_cards_cache: marker });
      else cb({});
    });
    chrome.storage.local.set.mockImplementation((obj, cb) => cb?.());
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message.type === 'GET_SETTINGS') callback({ steamId: '76561198000000002', regions: ['eu'], currency: 'EUR', apiKey: '' });
      else if (message.type === 'BEGIN_DEALS_REFRESH') callback({ ok: true });
      else if (message.type === 'GET_CACHED_PROFILE') callback({ wishlist: [] });
      else if (message.type === 'GET_PROFILE') callback({
        wishlist: ['Fresh Game'],
        tradables: [],
        profileComplete: false,
        failedAppIds: [],
        wishlistTotal: 1,
      });
      else if (message.type === 'GET_CACHED_RESOLUTIONS') callback({ 'Fresh Game': { appId: '42', type: 'app', status: 'hit' } });
      else callback({});
    });

    await initDeals(container);

    expect(container.textContent).toContain('Fresh Game');
    expect(container.textContent).not.toContain('Old Cached Game');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GET_PROFILE' }),
      expect.any(Function),
    );
  });
});
