// background/ggdeals.js
import { safeCacheGet, cacheSet, cacheDelete } from './cache.js';
import {
  buildApiCallSummary,
  buildQuotaBlockEvent,
  recordGgDealsDiagnostics,
} from './diagnostics.js';

const PRICE_TTL = 0; // Permanent until manual refresh
const BASE_URL = 'https://api.gg.deals/v1';
const RATE_LIMIT_STORAGE_KEY = 'ggdeals_rate_limit_state';
const SUB_PRICE_ORIGIN = 'ggdeals-sub-api-v1';

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
  const paths = {
    app: 'prices/by-steam-app-id',
    bundle: 'prices/by-steam-bundle-id',
    sub: 'prices/by-steam-sub-id',
  };
  const path = paths[normalizePriceType(type)];
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
        ...(type === 'sub' ? { priceOrigin: SUB_PRICE_ORIGIN } : {}),
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
          waitingJob.onRateLimited?.({
            type: waitingJob.type,
            ids: waitingJob.ids,
            region: waitingJob.region,
            resetAt: rateLimitState.resetAt,
            source: 'local-wait',
          });
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
          job.onRateLimited?.({
            type: job.type,
            ids: job.ids,
            region: job.region,
            resetAt: err.resetAt ?? rateLimitState.resetAt,
            source: '429',
          });
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
  const subFallbackIds = new Set();
  const subFallbackCache = new Map();
  const subFallbackWarning = 'GG.deals package price could not be refreshed; showing the last official cached response';

  function isOfficialSubPrice(value) {
    return value?.priceOrigin === SUB_PRICE_ORIGIN && value?.prices && typeof value.prices === 'object';
  }

  async function readCachedItem(item, region) {
    const key = typedPriceKey(item.id, item.type, region);
    const cached = await safeCacheGet(key);
    if (!cached || item.type !== 'sub') return cached;
    if (isOfficialSubPrice(cached.value)) return cached;
    await cacheDelete(key);
    return null;
  }

  function fallbackKey(subId, region) {
    return `${subId}:${region}`;
  }

  function writeSubFallback(subId, region) {
    const cachedSub = subFallbackCache.get(fallbackKey(subId, region));
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

  for (const region of regions) {
    const missing = [];
    for (const item of items) {
      const cached = await readCachedItem(item, region);
      if (cached && !forceRefresh) {
        writePriceResult(results, item.id, item.type, region, { ...cached.value, cachedAt: cached.cachedAt });
      } else {
        missing.push(item);
        if (forceRefresh && item.type === 'sub' && cached) {
          subFallbackCache.set(fallbackKey(item.id, region), cached);
        }
      }
    }
    if (missing.length > 0) {
      if (!toFetch[region]) toFetch[region] = { app: [], bundle: [], sub: [] };
      for (const item of missing) {
        const type = normalizePriceType(item.type);
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
        const promise = new Promise((resolve, reject) => {
            queue.push({ apiKey, ids: batch, type, region, resolve, reject, onRateLimited: options.onRateLimited });
          }).catch(error => Promise.reject({ error, region, type, ids: batch }));
        fetchPromises.push(promise);
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

  for (const item of items.filter(item => item.type === 'sub')) {
    for (const region of regions) {
      if (readPriceResult(results, item.id, 'sub')?.[region]) continue;
      writeSubFallback(item.id, region);
      if (!results[typedResultKey(item.id, 'sub')]) results[typedResultKey(item.id, 'sub')] = {};
    }
  }

  if (subFallbackIds.size > 0) {
    const warning = `${subFallbackIds.size} Steam package${subFallbackIds.size === 1 ? '' : 's'}: ${subFallbackWarning}`;
    results.error = results.error ? `${results.error}\n${warning}` : warning;
  }
  if (failedBatches.length > 0 && settledBatchResults.every(result => result.status === 'rejected') && subFallbackIds.size === 0) {
    const onlySubsFailed = failedBatches.every(result => result.reason?.type === 'sub');
    if (!onlySubsFailed) throw failedBatches[0].reason?.error ?? failedBatches[0].reason;
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
      const cached = await safeCacheGet(typedPriceKey(item.id, item.type, region));
      if (cached && (item.type !== 'sub' || cached.value?.priceOrigin === SUB_PRICE_ORIGIN)) {
        writePriceResult(results, item.id, item.type, region, { ...cached.value, cachedAt: cached.cachedAt });
      } else if (cached && item.type === 'sub') {
        await cacheDelete(typedPriceKey(item.id, item.type, region));
      }
    }
  }
  return results;
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
