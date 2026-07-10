/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getOutputNames } from '../build/manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let listeners = [];
let sendMessageHandler = null;
let lastError = null;
let scrapedMessages = [];
let scrollIntoViewSpy = null;

// Set up chrome mock
function setupChromeMock() {
  listeners = [];
  sendMessageHandler = null;
  scrapedMessages = [];
  lastError = null;

  global.chrome = {
    runtime: {
      get lastError() { return lastError; },
      set lastError(val) { lastError = val; },
      sendMessage: vi.fn((message, callback) => {
        if (message.type === 'GGDEALS_SCRAPED') {
          scrapedMessages.push(message);
          callback?.({ received: true });
          return;
        }
        if (sendMessageHandler) {
          const response = sendMessageHandler(message);
          if (response && typeof response.then === 'function') {
            response.then(res => callback?.(res)).catch(() => {
              lastError = { message: 'Test error' };
              callback?.();
              lastError = null;
            });
          } else {
            callback?.(response);
          }
        } else {
          callback?.({});
        }
      }),
      onMessage: {
        addListener: vi.fn(listener => listeners.push(listener)),
        removeListener: vi.fn(listener => {
          const index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        }),
      },
    },
  };
}

// jsdom does not implement scrollIntoView
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function() {};
}

function setupDOM(hasPriceHistory = true, rowCount = 3) {
  document.body.innerHTML = '';

  if (hasPriceHistory) {
    const priceHistory = document.createElement('div');
    priceHistory.id = 'price-history';
    document.body.appendChild(priceHistory);
  }

  for (let i = 0; i < rowCount; i++) {
    const row = document.createElement('div');
    row.className = 'game-lowest-price-row';
    const priceType = document.createElement('span');
    priceType.className = 'price-type';
    priceType.textContent = i === 0 ? 'Historical Low:' : `2nd Best ${i}:`;
    const price = document.createElement('span');
    price.className = 'price';
    price.textContent = `$${(i + 1) * 10}.99`;
    row.appendChild(priceType);
    row.appendChild(price);
    document.body.appendChild(row);
  }

  scrollIntoViewSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
}

function dispatchScrapeTabMessage() {
  for (const listener of listeners) {
    listener({ type: 'GGDEALS_SCRAPE_TAB' });
  }
}

const ROOT = resolve(__dirname, '..');

function loadAndExecuteScraper(pathname) {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const { outDir } = getOutputNames('chrome', version);
  const bundlePath = join(ROOT, outDir, 'dist', 'ggdeals-scraper.js');

  let source;
  try {
    source = readFileSync(bundlePath, 'utf-8');
  } catch {
    // Fall back to source if build hasn't run yet
    const sourcePath = join(__dirname, '..', 'content', 'ggdeals-scraper.js');
    source = readFileSync(sourcePath, 'utf-8');
  }

  // Set location using window.history.pushState (jsdom compatible)
  window.history.pushState(null, '', pathname);

  // Execute the IIFE in the current context
  if (source.includes('import ')) {
    console.warn('Testing unbundled source - prefer running build first');
  } else {
    try {
      const execFn = new Function('window', 'document', 'chrome', source);
      execFn(window, document, chrome);
    } catch (e) {
      eval(source);
    }
  }
}

describe('gg.deals scraper content script toggle', () => {
  beforeEach(() => {
    setupChromeMock();
    document.body.innerHTML = '';
    if (scrollIntoViewSpy) {
      scrollIntoViewSpy.mockRestore();
    }
    scrollIntoViewSpy = null;
  });

  describe('scrape tab detection (push ping)', () => {
    it('scrolls and sends GGDEALS_SCRAPED when GGDEALS_SCRAPE_TAB ping is received', async () => {
      vi.useFakeTimers();
      setupDOM();
      loadAndExecuteScraper('/game/test-game-123/');

      // Deliver the push ping immediately
      dispatchScrapeTabMessage();

      // Advance timers past the 1.5-second ping wait + scroll delays
      await vi.advanceTimersByTimeAsync(7000);

      expect(scrollIntoViewSpy).toHaveBeenCalled();
      expect(scrapedMessages).toHaveLength(1);
      expect(scrapedMessages[0].success).toBe(true);
      expect(scrapedMessages[0].type).toBe('GGDEALS_SCRAPED');

      vi.useRealTimers();
    });
  });

  describe('user navigation with toggle', () => {
    it('does NOT scroll or send when ggdealsAutoScroll is false', async () => {
      vi.useFakeTimers();
      setupDOM();

      sendMessageHandler = (message) => {
        if (message.type === 'GET_SETTINGS') {
          return Promise.resolve({ ggdealsAutoScroll: false });
        }
        return {};
      };

      loadAndExecuteScraper('/game/test-game-456/');

      // Do NOT dispatch GGDEALS_SCRAPE_TAB — simulate user navigation
      await vi.advanceTimersByTimeAsync(2000);

      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      expect(scrapedMessages).toHaveLength(0);

      vi.useRealTimers();
    });

    it('scrolls and sends when ggdealsAutoScroll is true', async () => {
      vi.useFakeTimers();
      setupDOM();

      sendMessageHandler = (message) => {
        if (message.type === 'GET_SETTINGS') {
          return Promise.resolve({ ggdealsAutoScroll: true });
        }
        return {};
      };

      loadAndExecuteScraper('/game/test-game-789/');

      // Do NOT dispatch GGDEALS_SCRAPE_TAB — simulate user navigation
      await vi.advanceTimersByTimeAsync(7000);

      expect(scrollIntoViewSpy).toHaveBeenCalled();
      expect(scrapedMessages).toHaveLength(1);
      expect(scrapedMessages[0].success).toBe(true);

      vi.useRealTimers();
    });

    it('falls back to scroll when GET_SETTINGS rejects', async () => {
      vi.useFakeTimers();
      setupDOM();

      sendMessageHandler = (message) => {
        if (message.type === 'GET_SETTINGS') {
          return Promise.reject(new Error('Settings unavailable'));
        }
        return {};
      };

      loadAndExecuteScraper('/game/test-game-reject/');

      // Do NOT dispatch GGDEALS_SCRAPE_TAB — simulate user navigation
      await vi.advanceTimersByTimeAsync(7000);

      // Falls back to scroll (default behavior preserves scraping)
      expect(scrollIntoViewSpy).toHaveBeenCalled();
      expect(scrapedMessages).toHaveLength(1);
      expect(scrapedMessages[0].success).toBe(true);

      vi.useRealTimers();
    });
  });
});
