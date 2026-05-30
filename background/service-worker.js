// background/service-worker.js
import { getPrices, getCachedPrices, getBundles, getRateLimitState, getPriceResult, isRefreshFallbackPrice } from './ggdeals.js';
import { resolveTitle, confirmResolution } from './resolver.js';
import { fetchProfile, getCachedProfile } from './profile.js';
import { cacheGet, cacheSet, cacheClear, setDismissed, setUndismissed, isDismissed, setDelisted, setUndelisted } from './cache.js';
import { getDisplayRegion } from '../utils/similarity.js';
import { writeSnapshot, pruneOldSnapshots } from './snapshots.js';
import { scrapeGame, scrapeBatch, handleScrapedResult, getScrapedData } from './ggdeals-scraper.js';

const SETTINGS_KEY = 'settings';
const TRADABLES_KEY = 'tradables_list';
const TRADABLES_SNAPSHOTS_INDEX_KEY = 'tradables_snapshots_index';
const ALARM_NAME = 'daily-snapshot';
const DIAGNOSTICS_KEY = 'diagnostics_session';

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
  const saved = await cacheGet(SETTINGS_KEY);
  const settings = { ...DEFAULT_SETTINGS, ...(saved?.value ?? {}) };

  // One-time migration: if settings.tradables exists and tradables_list key is empty, copy
  if (settings.tradables && settings.tradables.length > 0) {
    const tradablesCached = await cacheGet(TRADABLES_KEY);
    if (!tradablesCached || !tradablesCached.value || tradablesCached.value.length === 0) {
      // Migrate tradables from settings to separate storage
      await cacheSet(TRADABLES_KEY, settings.tradables, 0);
      // Remove tradables from settings object to prevent future wipes
      const cleanSettings = { ...settings };
      delete cleanSettings.tradables;
      await cacheSet(SETTINGS_KEY, cleanSettings, 0);
      console.log('[SW] Migrated tradables from settings to separate storage');
    } else {
      // tradables_list already exists, remove legacy tradables from settings
      delete settings.tradables;
    }
  }

  return settings;
}

const diagnosticsMemory = {
  activeUrl: '',
  resolutionStats: { total: 0, hit: 0, resolved: 0, fuzzy: 0, ambiguous: 0, 'not-found': 0, dismissed: 0, delisted: 0 },
  recentFailures: [],
  updatedAt: null,
};

function getSessionStorageArea() {
  return chrome.storage?.session ?? null;
}

async function getDiagnostics() {
  const area = getSessionStorageArea();
  if (!area) return { ...diagnosticsMemory };
  return new Promise(resolve => {
    area.get(DIAGNOSTICS_KEY, result => {
      resolve(result?.[DIAGNOSTICS_KEY] ?? { ...diagnosticsMemory });
    });
  });
}

async function setDiagnostics(next) {
  Object.assign(diagnosticsMemory, next);
  const area = getSessionStorageArea();
  if (!area) return;
  await new Promise(resolve => area.set({ [DIAGNOSTICS_KEY]: next }, resolve));
}

async function updateDiagnostics(patch) {
  const current = await getDiagnostics();
  await setDiagnostics({ ...current, ...patch, updatedAt: Date.now() });
}

function countResolutions(titles, resolutions) {
  const stats = { total: resolutions.length, hit: 0, resolved: 0, fuzzy: 0, ambiguous: 0, 'not-found': 0, dismissed: 0, delisted: 0 };
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

function formatDiagnosticDate(ts) {
  return ts ? new Date(ts).toISOString() : 'n/a';
}

async function buildDiagnosticLog() {
  const diagnostics = await getDiagnostics();
  const rate = getRateLimitState();
  const manifest = chrome.runtime.getManifest();
  const stats = diagnostics.resolutionStats ?? {};
  const failures = diagnostics.recentFailures ?? [];
  const calls = rate.lastCalls ?? [];
  const rateErrors = rate.recent429s ?? [];

  return [
    `SteamTrades Booster v${manifest.version}`,
    `Browser: ${navigator.userAgent}`,
    `Active SteamTrades URL: ${diagnostics.activeUrl || 'n/a'}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    'Resolution stats:',
    `total=${stats.total ?? 0} hit=${stats.hit ?? 0} resolved=${stats.resolved ?? 0} fuzzy=${stats.fuzzy ?? 0} ambiguous=${stats.ambiguous ?? 0} not-found=${stats['not-found'] ?? 0} dismissed=${stats.dismissed ?? 0} delisted=${stats.delisted ?? 0}`,
    '',
    'Rate limit:',
    `limit=${rate.limit ?? 'n/a'} remaining=${rate.remaining ?? 'n/a'} resetAt=${formatDiagnosticDate(rate.resetAt)} updatedAt=${formatDiagnosticDate(rate.lastUpdatedAt)}`,
    '',
    'Last API calls:',
    ...(calls.length ? calls.map(c => `${formatDiagnosticDate(c.at)} ${c.type} ${c.region} count=${c.count} status=${c.status}`) : ['none']),
    '',
    'Recent resolution failures:',
    ...(failures.length ? failures.map(f => `${formatDiagnosticDate(f.at)} ${f.status}: ${f.title}`) : ['none']),
    '',
    'Recent 429s:',
    ...(rateErrors.length ? rateErrors.map(e => `${formatDiagnosticDate(e.at)} ${e.type} ${e.region} count=${e.count} resetAt=${formatDiagnosticDate(e.resetAt)}`) : ['none']),
  ].join('\n');
}

function normalizePriceMessageItems(msg) {
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

function normalizeSteamEntityType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
}

function acquisitionItem(msg) {
  return {
    id: String(msg.itemId ?? msg.id ?? msg.appId),
    type: normalizeSteamEntityType(msg.itemType ?? msg.entityType ?? msg.steamType ?? 'app'),
  };
}

function acquisitionKey(id, type = 'app') {
  return `acq:${normalizeSteamEntityType(type)}:${String(id)}`;
}

function legacyAcquisitionKey(id) {
  return `acq:${String(id)}`;
}

function priceUpdatedMessage(target, region, priceData) {
  const itemType = normalizeSteamEntityType(target.type);
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

// --- Alarm: Daily Snapshot ---
chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1440 });

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  const settings = await getSettings();
  if (!settings.apiKey || !settings.steamId) return;

  // Fetch tradables from separate storage (not from settings)
  const tradablesCached = await cacheGet(TRADABLES_KEY);
  const tradables = tradablesCached?.value ?? [];
  const profile = await fetchProfile(settings.steamId, tradables);
  const allTitles = [...profile.wishlist, ...profile.tradables];
  const resolutions = await Promise.all(allTitles.map(t => resolveTitle(t)));
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

// --- Message Router ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    console.error('[SW] Error handling message', message.type, err);
    sendResponse({ error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(msg) {
  const settings = await getSettings();

  switch (msg.type) {
    case 'GET_SETTINGS':
      return settings;

    case 'GET_TRADABLES': {
      const cached = await cacheGet(TRADABLES_KEY);
      return cached?.value ?? [];
    }

    case 'SAVE_TRADABLES': {
      await cacheSet(TRADABLES_KEY, msg.tradables, 0);
      return { ok: true };
    }

    case 'SAVE_SETTINGS': {
      await cacheSet(SETTINGS_KEY, msg.settings, 0);
      // Broadcast to all tabs so content scripts and other popup tabs can re-render
      chrome.tabs.query({}, tabs => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED', settings: msg.settings }).catch(() => {});
        });
      });
      return { ok: true };
    }

    case 'CLEAR_CACHE': {
      await cacheClear();
      return { ok: true };
    }

    case 'GET_PROFILE': {
      if (!settings.steamId) return { wishlist: [], tradables: [], error: 'No Steam ID set' };
      // Use tradables from separate storage
      const tradablesCached = await cacheGet(TRADABLES_KEY);
      const tradables = tradablesCached?.value ?? settings.tradables ?? [];
      return fetchProfile(settings.steamId, tradables);
    }

    case 'RESOLVE_TITLES': {
      // msg.titles: string[]
      const results = await Promise.all(msg.titles.map(t => resolveTitle(t)));
      const { stats, failures } = countResolutions(msg.titles, results);
      const current = await getDiagnostics();
      await updateDiagnostics({
        resolutionStats: stats,
        recentFailures: [...failures, ...(current.recentFailures ?? [])].slice(0, 25),
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
      const prices = await getPrices(settings.apiKey, items, regions);
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
      await updateDiagnostics({ activeUrl: msg.url ?? '' });
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
      const cached = await cacheGet(acquisitionKey(item.id, item.type));
      if (cached) return { price: cached.value ?? null };
      if (item.type !== 'app') return { price: null };
      const legacy = await cacheGet(legacyAcquisitionKey(item.id));
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
      const results = await Promise.all(
        appIds.map(async (appId) => {
          try {
            const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
            const resp = await fetch(url);
            const data = await resp.json();
            const appData = data?.[appId];
            if (appData?.success && appData?.data?.name) {
              return { raw: appId, status: 'appid-resolved', appId, matchedName: appData.data.name };
            }
            return { raw: appId, status: 'not-found', appId: null, matchedName: null };
          } catch {
            return { raw: appId, status: 'not-found', appId: null, matchedName: null };
          }
        })
      );
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
      // Real-time Steam search for suggestions
      if (!msg.query || msg.query.length < 2) return { items: [] };
      try {
        const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(msg.query)}&l=english&cc=us`;
        const resp = await fetch(url);
        if (!resp.ok) return { items: [] };
        const data = await resp.json();
        return { items: (data.items ?? []).slice(0, 10) };
      } catch {
        return { items: [] };
      }
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
      const prices = await getPrices(settings.apiKey, items, regions, { forceRefresh: true });
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
      const timestamp = Date.now();
      const id = `snap_${timestamp}`;
      // Store the snapshot data
      await cacheSet(`tradables_snapshot:${id}`, {
        id,
        timestamp,
        label: msg.label || new Date(timestamp).toLocaleString(),
        count: msg.tradables?.length ?? 0,
        tradables: msg.tradables,
      }, 0);
      // Update index
      let index = await cacheGet(TRADABLES_SNAPSHOTS_INDEX_KEY);
      index = index?.value ?? [];
      index.push({
        id,
        timestamp,
        label: msg.label || new Date(timestamp).toLocaleString(),
        count: msg.tradables?.length ?? 0,
      });
      await cacheSet(TRADABLES_SNAPSHOTS_INDEX_KEY, index, 0);
      return { ok: true, id };
    }

    case 'GET_TRADABLES_SNAPSHOTS': {
      const index = await cacheGet(TRADABLES_SNAPSHOTS_INDEX_KEY);
      return index?.value ?? [];
    }

    case 'RESTORE_TRADABLES_SNAPSHOT': {
      const snap = await cacheGet(`tradables_snapshot:${msg.id}`);
      if (!snap?.value) return { error: 'Snapshot not found' };
      await cacheSet(TRADABLES_KEY, snap.value.tradables, 0);
      return { ok: true };
    }

    case 'DELETE_TRADABLES_SNAPSHOT': {
      // Remove the snapshot data directly
      await chrome.storage.local.remove([`tradables_snapshot:${msg.id}`]);
      // Update index
      let index = await cacheGet(TRADABLES_SNAPSHOTS_INDEX_KEY);
      index = index?.value ?? [];
      index = index.filter(s => s.id !== msg.id);
      await cacheSet(TRADABLES_SNAPSHOTS_INDEX_KEY, index, 0);
      return { ok: true };
    }

    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}
