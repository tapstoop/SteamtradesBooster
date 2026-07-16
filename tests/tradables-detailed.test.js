import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const {
  createDetailedStateElement,
  createEmptyTradablesDetailedElement,
  createTradablesDetailedCardElement,
  initTradablesDetailed,
} = await import('../popup/tradables-detailed.js');

describe('createDetailedStateElement', () => {
  it('renders malicious errors as inert text with the error-log link', () => {
    const message = 'Failed <img src=x onerror=alert(1)>';
    const state = createDetailedStateElement('error', message, { includeErrorLogLink: true });

    expect(state.className).toBe('error-state');
    expect(state.childNodes[0].textContent).toBe(message);
    expect(state.querySelector('img')).toBeNull();
    expect(state.querySelector('[onerror]')).toBeNull();
    const link = state.querySelector('.error-log-inline');
    expect(link.textContent).toBe('See error logs');
    expect(link.getAttribute('href')).toBe('popup.html?tab=settings&focus=error-log');
  });

  it('renders empty-state text without markup', () => {
    const state = createDetailedStateElement('empty', '<script>alert(1)</script>');

    expect(state.className).toBe('empty-state');
    expect(state.textContent).toBe('<script>alert(1)</script>');
    expect(state.querySelector('script')).toBeNull();
  });

  it('renders the empty tradables detailed message with a Tradables tab link', () => {
    const state = createEmptyTradablesDetailedElement();

    expect(state.textContent).toBe('No tradable games found. Add your tradables in Tradables.');
    const link = state.querySelector('a');
    expect(link.textContent).toBe('Tradables');
    expect(link.getAttribute('href')).toBe('popup.html?tab=tradables');
    expect(link.style.color).toBe('inherit');
    expect(link.style.textDecoration).toBe('underline');
  });
});

describe('createTradablesDetailedCardElement', () => {
  it('renders typed Steam and validated GG.deals links', () => {
    const card = createTradablesDetailedCardElement({
      title: 'Example Bundle',
      appId: '30',
      type: 'bundle',
      ggDealsUrl: 'https://gg.deals/game/example-bundle/',
      currentRetail: 1200,
      historicalRetail: 800,
      currency: 'EUR',
      settings: { keyshopsEnabled: false },
    });

    const steamLink = card.querySelector('.game-card-title a');
    expect(steamLink.href).toBe('https://store.steampowered.com/bundle/30');
    expect(steamLink.target).toBe('_blank');
    expect(steamLink.rel).toBe('noopener noreferrer');
    expect(steamLink.style.textDecoration).toBe('underline');

    const ggDealsLink = card.querySelector('.game-card-meta a');
    expect(ggDealsLink.textContent).toBe('GG.deals ↗');
    expect(ggDealsLink.href).toBe('https://gg.deals/game/example-bundle/');
    expect(card.querySelector('.game-card-meta').textContent).toContain('GG.deals ↗:');
  });

  it('omits invalid external links without leaving a dangling GG.deals label', () => {
    const card = createTradablesDetailedCardElement({
      title: 'Plain Game <img src=x onerror=alert(1)>',
      appId: 'bad-id',
      ggDealsUrl: 'https://gg.deals.evil.test/game/example/',
      currentRetail: 1200,
      historicalRetail: 800,
      currency: 'EUR',
      settings: { keyshopsEnabled: false },
    });

    expect(card.querySelector('.game-card-title a')).toBeNull();
    expect(card.querySelector('.game-card-title').textContent).toBe('Plain Game <img src=x onerror=alert(1)>');
    expect(card.querySelector('.game-card-meta a')).toBeNull();
    expect(card.querySelector('.game-card-meta').textContent).not.toContain('GG.deals:');
    expect(card.querySelector('img')).toBeNull();
  });

  it('renders malicious titles as text and preserves normal card classes', () => {
    const title = 'Bad <img src=x onerror=alert(1)>';
    const card = createTradablesDetailedCardElement({
      title,
      currentRetail: 1200,
      historicalRetail: 800,
      currency: 'EUR',
      settings: { keyshopsEnabled: false },
    });

    expect(card.className).toBe('game-card');
    expect(card.querySelector('.game-card-title').textContent).toBe(title);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('[onerror]')).toBeNull();
    expect(card.querySelector('.game-card-meta strong').textContent).toContain('12.00');
    expect(card.querySelector('.game-card-meta .atl').textContent).toContain('8.00');
    expect(card.querySelector('.game-card-range')).not.toBeNull();
  });

  it('renders range, acquisition, and keyshop opportunity content', () => {
    const card = createTradablesDetailedCardElement({
      title: 'Example Game',
      currentRetail: 1500,
      historicalRetail: 1000,
      historicalKeyshops: 900,
      currentKeyshops: 500,
      currency: 'EUR',
      snapRange: { min: 400, max: 1600 },
      acqPrice: 1000,
      settings: {
        keyshopsEnabled: true,
        keyshops: ['eneba', 'g2a'],
        keyshopFees: {
          eneba: { min: 8, max: 12 },
          g2a: { min: 10, max: 15 },
        },
        rangeHighRatio: 3,
        rangeLowRatio: 1.5,
      },
    });

    expect(card.querySelector('.game-card-range .range-HIGH').textContent).toBe('HIGH');
    expect(card.querySelector('.game-card-range').textContent).toContain('(180d history)');
    expect(card.textContent).toContain('Historical ATL');
    expect(card.querySelector('.atl').textContent).toContain('9.00');
    expect(card.querySelector('.game-card-meta.high').textContent).toContain('(50%)');
    expect(card.textContent).toContain('Keyshop flip: Buy');
    expect(card.textContent).toContain('Gap');
    expect(card.querySelector('.game-card-meta .high')).not.toBeNull();
  });

  it('omits acquisition percentage when acquisition price is zero', () => {
    const card = createTradablesDetailedCardElement({
      title: 'Free Acquisition',
      currentRetail: 1000,
      historicalRetail: 800,
      currency: 'EUR',
      acqPrice: 0,
      settings: { keyshopsEnabled: false },
    });

    const acquisition = card.querySelector('.game-card-meta.high');
    expect(acquisition.textContent).toContain('Paid');
    expect(acquisition.textContent).not.toContain('Infinity');
    expect(acquisition.textContent).not.toContain('NaN');
    expect(acquisition.textContent).not.toMatch(/\(\d+%\)/);
  });
});

describe('initTradablesDetailed', () => {
  it('does not load the profile or prices when the tradables list is empty', async () => {
    const originalChrome = globalThis.chrome;
    const sendMessage = vi.fn((message, callback) => {
      if (message.type === 'GET_SETTINGS') {
        callback?.({ apiKey: 'KEY', steamId: '76561198000000000', regions: ['eu'] });
      } else if (message.type === 'GET_TRADABLES') {
        callback?.({ tradables: [], tradablesRevision: 'missing' });
      } else {
        callback?.({});
      }
    });
    globalThis.chrome = {
      runtime: { sendMessage },
    };

    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      await initTradablesDetailed(container);

      expect(container.textContent).toContain('No tradable games found. Add your tradables in Tradables.');
      expect(container.querySelector('a')?.getAttribute('href')).toBe('popup.html?tab=tradables');
      expect(sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'GET_PROFILE' }),
        expect.any(Function),
      );
      expect(sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'GET_PRICES' }),
        expect.any(Function),
      );
    } finally {
      globalThis.chrome = originalChrome;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });

  it('reuses detailed cards when the tradables revision did not change', async () => {
    const originalChrome = globalThis.chrome;
    const sendMessage = vi.fn((message, callback) => {
      if (message.type === 'GET_SETTINGS') {
        callback?.({ apiKey: 'KEY', steamId: '76561198000000000', regions: ['eu'], keyshopsEnabled: false });
      } else if (message.type === 'GET_TRADABLES') {
        callback?.({ tradables: [{ name: 'Gift', appId: '10', type: 'app' }], tradablesRevision: 'tradables-1' });
      } else if (message.type === 'RESOLVE_TITLES') {
        callback?.([{ status: 'hit', appId: '10', type: 'app' }]);
      } else if (message.type === 'GET_PRICES') {
        callback?.({
          10: {
            eu: {
              prices: { currentRetail: 500, historicalRetail: 400, currency: 'EUR' },
            },
          },
        });
      } else if (message.type === 'GET_ACQ_PRICE') {
        callback?.({ price: null });
      } else {
        callback?.({});
      }
    });
    globalThis.chrome = {
      runtime: { sendMessage, onMessage: { addListener: vi.fn() } },
    };

    try {
      const container = document.createElement('div');
      document.body.appendChild(container);
      await initTradablesDetailed(container);
      await initTradablesDetailed(container);

      expect(container.textContent).toContain('Gift');
      expect(sendMessage.mock.calls.filter(([message]) => message.type === 'GET_PRICES')).toHaveLength(1);
      expect(sendMessage.mock.calls.filter(([message]) => message.type === 'RESOLVE_TITLES')).toHaveLength(1);
    } finally {
      globalThis.chrome = originalChrome;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });
});
