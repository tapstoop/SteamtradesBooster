import { parseGameRows, prioritize, injectCheckboxes } from './parser.js';
import { getDisplayRegion, normalizeSteamType, typedPriceKey } from '../utils/similarity.js';
import { TradeSimulator } from './trade-logic.js';
import {
  injectSkeleton, replaceBadge, injectQuestionBadge, injectFuzzyBadge, injectNotFoundBadge,
  injectDismissedBadge, injectDelistedBadge, injectRateLimitedBadge, SidebarWorkstation, setSkeletonLoading,
} from './ui.js';
import { applyResolvedRow } from './resolution-helpers.js';
import { handleRuntimeMessage, bindManualResolutionListener } from './content-handlers.js';
import { _getBadgePrice, setWorkstationPrice } from './price-helpers.js';
import { isPageExcluded } from '../utils/excluded-pages.js';
import { ProgressiveResolutionCoordinator } from './progressive-resolution.js';

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

function priceItem(row) {
  return { id: row.appId, type: row.type ?? row.resolution?.type ?? 'app' };
}

function canPrice(resolution) {
  return !!resolution?.appId
    && ['hit', 'resolved', 'delisted'].includes(resolution.status)
    && !resolution.fuzzy;
}

function workstationGame(row, settings) {
  return {
    stptId: row.el.dataset.stptId,
    appId: row.appId,
    type: row.type,
    title: row.title,
    originalTitle: row.originalTitle,
    manuallyResolved: row.manuallyResolved ?? false,
    price: row.priceData ? _getBadgePrice(row.priceData, settings) : null,
    tier: row.tier,
    section: row.section ?? row.el.dataset.stptSection,
    inWishlist: row.tier === 1,
    inTradables: row.tier === 2,
    currency: settings.regions?.[0] || 'EUR',
  };
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
  row.resolutionStatus = status === 'not-found' && resolution?.failed ? 'failed' : 'resolved';
  row.el.dataset.stptTitle = row.title;

  const checkbox = row.el.previousElementSibling?.classList?.contains('stpt-game-checkbox')
    ? row.el.previousElementSibling
    : row.el.parentNode?.querySelector?.('.stpt-game-checkbox');
  if (checkbox) checkbox.dataset.stptTitle = row.title;

  if (status === 'dismissed') injectDismissedBadge(row.el, row.cacheKey, row.title);
  else if (status === 'delisted') injectDelistedBadge(row.el, row.cacheKey, row.title);
  else if (status === 'ambiguous') injectQuestionBadge(row.el, resolution.candidates, row.cacheKey);
  else if (status === 'not-found') injectNotFoundBadge(row.el, row.cacheKey, row.title);
  else if (row.fuzzy) injectFuzzyBadge(row.el, resolution);
}

async function hydratePriceBatch(state, run, items) {
  if (!isCurrent(state, run)) return;
  const rows = items.map(item => item.row).filter(row => canPrice(row.resolution));
  if (rows.length === 0) return;
  const itemsByKey = new Map(rows.map(row => [`${row.type}:${row.appId}`, priceItem(row)]));
  const [cachedPrices, bundles] = await Promise.all([
    sendMessage('GET_CACHED_PRICES', { items: [...itemsByKey.values()], regions: run.settings.regions }).catch(() => ({})),
    run.settings.apiKey
      ? sendMessage('GET_BUNDLES', { appIds: [...new Set(rows.map(row => row.appId))] }).catch(() => ({}))
      : Promise.resolve({}),
  ]);
  if (!isCurrent(state, run)) return;

  const patches = [];
  for (const row of rows) {
    const priceData = readPriceRegion(cachedPrices, row.appId, row.type, getDisplayRegion(run.settings));
    row.inBundle = row.type === 'bundle' || !!bundles?.[row.appId]?.length;
    if (priceData) {
      row.priceData = priceData;
      const gameInfo = { ...row, settings: run.settings, cacheKey: row.cacheKey, acqPrice: row.acqPrice ?? null };
      if (row.resolution.status === 'delisted') injectDelistedBadge(row.el, row.cacheKey, row.title, priceData, gameInfo);
      else replaceBadge(row.el, priceData, gameInfo);
    }
    patches.push({
      stptId: row.el.dataset.stptId,
      update: {
        title: row.title,
        appId: row.appId,
        type: row.type,
        tier: row.tier,
        originalTitle: row.originalTitle,
        manuallyResolved: row.manuallyResolved ?? false,
        price: priceData ? _getBadgePrice(priceData, run.settings) : null,
        currency: priceData?.prices?.currency ?? run.settings.currency ?? 'EUR',
      },
    });
  }
  state.workstation.updateResolvedPageGames(patches);

  if (run.settings.selectiveFetch === false) {
    const missingTierPrices = rows.filter(row => row.tier <= 2 && !row.priceData && row.el.querySelector('.stpt-skeleton'));
    if (missingTierPrices.length) fetchRemotePrices(state, run, missingTierPrices).catch(() => {});
    scheduleTier4Prices(state, run, rows.filter(row => row.tier > 2 && !row.priceData && row.el.querySelector('.stpt-skeleton')));
  }
}

async function fetchRemotePrices(state, run, rows) {
  if (!isCurrent(state, run) || rows.length === 0) return;
  setSkeletonLoading(rows.map(row => row.el));
  const [prices, bundles, acquisitionEntries] = await Promise.all([
    sendMessage('GET_PRICES', { items: rows.map(priceItem), regions: run.settings.regions }),
    sendMessage('GET_BUNDLES', { appIds: [...new Set(rows.map(row => row.appId))] }).catch(() => ({})),
    Promise.all(rows.filter(row => row.tier === 2).map(async row => [
      `${row.type}:${row.appId}`,
      await sendMessage('GET_ACQ_PRICE', { appId: row.appId, itemType: row.type }).then(result => result?.price ?? null).catch(() => null),
    ])),
  ]);
  if (!isCurrent(state, run)) return;
  const acquisitionPrices = Object.fromEntries(acquisitionEntries);
  const patches = [];
  for (const row of rows) {
    const priceData = readPriceRegion(prices, row.appId, row.type, getDisplayRegion(run.settings));
    row.inBundle = row.type === 'bundle' || !!bundles?.[row.appId]?.length;
    row.priceData = priceData ?? null;
    row.acqPrice = acquisitionPrices[`${row.type}:${row.appId}`] ?? row.acqPrice ?? null;
    replaceBadge(row.el, row.priceData, { ...row, settings: run.settings, cacheKey: row.cacheKey, acqPrice: row.acqPrice });
    patches.push({
      stptId: row.el.dataset.stptId,
      update: { price: priceData ? _getBadgePrice(priceData, run.settings) : null, currency: priceData?.prices?.currency ?? 'EUR' },
    });
  }
  state.workstation.updateResolvedPageGames(patches);
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
  const patches = [];
  const promoted = [];
  tiered.forEach((next, index) => {
    const row = state.rows[index];
    const oldTier = row.tier;
    if (oldTier === next.tier) return;
    if (!authoritativeWishlist && oldTier === 1 && next.tier !== 1) return;
    if (!authoritativeTradables && oldTier === 2 && next.tier === 4) return;
    row.tier = next.tier;
    if (row.priceData && !row.fuzzy && row.resolution?.status !== 'delisted') {
      replaceBadge(row.el, row.priceData, { ...row, settings: run.settings, cacheKey: row.cacheKey });
    }
    patches.push({ stptId: row.el.dataset.stptId, update: { tier: row.tier } });
    if (row.resolutionStatus === 'pending' && row.tier <= 2) promoted.push(row);
  });
  if (patches.length) state.workstation.updateResolvedPageGames(patches);
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
  const profilePromise = sendMessage('GET_PROFILE', { requestId: run.profileRequestId });
  await sendMessage('BEGIN_RESOLUTION_SESSION', {
    resolutionSessionId: run.pageSessionId,
    url: location.href,
    totalRows: state.rows.length,
  }).catch(() => {});

  const [cachedProfile, tradablesRead, cachedStates] = await Promise.all([
    sendMessage('GET_CACHED_PROFILE').catch(() => ({ wishlist: [], partialWishlist: [] })),
    sendMessage('GET_TRADABLES').catch(() => ({ storageError: true, tradables: [] })),
    sendMessage('GET_CACHED_RESOLUTION_STATES', { titles: state.rows.map(row => row.originalTitle) }).catch(() => []),
  ]);
  if (!isCurrent(state, run)) return;
  for (const item of [...(cachedProfile?.wishlist ?? []), ...(cachedProfile?.partialWishlist ?? [])]) {
    const title = String(typeof item === 'string' ? item : item?.name ?? '').trim();
    if (title) run.wishlist.add(title);
  }
  if (!tradablesRead?.storageError) run.tradables = tradablesRead?.tradables ?? [];
  reconcileTiers(state, run, { authoritativeWishlist: false, authoritativeTradables: !tradablesRead?.storageError });
  state.workstation.setWishlistGames([...run.wishlist]);
  state.workstation.setTradableGames(run.tradables);

  run.coordinator = new ProgressiveResolutionCoordinator({
    rows: state.rows,
    resolveTitles: (titles, meta) => sendMessage('RESOLVE_TITLES', {
      titles,
      resolutionSessionId: run.pageSessionId,
      resolutionBatchId: meta.batchId,
      rowMultiplicities: meta.rowMultiplicities,
    }),
    onResolved: (row, resolution) => applyResolution(row, resolution),
    onBatchResolved: items => hydratePriceBatch(state, run, items),
  });

  const hydrated = [];
  (Array.isArray(cachedStates) ? cachedStates : []).forEach((resolution, index) => {
    if (!resolution || !state.rows[index]) return;
    const row = state.rows[index];
    applyResolution(row, resolution);
    hydrated.push({ row, resolution });
  });
  run.coordinator.markHydrated(hydrated.map(item => item.row));
  if (hydrated.length) await hydratePriceBatch(state, run, hydrated);
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
    state.workstation.setWishlistGames([...run.wishlist]);
    state.workstation.setTradableGames(run.tradables);
  }).catch(() => {});
}

function resetRows(state) {
  state.rows.forEach(row => {
    row.title = row.originalTitle;
    row.appId = null;
    row.type = 'app';
    row.cacheKey = null;
    row.resolution = null;
    row.resolutionStatus = 'pending';
    row.fuzzy = false;
    row.priceData = null;
    row.tier = 4;
    row.el.dataset.stptTitle = row.originalTitle;
    row.el.querySelectorAll('.stpt-badge, .stpt-skeleton').forEach(el => el.remove());
    injectSkeleton(row.el, true);
  });
}

function setupSelectedFetch(state) {
  const button = document.createElement('button');
  button.id = 'stpt-floating-fetch-btn';
  button.className = 'stpt-floating-fetch-btn';
  button.style.display = 'none';
  const update = () => {
    const selected = document.querySelectorAll('.stpt-game-checkbox:checked').length;
    button.style.display = selected ? 'flex' : 'none';
    button.textContent = `Fetch prices for ${selected} game${selected === 1 ? '' : 's'}`;
  };
  document.querySelectorAll('.stpt-game-checkbox').forEach(checkbox => checkbox.addEventListener('change', update));
  button.addEventListener('click', async () => {
    const selectedTitles = new Set(Array.from(document.querySelectorAll('.stpt-game-checkbox:checked'))
      .map(checkbox => checkbox.dataset.stptTitle));
    const rows = state.rows.filter(row => selectedTitles.has(row.el.dataset.stptTitle) && row.appId);
    if (!rows.length || !state.run) return;
    button.disabled = true;
    try {
      await fetchRemotePrices(state, state.run, rows);
      document.querySelectorAll('.stpt-game-checkbox:checked').forEach(checkbox => { checkbox.checked = false; });
    } finally {
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
        await hydratePriceBatch(state, run, [{ row, resolution }]);
      }).catch(() => {
        if (isCurrent(state, run) && row.rowRevision === revision) {
          applyResolution(row, { status: 'not-found', failed: true, cacheKey: event.detail?.cacheKey });
        }
      });
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
      row.el.dataset.stptId = String(index);
      row.el.dataset.stptTitle = row.title;
      injectSkeleton(row.el, true);
      return {
        ...row,
        originalTitle: row.title,
        appId: null,
        type: 'app',
        tier: 4,
        cacheKey: null,
        resolution: null,
        resolutionStatus: 'pending',
        fuzzy: false,
        similarity: null,
        priceData: null,
        rowRevision: 0,
      };
    }),
    workstation: new SidebarWorkstation(new TradeSimulator(0.1)),
    settingsRef: { current: settings, revision: 0 },
    run: null,
  };
  window.__stpt_workstation = state.workstation;
  state.workstation.setPageGames(state.rows.map(row => workstationGame(row, settings)));

  if (settings.selectiveFetch !== false) {
    injectCheckboxes(state.rows);
    setupSelectedFetch(state);
  }
  bindManualResolutionListener(document, {
    rowData: state.rows,
    workstation: state.workstation,
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
      workstation: state.workstation,
      _getBadgePrice,
      setWorkstationPrice,
    });
    if (handled && message.type === 'SETTINGS_UPDATED' && state.run) {
      state.run.settings = message.settings;
      if (message.settings.selectiveFetch === false) {
        state.run.coordinator?.enqueue(state.rows.filter(row => row.resolutionStatus === 'pending'));
      }
    }
  });

  await beginRun(state, settings);
}
