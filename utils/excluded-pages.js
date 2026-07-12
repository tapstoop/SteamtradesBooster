// utils/excluded-pages.js
// URL normalization and matching for personal-page exclusion list

const STEAMTRADES_ORIGIN = 'https://www.steamtrades.com';

function asUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.startsWith('trade:')) return null;
  try {
    return new URL(text, STEAMTRADES_ORIGIN);
  } catch {
    return null;
  }
}

/**
 * Return the pathname used to display a saved SteamTrades page.
 * New entries retain their slug, while legacy trade:<id> entries remain valid.
 */
export function getExcludedPagePath(href) {
  const url = asUrl(href);
  return url?.pathname || String(href ?? '').trim();
}

/**
 * Return the canonical value used to compare an exclusion entry to a page.
 * Stored legacy trade:<id> values are intentionally supported.
 */
export function getExcludedPageKey(href) {
  const value = String(href ?? '').trim();
  if (value.startsWith('trade:')) return value;
  const url = asUrl(value);
  return normalizePageUrl(url ? url.href : value);
}

/**
 * Normalize a steamtrades URL to a canonical identifier for exclusion matching.
 * Trade pages (/trade/ID/*) collapse to "trade:ID" so view and edit pages match.
 * All other pages use the pathname only (no query, no fragment).
 */
export function normalizePageUrl(href) {
  try {
    const url = new URL(href);
    const tradeMatch = url.pathname.match(/^\/trade\/([^/]+)/);
    if (tradeMatch) return `trade:${tradeMatch[1]}`;
    return url.pathname;
  } catch {
    return String(href);
  }
}

/**
 * Check if a page URL is in the exclusion list.
 */
export function isPageExcluded(href, list) {
  if (!Array.isArray(list) || list.length === 0) return false;
  const key = getExcludedPageKey(href);
  return list.some(entry => getExcludedPageKey(entry) === key);
}

/**
 * Check if a URL belongs to steamtrades.com domain.
 * Used to validate URLs before adding to exclusion list.
 */
export function isSteamTradesUrl(href) {
  try {
    const url = new URL(href);
    return url.hostname === 'steamtrades.com' || url.hostname === 'www.steamtrades.com';
  } catch {
    return false;
  }
}
