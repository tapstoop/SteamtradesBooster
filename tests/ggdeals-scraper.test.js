import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = {};
const listeners = [];

const defaultTabsSendImpl = (tabId, message, optionsOrCallback) => {
  const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : undefined;
  cb?.();
};

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
    onRemoved: { addListener: vi.fn() },
    sendMessage: vi.fn(defaultTabsSendImpl),
  },
};

const { scrapeBatch, sendScrapePing } = await import('../background/ggdeals-scraper.js');

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  Object.keys(store).forEach(key => delete store[key]);
  listeners.splice(0, listeners.length);
  chrome.runtime.lastError = null;
  vi.clearAllMocks();
  chrome.tabs.sendMessage = vi.fn(defaultTabsSendImpl);
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

describe('sendScrapePing', () => {
  it('retries when sendMessage fails with lastError, then resolves true on success', async () => {
    let callCount = 0;
    chrome.tabs.sendMessage = vi.fn((tabId, message, callback) => {
      callCount++;
      if (callCount < 4) {
        chrome.runtime.lastError = { message: 'Receiving end does not exist' };
      } else {
        chrome.runtime.lastError = null;
      }
      callback?.();
    });

    const result = await sendScrapePing(100);
    expect(result).toBe(true);
    expect(callCount).toBe(4);
  });

  it('returns false after exhausting all retries (default 30×200ms cap)', async () => {
    vi.useFakeTimers();
    chrome.tabs.sendMessage = vi.fn((tabId, message, callback) => {
      chrome.runtime.lastError = { message: 'Receiving end does not exist' };
      callback?.();
    });

    const promise = sendScrapePing(100);
    await vi.advanceTimersByTimeAsync(30 * 200);
    const result = await promise;
    expect(result).toBe(false);
    vi.useRealTimers();
  });
});
