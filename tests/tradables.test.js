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
