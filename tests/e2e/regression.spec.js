// tests/e2e/regression.spec.js
import { test, expect } from './helpers/extension.js';
import { join, resolve } from 'path';

const FIXTURES = resolve(import.meta.dirname, 'fixtures');

test.describe('B1 - Badge injection', () => {
  test('injects badges on trade page', async ({ navigate, seedFixtures }) => {
    await seedFixtures();

    const page = await navigate('https://www.steamtrades.com/trade/12345/test');

    // Wait for content script injection - look for skeleton badges first
    await page.waitForSelector('.stpt-skeleton', { state: 'attached', timeout: 10000 });

    // Skeletons get replaced by badges once resolutions and cached prices are read
    await page.waitForSelector('.stpt-badge', { state: 'attached', timeout: 10000 });

    const badgeCount = await page.locator('.stpt-badge').count();
    expect(badgeCount).toBeGreaterThan(0);

    // Assert floating fetch button exists in DOM (hidden until checkboxes selected)
    const fetchBtn = page.locator('#stpt-floating-fetch-btn');
    await expect(fetchBtn).toBeAttached();
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

    // Change region to NA via settings — triggers SETTINGS_UPDATED → fetchFreshPrice
    await setSettings({
      apiKey: 'TEST',
      regions: ['na'],
      selectiveFetch: true,
      showSidebar: true,
      ggdealsAutoScroll: true,
      currency: 'USD',
      theme: 'dark',
    });

    // After region change, SETTINGS_UPDATED triggers fetchFreshPrice for 'na'.
    // Since no prices are cached for 'na' and the API mock returns [], the content
    // script's clearRowStalePrices() removes badges and injectSkeleton() creates
    // .stpt-skeleton elements — directly proving the live re-render path fired.
    // Assert BOTH halves: badges cleared AND skeletons present.
    // If the SETTINGS_UPDATED listener were dropped, badges would never clear → timeout.
    await expect(page.locator('.stpt-badge')).toHaveCount(0, { timeout: 10000 });
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
