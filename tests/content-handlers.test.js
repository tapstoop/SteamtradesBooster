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
  let stripParentheses, getDisplayRegion, readPriceRegion;
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
      applyResolvedRow, stripParentheses, getDisplayRegion, readPriceRegion,
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

    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('7', {
      title: 'Resolved Game', appId: '456', type: 'bundle', price: null,
    });
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
    expect(replaceBadge).toHaveBeenCalled();
    expect(updateSidebarRow).toHaveBeenCalled();

    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('3', expect.objectContaining({
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

    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('10', expect.objectContaining({
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

    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('11', expect.objectContaining({
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

    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('5', expect.objectContaining({
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
    expect(replaceBadge).toHaveBeenCalled();
    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('20', expect.objectContaining({
      title: 'Settings Fail', appId: '555', type: 'app', price: null,
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
    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('21', expect.objectContaining({
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
    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('22', expect.objectContaining({
      price: null,
    }));
    expect(workstation.updateGamePrices).not.toHaveBeenCalled();
  });
});

describe('handleRuntimeMessage', () => {
  let rowData, settingsRef, sendMessage, replaceBadge, updateSidebarRow;
  let injectSkeleton, getDisplayRegion, readPriceRegion, priceItem, normalizeSteamType;
  let workstation, _getBadgePrice, setWorkstationPrice;

  beforeEach(() => {
    document.body.innerHTML = '';
    rowData = [];
    settingsRef = { current: null };
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
      priceMap[appId] = { price: priceData?.prices?.currentRetail ?? null, currency: 'EUR' };
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

  it('SETTINGS_UPDATED with unchanged region injects skeleton on GET_CACHED_PRICES rejection', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = '4';
    document.body.appendChild(el);

    const row = { el, appId: '202', type: 'app', title: 'Reject Test', cacheKey: null };
    rowData.push(row);

    settingsRef.current = { apiKey: 'key', regions: ['us'] };

    getDisplayRegion.mockImplementation(() => 'us');

    // Reset injectSkeleton mock for clean counting
    injectSkeleton.mockClear();

    sendMessage.mockRejectedValue(new Error('cache unavailable'));

    handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'] },
    }, makeDeps());

    // Fire-and-forget rejection now has a .catch() handler; settle it
    await vi.waitFor(() => {
      expect(injectSkeleton).toHaveBeenCalledWith(el, true);
    });
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

  it('returns false for unhandled message types', () => {
    const handled = handleRuntimeMessage({ type: 'UNKNOWN' }, makeDeps());
    expect(handled).toBe(false);
  });
});
