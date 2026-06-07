/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleManualResolution, handleRuntimeMessage } from '../content/content-handlers.js';
import { applyResolvedRow } from '../content/resolution-helpers.js';

function makePriceData(currentRetail = 1234, currency = 'EUR') {
  return { prices: { currentRetail, currency } };
}

function makeRowEl(dataset = {}) {
  const el = document.createElement('span');
  Object.entries(dataset).forEach(([k, v]) => { el.dataset[k] = v; });
  el.dataset.stptTitle = dataset.stptTitle ?? 'Test Game';
  const parent = document.createElement('div');
  const cb = document.createElement('input');
  cb.className = 'stpt-game-checkbox';
  cb.dataset.stptTitle = el.dataset.stptTitle;
  parent.appendChild(cb);
  parent.appendChild(el);
  return el;
}

function makeEvent(rowEl, detail = {}) {
  return { target: rowEl, detail };
}

describe('handleManualResolution', () => {
  let rowData, workstation, sendMessage, replaceBadge, updateSidebarRow;
  let injectSkeleton, stripParentheses, getDisplayRegion, readPriceRegion;
  let setWorkstationPrice, _getBadgePrice;

  beforeEach(() => {
    rowData = [];
    workstation = {
      updateResolvedPageGame: vi.fn(),
      updateGamePrices: vi.fn(),
    };
    sendMessage = vi.fn();
    replaceBadge = vi.fn();
    updateSidebarRow = vi.fn();
    injectSkeleton = vi.fn();
    setWorkstationPrice = vi.fn((priceMap, appId, type, priceData) => {
      priceMap[appId] = { price: priceData?.prices?.currentRetail ?? null, currency: 'EUR' };
    });
    stripParentheses = vi.fn(s => s);
    _getBadgePrice = vi.fn((pd) => pd?.prices?.currentRetail ?? null);
    getDisplayRegion = vi.fn(() => 'us');
    readPriceRegion = vi.fn().mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDeps() {
    return {
      rowData, workstation, sendMessage, replaceBadge, updateSidebarRow,
      injectSkeleton, applyResolvedRow, stripParentheses, getDisplayRegion, readPriceRegion,
      _getBadgePrice, setWorkstationPrice,
    };
  }

  it('no API key: updates rowData via real applyResolvedRow, workstation receives price:null', async () => {
    const el = makeRowEl({ stptId: '7', stptTitle: 'Ambiguous Game' });
    const entry = { el, appId: null, type: 'app', title: 'Ambiguous Game', cacheKey: 'ck1', fuzzy: true };
    rowData.push(entry);

    sendMessage.mockResolvedValueOnce({ apiKey: null, regions: ['us'] });

    await handleManualResolution(
      makeEvent(el, { appId: '456', title: 'Resolved Game', cacheKey: 'new-ck', type: 'bundle' }),
      makeDeps()
    );

    expect(entry.appId).toBe('456');
    expect(entry.type).toBe('bundle');
    expect(entry.fuzzy).toBe(false);
    expect(entry.resolution).toEqual({ status: 'resolved', appId: '456', type: 'bundle' });

    // Immediate synchronous updates before any await
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '7', expect.objectContaining({
      title: 'Resolved Game', appId: '456', type: 'bundle',
    }));

    // Final async update with price:null
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '7', expect.objectContaining({
      title: 'Resolved Game', appId: '456', type: 'bundle', price: null,
    }));
  });

  it('API key: fetches bundles/prices, sets inBundle, badge/sidebar/workstation updated', async () => {
    const el = makeRowEl({ stptId: '3', stptTitle: 'Test Game' });
    const entry = { el, appId: null, type: 'app', title: 'Test Game', cacheKey: 'ck', fuzzy: true, tier: 2, acqPrice: null };
    rowData.push(entry);

    const priceData = makePriceData(999, 'USD');

    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key123', regions: ['us'], currency: 'USD' })
      .mockResolvedValueOnce({ '123': ['bundle/xyz'] })
      .mockResolvedValueOnce({ 'app:123': { us: priceData } });

    readPriceRegion.mockReturnValueOnce(priceData);

    await handleManualResolution(
      makeEvent(el, { appId: '123', title: 'Resolved', cacheKey: null, type: 'app' }),
      makeDeps()
    );

    expect(entry.inBundle).toBe(true);
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(replaceBadge).toHaveBeenCalled();
    expect(updateSidebarRow).toHaveBeenCalled();

    // Immediate identity update before async
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '3', expect.objectContaining({
      title: 'Resolved', appId: '123', type: 'app',
    }));

    // Async update with price
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '3', expect.objectContaining({
      title: 'Resolved', appId: '123', type: 'app', price: 999, currency: 'USD',
    }));

    expect(workstation.updateGamePrices).toHaveBeenCalled();
  });

  it('missing API currency but settings.currency is provided: uses settings.currency', async () => {
    const el = makeRowEl({ stptId: '10', stptTitle: 'Curr A' });
    const entry = { el, appId: null, type: 'app', title: 'Curr A', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    // settings has currency: 'USD', price data has no currency
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'USD' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'app:100': { us: { prices: { currentRetail: 500 } } } });

    readPriceRegion.mockReturnValueOnce({ prices: { currentRetail: 500 } });

    await handleManualResolution(
      makeEvent(el, { appId: '100', title: 'Curr A', type: 'app' }),
      makeDeps()
    );

    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '10', expect.objectContaining({ title: 'Curr A', appId: '100', type: 'app' }));
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '10', expect.objectContaining({
      currency: 'USD',
    }));
  });

  it('missing API currency and settings.currency omitted: falls back to EUR', async () => {
    const el = makeRowEl({ stptId: '11', stptTitle: 'Curr B' });
    const entry = { el, appId: null, type: 'app', title: 'Curr B', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    // No currency in settings, no currency in price data
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'app:200': { us: { prices: { currentRetail: 300 } } } });

    readPriceRegion.mockReturnValueOnce({ prices: { currentRetail: 300 } });

    await handleManualResolution(
      makeEvent(el, { appId: '200', title: 'Curr B', type: 'app' }),
      makeDeps()
    );

    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '11', expect.objectContaining({ title: 'Curr B', appId: '200', type: 'app' }));
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '11', expect.objectContaining({
      currency: 'EUR',
    }));
  });

  it('no price data: sends price:null to workstation, does not call updateGamePrices', async () => {
    const el = makeRowEl({ stptId: '5' });
    const entry = { el, appId: null, type: 'app', title: 'NoPrice', cacheKey: null, fuzzy: true };
    rowData.push(entry);

    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    readPriceRegion.mockReturnValueOnce(null);

    await handleManualResolution(
      makeEvent(el, { appId: '999', title: 'NoPrice', type: 'app' }),
      makeDeps()
    );

    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '5', expect.objectContaining({ title: 'NoPrice', appId: '999', type: 'app' }));
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '5', expect.objectContaining({
      price: null,
    }));
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });

  it('end-to-end: no-key resolution then PRICE_UPDATED discovers the same row', async () => {
    const el = makeRowEl({ stptId: '42', stptTitle: 'E2E Game' });
    const entry = { el, appId: null, type: 'app', title: 'E2E Game', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    // Step 1: no-key resolution via manual handler
    sendMessage.mockResolvedValueOnce({ apiKey: null, regions: ['us'] });

    await handleManualResolution(
      makeEvent(el, { appId: '777', title: 'E2E Game', cacheKey: 'e2e-ck', type: 'app' }),
      makeDeps()
    );

    // Real applyResolvedRow mutated the entry
    expect(entry.appId).toBe('777');
    expect(entry.fuzzy).toBe(false);
    expect(entry.resolution).toEqual({ status: 'resolved', appId: '777', type: 'app' });
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '42', expect.objectContaining({ title: 'E2E Game', appId: '777', type: 'app' }));

    // Step 2: PRICE_UPDATED discovers the same row
    const runtimeDeps = {
      rowData,
      settingsRef: { current: { apiKey: 'key', regions: ['us'] } },
      sendMessage,
      replaceBadge,
      updateSidebarRow,
      injectSkeleton: vi.fn(),
      getDisplayRegion,
      readPriceRegion,
      priceItem: vi.fn(r => ({ id: r.appId, type: r.type ?? 'app' })),
      normalizeSteamType: vi.fn(t => t || 'app'),
      workstation,
      _getBadgePrice,
      setWorkstationPrice,
    };

    const handled = handleRuntimeMessage({
      type: 'PRICE_UPDATED',
      appId: 777,
      itemType: 'app',
      priceData: makePriceData(599, 'EUR'),
    }, runtimeDeps);

    expect(handled).toBe(true);
    expect(replaceBadge).toHaveBeenCalledWith(el, expect.objectContaining({ prices: expect.any(Object) }), expect.any(Object));
  });

  it('GET_SETTINGS rejection: resolves rowData, renders no-price badge, workstation updated with null', async () => {
    const el = makeRowEl({ stptId: '20', stptTitle: 'Settings Fail' });
    const entry = { el, appId: null, type: 'app', title: 'Settings Fail', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    sendMessage.mockRejectedValue(new Error('settings unavailable'));

    await handleManualResolution(
      makeEvent(el, { appId: '555', title: 'Settings Fail', type: 'app' }),
      makeDeps()
    );

    expect(entry.appId).toBe('555');
    expect(entry.fuzzy).toBe(false);
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '20', expect.objectContaining({ title: 'Settings Fail', appId: '555', type: 'app' }));
    expect(replaceBadge).toHaveBeenCalled();
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '20', expect.objectContaining({
      title: 'Settings Fail', appId: '555', type: 'app', price: null,
    }));
  });

  it('preserves full Steam title in rowData, sidebar, workstation while DOM/checkbox stays stripped', async () => {
    const el = makeRowEl({ stptId: '30', stptTitle: 'Old Match' });
    const entry = { el, appId: null, type: 'app', title: 'Old Match', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    stripParentheses = vi.fn(s => s.replace(/\s*\(.*?\)\s*/g, '').trim());

    sendMessage.mockResolvedValueOnce({ apiKey: null, regions: ['us'] });

    await handleManualResolution(
      makeEvent(el, { appId: '999', title: 'Prey (2017)', type: 'app' }),
      makeDeps()
    );

    // DOM dataset is stripped
    expect(el.dataset.stptTitle).toBe('Prey');
    // Checkbox title is also stripped
    const cb = el.parentNode.querySelector('.stpt-game-checkbox');
    expect(cb.dataset.stptTitle).toBe('Prey');
    // rowData title is the full Steam title
    expect(entry.title).toBe('Prey (2017)');
    // Immediate skeleton and identity update
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '30', expect.objectContaining({ title: 'Prey (2017)', appId: '999', type: 'app' }));
    // Sidebar receives full title via gameInfo
    expect(updateSidebarRow).toHaveBeenCalledWith('30', expect.objectContaining({
      title: 'Prey (2017)',
    }));
    // Workstation final update receives full title
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '30', expect.objectContaining({
      title: 'Prey (2017)',
    }));
  });

  it('GET_BUNDLES rejection: resolves rowData, renders with available price data, workstation updated', async () => {
    const el = makeRowEl({ stptId: '21', stptTitle: 'Bundle Fail' });
    const entry = { el, appId: null, type: 'app', title: 'Bundle Fail', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    const priceData = makePriceData(1111, 'USD');

    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'] })
      .mockRejectedValueOnce(new Error('bundles unavailable'))
      .mockResolvedValueOnce({ 'app:555': { us: priceData } });

    readPriceRegion.mockReturnValueOnce(priceData);

    await handleManualResolution(
      makeEvent(el, { appId: '555', title: 'Bundle Fail', type: 'app' }),
      makeDeps()
    );

    expect(entry.appId).toBe('555');
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '21', expect.objectContaining({ title: 'Bundle Fail', appId: '555', type: 'app' }));
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '21', expect.objectContaining({
      price: 1111,
    }));
  });

  it('GET_PRICES rejection: resolves rowData, renders no-price badge, clears workstation price', async () => {
    const el = makeRowEl({ stptId: '22', stptTitle: 'Price Fail' });
    const entry = { el, appId: null, type: 'app', title: 'Price Fail', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'] })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('prices unavailable'));

    readPriceRegion.mockReturnValueOnce(null);

    await handleManualResolution(
      makeEvent(el, { appId: '555', title: 'Price Fail', type: 'app' }),
      makeDeps()
    );

    expect(entry.appId).toBe('555');
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, '22', expect.objectContaining({ title: 'Price Fail', appId: '555', type: 'app' }));
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, '22', expect.objectContaining({
      price: null,
    }));
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });
});

describe('bindManualResolutionListener', () => {
  let rowData, workstation, sendMessage, replaceBadge, updateSidebarRow;
  let injectSkeleton, stripParentheses, getDisplayRegion, readPriceRegion;
  let setWorkstationPrice, _getBadgePrice;

  beforeEach(() => {
    document.body.innerHTML = '';
    rowData = [];
    workstation = {
      updateResolvedPageGame: vi.fn(),
      updateGamePrices: vi.fn(),
      pageGames: [],
      setPageGames(games) { this.pageGames = games; },
    };
    sendMessage = vi.fn();
    replaceBadge = vi.fn();
    updateSidebarRow = vi.fn();
    injectSkeleton = vi.fn();
    setWorkstationPrice = vi.fn((priceMap, appId, type, priceData) => {
      priceMap[appId] = { price: priceData?.prices?.currentRetail ?? null, currency: 'EUR' };
    });
    stripParentheses = vi.fn(s => s);
    _getBadgePrice = vi.fn((pd) => pd?.prices?.currentRetail ?? null);
    getDisplayRegion = vi.fn(() => 'us');
    readPriceRegion = vi.fn().mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeDeps() {
    return {
      rowData, workstation, sendMessage, replaceBadge, updateSidebarRow,
      injectSkeleton, applyResolvedRow, stripParentheses, getDisplayRegion, readPriceRegion,
      _getBadgePrice, setWorkstationPrice,
    };
  }

  function makeRowEl(dataset = {}) {
    const el = document.createElement('span');
    Object.entries(dataset).forEach(([k, v]) => { el.dataset[k] = v; });
    el.dataset.stptTitle = dataset.stptTitle ?? 'Test Game';
    const parent = document.createElement('div');
    const cb = document.createElement('input');
    cb.className = 'stpt-game-checkbox';
    cb.dataset.stptTitle = el.dataset.stptTitle;
    parent.appendChild(cb);
    parent.appendChild(el);
    return el;
  }

  // ── Integration: ambiguous candidate click ───────────────────────────

  it('ambiguous candidate click: badge removed, skeleton injected, rowData updated, price replaces skeleton', async () => {
    const el = makeRowEl({ stptId: 'amb-1', stptTitle: 'Ambiguous Game' });
    const container = el.parentNode;
    document.body.appendChild(container);
    const entry = { el, appId: null, type: 'app', title: 'Ambiguous Game', cacheKey: 'amb-ck', fuzzy: true, tier: 4 };
    rowData.push(entry);

    // Attach an ambiguous badge (simulating current DOM state)
    const ambBadge = document.createElement('span');
    ambBadge.className = 'stpt-badge';
    ambBadge.dataset.type = '?';
    el.appendChild(ambBadge);

    const priceData = makePriceData(1499, 'EUR');
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'EUR' })
      .mockResolvedValueOnce({ '456': [] })
      .mockResolvedValueOnce({ 'app:456': { us: priceData } });
    readPriceRegion.mockReturnValueOnce(priceData);

    const deps = makeDeps();
    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, deps);

    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '456', title: 'Resolved Title', cacheKey: 'new-ck', type: 'app' } }));

    // Synchronous effects must be visible immediately (before any await)
    expect(el.querySelector('.stpt-badge')).toBeNull();
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(entry.appId).toBe('456');
    expect(entry.fuzzy).toBe(false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'amb-1', expect.objectContaining({
      title: 'Resolved Title', appId: '456', type: 'app',
    }));

    // Wait for async pricing to settle
    await vi.waitFor(() => {
      expect(replaceBadge).toHaveBeenCalledWith(el, expect.objectContaining({ prices: expect.any(Object) }), expect.any(Object));
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'amb-1', expect.objectContaining({
        title: 'Resolved Title', appId: '456', type: 'app', price: 1499, currency: 'EUR',
      }));
      expect(workstation.updateGamePrices).toHaveBeenCalled();
    });
  });

  it('ambiguous candidate click: no API key still updates rowData and injects skeleton', async () => {
    const el = makeRowEl({ stptId: 'amb-2', stptTitle: 'No Key Game' });
    const container = el.parentNode;
    document.body.appendChild(container);
    rowData.push({ el, appId: null, type: 'app', title: 'No Key Game', cacheKey: null, fuzzy: true });

    sendMessage.mockResolvedValueOnce({ apiKey: null, regions: ['us'] });

    const deps = makeDeps();
    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, deps);

    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '888', title: 'Found Game', type: 'app' } }));

    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'amb-2', expect.objectContaining({
      title: 'Found Game', appId: '888', type: 'app',
    }));

    await vi.waitFor(() => {
      expect(replaceBadge).toHaveBeenCalledWith(el, null, expect.any(Object));
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'amb-2', expect.objectContaining({
        price: null,
      }));
      expect(workstation.updateGamePrices).not.toHaveBeenCalled();
    });
  });

  it('handles bundle type with typed price key', async () => {
    const el = makeRowEl({ stptId: 'bnd-1', stptTitle: 'Bundle Game' });
    const container = el.parentNode;
    document.body.appendChild(container);
    rowData.push({ el, appId: null, type: 'app', title: 'Bundle Game', cacheKey: null, fuzzy: true });

    const priceData = makePriceData(2999, 'USD');
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'USD' })
      .mockResolvedValueOnce({ '999': ['Some Bundle'] })
      .mockResolvedValueOnce({ 'bundle:999': { us: priceData } });
    readPriceRegion.mockReturnValueOnce(priceData);

    const deps = makeDeps();
    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, deps);

    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '999', title: 'A Bundle', type: 'bundle' } }));

    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'bnd-1', expect.objectContaining({
      title: 'A Bundle', appId: '999', type: 'bundle',
    }));

    await vi.waitFor(() => {
      expect(setWorkstationPrice).toHaveBeenCalledWith(expect.any(Object), '999', 'bundle', expect.any(Object), expect.any(Object));
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'bnd-1', expect.objectContaining({
        type: 'bundle', price: 2999,
      }));
    });
  });

  it('handles sub type with typed price key', async () => {
    const el = makeRowEl({ stptId: 'sub-1', stptTitle: 'Sub Game' });
    const container = el.parentNode;
    document.body.appendChild(container);
    rowData.push({ el, appId: null, type: 'app', title: 'Sub Game', cacheKey: null, fuzzy: true });

    const priceData = makePriceData(899, 'EUR');
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'EUR' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'sub:777': { us: priceData } });
    readPriceRegion.mockReturnValueOnce(priceData);

    const deps = makeDeps();
    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, deps);

    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '777', title: 'A Sub', type: 'sub' } }));

    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'sub-1', expect.objectContaining({
      title: 'A Sub', appId: '777', type: 'sub',
    }));

    await vi.waitFor(() => {
      expect(setWorkstationPrice).toHaveBeenCalledWith(expect.any(Object), '777', 'sub', expect.any(Object), expect.any(Object));
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'sub-1', expect.objectContaining({
        type: 'sub', price: 899,
      }));
    });
  });

  it('missing price produces resolved N/A state, not ambiguous picker', async () => {
    const el = makeRowEl({ stptId: 'na-1', stptTitle: 'N/A Game' });
    const container = el.parentNode;
    document.body.appendChild(container);
    rowData.push({ el, appId: null, type: 'app', title: 'N/A Game', cacheKey: null, fuzzy: true });

    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    readPriceRegion.mockReturnValueOnce(null);

    const deps = makeDeps();
    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, deps);

    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '111', title: 'No Price Game', type: 'app' } }));

    expect(injectSkeleton).toHaveBeenCalledWith(el, false);
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'na-1', expect.objectContaining({
      title: 'No Price Game', appId: '111', type: 'app',
    }));

    await vi.waitFor(() => {
      // replaceBadge called with null priceData → renders N/A badge
      expect(replaceBadge).toHaveBeenCalledWith(el, null, expect.any(Object));
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'na-1', expect.objectContaining({
        price: null,
      }));
      // updateGamePrices NOT called for null price
      expect(workstation.updateGamePrices).not.toHaveBeenCalled();
    });
  });

  // ── Production-order: listener bound AFTER init ─────────────────────

  it('production-order: listener bound after rowData and workstation are initialized uses live references', async () => {
    const el = makeRowEl({ stptId: 'prod-1', stptTitle: 'Page Game' });
    const container = el.parentNode;
    document.body.appendChild(container);

    // Simulate the production flow: rowData populated by main()
    rowData.push({ el, appId: null, type: 'app', title: 'Page Game', cacheKey: null, fuzzy: true, tier: 1 });

    // Simulate: workstation pageGames populated by main()
    workstation.setPageGames([{
      stptId: 'prod-1', appId: null, type: 'app', title: 'Page Game',
      price: null, tier: 1, el, section: 'have',
      inWishlist: true, inTradables: false, currency: 'EUR',
    }]);

    const priceData = makePriceData(1999, 'EUR');
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'EUR' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'app:500': { us: priceData } });
    readPriceRegion.mockReturnValueOnce(priceData);

    // Bind listener AFTER init — same order as production code
    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, makeDeps());

    // User selects a candidate → stpt-resolve fires
    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '500', title: 'Resolved Steam Title', cacheKey: 'ck-prod', type: 'app' } }));

    // rowData reference is live — entry mutated by applyResolvedRow
    const entry = rowData.find(r => r.el === el);
    expect(entry.appId).toBe('500');
    expect(entry.fuzzy).toBe(false);
    expect(entry.title).toBe('Resolved Steam Title');

    // Immediate workstation identity update (no price yet)
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'prod-1', expect.objectContaining({
      title: 'Resolved Steam Title', appId: '500', type: 'app',
    }));

    await vi.waitFor(() => {
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'prod-1', expect.objectContaining({
        title: 'Resolved Steam Title', appId: '500', type: 'app', price: 1999, currency: 'EUR',
      }));
    });
  });

  // ── Real SidebarWorkstation integration ──────────────────────────────

  it('real SidebarWorkstation: pageGames and DOM update after resolution with real render', async () => {
    const { SidebarWorkstation } = await import('../content/ui-workstation.js');

    vi.useFakeTimers();

    const ws = new SidebarWorkstation({ threshold: 0.1 });
    ws.setPageGames([
      { stptId: 'rws-1', title: 'Original Title', section: 'have', appId: null, type: 'app', price: null, tier: 4, el: null, inWishlist: false, inTradables: false, currency: 'EUR' },
    ]);
    vi.runAllTimers();

    workstation = ws;
    const deps = makeDeps();

    const el = makeRowEl({ stptId: 'rws-1', stptTitle: 'Original Title' });
    const container = el.parentNode;
    document.body.appendChild(container);
    rowData.push({ el, appId: null, type: 'app', title: 'Original Title', cacheKey: null, fuzzy: true, tier: 4 });

    const priceData = makePriceData(1299, 'EUR');
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'EUR' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'app:600': { us: priceData } });
    readPriceRegion.mockReturnValueOnce(priceData);

    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, deps);

    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '600', title: 'Resolved Steam Title', cacheKey: 'ck-rws', type: 'app' } }));

    // Immediate identity update (synchronous, before any await)
    vi.runAllTimers();
    let pgEntry = ws.pageGames.find(g => g.stptId === 'rws-1');
    expect(pgEntry.title).toBe('Resolved Steam Title');
    expect(pgEntry.appId).toBe('600');
    expect(pgEntry.price).toBeNull();

    // Wait for the async pricing chain to complete
    await vi.waitFor(() => {
      const pg = ws.pageGames.find(g => g.stptId === 'rws-1');
      if (pg?.price !== 1299) throw new Error('price not yet set');
    }, { timeout: 5000, interval: 50 });

    vi.runAllTimers();
    pgEntry = ws.pageGames.find(g => g.stptId === 'rws-1');
    expect(pgEntry.title).toBe('Resolved Steam Title');
    expect(pgEntry.price).toBe(1299);
    expect(pgEntry.currency).toBe('EUR');

    ws.destroy();
    vi.useRealTimers();
  });

  // ── Title mismatch: SteamTrades title ≠ selected Steam title ────────

  it('stptId update works even when original SteamTrades title differs from resolved Steam title', async () => {
    const el = makeRowEl({ stptId: 'mismatch-1', stptTitle: 'Weird Name' });
    const container = el.parentNode;
    document.body.appendChild(container);

    // SteamTrades page listed this as "Weird Name", but user selected "Actual Name" from Steam
    rowData.push({ el, appId: null, type: 'app', title: 'Weird Name', cacheKey: null, fuzzy: true, tier: 4 });

    workstation.setPageGames([{
      stptId: 'mismatch-1', appId: null, type: 'app', title: 'Weird Name',
      price: null, tier: 4, el, section: 'have',
      inWishlist: false, inTradables: false, currency: 'EUR',
    }]);

    const priceData = makePriceData(888, 'USD');
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'USD' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'app:700': { us: priceData } });
    readPriceRegion.mockReturnValueOnce(priceData);

    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, makeDeps());

    // The resolved title is different from the original
    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '700', title: 'Actual Name', type: 'app' } }));

    // Updated by stptId, not by matching the old title
    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'mismatch-1', expect.objectContaining({
      title: 'Actual Name', appId: '700', type: 'app',
    }));

    const entry = rowData.find(r => r.el === el);
    expect(entry.title).toBe('Actual Name');

    await vi.waitFor(() => {
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'mismatch-1', expect.objectContaining({
        title: 'Actual Name', appId: '700', type: 'app', price: 888,
      }));
    });
  });

  // ── Single listener invocation ──────────────────────────────────────

  it('only one listener is triggered per stpt-resolve dispatch', async () => {
    const el = makeRowEl({ stptId: 'once-1', stptTitle: 'One Shot' });
    const container = el.parentNode;
    document.body.appendChild(container);
    rowData.push({ el, appId: null, type: 'app', title: 'One Shot', cacheKey: null, fuzzy: true });

    sendMessage.mockResolvedValueOnce({ apiKey: null, regions: ['us'] });

    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, makeDeps());

    const callsBefore = injectSkeleton.mock.calls.length;

    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '900', title: 'Only Once', type: 'app' } }));

    // injectSkeleton should be called exactly once more
    expect(injectSkeleton).toHaveBeenCalledTimes(callsBefore + 1);
    expect(workstation.updateResolvedPageGame).toHaveBeenCalledTimes(1);
  });

  // ── Persistence-rejection coverage ──────────────────────────────────

  it('N/A search result flow: badge removed, skeleton injected, rowData and identity updated even on persistence failure', async () => {
    const el = makeRowEl({ stptId: 'nas-1', stptTitle: 'Not Found Game' });
    const container = el.parentNode;
    document.body.appendChild(container);

    // Attach a not-found badge (simulating current DOM state)
    const nfBadge = document.createElement('span');
    nfBadge.className = 'stpt-badge';
    nfBadge.dataset.type = 'NA';
    el.appendChild(nfBadge);

    rowData.push({ el, appId: null, type: 'app', title: 'Not Found Game', cacheKey: 'nf-ck', fuzzy: true, tier: 4 });

    const priceData = makePriceData(1599, 'EUR');
    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'], currency: 'EUR' })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'app:800': { us: priceData } });
    readPriceRegion.mockReturnValueOnce(priceData);

    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, makeDeps());

    // Simulate a CONFIRM_RESOLUTION persistence failure (the picker
    // dispatches stpt-resolve first then fires CONFIRM_RESOLUTION async;
    // this test covers the case where stpt-resolve succeeds but persistence fails)
    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '800', title: 'Found via Search', cacheKey: 'nf-ck', type: 'app' } }));

    // Badge removed, skeleton injected immediately
    expect(el.querySelector('.stpt-badge')).toBeNull();
    expect(injectSkeleton).toHaveBeenCalledWith(el, false);

    const entry = rowData.find(r => r.el === el);
    expect(entry.appId).toBe('800');
    expect(entry.fuzzy).toBe(false);

    expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(1, 'nas-1', expect.objectContaining({
      title: 'Found via Search', appId: '800', type: 'app',
    }));

    await vi.waitFor(() => {
      expect(workstation.updateResolvedPageGame).toHaveBeenNthCalledWith(2, 'nas-1', expect.objectContaining({
        price: 1599,
      }));
    });
  });

  it('event listener error does not produce unhandled rejection', async () => {
    const el = makeRowEl({ stptId: 'err-1', stptTitle: 'Error Game' });
    const container = el.parentNode;
    document.body.appendChild(container);
    rowData.push({ el, appId: null, type: 'app', title: 'Error Game', cacheKey: null, fuzzy: true });

    const deps = makeDeps();
    // Force a synchronous throw inside handleManualResolution
    stripParentheses = vi.fn(() => { throw new Error('boom'); });

    const doc = document.createElement('div');
    doc.appendChild(container);
    document.body.appendChild(doc);
    const { bindManualResolutionListener } = await import('../content/content-handlers.js');
    bindManualResolutionListener(doc, deps);

    // This must not throw or produce an unhandled rejection
    el.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: '1', title: 'Test', type: 'app' } }));
  });
});

describe('handleRuntimeMessage', () => {
  let rowData, settingsRef, sendMessage, replaceBadge, updateSidebarRow;
  let injectSkeleton, getDisplayRegion, readPriceRegion, priceItem, normalizeSteamType;
  let workstation, _getBadgePrice, setWorkstationPrice;

  beforeEach(() => {
    document.body.innerHTML = '';
    rowData = [];
    settingsRef = { current: null, revision: 0 };
    sendMessage = vi.fn();
    replaceBadge = vi.fn();
    updateSidebarRow = vi.fn();
    injectSkeleton = vi.fn();
    getDisplayRegion = vi.fn(() => 'us');
    readPriceRegion = vi.fn().mockReturnValue(null);
    priceItem = vi.fn(r => ({ id: r.appId, type: r.type ?? 'app' }));
    normalizeSteamType = vi.fn(t => t || 'app');
    workstation = {
      updateResolvedPageGame: vi.fn(),
      updateGamePrices: vi.fn(),
    };
    _getBadgePrice = vi.fn((pd) => pd?.prices?.currentRetail ?? null);
    setWorkstationPrice = vi.fn((priceMap, appId, type, priceData) => {
      const price = priceData?.prices?.currentRetail ?? null;
      if (price == null) return;
      priceMap[appId] = { price, currency: 'EUR' };
    });
  });

  function makeDeps() {
    return {
      rowData, settingsRef, sendMessage, replaceBadge, updateSidebarRow,
      injectSkeleton, getDisplayRegion, readPriceRegion, priceItem, normalizeSteamType,
      workstation, _getBadgePrice, setWorkstationPrice,
    };
  }

  it('PRICE_UPDATED finds a row resolved without API key, rerenders and updates workstation', () => {
    const el = document.createElement('span');
    el.dataset.stptId = '1';
    el.dataset.stptTitle = 'Test';
    document.body.appendChild(el);

    const row = { el, appId: '456', type: 'app', title: 'Test', cacheKey: 'ck', inBundle: false };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['us'] };

    const handled = handleRuntimeMessage({
      type: 'PRICE_UPDATED',
      appId: 456,
      itemType: 'app',
      priceData: makePriceData(499, 'EUR'),
    }, makeDeps());

    expect(handled).toBe(true);
    expect(replaceBadge).toHaveBeenCalledWith(el, expect.objectContaining({ prices: expect.any(Object) }), expect.any(Object));
    expect(updateSidebarRow).toHaveBeenCalledWith('1', expect.any(Object));
    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('1', expect.objectContaining({
      price: 499, currency: 'EUR',
    }));
    expect(workstation.updateGamePrices).toHaveBeenCalled();
  });

  it('PRICE_UPDATED does nothing when no rows match', () => {
    const handled = handleRuntimeMessage({
      type: 'PRICE_UPDATED',
      appId: 999,
      priceData: makePriceData(),
    }, makeDeps());

    expect(handled).toBe(true);
    expect(replaceBadge).not.toHaveBeenCalled();
  });

  it('PRICE_UPDATED clears a stale workstation price when the new price is N/A', () => {
    const el = document.createElement('span');
    el.dataset.stptId = '1b';
    document.body.appendChild(el);

    rowData.push({ el, appId: '457', type: 'app', title: 'No Price', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['us'], currency: 'USD' };

    handleRuntimeMessage({
      type: 'PRICE_UPDATED',
      appId: 457,
      itemType: 'app',
      priceData: makePriceData(null, 'USD'),
    }, makeDeps());

    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('1b', { price: null });
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });

  it('SETTINGS_UPDATED with region change fetches fresh prices and rerenders on success', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = '2';
    document.body.appendChild(el);

    const row = { el, appId: '789', type: 'sub', title: 'Settings Test', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['eu'], currency: 'USD' };

    getDisplayRegion.mockImplementation(s => (s.regions?.[0] === 'us' ? 'us' : 'eu'));

    const priceData = makePriceData(399, 'USD');
    sendMessage.mockResolvedValue({ 'sub:789': { us: priceData } });
    readPriceRegion.mockReturnValue(priceData);

    const handled = handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'USD' },
    }, makeDeps());

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('GET_PRICES', expect.objectContaining({
      regions: ['us'],
    }));

    // Settle the fire-and-forget promise and assert rerender
    await vi.waitFor(() => {
      expect(replaceBadge).toHaveBeenCalledWith(el, expect.objectContaining({ prices: expect.any(Object) }), expect.any(Object));
      expect(updateSidebarRow).toHaveBeenCalledWith('2', expect.any(Object));
    });
  });

  it('SETTINGS_UPDATED with region change injects skeleton on GET_PRICES rejection', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = '2b';
    document.body.appendChild(el);

    const row = { el, appId: '790', type: 'app', title: 'Reject Region Test', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['eu'] };

    getDisplayRegion.mockImplementation(s => (s.regions?.[0] === 'us' ? 'us' : 'eu'));

    sendMessage.mockRejectedValue(new Error('fetch failed'));

    const handled = handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'] },
    }, makeDeps());

    expect(handled).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('GET_PRICES', expect.objectContaining({
      regions: ['us'],
    }));

    // Settle the rejected promise — must not emit unhandled rejection
    await vi.waitFor(() => {
      expect(injectSkeleton).toHaveBeenCalledWith(el, true);
    });
  });

  it('SETTINGS_UPDATED with unchanged region uses cached prices and rerenders on success', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = '3';
    document.body.appendChild(el);

    const row = { el, appId: '101', type: 'app', title: 'Cached Test', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['us'], currency: 'USD' };

    // Same region → unchanged
    getDisplayRegion.mockImplementation(() => 'us');

    const cachedPrices = { 'app:101': { us: makePriceData(249, 'USD') } };
    sendMessage.mockResolvedValue(cachedPrices);
    readPriceRegion.mockReturnValue(makePriceData(249, 'USD'));

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'USD' },
    }, makeDeps());

    expect(sendMessage).toHaveBeenCalledWith('GET_CACHED_PRICES', expect.objectContaining({
      regions: ['us'],
    }));

    // Wait for the fire-and-forget promise chain to settle
    await vi.waitFor(() => {
      expect(replaceBadge).toHaveBeenCalledWith(el, expect.objectContaining({ prices: expect.any(Object) }), expect.any(Object));
      expect(updateSidebarRow).toHaveBeenCalledWith('3', expect.any(Object));
    });
  });

  it('SETTINGS_UPDATED with unchanged region falls back to fresh prices when cache lookup rejects', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = '4';
    document.body.appendChild(el);

    const row = { el, appId: '202', type: 'app', title: 'Reject Test', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['us'] };

    getDisplayRegion.mockImplementation(() => 'us');

    const freshData = makePriceData(549, 'EUR');
    sendMessage
      .mockRejectedValueOnce(new Error('cache unavailable'))
      .mockResolvedValueOnce({ 'app:202': { us: freshData } });
    readPriceRegion.mockReturnValueOnce(freshData);

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'] },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('GET_PRICES', expect.any(Object));
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('4', expect.objectContaining({
        price: 549,
      }));
    });
    expect(injectSkeleton).not.toHaveBeenCalled();
  });

  it('SETTINGS_UPDATED with changed region updates workstation state after fresh pricing', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'r1';
    document.body.appendChild(el);

    const row = { el, appId: '901', type: 'app', title: 'Workstation R1', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['eu'], currency: 'EUR' };
    getDisplayRegion.mockImplementation(s => (s.regions?.[0] === 'us' ? 'us' : 'eu'));

    const priceData = makePriceData(599, 'USD');
    sendMessage.mockResolvedValue({ 'app:901': { us: priceData } });
    readPriceRegion.mockReturnValue(priceData);

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'USD' },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('r1', expect.objectContaining({
        price: 599, currency: 'USD',
      }));
      expect(workstation.updateGamePrices).toHaveBeenCalled();
    });
  });

  it('SETTINGS_UPDATED with unchanged region updates workstation from cached prices', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'r2';
    document.body.appendChild(el);

    const row = { el, appId: '301', type: 'app', title: 'Cached WS', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['us'], currency: 'EUR' };
    getDisplayRegion.mockImplementation(() => 'us');

    const cachedPrices = { 'app:301': { us: makePriceData(349, 'EUR') } };
    sendMessage.mockResolvedValue(cachedPrices);
    readPriceRegion.mockReturnValue(makePriceData(349, 'EUR'));

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'EUR' },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('r2', expect.objectContaining({
        price: 349, currency: 'EUR',
      }));
      expect(workstation.updateGamePrices).toHaveBeenCalled();
    });
  });

  it('SETTINGS_UPDATED clears a stale workstation price when cached price is N/A', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'r2b';
    document.body.appendChild(el);

    rowData.push({ el, appId: '302', type: 'app', title: 'Cached N/A', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['us'], currency: 'USD' };
    getDisplayRegion.mockImplementation(() => 'us');

    const priceData = makePriceData(null, 'USD');
    sendMessage.mockResolvedValue({ 'app:302': { us: priceData } });
    readPriceRegion.mockReturnValue(priceData);

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'USD' },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('r2b', { price: null });
    });
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });

  it('SETTINGS_UPDATED unchanged region cache miss falls back to GET_PRICES', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'r3';
    document.body.appendChild(el);

    const row = { el, appId: '501', type: 'app', title: 'Cache Miss', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['us'], currency: 'EUR' };
    getDisplayRegion.mockImplementation(() => 'us');

    // First call: GET_CACHED_PRICES returns empty (cache miss)
    // Second call: GET_PRICES returns real data
    const cachedPrices = {};
    const freshPrices = { 'app:501': { us: makePriceData(799, 'EUR') } };
    sendMessage
      .mockResolvedValueOnce(cachedPrices)
      .mockResolvedValueOnce(freshPrices);

    readPriceRegion
      .mockReturnValueOnce(null)        // cache miss
      .mockReturnValueOnce(makePriceData(799, 'EUR')); // fresh hit

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'EUR' },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('GET_CACHED_PRICES', expect.any(Object));
      expect(sendMessage).toHaveBeenCalledWith('GET_PRICES', expect.any(Object));
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('r3', expect.objectContaining({
        price: 799,
      }));
    });
  });

  it('SETTINGS_UPDATED unchanged region cache miss GET_PRICES fallback fails: skeleton', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'r4';
    document.body.appendChild(el);

    const row = { el, appId: '601', type: 'app', title: 'Double Fail', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['us'] };
    getDisplayRegion.mockImplementation(() => 'us');

    // First call: GET_CACHED_PRICES returns empty (cache miss)
    // Second call: GET_PRICES rejected
    sendMessage
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('fresh fetch failed'));

    readPriceRegion.mockReturnValueOnce(null); // cache miss

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'] },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(injectSkeleton).toHaveBeenCalledWith(el, true);
    });
  });

  it('SETTINGS_UPDATED cache rejection and fresh-price rejection injects skeleton', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'r5';
    document.body.appendChild(el);

    rowData.push({ el, appId: '602', type: 'app', title: 'Unavailable', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['us'] };
    getDisplayRegion.mockImplementation(() => 'us');

    sendMessage
      .mockRejectedValueOnce(new Error('cache unavailable'))
      .mockRejectedValueOnce(new Error('fresh fetch failed'));

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'] },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('GET_PRICES', expect.any(Object));
      expect(injectSkeleton).toHaveBeenCalledWith(el, true);
    });
  });

  it('SETTINGS_UPDATED fresh-price rejection removes stale badges and clears workstation', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 's1';
    // Attach multiple badges that should all be removed
    const primaryBadge = document.createElement('span');
    primaryBadge.className = 'stpt-badge';
    const secondaryBadge = document.createElement('span');
    secondaryBadge.className = 'stpt-badge';
    const skeleton = document.createElement('span');
    skeleton.className = 'stpt-skeleton';
    el.appendChild(primaryBadge);
    el.appendChild(secondaryBadge);
    el.appendChild(skeleton);
    document.body.appendChild(el);

    rowData.push({ el, appId: '701', type: 'app', title: 'Stale Row', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['eu'] };
    getDisplayRegion.mockImplementation(s => (s.regions?.[0] === 'us' ? 'us' : 'eu'));

    sendMessage.mockRejectedValue(new Error('fetch failed'));

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'] },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(el.querySelectorAll('.stpt-badge, .stpt-skeleton')).toHaveLength(0);
      expect(injectSkeleton).toHaveBeenCalledWith(el, true);
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('s1', { price: null });
    });
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });

  it('SETTINGS_UPDATED fresh-price empty data removes stale badge and clears workstation', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 's2';
    const oldBadge = document.createElement('span');
    oldBadge.className = 'stpt-badge';
    el.appendChild(oldBadge);
    document.body.appendChild(el);

    rowData.push({ el, appId: '702', type: 'app', title: 'Empty Data', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['eu'] };
    getDisplayRegion.mockImplementation(s => (s.regions?.[0] === 'us' ? 'us' : 'eu'));

    sendMessage.mockResolvedValue({}); // no regional data
    readPriceRegion.mockReturnValue(null);

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'] },
    }, makeDeps());

    await vi.waitFor(() => {
      expect(el.querySelector('.stpt-badge')).toBeNull();
      expect(injectSkeleton).toHaveBeenCalledWith(el, true);
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('s2', { price: null });
    });
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });

  it('stale request failure cannot clear state produced by a newer SETTINGS_UPDATED', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 's3';
    document.body.appendChild(el);

    rowData.push({ el, appId: '703', type: 'app', title: 'Race Row', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['us'] };
    getDisplayRegion.mockImplementation(s => s.regions?.[0] ?? 'us');

    // Deferred promise so we control resolution order
    let resolveStale;
    const stalePromise = new Promise(r => { resolveStale = r; });

    sendMessage.mockReturnValueOnce(stalePromise);

    // Dispatch SETTINGS_UPDATED #1 (region changes, revision = 1)
    const handled1 = handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['eu'] },
    }, makeDeps());

    expect(handled1).toBe(true);
    expect(settingsRef.revision).toBe(1);

    // Simulate a newer settings update arriving before #1's GET_PRICES resolves
    settingsRef.revision = 2;
    settingsRef.current = { apiKey: 'key', regions: ['uk'] };

    // Resolve the stale promise (returns valid-looking data)
    resolveStale({ 'app:703': { eu: makePriceData(199, 'EUR') } });
    readPriceRegion.mockReturnValue(makePriceData(199, 'EUR'));

    // Wait for the stale chain to settle
    await vi.waitFor(() => {
      // Stale guard prevents UI mutation: no replaceBadge, no injectSkeleton
      expect(replaceBadge).not.toHaveBeenCalled();
    });

    // The stale callback may have called readPriceRegion (sync, before guard),
    // but must not have called injectSkeleton or cleared the workstation
    expect(injectSkeleton).not.toHaveBeenCalled();
    expect(workstation.updateResolvedPageGame).not.toHaveBeenCalledWith('s3', { price: null });
  });

  it('overlapping SETTINGS_UPDATED applies only newest response (same region)', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = 's4';
    document.body.appendChild(el);

    rowData.push({ el, appId: '704', type: 'app', title: 'Overlap Row', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['us'] };
    getDisplayRegion.mockImplementation(() => 'us');

    // Deferred promise for the first update's GET_CACHED_PRICES
    let resolveOld;
    const oldPromise = new Promise(r => { resolveOld = r; });

    const newPriceData = makePriceData(777, 'EUR');
    sendMessage
      .mockReturnValueOnce(oldPromise)                                  // GET_CACHED_PRICES #1
      .mockResolvedValueOnce({ 'app:704': { us: newPriceData } });      // GET_CACHED_PRICES #2

    // Dispatch #1 (unchanged region, revision = 1, triggers GET_CACHED_PRICES)
    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'EUR' },
    }, makeDeps());

    expect(settingsRef.revision).toBe(1);

    // Dispatch #2 before #1 resolves (unchanged region, revision = 2)
    readPriceRegion.mockReturnValue(newPriceData);
    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'EUR' },
    }, makeDeps());

    expect(settingsRef.revision).toBe(2);

    // Wait for #2's GET_CACHED_PRICES to apply
    await vi.waitFor(() => {
      expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('s4', expect.objectContaining({
        price: 777,
      }));
    });

    // Clear mocks to capture only stale-pipeline activity
    replaceBadge.mockClear();
    updateSidebarRow.mockClear();
    workstation.updateResolvedPageGame.mockClear();
    workstation.updateGamePrices.mockClear();

    // Resolve the stale promise
    resolveOld({ 'app:704': { us: makePriceData(111, 'EUR') } });
    readPriceRegion.mockReturnValue(makePriceData(111, 'EUR'));

    // Stale guard prevents the old data from clobbering the newer state
    await vi.waitFor(() => {
      // Give microtasks time to settle — nothing should have been updated
      expect(replaceBadge).not.toHaveBeenCalled();
    });

    expect(workstation.updateResolvedPageGame).not.toHaveBeenCalledWith('s4', expect.objectContaining({ price: 111 }));
  });

  it('PRICE_UPDATED message for another region is ignored', () => {
    settingsRef.current = { apiKey: 'key', regions: ['us'] };
    getDisplayRegion.mockReturnValue('us');

    const el = document.createElement('span');
    el.dataset.stptId = 'p1';
    rowData.push({ el, appId: '801', type: 'app', title: 'Region Mismatch', cacheKey: null });

    const handled = handleRuntimeMessage({
      type: 'PRICE_UPDATED',
      appId: 801,
      itemType: 'app',
      region: 'eu',
      priceData: makePriceData(555, 'EUR'),
    }, makeDeps());

    expect(handled).toBe(true);
    expect(replaceBadge).not.toHaveBeenCalled();
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });

  it('PRICE_UPDATED message with matching region is applied', () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'p2';
    document.body.appendChild(el);

    rowData.push({ el, appId: '802', type: 'app', title: 'Region Match', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['us'] };
    getDisplayRegion.mockReturnValue('us');

    handleRuntimeMessage({
      type: 'PRICE_UPDATED',
      appId: 802,
      itemType: 'app',
      region: 'us',
      priceData: makePriceData(444, 'EUR'),
    }, makeDeps());

    expect(replaceBadge).toHaveBeenCalled();
    expect(workstation.updateGamePrices).toHaveBeenCalled();
  });

  it('PRICE_UPDATED message without region field remains compatible', () => {
    const el = document.createElement('span');
    el.dataset.stptId = 'p3';
    document.body.appendChild(el);

    rowData.push({ el, appId: '803', type: 'app', title: 'No Region', cacheKey: null });
    settingsRef.current = { apiKey: 'key', regions: ['us'] };
    getDisplayRegion.mockReturnValue('us');

    handleRuntimeMessage({
      type: 'PRICE_UPDATED',
      appId: 803,
      itemType: 'app',
      // no region field
      priceData: makePriceData(333, 'EUR'),
    }, makeDeps());

    expect(replaceBadge).toHaveBeenCalled();
    expect(workstation.updateGamePrices).toHaveBeenCalled();
  });

  it('returns false for unhandled message types', () => {
    const handled = handleRuntimeMessage({ type: 'UNKNOWN' }, makeDeps());
    expect(handled).toBe(false);
  });
});
