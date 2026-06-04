import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = {};
const listeners = [];

global.chrome = {
  runtime: {
    lastError: null,
    sendMessage: vi.fn((message, callback) => callback?.({ ok: true })),
    onMessage: {
      addListener: vi.fn(listener => listeners.push(listener)),
      removeListener: vi.fn(listener => {
        const index = listeners.indexOf(listener);
        if (index !== -1) listeners.splice(index, 1);
      }),
    },
  },
  storage: {
    local: {
      get: vi.fn((key, callback) => callback({ [key]: store[key] ?? null })),
      set: vi.fn((obj, callback) => { Object.assign(store, obj); callback?.(); }),
    },
  },
  tabs: {
    create: vi.fn((options, callback) => callback({ id: 100, ...options })),
    remove: vi.fn((tabId, callback) => callback?.()),
  },
};

const { scrapeBatch } = await import('../background/ggdeals-scraper.js');

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  Object.keys(store).forEach(key => delete store[key]);
  listeners.splice(0, listeners.length);
  chrome.runtime.lastError = null;
  vi.clearAllMocks();
});

describe('gg.deals scraper tab messages', () => {
  it('ignores scrape results from tabs other than the tab it opened', async () => {
    const batchPromise = scrapeBatch([
      { gameId: 'game-one', appId: '10', ggdealsUrl: 'https://gg.deals/game/game-one/' },
    ]);

    await flushPromises();
    expect(listeners).toHaveLength(1);

    listeners[0]({
      type: 'GGDEALS_SCRAPED',
      success: true,
      data: { source: 'wrong-tab' },
    }, { tab: { id: 999 } });

    await flushPromises();
    expect(chrome.tabs.remove).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(1);

    listeners[0]({
      type: 'GGDEALS_SCRAPED',
      success: true,
      data: { source: 'opened-tab' },
    }, { tab: { id: 100 } });

    const results = await batchPromise;

    expect(results).toEqual([
      {
        gameId: 'game-one',
        appId: '10',
        success: true,
        data: { source: 'opened-tab' },
        error: undefined,
      },
    ]);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(100, expect.any(Function));
    expect(listeners).toHaveLength(0);
  });
});
