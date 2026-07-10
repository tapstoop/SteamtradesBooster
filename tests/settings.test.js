import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildDiagnosticsPanelElement,
  buildDiagnosticsPanelHtml,
  formatPopupDiagnosticDate,
  initSettings,
} from '../popup/settings.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

describe('settings diagnostics panel', () => {
  it('renders collapsed and ungenererated by default', () => {
    const html = buildDiagnosticsPanelHtml();

    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden');
    expect(html).toContain('Not generated yet');
    expect(html).toContain('Click Generate to create a diagnostic snapshot.');
    expect(html).toContain('id="s-copy-log" type="button" disabled');
  });

  it('renders generated logs expanded with refresh and copy actions enabled', () => {
    const html = buildDiagnosticsPanelHtml({
      expanded: true,
      log: 'SteamTrades Booster v0.1.3',
      generatedAt: new Date(2026, 4, 31, 7, 48).getTime(),
    });

    expect(html).toContain('data-expanded="true"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('class="diagnostics-body" hidden');
    expect(html).toContain('Refresh');
    expect(html).toContain('SteamTrades Booster v0.1.3');
    expect(html).not.toContain('id="s-copy-log" type="button" disabled');
    expect(html).toMatch(/Generated 2026-05-31 \d{2}:48/);
  });

  it('escapes generated log content and error text', () => {
    const html = buildDiagnosticsPanelHtml({
      expanded: true,
      log: '<script>alert(1)</script>',
      error: '<b>failed</b>',
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;failed&lt;/b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('formats popup diagnostic timestamps without seconds', () => {
    expect(formatPopupDiagnosticDate(new Date(2026, 4, 31, 7, 8, 25).getTime()))
      .toMatch(/^2026-05-31 \d{2}:08$/);
  });

  it('builds malicious log and error content as inert textarea and text values', () => {
    const panel = buildDiagnosticsPanelElement({
      expanded: true,
      log: '<img src=x onerror=alert(1)>',
      error: '<script>alert(2)</script>',
    });

    expect(panel).toBeInstanceOf(HTMLElement);
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.querySelector('script')).toBeNull();
    expect(panel.querySelector('[onerror]')).toBeNull();
    expect(panel.querySelector('#s-error-log').value).toBe('<img src=x onerror=alert(1)>');
    expect(panel.querySelector('#s-error-log-error').textContent).toBe('<script>alert(2)</script>');
  });

  it('preserves expanded controls and generated diagnostics states', () => {
    const panel = buildDiagnosticsPanelElement({
      expanded: true,
      log: 'SteamTrades Booster v0.1.3',
      generatedAt: new Date(2026, 4, 31, 7, 48).getTime(),
    });

    expect(panel.id).toBe('error-log');
    expect(panel.classList.contains('diagnostics-panel')).toBe(true);
    expect(panel.classList.contains('expanded')).toBe(true);
    expect(panel.dataset.expanded).toBe('true');
    expect(panel.querySelector('#s-toggle-log').getAttribute('aria-expanded')).toBe('true');
    expect(panel.querySelector('.diagnostics-body').hidden).toBe(false);
    expect(panel.querySelector('#s-generate-log').textContent).toBe('Refresh');
    expect(panel.querySelector('#s-generate-log').disabled).toBe(false);
    expect(panel.querySelector('#s-copy-log').textContent).toBe('Copy');
    expect(panel.querySelector('#s-copy-log').disabled).toBe(false);
  });

  it('preserves collapsed loading and empty diagnostics states', () => {
    const panel = buildDiagnosticsPanelElement({ loading: true });

    expect(panel.dataset.expanded).toBe('false');
    expect(panel.querySelector('.diagnostics-body').hidden).toBe(true);
    expect(panel.querySelector('#s-error-log').value).toBe('Click Generate to create a diagnostic snapshot.');
    expect(panel.querySelector('#s-error-log-error').hidden).toBe(true);
    expect(panel.querySelector('#s-generate-log').textContent).toBe('Generate');
    expect(panel.querySelector('#s-generate-log').disabled).toBe(true);
    expect(panel.querySelector('#s-copy-log').disabled).toBe(true);
  });

  it('keeps diagnostics controls bound across initSettings panel replacements', async () => {
    const originalChrome = globalThis.chrome;
    const originalLocation = globalThis.location;
    const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const diagnosticLog = 'SteamTrades Booster integration diagnostics';
    const sendMessage = vi.fn((message, callback) => {
      const response = message.type === 'GET_SETTINGS'
        ? {
            apiKey: '',
            steamId: '',
            currency: 'EUR',
            regions: ['eu'],
            platforms: ['steam'],
            keyshopsEnabled: false,
            keyshops: [],
            keyshopFees: {},
            showSidebar: true,
            showFullTimestamp: false,
            selectiveFetch: true,
            dealThresholdPct: 10,
          }
        : message.type === 'GET_EXCLUDED_PAGES'
          ? []
          : message.type === 'ADD_EXCLUDED_PAGE'
            ? [message.url]
            : message.type === 'REMOVE_EXCLUDED_PAGE'
              ? []
              : message.type === 'GET_DIAGNOSTIC_LOG'
                ? { log: diagnosticLog }
                : {};
      callback?.(response);
      return Promise.resolve(response);
    });
    const storageGet = vi.fn((key, callback) => callback({ [key]: false }));
    const storageSet = vi.fn((value, callback) => callback?.());
    const writeText = vi.fn().mockResolvedValue(undefined);

    globalThis.chrome = {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '0.1.3' })),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    };
    globalThis.location = new URL('https://extension.test/popup.html?tab=settings');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText } },
    });

    try {
      const container = document.createElement('div');
      await initSettings(container);

      expect(container.querySelector('#diagnostics-panel-slot')).toBeNull();
      const initialPanel = container.querySelector('#error-log');
      expect(initialPanel).not.toBeNull();
      expect(initialPanel.dataset.expanded).toBe('false');
      expect(initialPanel.querySelector('#s-toggle-log')).not.toBeNull();
      expect(initialPanel.querySelector('#s-generate-log')).not.toBeNull();
      expect(initialPanel.querySelector('#s-copy-log')).not.toBeNull();

      initialPanel.querySelector('#s-toggle-log').click();
      await vi.waitFor(() => {
        expect(container.querySelector('#error-log')).not.toBe(initialPanel);
        expect(container.querySelector('#error-log').dataset.expanded).toBe('true');
      });

      const expandedPanel = container.querySelector('#error-log');
      expandedPanel.querySelector('#s-generate-log').click();
      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'GET_DIAGNOSTIC_LOG' }),
          expect.any(Function),
        );
        expect(container.querySelector('#s-error-log').value).toBe(diagnosticLog);
        expect(container.querySelector('#s-error-log-meta').textContent).toMatch(/^Generated /);
        expect(container.querySelector('#s-generate-log').textContent).toBe('Refresh');
        expect(container.querySelector('#s-copy-log').disabled).toBe(false);
      });

      const generatedPanel = container.querySelector('#error-log');
      expect(generatedPanel).not.toBe(expandedPanel);
      generatedPanel.querySelector('#s-toggle-log').click();
      await vi.waitFor(() => {
        expect(container.querySelector('#error-log')).not.toBe(generatedPanel);
        expect(container.querySelector('#error-log').dataset.expanded).toBe('false');
      });
      expect(storageSet).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.chrome = originalChrome;
      globalThis.location = originalLocation;
      if (originalNavigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
      } else {
        delete globalThis.navigator;
      }
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });

  it('calls GET_EXCLUDED_PAGES on init', async () => {
    const originalChrome = globalThis.chrome;
    const originalLocation = globalThis.location;
    const sendMessage = vi.fn((message, callback) => {
      const response = message.type === 'GET_SETTINGS'
        ? {
            apiKey: '',
            steamId: '',
            currency: 'EUR',
            regions: ['eu'],
            platforms: ['steam'],
            keyshopsEnabled: false,
            keyshops: [],
            keyshopFees: {},
            showSidebar: true,
            showFullTimestamp: false,
            selectiveFetch: true,
            dealThresholdPct: 10,
          }
        : message.type === 'GET_EXCLUDED_PAGES'
          ? []
          : {};
      callback?.(response);
      return Promise.resolve(response);
    });
    const storageGet = vi.fn((key, callback) => callback({ [key]: false }));
    const storageSet = vi.fn((value, callback) => callback?.());

    globalThis.chrome = {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '0.1.3' })),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    };
    globalThis.location = new URL('https://extension.test/popup.html?tab=settings');

    try {
      const container = document.createElement('div');
      await initSettings(container);

      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'GET_EXCLUDED_PAGES' }),
        expect.any(Function),
      );
    } finally {
      globalThis.chrome = originalChrome;
      globalThis.location = originalLocation;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });

  it('adds an excluded page when clicking the add button', async () => {
    const originalChrome = globalThis.chrome;
    const originalLocation = globalThis.location;
    const addedPages = [];
    const sendMessage = vi.fn((message, callback) => {
      const response = message.type === 'GET_SETTINGS'
        ? {
            apiKey: '',
            steamId: '',
            currency: 'EUR',
            regions: ['eu'],
            platforms: ['steam'],
            keyshopsEnabled: false,
            keyshops: [],
            keyshopFees: {},
            showSidebar: true,
            showFullTimestamp: false,
            selectiveFetch: true,
            dealThresholdPct: 10,
          }
        : message.type === 'GET_EXCLUDED_PAGES'
          ? [...addedPages]
          : message.type === 'ADD_EXCLUDED_PAGE'
            ? (addedPages.push(message.url), [...addedPages])
            : {};
      callback?.(response);
      return Promise.resolve(response);
    });
    const storageGet = vi.fn((key, callback) => callback({ [key]: false }));
    const storageSet = vi.fn((value, callback) => callback?.());

    globalThis.chrome = {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '0.1.3' })),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    };
    globalThis.location = new URL('https://extension.test/popup.html?tab=settings');

    try {
      const container = document.createElement('div');
      await initSettings(container);

      const input = container.querySelector('#s-excluded-add-url');
      const btn = container.querySelector('#s-excluded-add-btn');
      input.value = 'https://www.steamtrades.com/trade/999/test-game';
      btn.click();

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'ADD_EXCLUDED_PAGE', url: 'https://www.steamtrades.com/trade/999/test-game' }),
          expect.any(Function),
        );
      });

      const listEl = container.querySelector('#s-excluded-pages-list');
      expect(listEl.textContent).toContain('steamtrades.com/trade/999');
    } finally {
      globalThis.chrome = originalChrome;
      globalThis.location = originalLocation;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });

  it('removes an excluded page when clicking delete', async () => {
    const originalChrome = globalThis.chrome;
    const originalLocation = globalThis.location;
    let pages = ['trade:123'];
    const sendMessage = vi.fn((message, callback) => {
      const response = message.type === 'GET_SETTINGS'
        ? {
            apiKey: '',
            steamId: '',
            currency: 'EUR',
            regions: ['eu'],
            platforms: ['steam'],
            keyshopsEnabled: false,
            keyshops: [],
            keyshopFees: {},
            showSidebar: true,
            showFullTimestamp: false,
            selectiveFetch: true,
            dealThresholdPct: 10,
          }
        : message.type === 'GET_EXCLUDED_PAGES'
          ? [...pages]
          : message.type === 'REMOVE_EXCLUDED_PAGE'
            ? (pages = pages.filter(p => p !== message.page), [])
            : {};
      callback?.(response);
      return Promise.resolve(response);
    });
    const storageGet = vi.fn((key, callback) => callback({ [key]: false }));
    const storageSet = vi.fn((value, callback) => callback?.());

    globalThis.chrome = {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '0.1.3' })),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    };
    globalThis.location = new URL('https://extension.test/popup.html?tab=settings');

    try {
      const container = document.createElement('div');
      await initSettings(container);

      await vi.waitFor(() => {
        const listEl = container.querySelector('#s-excluded-pages-list');
        expect(listEl.textContent).toContain('steamtrades.com/trade/123');
      });

      const deleteBtn = container.querySelector('.excluded-page-delete');
      deleteBtn.click();

      await vi.waitFor(() => {
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'REMOVE_EXCLUDED_PAGE', page: 'trade:123' }),
          expect.any(Function),
        );
        const listEl = container.querySelector('#s-excluded-pages-list');
        expect(listEl.textContent).not.toContain('steamtrades.com/trade/123');
      });
    } finally {
      globalThis.chrome = originalChrome;
      globalThis.location = originalLocation;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });

  it('shows "must be a steamtrades.com page" when adding invalid URL to empty list', async () => {
    const originalChrome = globalThis.chrome;
    const originalLocation = globalThis.location;
    const sendMessage = vi.fn((message, callback) => {
      const response = message.type === 'GET_SETTINGS'
        ? {
            apiKey: '',
            steamId: '',
            currency: 'EUR',
            regions: ['eu'],
            platforms: ['steam'],
            keyshopsEnabled: false,
            keyshops: [],
            keyshopFees: {},
            showSidebar: true,
            showFullTimestamp: false,
            selectiveFetch: true,
            dealThresholdPct: 10,
          }
        : message.type === 'GET_EXCLUDED_PAGES'
          ? []
          : message.type === 'ADD_EXCLUDED_PAGE'
            ? []
            : {};
      callback?.(response);
      return Promise.resolve(response);
    });
    const storageGet = vi.fn((key, callback) => callback({ [key]: false }));
    const storageSet = vi.fn((value, callback) => callback?.());

    globalThis.chrome = {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '0.1.3' })),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    };
    globalThis.location = new URL('https://extension.test/popup.html?tab=settings');

    try {
      const container = document.createElement('div');
      await initSettings(container);

      const input = container.querySelector('#s-excluded-add-url');
      const btn = container.querySelector('#s-excluded-add-btn');
      input.value = 'https://example.com/trade/123';
      btn.click();

      await vi.waitFor(() => {
        const msgEl = container.querySelector('.add-error-msg');
        expect(msgEl).not.toBeNull();
        expect(msgEl.textContent).toBe('URL must be a steamtrades.com page');
      });
    } finally {
      globalThis.chrome = originalChrome;
      globalThis.location = originalLocation;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });

  it('shows "Already in your personal pages" when re-adding a duplicate URL', async () => {
    const originalChrome = globalThis.chrome;
    const originalLocation = globalThis.location;
    const existingList = ['trade:999'];
    const sendMessage = vi.fn((message, callback) => {
      const response = message.type === 'GET_SETTINGS'
        ? {
            apiKey: '',
            steamId: '',
            currency: 'EUR',
            regions: ['eu'],
            platforms: ['steam'],
            keyshopsEnabled: false,
            keyshops: [],
            keyshopFees: {},
            showSidebar: true,
            showFullTimestamp: false,
            selectiveFetch: true,
            dealThresholdPct: 10,
          }
        : message.type === 'GET_EXCLUDED_PAGES'
          ? [...existingList]
          : message.type === 'ADD_EXCLUDED_PAGE'
            ? [...existingList]
            : {};
      callback?.(response);
      return Promise.resolve(response);
    });
    const storageGet = vi.fn((key, callback) => callback({ [key]: false }));
    const storageSet = vi.fn((value, callback) => callback?.());

    globalThis.chrome = {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '0.1.3' })),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    };
    globalThis.location = new URL('https://extension.test/popup.html?tab=settings');

    try {
      const container = document.createElement('div');
      await initSettings(container);

      const input = container.querySelector('#s-excluded-add-url');
      const btn = container.querySelector('#s-excluded-add-btn');
      input.value = 'https://www.steamtrades.com/trade/999/test-game';
      btn.click();

      await vi.waitFor(() => {
        const msgEl = container.querySelector('.add-error-msg');
        expect(msgEl).not.toBeNull();
        expect(msgEl.textContent).toBe('Already in your personal pages');
      });
    } finally {
      globalThis.chrome = originalChrome;
      globalThis.location = originalLocation;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });

  it('shows "Could not add this page" when backend returns unchanged list for a valid non-duplicate URL', async () => {
    const originalChrome = globalThis.chrome;
    const originalLocation = globalThis.location;
    const existingList = ['trade:111'];
    const sendMessage = vi.fn((message, callback) => {
      const response = message.type === 'GET_SETTINGS'
        ? {
            apiKey: '',
            steamId: '',
            currency: 'EUR',
            regions: ['eu'],
            platforms: ['steam'],
            keyshopsEnabled: false,
            keyshops: [],
            keyshopFees: {},
            showSidebar: true,
            showFullTimestamp: false,
            selectiveFetch: true,
            dealThresholdPct: 10,
          }
        : message.type === 'GET_EXCLUDED_PAGES'
          ? [...existingList]
          : message.type === 'ADD_EXCLUDED_PAGE'
            ? [...existingList]
            : {};
      callback?.(response);
      return Promise.resolve(response);
    });
    const storageGet = vi.fn((key, callback) => callback({ [key]: false }));
    const storageSet = vi.fn((value, callback) => callback?.());

    globalThis.chrome = {
      runtime: {
        sendMessage,
        getManifest: vi.fn(() => ({ version: '0.1.3' })),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    };
    globalThis.location = new URL('https://extension.test/popup.html?tab=settings');

    try {
      const container = document.createElement('div');
      await initSettings(container);

      const input = container.querySelector('#s-excluded-add-url');
      const btn = container.querySelector('#s-excluded-add-btn');
      // Valid steamtrades URL, not in the existing list, but backend returns unchanged list
      input.value = 'https://www.steamtrades.com/trade/222/new-trade';
      btn.click();

      await vi.waitFor(() => {
        const msgEl = container.querySelector('.add-error-msg');
        expect(msgEl).not.toBeNull();
        expect(msgEl.textContent).toBe('Could not add this page');
      });
    } finally {
      globalThis.chrome = originalChrome;
      globalThis.location = originalLocation;
      document.body.replaceChildren();
      vi.restoreAllMocks();
    }
  });
});
