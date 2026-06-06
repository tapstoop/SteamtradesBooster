/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleManualResolution, handleRuntimeMessage } from '../content/content-handlers.js';

// Shared price-data factory
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
  let applyResolvedRow, stripParentheses, getDisplayRegion, readPriceRegion;
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
    applyResolvedRow = vi.fn((rd, el, r) => {
      const row = rd.find(x => x.el === el);
      if (row) {
        row.appId = r.appId;
        row.type = r.type ?? 'app';
        row.title = r.title;
        row.cacheKey = r.cacheKey ?? row.cacheKey;
        row.fuzzy = false;
        row.resolution = { status: 'resolved', appId: r.appId, type: r.type ?? 'app' };
      }
      return row ?? null;
    });
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

  it('no API key: updates rowData, workstation receives price:null, no price request sent', async () => {
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

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('GET_SETTINGS');
  });

  it('API key: fetches bundles/prices, updates rowData.inBundle, badge and sidebar rendered', async () => {
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

  it('missing API currency: falls back to settings.currency, then EUR', async () => {
    const el = makeRowEl({ stptId: '0', stptTitle: 'No Currency' });
    const entry = { el, appId: null, type: 'app', title: 'No Currency', cacheKey: null, fuzzy: true, tier: 4 };
    rowData.push(entry);

    sendMessage
      .mockResolvedValueOnce({ apiKey: 'key', regions: ['us'] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ 'app:555': { us: { prices: { currentRetail: 5.00 } } } });

    readPriceRegion.mockReturnValueOnce({ prices: { currentRetail: 5.00 } });

    await handleManualResolution(
      makeEvent(el, { appId: '555', title: 'No Currency', type: 'app' }),
      makeDeps()
    );

    expect(workstation.updateResolvedPageGame).toHaveBeenCalledWith('0', expect.objectContaining({
      currency: 'EUR',
    }));
  });

  it('no price data: sends price:null to workstation', async () => {
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
});

describe('handleRuntimeMessage', () => {
  let rowData, settingsRef, sendMessage, replaceBadge, updateSidebarRow;
  let injectSkeleton, getDisplayRegion, readPriceRegion, priceItem, normalizeSteamType;

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
  });

  function makeDeps() {
    return {
      rowData, settingsRef, sendMessage, replaceBadge, updateSidebarRow,
      injectSkeleton, getDisplayRegion, readPriceRegion, priceItem, normalizeSteamType,
    };
  }

  it('PRICE_UPDATED finds a row resolved without API key and rerenders it', () => {
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
      priceData: makePriceData(4.99, 'EUR'),
    }, makeDeps());

    expect(handled).toBe(true);
    expect(replaceBadge).toHaveBeenCalledWith(el, expect.objectContaining({ prices: expect.any(Object) }), expect.any(Object));
    expect(updateSidebarRow).toHaveBeenCalledWith('1', expect.any(Object));
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

  it('SETTINGS_UPDATED requests prices for a resolved row', async () => {
    const el = document.createElement('span');
    el.dataset.stptId = '2';
    document.body.appendChild(el);

    const row = { el, appId: '789', type: 'sub', title: 'Settings Test', cacheKey: null };
    rowData.push(row);

    // Old settings: region 'eu', new settings: region 'us' → change detected
    settingsRef.current = { apiKey: 'key', regions: ['eu'], currency: 'USD' };

    // Make getDisplayRegion return region from settings
    getDisplayRegion.mockImplementation(s => (s.regions?.[0] === 'us' ? 'us' : 'eu'));

    sendMessage.mockResolvedValue({ 'sub:789': { us: makePriceData(399, 'USD') } });

    const handled = handleRuntimeMessage({
      type: 'SETTINGS_UPDATED',
      settings: { apiKey: 'key', regions: ['us'], currency: 'USD' },
    }, makeDeps());

    expect(handled).toBe(true);
    // Region changed (eu → us), should fetch fresh prices via GET_PRICES
    expect(sendMessage).toHaveBeenCalledWith('GET_PRICES', expect.objectContaining({
      regions: ['us'],
    }));
  });

  it('returns false for unhandled message types', () => {
    const handled = handleRuntimeMessage({ type: 'UNKNOWN' }, makeDeps());
    expect(handled).toBe(false);
  });
});
