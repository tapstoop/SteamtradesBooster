import { cacheSet, safeCacheGet } from './cache.js';
import { getSearchTerms, hasBundleSearchKeyword, normalizeTitle, readResolutionValue } from './resolution-search-utils.js';
import { searchResolutionIndex } from './resolution-search-index.js';
import {
  cancelAllBundleDiscoveries,
  cancelBundleDiscovery,
  discoverSteamBundles,
} from './steam-bundle-discovery.js';
import { normalizeSteamType } from '../utils/similarity.js';
import { steamFetch } from './steam-rate-limiter.js';

const SEARCH_CACHE_TTL = 45;
const CANCELLED_SEARCH_TTL_MS = 60_000;
const CANCELLED_SEARCH_LIMIT = 500;
const pendingSearches = new Map();
const searchSubscribers = new Map();
const cancelledRequests = new Map();

function pruneCancelledRequests() {
  const now = Date.now();
  for (const [requestId, cancelledAt] of cancelledRequests) {
    if (now - cancelledAt > CANCELLED_SEARCH_TTL_MS) cancelledRequests.delete(requestId);
  }
  while (cancelledRequests.size > CANCELLED_SEARCH_LIMIT) {
    const oldest = cancelledRequests.keys().next().value;
    if (oldest == null) break;
    cancelledRequests.delete(oldest);
  }
}

function createRequestId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `steam-search-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function searchCacheKey(query, locale, country) {
  return `steam-search:v1:${encodeURIComponent(query.toLocaleLowerCase())}:${locale}:${country}`;
}

function normalizeItems(data) {
  if (!Array.isArray(data?.items)) return null;
  return data.items.slice(0, 10).map(item => ({
    ...item,
    id: String(item.id ?? item.appid ?? ''),
    name: typeof item.name === 'string' ? item.name.trim() : '',
    type: normalizeSteamType(item.type ?? 'app'),
    source: 'store',
  })).filter(item => item.id && item.name);
}

function isEpochCurrent(options, epoch) {
  return typeof options.isEpochCurrent !== 'function' || options.isEpochCurrent(epoch);
}

function getSearchEntry(query, locale, country, options) {
  const cacheKey = searchCacheKey(query, locale, country);
  const epoch = options.epoch;
  let entry = pendingSearches.get(cacheKey);
  if (entry && entry.epoch === epoch) return entry;

  const controller = new AbortController();
  entry = { cacheKey, epoch, controller, subscribers: new Set(), cancelled: false, promise: null };
  entry.promise = (async () => {
    try {
      const url = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=${encodeURIComponent(locale)}&cc=${encodeURIComponent(country)}`;
      const resp = await steamFetch(url, { signal: controller.signal }, { kind: 'storesearch' });
      if (!resp.ok || entry.cancelled || !isEpochCurrent(options, epoch)) return { items: [], cancelled: entry.cancelled };
      const items = normalizeItems(await resp.json());
      if (!items || entry.cancelled || !isEpochCurrent(options, epoch)) return { items: [] };
      try {
        await cacheSet(cacheKey, items, SEARCH_CACHE_TTL);
      } catch {
        // Raw search caching is best-effort.
      }
      return { items };
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return { items: [], cancelled: true };
      return { items: [] };
    } finally {
      if (pendingSearches.get(cacheKey) === entry) pendingSearches.delete(cacheKey);
      for (const requestId of entry.subscribers) searchSubscribers.delete(requestId);
      entry.subscribers.clear();
    }
  })();
  pendingSearches.set(cacheKey, entry);
  return entry;
}

export async function searchSteamStoreTerm(query, options = {}) {
  const term = String(query ?? '').trim();
  if (term.length < 2) return { items: [] };
  const locale = String(options.locale ?? 'english');
  const country = String(options.country ?? 'us');
  const requestId = String(options.requestId ?? createRequestId());
  pruneCancelledRequests();
  if (cancelledRequests.has(requestId)) return { items: [], cancelled: true };

  const cacheKey = searchCacheKey(term, locale, country);
  const cached = await safeCacheGet(cacheKey);
  if (Array.isArray(cached?.value)) {
    const items = normalizeItems({ items: cached.value });
    if (items) return { items };
  }

  const entry = getSearchEntry(term, locale, country, options);
  entry.subscribers.add(requestId);
  searchSubscribers.set(requestId, entry);
  const result = await entry.promise;
  if (!isEpochCurrent(options, entry.epoch) || cancelledRequests.has(requestId)) {
    cancelledRequests.delete(requestId);
    return { items: [], cancelled: true };
  }
  return result?.cancelled ? { items: [], cancelled: true } : { items: result?.items ?? [] };
}

async function exactCacheCandidate(query) {
  const key = `resolve:${normalizeTitle(query)}`;
  const [automatic, confirmed, confirmedTitle] = await Promise.all([
    safeCacheGet(key),
    safeCacheGet(`${key}:confirmed`),
    safeCacheGet(`${key}:confirmed:title`),
  ]);
  const selected = confirmed?.value ? confirmed : automatic;
  const resolution = readResolutionValue(selected?.value);
  if (!resolution) return null;
  const storedTitle = typeof confirmedTitle?.value === 'string' ? confirmedTitle.value.trim() : '';
  return {
    id: resolution.appId,
    name: storedTitle || query,
    type: resolution.type,
    source: 'resolver-cache',
    confirmed: Boolean(confirmed?.value),
  };
}

function addCandidate(target, candidate, { replace = false } = {}) {
  if (!candidate?.id || !candidate?.name) return;
  const key = `${normalizeSteamType(candidate.type)}:${String(candidate.id)}`;
  if (!target.has(key) || replace) target.set(key, candidate);
}

export async function searchSteam(message, options = {}) {
  const query = String(message?.query ?? '').trim();
  if (query.length < 2) return { items: [] };
  const limit = Math.max(1, Number(message.limit) || 10);
  const requestId = String(message.requestId ?? createRequestId());
  const searchOptions = {
    requestId,
    locale: message.locale ?? 'english',
    country: message.country ?? 'us',
    epoch: options.epoch,
    isEpochCurrent: options.isEpochCurrent,
  };

  const exactCache = await exactCacheCandidate(query);
  const indexedCandidates = await searchResolutionIndex(query);
  const storeCandidates = new Map();
  for (const term of getSearchTerms(query)) {
    const exactKey = exactCache ? `${exactCache.type}:${exactCache.id}` : null;
    const distinctCount = storeCandidates.size + Number(exactKey && !storeCandidates.has(exactKey));
    if (distinctCount >= limit) break;
    const result = await searchSteamStoreTerm(term, searchOptions);
    if (result.cancelled) return { items: [], cancelled: true };
    for (const item of result.items) addCandidate(storeCandidates, item);
  }

  let discoveredBundles = [];
  const hasLocalBundle = exactCache?.type === 'bundle'
    || indexedCandidates.some(entry => entry.type === 'bundle' && normalizeTitle(entry.displayTitle) === normalizeTitle(query));
  const discoveryApps = [...storeCandidates.values()].filter(item => item.type === 'app');
  if (hasBundleSearchKeyword(query) && !hasLocalBundle && discoveryApps.length > 0) {
    if (cancelledRequests.has(requestId)) return { items: [], cancelled: true };
    discoveredBundles = await discoverSteamBundles(query, discoveryApps, searchOptions);
    if (cancelledRequests.has(requestId)) return { items: [], cancelled: true };
  }

  const merged = new Map();
  addCandidate(merged, exactCache);
  const normalizedQuery = normalizeTitle(query);
  for (const item of storeCandidates.values()) {
    if (normalizeTitle(item.name) === normalizedQuery) addCandidate(merged, item);
  }
  for (const item of discoveredBundles) addCandidate(merged, item);
  for (const item of storeCandidates.values()) addCandidate(merged, item);

  for (const entry of indexedCandidates) {
    const candidate = {
      id: entry.id,
      name: entry.displayTitle,
      type: entry.type,
      source: 'resolver-cache',
    };
    const key = `${candidate.type}:${candidate.id}`;
    addCandidate(merged, candidate, { replace: merged.get(key)?.source === 'store' });
  }

  return { items: [...merged.values()].slice(0, limit) };
}

export function cancelSteamSearch(requestId) {
  const id = String(requestId ?? '');
  if (!id) return;
  pruneCancelledRequests();
  cancelledRequests.set(id, Date.now());
  cancelBundleDiscovery(id);
  const entry = searchSubscribers.get(id);
  if (!entry) return;
  entry.subscribers.delete(id);
  searchSubscribers.delete(id);
  if (entry.subscribers.size === 0) {
    entry.cancelled = true;
    entry.controller.abort();
  }
}

export function cancelAllSteamSearches() {
  cancelAllBundleDiscoveries();
  for (const entry of pendingSearches.values()) {
    entry.cancelled = true;
    entry.controller.abort();
  }
  pendingSearches.clear();
  searchSubscribers.clear();
  cancelledRequests.clear();
}
