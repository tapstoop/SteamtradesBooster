// content/content-handlers.js
// Testable event handlers for content-script events.
// Production listeners in content/content.js call these with real dependencies.

export async function handleManualResolution(e, deps) {
  const { rowData, workstation, sendMessage, replaceBadge, updateSidebarRow,
    applyResolvedRow, stripParentheses, getDisplayRegion, readPriceRegion,
    _getBadgePrice, setWorkstationPrice } = deps;

  const { appId, title, cacheKey } = e.detail;
  const type = e.detail.type ?? 'app';
  const rowEl = e.target;

  // Sync DOM attribute to resolved title
  rowEl.dataset.stptTitle = stripParentheses(title);

  // Sync checkbox data-stpt-title so getSelectedTitles() stays correct
  const cb = rowEl.previousElementSibling?.classList?.contains('stpt-game-checkbox')
    ? rowEl.previousElementSibling
    : rowEl.parentNode.querySelector('.stpt-game-checkbox');
  if (cb) cb.dataset.stptTitle = rowEl.dataset.stptTitle;

  // Apply the confirmed resolution before any async request — ensures rowData
  // is up to date even if subsequent requests fail.
  const row = applyResolvedRow(rowData, rowEl, {
    appId,
    type,
    title: rowEl.dataset.stptTitle,
    cacheKey,
  });

  // Fetch settings, bundles, and prices with individual recovery
  let settings;
  try {
    settings = await sendMessage('GET_SETTINGS');
  } catch {
    console.warn('[STPT] GET_SETTINGS failed during manual resolution — using empty settings');
    settings = {};
  }

  let bundles = {};
  let prices = {};

  if (settings.apiKey) {
    try {
      bundles = await sendMessage('GET_BUNDLES', { appIds: [appId] });
    } catch {
      console.warn('[STPT] GET_BUNDLES failed during manual resolution — using empty bundles');
    }

    try {
      prices = await sendMessage('GET_PRICES', { items: [{ id: appId, type }], regions: settings.regions ?? [] });
    } catch {
      console.warn('[STPT] GET_PRICES failed during manual resolution — using empty prices');
    }
  }

  // Persist inBundle on rowData
  if (row) {
    row.inBundle = type === 'bundle' || !!(bundles?.[appId]?.length);
  }

  const region = getDisplayRegion(settings);
  const priceData = readPriceRegion(prices, appId, type, region) ?? null;
  const gameInfo = {
    appId,
    type,
    title,
    el: rowEl,
    tier: row?.tier ?? 4,
    cacheKey: cacheKey ?? row?.cacheKey,
    settings,
    acqPrice: row?.acqPrice ?? null,
    inBundle: type === 'bundle' || row?.inBundle,
    resolution: { status: 'resolved', appId, type },
  };
  replaceBadge(rowEl, priceData, gameInfo);
  updateSidebarRow(rowEl.dataset.stptId, gameInfo);

  if (workstation) {
    const price = priceData ? _getBadgePrice(priceData, settings) : null;
    const resolvedUpdate = { title, appId, type, price };
    if (priceData) {
      resolvedUpdate.currency = priceData.prices?.currency ?? settings.currency ?? 'EUR';
    }
    workstation.updateResolvedPageGame(rowEl.dataset.stptId, resolvedUpdate);

    if (priceData) {
      const priceMap = {};
      setWorkstationPrice(priceMap, appId, type, priceData, settings);
      if (Object.keys(priceMap).length > 0) workstation.updateGamePrices(priceMap);
    }
  }
}

export function handleRuntimeMessage(message, deps) {
  const { rowData, settingsRef, sendMessage, replaceBadge, updateSidebarRow,
    injectSkeleton, getDisplayRegion, readPriceRegion, priceItem,
    workstation, _getBadgePrice, setWorkstationPrice } = deps;

  if (message.type === 'SETTINGS_UPDATED') {
    const oldRegion = settingsRef.current ? getDisplayRegion(settingsRef.current) : null;
    settingsRef.current = message.settings;
    const newRegion = getDisplayRegion(message.settings);
    const regionChanged = oldRegion !== newRegion;

    rowData.forEach(row => {
      if (!row.appId) return;
      const newSettings = message.settings;

      function applyPrice(priceData) {
        if (priceData) {
          const gameInfo = { ...row, settings: newSettings };
          replaceBadge(row.el, priceData, gameInfo);
          updateSidebarRow(row.el.dataset.stptId, gameInfo);
          if (workstation) {
            const price = _getBadgePrice(priceData, newSettings);
            const update = {};
            setWorkstationPrice(update, row.appId, row.type, priceData, newSettings);
            if (price != null) {
              workstation.updateResolvedPageGame(row.el.dataset.stptId, { price, currency: priceData.prices?.currency ?? newSettings.currency ?? 'EUR' });
              if (Object.keys(update).length > 0) workstation.updateGamePrices(update);
            }
          }
          return true;
        }
        return false;
      }

      if (regionChanged) {
        sendMessage('GET_PRICES', { items: [priceItem(row)], regions: newSettings.regions }).then(prices => {
          const priceData = readPriceRegion(prices, row.appId, row.type, newRegion);
          if (!applyPrice(priceData)) {
            injectSkeleton(row.el, true);
          }
        }).catch(() => {
          injectSkeleton(row.el, true);
        });
      } else {
        sendMessage('GET_CACHED_PRICES', { items: [priceItem(row)], regions: newSettings.regions }).then(prices => {
          const priceData = readPriceRegion(prices, row.appId, row.type, newRegion);
          if (applyPrice(priceData)) return;
          // Cache miss — fall back to GET_PRICES
          return sendMessage('GET_PRICES', { items: [priceItem(row)], regions: newSettings.regions }).then(freshPrices => {
            const freshData = readPriceRegion(freshPrices, row.appId, row.type, newRegion);
            if (!applyPrice(freshData)) {
              injectSkeleton(row.el, true);
            }
          });
        }).catch(() => {
          injectSkeleton(row.el, true);
        });
      }
    });
    return true;
  }

  if (message.type === 'PRICE_UPDATED') {
    const { itemId, appId, itemType, priceData } = message;
    const id = String(itemId ?? appId ?? '');
    const normalizeSteamType = deps.normalizeSteamType;
    const rows = itemType
      ? rowData.filter(r => String(r.appId) === id && normalizeSteamType(r.type) === normalizeSteamType(itemType))
      : rowData.filter(r => String(r.appId) === id);
    if (rows.length === 0 || !priceData) return true;
    for (const row of rows) {
      const settings = settingsRef.current ?? row.settings;
      const gameInfo = { ...row, settings };
      replaceBadge(row.el, priceData, gameInfo);
      updateSidebarRow(row.el.dataset.stptId, gameInfo);
      if (workstation) {
        const price = _getBadgePrice(priceData, settings);
        if (price != null) {
          workstation.updateResolvedPageGame(row.el.dataset.stptId, { price, currency: priceData.prices?.currency ?? settings.currency ?? 'EUR' });
        }
        const priceMap = {};
        setWorkstationPrice(priceMap, row.appId, row.type, priceData, settings);
        if (Object.keys(priceMap).length > 0) workstation.updateGamePrices(priceMap);
      }
    }
    return true;
  }

  return false;
}
