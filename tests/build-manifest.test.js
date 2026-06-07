import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  createPackagedManifest,
  getBuildTarget,
  getOutputNames
} from '../build/manifest.js';

const baseManifest = {
  manifest_version: 3,
  name: 'SteamTrades Booster',
  version: '0.1.3',
  description: 'Enhance steamtrades.com with new UI features and price tracking',
  permissions: ['storage', 'alarms', 'unlimitedStorage'],
  host_permissions: ['https://www.steamtrades.com/*'],
  background: {
    service_worker: 'background/service-worker.js',
    type: 'module'
  },
  content_scripts: [
    {
      matches: ['https://www.steamtrades.com/*'],
      js: ['dist/content.js'],
      css: ['styles/content.css'],
      run_at: 'document_idle'
    }
  ],
  action: {
    default_popup: 'popup/popup.html',
    default_title: 'SteamTrades Booster'
  },
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  }
};

const repoManifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

describe('build manifest helpers', () => {
  it('defaults to chrome when no target is provided', () => {
    expect(getBuildTarget(undefined)).toBe('chrome');
    expect(getBuildTarget('')).toBe('chrome');
  });

  it('accepts chrome and firefox targets', () => {
    expect(getBuildTarget('chrome')).toBe('chrome');
    expect(getBuildTarget('firefox')).toBe('firefox');
  });

  it('rejects unknown build targets', () => {
    expect(() => getBuildTarget('safari')).toThrow(
      'Unknown build target "safari". Expected one of: chrome, firefox'
    );
  });

  it('uses browser-specific output names', () => {
    expect(getOutputNames('chrome', '0.1.3')).toEqual({
      outDir: 'steamtrades_booster_chrome_v0.1.3',
      packageName: 'steamtrades_booster_chrome_v0.1.3.zip'
    });
    expect(getOutputNames('firefox', '0.1.3')).toEqual({
      outDir: 'steamtrades_booster_firefox_v0.1.3',
      packageName: 'steamtrades_booster_firefox_v0.1.3.zip'
    });
  });

  it('creates a chrome manifest with a background service worker', () => {
    const packaged = createPackagedManifest(baseManifest, {
      target: 'chrome',
      includeIcons: true
    });

    expect(packaged.background).toEqual({
      service_worker: 'dist/service-worker.js'
    });
    expect(packaged.browser_specific_settings).toBeUndefined();
    expect(packaged.icons).toEqual(baseManifest.icons);
  });

  it('creates a firefox manifest with background scripts and gecko metadata', () => {
    const packaged = createPackagedManifest(baseManifest, {
      target: 'firefox',
      includeIcons: true
    });

    expect(packaged.background).toEqual({
      scripts: ['dist/service-worker.js']
    });
    expect(packaged.browser_specific_settings).toEqual({
      gecko: {
        id: 'steamtrades-booster@example.com',
        strict_min_version: '142.0',
        data_collection_permissions: {
          required: ['none']
        }
      }
    });
  });

  it('preserves top-level and action icons from the real manifest for both targets', () => {
    const expectedIcons = {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png'
    };

    for (const target of ['chrome', 'firefox']) {
      const output = createPackagedManifest(repoManifest, {
        target,
        includeIcons: true
      });

      expect(output.icons).toEqual(expectedIcons);
      expect(output.action).toHaveProperty('default_icon');
      expect(output.action.default_icon).toEqual(expectedIcons);
      expect(output.action).toHaveProperty('default_popup', repoManifest.action.default_popup);
      expect(output.action).toHaveProperty('default_title', repoManifest.action.default_title);
    }
  });

  it('omits both icons and action.default_icon when the package has no icon directory', () => {
    const manifestWithIcons = {
      ...baseManifest,
      action: {
        default_popup: 'popup/popup.html',
        default_title: 'SteamTrades Booster',
        default_icon: {
          16: 'icons/icon16.png',
          48: 'icons/icon48.png',
          128: 'icons/icon128.png'
        }
      }
    };

    const packaged = createPackagedManifest(manifestWithIcons, {
      target: 'chrome',
      includeIcons: false
    });

    expect(packaged.icons).toBeUndefined();
    expect(packaged.action).not.toHaveProperty('default_icon');
  });

  it('does not mutate the input manifest during transformation', () => {
    const manifestWithIcons = {
      ...baseManifest,
      action: {
        default_popup: 'popup/popup.html',
        default_title: 'SteamTrades Booster',
        default_icon: {
          16: 'icons/icon16.png',
          48: 'icons/icon48.png',
          128: 'icons/icon128.png'
        }
      }
    };
    const snapshot = JSON.stringify(manifestWithIcons);

    createPackagedManifest(manifestWithIcons, { target: 'chrome', includeIcons: false });
    expect(JSON.stringify(manifestWithIcons)).toBe(snapshot);

    createPackagedManifest(manifestWithIcons, { target: 'firefox', includeIcons: true });
    expect(JSON.stringify(manifestWithIcons)).toBe(snapshot);
  });
});
