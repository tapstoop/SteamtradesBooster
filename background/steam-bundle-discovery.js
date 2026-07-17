import { cacheSet, safeCacheGet } from './cache.js';
import { normalizeTitle, wordSimilarity } from '../utils/similarity.js';
import { steamFetch } from './steam-rate-limiter.js';

const APP_BUNDLES_TTL = 86400;
const BUNDLE_METADATA_TTL = 86400 * 7;
const DISCOVERY_TTL = 3600;
const MAX_APP_PAGES = 3;
const MAX_BUNDLE_PAGES = 8;
const MAX_HTML_LENGTH = 2_000_000;
const DISCOVERY_TIMEOUT_MS = 8000;
const SIMILARITY_THRESHOLD = 0.75;

const pendingPages = new Map();
const pageSubscriptions = new Map();
const pendingDiscoveries = new Map();
const requestDiscoveries = new Map();

function appBundlesKey(appId, locale, country) {
  return `steam-related-bundles:v1:${appId}:${locale}:${country}`;
}

function bundleMetadataKey(bundleId, locale, country) {
  return `steam-bundle-metadata:v1:${bundleId}:${locale}:${country}`;
}

function discoveryKey(query, locale, country) {
  return `steam-bundle-discovery:v2:${encodeURIComponent(normalizeTitle(query))}:${locale}:${country}`;
}

function decodeHtml(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const hex = entity[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function cleanHtmlText(value) {
  return decodeHtml(String(value ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function isUsableStoreHtml(html) {
  return typeof html === 'string'
    && html.length > 0
    && html.length <= MAX_HTML_LENGTH
    && !/(?:agegate_birthday_selector|agecheck_form|Please enter your birth date)/i.test(html);
}

export function extractSteamBundleIds(html) {
  if (!isUsableStoreHtml(html)) return null;
  const ids = [];
  const seen = new Set();
  const pattern = /\bhref\s*=\s*["']([^"']{1,1000})["']/gi;
  for (const match of html.matchAll(pattern)) {
    let url;
    try {
      url = new URL(decodeHtml(match[1]), 'https://store.steampowered.com/');
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'store.steampowered.com') continue;
    const id = url.pathname.match(/^\/bundle\/(\d+)(?:\/|$)/)?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function extractSteamBundleTitle(html) {
  if (!isUsableStoreHtml(html)) return null;
  const pageHeader = html.match(/<div[^>]*class=["'][^"']*\bpageheader\b[^"']*["'][^>]*>([\s\S]{1,500}?)<\/div>/i);
  const titleTag = html.match(/<title[^>]*>([\s\S]{1,500}?)<\/title>/i);
  const title = cleanHtmlText(pageHeader?.[1] ?? titleTag?.[1] ?? '').replace(/\s+on Steam$/i, '').trim();
  return title && title.length <= 300 ? title : null;
}

function subscribePage(entry, subscriberId) {
  entry.subscribers.add(subscriberId);
  let entries = pageSubscriptions.get(subscriberId);
  if (!entries) pageSubscriptions.set(subscriberId, entries = new Set());
  entries.add(entry);
}

function unsubscribePage(entry, subscriberId) {
  entry.subscribers.delete(subscriberId);
  const entries = pageSubscriptions.get(subscriberId);
  entries?.delete(entry);
  if (entries?.size === 0) pageSubscriptions.delete(subscriberId);
  if (entry.subscribers.size === 0 && pendingPages.get(entry.key) === entry) entry.controller.abort();
}

function cancelPageSubscriber(subscriberId) {
  for (const entry of [...(pageSubscriptions.get(subscriberId) ?? [])]) unsubscribePage(entry, subscriberId);
}

async function fetchParsedPage({ key, url, subscriberId, parser, ttl }) {
  const cached = await safeCacheGet(key);
  if (cached?.value?.status === 'ok') return cached.value.data;

  let entry = pendingPages.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { key, controller, subscribers: new Set(), promise: null };
    entry.promise = (async () => {
      try {
        const response = await steamFetch(url, { signal: controller.signal }, { kind: 'storepage' });
        if (!response.ok) return null;
        const parsed = parser(await response.text());
        if (parsed == null) return null;
        try {
          await cacheSet(key, { status: 'ok', data: parsed }, ttl);
        } catch {
          // Parsed page caching is best-effort.
        }
        return parsed;
      } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') return null;
        return null;
      } finally {
        if (pendingPages.get(key) === entry) pendingPages.delete(key);
      }
    })();
    pendingPages.set(key, entry);
  }

  subscribePage(entry, subscriberId);
  try {
    return await entry.promise;
  } finally {
    unsubscribePage(entry, subscriberId);
  }
}

async function mapPool(items, worker, { concurrency = 2, shouldStop = () => false } = {}) {
  let cursor = 0;
  async function run() {
    while (cursor < items.length && !shouldStop()) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

async function runDiscovery(entry, query, appCandidates, locale, country) {
  const subscriberId = entry.pageSubscriberId;
  const bundleSources = new Map();
  const apps = appCandidates
    .filter(item => item.type === 'app' && /^\d+$/.test(String(item.id)))
    .filter((item, index, list) => list.findIndex(other => String(other.id) === String(item.id)) === index)
    .slice(0, MAX_APP_PAGES);

  await mapPool(apps, async (app, appIndex) => {
    if (entry.cancelled || entry.timedOut) return;
    const ids = await fetchParsedPage({
      key: appBundlesKey(app.id, locale, country),
      url: `https://store.steampowered.com/app/${encodeURIComponent(app.id)}/?l=${encodeURIComponent(locale)}&cc=${encodeURIComponent(country)}`,
      subscriberId,
      parser: extractSteamBundleIds,
      ttl: APP_BUNDLES_TTL,
    });
    if (ids == null) entry.incomplete = true;
    for (const id of ids ?? []) {
      if (!bundleSources.has(id) && bundleSources.size < MAX_BUNDLE_PAGES) bundleSources.set(id, appIndex);
    }
  }, { shouldStop: () => entry.cancelled || entry.timedOut });

  const normalizedQuery = normalizeTitle(query);
  const matches = entry.matches;
  let exactFound = false;
  await mapPool([...bundleSources], async ([bundleId, appIndex]) => {
    if (entry.cancelled || entry.timedOut || exactFound) return;
    const title = await fetchParsedPage({
      key: bundleMetadataKey(bundleId, locale, country),
      url: `https://store.steampowered.com/bundle/${encodeURIComponent(bundleId)}/?l=${encodeURIComponent(locale)}&cc=${encodeURIComponent(country)}`,
      subscriberId,
      parser: extractSteamBundleTitle,
      ttl: BUNDLE_METADATA_TTL,
    });
    if (!title) {
      entry.incomplete = true;
      return;
    }
    const normalizedTitle = normalizeTitle(title);
    const similarity = wordSimilarity(normalizedQuery, normalizedTitle);
    if (normalizedTitle !== normalizedQuery && similarity < SIMILARITY_THRESHOLD) return;
    matches.push({ id: bundleId, name: title, type: 'bundle', source: 'steam-related-bundle', similarity, appIndex });
    if (normalizedTitle === normalizedQuery) exactFound = true;
  }, { shouldStop: () => entry.cancelled || entry.timedOut || exactFound });

  matches.sort((a, b) => (
    Number(normalizeTitle(b.name) === normalizedQuery) - Number(normalizeTitle(a.name) === normalizedQuery)
    || b.similarity - a.similarity
    || a.appIndex - b.appIndex
    || Number(a.id) - Number(b.id)
  ));
  return matches.map(({ similarity, appIndex, ...candidate }) => candidate);
}

function attachDiscoveryRequest(entry, requestId) {
  entry.subscribers.add(requestId);
  let entries = requestDiscoveries.get(requestId);
  if (!entries) requestDiscoveries.set(requestId, entries = new Set());
  entries.add(entry);
}

function detachDiscoveryRequest(entry, requestId) {
  entry.subscribers.delete(requestId);
  const entries = requestDiscoveries.get(requestId);
  entries?.delete(entry);
  if (entries?.size === 0) requestDiscoveries.delete(requestId);
  if (entry.subscribers.size === 0) {
    entry.cancelled = true;
    cancelPageSubscriber(entry.pageSubscriberId);
  }
}

export async function discoverSteamBundles(query, appCandidates, options = {}) {
  const locale = String(options.locale ?? 'english');
  const country = String(options.country ?? 'us');
  const requestId = String(options.requestId ?? 'anonymous');
  const key = discoveryKey(query, locale, country);
  const cached = await safeCacheGet(key);
  if (Array.isArray(cached?.value)) return cached.value;

  let entry = pendingDiscoveries.get(key);
  if (!entry) {
    entry = {
      key,
      pageSubscriberId: `bundle-discovery:${key}`,
      subscribers: new Set(),
      cancelled: false,
      timedOut: false,
      incomplete: false,
      matches: [],
      promise: null,
    };
    entry.promise = (async () => {
      let timer;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          entry.timedOut = true;
          cancelPageSubscriber(entry.pageSubscriberId);
          resolve(entry.matches.map(({ similarity, appIndex, ...candidate }) => candidate));
        }, DISCOVERY_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([runDiscovery(entry, query, appCandidates, locale, country), timeout]);
        const exactResult = result.some(item => normalizeTitle(item.name) === normalizeTitle(query));
        if (!entry.cancelled && !entry.timedOut && (!entry.incomplete || exactResult)) {
          try { await cacheSet(key, result, DISCOVERY_TTL); } catch { /* best-effort */ }
        }
        return result;
      } finally {
        clearTimeout(timer);
        cancelPageSubscriber(entry.pageSubscriberId);
        if (pendingDiscoveries.get(key) === entry) pendingDiscoveries.delete(key);
      }
    })();
    pendingDiscoveries.set(key, entry);
  }

  attachDiscoveryRequest(entry, requestId);
  try {
    return await entry.promise;
  } finally {
    detachDiscoveryRequest(entry, requestId);
  }
}

export function cancelBundleDiscovery(requestId) {
  const id = String(requestId ?? '');
  for (const entry of [...(requestDiscoveries.get(id) ?? [])]) detachDiscoveryRequest(entry, id);
}

export function cancelAllBundleDiscoveries() {
  for (const requestId of [...requestDiscoveries.keys()]) cancelBundleDiscovery(requestId);
  for (const entry of pendingPages.values()) entry.controller.abort();
  pendingPages.clear();
  pageSubscriptions.clear();
  pendingDiscoveries.clear();
  requestDiscoveries.clear();
}
