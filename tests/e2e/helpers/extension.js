// tests/e2e/helpers/extension.js
import { test as base, expect, chromium } from '@playwright/test';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { readFileSync, mkdirSync, existsSync } from 'fs';

const ROOT = resolve(import.meta.dirname, '../../..');
// Strip semver pre-release suffix for Chrome-compatible directory name
const RAW_VERSION = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
const MANIFEST_VERSION = RAW_VERSION.replace(/-.+$/, '');
const BUILD_DIR_NAME = `steamtrades_booster_chrome_v${MANIFEST_VERSION}`;
const BUILD_DIR = join(ROOT, BUILD_DIR_NAME);

const FIXTURES = resolve(import.meta.dirname, '../fixtures');

export const test = base.extend({
  extensionContext: async ({}, use) => {
    // Create unique temp userDataDir per test for isolation
    const userDataDir = join(tmpdir(), `ext-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(userDataDir, { recursive: true });

    console.log(`[EXT] Launching browser with extension from: ${BUILD_DIR}`);
    console.log(`[EXT] Build dir exists: ${existsSync(BUILD_DIR)}`);

    // Launch persistent context with extension loaded
    const context = await chromium.launchPersistentContext(userDataDir, {
      args: [
        '--no-sandbox',
        `--disable-extensions-except=${BUILD_DIR}`,
        `--load-extension=${BUILD_DIR}`,
        '--enable-logging',
        '--v=1',
      ],
      headless: false, // CI: use xvfb-run (headless Chromium doesn't load extensions)
    });

    console.log('[EXT] Browser launched, waiting for service worker...');

    // Give extension time to register service worker
    await new Promise(r => setTimeout(r, 2000));

    // Find extension ID via service worker URL
    // MV3 service worker URL pattern: chrome-extension://<id>/dist/service-worker.js
    let extensionId = '';
    const workers = context.serviceWorkers();
    if (workers.length > 0) {
      const swUrl = workers[0].url();
      const match = swUrl.match(/^chrome-extension:\/\/([a-z]+)/);
      if (match) {
        extensionId = match[1];
        console.log(`[EXT] Found extension ID from service worker: ${extensionId}`);
      }
    }

    if (!extensionId) {
      // Fallback: wait for a new service worker to appear
      try {
        const sw = await context.waitForEvent('serviceworker', { timeout: 5000 });
        const swUrl = sw.url();
        const match = swUrl.match(/^chrome-extension:\/\/([a-z]+)/);
        if (match) {
          extensionId = match[1];
          console.log(`[EXT] Found extension ID from service worker event: ${extensionId}`);
        }
      } catch {
        console.warn('[EXT] Could not find service worker, extension may not be loaded.');
      }
    }

    if (!extensionId) {
      console.warn('[EXT] WARNING: Could not find extension ID! Extension may not be loaded.');
    }

    // Verify SW is ready by sending a ping and waiting for response
    const sw = context.serviceWorkers()[0];
    if (sw) {
      let swReady = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const pong = await sw.evaluate(async () => {
            if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
              return { ready: true };
            }
            return { ready: false };
          });
          if (pong?.ready) {
            swReady = true;
            console.log(`[EXT] SW ready after ${attempt + 1} attempt(s)`);
            break;
          }
        } catch {
          // SW not ready yet
        }
        await new Promise(r => setTimeout(r, 500));
      }
      if (!swReady) {
        console.warn('[EXT] SW did not become ready within timeout');
      }
    }

    // Set up route interception for steamtrades.com and gg.deals
    await context.route('**/www.steamtrades.com/trade/**', async route => {
      console.log('[EXT] Intercepting steamtrades trade request');
      await route.fulfill({ path: join(FIXTURES, 'trade-page.html') });
    });

    await context.route('**/gg.deals/game/**', async route => {
      console.log('[EXT] Intercepting gg.deals game request');
      await route.fulfill({ path: join(FIXTURES, 'ggdeals-game.html') });
    });

    await context.route('**/api.gg.deals/v1/prices/*', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await context.route('**/store.steampowered.com/api/*', async route => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    });

    console.log('[EXT] Route interception configured');

    await use({ context, extensionId });

    await context.close();
  },

  navigate: async ({ extensionContext }, use) => {
    const navigate = async (url) => {
      console.log(`[NAV] Navigating to: ${url}`);
      const page = await extensionContext.context.newPage();

      // Listen for console messages
      page.on('console', msg => console.log(`[PAGE] ${msg.type()}: ${msg.text()}`));

      await page.goto(url);
      console.log(`[NAV] Navigation complete, current URL: ${page.url()}`);
      return page;
    };
    await use(navigate);
  },

  getSettings: async ({ extensionContext }, use) => {
    const getSettings = async () => {
      const { context, extensionId } = extensionContext;

      if (!extensionId) {
        console.warn('[SET] No extension ID available, cannot get settings');
        return null;
      }

      try {
        // Evaluate in the service worker context where chrome.storage.local is available
        const sw = context.serviceWorkers()[0];
        if (!sw) {
          console.warn('[SET] No service worker found');
          return null;
        }
        const result = await sw.evaluate(async () => {
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            const data = await chrome.storage.local.get('settings');
            const raw = data.settings;
            // Unwrap cache format { value, cachedAt, expiresAt } used by cacheGet/cacheSet
            if (raw && typeof raw === 'object' && 'value' in raw && 'cachedAt' in raw) {
              return raw.value ?? null;
            }
            return raw || null;
          }
          return null;
        });
        console.log(`[SET] Settings retrieved:`, result);
        return result;
      } catch (e) {
        console.warn('[SET] Could not get settings:', e.message);
        return null;
      }
    };
    await use(getSettings);
  },

  setSettings: async ({ extensionContext }, use) => {
    const setSettings = async (obj) => {
      const { context, extensionId } = extensionContext;

      if (!extensionId) {
        console.warn('[SET] No extension ID available, cannot set settings');
        return;
      }

      try {
        const sw = context.serviceWorkers()[0];
        if (!sw) {
          console.warn('[SET] No service worker found');
          return;
        }
        // Write with the cache wrapper { value, cachedAt, expiresAt } so the SW's
        // cacheGet(SETTINGS_KEY) can find the value at entry.value
        await sw.evaluate(async (settingsObj) => {
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            const entry = { value: settingsObj, cachedAt: Date.now(), expiresAt: 0 };
            await chrome.storage.local.set({ settings: entry });
            // Broadcast SETTINGS_UPDATED to all tabs (mirrors SAVE_SETTINGS in the SW);
            // a no-op when no content-script tabs are listening (e.g. pre-navigation calls).
            try {
              const tabs = await new Promise(resolve => chrome.tabs.query({}, resolve));
              for (const tab of tabs) {
                chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: settingsObj }).catch(() => {});
              }
            } catch {}
          }
        }, obj);
        console.log('[SET] Settings saved');
      } catch (e) {
        console.warn('[SET] Could not set settings:', e.message);
      }
    };
    await use(setSettings);
  },

  seedFixtures: async ({ extensionContext }, use) => {
    // Pre-seed resolution and price caches so the SW finds data instantly
    // without making real network calls to Steam / gg.deals APIs.
    const seed = async (region = 'eu') => {
      const { context } = extensionContext;
      const sw = context.serviceWorkers()[0];
      if (!sw) {
        console.warn('[SEED] No service worker found, skipping fixture seed');
        return;
      }

      // Game titles from the trade-page fixture with real Steam app IDs
      const GAMES = [
        { title: 'ori and the blind forest', appId: '261570' },
        { title: 'hollow knight', appId: '367520' },
        { title: 'celeste', appId: '504230' },
        { title: 'dead cells', appId: '588650' },
      ];

      await sw.evaluate(async ({ games, region }) => {
        const makePrice = () => ({
          prices: {
            currentRetail: 599,
            currentKeyshops: 399,
            historicalRetail: 299,
            historicalKeyshops: 199,
            currency: 'EUR',
          },
        });

        const entries = {};
        for (const g of games) {
          // Resolution cache: resolveTitle() reads resolve:<normalizedTitle>
          entries[`resolve:${g.title}`] = {
            value: { appId: g.appId, type: 'app' },
            cachedAt: Date.now(),
            expiresAt: 0,
          };
          // Price cache: getCachedPrices() reads price:<appId>:<region>
          entries[`price:${g.appId}:${region}`] = {
            value: makePrice(),
            cachedAt: Date.now(),
            expiresAt: 0,
          };
        }
        await chrome.storage.local.set(entries);
      }, { games: GAMES, region });

      console.log('[SEED] Resolution and price caches seeded');
    };
    await use(seed);
  },
});

export { expect };
