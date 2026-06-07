// content/content-handlers.js
// Testable event handlers for content-script events.
// Production listeners in content/content.js call these with real dependencies.

export async function handleManualResolution(e, deps) {
  const { rowData, workstation, sendMessage, replaceBadge, updateSidebarRow,
    injectSkeleton, applyResolvedRow, stripParentheses, getDisplayRegion, readPriceRegion,
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
  // Capture the current title as originalTitle before mutation.
  // Pass the full Steam title (not the stripped DOM version) for canonical storage.
  const row = rowData.find(r => r.el === rowEl);
  const currentTitle = row?.title ?? rowEl.dataset.stptTitle;
  applyResolvedRow(rowData, rowEl, {
    appId,
    type,
    title,
    originalTitle: currentTitle,
    cacheKey,
  });

  // Immediately remove any ambiguous/not-found badge and inject a loading skeleton
  rowEl.querySelectorAll('.stpt-badge, .stpt-skeleton').forEach(el => el.remove());
  injectSkeleton(rowEl, false);

  // Update workstation identity before awaiting settings/prices (omit price so
  // explicit-null semantics remain intact until pricing completes)
  if (workstation) {
    workstation.updateResolvedPageGame(rowEl.dataset.stptId, { title, appId, type, originalTitle: currentTitle, manuallyResolved: true });
  }

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
    const resolvedUpdate = { title, appId, type, price, originalTitle: row?.originalTitle, manuallyResolved: true };
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
    settingsRef.revision = (settingsRef.revision ?? 0) + 1;
    const myRev = settingsRef.revision;
    const newRegion = getDisplayRegion(message.settings);
    const regionChanged = oldRegion !== newRegion;

    rowData.forEach(row => {
      if (!row.appId) return;

      function applyPrice(priceData) {
        if (priceData) {
          // Stale guard — newer settings update may have landed
          if (settingsRef.revision !== myRev || getDisplayRegion(settingsRef.current) !== newRegion) return true;
          const gameInfo = { ...row, settings: message.settings };
          replaceBadge(row.el, priceData, gameInfo);
          updateSidebarRow(row.el.dataset.stptId, gameInfo);
          if (workstation) {
            const price = _getBadgePrice(priceData, message.settings);
            const resolvedUpdate = { price };
            if (price != null) {
              resolvedUpdate.currency = priceData.prices?.currency ?? message.settings.currency ?? 'EUR';
            }
            workstation.updateResolvedPageGame(row.el.dataset.stptId, resolvedUpdate);

            const priceMap = {};
            setWorkstationPrice(priceMap, row.appId, row.type, priceData, message.settings);
            if (Object.keys(priceMap).length > 0) workstation.updateGamePrices(priceMap);
          }
          return true;
        }
        return false;
      }

      function clearRowStalePrices() {
        // Stale guard — newer update may have already rendered valid state
        if (settingsRef.revision !== myRev || getDisplayRegion(settingsRef.current) !== newRegion) return;
        row.el.querySelectorAll('.stpt-badge, .stpt-skeleton').forEach(el => el.remove());
        if (workstation) {
          workstation.updateResolvedPageGame(row.el.dataset.stptId, { price: null });
        }
        injectSkeleton(row.el, true);
      }

      function fetchFreshPrice() {
        return sendMessage('GET_PRICES', { items: [priceItem(row)], regions: message.settings.regions }).then(prices => {
          const priceData = readPriceRegion(prices, row.appId, row.type, newRegion);
          if (!applyPrice(priceData)) {
            clearRowStalePrices();
          }
        }).catch(() => {
          clearRowStalePrices();
        });
      }

      if (regionChanged) {
        fetchFreshPrice();
      } else {
        sendMessage('GET_CACHED_PRICES', { items: [priceItem(row)], regions: message.settings.regions }).then(
          prices => {
            const priceData = readPriceRegion(prices, row.appId, row.type, newRegion);
            if (applyPrice(priceData)) return;
            return fetchFreshPrice();
          },
          () => fetchFreshPrice()
        ).catch(() => {
          clearRowStalePrices();
        });
      }
    });
    return true;
  }

  if (message.type === 'PRICE_UPDATED') {
    // Ignore messages whose region differs from the current display region.
    // Accept messages without a region field for backward compatibility.
    if (message.region && settingsRef.current) {
      if (message.region !== getDisplayRegion(settingsRef.current)) return true;
    }

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
        const resolvedUpdate = { price };
        if (price != null) {
          resolvedUpdate.currency = priceData.prices?.currency ?? settings?.currency ?? 'EUR';
        }
        workstation.updateResolvedPageGame(row.el.dataset.stptId, resolvedUpdate);

        const priceMap = {};
        setWorkstationPrice(priceMap, row.appId, row.type, priceData, settings);
        if (Object.keys(priceMap).length > 0) workstation.updateGamePrices(priceMap);
      }
    }
    return true;
  }

  return false;
}

export function bindManualResolutionListener(doc, deps) {
  const handler = (e) => {
    handleManualResolution(e, deps).catch(err => console.error('[STPT] stpt-resolve error:', err));
  };
  doc.addEventListener('stpt-resolve', handler);
  return handler;
}
