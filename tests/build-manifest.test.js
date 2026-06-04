import { describe, expect, it } from 'vitest';
import {
  createPackagedManifest,
  getBuildTarget,
  getOutputNames
} from '../build/manifest.js';

const baseManifest = {
  manifest_version: 3,
  name: 'SteamTrades Booster',
  version: '0.1.2',
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
    expect(getOutputNames('chrome', '0.1.2')).toEqual({
      outDir: 'steamtrades_booster_chrome_v0.1.2',
      packageName: 'steamtrades_booster_chrome_v0.1.2.zip'
    });
    expect(getOutputNames('firefox', '0.1.2')).toEqual({
      outDir: 'steamtrades_booster_firefox_v0.1.2',
      packageName: 'steamtrades_booster_firefox_v0.1.2.zip'
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
        strict_min_version: '109.0',
        data_collection_permissions: {
          required: [],
          optional: []
        }
      }
    });
  });

  it('omits icons when the package has no icon directory', () => {
    const packaged = createPackagedManifest(baseManifest, {
      target: 'chrome',
      includeIcons: false
    });

    expect(packaged.icons).toBeUndefined();
  });
});
