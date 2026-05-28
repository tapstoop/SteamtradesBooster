// background/resolver.js
import { cacheGet, cacheSet, isDismissed, isDelisted } from './cache.js';
import { normalizeTitle, wordSimilarity } from '../utils/similarity.js';

// Re-export for backwards compatibility and tests
export { normalizeTitle, wordSimilarity };

const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const RESOLVE_TTL = 0; // permanent
const SIMILARITY_THRESHOLD = 0.85; // 85% word overlap for fuzzy matching

function normalizeSteamType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
}

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

function getSearchTerms(title) {
  const terms = [title, stripEditionNoise(title)];
  const punctuationLight = title
    .replace(/[™®]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  terms.push(punctuationLight, stripEditionNoise(punctuationLight));
  return [...new Set(terms.filter(t => t && t.length >= 2))];
}

async function fetchSteamItems(term) {
  const url = `${STEAM_SEARCH}?term=${encodeURIComponent(term)}&l=english&cc=us`;
  const resp = await fetch(url);
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
export async function resolveTitle(title) {
  const key = `resolve:${normalizeTitle(title)}`;

  // Check if user dismissed this title
  if (await isDismissed(key)) {
    return { status: 'dismissed', cacheKey: key };
  }

  // Check if user marked this as delisted
  if (await isDelisted(key)) {
    // Check if there's a confirmed appId or cached resolution for price display
    const confirmed = await cacheGet(`${key}:confirmed`);
    if (confirmed?.value) {
      const confirmedTitle = await cacheGet(`${key}:confirmed:title`);
      return resultFromCache(confirmed.value, 'delisted', key, { title: confirmedTitle?.value });
    }
    const cached = await cacheGet(key);
    if (cached?.value) {
      return resultFromCache(cached.value, 'delisted', key);
    }
    return { status: 'delisted', cacheKey: key };
  }

  // Check confirmed user choice
  const confirmed = await cacheGet(`${key}:confirmed`);
  if (confirmed?.value) {
    const confirmedTitle = await cacheGet(`${key}:confirmed:title`);
    return resultFromCache(confirmed.value, 'hit', key, { title: confirmedTitle?.value });
  }

  // Check resolved cache
  const cached = await cacheGet(key);
  if (cached?.value) return resultFromCache(cached.value, 'hit', key);

  // Fetch from Steam
  let items = [];
  try {
    for (const term of getSearchTerms(title)) {
      items = await fetchSteamItems(term);
      if (items.length > 0) break;
    }
  } catch {
    return { status: 'not-found', cacheKey: key };
  }

  if (items.length === 0) return { status: 'not-found', cacheKey: key };

  // Single result or top result matches closely
  if (items.length === 1) {
    const value = resolutionValue(items[0].id, items[0].type);
    await cacheSet(key, value, RESOLVE_TTL);
    return { ...value, status: 'resolved', cacheKey: key };
  }

  // Check if any result is an exact match — pick it over showing ambiguous
  const normalizedQuery = normalizeTitle(title);
  const exactMatch = items.find(item => normalizeTitle(item.name) === normalizedQuery);
  if (exactMatch) {
    const value = resolutionValue(exactMatch.id, exactMatch.type);
    await cacheSet(key, value, RESOLVE_TTL);
    return { ...value, status: 'resolved', cacheKey: key };
  }

  // No exact match — try fuzzy matching
  let bestMatch = null;
  let bestScore = 0;

  for (const item of items) {
    const score = wordSimilarity(title, item.name);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestMatch && bestScore >= SIMILARITY_THRESHOLD) {
    // High confidence match — auto-resolve with fuzzy status
    const value = resolutionValue(bestMatch.id, bestMatch.type);
    await cacheSet(key, value, RESOLVE_TTL);
    return {
      ...value,
      status: 'resolved',
      fuzzy: true,
      similarity: Math.round(bestScore * 100),
      title: bestMatch.name,
      cacheKey: key
    };
  }

  // No good match — multiple candidates, let user pick
  return {
    status: 'ambiguous',
    candidates: items.slice(0, 5).map(candidateFromItem),
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
