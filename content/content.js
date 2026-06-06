// content/content.js
import { parseGameRows, prioritize, injectCheckboxes, getSelectedTitles, stripParentheses } from './parser.js';
import { fuzzySetMatch, getDisplayRegion, normalizeSteamType, typedPriceKey } from '../utils/similarity.js';
import { TradeSimulator } from './trade-logic.js';
import {
  injectSkeleton, replaceBadge, injectQuestionBadge, injectFuzzyBadge, injectNotFoundBadge, injectDismissedBadge, injectDelistedBadge,
  SidebarWorkstation, updateSidebarRow, syncSidebarHeights, updateFetchButton, setSkeletonLoading
} from './ui.js';
import { applyResolvedRow } from './resolution-helpers.js';
import { handleManualResolution, handleRuntimeMessage } from './content-handlers.js';
import { _getBadgePrice, setWorkstationPrice } from './price-helpers.js';

let rowData = []; // Store row data for callback access
let currentSettings = null; // Module-level settings for PRICE_UPDATED and SETTINGS_UPDATED listeners
const settingsRef = { current: null }; // Mutable reference for runtime handler

(async function main() {
  let settings;
  try {
    settings = await sendMessage('GET_SETTINGS');
  } catch {
    console.warn('[STPT] Failed to get settings — aborting');
    return;
  }
  currentSettings = settings; // Store for PRICE_UPDATED / SETTINGS_UPDATED listeners
  settingsRef.current = settings; // Sync mutable ref for handler
  sendMessage('REPORT_PAGE_DIAGNOSTICS', { url: location.href }).catch(() => {});
  if (!settings.showSidebar && !settings.apiKey) return;

  let profile;
  try {
    profile = await sendMessage('GET_PROFILE');
  } catch {
    console.warn('[STPT] Failed to get profile — using empty defaults');
    profile = { wishlist: [], tradables: [] };
  }
  const rows = parseGameRows();
  if (rows.length === 0) return;

  const prioritized = prioritize(rows, profile.wishlist ?? [], profile.tradables ?? []);

  // Assign stable IDs to rows
  prioritized.forEach((row, i) => {
    row.el.dataset.stptId = String(i);
  });

  // Initialize Trade Simulation Workstation
  const tradeSimulator = new TradeSimulator(0.1);
  const workstation = new SidebarWorkstation(tradeSimulator);
  window.__stpt_workstation = workstation; // Make accessible for price updates

  // Inject skeletons for all games
  prioritized.forEach(row => {
    injectSkeleton(row.el, true); // static skeleton
  });

  // Resolve titles → App IDs
  const titles = prioritized.map(r => r.title);
  const resolutions = await sendMessage('RESOLVE_TITLES', { titles });

  // Build resolution map
  rowData = prioritized.map((row, i) => {
    const res = resolutions[i];
    // Include appId for resolved, hit, OR delisted (if user confirmed game before marking delisted)
    const appId = (res?.status === 'hit' || res?.status === 'resolved' || res?.status === 'delisted') ? res.appId : null;
    // Use confirmed title if available (from user selection or fuzzy match)
    const displayTitle = res?.title ?? row.title;
    // Keep DOM in sync: el.dataset.stptTitle is the single source of truth
    row.el.dataset.stptTitle = stripParentheses(displayTitle);
    return {
      ...row,
      title: displayTitle, // Update title to confirmed title
      resolution: res,
      appId,
      type: res?.type ?? 'app',
      fuzzy: res?.fuzzy ?? false,
      similarity: res?.similarity ?? null,
      cacheKey: res?.cacheKey ?? null,
    };
  });

  // Handle resolution statuses
  rowData.forEach(row => {
    const skeleton = row.el.querySelector('.stpt-skeleton');

    if (row.resolution?.status === 'dismissed') {
      // User previously dismissed this title
      if (skeleton) skeleton.remove();
      injectDismissedBadge(row.el, row.cacheKey, row.title);
      return;
    }

    if (row.resolution?.status === 'delisted') {
      // User marked this as a delisted game - may have appId for price
      if (skeleton) skeleton.remove();
      if (row.appId) {
        // Delisted game with confirmed appId - inject badge immediately with placeholder, update price async
        const gameInfo = { ...row, cacheKey: row.cacheKey, settings, inBundle: row.type === 'bundle', acqPrice: null, resolution: { status: 'delisted' } };
        injectDelistedBadge(row.el, row.cacheKey, row.title, null, gameInfo);
        // Fetch price in background (uses getPrices which handles Sub IDs)
        sendMessage('GET_PRICES', { items: [priceItem(row)], regions: settings.regions }).then(prices => {
          const priceData = readPriceRegion(prices, row.appId, row.type, getDisplayRegion(settings));
          if (priceData) {
            const badge = row.el.querySelector('.stpt-badge[data-type="delisted"]');
            if (badge) badge.remove();
            injectDelistedBadge(row.el, row.cacheKey, row.title, priceData, gameInfo);
          }
        });
      } else {
        injectDelistedBadge(row.el, row.cacheKey, row.title);
      }
      return;
    }

    if (row.resolution?.status === 'ambiguous') {
      if (skeleton) skeleton.remove();
      injectQuestionBadge(row.el, row.resolution.candidates, row.resolution.cacheKey);
      return;
    }

    if (row.resolution?.status === 'not-found') {
      if (skeleton) skeleton.remove();
      injectNotFoundBadge(row.el, row.resolution.cacheKey, row.title);
      return;
    }

    if (row.fuzzy && row.appId) {
      // Fuzzy match with confidence
      if (skeleton) skeleton.remove();
      injectFuzzyBadge(row.el, row.resolution);
    }
  });

  // QUICKFIX #3: Set up the floating fetch button for selective mode BEFORE checkbox init
  setupFloatingFetchButton();

  // Wire up the Sidebar Workstation BEFORE price fetching
  // so all updateGamePrices() calls operate on populated pageGames
  // Tier 1 = wishlist, Tier 2 = tradables (already calculated by prioritize())
  workstation.setPageGames(rowData.map(r => ({
    stptId: r.el.dataset.stptId,
    appId: r.appId,
    type: r.type,
    title: r.title,
    price: r.price,
    tier: r.tier,
    el: r.el,
    section: r.el.dataset.stptSection,
    inWishlist: r.tier === 1,
    inTradables: r.tier === 2,
    currency: settings.regions?.[0] || 'EUR',
  })));
  workstation.setWishlistGames(profile.wishlist ?? []);
  workstation.setTradableGames(profile.tradables ?? []);

  // Resolve "other tradables" names → appIds and fetch their prices
  const tradableNames = (profile.tradables ?? []).filter(t => typeof t === 'string' || t?.name).map(t => typeof t === 'string' ? t : t.name);
  if (tradableNames.length > 0 && settings.apiKey) {
    const tradableResolutions = await sendMessage('RESOLVE_TITLES', { titles: tradableNames });
    const tradableAppIds = tradableResolutions
      .filter(r => r?.status === 'hit' || r?.status === 'resolved')
      .map(r => ({ id: r.appId, type: r.type ?? 'app' }));

    if (tradableAppIds.length > 0) {
      const tradablePrices = await sendMessage('GET_CACHED_PRICES', {
        items: tradableAppIds,
        regions: settings.regions,
      });

      const tradablePriceMap = {};
      tradableResolutions.forEach((res, i) => {
        if (res?.appId && (res.status === 'hit' || res.status === 'resolved')) {
          const priceData = readPriceRegion(tradablePrices, res.appId, res.type ?? 'app', getDisplayRegion(settings));
          tradablePriceMap[tradableNames[i].toLowerCase()] = {
            appId: res.appId,
            price: priceData ? _getBadgePrice(priceData, settings) : null,
            currency: priceData?.prices?.currency ?? 'EUR',
          };
        }
      });

      workstation.updateTradablePrices(tradablePriceMap);
    }
  }

  // Render any prices already in cache (no API calls, just cache reads)
  // Exclude delisted rows - they already have their badge
  const resolvedRows = rowData.filter(r => r.appId && !r.fuzzy && r.resolution?.status !== 'delisted' && r.resolution?.status !== 'dismissed');
  const priceMap = {};
  if (resolvedRows.length > 0) {
    const cachedPrices = await sendMessage('GET_CACHED_PRICES', {
      items: resolvedRows.map(priceItem),
      regions: settings.regions,
    });
    const cachedBundles = await sendMessage('GET_BUNDLES', { appIds: resolvedRows.map(r => r.appId) });

    resolvedRows.forEach(row => {
      const priceData = readPriceRegion(cachedPrices, row.appId, row.type, getDisplayRegion(settings));
      if (priceData) {
        setWorkstationPrice(priceMap, row.appId, row.type, priceData, settings);
        // Persist inBundle on rowData so later handlers (PRICE_UPDATED, SETTINGS_UPDATED) have it
        row.inBundle = row.type === 'bundle' || !!(cachedBundles[row.appId]?.length);
        const gameInfo = {
          ...row,
          cacheKey: row.cacheKey,
          settings,
          acqPrice: null,
        };
        replaceBadge(row.el, priceData, gameInfo);
        updateSidebarRow(row.el.dataset.stptId, gameInfo);
      }
    });
    workstation.updateGamePrices(priceMap);
  }

  // Fetch acquisition prices for tier 2 tradables
  const tier2withPrice = rowData.filter(r => r.appId && r.tier === 2);
  for (const row of tier2withPrice) {
    const { price } = await sendMessage('GET_ACQ_PRICE', { appId: row.appId, itemType: row.type });
    if (price != null) row.acqPrice = price;
  }

  if (settings.selectiveFetch !== false) {
    // Selective mode (default): inject checkboxes for ALL games
    const needsCheckbox = rowData; // ALL detected games get a checkbox
    if (needsCheckbox.length > 0) {
      injectCheckboxes(needsCheckbox);

      // Checkbox changes update floating button (NOT auto-fetch)
      document.querySelectorAll('.stpt-game-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
          updateFetchButton();
          updateFloatingFetchButton();
        });
      });

      updateFetchButton();
      updateFloatingFetchButton();
    }
  } else {
    // Automatic mode: fetch tier 1-2 immediately, tier 4 via IntersectionObserver
    const tier12missing = rowData.filter(r =>
      r.appId && (r.tier === 1 || r.tier === 2) && r.el.querySelector('.stpt-skeleton') !== null
    );
    if (tier12missing.length > 0) {
      setSkeletonLoading(tier12missing.map(r => r.el));
      await fetchAndRender(tier12missing, settings);
    }

    const tier4 = rowData.filter(r => r.tier > 2);
    const tier4resolved = tier4.filter(r => r.appId && r.el.querySelector('.stpt-skeleton') !== null);
    if (tier4resolved.length > 0) {
      setupIntersectionObserver(tier4resolved, settings);
    }
  }

  syncSidebarHeights(rowData.map(r => ({ el: r.el, appId: r.el.dataset.stptId })));
})();

// ─── #3: Floating Fetch Button ──────────────────────
let floatingFetchBtn = null;

function setupFloatingFetchButton() {
  if (floatingFetchBtn) return;

  floatingFetchBtn = document.createElement('button');
  floatingFetchBtn.id = 'stpt-floating-fetch-btn';
  floatingFetchBtn.className = 'stpt-floating-fetch-btn';
  floatingFetchBtn.style.display = 'none';
  floatingFetchBtn.addEventListener('click', () => {
    if (floatingFetchBtn.dataset.resultType === 'error') {
      sendMessage('OPEN_POPUP_TAB', { tab: 'settings', focus: 'error-log' });
      return;
    }
    handleFetchSelected();
  });
  document.body.appendChild(floatingFetchBtn);
}

function updateFloatingFetchButton() {
  if (!floatingFetchBtn) return;
  const checkboxes = document.querySelectorAll('.stpt-game-checkbox:checked');
  const count = checkboxes.length;

  if (count > 0) {
    floatingFetchBtn.style.display = 'flex';
    floatingFetchBtn.textContent = `Fetch prices for ${count} game${count > 1 ? 's' : ''}`;
  } else {
    floatingFetchBtn.style.display = 'none';
  }
}

function showResultOnButton(message, type = 'success', autoHideDelay = 4000) {
  if (!floatingFetchBtn) return;

  // Show the button as a result message
  floatingFetchBtn.style.display = 'flex';
  floatingFetchBtn.textContent = type === 'error' ? `${message} See error logs` : message;
  floatingFetchBtn.disabled = type !== 'error';
  floatingFetchBtn.dataset.resultType = type;

  // Clear previous timeout if any
  if (floatingFetchBtn._resultTimeout) clearTimeout(floatingFetchBtn._resultTimeout);

  floatingFetchBtn._resultTimeout = setTimeout(() => {
    delete floatingFetchBtn.dataset.resultType;
    floatingFetchBtn.disabled = false;
    updateFloatingFetchButton(); // reverts to count or hides
  }, autoHideDelay);
}

async function handleFetchSelected() {
  const settings = currentSettings;
  if (!settings) return;

  const selectedTitles = getSelectedTitles();
  if (selectedTitles.length === 0) return;

  // Distinguish resolvable games (have appId) vs unresolved
  const selectedRows = rowData.filter(r =>
    selectedTitles.includes(r.title)
  );

  const resolvableRows = selectedRows.filter(r => r.appId);
  const unresolvedCount = selectedRows.length - resolvableRows.length;

  if (resolvableRows.length === 0) {
    // None of the selected games could be resolved
    const msg = unresolvedCount === 1
      ? 'This game could not be resolved. Please resolve it first.'
      : 'None of the selected games could be resolved.';
    showResultOnButton(msg, 'error');
    return;
  }

  // Disable button while fetching
  if (floatingFetchBtn) {
    floatingFetchBtn.disabled = true;
    floatingFetchBtn.textContent = 'Fetching…';
  }

  // Set skeletons to loading state
  setSkeletonLoading(resolvableRows.map(r => r.el));

  let fetchedCount = 0;
  let failedCount = 0;

  let hasError = false;
  try {
    const prices = await sendMessage('GET_PRICES', {
      items: resolvableRows.map(priceItem),
      regions: settings.regions,
    });

    // Also fetch bundles for these appIds
    const bundles = await sendMessage('GET_BUNDLES', {
      appIds: resolvableRows.map(r => r.appId),
    });

    const region = getDisplayRegion(settings);
    const priceMap = {};

    resolvableRows.forEach(row => {
      const priceData = readPriceRegion(prices, row.appId, row.type, region);
      row.inBundle = row.type === 'bundle' || !!(bundles[row.appId]?.length);

      const gameInfo = {
        ...row,
        settings,
        cacheKey: row.cacheKey,
        acqPrice: null,
      };

      if (priceData) {
        fetchedCount++;
        replaceBadge(row.el, priceData, gameInfo);
        updateSidebarRow(row.el.dataset.stptId, gameInfo);

        setWorkstationPrice(priceMap, row.appId, row.type, priceData, settings);

        // Uncheck the successfully fetched game
        const checkbox = document.querySelector(
          `.stpt-game-checkbox[data-stpt-title="${CSS.escape(row.title)}"]`
        );
        if (checkbox) checkbox.checked = false;
      } else {
        failedCount++;
        // Remove skeleton, show N/A
        const skel = row.el.querySelector('.stpt-skeleton');
        if (skel) skel.remove();
        replaceBadge(row.el, null, gameInfo);
        updateSidebarRow(row.el.dataset.stptId, gameInfo);
      }
    });

    if (Object.keys(priceMap).length > 0 && window.__stpt_workstation) {
      window.__stpt_workstation.updateGamePrices(priceMap);
    }
  } catch (err) {
    console.error('[STPT] Fetch selected error:', err);
    hasError = true;
    failedCount = resolvableRows.length;
    // Remove skeletons
    resolvableRows.forEach(row => {
      const skel = row.el.querySelector('.stpt-skeleton');
      if (skel) skel.remove();
    });
  } finally {
    // Re-enable button & update UI
    updateFetchButton();
    updateFloatingFetchButton();
  }

  // Show appropriate result on the floating button
  if (hasError) {
    showResultOnButton(
      `An error occurred while fetching prices. Please try again.`,
      'error'
    );
  } else if (unresolvedCount > 0 && fetchedCount === 0 && failedCount === 0) {
    showResultOnButton(
      `${unresolvedCount} game${unresolvedCount > 1 ? 's' : ''} could not be resolved.`,
      'error'
    );
  } else if (failedCount > 0 && fetchedCount === 0) {
    showResultOnButton(
      `Failed to fetch ${failedCount} game${failedCount > 1 ? 's' : ''}.`,
      'error'
    );
  } else if (failedCount > 0 && fetchedCount > 0) {
    const parts = [`Fetched ${fetchedCount} successfully`];
    if (failedCount > 0) parts.push(`${failedCount} couldn't be fetched`);
    if (unresolvedCount > 0) parts.push(`${unresolvedCount} couldn't be resolved`);
    showResultOnButton(parts.join(', ') + '.', 'warning');
  } else if (fetchedCount > 0 && unresolvedCount > 0) {
    showResultOnButton(
      `Fetched ${fetchedCount} successfully, ${unresolvedCount} couldn't be resolved.`,
      'warning'
    );
  } else if (fetchedCount > 0) {
    showResultOnButton(
      `Fetched ${fetchedCount} game${fetchedCount > 1 ? 's' : ''} successfully.`,
      'success'
    );
  }
}

async function fetchAndRender(rows, settings) {
  const appIds = [...new Set(rows.map(r => r.appId))];
  const prices = await sendMessage('GET_PRICES', {
    items: rows.map(priceItem),
    regions: settings.regions,
  });

  // Also fetch bundles for these appIds
  const bundles = await sendMessage('GET_BUNDLES', { appIds });

  // Fetch acquisition prices for tradables
  const acqPrices = {};
  for (const row of rows.filter(r => r.tier === 2)) {
    const { price } = await sendMessage('GET_ACQ_PRICE', { appId: row.appId, itemType: row.type });
    acqPrices[typedPriceKey(row.appId, row.type)] = price;
  }

  rows.forEach(row => {
    const priceData = readPriceRegion(prices, row.appId, row.type, getDisplayRegion(settings));
    // Persist inBundle on rowData so later handlers (PRICE_UPDATED, SETTINGS_UPDATED) have it
    row.inBundle = row.type === 'bundle' || !!(bundles[row.appId]?.length);
    const gameInfo = {
      ...row,
      settings,
      cacheKey: row.cacheKey,
      acqPrice: acqPrices[typedPriceKey(row.appId, row.type)] ?? null,
    };
    replaceBadge(row.el, priceData ?? null, gameInfo);
    updateSidebarRow(row.el.dataset.stptId, gameInfo);
  });

  // Update workstation with fetched prices
  const priceMap = {};
  rows.forEach(row => {
    const priceData = readPriceRegion(prices, row.appId, row.type, getDisplayRegion(settings));
    if (priceData) {
      setWorkstationPrice(priceMap, row.appId, row.type, priceData, settings);
    }
  });
  if (Object.keys(priceMap).length > 0 && window.__stpt_workstation) {
    window.__stpt_workstation.updateGamePrices(priceMap);
  }
}

function setupIntersectionObserver(rows, settings) {
  const pending = new Map(rows.map(r => [r.el, r]));
  const observer = new IntersectionObserver(entries => {
    const visible = entries
      .filter(e => e.isIntersecting)
      .map(e => pending.get(e.target))
      .filter(Boolean);

    if (visible.length === 0) return;

    // Unobserve ALL visible elements (including cached ones)
    visible.forEach(r => { observer.unobserve(r.el); pending.delete(r.el); });

    // Skip games that already have a price badge (already fetched)
    const uncached = visible.filter(r => r.el.querySelector('.stpt-skeleton') !== null);
    if (uncached.length === 0) return;

    // Set skeletons to loading and fetch
    setSkeletonLoading(uncached.map(r => r.el));
    for (let i = 0; i < uncached.length; i += 100) {
      fetchAndRender(uncached.slice(i, i + 100), settings);
    }
  }, { rootMargin: '200px' });

  rows.forEach(r => observer.observe(r.el));
}

// Listen for re-resolve events (user picked candidate)
document.addEventListener('stpt-resolve', e => {
  handleManualResolution(e, {
    rowData,
    workstation: window.__stpt_workstation,
    sendMessage,
    replaceBadge,
    updateSidebarRow,
    applyResolvedRow,
    stripParentheses,
    getDisplayRegion,
    readPriceRegion,
    _getBadgePrice,
    setWorkstationPrice,
  }).catch(err => console.error('[STPT] stpt-resolve error:', err));
});

// Listen for recheck events (user clicked dismissed badge)
document.addEventListener('stpt-recheck', async e => {
  const { title, cacheKey } = e.detail;
  const rowEl = e.target;

  // Re-resolve the title
  const resolutions = await sendMessage('RESOLVE_TITLES', { titles: [title] });
  const res = resolutions[0];

  // Remove existing badge/skeleton
  const existing = rowEl.querySelector('.stpt-skeleton, .stpt-badge');
  if (existing) existing.remove();

  if (!res) {
    injectNotFoundBadge(rowEl, cacheKey, title);
    return;
  }

  if (res.status === 'dismissed') {
    injectDismissedBadge(rowEl, res.cacheKey || cacheKey, title);
  } else if (res.status === 'delisted') {
    // Check if there's a confirmed appId for price display
    if (res.appId) {
      const settings = await sendMessage('GET_SETTINGS');
      if (settings.apiKey) {
        const priceData = await sendMessage('GET_PRICES', { items: [{ id: res.appId, type: res.type ?? 'app' }], regions: settings.regions });
        const gameInfo = { appId: res.appId, type: res.type ?? 'app', title, tier: 4, settings, cacheKey: res.cacheKey, inBundle: res.type === 'bundle', acqPrice: null };
        injectDelistedBadge(
          rowEl,
          res.cacheKey || cacheKey,
          title,
          readPriceRegion(priceData, res.appId, res.type ?? 'app', getDisplayRegion(settings)) ?? null,
          gameInfo
        );
      } else {
        injectDelistedBadge(rowEl, res.cacheKey || cacheKey, title);
      }
    } else {
      injectDelistedBadge(rowEl, res.cacheKey || cacheKey, title);
    }
  } else if (res.status === 'ambiguous') {
    injectQuestionBadge(rowEl, res.candidates, res.cacheKey);
  } else if (res.status === 'not-found') {
    injectNotFoundBadge(rowEl, res.cacheKey, title);
  } else if (res.fuzzy) {
    injectFuzzyBadge(rowEl, res);
    // Fetch price for fuzzy match
    const settings = await sendMessage('GET_SETTINGS');
    if (settings.apiKey) {
      const bundles = await sendMessage('GET_BUNDLES', { appIds: [res.appId] });
      const priceData = await sendMessage('GET_PRICES', { items: [{ id: res.appId, type: res.type ?? 'app' }], regions: settings.regions });
      // Find and persist inBundle on rowData
      const row = rowData.find(r => r.el === rowEl);
      if (row) {
        row.type = res.type ?? 'app';
        row.inBundle = row.type === 'bundle' || !!(bundles[res.appId]?.length);
      }
      const gameInfo = { appId: res.appId, type: res.type ?? 'app', title, tier: 4, settings, fuzzy: true, similarity: res.similarity, cacheKey: res.cacheKey, inBundle: res.type === 'bundle' || row?.inBundle };
      const pd = readPriceRegion(priceData, res.appId, res.type ?? 'app', getDisplayRegion(settings)) ?? null;
      replaceBadge(rowEl, pd, gameInfo);
      if (pd && window.__stpt_workstation) {
        const update = {};
        setWorkstationPrice(update, res.appId, res.type ?? 'app', pd, settings);
        if (Object.keys(update).length > 0) window.__stpt_workstation.updateGamePrices(update);
      }
    }
  } else {
    // Hit or resolved - fetch price
    const settings = await sendMessage('GET_SETTINGS');
    if (settings.apiKey) {
      const bundles = await sendMessage('GET_BUNDLES', { appIds: [res.appId] });
      const priceData = await sendMessage('GET_PRICES', { items: [{ id: res.appId, type: res.type ?? 'app' }], regions: settings.regions });
      // Find and persist inBundle on rowData
      const row = rowData.find(r => r.el === rowEl);
      if (row) {
        row.type = res.type ?? 'app';
        row.inBundle = row.type === 'bundle' || !!(bundles[res.appId]?.length);
      }
      const gameInfo = { appId: res.appId, type: res.type ?? 'app', title, tier: 4, settings, cacheKey: res.cacheKey, inBundle: res.type === 'bundle' || row?.inBundle };
      const pd = readPriceRegion(priceData, res.appId, res.type ?? 'app', getDisplayRegion(settings)) ?? null;
      replaceBadge(rowEl, pd, gameInfo);
      if (pd && window.__stpt_workstation) {
        const update = {};
        setWorkstationPrice(update, res.appId, res.type ?? 'app', pd, settings);
        if (Object.keys(update).length > 0) window.__stpt_workstation.updateGamePrices(update);
      }
    }
  }
});

// Listen for SETTINGS_UPDATED and PRICE_UPDATED — handled by testable module
chrome.runtime.onMessage.addListener((message) => {
  const handled = handleRuntimeMessage(message, {
    rowData,
    settingsRef,
    sendMessage,
    replaceBadge,
    updateSidebarRow,
    injectSkeleton,
    getDisplayRegion,
    readPriceRegion,
    priceItem,
    normalizeSteamType,
  });
  if (handled) {
    // Sync currentSettings back from the mutable ref
    currentSettings = settingsRef.current;
    return;
  }
});

function readPriceRegion(prices, appId, type = 'app', region) {
  if (!prices || !appId) return null;
  const normalizedType = normalizeSteamType(type);
  const typed = prices[typedPriceKey(appId, normalizedType)]?.[region];
  if (typed) return typed;
  return normalizedType === 'app' ? prices[String(appId)]?.[region] ?? null : null;
}

function sendMessage(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

function priceItem(row) {
  return { id: row.appId, type: row.type ?? row.resolution?.type ?? 'app' };
}
