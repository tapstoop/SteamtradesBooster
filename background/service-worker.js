// background/service-worker.js
import { getPrices, getCachedPrices, getBundles, getPriceResult, isRefreshFallbackPrice } from './ggdeals.js';
import { resolveTitle, confirmResolution } from './resolver.js';
import { fetchProfile, getCachedProfile } from './profile.js';
import { cacheGet, safeCacheGet, cacheSet, cacheClear, cacheRevision, setDismissed, setUndismissed, isDismissed, setDelisted, setUndelisted } from './cache.js';
import { getDisplayRegion, normalizeSteamType } from '../utils/similarity.js';
import { scrapeGame, scrapeBatch, handleScrapedResult, getScrapedData } from './ggdeals-scraper.js';
import { getExcludedPageKey, getExcludedPagePath, isSteamTradesUrl } from '../utils/excluded-pages.js';
import { writeSnapshot, pruneOldSnapshots } from './snapshots.js';
import { steamFetch, mapSteamTasks, steamRequestScheduler } from './steam-rate-limiter.js';
import {
  buildDiagnosticLog as renderDiagnosticLog,
  DEFAULT_RESOLUTION_STATS,
  DIAGNOSTICS_RETENTION,
  getDiagnostics,
  sanitizeSteamTradesUrl,
  updateDiagnostics,
} from './diagnostics.js';

const SETTINGS_KEY = 'settings';
const TRADABLES_KEY = 'tradables_list';
const TRADABLES_SNAPSHOTS_INDEX_KEY = 'tradables_snapshots_index';
const EXCLUDED_PAGES_KEY = 'excluded_pages';
const DEALS_CACHE_KEY = 'deals_cards_cache';
const DEALS_REFRESH_OPTIONS_KEY = 'dealsRefreshOptions';
const DIAGNOSTICS_PANEL_EXPANDED_KEY = 'diagnosticsPanelExpanded';
const ALARM_NAME = 'daily-snapshot';
const pendingSteamSearches = new Map();
const steamSearchSubscribers = new Map();
const cancelledSteamSearchRequests = new Map();
const CANCELLED_SEARCH_TTL_MS = 60_000;
const CANCELLED_SEARCH_LIMIT = 500;
const inFlightProfiles = new Map();
const latestProfileRuns = new Map();
let profileGeneration = 0;
let profileRequestSequence = 0;
let profileInvalidationGeneration = 0;
let lifecycleEpoch = 0;
let activeLifecycleOperations = 0;
let lifecycleAdmissionClosed = false;
let lifecycleDrainResolver = null;
let cacheClearPromise = null;
let storageWriteChain = Promise.resolve();

function withStorageWriteLock(task) {
  const result = storageWriteChain.then(task, task);
  storageWriteChain = result.catch(() => {});
  return result;
}

function waitForLifecycleDrain() {
  if (activeLifecycleOperations === 0) return Promise.resolve();
  return new Promise(resolve => { lifecycleDrainResolver = resolve; });
}

function releaseLifecycleOperation() {
  activeLifecycleOperations = Math.max(0, activeLifecycleOperations - 1);
  if (activeLifecycleOperations === 0 && lifecycleDrainResolver) {
    const resolve = lifecycleDrainResolver;
    lifecycleDrainResolver = null;
    resolve();
  }
}

async function withLifecycleOperation(task) {
  while (cacheClearPromise || lifecycleAdmissionClosed) {
    await cacheClearPromise;
  }
  activeLifecycleOperations += 1;
  const epoch = lifecycleEpoch;
  try {
    return await task(epoch);
  } finally {
    releaseLifecycleOperation();
  }
}

function revisionConflict(entity, expectedRevision, currentRevision) {
  return {
    ok: false,
    code: 'CONFLICT',
    error: `${entity} changed in another window. Reload before saving.`,
    revision: currentRevision,
  };
}

function broadcastWishlistProgress(steamId, progress, requestId, generation) {
  const message = { type: 'WISHLIST_PROGRESS', steamId, requestId, generation, ...progress };
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // No extension page may be listening while the service worker runs.
  }
  try {
    chrome.tabs.query({}, tabs => {
      tabs?.forEach(tab => {
        if (tab.id == null) return;
        try { chrome.tabs.sendMessage(tab.id, message).catch(() => {}); } catch {}
      });
    });
  } catch {}
}

function broadcastCacheCleared() {
  const message = { type: 'CACHE_CLEARED' };
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {}
  try {
    chrome.tabs.query({}, tabs => {
      tabs?.forEach(tab => {
        if (tab.id == null) return;
        try { chrome.tabs.sendMessage(tab.id, message).catch(() => {}); } catch {}
      });
    });
  } catch {}
}

function broadcastGgDealsRateLimited(event) {
  const ids = Array.isArray(event?.ids) ? event.ids.map(id => String(id)).filter(Boolean) : [];
  if (ids.length === 0) return;
  const type = normalizeSteamType(event.type ?? 'app');
  const region = String(event.region ?? '').trim();
  const message = {
    type: 'GGDEALS_RATE_LIMITED',
    items: ids.map(id => ({ id, type })),
    regions: region ? [region] : [],
    resetAt: Number(event.resetAt) || null,
    source: event.source ?? 'rate-limit',
  };
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {}
  try {
    chrome.tabs.query({}, tabs => {
      tabs?.forEach(tab => {
        if (tab.id == null) return;
        try { chrome.tabs.sendMessage(tab.id, message).catch(() => {}); } catch {}
      });
    });
  } catch {}
}

function broadcastTradablesUpdated(tradables, revision) {
  const message = {
    type: 'TRADABLES_UPDATED',
    tradables,
    revision,
    count: Array.isArray(tradables) ? tradables.length : 0,
  };
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {}
  try {
    chrome.tabs.query({}, tabs => {
      tabs?.forEach(tab => {
        if (tab.id == null) return;
        try { chrome.tabs.sendMessage(tab.id, message).catch(() => {}); } catch {}
      });
    });
  } catch {}
}

function nextProfileRequestId() {
  profileRequestSequence += 1;
  return `profile-${Date.now()}-${profileRequestSequence}`;
}

function profileTradablesRevision(tradables) {
  const normalized = normalizeTradablesList(tradables);
  return JSON.stringify(normalized.map(item => {
    if (typeof item === 'string') return item;
    return {
      appId: String(item?.appId ?? ''),
      name: String(item?.name ?? ''),
      type: String(item?.type ?? 'app'),
    };
  }));
}

export function normalizeTradablesList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => {
    if (typeof item === 'string') return item.trim().length > 0;
    return item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim();
  });
}

async function readProfileTradables(settings) {
  let cached;
  try {
    cached = await cacheGet(TRADABLES_KEY);
  } catch (err) {
    return {
      ok: false,
      error: 'Tradables storage read failed',
      cause: err,
    };
  }

  if (cached == null) {
    return {
      ok: true,
      tradables: normalizeTradablesList(settings.tradables),
      absent: true,
    };
  }

  if (!Array.isArray(cached.value)) {
    return {
      ok: false,
      error: 'Stored tradables list is malformed',
    };
  }

  return {
    ok: true,
    tradables: normalizeTradablesList(cached.value),
    absent: false,
  };
}

function storageGetRaw(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, result => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result?.[key] ?? null);
    });
  });
}

function storageSetRaw(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function getProfileCoalesced(steamId, tradables, requestId = null, epoch = lifecycleEpoch, { forceRefresh = false } = {}) {
  const normalizedTradables = normalizeTradablesList(tradables);
  const revision = profileTradablesRevision(normalizedTradables);
  const key = `${steamId}:${revision}:${forceRefresh ? 'refresh' : 'cached'}`;
  let run = inFlightProfiles.get(key);
  if (!run) {
    run = {
      key,
      steamId,
      revision,
      generation: ++profileGeneration,
      invalidationGeneration: profileInvalidationGeneration,
      epoch,
      requestIds: new Set(),
      cancelled: false,
      settled: false,
      promise: null,
    };
    latestProfileRuns.set(steamId, run);
    inFlightProfiles.set(key, run);
    run.promise = fetchProfile(steamId, normalizedTradables, {
      forceRefresh,
      shouldCommit: () => isProfileRunCurrent(run),
      onWishlistProgress: progress => {
        if (!isProfileRunCurrent(run)) return;
        for (const subscriberId of run.requestIds) {
          broadcastWishlistProgress(steamId, progress, subscriberId, run.generation);
        }
      },
    }).finally(() => {
      run.settled = true;
      run.requestIds.clear();
      if (inFlightProfiles.get(key) === run) inFlightProfiles.delete(key);
    });
  }
  if (requestId) run.requestIds.add(requestId);
  return run;
}

function isProfileRunCurrent(run) {
  return Boolean(run)
    && !run.cancelled
    && run.epoch === lifecycleEpoch
    && run.invalidationGeneration === profileInvalidationGeneration
    && latestProfileRuns.get(run.steamId) === run;
}

function invalidateActiveProfileRuns() {
  profileInvalidationGeneration += 1;
  const pending = [...inFlightProfiles.values()].map(run => {
    run.cancelled = true;
    return run.promise?.catch(() => {});
  }).filter(Boolean);
  inFlightProfiles.clear();
  latestProfileRuns.clear();
  return pending;
}

async function getExcludedPages() {
  const cached = await safeCacheGet(EXCLUDED_PAGES_KEY);
  return Array.isArray(cached?.value) ? cached.value.filter(page => typeof page === 'string' && page) : [];
}

function broadcastExcludedPages(pages) {
  const message = { type: 'EXCLUDED_PAGES_UPDATED', pages };
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // No popup/content listener may be present while the service worker runs.
  }
  chrome.tabs.query({}, tabs => {
    tabs.forEach(tab => {
      if (tab.id == null) return;
      try {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      } catch {
        // Ignore tabs that have navigated away or have no content script.
      }
    });
  });
}

// --- Default Settings (tradables now stored separately) ---
const DEFAULT_SETTINGS = {
  apiKey: '',
  steamId: '',
  regions: ['eu', 'us'],
  platforms: ['steam'],
  keyshopsEnabled: true,
  keyshops: ['driffle', 'eneba', 'g2a', 'g2play', 'gamivo', 'kinguin'],
  keyshopFees: {
    driffle: { min: 8, max: 15 },
    eneba: { min: 6, max: 12 },
    g2a: { min: 10, max: 15 },
    g2play: { min: 8, max: 15 },
    gamivo: { min: 8, max: 21 },
    kinguin: { min: 8, max: 15 },
  },
  showSidebar: true,
  showFullTimestamp: false,
  selectiveFetch: true,
  dealThresholdPct: 10,
  rangeLowRatio: 1.5,
  rangeHighRatio: 3.0,
  snapshotWindowDays: 180,
  currency: 'EUR',
  ggdealsAutoScroll: true,
};

/**
 * Bulk-read resolution cache entries in a single chrome.storage.local.get() call.
 * Returns a map of title → { appId, status } for resolved titles.
 * @param {string[]} titles
 * @param {string} prefix - Cache key prefix (e.g. 'resolve')
 * @returns {Promise<Object>} Map of title → { appId, status }
 */
async function getCacheBatch(titles, prefix) {
  const { normalizeTitle } = await import('../utils/similarity.js');
  const keys = titles.map(t => `${prefix}:${normalizeTitle(t)}`);
  const confirmedKeys = titles.map(t => `${prefix}:${normalizeTitle(t)}:confirmed`);
  const allKeys = [...keys, ...confirmedKeys];
  const all = await new Promise(resolve => chrome.storage.local.get(allKeys, resolve));
  const result = {};
  titles.forEach((title, i) => {
    const confirmedVal = all[confirmedKeys[i]]?.value;
    const resolvedVal = all[keys[i]]?.value;
    const raw = confirmedVal ?? resolvedVal;
    const appId = typeof raw === 'object' ? raw.appId ?? raw.id : raw;
    if (appId) {
      result[title] = {
        appId: String(appId),
        type: typeof raw === 'object' ? raw.type ?? 'app' : 'app',
        status: 'hit',
      };
    }
  });
  return result;
}

async function getSettings() {
  let saved;
  try {
    saved = await cacheGet(SETTINGS_KEY);
  } catch (err) {
    console.warn('[SW] Settings read failed:', err?.message ?? err);
    return { ...DEFAULT_SETTINGS, storageError: true, error: 'Settings storage read failed' };
  }
  const settings = { ...DEFAULT_SETTINGS, ...(saved?.value ?? {}) };
  const settingsRevision = cacheRevision(saved);

  // One-time migration: if settings.tradables exists and tradables_list key is empty, copy
  if (settings.tradables && settings.tradables.length > 0) {
    try {
      return await withStorageWriteLock(async () => {
        const currentSettingsCache = await cacheGet(SETTINGS_KEY);
        const currentSettings = { ...DEFAULT_SETTINGS, ...(currentSettingsCache?.value ?? {}) };
        const currentRevision = cacheRevision(currentSettingsCache);
        if (!Array.isArray(currentSettings.tradables) || currentSettings.tradables.length === 0) {
          return { ...currentSettings, settingsRevision: currentRevision };
        }

        const tradablesCached = await cacheGet(TRADABLES_KEY);
        if (tradablesCached && !Array.isArray(tradablesCached.value)) {
          throw new Error('Stored tradables list is malformed');
        }
        if (!tradablesCached || tradablesCached.value.length === 0) {
          await cacheSet(TRADABLES_KEY, currentSettings.tradables, 0);
        }

        const cleanSettings = { ...currentSettings };
        delete cleanSettings.tradables;
        const migratedRevision = await cacheSet(SETTINGS_KEY, cleanSettings, 0);
        console.log('[SW] Migrated tradables from settings to separate storage');
        return { ...cleanSettings, settingsRevision: migratedRevision };
      });
    } catch (err) {
      console.warn('[SW] Skipping tradables migration because storage read failed:', err?.message ?? err);
      return { ...settings, storageError: true, error: 'Settings storage read failed during tradables migration' };
    }
  }

  return { ...settings, settingsRevision };
}

function countResolutions(titles, resolutions) {
  const stats = { ...DEFAULT_RESOLUTION_STATS, total: resolutions.length };
  const failures = [];
  resolutions.forEach((res, i) => {
    const status = res?.status ?? 'not-found';
    if (status in stats) stats[status]++;
    if (res?.fuzzy) stats.fuzzy++;
    if (status === 'ambiguous' || status === 'not-found') {
      failures.push({ title: titles[i], status, at: Date.now() });
    }
  });
  return { stats, failures };
}

function queryActiveTabUrl() {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const url = tabs?.[0]?.url ?? '';
        resolve(sanitizeSteamTradesUrl(url));
      });
    } catch {
      resolve('');
    }
  });
}

async function buildDiagnosticLog() {
  const diagnostics = await getDiagnostics();
  const manifest = chrome.runtime.getManifest();
  const activeUrl = await queryActiveTabUrl();

  return renderDiagnosticLog({
    diagnostics,
    manifestVersion: manifest.version,
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData,
    activeUrl,
  });
}

export function normalizePriceMessageItems(msg) {
  const items = Array.isArray(msg.items)
    ? msg.items.map(item => ({
      id: String(item.id ?? item.appId),
      type: ['app', 'bundle', 'sub'].includes(item.type) ? item.type : 'app',
    }))
    : (msg.appIds ?? []).map(id => ({ id: String(id), type: 'app' }));

  const seen = new Set();
  return items.filter(item => {
    if (!item.id || item.id === 'undefined') return false;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function priceMessageTargets(msg) {
  return normalizePriceMessageItems(msg).map(item => ({ id: String(item.id ?? item.appId), type: item.type ?? 'app' }));
}


function acquisitionItem(msg) {
  return {
    id: String(msg.itemId ?? msg.id ?? msg.appId),
    type: normalizeSteamType(msg.itemType ?? msg.entityType ?? msg.steamType ?? 'app'),
  };
}

function acquisitionKey(id, type = 'app') {
  return `acq:${normalizeSteamType(type)}:${String(id)}`;
}

function legacyAcquisitionKey(id) {
  return `acq:${String(id)}`;
}

function priceUpdatedMessage(target, region, priceData) {
  const itemType = normalizeSteamType(target.type);
  const message = {
    type: 'PRICE_UPDATED',
    itemId: target.id,
    itemType,
    region,
    priceData,
  };
  if (itemType === 'app') message.appId = target.id;
  return message;
}

function pruneCancelledSteamSearchRequests() {
  const now = Date.now();
  for (const [requestId, cancelledAt] of cancelledSteamSearchRequests) {
    if (now - cancelledAt > CANCELLED_SEARCH_TTL_MS) {
      cancelledSteamSearchRequests.delete(requestId);
    }
  }
  while (cancelledSteamSearchRequests.size > CANCELLED_SEARCH_LIMIT) {
    const oldest = cancelledSteamSearchRequests.keys().next().value;
    if (oldest == null) break;
    cancelledSteamSearchRequests.delete(oldest);
  }
}

function createSearchRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `steam-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function steamSearchCacheKey(query) {
  return `steam-search:v1:${encodeURIComponent(query.toLocaleLowerCase())}:english:us`;
}

function cancelSteamSearch(requestId) {
  const id = String(requestId ?? '');
  if (!id) return;
  pruneCancelledSteamSearchRequests();
  cancelledSteamSearchRequests.set(id, Date.now());
  const entry = steamSearchSubscribers.get(id);
  if (!entry) return;
  entry.subscribers.delete(id);
  steamSearchSubscribers.delete(id);
  if (entry.subscribers.size === 0) {
    entry.cancelled = true;
    entry.controller.abort();
  }
}

function cancelAllSteamSearches() {
  for (const entry of pendingSteamSearches.values()) {
    entry.cancelled = true;
    entry.controller.abort();
  }
  pendingSteamSearches.clear();
  steamSearchSubscribers.clear();
  cancelledSteamSearchRequests.clear();
}

function normalizeSteamSearchItems(data) {
  if (!Array.isArray(data?.items)) return null;
  return data.items.slice(0, 10).map(item => ({
    ...item,
    id: String(item.id ?? item.appid ?? ''),
    type: normalizeSteamType(item.type ?? 'app'),
  })).filter(item => item.id);
}

function getSteamSearchEntry(query, cacheKey, epoch) {
  let entry = pendingSteamSearches.get(cacheKey);
  if (entry && entry.epoch === epoch) return entry;

  const controller = new AbortController();
  entry = {
    cacheKey,
    query,
    epoch,
    controller,
    subscribers: new Set(),
    cancelled: false,
    promise: null,
  };
  entry.promise = (async () => {
    try {
      const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=english&cc=us`;
      const resp = await steamFetch(url, { signal: controller.signal }, { kind: 'storesearch' });
      if (!resp.ok || entry.cancelled || entry.epoch !== lifecycleEpoch) return { items: [], cancelled: entry.cancelled };
      const data = await resp.json();
      const items = normalizeSteamSearchItems(data);
      if (!items || entry.cancelled || entry.epoch !== lifecycleEpoch) return { items: [] };
      try {
        await cacheSet(cacheKey, items, 45);
      } catch {
        // Search cache persistence is best-effort.
      }
      return { items };
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return { items: [], cancelled: true };
      return { items: [] };
    } finally {
      if (pendingSteamSearches.get(cacheKey) === entry) pendingSteamSearches.delete(cacheKey);
      for (const requestId of entry.subscribers) steamSearchSubscribers.delete(requestId);
      entry.subscribers.clear();
    }
  })();
  pendingSteamSearches.set(cacheKey, entry);
  return entry;
}

async function searchSteam(msg, epoch) {
  if (!msg.query || String(msg.query).trim().length < 2) return { items: [] };
  pruneCancelledSteamSearchRequests();
  const requestId = String(msg.requestId ?? createSearchRequestId());
  if (cancelledSteamSearchRequests.has(requestId)) {
    cancelledSteamSearchRequests.delete(requestId);
    return { items: [], cancelled: true };
  }

  const query = String(msg.query).trim();
  const cacheKey = steamSearchCacheKey(query);
  const cachedSearch = await safeCacheGet(cacheKey);
  if (cachedSearch?.value && Array.isArray(cachedSearch.value)) return { items: cachedSearch.value };

  const entry = getSteamSearchEntry(query, cacheKey, epoch);
  entry.subscribers.add(requestId);
  steamSearchSubscribers.set(requestId, entry);

  const result = await entry.promise;
  if (entry.epoch !== lifecycleEpoch || cancelledSteamSearchRequests.has(requestId)) {
    cancelledSteamSearchRequests.delete(requestId);
    return { items: [], cancelled: true };
  }
  return result?.cancelled ? { items: [], cancelled: true } : { items: result?.items ?? [] };
}

// --- Alarm: Daily Snapshot ---
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1440 });

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  await withLifecycleOperation(async (operationEpoch) => {
  const settings = await getSettings();
  if (!settings.apiKey || !settings.steamId) return;

  const tradablesRead = await readProfileTradables(settings);
  if (!tradablesRead.ok) {
    console.warn('[SW] Daily snapshot skipped:', tradablesRead.cause?.message ?? tradablesRead.error);
    return;
  }
  const profileRun = getProfileCoalesced(settings.steamId, tradablesRead.tradables, null, operationEpoch);
  const profile = await profileRun.promise;
  if (!isProfileRunCurrent(profileRun)) return;
  const allTitles = [...profile.wishlist, ...profile.tradables];
  const resolutions = await mapSteamTasks(allTitles, async title => {
    try { return await resolveTitle(title); } catch { return { status: 'not-found' }; }
  }, { concurrency: 2 });
  const appIds = resolutions
    .filter(r => r.status === 'hit' || r.status === 'resolved')
    .map(r => ({ id: r.appId, type: r.type ?? 'app' }));

  if (appIds.length === 0) return;

  const prices = await getPrices(settings.apiKey, appIds, settings.regions);
  for (const region of settings.regions) {
    for (const item of appIds) {
      if ((item.type ?? 'app') !== 'app') continue;
      const appId = item.id;
      const data = getPriceResult(prices, appId, item.type)?.[region];
      if (!data) continue;
      await writeSnapshot({
        appId,
        region,
        currentRetail: data.prices?.currentRetail ?? null,
        currentKeyshops: data.prices?.currentKeyshops ?? null,
      });
    }
  }
  await pruneOldSnapshots(settings.snapshotWindowDays);
  });
});

// --- Message Router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('[SW] Error handling message', message.type, err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function clearCacheWithBarrier() {
  if (cacheClearPromise) return cacheClearPromise;

  cacheClearPromise = (async () => {
    lifecycleAdmissionClosed = true;
    lifecycleEpoch += 1;
    const pendingProfiles = invalidateActiveProfileRuns();
    cancelAllSteamSearches();
    let ok = true;
    let error = null;
    try {
      await steamRequestScheduler.reset();
      await waitForLifecycleDrain();
      await Promise.allSettled(pendingProfiles);
      await cacheClear({
        preserveKeys: [
          SETTINGS_KEY,
          TRADABLES_KEY,
          TRADABLES_SNAPSHOTS_INDEX_KEY,
          EXCLUDED_PAGES_KEY,
          DEALS_REFRESH_OPTIONS_KEY,
          DIAGNOSTICS_PANEL_EXPANDED_KEY,
        ],
        preservePrefixes: [
          'tradables_snapshot:',
          'acq:',
        ],
      });
    } catch (err) {
      ok = false;
      error = err?.message ?? String(err);
    } finally {
      lifecycleAdmissionClosed = false;
      cacheClearPromise = null;
    }
    if (!ok) return { ok: false, code: 'CACHE_CLEAR_FAILED', error };
    broadcastCacheCleared();
    return { ok: true };
  })();

  return cacheClearPromise;
}

export async function handleMessage(msg, sender) {
  if (msg.type === 'CLEAR_CACHE') return clearCacheWithBarrier();
  if (msg.type === 'CANCEL_STEAM_SEARCH') {
    cancelSteamSearch(msg.requestId);
    return { ok: true };
  }
  return withLifecycleOperation(epoch => handleMessageAdmitted(msg, sender, epoch));
}

async function handleMessageAdmitted(msg, sender, operationEpoch) {
  const settings = await getSettings();

  switch (msg.type) {
    case 'GET_SETTINGS':
      return settings;

    case 'GET_TRADABLES': {
      try {
        const cached = await cacheGet(TRADABLES_KEY);
        return {
          tradables: normalizeTradablesList(cached?.value),
          tradablesRevision: cacheRevision(cached),
        };
      } catch (err) {
        console.warn('[SW] Tradables read failed:', err?.message ?? err);
        return { error: 'Tradables storage read failed', storageError: true, tradables: [] };
      }
    }

    case 'SAVE_TRADABLES': {
      try {
        return await withStorageWriteLock(async () => {
          const current = await cacheGet(TRADABLES_KEY);
          const currentRevision = cacheRevision(current);
          if (msg.expectedRevision !== currentRevision) {
            return revisionConflict('Tradables', msg.expectedRevision, currentRevision);
          }
          const tradables = normalizeTradablesList(msg.tradables);
          const revision = await cacheSet(TRADABLES_KEY, tradables, 0);
          broadcastTradablesUpdated(tradables, revision);
          return { ok: true, revision };
        });
      } catch (err) {
        console.warn('[SW] Tradables save failed:', err?.message ?? err);
        return { ok: false, error: `Tradables save failed: ${err?.message ?? err}` };
      }
    }

    case 'GET_EXCLUDED_PAGES': {
      return getExcludedPages();
    }

    case 'SAVE_EXCLUDED_PAGES': {
      const pages = Array.isArray(msg.pages) ? msg.pages : [];
      await cacheSet(EXCLUDED_PAGES_KEY, pages, 0);
      broadcastExcludedPages(pages);
      return { ok: true };
    }

    case 'ADD_EXCLUDED_PAGE': {
      const rawUrl = typeof msg.url === 'string' ? msg.url : '';
      if (!rawUrl || !isSteamTradesUrl(rawUrl)) {
        return getExcludedPages();
      }
      const list = await getExcludedPages();
      const key = getExcludedPageKey(rawUrl);
      if (!list.some(page => getExcludedPageKey(page) === key)) {
        list.push(getExcludedPagePath(rawUrl));
        await cacheSet(EXCLUDED_PAGES_KEY, list, 0);
        broadcastExcludedPages(list);
      }
      return list;
    }

    case 'REMOVE_EXCLUDED_PAGE': {
      const page = typeof msg.page === 'string' ? msg.page : '';
      const key = getExcludedPageKey(page);
      const list = await getExcludedPages();
      if (!key) return list;
      const next = list.filter(entry => getExcludedPageKey(entry) !== key);
      if (next.length !== list.length) {
        await cacheSet(EXCLUDED_PAGES_KEY, next, 0);
        broadcastExcludedPages(next);
      }
      return next;
    }

    case 'SAVE_SETTINGS': {
      if (settings.storageError) {
        return { ok: false, error: 'Refusing to save settings after a failed storage read. Reload settings first.' };
      }
      try {
        const result = await withStorageWriteLock(async () => {
          const current = await cacheGet(SETTINGS_KEY);
          const currentRevision = cacheRevision(current);
          if (msg.expectedRevision !== currentRevision) {
            return revisionConflict('Settings', msg.expectedRevision, currentRevision);
          }
          const revision = await cacheSet(SETTINGS_KEY, msg.settings, 0);
          return { ok: true, revision };
        });
        if (!result.ok) return result;
        settings.settingsRevision = result.revision;
      } catch (err) {
        console.warn('[SW] Settings save failed:', err?.message ?? err);
        return { ok: false, error: `Settings save failed: ${err?.message ?? err}` };
      }
      // Broadcast to all tabs so content scripts and other popup tabs can re-render
      chrome.tabs.query({}, tabs => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: msg.settings }).catch(() => {});
        });
      });
      return { ok: true, revision: settings.settingsRevision };
    }

    case 'GET_PROFILE': {
      if (!settings.steamId) return { wishlist: [], tradables: [], error: 'No Steam ID set' };
      const requestId = String(msg.requestId ?? nextProfileRequestId());
      const tradablesRead = await readProfileTradables(settings);
      if (!tradablesRead.ok) {
        return {
          wishlist: [],
          tradables: [],
          storageError: true,
          profileComplete: false,
          failedAppIds: [],
          wishlistTotal: 0,
          error: 'Tradables storage read failed',
          profileRequestId: requestId,
          profileGeneration,
        };
      }
      const run = getProfileCoalesced(settings.steamId, tradablesRead.tradables, requestId, operationEpoch, {
        forceRefresh: msg.forceRefresh === true,
      });
      const profile = await run.promise;
      if (!isProfileRunCurrent(run)) {
        return {
          wishlist: [],
          tradables: [],
          profileComplete: false,
          failedAppIds: [],
          wishlistTotal: 0,
          error: 'Profile request invalidated',
          profileRequestId: requestId,
          profileGeneration: run.generation,
        };
      }
      return { ...profile, profileRequestId: requestId, profileGeneration: run.generation };
    }

    case 'BEGIN_DEALS_REFRESH': {
      const cacheIdentity = String(msg.cacheIdentity ?? '');
      const refreshToken = String(msg.refreshToken ?? '');
      if (!cacheIdentity || !refreshToken) return { ok: false, error: 'Missing deals refresh identity' };
      return withStorageWriteLock(async () => {
        const current = await storageGetRaw(DEALS_CACHE_KEY);
        const previousComplete = current?.cacheIdentity === cacheIdentity && Array.isArray(current.cards) && current.profileComplete !== false
          ? {
            cards: current.cards,
            savedAt: current.savedAt ?? null,
            cacheIdentity: current.cacheIdentity,
            failedAppIds: Array.isArray(current.failedAppIds) ? current.failedAppIds : [],
          }
          : current?.cacheIdentity === cacheIdentity && current?.profileComplete === false && current?.previousComplete
            ? current.previousComplete
            : null;
        await storageSetRaw(DEALS_CACHE_KEY, {
          profileComplete: false,
          cacheIdentity,
          refreshToken,
          startedAt: Date.now(),
          previousComplete,
        }, 0);
        return { ok: true };
      });
    }

    case 'COMMIT_DEALS_REFRESH': {
      const cacheIdentity = String(msg.cacheIdentity ?? '');
      const refreshToken = String(msg.refreshToken ?? '');
      if (!cacheIdentity || !refreshToken) return { ok: false, error: 'Missing deals refresh identity' };
      return withStorageWriteLock(async () => {
        const marker = await storageGetRaw(DEALS_CACHE_KEY);
        if (marker?.cacheIdentity !== cacheIdentity || marker?.refreshToken !== refreshToken || marker?.profileComplete !== false) {
          return { ok: false, code: 'STALE_REFRESH' };
        }
        await storageSetRaw(DEALS_CACHE_KEY, {
          cards: Array.isArray(msg.cards) ? msg.cards : [],
          savedAt: Number(msg.savedAt) || Date.now(),
          cacheIdentity,
          profileComplete: true,
          failedAppIds: Array.isArray(msg.failedAppIds) ? msg.failedAppIds : [],
        }, 0);
        return { ok: true };
      });
    }

    case 'UPDATE_DEALS_REFRESH_PROGRESS': {
      const cacheIdentity = String(msg.cacheIdentity ?? '');
      const refreshToken = String(msg.refreshToken ?? '');
      if (!cacheIdentity || !refreshToken) return { ok: false, error: 'Missing deals refresh identity' };
      return withStorageWriteLock(async () => {
        const marker = await storageGetRaw(DEALS_CACHE_KEY);
        if (marker?.cacheIdentity !== cacheIdentity || marker?.refreshToken !== refreshToken || marker?.profileComplete !== false) {
          return { ok: false, code: 'STALE_REFRESH' };
        }
        await storageSetRaw(DEALS_CACHE_KEY, {
          ...marker,
          partialCards: Array.isArray(msg.cards) ? msg.cards : [],
          partialSavedAt: Number(msg.savedAt) || Date.now(),
        }, 0);
        return { ok: true };
      });
    }

    case 'RESOLVE_TITLES': {
      // msg.titles: string[]
      const titles = Array.isArray(msg.titles) ? msg.titles : [];
      const forceRefresh = msg.forceRefresh === true;
      const results = await mapSteamTasks(titles, async title => {
        try { return await resolveTitle(title, { forceRefresh }); } catch { return { status: 'not-found' }; }
      }, { concurrency: 2 });
      const { stats, failures } = countResolutions(titles, results);
      const current = await getDiagnostics();
      await updateDiagnostics({
        resolutionStats: stats,
        recentFailures: [...failures, ...(current.recentFailures ?? [])].slice(0, DIAGNOSTICS_RETENTION.maxResolutionFailures),
      });
      return results;
    }

    case 'GET_CACHED_RESOLUTIONS': {
      // Fast bulk cache read: resolve all titles from cache in one chrome.storage.local.get() call
      // Avoids N individual reads via message-passing
      const cachedResolutions = await getCacheBatch(msg.titles, 'resolve');
      return cachedResolutions;
    }

    case 'CONFIRM_RESOLUTION': {
      await confirmResolution(msg.cacheKey, msg.appId, msg.title, msg.type);
      return { ok: true };
    }

    case 'SET_DISMISSED': {
      await setDismissed(msg.cacheKey);
      return { ok: true };
    }

    case 'SET_UNDISMISSED': {
      await setUndismissed(msg.cacheKey);
      return { ok: true };
    }

    case 'SET_UNDELISTED': {
      await setUndelisted(msg.cacheKey);
      return { ok: true };
    }

    case 'SET_DELISTED': {
      await setDelisted(msg.cacheKey);
      return { ok: true };
    }

    case 'CLEAR_RESOLUTION': {
      // Clear confirmed resolution, cached resolution, and delisted flag
      const key = msg.cacheKey;
      await chrome.storage.local.remove([`${key}:confirmed`, `${key}:confirmed:title`, key, `${key}:delisted`]);
      return { ok: true };
    }

    case 'GET_PRICES': {
      // msg.appIds: string[], msg.regions: string[] (optional, falls back to settings)
      const regions = msg.regions ?? settings.regions;
      if (!settings.apiKey) return { error: 'No API key set' };
      const items = normalizePriceMessageItems(msg);
      const targets = priceMessageTargets(msg);
      const prices = await getPrices(settings.apiKey, items, regions, { onRateLimited: broadcastGgDealsRateLimited });
      // Broadcast PRICE_UPDATED to all tabs for each app that got fresh data
      if (prices) {
        const region = getDisplayRegion({ ...settings, regions });
        for (const target of targets) {
          const typedRegionData = getPriceResult(prices, target.id, target.type);
          if (typedRegionData?.[region]) {
            try {
              chrome.tabs.query({}, tabs => {
                tabs.forEach(tab => {
                  chrome.tabs.sendMessage(tab.id, {
                    ...priceUpdatedMessage(target, region, typedRegionData[region]),
                  }).catch(() => {});
                });
              });
            } catch (e) {
              // Ignore broadcast errors (tabs may not be listening)
            }
          }
        }
      }
      return prices;
    }

    case 'GET_CACHED_PRICES': {
      // Cache-only: no API calls, just return what's in storage
      // No broadcast here — cached reads are internal and don't need to trigger UI updates
      const regions = msg.regions ?? settings.regions;
      return getCachedPrices(normalizePriceMessageItems(msg), regions);
    }

    case 'GET_BUNDLES': {
      if (!settings.apiKey) return {};
      return getBundles(settings.apiKey, msg.appIds);
    }

    case 'REPORT_PAGE_DIAGNOSTICS': {
      await updateDiagnostics({ activeUrl: sanitizeSteamTradesUrl(msg.url ?? '') });
      return { ok: true };
    }

    case 'GET_DIAGNOSTIC_LOG': {
      return { log: await buildDiagnosticLog() };
    }

    case 'SAVE_ACQ_PRICE': {
      const item = acquisitionItem(msg);
      await cacheSet(acquisitionKey(item.id, item.type), msg.price, 0);
      if (item.type === 'app') {
        await cacheSet(legacyAcquisitionKey(item.id), msg.price, 0);
      }
      return { ok: true };
    }

    case 'GET_ACQ_PRICE': {
      const item = acquisitionItem(msg);
      const cached = await safeCacheGet(acquisitionKey(item.id, item.type));
      if (cached) return { price: cached.value ?? null };
      if (item.type !== 'app') return { price: null };
      const legacy = await safeCacheGet(legacyAcquisitionKey(item.id));
      return { price: legacy?.value ?? null };
    }

    case 'SCRAPE_GGDEALS': {
      return scrapeGame(msg.gameId, msg.ggdealsUrl);
    }

    case 'SCRAPE_BATCH': {
      return scrapeBatch(msg.games);
    }

    case 'GGDEALS_SCRAPED': {
      return handleScrapedResult(msg);
    }

    case 'GET_SCRAPED_DATA': {
      const data = await getScrapedData(msg.gameId);
      return { data };
    }

    case 'RESOLVE_APP_IDS': {
      const { appIds } = msg;
      const results = await mapSteamTasks(appIds, async (appId) => {
          try {
            const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
            const resp = await steamFetch(url, {}, { kind: 'appdetails' });
            const data = await resp.json();
            const appData = data?.[appId];
            if (appData?.success && appData?.data?.name) {
              return { raw: appId, status: 'appid-resolved', appId, matchedName: appData.data.name };
            }
            return { raw: appId, status: 'not-found', appId: null, matchedName: null };
          } catch {
            return { raw: appId, status: 'not-found', appId: null, matchedName: null };
          }
        }, { concurrency: 2 });
      return results;
    }

    case 'OPEN_POPUP':
    case 'OPEN_POPUP_TAB': {
      // Open the extension popup as a tab (chrome.action.openPopup requires user gesture)
      const params = new URLSearchParams();
      if (msg.tab) params.set('tab', msg.tab);
      if (msg.focus) params.set('focus', msg.focus);
      const popupUrl = chrome.runtime.getURL('popup/popup.html') + (params.toString() ? `?${params}` : '');
      chrome.tabs.create({ url: popupUrl });
      return { ok: true };
    }

    case 'SEARCH_STEAM': {
      return searchSteam(msg, operationEpoch);
    }

    // --- Cached Profile (fast, no API call if cache exists) ---
    case 'GET_CACHED_PROFILE': {
      if (!settings.steamId) return { wishlist: [], tradables: [] };
      return getCachedProfile(settings.steamId);
    }

    // --- Refresh Prices (cache bypass) ---
    case 'REFRESH_PRICES': {
      if (!settings.apiKey) return { error: 'No API key set' };
      const regions = msg.regions ?? settings.regions;
      const items = normalizePriceMessageItems(msg);
      const targets = priceMessageTargets(msg);
      if (items.length === 0) return {};
      const prices = await getPrices(settings.apiKey, items, regions, {
        forceRefresh: true,
        onRateLimited: broadcastGgDealsRateLimited,
      });
      // Broadcast PRICE_UPDATED for each app (same as GET_PRICES)
      if (prices) {
        const region = getDisplayRegion({ ...settings, regions });
        for (const target of targets) {
          const typedRegionData = getPriceResult(prices, target.id, target.type);
          if (typedRegionData?.[region]) {
            if (isRefreshFallbackPrice(typedRegionData[region])) continue;
            try {
              chrome.tabs.query({}, tabs => {
                tabs.forEach(tab => {
                  chrome.tabs.sendMessage(tab.id, {
                    ...priceUpdatedMessage(target, region, typedRegionData[region]),
                  }).catch(() => {});
                });
              });
            } catch (e) {}
          }
        }
      }
      return prices;
    }

    // --- Tradables Snapshots ---
    case 'SAVE_TRADABLES_SNAPSHOT': {
      return withStorageWriteLock(async () => {
        const timestamp = Date.now();
        const id = `snap_${timestamp}`;
        await cacheSet(`tradables_snapshot:${id}`, {
          id,
          timestamp,
          label: msg.label || new Date(timestamp).toLocaleString(),
          count: msg.tradables?.length ?? 0,
          tradables: msg.tradables,
        }, 0);
        const cachedIndex = await cacheGet(TRADABLES_SNAPSHOTS_INDEX_KEY);
        const index = Array.isArray(cachedIndex?.value) ? cachedIndex.value : [];
        index.push({
        id,
        timestamp,
        label: msg.label || new Date(timestamp).toLocaleString(),
        count: msg.tradables?.length ?? 0,
        });
        await cacheSet(TRADABLES_SNAPSHOTS_INDEX_KEY, index, 0);
        return { ok: true, id };
      });
    }

    case 'GET_TRADABLES_SNAPSHOTS': {
      const index = await safeCacheGet(TRADABLES_SNAPSHOTS_INDEX_KEY);
      return index?.value ?? [];
    }

    case 'RESTORE_TRADABLES_SNAPSHOT': {
      const snap = await safeCacheGet(`tradables_snapshot:${msg.id}`);
      if (!snap?.value) return { error: 'Snapshot not found' };
      try {
        return await withStorageWriteLock(async () => {
          const current = await cacheGet(TRADABLES_KEY);
          const currentRevision = cacheRevision(current);
          if (msg.expectedRevision !== currentRevision) {
            return revisionConflict('Tradables', msg.expectedRevision, currentRevision);
          }
          const tradables = normalizeTradablesList(snap.value.tradables);
          const revision = await cacheSet(TRADABLES_KEY, tradables, 0);
          broadcastTradablesUpdated(tradables, revision);
          return { ok: true, revision, tradables };
        });
      } catch (err) {
        return { ok: false, error: `Snapshot restore failed: ${err?.message ?? err}` };
      }
    }

    case 'DELETE_TRADABLES_SNAPSHOT': {
      return withStorageWriteLock(async () => {
        await new Promise((resolve, reject) => {
          chrome.storage.local.remove([`tradables_snapshot:${msg.id}`], () => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        });
        const cachedIndex = await cacheGet(TRADABLES_SNAPSHOTS_INDEX_KEY);
        const index = Array.isArray(cachedIndex?.value) ? cachedIndex.value : [];
        await cacheSet(TRADABLES_SNAPSHOTS_INDEX_KEY, index.filter(s => s.id !== msg.id), 0);
        return { ok: true };
      });
    }

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}
