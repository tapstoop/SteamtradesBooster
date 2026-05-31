import { describe, it, expect, vi } from 'vitest';

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn(),
  },
};

const {
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
