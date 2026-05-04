/**
 * Shared similarity utilities for fuzzy matching.
 * Used by both background (resolver.js) and content (parser.js) scripts.
 */

/**
 * Normalize a title for comparison: lowercase, strip punctuation, collapse whitespace.
 */
export function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[™®:'.!?,\-\u2013\u2014]/g, '')  // Also strip en-dash (–) and em-dash (—)
    .replace(/[•●○◆►►\-*]/g, '')  // Strip bullet characters
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate word-overlap similarity between two strings.
 * Returns 0-1 (0 = no overlap, 1 = identical words after normalization)
 * Uses Jaccard similarity on word sets.
 */
export function wordSimilarity(a, b) {
  const wordsA = new Set(normalizeTitle(a).split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(normalizeTitle(b).split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = wordsA.size + wordsB.size - intersection;
  return intersection / union;
}

/**
 * Check if any entry in a set matches the given name with sufficient similarity.
 * @param {string} name - The name to check
 * @param {string[]} set - Array of known entries to match against
 * @param {number} threshold - Minimum similarity (0-1), default 0.9
 * @returns {boolean}
 */
export function fuzzySetMatch(name, set, threshold = 0.9) {
  const normalizedName = normalizeTitle(name);
  for (const entry of set) {
    if (wordSimilarity(normalizedName, normalizeTitle(entry)) >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * Map currency setting to the appropriate region for price lookups.
 * EUR → prefer non-US region, USD → prefer 'us', GBP → prefer 'gb'.
 * @param {{ currency?: string, regions?: string[] }} settings
 * @returns {string} The region code to use for price lookups
 */
export function getDisplayRegion(settings) {
  const currency = settings?.currency ?? 'EUR';
  const regions = settings?.regions ?? ['eu'];
  if (currency === 'USD') return regions.find(r => r === 'us') ?? regions[0];
  if (currency === 'GBP') return regions.find(r => r === 'gb') ?? regions[0];
  // EUR and others: prefer any non-us region
  return regions.find(r => r !== 'us') ?? regions[0];
}
