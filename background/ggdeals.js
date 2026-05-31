// background/ggdeals.js
import { cacheGet, cacheSet } from './cache.js';
import {
  buildApiCallSummary,
  buildQuotaBlockEvent,
  recordGgDealsDiagnostics,
} from './diagnostics.js';

const PRICE_TTL = 0; // Permanent until manual refresh
const BASE_URL = 'https://api.gg.deals/v1';
const RATE_LIMIT_STORAGE_KEY = 'ggdeals_rate_limit_state';

const rateLimitState = {
  remaining: 100,
  resetAt: 0,
  limit: null,
  lastUpdatedAt: null,
};

const queue = [];
let processingQueue = false;

function priceKey(appId, region) {
  return `price:${appId}:${region}`;
}

function bundlePriceKey(bundleId, region) {
  return `bundle-price:${bundleId}:${region}`;
}

function subPriceKey(subId, region) {
  return `sub-price:${subId}:${region}`;
}

function typedPriceKey(id, type, region) {
  if (type === 'bundle') return bundlePriceKey(id, region);
  if (type === 'sub') return subPriceKey(id, region);
  return priceKey(id, region);
}

function normalizePriceType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
}

function typedResultKey(id, type = 'app') {
  return `${normalizePriceType(type)}:${String(id)}`;
}

function readPriceResult(results, id, type = 'app') {
  if (!results) return null;
  const normalizedType = normalizePriceType(type);
  const typed = results[typedResultKey(id, normalizedType)];
  if (typed) return typed;
  return normalizedType === 'app' ? results[String(id)] ?? null : null;
}

function writePriceResult(results, id, type, region, value) {
  const normalizedType = normalizePriceType(type);
  const stringId = String(id);
  const typedKey = typedResultKey(stringId, normalizedType);
  if (!results[typedKey]) results[typedKey] = {};
  results[typedKey][region] = value;

  // NOTE: For app type, both results[stringId] and results[typedKey] alias the same object.
  // Mutating one reference mutates the other. This is intentional for backward compatibility
  // with callers that access prices by plain appId. To avoid alias confusion, always
  // assign new values rather than mutating in place.
  if (normalizedType === 'app') {
    results[stringId] = results[typedKey];
  }
}

function normalizePriceItems(itemsOrIds) {
  return (itemsOrIds ?? []).map(item => {
    if (typeof item === 'object') {
      const id = item.id ?? item.appId;
      return { id: String(id), type: normalizePriceType(item.type) };
    }
    return { id: String(item), type: 'app' };
  }).filter(item => item.id && item.id !== 'undefined');
}

function updateRateLimit(resp) {
  const limit = parseInt(resp.headers.get('x-ratelimit-limit') ?? '');
  const remaining = parseInt(resp.headers.get('x-ratelimit-remaining') ?? '100');
  const resetAt = parseInt(resp.headers.get('x-ratelimit-reset') ?? '0') * 1000;
  rateLimitState.limit = Number.isFinite(limit) ? limit : rateLimitState.limit;
  rateLimitState.remaining = remaining;
  rateLimitState.resetAt = resetAt;
  rateLimitState.lastUpdatedAt = Date.now();
  persistRateLimitState(); // fire-and-forget; must not block
  return {
    limit: rateLimitState.limit,
    remaining: rateLimitState.remaining,
    resetAt: rateLimitState.resetAt,
    lastUpdatedAt: rateLimitState.lastUpdatedAt,
  };
}

async function persistRateLimitState() {
  try {
    await new Promise(resolve => {
      chrome.storage.local.set({ [RATE_LIMIT_STORAGE_KEY]: { ...rateLimitState } }, resolve);
    });
  } catch {
    // Best-effort persistence; must not break price fetching.
  }
}

async function safeRecordDiagnostics(fn) {
  try {
    await fn();
  } catch {
    // Diagnostics are best-effort and must not break price fetching.
  }
}

function buildCurrentQuotaBlock({ kind, type, ids, region, status, message }) {
  return buildQuotaBlockEvent({
    kind,
    type,
    ids,
    region,
    status,
    resetAt: rateLimitState.resetAt,
    limit: rateLimitState.limit,
    remaining: rateLimitState.remaining,
    message,
  });
}

async function fetchBatch(apiKey, ids, region, type = 'app') {
  const path = type === 'bundle' ? 'prices/by-steam-bundle-id' : 'prices/by-steam-app-id';
  const url = `${BASE_URL}/${path}/?ids=${ids.join(',')}&key=${encodeURIComponent(apiKey)}&region=${encodeURIComponent(region)}`;
  const resp = await fetch(url);

  const rateSnapshot = updateRateLimit(resp);
  const apiCall = buildApiCallSummary({ type, ids, region, status: resp.status });

  if (resp.status === 429) {
    let message = '';
    try {
      const body = await resp.json();
      message = body?.data?.message ?? body?.message ?? '';
    } catch {
      // 429 body is optional for diagnostics; headers still carry reset data.
    }
    const quotaBlock = buildCurrentQuotaBlock({ kind: '429', type, ids, region, status: resp.status, message });
    await safeRecordDiagnostics(() => recordGgDealsDiagnostics({ rateLimit: rateSnapshot, apiCall, quotaBlock }));
    throw { rateLimited: true, resetAt: rateLimitState.resetAt };
  }

  await safeRecordDiagnostics(() => recordGgDealsDiagnostics({ rateLimit: rateSnapshot, apiCall }));

  if (!resp.ok) {
    let apiMessage = resp.statusText;
    try {
      const body = await resp.json();
      apiMessage = body?.data?.message ?? body?.message ?? resp.statusText;
    } catch {
      // Body not valid JSON (e.g. HTML error page from proxy/CDN)
    }
    // Provide actionable hints for common errors
    let hint = '';
    if (resp.status === 400) {
      hint = '\nCheck: Is your GG.deals account confirmed? Click the verification link in your email after registering.';
    } else if (resp.status === 401 || resp.status === 403) {
      hint = '\nCheck: Is your API key correct? Go to GG.deals Settings to verify or regenerate it.';
    }
    throw new Error(`GG.deals API error: ${resp.status} — ${apiMessage}${hint}`);
  }

  const json = await resp.json();
  const data = json.data ?? {};
  const converted = {};
  for (const [id, priceData] of Object.entries(data)) {
    if (priceData && priceData.prices) {
      converted[id] = {
        title: priceData.title,
        url: priceData.url,
        prices: {
          currentRetail: parsePriceToCents(priceData.prices.currentRetail),
          currentKeyshops: parsePriceToCents(priceData.prices.currentKeyshops),
          historicalRetail: parsePriceToCents(priceData.prices.historicalRetail),
          historicalKeyshops: parsePriceToCents(priceData.prices.historicalKeyshops),
          currency: priceData.prices.currency,
        }
      };
    }
  }
  return converted;
}

function parsePriceToCents(priceStr) {
  if (priceStr == null) return null;
  const num = parseFloat(priceStr);
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

async function processQueue() {
  if (processingQueue || queue.length === 0) return;
  processingQueue = true;

  // Restore persisted rate-limit state (handles service worker hibernation)
  try {
    const stored = await new Promise(resolve => {
      chrome.storage.local.get(RATE_LIMIT_STORAGE_KEY, resolve);
    });
    if (stored?.[RATE_LIMIT_STORAGE_KEY]?.lastUpdatedAt) {
      const saved = stored[RATE_LIMIT_STORAGE_KEY];
      // Only restore if less than 1 hour old (stale data worse than defaults)
      if (Date.now() - saved.lastUpdatedAt < 3600000) {
        Object.assign(rateLimitState, saved);
      }
    }
  } catch {
    // Ignore; use module-level defaults
  }

  try {
    while (queue.length > 0) {
      if (rateLimitState.remaining <= 0 && rateLimitState.resetAt > Date.now()) {
        const waitingJob = queue[0];
        if (waitingJob) {
          const quotaBlock = buildCurrentQuotaBlock({
            kind: 'local-wait',
            type: waitingJob.type,
            ids: waitingJob.ids,
            region: waitingJob.region,
            status: 'local-wait',
          });
          await safeRecordDiagnostics(() => recordGgDealsDiagnostics({ quotaBlock }));
        }
        const wait = rateLimitState.resetAt - Date.now() + 200;
        await new Promise(r => setTimeout(r, Math.max(200, wait)));
      }

      const job = queue.shift();
      try {
        const data = await fetchBatch(job.apiKey, job.ids, job.region, job.type);
        for (const [id, priceData] of Object.entries(data)) {
          if (priceData) {
            await cacheSet(typedPriceKey(id, job.type, job.region), priceData, PRICE_TTL);
          }
        }
        job.resolve({ region: job.region, type: job.type, data });
      } catch (err) {
        if (err.rateLimited) {
          queue.unshift(job);
          const rawWait = (err.resetAt || Date.now() + 60000) - Date.now() + 200;
          await new Promise(r => setTimeout(r, Math.max(200, rawWait)));
        } else {
          job.reject(err);
        }
      }
    }
  } finally {
    processingQueue = false;
  }
}

export async function getPrices(apiKey, itemsOrIds, regions, options = {}) {
  const items = normalizePriceItems(itemsOrIds);
  const forceRefresh = Boolean(options.forceRefresh);
  const results = {};
  const toFetch = {};
  const subAppMap = {}; // Map Sub ID -> contained App IDs
  const subFailedIds = new Set();
  const subIncompleteIds = new Set();
  const subFallbackIds = new Set();
  const subFallbackCache = new Map();
  const subFallbackWarning = 'Steam package could not be fully refreshed; showing cached price data';

  async function captureSubFallback(subId) {
    if (!forceRefresh || subFallbackCache.has(subId)) return;
    const cachedRegions = new Map();
    for (const region of regions) {
      const cachedSub = await cacheGet(typedPriceKey(subId, 'sub', region));
      if (cachedSub) cachedRegions.set(region, cachedSub);
    }
    subFallbackCache.set(subId, cachedRegions);
  }

  function writeSubFallback(subId, region) {
    const cachedSub = subFallbackCache.get(subId)?.get(region);
    if (!cachedSub) return false;
    writePriceResult(results, subId, 'sub', region, {
      ...cachedSub.value,
      cachedAt: cachedSub.cachedAt,
      refreshFallback: true,
      refreshWarning: subFallbackWarning,
    });
    subFallbackIds.add(subId);
    return true;
  }

  // First, check for Sub IDs and resolve them to their contained apps
  for (const item of items) {
    if (item.type !== 'sub') continue;
    const id = item.id;
    await captureSubFallback(id);
    let allRegionsCached = !forceRefresh && regions.length > 0;
    if (allRegionsCached) {
      for (const region of regions) {
        const cachedSub = await cacheGet(typedPriceKey(id, 'sub', region));
        if (cachedSub) {
          writePriceResult(results, id, 'sub', region, { ...cachedSub.value, cachedAt: cachedSub.cachedAt });
        } else {
          allRegionsCached = false;
        }
      }
      if (allRegionsCached) continue;
    }
    // Try to get apps contained in this sub/bundle
    const subApps = await getSubApps(id);
    if (subApps && subApps.length > 0) {
      subAppMap[id] = subApps;
      // Add contained apps to the fetch list (we'll use their prices for the sub)
      for (const region of regions) {
        if (!toFetch[region]) toFetch[region] = { app: [], bundle: [] };
        for (const subAppId of subApps) {
          const cachedApp = !forceRefresh ? await cacheGet(typedPriceKey(subAppId, 'app', region)) : null;
          if (cachedApp) {
            writePriceResult(results, subAppId, 'app', region, { ...cachedApp.value, cachedAt: cachedApp.cachedAt });
          } else if (!toFetch[region].app.includes(subAppId)) {
            toFetch[region].app.push(subAppId);
          }
        }
      }
    } else {
      subFailedIds.add(id);
      if (forceRefresh) {
        for (const region of regions) {
          writeSubFallback(id, region);
        }
      }
    }
  }

  for (const region of regions) {
    const missing = [];
    for (const item of items) {
      const id = item.id;
      // Sub IDs are either aggregated from contained apps or fail closed.
      if (item.type === 'sub') {
        const cachedSub = !forceRefresh ? await cacheGet(typedPriceKey(id, 'sub', region)) : null;
        if (cachedSub && !readPriceResult(results, id, 'sub')?.[region]) {
          writePriceResult(results, id, 'sub', region, { ...cachedSub.value, cachedAt: cachedSub.cachedAt });
        }
        continue;
      }
      const cached = !forceRefresh ? await cacheGet(typedPriceKey(id, item.type, region)) : null;
      if (cached) {
        writePriceResult(results, id, item.type, region, { ...cached.value, cachedAt: cached.cachedAt });
      } else {
        missing.push(item);
      }
    }
    if (missing.length > 0) {
      if (!toFetch[region]) toFetch[region] = { app: [], bundle: [] };
      for (const item of missing) {
        const type = item.type === 'bundle' ? 'bundle' : 'app';
        if (!toFetch[region][type].includes(item.id)) {
          toFetch[region][type].push(item.id);
        }
      }
    }
  }

  const fetchPromises = [];
  for (const [region, groups] of Object.entries(toFetch)) {
    for (const [type, ids] of Object.entries(groups)) {
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        fetchPromises.push(
          new Promise((resolve, reject) => {
            queue.push({ apiKey, ids: batch, type, region, resolve, reject });
          })
        );
      }
    }
  }

  processQueue().catch(console.error);

  const settledBatchResults = await Promise.allSettled(fetchPromises);
  const failedBatches = settledBatchResults.filter(result => result.status === 'rejected');
  for (const result of settledBatchResults) {
    if (result.status !== 'fulfilled') continue;
    const { region, type, data } = result.value;
    for (const [id, priceData] of Object.entries(data)) {
      if (!priceData) continue;
      writePriceResult(results, id, type, region, { ...priceData, cachedAt: Date.now() });
    }
  }
  if (failedBatches.length > 0) {
    results.error = `${failedBatches.length} GG.deals price batch${failedBatches.length === 1 ? '' : 'es'} failed`;
  }

  // For Sub IDs, aggregate prices from contained apps
  for (const [subId, containedApps] of Object.entries(subAppMap)) {
    for (const region of regions) {
      const containedPrices = containedApps
        .map(appId => readPriceResult(results, appId, 'app')?.[region])
        .filter(Boolean);

      if (containedPrices.length === containedApps.length) {
        // Sum prices for the bundle (simple aggregation)
        const currency = containedPrices[0].prices?.currency ?? 'EUR';
        const sumPrice = (field) => {
          const vals = containedPrices.map(p => p.prices?.[field]).filter(v => v != null);
          return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
        };

        // Use first app's URL as the bundle URL (GG.deals doesn't have bundle-specific URLs via API)
        const firstUrl = containedPrices[0].url;

        const aggregate = {
          title: `Bundle (${containedApps.length} games)`,
          url: firstUrl,
          prices: {
            currentRetail: sumPrice('currentRetail'),
            currentKeyshops: sumPrice('currentKeyshops'),
            historicalRetail: sumPrice('historicalRetail'),
            historicalKeyshops: sumPrice('historicalKeyshops'),
            currency,
          },
          cachedAt: Date.now(),
          isSub: true,
          containedApps,
        };
        writePriceResult(results, subId, 'sub', region, aggregate);
        try {
          await cacheSet(typedPriceKey(subId, 'sub', region), aggregate, PRICE_TTL);
        } catch (err) {
          console.warn('[ggdeals] Failed to cache sub aggregate:', err?.message ?? err);
        }
      } else if (forceRefresh) {
        if (!writeSubFallback(subId, region)) subIncompleteIds.add(subId);
      }
    }
  }

  if (subFallbackIds.size > 0) {
    const warning = `${subFallbackIds.size} Steam package${subFallbackIds.size === 1 ? '' : 's'} could not be fully refreshed; showing cached price data`;
    results.error = results.error ? `${results.error}\n${warning}` : warning;
  }
  if (failedBatches.length > 0 && settledBatchResults.every(result => result.status === 'rejected') && subFallbackIds.size === 0) {
    throw failedBatches[0].reason;
  }

  // Mark sub IDs that could not be expanded as missing (fail closed).
  for (const subId of new Set([...subFailedIds, ...subIncompleteIds])) {
    for (const region of regions) {
      if (!readPriceResult(results, subId, 'sub')?.[region]) {
        // Keep explicit empty object for typed key consumers.
        if (!results[typedResultKey(subId, 'sub')]) results[typedResultKey(subId, 'sub')] = {};
      }
    }
  }

  return results;
}

/**
 * Cache-only version of getPrices — no API calls, only returns cached data.
 * Missing entries are simply omitted from the result.
 */
export async function getCachedPrices(itemsOrIds, regions) {
  const items = normalizePriceItems(itemsOrIds);
  const results = {};
  for (const region of regions) {
    for (const item of items) {
      const cached = await cacheGet(typedPriceKey(item.id, item.type, region));
      if (cached) {
        writePriceResult(results, item.id, item.type, region, { ...cached.value, cachedAt: cached.cachedAt });
      }
    }
  }
  return results;
}

/**
 * Get price data for Steam Sub IDs (bundles/packages).
 * GG.deals doesn't directly support Sub IDs, so we need to fetch the contained app IDs
 * and get prices for those individual apps.
 */
export async function getSubApps(subId) {
  try {
    const resp = await fetch(`https://store.steampowered.com/api/packagedetails?packageids=${subId}&l=english`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const subData = data[subId];
    if (!subData?.success) return null;
    const apps = subData.data?.apps ?? [];
    return apps.map(a => String(a.id));
  } catch {
    return null;
  }
}

export async function getBundles(apiKey, appIds) {
  const url = `${BASE_URL}/bundles/?ids=${appIds.join(',')}&key=${encodeURIComponent(apiKey)}`;
  try {
    const resp = await fetch(url);
    updateRateLimit(resp);
    if (!resp.ok) return {};
    const json = await resp.json();
    return json.data ?? {};
  } catch {
    return {};
  }
}

export function getPriceCacheKeys(itemsOrIds, regions) {
  const items = normalizePriceItems(itemsOrIds);
  return items.flatMap(item => regions.map(region => typedPriceKey(item.id, item.type, region)));
}

export function getPriceResult(prices, id, type = 'app') {
  return readPriceResult(prices, id, type);
}

export function isRefreshFallbackPrice(priceData) {
  return Boolean(priceData?.refreshFallback);
}
