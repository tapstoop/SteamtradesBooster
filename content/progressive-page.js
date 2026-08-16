import { parseGameRows, prioritize, injectCheckboxes } from './parser.js';
import { getDisplayRegion, normalizeSteamType, normalizeTitle, typedPriceKey } from '../utils/similarity.js';
import { TradeSimulator } from './trade-logic.js';
import {
  injectSkeleton, replaceBadge, injectQuestionBadge, injectFuzzyBadge, injectNotFoundBadge,
  injectDismissedBadge, injectRateLimitedBadge, SidebarWorkstation, setSkeletonLoading,
} from './ui.js';
import { applyResolvedRow } from './resolution-helpers.js';
import { handleRuntimeMessage, bindManualResolutionListener } from './content-handlers.js';
import { _getBadgePrice, setWorkstationPrice } from './price-helpers.js';
import { isPageExcluded } from '../utils/excluded-pages.js';
import { ProgressiveResolutionCoordinator } from './progressive-resolution.js';
import { sameRemoval } from '../utils/removal-status.js';

function sendMessage(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...data }, response => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function createId(prefix) {
  try { return `${prefix}-${crypto.randomUUID()}`; } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function readPriceRegion(prices, appId, type = 'app', region) {
  if (!prices || !appId) return null;
  const normalizedType = normalizeSteamType(type);
  const typed = prices[typedPriceKey(appId, normalizedType)]?.[region];
  return typed ?? (normalizedType === 'app' ? prices[String(appId)]?.[region] ?? null : null);
}

function readGgDealsNoData(prices, appId, type = 'app', region) {
  return Boolean(prices?._meta?.noData?.[`${normalizeSteamType(type)}:${String(appId)}`]?.[region]);
}

function priceItem(row) {
  return { id: row.appId, type: row.type ?? row.resolution?.type ?? 'app' };
}

function canPrice(resolution) {
  return !!resolution?.appId
    && ['hit', 'resolved'].includes(resolution.status)
    && !resolution.fuzzy;
}

export function toWorkstationGame(row, settings = {}) {
  const resolution = row.resolution ?? null;
  return {
    stptId: row.el.dataset.stptId,
    el: row.el,
    appId: row.appId,
    type: row.type,
    title: row.title,
    originalTitle: row.originalTitle,
    manuallyResolved: row.manuallyResolved ?? false,
    price: row.priceData ? _getBadgePrice(row.priceData, settings) : null,
    tier: row.tier,
    section: row.section ?? row.el.dataset.stptSection,
    inWishlist: row.inWishlist ?? row.tier === 1,
    inTradables: row.inTradables ?? row.tier === 2,
    currency: row.priceData?.prices?.currency ?? settings.currency ?? 'EUR',
    resolutionStatus: row.resolutionStatus ?? 'pending',
    resolution,
    cacheKey: row.cacheKey ?? resolution?.cacheKey ?? null,
    candidates: resolution?.candidates ?? [],
    fuzzy: row.fuzzy === true,
    similarity: row.similarity ?? resolution?.similarity ?? null,
    removalStatus: row.removal?.status ?? null,
    ggDealsNoData: row.ggDealsNoData === true,
  };
}

function syncWorkstationRows(state, run, rows) {
  if (!state.workstation) return;
  const uniqueRows = new Map();
  for (const row of rows ?? []) {
    const stptId = row?.el?.dataset?.stptId;
    if (stptId != null) uniqueRows.set(String(stptId), row);
  }
  if (uniqueRows.size === 0) return;
  const settings = run?.settings ?? state.settingsRef?.current ?? {};
  state.workstation.updateResolvedPageGames([...uniqueRows.values()].map(row => ({
    stptId: row.el.dataset.stptId,
    update: toWorkstationGame(row, settings),
  })));
}

function createWorkstationBridge(state) {
  return {
    updateResolvedPageGame: (...args) => state.workstation?.updateResolvedPageGame(...args),
    updateGamePrices: (...args) => state.workstation?.updateGamePrices(...args),
  };
}

function ensureWorkstation(state, settings = state.settingsRef?.current ?? {}) {
  if (!state.workstation) {
    state.workstation = new SidebarWorkstation(new TradeSimulator(0.1));
    window.__stpt_workstation = state.workstation;
    state.workstation.setPageGames(state.rows.map(row => toWorkstationGame(row, settings)));
    state.workstation.setTradableGames(state.run?.tradables ?? []);
  }
  state.workstation.show();
  return state.workstation;
}

function applyWorkstationVisibility(state, settings) {
  if (settings?.showSidebar === false) {
    state.workstation?.hide();
    return;
  }
  ensureWorkstation(state, settings);
}

function isCurrent(state, run) {
  return state.run === run && !run.cancelled;
}

function applyResolution(row, resolution) {
  if (!row?.el?.isConnected) return;
  const status = resolution?.status ?? 'not-found';
  row.rowRevision = (row.rowRevision ?? 0) + 1;
  row.title = resolution?.title ?? row.title;
  row.appId = canPrice(resolution) ? String(resolution.appId) : null;
  row.type = resolution?.type ?? row.type ?? 'app';
  row.cacheKey = resolution?.cacheKey ?? row.cacheKey;
  row.fuzzy = !!resolution?.fuzzy;
  row.similarity = resolution?.similarity ?? null;
  row.resolution = resolution;
  row.removal = resolution?.removal ?? null;
  row.resolutionStatus = status === 'not-found' && resolution?.failed ? 'failed' : status;
  row.el.dataset.stptTitle = row.title;

  const checkbox = row.el.previousElementSibling?.classList?.contains('stpt-game-checkbox')
    ? row.el.previousElementSibling
    : row.el.parentNode?.querySelector?.('.stpt-game-checkbox');
  if (checkbox) checkbox.dataset.stptTitle = row.title;

  if (status === 'dismissed') injectDismissedBadge(row.el, row.cacheKey, row.title);
  else if (status === 'ambiguous') injectQuestionBadge(row.el, resolution.candidates, row.cacheKey);
  else if (status === 'not-found') injectNotFoundBadge(row.el, row.cacheKey, row.title);
  else if (row.fuzzy) injectFuzzyBadge(row.el, resolution);
}

function trackerPickerCandidates(match) {
  return (match?.candidates ?? []).map(candidate => ({
    id: candidate.appId,
    name: candidate.title,
    type: 'app',
    removalStatus: candidate.removal?.status ?? null,
  }));
}

function renderTrackerOnlyRow(state, run, row) {
  replaceBadge(row.el, row.priceData, {
    ...row,
    settings: run.settings,
    cacheKey: row.cacheKey,
    acqPrice: row.acqPrice ?? null,
  });
}

function applyTrackerMatch(state, run, row, match) {
  if (!match || !isCurrent(state, run) || !row.el?.isConnected) return false;
  if (row.resolution?.confirmed || row.resolution?.status === 'dismissed') return false;
  row.trackerFuzzy = match.kind === 'fuzzy' ? match : null;
  if (match.kind === 'fuzzy') return false;

  const existingAppId = row.appId ? String(row.appId) : null;
  const candidates = match.candidates ?? [];
  if (existingAppId) {
    const same = candidates.find(candidate => String(candidate.appId) === existingAppId);
    if (same) {
      row.removal = same.removal;
      renderTrackerOnlyRow(state, run, row);
      return true;
    }
    applyResolution(row, {
      status: 'ambiguous',
      candidates: trackerPickerCandidates(match),
      cacheKey: `resolve:${normalizeTitle(row.originalTitle)}`,
      source: 'provider-conflict',
    });
    return true;
  }

  if (match.kind === 'resolved') {
    applyResolution(row, {
      status: 'resolved',
      appId: match.appId,
      type: 'app',
      title: match.title ?? row.title,
      removal: match.removal,
      cacheKey: `resolve:${normalizeTitle(row.originalTitle)}`,
      source: 'steam-tracker',
    });
    renderTrackerOnlyRow(state, run, row);
    return true;
  }

  if (match.kind === 'status-only') {
    row.rowRevision = (row.rowRevision ?? 0) + 1;
    row.resolutionStatus = 'resolved';
    row.resolution = {
      status: 'removed-unresolved',
      source: 'steam-tracker',
      candidates: trackerPickerCandidates(match),
    };
    row.removal = match.removal;
    renderTrackerOnlyRow(state, run, row);
    return true;
  }

  if (match.kind === 'ambiguous') {
    applyResolution(row, {
      status: 'ambiguous',
      candidates: trackerPickerCandidates(match),
      cacheKey: `resolve:${normalizeTitle(row.originalTitle)}`,
      source: 'steam-tracker',
    });
    return true;
  }
  return false;
}

function applySteamResolution(state, run, row, resolution) {
  const trackerResolution = row.resolution?.source === 'steam-tracker' ? row.resolution : null;
  if (!trackerResolution) {
    if (resolution?.status === 'not-found' && row.trackerFuzzy) {
      applyResolution(row, {
        status: 'ambiguous',
        candidates: trackerPickerCandidates(row.trackerFuzzy),
        cacheKey: `resolve:${normalizeTitle(row.originalTitle)}`,
        source: 'steam-tracker-fuzzy',
      });
      return;
    }
    applyResolution(row, resolution);
    return;
  }
  if (!resolution?.appId || resolution.status === 'not-found') return;
  const sameCandidate = trackerResolution.candidates?.find(candidate => String(candidate.id) === String(resolution.appId));
  if (String(trackerResolution.appId ?? '') === String(resolution.appId) || sameCandidate) {
    applyResolution(row, { ...resolution, removal: row.removal });
    return;
  }
  applyResolution(row, {
    status: 'ambiguous',
    candidates: [
      { id: String(resolution.appId), name: resolution.title ?? row.title, type: resolution.type ?? 'app' },
      ...(trackerResolution.candidates ?? []),
    ],
    cacheKey: resolution.cacheKey ?? `resolve:${normalizeTitle(row.originalTitle)}`,
    source: 'provider-conflict',
  });
}

async function reconcileRemovalTitleMatches(state, run, rows = state.rows, { includeFuzzy = true, authoritative = false } = {}) {
  if (!isCurrent(state, run) || rows.length === 0) return [];
  const response = await sendMessage('GET_REMOVAL_MATCHES', {
    items: rows.map(row => ({
      title: row.originalTitle,
      linkedAppId: row.linkedType === 'app' ? row.linkedAppId : null,
    })),
    includeFuzzy,
  }).catch(() => null);
  if (!response || !isCurrent(state, run)) return [];
  const hydrated = [];
  const invalidated = [];
  rows.forEach((row, index) => {
    const match = response.matches?.[index];
    if (applyTrackerMatch(state, run, row, match)) {
      hydrated.push(row);
    } else if (authoritative && response.hasCache && !match && row.resolution?.source === 'steam-tracker') {
      row.rowRevision = (row.rowRevision ?? 0) + 1;
      row.appId = null;
      row.type = 'app';
      row.removal = null;
      row.priceData = null;
      row.ggDealsNoData = false;
      row.resolution = { status: 'pending' };
      row.el.querySelectorAll('.stpt-badge, .stpt-skeleton').forEach(el => el.remove());
      injectSkeleton(row.el, false);
      invalidated.push(row);
    }
  });
  if (invalidated.length) {
    run.coordinator?.invalidate(invalidated);
    syncWorkstationRows(state, run, invalidated);
    run.coordinator?.enqueue(invalidated, { priority: true });
  }
  if (hydrated.length) syncWorkstationRows(state, run, hydrated);
  return hydrated;
}

async function reconcileRemovalRows(state, run, rows = state.rows) {
  if (!isCurrent(state, run)) return;
  const candidates = rows
    .filter(row => row?.appId && normalizeSteamType(row.type) === 'app' && !row.fuzzy)
    .map(row => {
      const removalLookupRevision = (row.removalLookupRevision ?? 0) + 1;
      row.removalLookupRevision = removalLookupRevision;
      return {
        row,
        appId: String(row.appId),
        rowRevision: row.rowRevision,
        removalLookupRevision,
      };
    });
  if (candidates.length === 0) return;
  const uniqueItems = [...new Map(candidates.map(item => [`app:${item.appId}`, { id: item.appId, type: 'app' }])).values()];
  const response = await sendMessage('GET_REMOVAL_STATUSES', { items: uniqueItems }).catch(() => null);
  if (!response || !isCurrent(state, run)) return;

  const changedRows = [];
  for (const candidate of candidates) {
    const { row, appId, rowRevision, removalLookupRevision } = candidate;
    if (!row.el?.isConnected || row.rowRevision !== rowRevision) continue;
    if (row.removalLookupRevision !== removalLookupRevision) continue;
    if (String(row.appId) !== appId || normalizeSteamType(row.type) !== 'app') continue;
    const nextRemoval = response.statuses?.[`app:${appId}`] ?? null;
    if (sameRemoval(row.removal, nextRemoval)) continue;
    row.removal = nextRemoval;
    replaceBadge(row.el, row.priceData, {
      ...row,
      settings: run.settings,
      cacheKey: row.cacheKey,
      acqPrice: row.acqPrice ?? null,
    });
    changedRows.push(row);
  }
  syncWorkstationRows(state, run, changedRows);
}

async function hydratePriceBatch(state, run, items) {
  if (!isCurrent(state, run)) return;
  const rows = items.map(item => item.row).filter(row => canPrice(row.resolution));
  if (rows.length === 0) return;
  const itemsByKey = new Map(rows.map(row => [`${row.type}:${row.appId}`, priceItem(row)]));
  const [cachedPrices, bundles] = await Promise.all([
    sendMessage('GET_CACHED_PRICES', { items: [...itemsByKey.values()], regions: run.settings.regions }).catch(() => ({})),
    run.settings.apiKey && run.settings.selectiveFetch === false
      ? sendMessage('GET_BUNDLES', {
        appIds: [...new Set(rows.map(row => row.appId))],
        fetchIntent: 'automatic',
      }).catch(() => ({}))
      : Promise.resolve({}),
  ]);
  if (!isCurrent(state, run)) return;

  for (const row of rows) {
    const displayRegion = getDisplayRegion(run.settings);
    const priceData = readPriceRegion(cachedPrices, row.appId, row.type, displayRegion);
    row.ggDealsNoData = readGgDealsNoData(cachedPrices, row.appId, row.type, displayRegion);
    row.inBundle = row.type === 'bundle' || !!bundles?.[row.appId]?.length;
    if (priceData) {
      row.priceData = priceData;
      const gameInfo = { ...row, settings: run.settings, cacheKey: row.cacheKey, acqPrice: row.acqPrice ?? null };
      replaceBadge(row.el, priceData, gameInfo);
    } else if (row.removal) {
      replaceBadge(row.el, row.priceData, {
        ...row,
        settings: run.settings,
        cacheKey: row.cacheKey,
        acqPrice: row.acqPrice ?? null,
      });
    }
  }
  syncWorkstationRows(state, run, rows);

  if (run.settings.selectiveFetch === false) {
    const missingTierPrices = rows.filter(row => row.tier <= 2 && !row.priceData && row.el.querySelector('.stpt-skeleton'));
    if (missingTierPrices.length) fetchRemotePrices(state, run, missingTierPrices).catch(() => {});
    scheduleTier4Prices(state, run, rows.filter(row => row.tier > 2 && !row.priceData && row.el.querySelector('.stpt-skeleton')));
  }
}

async function fetchRemotePrices(state, run, rows, fetchIntent = 'automatic') {
  if (!isCurrent(state, run) || rows.length === 0) return { completedRows: [], failedRows: rows };
  setSkeletonLoading(rows.map(row => row.el));
  const [prices, bundles, acquisitionEntries] = await Promise.all([
    sendMessage('GET_PRICES', {
      items: rows.map(priceItem),
      regions: run.settings.regions,
      fetchIntent,
    }),
    sendMessage('GET_BUNDLES', {
      appIds: [...new Set(rows.map(row => row.appId))],
      fetchIntent,
    }).catch(() => ({})),
    Promise.all(rows.filter(row => row.tier === 2).map(async row => [
      `${row.type}:${row.appId}`,
      await sendMessage('GET_ACQ_PRICE', { appId: row.appId, itemType: row.type }).then(result => result?.price ?? null).catch(() => null),
    ])),
  ]);
  if (!isCurrent(state, run)) return { completedRows: [], failedRows: rows, stale: true };
  const acquisitionPrices = Object.fromEntries(acquisitionEntries);
  const completedRows = [];
  const failedRows = [];
  const skippedKeys = new Set((prices?._meta?.skipped ?? []).map(item => `${item.type ?? 'app'}:${item.id}`));
  for (const row of rows) {
    const displayRegion = getDisplayRegion(run.settings);
    const priceData = readPriceRegion(prices, row.appId, row.type, displayRegion);
    row.inBundle = row.type === 'bundle' || !!bundles?.[row.appId]?.length;
    row.priceData = priceData ?? null;
    row.ggDealsNoData = readGgDealsNoData(prices, row.appId, row.type, displayRegion);
    row.acqPrice = acquisitionPrices[`${row.type}:${row.appId}`] ?? row.acqPrice ?? null;
    replaceBadge(row.el, row.priceData, { ...row, settings: run.settings, cacheKey: row.cacheKey, acqPrice: row.acqPrice });
    if (!skippedKeys.has(`${row.type}:${row.appId}`) && (priceData || row.ggDealsNoData)) completedRows.push(row);
    else failedRows.push(row);
  }
  syncWorkstationRows(state, run, rows);
  return { completedRows, failedRows, partialError: prices?.error ?? null };
}

function scheduleTier4Prices(state, run, rows) {
  if (!isCurrent(state, run) || rows.length === 0) return;
  if (typeof IntersectionObserver === 'undefined') {
    fetchRemotePrices(state, run, rows).catch(() => {});
    return;
  }
  if (!run.priceObserver) {
    run.priceObserver = new IntersectionObserver(entries => {
      if (!isCurrent(state, run)) return;
      const visible = entries.filter(entry => entry.isIntersecting).map(entry => entry.target.__stptPriceRow).filter(Boolean);
      visible.forEach(row => run.priceObserver.unobserve(row.el));
      fetchRemotePrices(state, run, visible).catch(() => {});
    }, { rootMargin: '200px' });
  }
  rows.forEach(row => {
    row.el.__stptPriceRow = row;
    run.priceObserver.observe(row.el);
  });
}

function reconcileTiers(state, run, { authoritativeWishlist, authoritativeTradables }) {
  if (!isCurrent(state, run)) return;
  const tiered = prioritize(state.rows.map(row => ({ ...row, title: row.originalTitle })), [...run.wishlist], run.tradables);
  const changedRows = [];
  const promoted = [];
  tiered.forEach((next, index) => {
    const row = state.rows[index];
    const oldTier = row.tier;
    const inWishlist = authoritativeWishlist
      ? next.inWishlist
      : Boolean(row.inWishlist || next.inWishlist);
    const inTradables = authoritativeTradables
      ? next.inTradables
      : Boolean(row.inTradables || next.inTradables);
    const tier = inWishlist ? 1 : inTradables ? 2 : 4;
    if (oldTier === tier && row.inWishlist === inWishlist && row.inTradables === inTradables) return;
    row.tier = tier;
    row.inWishlist = inWishlist;
    row.inTradables = inTradables;
    if (row.priceData && !row.fuzzy) {
      replaceBadge(row.el, row.priceData, { ...row, settings: run.settings, cacheKey: row.cacheKey });
    }
    changedRows.push(row);
    if (row.resolutionStatus === 'pending' && row.tier <= 2) promoted.push(row);
  });
  syncWorkstationRows(state, run, changedRows);
  if (promoted.length) run.coordinator?.enqueue(promoted, { priority: true });
}

function setupResolutionObserver(state, run) {
  if (typeof IntersectionObserver === 'undefined') return;
  run.observer = new IntersectionObserver(entries => {
    if (!isCurrent(state, run)) return;
    const visible = entries.filter(entry => entry.isIntersecting).map(entry => entry.target.__stptProgressiveRow).filter(Boolean);
    visible.forEach(row => run.observer.unobserve(row.el));
    run.coordinator.enqueue(visible);
  }, { rootMargin: '200px' });
  state.rows.filter(row => row.resolutionStatus === 'pending' && row.tier > 2).forEach(row => {
    row.el.__stptProgressiveRow = row;
    run.observer.observe(row.el);
  });
}

async function beginRun(state, settings) {
  state.run?.coordinator?.cancel();
  state.run?.observer?.disconnect();
  state.run?.priceObserver?.disconnect();
  if (state.run) state.run.cancelled = true;
  const run = {
    sequence: (state.run?.sequence ?? 0) + 1,
    pageSessionId: createId('resolution-session'),
    profileRequestId: createId('profile'),
    profileGeneration: null,
    cancelled: false,
    settings,
    wishlist: new Set(),
    tradables: [],
    coordinator: null,
    observer: null,
    priceObserver: null,
  };
  state.run = run;
  sendMessage('ENSURE_STEAM_TRACKER_DATA').catch(() => {});
  const profilePromise = sendMessage('GET_PROFILE', { requestId: run.profileRequestId });
  await sendMessage('BEGIN_RESOLUTION_SESSION', {
    resolutionSessionId: run.pageSessionId,
    url: location.href,
    totalRows: state.rows.length,
  }).catch(() => {});

  const [cachedProfile, tradablesRead, cachedStates, trackerMatches] = await Promise.all([
    sendMessage('GET_CACHED_PROFILE').catch(() => ({ wishlist: [], partialWishlist: [] })),
    sendMessage('GET_TRADABLES').catch(() => ({ storageError: true, tradables: [] })),
    sendMessage('GET_CACHED_RESOLUTION_STATES', { titles: state.rows.map(row => row.originalTitle) }).catch(() => []),
    sendMessage('GET_REMOVAL_MATCHES', {
      items: state.rows.map(row => ({
        title: row.originalTitle,
        linkedAppId: row.linkedType === 'app' ? row.linkedAppId : null,
      })),
    }).catch(() => ({ matches: [] })),
  ]);
  if (!isCurrent(state, run)) return;
  for (const item of [...(cachedProfile?.wishlist ?? []), ...(cachedProfile?.partialWishlist ?? [])]) {
    const title = String(typeof item === 'string' ? item : item?.name ?? '').trim();
    if (title) run.wishlist.add(title);
  }
  if (!tradablesRead?.storageError) run.tradables = tradablesRead?.tradables ?? [];
  reconcileTiers(state, run, { authoritativeWishlist: false, authoritativeTradables: !tradablesRead?.storageError });
  state.workstation?.setTradableGames(run.tradables);

  run.coordinator = new ProgressiveResolutionCoordinator({
    rows: state.rows,
    resolveTitles: (titles, meta) => sendMessage('RESOLVE_TITLES', {
      titles,
      resolutionSessionId: run.pageSessionId,
      resolutionBatchId: meta.batchId,
      rowMultiplicities: meta.rowMultiplicities,
    }),
    onResolved: (row, resolution) => applySteamResolution(state, run, row, resolution),
    onBatchResolved: items => {
      syncWorkstationRows(state, run, items.map(item => item.row));
      return Promise.all([
        hydratePriceBatch(state, run, items),
        reconcileRemovalRows(state, run, items.map(item => item.row)),
      ]);
    },
  });

  const hydrated = state.rows
    .filter(row => canPrice(row.resolution))
    .map(row => ({ row, resolution: row.resolution }));
  (Array.isArray(cachedStates) ? cachedStates : []).forEach((resolution, index) => {
    if (!resolution || !state.rows[index]) return;
    const row = state.rows[index];
    if (canPrice(row.resolution)) return;
    applyResolution(row, resolution);
    hydrated.push({ row, resolution });
  });
  state.rows.forEach((row, index) => {
    if (applyTrackerMatch(state, run, row, trackerMatches?.matches?.[index])) {
      hydrated.push({ row, resolution: row.resolution });
    }
  });
  run.coordinator.markHydrated(hydrated.map(item => item.row));
  if (hydrated.length) {
    syncWorkstationRows(state, run, hydrated.map(item => item.row));
    await Promise.all([
      hydratePriceBatch(state, run, hydrated),
      reconcileRemovalRows(state, run, hydrated.map(item => item.row)),
    ]);
  }
  if (!isCurrent(state, run)) return;

  run.coordinator.enqueue(state.rows.filter(row => row.resolutionStatus === 'pending' && row.tier <= 2), { priority: true });
  setupResolutionObserver(state, run);
  if (settings.selectiveFetch === false) run.coordinator.enqueue(state.rows.filter(row => row.resolutionStatus === 'pending'));

  profilePromise.then(profile => {
    if (!isCurrent(state, run) || profile?.storageError) return;
    if (profile?.profileGeneration != null) run.profileGeneration = profile.profileGeneration;
    if (profile?.profileComplete) {
      run.wishlist = new Set((profile.wishlist ?? []).map(item => String(typeof item === 'string' ? item : item?.name ?? '').trim()).filter(Boolean));
    } else {
      for (const item of profile?.wishlist ?? []) {
        const title = String(typeof item === 'string' ? item : item?.name ?? '').trim();
        if (title) run.wishlist.add(title);
      }
    }
    run.tradables = profile.tradables ?? run.tradables;
    reconcileTiers(state, run, { authoritativeWishlist: profile?.profileComplete === true, authoritativeTradables: true });
    state.workstation?.setTradableGames(run.tradables);
  }).catch(() => {});
}

function resetRows(state) {
  state.rows.forEach(row => {
    row.title = row.originalTitle;
    row.appId = null;
    row.type = 'app';
    row.cacheKey = null;
    row.resolution = null;
    row.removal = null;
    row.resolutionStatus = 'pending';
    row.fuzzy = false;
    row.similarity = null;
    row.manuallyResolved = false;
    row.priceData = null;
    row.ggDealsNoData = false;
    row.tier = 4;
    row.inWishlist = false;
    row.inTradables = false;
    row.el.dataset.stptTitle = row.originalTitle;
    row.el.querySelectorAll('.stpt-badge, .stpt-skeleton').forEach(el => el.remove());
    injectSkeleton(row.el, true);
  });
  syncWorkstationRows(state, state.run, state.rows);
}

function setupSelectedFetch(state) {
  const button = document.createElement('button');
  button.id = 'stpt-floating-fetch-btn';
  button.className = 'stpt-floating-fetch-btn';
  button.style.display = 'none';
  const update = () => {
    if (button.dataset.resultType) return;
    const selected = document.querySelectorAll('.stpt-game-checkbox:checked').length;
    button.style.display = selected ? 'flex' : 'none';
    button.textContent = `Fetch prices for ${selected} game${selected === 1 ? '' : 's'}`;
  };
  document.querySelectorAll('.stpt-game-checkbox').forEach(checkbox => checkbox.addEventListener('change', update));
  const showResult = (message, type, delay = 4000) => {
    if (button._resultTimeout) clearTimeout(button._resultTimeout);
    button.style.display = 'flex';
    button.textContent = message;
    button.disabled = true;
    button.dataset.resultType = type;
    button._resultTimeout = setTimeout(() => {
      delete button.dataset.resultType;
      button.disabled = false;
      update();
    }, delay);
  };
  button.addEventListener('click', async () => {
    const checked = Array.from(document.querySelectorAll('.stpt-game-checkbox:checked'));
    const selectedIds = new Set(checked.map(checkbox => checkbox.dataset.stptId));
    const selectedRows = state.rows.filter(row => selectedIds.has(row.el.dataset.stptId));
    const rows = selectedRows.filter(row => row.appId);
    const unresolvedCount = selectedRows.length - rows.length;
    if (!state.run) return;
    if (!rows.length) {
      showResult(unresolvedCount === 1
        ? 'This game could not be resolved. Resolve it first.'
        : 'None of the selected games could be resolved.', 'error');
      return;
    }
    button.disabled = true;
    button.textContent = 'Fetching…';
    try {
      const result = await fetchRemotePrices(state, state.run, rows, 'selected');
      if (result.stale) return;
      const completedIds = new Set(result.completedRows.map(row => row.el.dataset.stptId));
      checked.forEach(checkbox => {
        if (completedIds.has(checkbox.dataset.stptId)) checkbox.checked = false;
      });
      const failedCount = result.failedRows.length;
      const completedCount = result.completedRows.length;
      if (failedCount || unresolvedCount || result.partialError) {
        const parts = [];
        if (completedCount) parts.push(`Fetched ${completedCount} successfully`);
        if (failedCount) parts.push(`${failedCount} could not be fetched`);
        if (unresolvedCount) parts.push(`${unresolvedCount} could not be resolved`);
        showResult(`${parts.join(', ')}.`, completedCount ? 'warning' : 'error');
      } else {
        showResult(`Fetched ${completedCount} game${completedCount === 1 ? '' : 's'} successfully.`, 'success');
      }
    } catch (error) {
      rows.forEach(row => replaceBadge(row.el, row.priceData, {
        ...row,
        settings: state.run?.settings ?? {},
        cacheKey: row.cacheKey,
      }));
      showResult(error?.code === 'GGDEALS_INTERACTIVE_TIMEOUT'
        ? 'GG.deals timed out. Try again after the rate-limit reset.'
        : 'An error occurred while fetching prices. Please try again.', 'error');
    } finally {
      if (button.dataset.resultType) return;
      button.disabled = false;
      update();
    }
  });
  document.body.appendChild(button);
  update();
}

function bindRecheckListener(state) {
  document.addEventListener('stpt-recheck', event => {
    const row = state.rows.find(item => item.el === event.target);
    const run = state.run;
    const title = event.detail?.title ?? row?.originalTitle;
    if (!row || !run || !title) return;
    const revision = ++row.rowRevision;
    sendMessage('RESOLVE_TITLES', { titles: [title], resolutionSessionId: run.pageSessionId })
      .then(async resolutions => {
        if (!isCurrent(state, run) || row.rowRevision !== revision) return;
        const resolution = resolutions?.[0] ?? { status: 'not-found', failed: true };
        applyResolution(row, resolution);
        syncWorkstationRows(state, run, [row]);
        await Promise.all([
          hydratePriceBatch(state, run, [{ row, resolution }]),
          reconcileRemovalRows(state, run, [row]),
        ]);
      }).catch(() => {
        if (isCurrent(state, run) && row.rowRevision === revision) {
          applyResolution(row, { status: 'not-found', failed: true, cacheKey: event.detail?.cacheKey });
          syncWorkstationRows(state, run, [row]);
        }
      });
  });
}

function bindDismissListener(state) {
  document.addEventListener('stpt-dismiss', event => {
    const row = state.rows.find(item => item.el === event.target);
    if (!row) return;
    applyResolution(row, {
      status: 'dismissed',
      cacheKey: event.detail?.cacheKey ?? row.cacheKey,
    });
    syncWorkstationRows(state, state.run, [row]);
  });
}

export async function startProgressivePage() {
  const { injectExclusionButton } = await import('./ui-exclusion.js');
  injectExclusionButton();
  const settings = await sendMessage('GET_SETTINGS');
  const excluded = await sendMessage('GET_EXCLUDED_PAGES').catch(() => []);
  if (isPageExcluded(location.href, excluded ?? []) || (!settings.showSidebar && !settings.apiKey)) return;
  sendMessage('REPORT_PAGE_DIAGNOSTICS', { url: location.href }).catch(() => {});

  const rows = parseGameRows();
  if (rows.length === 0) return;
  const state = {
    rows: rows.map((row, index) => {
      const linkedAppId = row.linkedAppId ? String(row.linkedAppId) : null;
      const linkedType = row.linkedType ? normalizeSteamType(row.linkedType) : null;
      row.el.dataset.stptId = String(index);
      row.el.dataset.stptTitle = row.title;
      injectSkeleton(row.el, true);
      return {
        ...row,
        originalTitle: row.title,
        appId: null,
        type: 'app',
        linkedAppId,
        linkedType,
        tier: 4,
        inWishlist: false,
        inTradables: false,
        cacheKey: null,
        resolution: null,
        removal: null,
        resolutionStatus: 'pending',
        fuzzy: false,
        similarity: null,
        priceData: null,
        ggDealsNoData: false,
        rowRevision: 0,
      };
    }),
    workstation: null,
    workstationBridge: null,
    settingsRef: { current: settings, revision: 0 },
    run: null,
  };
  state.workstationBridge = createWorkstationBridge(state);
  applyWorkstationVisibility(state, settings);

  if (settings.selectiveFetch !== false) {
    injectCheckboxes(state.rows);
    setupSelectedFetch(state);
  }
  bindManualResolutionListener(document, {
    rowData: state.rows,
    workstation: state.workstationBridge,
    sendMessage,
    replaceBadge,
    updateSidebarRow: () => {},
    injectSkeleton,
    applyResolvedRow,
    stripParentheses: title => String(title ?? '').replace(/\s*\([^)]*\)\s*/g, '').trim(),
    getDisplayRegion,
    readPriceRegion,
    _getBadgePrice,
    setWorkstationPrice,
  });
  bindRecheckListener(state);
  bindDismissListener(state);

  chrome.runtime.onMessage.addListener(message => {
    const run = state.run;
    if (message.type === 'WISHLIST_PROGRESS' && run && isCurrent(state, run)) {
      if (message.requestId !== run.profileRequestId) return;
      if (run.profileGeneration == null) run.profileGeneration = message.generation;
      if (message.generation != null && message.generation !== run.profileGeneration) return;
      for (const item of message.wishlist ?? []) {
        const title = String(typeof item === 'string' ? item : item?.name ?? '').trim();
        if (title) run.wishlist.add(title);
      }
      reconcileTiers(state, run, { authoritativeWishlist: false, authoritativeTradables: false });
      return;
    }
    if (message.type === 'CACHE_CLEARED' && run) {
      run.cancelled = true;
      run.coordinator?.cancel();
      run.observer?.disconnect();
      run.priceObserver?.disconnect();
      resetRows(state);
      beginRun(state, state.settingsRef.current).catch(() => {});
      return;
    }
    if (message.type === 'STEAM_TRACKER_UPDATED' && run && isCurrent(state, run)) {
      const titleReconciliation = reconcileRemovalTitleMatches(
        state,
        run,
        state.rows,
        { authoritative: true }
      );
      Promise.all([
        reconcileRemovalRows(state, run),
        titleReconciliation.then(rows => hydratePriceBatch(
          state,
          run,
          rows.map(row => ({ row, resolution: row.resolution }))
        )),
      ]).catch(() => {});
      return;
    }
    if (message.type === 'GGDEALS_RATE_LIMITED' && run && isCurrent(state, run)) {
      const limited = new Set((message.items ?? []).map(item => `${normalizeSteamType(item.type)}:${item.id}`));
      state.rows.forEach(row => {
        if (!row.appId || row.priceData) return;
        if (limited.has(`${normalizeSteamType(row.type)}:${row.appId}`)) {
          injectRateLimitedBadge(row.el, message.resetAt);
        }
      });
      return;
    }
    const previousSettings = state.run?.settings ?? state.settingsRef.current;
    const handled = handleRuntimeMessage(message, {
      rowData: state.rows,
      settingsRef: state.settingsRef,
      sendMessage,
      replaceBadge,
      updateSidebarRow: () => {},
      injectSkeleton,
      getDisplayRegion,
      readPriceRegion,
      priceItem,
      normalizeSteamType,
      workstation: state.workstationBridge,
      _getBadgePrice,
      setWorkstationPrice,
    });
    if (handled && message.type === 'SETTINGS_UPDATED' && state.run) {
      const run = state.run;
      run.settings = message.settings;
      applyWorkstationVisibility(state, message.settings);
      const switchedToAutomatic = previousSettings?.selectiveFetch !== false
        && message.settings.selectiveFetch === false;
      const enabledRemovedPrices = previousSettings?.fetchRemovedGamePrices !== true
        && message.settings.fetchRemovedGamePrices === true;

      if (switchedToAutomatic) {
        run.coordinator?.enqueue(state.rows.filter(row => row.resolutionStatus === 'pending'));
        const resolvedMissing = state.rows.filter(row => row.appId && !row.priceData);
        const immediate = resolvedMissing.filter(row => row.tier <= 2);
        if (immediate.length) fetchRemotePrices(state, run, immediate, 'automatic').catch(() => {});
        scheduleTier4Prices(state, run, resolvedMissing.filter(row => row.tier > 2));
      } else if (enabledRemovedPrices && message.settings.selectiveFetch === false) {
        const removedMissing = state.rows.filter(row => row.removal && row.appId && !row.priceData);
        const immediate = removedMissing.filter(row => row.tier <= 2);
        if (immediate.length) fetchRemotePrices(state, run, immediate, 'automatic').catch(() => {});
        scheduleTier4Prices(state, run, removedMissing.filter(row => row.tier > 2));
      }
    }
  });

  await beginRun(state, settings);
}
