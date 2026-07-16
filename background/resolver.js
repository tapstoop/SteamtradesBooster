// background/resolver.js
import { safeCacheGet, cacheSet, isDismissed, isDelisted } from './cache.js';
import { normalizeTitle, wordSimilarity, normalizeSteamType } from '../utils/similarity.js';
import { steamFetch } from './steam-rate-limiter.js';

// Re-export for backwards compatibility and tests
export { normalizeTitle, wordSimilarity };

const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const RESOLVE_TTL = 0; // permanent
const SIMILARITY_THRESHOLD = 0.85; // 85% word overlap for fuzzy matching
function resolutionValue(id, type = 'app') {
  return { appId: String(id), type: normalizeSteamType(type) };
}

function readResolutionValue(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    const appId = value.appId ?? value.id;
    if (!appId) return null;
    return { appId: String(appId), type: normalizeSteamType(value.type) };
  }
  return { appId: String(value), type: 'app' };
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

function stripEditionNoise(title) {
  return title
    .replace(/\s*[-–—:]\s*(deluxe|ultimate|complete|collector'?s|goty|game of the year|definitive|enhanced|gold|premium|standard)\s+edition\b.*$/i, '')
    .replace(/\s*\b(deluxe|ultimate|complete|collector'?s|goty|game of the year|definitive|enhanced|gold|premium|standard)\s+edition\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const BUNDLE_KEYWORDS = /\b(collection|bundle|pack|package|anthology|trilogy|quadrilogy)\b/i;

function getSearchTerms(title) {
  const terms = [title, stripEditionNoise(title)];
  const punctuationLight = title
    .replace(/[™®]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  terms.push(punctuationLight, stripEditionNoise(punctuationLight));

  const bundleMatch = title.match(BUNDLE_KEYWORDS);
  if (bundleMatch) {
    const withoutKeyword = title.replace(BUNDLE_KEYWORDS, '').replace(/\s+/g, ' ').trim();
    if (withoutKeyword && withoutKeyword.length >= 3) {
      terms.push(`${withoutKeyword} bundle`);
    }
  }

  return [...new Set(terms.filter(t => t && t.length >= 2))];
}

async function fetchSteamItems(term) {
  const url = `${STEAM_SEARCH}?term=${encodeURIComponent(term)}&l=english&cc=us`;
  const resp = await steamFetch(url, {}, { kind: 'storesearch' });
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.items ?? [];
}

/**
 * @returns {{ appId: string, status: 'hit'|'resolved' }
 *          |{ appId: string, status: 'resolved', fuzzy: true, similarity: number }
 *          |{ status: 'ambiguous', candidates: {id,name}[], cacheKey: string }
 *          |{ status: 'not-found', cacheKey: string }
 *          |{ status: 'dismissed' }}
 */
export async function resolveTitle(title, options = {}) {
  const key = `resolve:${normalizeTitle(title)}`;
  const forceRefresh = options.forceRefresh === true;

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
    if (cached?.value) return resultFromCache(cached.value, 'hit', key);
  }

  let bestExactMatch = null;
  let bestFuzzyResult = null;
  let bestFuzzyScore = 0;
  let bestAmbiguous = null;
  let bestAmbiguousScore = 0;
  let sawItems = false;

  for (const term of getSearchTerms(title)) {
    let items;
    try {
      items = await fetchSteamItems(term);
    } catch {
      continue;
    }
    if (items.length === 0) continue;
    sawItems = true;

    const normalizedTerm = normalizeTitle(term);
    const isOriginalTerm = normalizedTerm === normalizeTitle(title);

    // Exact match for this search term
    const exactMatch = items.find(item => normalizeTitle(item.name) === normalizedTerm);
    if (exactMatch) {
      // Prefer exact match on the original title; otherwise keep first found
      if (!bestExactMatch || isOriginalTerm) {
        bestExactMatch = { item: exactMatch, isOriginalTerm };
      }
    }

    // Fuzzy match for this term
    let termBestMatch = null;
    let termBestScore = 0;
    for (const item of items) {
      const score = wordSimilarity(term, item.name);
      if (score > termBestScore) {
        termBestScore = score;
        termBestMatch = item;
      }
    }

    if (termBestMatch && termBestScore >= SIMILARITY_THRESHOLD) {
      if (termBestScore > bestFuzzyScore || (!bestFuzzyResult && !bestExactMatch)) {
        bestFuzzyScore = termBestScore;
        bestFuzzyResult = { item: termBestMatch, score: termBestScore, isOriginalTerm };
      }
    }

    if (termBestScore > bestAmbiguousScore) {
      bestAmbiguousScore = termBestScore;
      bestAmbiguous = items;
    } else if (!bestAmbiguous) {
      bestAmbiguous = items;
    }
  }

  // Return best exact match if found (on any term, preferring original)
  if (bestExactMatch) {
    const value = resolutionValue(bestExactMatch.item.id, bestExactMatch.item.type);
    await cacheSet(key, value, RESOLVE_TTL);
    return { ...value, status: 'resolved', cacheKey: key };
  }

  // Return best fuzzy match if found (with sufficient similarity)
  if (bestFuzzyResult) {
    const value = resolutionValue(bestFuzzyResult.item.id, bestFuzzyResult.item.type);
    await cacheSet(key, value, RESOLVE_TTL);
    return {
      ...value,
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
  await cacheSet(`${cacheKey}:confirmed`, resolutionValue(appId, type), 0);
  if (title) {
    await cacheSet(`${cacheKey}:confirmed:title`, title, 0);
  }
}
