// utils/excluded-pages.js
// URL normalization and matching for personal-page exclusion list

/**
 * Normalize a steamtrades URL to a canonical identifier for exclusion matching.
 * Trade pages (/trade/ID/*) collapse to "trade:ID" so view and edit pages match.
 * All other pages use the pathname only (no query, no fragment).
 */
export function normalizePageUrl(href) {
  try {
    const url = new URL(href);
    const tradeMatch = url.pathname.match(/^\/trade\/(\d+)/);
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
  return list.includes(normalizePageUrl(href));
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
