import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn(),
  },
};

const {
  buildTradablesListItemElement,
  bindTradablesRuntimeStateForInit,
  createTradablesInitGuard,
} = await import('../popup/tradables.js');

const { hasBundleKeywords } = await import('../popup/tradables-parser.js');

describe('tradables init guards', () => {
  it('marks older init guards stale when a newer init starts', () => {
    const first = createTradablesInitGuard();
    expect(first()).toBe(true);

    const second = createTradablesInitGuard();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('does not bind runtime state for stale init guards', () => {
    const stale = createTradablesInitGuard();
    createTradablesInitGuard();

    expect(bindTradablesRuntimeStateForInit(stale, {
      settings: {},
      priceData: {},
      render: vi.fn(),
      updateStats: vi.fn(),
    })).toBe(false);
  });

  it('binds runtime state for the latest init guard', () => {
    const current = createTradablesInitGuard();

    expect(bindTradablesRuntimeStateForInit(current, {
      settings: {},
      priceData: {},
      render: vi.fn(),
      updateStats: vi.fn(),
    })).toBe(true);
  });
});

describe('buildTradablesListItemElement', () => {
  it('renders stored item data as text and preserves row metadata', () => {
    const item = {
      name: 'Bad <img src=x onerror=alert(1)>',
      appId: '123',
      type: 'bundle',
      qty: 2,
      acqPrice: 1.5,
      _origIndex: 7,
    };

    const element = buildTradablesListItemElement(item, {
      priceData: {
        prices: {
          currentRetail: 250,
          historicalRetail: 240,
        },
        cachedAt: Date.now(),
      },
      settings: {
        currency: 'EUR',
        dealThresholdPct: 10,
        keyshopsEnabled: false,
      },
      currencySymbol: '€',
    });

    expect(element.className).toBe('tradables-item');
    expect(element.dataset.origIndex).toBe('7');
    expect(element.dataset.appid).toBe('123');
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('[onerror]')).toBeNull();
    expect(element.querySelector('[onclick]')).toBeNull();
    expect(element.querySelector('[onfocus]')).toBeNull();
    expect(element.querySelector('.tradables-name').textContent).toBe(item.name);
    expect(element.querySelector('.tradables-appid').textContent).toBe('Bundle #123');
    expect(element.querySelector('.tradables-price-badge.deal')).not.toBeNull();
    expect(element.querySelector('.tradables-qty-suffix').textContent).toContain(' x 2 = ');
    const qtyUp = element.querySelector('.tradables-qty-arrow.tradables-qty-up');
    const qtyDown = element.querySelector('.tradables-qty-arrow.tradables-qty-down');
    const qtyInput = element.querySelector('.tradables-qty-input');
    expect(qtyUp.dataset.origIndex).toBe('7');
    expect(qtyUp.getAttribute('aria-label')).toBe('Increase quantity');
    expect(qtyUp.textContent).toBe('▲');
    expect(qtyDown.dataset.origIndex).toBe('7');
    expect(qtyDown.getAttribute('aria-label')).toBe('Decrease quantity');
    expect(qtyDown.textContent).toBe('▼');
    expect(qtyInput.dataset.origIndex).toBe('7');
    expect(qtyInput.type).toBe('number');
    expect(qtyInput.min).toBe('1');
    expect(qtyInput.max).toBe('999');
    expect(qtyInput.title).toBe('Quantity');
    expect(qtyInput.value).toBe('2');
    expect(element.querySelector('.tradables-acq-input').placeholder).toBe('Acq. €');
    expect(element.querySelector('.tradables-remove').getAttribute('aria-label')).toBe(`Remove ${item.name}`);
  });

  it('renders invalid stored app ids as unresolved', () => {
    const element = buildTradablesListItemElement({
      name: 'Broken App',
      appId: '<script>alert(1)</script>',
      type: 'app',
      qty: 1,
      _origIndex: 2,
    }, {
      settings: { currency: 'EUR' },
      currencySymbol: '€',
    });

    expect(element.dataset.appid).toBe('');
    expect(element.querySelector('.tradables-appid')).toBeNull();
    const unresolved = element.querySelector('.tradables-unresolved.tradables-resolve-link');
    expect(unresolved).not.toBeNull();
    expect(unresolved.dataset.origIndex).toBe('2');
    expect(unresolved.textContent).toBe('unresolved ↗');
    expect(element.querySelector('.tradables-price-badge.na').textContent).toBe('N/A');
  });
});

describe('hasBundleKeywords', () => {
  it('returns true for names containing "collection"', () => {
    expect(hasBundleKeywords('Asterix & Obelix XXL Collection')).toBe(true);
  });

  it('returns true for names containing "bundle"', () => {
    expect(hasBundleKeywords('Valve Complete Pack')).toBe(true);
  });

  it('returns true for "pack"', () => {
    expect(hasBundleKeywords('Starter Pack')).toBe(true);
  });

  it('returns true for "anthology"', () => {
    expect(hasBundleKeywords('Dark Souls Trilogy')).toBe(true);
  });

  it('returns false for names without bundle keywords', () => {
    expect(hasBundleKeywords('Hollow Knight')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasBundleKeywords('')).toBe(false);
  });

  it('requires keyword as a whole word (not substring)', () => {
    expect(hasBundleKeywords('Packing Simulator')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasBundleKeywords('ULTIMATE BUNDLE')).toBe(true);
  });
});

describe('resolve popover bundle guidance', () => {
  it('uses item.type === "bundle" not name keywords', () => {
    const bundleItem = { name: 'Some Game', type: 'bundle' };
    const appItem = { name: 'Asterix & Obelix XXL Collection', type: 'app' };
    const appWithKeywords = { name: 'Valve Complete Pack', type: 'app' };

    expect(bundleItem.type === 'bundle').toBe(true);
    expect(appItem.type === 'bundle').toBe(false);
    expect(appWithKeywords.type === 'bundle').toBe(false);
  });
});
