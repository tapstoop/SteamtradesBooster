// tests/e2e/regression.spec.js
import { test, expect } from './helpers/extension.js';
import { join, resolve } from 'path';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

test.describe('B1 - Badge injection', () => {
  test('injects badges on trade page', async ({ navigate, seedFixtures }) => {
    await seedFixtures();

    const page = await navigate('https://www.steamtrades.com/trade/12345/test');

    // The content script can replace skeletons with badges before Playwright observes them.
    await page.waitForSelector('.stpt-skeleton, .stpt-badge', { state: 'attached', timeout: 10000 });

    // Skeletons get replaced by badges once resolutions and cached prices are read
    await page.waitForSelector('.stpt-badge', { state: 'attached', timeout: 10000 });

    const badgeCount = await page.locator('.stpt-badge').count();
    expect(badgeCount).toBeGreaterThan(0);

    // Assert floating fetch button exists in DOM (hidden until checkboxes selected)
    const fetchBtn = page.locator('#stpt-floating-fetch-btn');
    await expect(fetchBtn).toBeAttached();
  });

  test('reconciles a late Steam Tracker badge ahead of an existing price badge', async ({ extensionContext, navigate, seedFixtures }) => {
    const { context, extensionId } = extensionContext;
    await context.route('https://steam-tracker.com/api**', async route => {
      await new Promise(resolve => setTimeout(resolve, 500));
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          removed_apps: [{ appid: 970620, name: 'Castle Rencounter', type: 'game', category_id: 3 }],
        }),
      });
    });

    const sw = context.serviceWorkers()[0];
    const extensionPage = await context.newPage();
    await extensionPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await extensionPage.evaluate(() => chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' }));
    await extensionPage.close();
    await seedFixtures();
    await sw.evaluate(async () => {
      await chrome.storage.local.set({
        'price:970620:eu': {
          value: {
            prices: {
              currentRetail: 299,
              currentKeyshops: 299,
              historicalRetail: 299,
              historicalKeyshops: 299,
              currency: 'EUR',
            },
          },
          cachedAt: Date.now(),
          expiresAt: 0,
        },
      });
    });

    const page = await navigate('https://www.steamtrades.com/trade/12345/test');
    const castleRow = page.locator('.stpt-game-item', { hasText: 'Castle Rencounter' }).first();
    await expect(castleRow.locator('.stpt-badge[data-type="DEAL"]')).toBeAttached({ timeout: 10000 });
    await expect(castleRow.locator('.stpt-badge[data-type="removed_disabled"]')).toBeAttached({ timeout: 10000 });

    const badgeTypes = await castleRow.locator('.stpt-badge').evaluateAll(nodes => (
      nodes.map(node => node.dataset.type)
    ));
    expect(badgeTypes.slice(0, 2)).toEqual(['removed_disabled', 'DEAL']);
  });
});

test.describe('B2 - Selective fetch', () => {
  test('checkbox toggles fetch button text', async ({ navigate, seedFixtures }) => {
    await seedFixtures();

    const page = await navigate('https://www.steamtrades.com/trade/12345/test');

    await page.waitForSelector('.stpt-game-checkbox', { state: 'attached', timeout: 10000 });

    // Check one checkbox
    const firstCheckbox = page.locator('.stpt-game-checkbox').first();
    await firstCheckbox.click();

    await page.waitForTimeout(500);

    // Assert floating button text becomes "Fetch prices for 1 game"
    const fetchBtn = page.locator('#stpt-floating-fetch-btn');
    await expect(fetchBtn).toContainText('Fetch prices for 1 game');

    // Uncheck
    await firstCheckbox.click();
    await page.waitForTimeout(500);

    // Button should be hidden or text resets
    const isVisible = await fetchBtn.isVisible().catch(() => false);
    if (isVisible) {
      const btnText = await fetchBtn.textContent();
      expect(btnText).not.toContain('Fetch prices for 1 game');
    }
  });

  test('removed-game toggle does not turn selective mode into global automatic fetch', async ({
    extensionContext,
    navigate,
    seedFixtures,
    setSettings,
  }) => {
    const { context, extensionId } = extensionContext;
    await seedFixtures();
    await setSettings({
      apiKey: 'TEST',
      regions: ['eu'],
      selectiveFetch: true,
      fetchRemovedGamePrices: false,
      showSidebar: true,
      ggdealsAutoScroll: true,
      currency: 'EUR',
      theme: 'dark',
    });
    const sw = context.serviceWorkers()[0];
    await sw.evaluate(async () => {
      const stored = await chrome.storage.local.get(null);
      const priceKeys = Object.keys(stored).filter(key => key.startsWith('price:'));
      if (priceKeys.length) await chrome.storage.local.remove(priceKeys);
    });

    const ggRequests = [];
    context.on('request', request => {
      if (request.url().startsWith('https://api.gg.deals/v1/')) ggRequests.push(request.url());
    });
    const tradePage = await navigate('https://www.steamtrades.com/trade/12345/test');
    await tradePage.waitForSelector('.stpt-game-checkbox', { timeout: 10000 });
    await tradePage.waitForTimeout(500);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    await popup.locator('[data-tab="settings"]').click();
    const removedToggle = popup.locator('#s-fetch-removed');
    await expect(removedToggle).not.toBeChecked();
    ggRequests.length = 0;
    await removedToggle.click();
    await expect(removedToggle).toBeChecked();
    await tradePage.waitForTimeout(1200);
    expect(ggRequests).toHaveLength(0);

    await removedToggle.click();
    await expect(removedToggle).not.toBeChecked();
    ggRequests.length = 0;

    const removedRow = tradePage.locator('.stpt-game-item', { hasText: 'Castle Rencounter' }).first();
    await removedRow.locator('xpath=preceding-sibling::input[contains(@class,"stpt-game-checkbox")][1]').click();
    await tradePage.locator('#stpt-floating-fetch-btn').click();
    await expect.poll(() => ggRequests.some(url => url.includes('/prices/by-steam-app-id/') && url.includes('970620')), { timeout: 10000 }).toBe(true);
    await popup.close();
  });
});

test.describe('B3 - Settings persistence', () => {
  test('showSidebar persists across popup sessions', async ({ extensionContext, getSettings, setSettings }) => {
    const { context, extensionId } = extensionContext;

    // Seed initial settings with showSidebar: true so the popup can toggle it
    await setSettings({
      apiKey: 'TEST',
      regions: ['eu'],
      selectiveFetch: true,
      showSidebar: true,
      ggdealsAutoScroll: true,
      currency: 'EUR',
      theme: 'dark',
    });

    // Navigate to popup
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const page = await context.newPage();
    await page.goto(popupUrl);
    await page.waitForLoadState('networkidle');

    // Go to settings tab
    const settingsTab = page.locator('[data-tab="settings"]');
    await expect(settingsTab).toBeAttached();
    await settingsTab.click();
    await page.waitForTimeout(500);

    // Find the showSidebar toggle (#s-sidebar) and turn it off
    const sidebarToggle = page.locator('#s-sidebar').first();
    await expect(sidebarToggle).toBeAttached();
    const isChecked = await sidebarToggle.isChecked();
    if (isChecked) {
      await sidebarToggle.click();
      await page.waitForTimeout(500);
    }

    // Close popup
    await page.close();

    // Re-read settings — the popup's SAVE_SETTINGS call writes via cacheSet,
    // so getSettings unwraps the cache format
    const settings = await getSettings();
    expect(settings).not.toBeNull();
    expect(settings.showSidebar).toBe(false);
  });
});

test.describe('B4 - SETTINGS_UPDATED live re-render', () => {
  test('badges update when region changes in popup', async ({ navigate, setSettings, seedFixtures }) => {
    await seedFixtures('eu');
    await setSettings({
      apiKey: 'TEST',
      regions: ['eu'],
      selectiveFetch: true,
      showSidebar: true,
      ggdealsAutoScroll: true,
      currency: 'EUR',
      theme: 'dark',
    });

    const page = await navigate('https://www.steamtrades.com/trade/12345/test');

    await page.waitForSelector('.stpt-badge', { state: 'attached', timeout: 10000 });

    // Change region to NA via settings — SETTINGS_UPDATED performs a cache-only repaint.
    await setSettings({
      apiKey: 'TEST',
      regions: ['na'],
      selectiveFetch: true,
      showSidebar: true,
      ggdealsAutoScroll: true,
      currency: 'USD',
      theme: 'dark',
    });

    // No prices are cached for 'na', so price/tier badges disappear and idle
    // skeletons return. The independent Steam Tracker removal badge must remain.
    // This also proves a settings update did not perform a remote price fallback.
    const priceBadges = page.locator([
      '.stpt-badge[data-type="DEAL"]',
      '.stpt-badge[data-type="WISH"]',
      '.stpt-badge[data-type="TRADE"]',
      '.stpt-badge[data-type="BUNDLE"]',
      '.stpt-badge[data-type="NA"]',
    ].join(','));
    await expect(priceBadges).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('.stpt-badge[data-type^="removed_"]')).toHaveCount(1);
    const skeletonCount = await page.locator('.stpt-skeleton').count();
    expect(skeletonCount).toBeGreaterThan(0);
  });
});

test.describe('B5 - gg.deals scroll toggle', () => {
  test('auto-scroll respects ggdealsAutoScroll setting', async ({ extensionContext, navigate, setSettings }) => {
    const { context } = extensionContext;

    // Helper: set up a GGDEALS_SCRAPED counter in the SW, navigate, wait, check count
    const checkScraped = async (expectScraped) => {
      const sw = context.serviceWorkers()[0];
      // Reset counter and listen for GGDEALS_SCRAPED messages
      await sw.evaluate(() => {
        globalThis.__b5ScrapedCount = 0;
        if (!globalThis.__b5ListenerAdded) {
          chrome.runtime.onMessage.addListener((msg) => {
            if (msg.type === 'GGDEALS_SCRAPED') {
              globalThis.__b5ScrapedCount = (globalThis.__b5ScrapedCount || 0) + 1;
            }
          });
          globalThis.__b5ListenerAdded = true;
        }
      });

      const page = await navigate('https://gg.deals/game/test-game');
      await page.waitForLoadState('networkidle');
      // Scraper delays: 1s ping wait + 2s pre-scroll + 1s between + 2s post-scroll = ~6s
      await page.waitForTimeout(9000);

      const count = await sw.evaluate(() => globalThis.__b5ScrapedCount || 0);
      if (expectScraped) {
        expect(count).toBeGreaterThan(0);
      } else {
        expect(count).toBe(0);
      }
      await page.close();
    };

    // Enable auto-scroll
    await setSettings({
      apiKey: 'TEST',
      regions: ['eu'],
      selectiveFetch: true,
      showSidebar: true,
      ggdealsAutoScroll: true,
      currency: 'EUR',
      theme: 'dark',
    });
    await checkScraped(true);

    // Disable auto-scroll
    await setSettings({
      apiKey: 'TEST',
      regions: ['eu'],
      selectiveFetch: true,
      showSidebar: true,
      ggdealsAutoScroll: false,
      currency: 'EUR',
      theme: 'dark',
    });
    await checkScraped(false);
  });
});

test.describe('B6 - Personal-page exclusion', () => {
  test('exclusion button hides badges and persists', async ({ navigate, seedFixtures }) => {
    await seedFixtures();

    const page = await navigate('https://www.steamtrades.com/trade/12345/test');

    // Wait for badges and exclusion button
    await page.waitForSelector('.stpt-badge', { state: 'attached', timeout: 10000 });
    await page.waitForSelector('#stpt-exclusion-btn', { state: 'attached', timeout: 10000 });

    const badgeCount = await page.locator('.stpt-badge').count();
    expect(badgeCount).toBeGreaterThan(0);

    // Click exclusion button
    await page.locator('#stpt-exclusion-btn').click();
    await page.waitForTimeout(1000);

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Assert no badges appear
    const badgeCountAfter = await page.locator('.stpt-badge').count({ timeout: 3000 }).catch(() => 0);
    expect(badgeCountAfter).toBe(0);

    // Button text should indicate exclusion
    const btnText = await page.locator('#stpt-exclusion-btn').textContent();
    expect(btnText).toContain('Personal page');
  });
});

test.describe('B7 - Excluded add-via-settings', () => {
  test('adding trade URL via popup settings excludes it', async ({ extensionContext, navigate, seedFixtures }) => {
    const { context, extensionId } = extensionContext;
    const tradeUrl = 'https://www.steamtrades.com/trade/99999/excluded-trade';

    // Navigate to popup
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const page = await context.newPage();
    await page.goto(popupUrl);
    await page.waitForLoadState('networkidle');

    // Go to Personal Pages section in settings
    const settingsTab = page.locator('[data-tab="settings"]');
    await expect(settingsTab).toBeAttached();
    await settingsTab.click();
    await page.waitForTimeout(300);

    // Type trade URL into input and click Add
    const urlInput = page.locator('#s-excluded-add-url');
    await expect(urlInput).toBeAttached();

    const inputBox = await urlInput.boundingBox();
    const buttonBox = await page.locator('#s-excluded-add-btn').boundingBox();
    expect(inputBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(inputBox.width).toBeGreaterThan(buttonBox.width * 2);

    await urlInput.fill(tradeUrl);

    const addButton = page.locator('#s-excluded-add-btn');
    await expect(addButton).toBeAttached();
    await addButton.click();

    await page.waitForTimeout(500);
    await page.close();

    // Seed fixtures so the trade page would show badges if not excluded
    await seedFixtures();

    // Navigate to that trade URL
    const tradePage = await navigate(tradeUrl);
    await tradePage.waitForLoadState('networkidle');

    // Assert no badges appear (page is excluded)
    const badgeCount = await tradePage.locator('.stpt-badge').count({ timeout: 3000 }).catch(() => 0);
    expect(badgeCount).toBe(0);
  });
});

test.describe('B8 - Excluded pages stay synchronized', () => {
  test('syncs popup and page-button changes with compact link deletion', async ({ extensionContext, navigate }) => {
    const { context, extensionId } = extensionContext;
    const tradeUrl = 'https://www.steamtrades.com/trade/9EnIv/h-games-w-games-paypal-revolut';
    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;

    const tradePage = await navigate(tradeUrl);
    await tradePage.waitForSelector('#stpt-exclusion-btn', { state: 'attached', timeout: 10000 });

    const popup = await context.newPage();
    await popup.goto(`${popupUrl}?tab=settings`);
    await popup.waitForLoadState('networkidle');
    await popup.waitForTimeout(300);

    const input = popup.locator('#s-excluded-add-url');
    await input.fill(tradeUrl);
    await popup.locator('#s-excluded-add-btn').click();

    const savedLink = popup.locator('.excluded-page-link');
    await expect(savedLink).toContainText('...9EnIv/h-games-w-games-paypal-revolut');
    await expect(tradePage.locator('#stpt-exclusion-btn')).toContainText('Personal page', { timeout: 10000 });

    await popup.locator('.excluded-page-delete').click();
    await expect(popup.locator('#s-excluded-pages-list')).toContainText('No personal pages added yet.');
    await expect(tradePage.locator('#stpt-exclusion-btn')).toHaveText('Mark as personal page', { timeout: 10000 });

    await tradePage.locator('#stpt-exclusion-btn').click();
    await expect(popup.locator('.excluded-page-link')).toContainText('...9EnIv/h-games-w-games-paypal-revolut', { timeout: 10000 });

    await popup.close();
    await tradePage.close();
  });
});

test.describe('S1 - Tradables persistence', () => {
  test('add and remove persist across popup sessions', async ({ extensionContext, setSettings }) => {
    const { context, extensionId } = extensionContext;

    await setSettings({
      apiKey: '',
      steamId: '',
      currency: 'EUR',
      regions: ['eu'],
      selectiveFetch: true,
      showSidebar: false,
      ggdealsAutoScroll: false,
      dealThresholdPct: 10,
    });

    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
    const openTradables = async () => {
      const page = await context.newPage();
      await page.goto(`${popupUrl}?tab=tradables`);
      await expect(page.locator('#t-list')).toBeAttached();
      return page;
    };

    const firstSession = await openTradables();
    await firstSession.locator('#t-add-btn').click();
    await firstSession.locator('#bulk-input').fill('Test Game');
    await firstSession.locator('#bulk-preview-btn').click();
    await expect(firstSession.locator('#bulk-add-btn')).toBeEnabled();
    await firstSession.locator('#bulk-add-btn').click();
    await expect(firstSession.locator('.tradables-name')).toContainText('Test Game');
    await firstSession.close();

    const secondSession = await openTradables();
    await expect(secondSession.locator('.tradables-name')).toContainText('Test Game');
    await secondSession.locator('.tradables-remove').click();
    await expect(secondSession.locator('.tradables-empty')).toContainText('No tradables found');
    await secondSession.close();

    const thirdSession = await openTradables();
    await expect(thirdSession.locator('.tradables-empty')).toContainText('No tradables found');
    await expect(thirdSession.locator('.tradables-name')).toHaveCount(0);
    await thirdSession.close();
  });
});

test.describe('S2 - Exact Steam bundle resolution', () => {
  test('adds an exact bundle without manual resolution', async ({ extensionContext, setSettings }) => {
    const { context, extensionId } = extensionContext;
    await setSettings({
      apiKey: '',
      steamId: '',
      currency: 'EUR',
      regions: ['eu'],
      selectiveFetch: true,
      showSidebar: false,
      ggdealsAutoScroll: false,
      dealThresholdPct: 10,
    });

    await context.route('**/store.steampowered.com/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/storesearch/') {
        const term = url.searchParams.get('term');
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            items: term === 'Asterix & Obelix XXL'
              ? [{ id: 887060, name: 'Asterix & Obelix XXL 2', type: 'app' }]
              : [],
          }),
        });
        return;
      }
      if (url.pathname.startsWith('/app/887060/')) {
        await route.fulfill({
          contentType: 'text/html',
          body: '<a href="/bundle/16628/Asterix__Obelix_XXL_Collection/">Bundle</a>',
        });
        return;
      }
      if (url.pathname.startsWith('/bundle/16628/')) {
        await route.fulfill({
          contentType: 'text/html',
          body: '<div class="pageheader">Asterix &amp; Obelix XXL Collection</div>',
        });
        return;
      }
      await route.fulfill({ status: 404, body: '' });
    });

    const popupUrl = `chrome-extension://${extensionId}/popup/popup.html?tab=tradables`;
    const page = await context.newPage();
    await page.goto(popupUrl);
    await expect(page.locator('#t-list')).toBeAttached();
    await page.locator('#t-add-btn').click();
    await page.locator('#bulk-input').fill('Asterix & Obelix XXL Collection');
    await page.locator('#bulk-preview-btn').click();

    const preview = page.locator('.preview-item');
    await expect(preview).toContainText('Asterix & Obelix XXL Collection', { timeout: 15000 });
    await expect(preview.locator('.preview-appid')).toHaveText('#16628');
    await expect(preview.locator('.preview-resolve-btn')).toHaveCount(0);
    await expect(preview.locator('.preview-bundle-hint')).toHaveCount(0);

    await page.locator('#bulk-add-btn').click();
    await expect(page.locator('.tradables-name')).toContainText('Asterix & Obelix XXL Collection');

    const sw = context.serviceWorkers()[0];
    const tradables = await sw.evaluate(async () => {
      const stored = await chrome.storage.local.get('tradables_list');
      return stored.tradables_list?.value ?? [];
    });
    expect(tradables).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'Asterix & Obelix XXL Collection',
        appId: '16628',
        type: 'bundle',
      }),
    ]));

    await page.close();
  });
});
