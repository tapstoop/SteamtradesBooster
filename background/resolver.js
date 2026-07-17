// background/resolver.js
import { safeCacheGet, cacheSet, cacheDelete, isDismissed, isDelisted } from './cache.js';
import { normalizeTitle, wordSimilarity, normalizeSteamType } from '../utils/similarity.js';
import { searchSteamStoreTerm } from './steam-search.js';
import { upsertResolutionSearchEntry } from './resolution-search-index.js';
import { discoverSteamBundles } from './steam-bundle-discovery.js';
import {
  getSearchTerms,
  hasBundleSearchKeyword,
  readResolutionValue,
} from './resolution-search-utils.js';

// Re-export for backwards compatibility and tests
export { getSearchTerms, hasBundleSearchKeyword, normalizeTitle, readResolutionValue, wordSimilarity };

const RESOLVE_TTL = 0; // permanent
const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const BUNDLE_SIMILARITY_THRESHOLD = 0.75;
const RESOLVER_VERSION = 2;
let resolverRequestSequence = 0;

function resolutionValue(id, type = 'app', metadata = {}) {
  return { appId: String(id), type: normalizeSteamType(type), ...metadata };
}

function resultFromCache(value, status, cacheKey, extra = {}) {
  const resolved = readResolutionValue(value);
  if (!resolved) return null;
  return { ...resolved, status, cacheKey, ...extra };
}

function candidateFromItem(item) {
  return {
    id: String(item.id),
    name: item.name,
    type: normalizeSteamType(item.type),
  };
}

function automaticResolutionValue(item, match) {
  return resolutionValue(item.id ?? item.appId, item.type, {
    resolverVersion: RESOLVER_VERSION,
    match,
    source: item.source ?? 'store',
  });
}

async function fetchSteamItems(term, options) {
  const result = await searchSteamStoreTerm(term, options);
  return result.items;
}

function nextResolverRequestId() {
  resolverRequestSequence += 1;
  return `resolver-${Date.now()}-${resolverRequestSequence}`;
}

function similarityThreshold(type) {
  return normalizeSteamType(type) === 'bundle'
    ? BUNDLE_SIMILARITY_THRESHOLD
    : DEFAULT_SIMILARITY_THRESHOLD;
}

async function indexResolution(title, item, source = 'automatic') {
  try {
    await upsertResolutionSearchEntry({
      normalizedTitle: normalizeTitle(title),
      displayTitle: item.name || title,
      id: item.id ?? item.appId,
      type: item.type,
      source,
    });
  } catch (err) {
    console.warn('[resolver] Resolution index update failed:', err?.message ?? err);
  }
}

/**
 * @returns {{ appId: string, status: 'hit'|'resolved' }
 *          |{ appId: string, status: 'resolved', fuzzy: true, similarity: number }
 *          |{ status: 'ambiguous', candidates: {id,name}[], cacheKey: string }
 *          |{ status: 'not-found', cacheKey: string }
 *          |{ status: 'dismissed' }}
 */
export async function resolveTitle(title, options = {}) {
  const normalizedTitle = normalizeTitle(title);
  const key = `resolve:${normalizedTitle}`;
  const forceRefresh = options.forceRefresh === true;
  const bundleSearch = hasBundleSearchKeyword(title);

  if (!forceRefresh) {
    // Check if user dismissed this title
    if (await isDismissed(key)) {
      return { status: 'dismissed', cacheKey: key };
    }

    // Check if user marked this as delisted
    if (await isDelisted(key)) {
      // Check if there's a confirmed appId or cached resolution for price display
      const confirmed = await safeCacheGet(`${key}:confirmed`);
      if (confirmed?.value) {
        const confirmedTitle = await safeCacheGet(`${key}:confirmed:title`);
        return resultFromCache(confirmed.value, 'delisted', key, { title: confirmedTitle?.value, confirmed: true });
      }
      const cached = await safeCacheGet(key);
      if (cached?.value) {
        return resultFromCache(cached.value, 'delisted', key);
      }
      return { status: 'delisted', cacheKey: key };
    }

    // Check confirmed user choice
    const confirmed = await safeCacheGet(`${key}:confirmed`);
    if (confirmed?.value) {
      const confirmedTitle = await safeCacheGet(`${key}:confirmed:title`);
      return resultFromCache(confirmed.value, 'hit', key, { title: confirmedTitle?.value, confirmed: true });
    }

    // Check resolved cache
    const cached = await safeCacheGet(key);
    if (cached?.value) {
      const cachedResolution = readResolutionValue(cached.value);
      const legacyBundleApp = bundleSearch
        && cachedResolution?.type === 'app'
        && cached.value?.resolverVersion !== RESOLVER_VERSION;
      if (!legacyBundleApp) return resultFromCache(cached.value, 'hit', key);
      await cacheDelete(key);
    }
  }

  let bestExactMatch = null;
  let bestFuzzyResult = null;
  let bestFuzzyScore = 0;
  let bestAmbiguous = null;
  let bestAmbiguousScore = 0;
  let sawItems = false;
  const appCandidates = new Map();
  const searchOptions = {
    requestId: options.requestId ?? nextResolverRequestId(),
    locale: options.locale,
    country: options.country,
    epoch: options.epoch,
    isEpochCurrent: options.isEpochCurrent,
  };

  for (const term of getSearchTerms(title)) {
    let items;
    try {
      items = await fetchSteamItems(term, searchOptions);
    } catch {
      continue;
    }
    if (items.length === 0) continue;
    sawItems = true;
    for (const item of items) {
      if (normalizeSteamType(item.type) === 'app' && /^\d+$/.test(String(item.id))) {
        appCandidates.set(String(item.id), item);
      }
    }

    const normalizedTerm = normalizeTitle(term);
    const isOriginalTerm = normalizedTerm === normalizedTitle;

    // Exact match for this search term
    const exactMatch = items.find(item => normalizeTitle(item.name) === normalizedTerm);
    if (exactMatch && (isOriginalTerm || !bundleSearch)) {
      // Prefer exact match on the original title; otherwise keep first found
      if (!bestExactMatch || isOriginalTerm) {
        bestExactMatch = { item: exactMatch, isOriginalTerm };
      }
    }

    // Fuzzy match for this term
    let termBestMatch = null;
    let termBestScore = 0;
    for (const item of items) {
      const score = wordSimilarity(bundleSearch ? title : term, item.name);
      if (score > termBestScore) {
        termBestScore = score;
        termBestMatch = item;
      }
      if (score >= similarityThreshold(item.type) && score > bestFuzzyScore) {
        bestFuzzyScore = score;
        bestFuzzyResult = { item, score };
      }
    }

    if (termBestScore > bestAmbiguousScore) {
      bestAmbiguousScore = termBestScore;
      bestAmbiguous = items;
    } else if (!bestAmbiguous) {
      bestAmbiguous = items;
    }
  }

  if (bundleSearch && appCandidates.size > 0) {
    const bundles = await discoverSteamBundles(title, [...appCandidates.values()], searchOptions);
    for (const item of bundles) {
      const itemTitle = normalizeTitle(item.name);
      const score = wordSimilarity(normalizedTitle, itemTitle);
      if (itemTitle === normalizedTitle) {
        if (!bestExactMatch || normalizeSteamType(bestExactMatch.item.type) !== 'bundle') {
          bestExactMatch = { item, isOriginalTerm: true };
        }
        continue;
      }
      if (score >= BUNDLE_SIMILARITY_THRESHOLD && score > bestFuzzyScore) {
        bestFuzzyScore = score;
        bestFuzzyResult = { item, score };
      }
    }
  }

  // Return best exact match if found (on any term, preferring original)
  if (bestExactMatch) {
    const value = automaticResolutionValue(bestExactMatch.item, 'exact');
    const resolved = readResolutionValue(value);
    await cacheSet(key, value, RESOLVE_TTL);
    await indexResolution(title, bestExactMatch.item);
    return { ...resolved, status: 'resolved', cacheKey: key };
  }

  // Return best fuzzy match if found (with sufficient similarity)
  if (bestFuzzyResult) {
    const value = automaticResolutionValue(bestFuzzyResult.item, 'fuzzy');
    const resolved = readResolutionValue(value);
    const requiresConfirmation = bundleSearch || resolved.type === 'bundle';
    if (!requiresConfirmation) await cacheSet(key, value, RESOLVE_TTL);
    await indexResolution(title, bestFuzzyResult.item);
    return {
      ...resolved,
      status: 'resolved',
      fuzzy: true,
      similarity: Math.round(bestFuzzyResult.score * 100),
      title: bestFuzzyResult.item.name,
      cacheKey: key,
    };
  }

  if (!sawItems) return { status: 'not-found', cacheKey: key };
  return {
    status: 'ambiguous',
    candidates: (bestAmbiguous ?? []).slice(0, 5).map(candidateFromItem),
    cacheKey: key,
  };
}

/** Called when user confirms a candidate from the ? badge dropdown */
export async function confirmResolution(cacheKey, appId, title, type = 'app') {
  const value = resolutionValue(appId, type);
  await cacheSet(`${cacheKey}:confirmed`, value, 0);
  if (title) {
    await cacheSet(`${cacheKey}:confirmed:title`, title, 0);
  }
  const normalizedTitle = cacheKey.startsWith('resolve:') ? cacheKey.slice('resolve:'.length) : normalizeTitle(title || '');
  await indexResolution(normalizedTitle, { ...value, name: title || normalizedTitle }, 'confirmed');
}
