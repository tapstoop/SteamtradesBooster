// background/resolver.js
import { cacheGet, cacheSet, isDismissed, isDelisted } from './cache.js';
import { normalizeTitle, wordSimilarity } from '../utils/similarity.js';

// Re-export for backwards compatibility and tests
export { normalizeTitle, wordSimilarity };

const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const RESOLVE_TTL = 0; // permanent
const SIMILARITY_THRESHOLD = 0.85; // 85% word overlap for fuzzy matching

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
      return { status: 'delisted', cacheKey: key, appId: String(confirmed.value), title: confirmedTitle?.value };
    }
    const cached = await cacheGet(key);
    if (cached?.value) {
      return { status: 'delisted', cacheKey: key, appId: String(cached.value) };
    }
    return { status: 'delisted', cacheKey: key };
  }

  // Check confirmed user choice
  const confirmed = await cacheGet(`${key}:confirmed`);
  if (confirmed?.value) {
    const confirmedTitle = await cacheGet(`${key}:confirmed:title`);
    return { appId: String(confirmed.value), status: 'hit', cacheKey: key, title: confirmedTitle?.value };
  }

  // Check resolved cache
  const cached = await cacheGet(key);
  if (cached?.value) return { appId: String(cached.value), status: 'hit', cacheKey: key };

  // Fetch from Steam
  const url = `${STEAM_SEARCH}?term=${encodeURIComponent(title)}&l=english&cc=us`;
  let items = [];
  try {
    const resp = await fetch(url);
    if (!resp.ok) return { status: 'not-found', cacheKey: key };
    const data = await resp.json();
    items = data.items ?? [];
  } catch {
    return { status: 'not-found', cacheKey: key };
  }

  if (items.length === 0) return { status: 'not-found', cacheKey: key };

  // Single result or top result matches closely
  if (items.length === 1) {
    await cacheSet(key, String(items[0].id), RESOLVE_TTL);
    return { appId: String(items[0].id), status: 'resolved', cacheKey: key };
  }

  // Check if any result is an exact match — pick it over showing ambiguous
  const normalizedQuery = normalizeTitle(title);
  const exactMatch = items.find(item => normalizeTitle(item.name) === normalizedQuery);
  if (exactMatch) {
    await cacheSet(key, String(exactMatch.id), RESOLVE_TTL);
    return { appId: String(exactMatch.id), status: 'resolved', cacheKey: key };
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
    await cacheSet(key, String(bestMatch.id), RESOLVE_TTL);
    return {
      appId: String(bestMatch.id),
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
    candidates: items.slice(0, 5).map(i => ({ id: String(i.id), name: i.name })),
    cacheKey: key,
  };
}

/** Called when user confirms a candidate from the ? badge dropdown */
export async function confirmResolution(cacheKey, appId, title) {
  await cacheSet(`${cacheKey}:confirmed`, appId, 0);
  if (title) {
    await cacheSet(`${cacheKey}:confirmed:title`, title, 0);
  }
}
