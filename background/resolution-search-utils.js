import { normalizeSteamType, normalizeTitle } from '../utils/similarity.js';

const BUNDLE_KEYWORDS = /\b(collection|bundle|pack|package|anthology|trilogy|quadrilogy)\b/i;

function stripEditionNoise(title) {
  return title
    .replace(/\s*[-–—:]\s*(deluxe|ultimate|complete|collector'?s|goty|game of the year|definitive|enhanced|gold|premium|standard)\s+edition\b.*$/i, '')
    .replace(/\s*\b(deluxe|ultimate|complete|collector'?s|goty|game of the year|definitive|enhanced|gold|premium|standard)\s+edition\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function readResolutionValue(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    const appId = value.appId ?? value.id;
    if (!/^\d+$/.test(String(appId ?? ''))) return null;
    return { appId: String(appId), type: normalizeSteamType(value.type) };
  }
  if (!/^\d+$/.test(String(value))) return null;
  return { appId: String(value), type: 'app' };
}

export function hasBundleSearchKeyword(title) {
  return BUNDLE_KEYWORDS.test(String(title ?? ''));
}

export function getSearchTerms(title) {
  const terms = [title, stripEditionNoise(title)];
  const punctuationLight = title
    .replace(/[™®]/g, '')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  terms.push(punctuationLight, stripEditionNoise(punctuationLight));

  if (hasBundleSearchKeyword(title)) {
    const withoutKeyword = title.replace(BUNDLE_KEYWORDS, '').replace(/\s+/g, ' ').trim();
    if (withoutKeyword && withoutKeyword.length >= 3) {
      terms.push(withoutKeyword);
      terms.push(`${withoutKeyword} bundle`);
    }
  }

  return [...new Set(terms.filter(term => term && term.length >= 2))];
}

export { normalizeTitle };
