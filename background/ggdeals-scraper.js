// background/ggdeals-scraper.js
// Sequential single-tab scraping to avoid Chrome background tab throttling
// Each tab stays active until content script finishes, then closes and moves to next

import { cacheSet, cacheGet } from './cache.js';
import { runtimeSendMessage, tabsCreate, tabsRemove } from '../utils/chrome-api.js';

const SCRAPED_TTL = 86400 * 30;
const RETRY_ATTEMPTS = 1;
const SCRAPE_TIMEOUT_MS = 30000;

const pendingScrapes = new Map();

function broadcastProgress(message) {
  runtimeSendMessage(message).catch(() => {});
}

export async function sendScrapePing(tabId, retries = 30, delayMs = 200) {
  for (let i = 0; i < retries; i++) {
    const delivered = await new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { type: 'GGDEALS_SCRAPE_TAB' }, () => {
        resolve(!chrome.runtime.lastError);
      });
    });
    if (delivered) return true;
    await new Promise(r => setTimeout(r, delayMs));
  }
  return false;
}

export async function scrapeGame(gameId, ggdealsUrl) {
  if (!ggdealsUrl) {
    return { success: false, error: 'No GG.deals URL provided' };
  }

  const cached = await cacheGet(`scraped:${gameId}`);
  if (cached?.value) {
    return { success: true, data: cached.value, cached: true };
  }

  return new Promise((resolve) => {
    pendingScrapes.set(gameId, { resolve, url: ggdealsUrl, retryCount: 0 });
  });
}

async function scrapeSingleTab(gameId, url) {
  try {
    const tab = await tabsCreate({ url, active: true });
    sendScrapePing(tab.id).catch(() => {});

    return await new Promise((resolve) => {
      const cleanup = () => {
        tabsRemove(tab.id).catch(() => {});
      };

      const timeoutId = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        cleanup();
        resolve({ success: false, error: 'Scrape timeout (30s)', tabId: tab.id });
      }, SCRAPE_TIMEOUT_MS);

      const listener = (message, sender) => {
        if (message.type === 'GGDEALS_SCRAPED' && sender?.tab?.id === tab.id) {
          clearTimeout(timeoutId);
          chrome.runtime.onMessage.removeListener(listener);
          cleanup();
          resolve({
            success: message.success,
            data: message.data,
            error: message.error,
            tabId: tab.id
          });
        }
      };

      chrome.runtime.onMessage.addListener(listener);
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function handleScrapedResult(message) {
  const { gameId, appId, data, success, error } = message;
  const lookupId = gameId || appId;
  const pending = pendingScrapes.get(lookupId);

  if (!pending) {
    return { received: true, ignored: true };
  }

  if (success && data) {
    await cacheSet(`scraped:${lookupId}`, data, SCRAPED_TTL);
  }

  return { received: true };
}

export async function scrapeBatch(games) {
  if (!games || games.length === 0) return [];

  const results = [];
  const total = games.length;

  for (let i = 0; i < games.length; i++) {
    const game = games[i];
    const gameId = game.gameId || game.appId;

    // Check cache first
    const cached = await cacheGet(`scraped:${gameId}`);
    if (cached?.value) {
      broadcastProgress({
        type: 'SCRAPING_PROGRESS',
        gameId,
        status: 'success',
        message: `✓ ${game.gameId || game.appId} (cached)`,
        progress: { current: i + 1, total }
      });
      results.push({ gameId: game.gameId, appId: game.appId, success: true, data: cached.value, cached: true });
      continue;
    }

    // Scrape with retry logic
    let result = null;
    let attempt = 0;

    while (attempt <= RETRY_ATTEMPTS) {
      if (attempt === 1) {
        broadcastProgress({
          type: 'SCRAPING_PROGRESS',
          gameId,
          status: 'retry',
          message: `↻ Retrying ${game.gameId || game.appId} (attempt 2/2)...`,
          progress: { current: i + 1, total }
        });
      } else {
        broadcastProgress({
          type: 'SCRAPING_PROGRESS',
          gameId,
          status: 'opening',
          message: `Scraping ${i + 1}/${total}: ${game.gameId || game.appId}...`,
          progress: { current: i + 1, total }
        });
      }

      result = await scrapeSingleTab(gameId, game.ggdealsUrl);

      if (result.success) {
        break;
      }

      attempt++;
    }

    if (result.success && result.data) {
      await cacheSet(`scraped:${gameId}`, result.data, SCRAPED_TTL);
      broadcastProgress({
        type: 'SCRAPING_PROGRESS',
        gameId,
        status: 'success',
        message: `✓ ${game.gameId || game.appId}`,
        progress: { current: i + 1, total }
      });
    } else {
      broadcastProgress({
        type: 'SCRAPING_ERROR',
        gameId,
        error: result?.error || 'Unknown error',
        willRetry: false
      });
    }

    results.push({
      gameId: game.gameId,
      appId: game.appId,
      success: result?.success ?? false,
      data: result?.data,
      error: result?.error
    });
  }

  return results;
}

export async function getScrapedData(gameId) {
  const cached = await cacheGet(`scraped:${gameId}`);
  return cached?.value ?? null;
}
