import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener: vi.fn(),
    },
    sendMessage: vi.fn(),
  },
};

const {
  buildTradablesCountLabelContent,
  buildTradablesListItemElement,
  buildTradablesResolvePopoverElement,
  buildTradablesSnapshotOptions,
  bindTradablesRuntimeStateForInit,
  computeTradablesTotalValue,
  createTradablesInitGuard,
  initTradables,
  normalizeTradableItem,
  parseTradablesAcqPrice,
  parseTradablesQuantity,
  populateTradablesShellState,
  renderTradablesSearchStatus,
} = await import('../popup/tradables.js');

const { hasBundleKeywords } = await import('../popup/tradables-parser.js');

describe('tradables init guards', () => {
  it('marks older init guards stale when a newer init starts', () => {
    const first = createTradablesInitGuard();
    expect(first()).toBe(true);

    const second = createTradablesInitGuard();

    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('does not bind runtime state for stale init guards', () => {
    const stale = createTradablesInitGuard();
    createTradablesInitGuard();

    expect(bindTradablesRuntimeStateForInit(stale, {
      settings: {},
      priceData: {},
      render: vi.fn(),
      updateStats: vi.fn(),
    })).toBe(false);
  });

  it('binds runtime state for the latest init guard', () => {
    const current = createTradablesInitGuard();

    expect(bindTradablesRuntimeStateForInit(current, {
      settings: {},
      priceData: {},
      render: vi.fn(),
      updateStats: vi.fn(),
    })).toBe(true);
  });
});

describe('buildTradablesListItemElement', () => {
  it('uses manual acquisition price for the displayed unit and quantity total', () => {
    const element = buildTradablesListItemElement({
      name: 'Manual Price Game',
      appId: '123',
      type: 'app',
      qty: 3,
      acqPrice: 10,
    }, {
      priceData: {
        prices: { currentRetail: 119, historicalRetail: 99 },
      },
      settings: { currency: 'EUR', keyshopsEnabled: false },
    });

    const badge = element.querySelector('.tradables-price-badge');
    expect(badge.classList.contains('manual')).toBe(true);
    expect(badge.textContent).toContain('€10.00');
    expect(badge.textContent).toContain('× 3 = €30.00');
    expect(badge.title).toContain('API: €1.19');
  });

  it('links resolved titles and valid prices using their typed Steam paths', () => {
    for (const [type, id, path] of [
      ['app', '10', '/app/10'],
      ['sub', '20', '/sub/20'],
      ['bundle', '30', '/bundle/30'],
    ]) {
      const element = buildTradablesListItemElement({
        name: `Game ${type}`,
        appId: id,
        type,
        qty: 1,
      }, {
        priceData: {
          prices: { currentRetail: 500 },
          url: 'https://gg.deals/game/example/',
        },
      });

      const titleLink = element.querySelector('.tradables-name');
      expect(titleLink.tagName).toBe('A');
      expect(new URL(titleLink.href).pathname).toBe(path);
      expect(titleLink.target).toBe('_blank');
      expect(titleLink.rel).toBe('noopener noreferrer');
      expect(titleLink.title).toBe('Open on Steam');

      const ggDealsLink = element.querySelector('.tradables-item-meta a');
      expect(ggDealsLink.textContent).toBe('GG.deals ↗');
      expect(ggDealsLink.href).toBe('https://gg.deals/game/example/');
    }
  });

  it('keeps unresolved titles plain and omits invalid price links', () => {
    const element = buildTradablesListItemElement({
      name: 'Unresolved Game',
      appId: 'not-an-id',
      type: 'app',
      qty: 1,
    }, {
      priceData: {
        prices: { currentRetail: 0 },
        url: 'javascript:alert(1)',
      },
    });

    expect(element.querySelector('.tradables-name').tagName).toBe('SPAN');
    expect(element.querySelector('.tradables-item-meta a')).toBeNull();
    expect(element.querySelector('.tradables-unresolved')).not.toBeNull();
  });

  it('renders stored item data as text and preserves row metadata', () => {
    const item = {
      name: 'Bad <img src=x onerror=alert(1)>',
      appId: '123',
      type: 'bundle',
      qty: 2,
      acqPrice: 1.5,
      _origIndex: 7,
    };

    const element = buildTradablesListItemElement(item, {
      priceData: {
        prices: {
          currentRetail: 250,
          historicalRetail: 240,
        },
        cachedAt: Date.now(),
      },
      settings: {
        currency: 'EUR',
        dealThresholdPct: 10,
        keyshopsEnabled: false,
      },
      currencySymbol: '€',
    });

    expect(element.className).toBe('tradables-item');
    expect(element.dataset.origIndex).toBe('7');
    expect(element.dataset.appid).toBe('123');
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('[onerror]')).toBeNull();
    expect(element.querySelector('[onclick]')).toBeNull();
    expect(element.querySelector('[onfocus]')).toBeNull();
    expect(element.querySelector('.tradables-name').textContent).toBe(item.name);
    expect(element.querySelector('.tradables-appid').textContent).toBe('Bundle #123');
    expect(element.querySelector('.tradables-price-badge.manual')).not.toBeNull();
    expect(element.querySelector('.tradables-qty-suffix').textContent).toContain(' × 2 = ');
    const qtyUp = element.querySelector('.tradables-qty-arrow.tradables-qty-up');
    const qtyDown = element.querySelector('.tradables-qty-arrow.tradables-qty-down');
    const qtyInput = element.querySelector('.tradables-qty-input');
    expect(qtyUp.dataset.origIndex).toBe('7');
  expect(qtyUp.getAttribute('aria-label')).toBe('Increase quantity');
  expect(qtyUp.textContent).toBe('\u25B2');
  expect(qtyDown.dataset.origIndex).toBe('7');
  expect(qtyDown.getAttribute('aria-label')).toBe('Decrease quantity');
  expect(qtyDown.textContent).toBe('\u25BC');
  expect(qtyInput.dataset.origIndex).toBe('7');
  expect(qtyInput.type).toBe('text');
  expect(qtyInput.inputMode).toBe('numeric');
  expect(qtyInput.pattern).toBe('[0-9]*');
  expect(qtyInput.title).toBe('Quantity');
  expect(qtyInput.value).toBe('2');
  expect(element.querySelector('.tradables-acq-input').type).toBe('text');
  expect(element.querySelector('.tradables-acq-input').inputMode).toBe('decimal');
  expect(element.querySelector('.tradables-acq-input').placeholder).toBe('Acq. \u20AC');
    expect(element.querySelector('.tradables-remove').getAttribute('aria-label')).toBe(`Remove ${item.name}`);
  });

  it('renders invalid stored app ids as unresolved', () => {
    const element = buildTradablesListItemElement({
      name: 'Broken App',
      appId: '<script>alert(1)</script>',
      type: 'app',
      qty: 1,
      _origIndex: 2,
    }, {
      settings: { currency: 'EUR' },
      currencySymbol: '€',
    });

    expect(element.dataset.appid).toBe('');
    expect(element.querySelector('.tradables-appid')).toBeNull();
    const unresolved = element.querySelector('.tradables-unresolved.tradables-resolve-link');
    expect(unresolved).not.toBeNull();
    expect(unresolved.dataset.origIndex).toBe('2');
    expect(unresolved.textContent).toBe('unresolved ↗');
    expect(element.querySelector('.tradables-price-badge.na').textContent).toBe('N/A');
  });
});

describe('tradables value calculations', () => {
  it('uses manual acquisition price per unit and multiplies it by quantity', () => {
    const result = computeTradablesTotalValue([
      { appId: '123', type: 'app', qty: 2, acqPrice: 10 },
    ], {
      'app:123': { prices: { currentRetail: 119 } },
    }, { keyshopsEnabled: true });

    expect(result).toEqual({ total: 2000, count: 2 });
  });

  it('falls back to the selected fetched price when no acquisition price exists', () => {
    const result = computeTradablesTotalValue([
      { appId: '123', type: 'app', qty: 2 },
    ], {
      'app:123': { prices: { currentRetail: 119, currentKeyshops: 99 } },
    }, { keyshopsEnabled: true });

    expect(result).toEqual({ total: 198, count: 2 });
  });

  it('includes unresolved items when they have a manual acquisition price', () => {
    const result = computeTradablesTotalValue([
      { appId: null, type: 'app', qty: 3, acqPrice: 10 },
    ], {}, { keyshopsEnabled: true });

    expect(result).toEqual({ total: 3000, count: 3 });
  });
});

describe('tradables persistence', () => {
  it('saves quantity changes so reopening the view keeps the quantity', async () => {
    const sendMessage = chrome.runtime.sendMessage;
    const settings = {
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
      ggdealsAutoScroll: true,
      selectiveFetch: true,
      dealThresholdPct: 10,
    };
    let savedTradables = [{ name: 'Persisted Game', appId: '123', type: 'app', qty: 1 }];
    sendMessage.mockImplementation((message, callback) => {
      let response = {};
      if (message.type === 'GET_SETTINGS') response = settings;
      if (message.type === 'GET_TRADABLES') response = savedTradables;
      if (message.type === 'GET_TRADABLES_SNAPSHOTS') response = [];
      if (message.type === 'SAVE_TRADABLES') {
        savedTradables = message.tradables;
        response = { ok: true };
      }
      callback?.(response);
    });

    try {
      const firstContainer = document.createElement('div');
      document.body.appendChild(firstContainer);
      await initTradables(firstContainer);
      const searchInput = firstContainer.querySelector('#t-search');
      searchInput.focus();
      searchInput.value = 'Persisted';
      searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await vi.waitFor(() => {
        expect(firstContainer.querySelector('#t-search')).toBe(searchInput);
        expect(document.activeElement).toBe(searchInput);
      });
      await new Promise(resolve => setTimeout(resolve, 250));

      const qtyInput = firstContainer.querySelector('.tradables-qty-input');
      qtyInput.value = '3';
      qtyInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

      await vi.waitFor(() => expect(savedTradables[0].qty).toBe(3));

      firstContainer.remove();
      const reopenedContainer = document.createElement('div');
      document.body.appendChild(reopenedContainer);
      await initTradables(reopenedContainer);
      expect(reopenedContainer.querySelector('.tradables-qty-input').value).toBe('3');
      document.body.replaceChildren();
    } finally {
      sendMessage.mockReset();
    }
  });
});

describe('hasBundleKeywords', () => {
  it('returns true for names containing "collection"', () => {
    expect(hasBundleKeywords('Asterix & Obelix XXL Collection')).toBe(true);
  });

  it('returns true for names containing "bundle"', () => {
    expect(hasBundleKeywords('Valve Complete Pack')).toBe(true);
  });

  it('returns true for "pack"', () => {
    expect(hasBundleKeywords('Starter Pack')).toBe(true);
  });

  it('returns true for "anthology"', () => {
    expect(hasBundleKeywords('Dark Souls Trilogy')).toBe(true);
  });

  it('returns false for names without bundle keywords', () => {
    expect(hasBundleKeywords('Hollow Knight')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasBundleKeywords('')).toBe(false);
  });

  it('requires keyword as a whole word (not substring)', () => {
    expect(hasBundleKeywords('Packing Simulator')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hasBundleKeywords('ULTIMATE BUNDLE')).toBe(true);
  });
});

describe('resolve popover bundle guidance', () => {
  it('uses item.type === "bundle" not name keywords', () => {
    const bundleItem = { name: 'Some Game', type: 'bundle' };
    const appItem = { name: 'Asterix & Obelix XXL Collection', type: 'app' };
    const appWithKeywords = { name: 'Valve Complete Pack', type: 'app' };

    expect(bundleItem.type === 'bundle').toBe(true);
    expect(appItem.type === 'bundle').toBe(false);
    expect(appWithKeywords.type === 'bundle').toBe(false);
  });

  it('renders a malicious item name as inert text and retains required selectors', () => {
    const item = {
      name: 'Bad "><img src=x onerror=alert(1)>',
      type: 'bundle',
    };

    const popover = buildTradablesResolvePopoverElement(item);

    expect(popover.className).toBe('tradables-resolve-popover');
    expect(popover.querySelector('img')).toBeNull();
    expect(popover.querySelector('[onerror]')).toBeNull();
    expect(popover.querySelector('.trp-header').textContent).toBe(`Search for "${item.name}"`);
    expect(popover.querySelector('.tradables-resolve-search').value).toBe(item.name);
    expect(popover.querySelector('.tradables-resolve-results')).not.toBeNull();
    expect(popover.querySelector('.trp-cancel').textContent).toBe('Cancel');
    expect(popover.querySelector('.trp-bundle-guidance')).not.toBeNull();

    const searchLink = popover.querySelector('.trp-bundle-search-link');
    const url = new URL(searchLink.href);
    expect(url.origin).toBe('https://store.steampowered.com');
    expect(url.pathname).toBe('/search/');
    expect(url.searchParams.get('term')).toBe(item.name);
  });

  it('omits bundle guidance for app items', () => {
    const popover = buildTradablesResolvePopoverElement({
      name: 'Regular Game',
      type: 'app',
    });

    expect(popover.querySelector('.trp-bundle-guidance')).toBeNull();
    expect(popover.querySelector('.tradables-resolve-search')).not.toBeNull();
  });
});

describe('tradables status and summary builders', () => {
  it('replaces search results with an inert status element', () => {
    const container = document.createElement('div');
    container.innerHTML = '<button onclick="alert(1)">old</button>';

    renderTradablesSearchStatus(container, '<img src=x onerror=alert(1)>', { error: true });

    expect(container.children).toHaveLength(1);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.firstElementChild.style.color).toBe('rgb(243, 139, 168)');
  });

  it('builds snapshot options with labels as text', () => {
    const options = buildTradablesSnapshotOptions([
      { id: 'snap-1', label: '<img src=x onerror=alert(1)>', count: 3 },
    ]);

    expect(options).toHaveLength(2);
    expect(options[0].value).toBe('');
    expect(options[0].textContent).toBe('No snapshots');
    expect(options[1].value).toBe('snap-1');
    expect(options[1].textContent).toBe('<img src=x onerror=alert(1)> (3 games)');
    expect(options[1].querySelector('img')).toBeNull();
  });

  it('builds a games label with a unique count span when quantities differ', () => {
    const nodes = buildTradablesCountLabelContent(5, 3);
    const label = document.createElement('div');
    label.replaceChildren(...nodes);

    expect(label.childNodes[0].textContent).toBe('Games ');
    expect(label.querySelector('.stat-unique').textContent).toBe('(3 unique)');
    expect(label.textContent).toBe('Games (3 unique)');
  });

  it('builds a plain games label when quantity and unique counts match', () => {
    const label = document.createElement('div');
    label.replaceChildren(...buildTradablesCountLabelContent(3, 3));

    expect(label.textContent).toBe('Games');
    expect(label.querySelector('.stat-unique')).toBeNull();
  });
});

describe('populateTradablesShellState', () => {
  function createShell() {
    const shell = document.createElement('div');
    shell.innerHTML = `
      <input id="t-search">
      <select id="t-sort">
        <option value="name">Name A→Z</option>
        <option value="name-desc">Name Z→A</option>
        <option value="price">Price ↑</option>
        <option value="price-desc">Price ↓</option>
        <option value="acq">Acq. Price ↑</option>
        <option value="acq-desc">Acq. Price ↓</option>
      </select>
      <span id="t-total-count"></span>
      <span id="t-total-count-label"></span>
      <div id="t-price-warning" class="tradables-warning" hidden></div>
      <div id="t-actions">
        <button id="t-delete-all"></button>
      </div>
    `;
    return shell;
  }

  it('populates hostile search, warning, and undo values without creating markup', () => {
    const shell = createShell();
    const searchQuery = '"><img src=x onerror=alert(1)>';
    const priceError = '<script>alert(2)</script>\nignored';
    const undoLabel = '<svg onload=alert(3)>';

    populateTradablesShellState(shell, {
      searchQuery,
      sortBy: 'price-desc',
      totalQty: 5,
      uniqueCount: 3,
      priceError,
      hasUndo: true,
      undoLabel,
      hasTradables: true,
    });

    expect(shell.querySelector('#t-search').value).toBe(searchQuery);
    expect(shell.querySelector('#t-sort').value).toBe('price-desc');
    expect(shell.querySelector('#t-total-count').textContent).toBe('5');
    expect(shell.querySelector('#t-total-count-label').textContent).toBe('Games (3 unique)');
    expect(shell.querySelector('#t-total-count-label .stat-unique').textContent).toBe('(3 unique)');
    expect(shell.querySelector('#t-price-warning').hidden).toBe(false);
    expect(shell.querySelector('#t-price-warning').textContent).toBe(`Price warning: ${priceError.split('\n')[0]}`);
    const undo = shell.querySelector('#t-undo.btn-undo');
    expect(undo.title).toBe(`Undo "${undoLabel}"`);
    expect(undo.textContent).toBe('↩ Undo');
    const deleteAll = shell.querySelector('#t-delete-all');
    expect(undo.nextElementSibling).toBe(deleteAll);
    expect(deleteAll.previousElementSibling).toBe(undo);
    expect(deleteAll.style.display).toBe('inline-block');
    expect(shell.querySelector('img')).toBeNull();
    expect(shell.querySelector('script')).toBeNull();
    expect(shell.querySelector('svg')).toBeNull();
    expect(shell.querySelector('[onerror]')).toBeNull();
    expect(shell.querySelector('[onload]')).toBeNull();
  });

  it('clears warning and undo state and hides delete-all when the list is empty', () => {
    const shell = createShell();
    populateTradablesShellState(shell, {
      searchQuery: 'game',
      sortBy: 'name',
      totalQty: 1,
      uniqueCount: 1,
      priceError: 'old error',
      hasUndo: true,
      undoLabel: 'Old Game',
      hasTradables: true,
    });

    populateTradablesShellState(shell, {
      searchQuery: '',
      sortBy: 'name-desc',
      totalQty: 0,
      uniqueCount: 0,
      priceError: '',
      hasUndo: false,
      undoLabel: '',
      hasTradables: false,
    });

    expect(shell.querySelector('#t-price-warning').hidden).toBe(true);
    expect(shell.querySelector('#t-price-warning').textContent).toBe('');
    expect(shell.querySelector('#t-undo')).toBeNull();
    expect(shell.querySelector('#t-delete-all').style.display).toBe('none');
    expect(shell.querySelector('#t-total-count-label').textContent).toBe('Games');
  });
});
describe('tradables list rendering', () => {
  it('normalizes persisted malicious fields before rendering inert DOM content', () => {
    const item = normalizeTradableItem({
      _origIndex: 0,
      name: 'Evil <img src=x onerror=alert(1)>',
      appId: '1" autofocus onfocus="alert(1)',
      type: 'sub" onclick="alert(1)',
      qty: '2" onfocus="alert(1)',
      acqPrice: '3" autofocus onfocus="alert(1)',
    });
    const element = buildTradablesListItemElement(item);

    expect(item).toMatchObject({
      appId: null,
      type: 'app',
      qty: 1,
      acqPrice: null,
    });
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelectorAll('[onerror], [onfocus], [onclick], [autofocus]')).toHaveLength(0);
    expect(element.querySelector('.tradables-name')?.textContent).toBe('Evil <img src=x onerror=alert(1)>');
    expect(element.dataset.appid).toBe('');
    expect(element.querySelector('.tradables-unresolved')?.textContent).toContain('unresolved');
  });

  it('clamps persisted quantities and keeps finite acquisition prices', () => {
    expect(normalizeTradableItem({ name: 'High', qty: 5000, acqPrice: '4.25' })).toMatchObject({
      qty: 999,
      acqPrice: 4.25,
    });
    expect(normalizeTradableItem({ name: 'Low', qty: -10, acqPrice: Infinity })).toMatchObject({
      qty: 1,
      acqPrice: null,
    });
    expect(normalizeTradableItem({ name: 'Empty qty', qty: undefined })).toMatchObject({ qty: 1 });
    expect(normalizeTradableItem({ name: 'Partial qty', qty: '12abc' })).toMatchObject({ qty: 1 });
  });

  it('rejects partial and non-finite acquisition prices', () => {
    expect(normalizeTradableItem({ name: 'Partial', qty: 1, acqPrice: '12abc' })).toMatchObject({ acqPrice: null });
    expect(normalizeTradableItem({ name: 'Scientific', qty: 1, acqPrice: '1e3' })).toMatchObject({ acqPrice: null });
    expect(normalizeTradableItem({ name: 'Hex', qty: 1, acqPrice: '0x10' })).toMatchObject({ acqPrice: null });
    expect(normalizeTradableItem({ name: 'NaN', qty: 1, acqPrice: NaN })).toMatchObject({ acqPrice: null });
    expect(normalizeTradableItem({ name: 'Float', qty: 1, acqPrice: '12.34' })).toMatchObject({ acqPrice: 12.34 });
    expect(normalizeTradableItem({ name: 'Dot prefix', qty: 1, acqPrice: '.50' })).toMatchObject({ acqPrice: 0.5 });
    expect(normalizeTradableItem({ name: 'Dot suffix', qty: 1, acqPrice: '12.' })).toMatchObject({ acqPrice: 12 });
  });
});

describe('parseTradablesQuantity', () => {
  it('accepts valid integer strings', () => {
    expect(parseTradablesQuantity('10')).toBe(10);
    expect(parseTradablesQuantity('1')).toBe(1);
    expect(parseTradablesQuantity('999')).toBe(999);
  });

  it('trims surrounding whitespace', () => {
    expect(parseTradablesQuantity('  42  ')).toBe(42);
  });

  it('clamps below-minimum values to 1', () => {
    expect(parseTradablesQuantity('0')).toBe(1);
    expect(parseTradablesQuantity('-5')).toBe(1);
  });

  it('clamps above-maximum values to 999', () => {
    expect(parseTradablesQuantity('1000')).toBe(999);
    expect(parseTradablesQuantity('9999')).toBe(999);
  });

  it('returns 1 for blank, null, or undefined input', () => {
    expect(parseTradablesQuantity('')).toBe(1);
    expect(parseTradablesQuantity(null)).toBe(1);
    expect(parseTradablesQuantity(undefined)).toBe(1);
  });

  it('rejects mixed text, scientific notation, hex, and decimals', () => {
    expect(parseTradablesQuantity('12abc')).toBe(1);
    expect(parseTradablesQuantity('1e3')).toBe(1);
    expect(parseTradablesQuantity('0x10')).toBe(1);
    expect(parseTradablesQuantity('1.5')).toBe(1);
    expect(parseTradablesQuantity('abc')).toBe(1);
  });
});

describe('parseTradablesAcqPrice', () => {
  it('accepts valid decimal strings', () => {
    expect(parseTradablesAcqPrice('12')).toBe(12);
    expect(parseTradablesAcqPrice('12.34')).toBe(12.34);
    expect(parseTradablesAcqPrice('.50')).toBe(0.5);
    expect(parseTradablesAcqPrice('12.')).toBe(12);
    expect(parseTradablesAcqPrice('0')).toBe(0);
  });

  it('trims surrounding whitespace', () => {
    expect(parseTradablesAcqPrice('  5.5  ')).toBe(5.5);
  });

  it('returns null for blank, null, undefined, or whitespace-only', () => {
    expect(parseTradablesAcqPrice('')).toBeNull();
    expect(parseTradablesAcqPrice(null)).toBeNull();
    expect(parseTradablesAcqPrice(undefined)).toBeNull();
    expect(parseTradablesAcqPrice('   ')).toBeNull();
  });

  it('rejects mixed text, scientific notation, hex, and signed values', () => {
    expect(parseTradablesAcqPrice('12abc')).toBeNull();
    expect(parseTradablesAcqPrice('1e3')).toBeNull();
    expect(parseTradablesAcqPrice('0x10')).toBeNull();
    expect(parseTradablesAcqPrice('-5')).toBeNull();
    expect(parseTradablesAcqPrice('+5')).toBeNull();
  });

  it('rejects malformed decimals', () => {
    expect(parseTradablesAcqPrice('.')).toBeNull();
    expect(parseTradablesAcqPrice('1.2.3')).toBeNull();
    expect(parseTradablesAcqPrice('Infinity')).toBeNull();
    expect(parseTradablesAcqPrice('NaN')).toBeNull();
  });
});
