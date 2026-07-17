import { cacheSet, safeCacheGet } from './cache.js';
import { normalizeTitle, normalizeSteamType, wordSimilarity } from '../utils/similarity.js';

export const RESOLUTION_SEARCH_INDEX_KEY = 'resolution_search_index_v1';
export const RESOLUTION_SEARCH_INDEX_VERSION = 1;
export const RESOLUTION_SEARCH_INDEX_LIMIT = 5000;

const VALID_SOURCES = new Set(['automatic', 'profile', 'tradable', 'confirmed']);
const VALID_TYPES = new Set(['app', 'bundle', 'sub']);
let writeChain = Promise.resolve();

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const normalizedTitle = normalizeTitle(String(entry.normalizedTitle ?? entry.displayTitle ?? ''));
  const displayTitle = typeof entry.displayTitle === 'string' ? entry.displayTitle.trim() : '';
  const id = String(entry.id ?? entry.appId ?? '').trim();
  if (!VALID_TYPES.has(entry.type) || !VALID_SOURCES.has(entry.source)) return null;
  const type = normalizeSteamType(entry.type);
  const source = entry.source;
  const updatedAt = Number(entry.updatedAt);
  if (!normalizedTitle || !displayTitle || !/^\d+$/.test(id)) return null;
  return {
    normalizedTitle,
    displayTitle,
    id,
    type,
    source,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : Date.now(),
  };
}

function readEntries(value) {
  if (!value || value.version !== RESOLUTION_SEARCH_INDEX_VERSION || !Array.isArray(value.entries)) return [];
  return value.entries.map(normalizeEntry).filter(Boolean);
}

export async function getResolutionSearchEntries() {
  const cached = await safeCacheGet(RESOLUTION_SEARCH_INDEX_KEY);
  return readEntries(cached?.value);
}

export function upsertResolutionSearchEntry(entry, { limit = RESOLUTION_SEARCH_INDEX_LIMIT } = {}) {
  const normalized = normalizeEntry({ ...entry, updatedAt: entry?.updatedAt ?? Date.now() });
  if (!normalized) return Promise.resolve(false);

  const write = async () => {
    const entries = await getResolutionSearchEntries();
    const retained = entries.filter(item => item.normalizedTitle !== normalized.normalizedTitle);
    retained.push(normalized);
    retained.sort((a, b) => b.updatedAt - a.updatedAt || a.normalizedTitle.localeCompare(b.normalizedTitle));
    await cacheSet(RESOLUTION_SEARCH_INDEX_KEY, {
      version: RESOLUTION_SEARCH_INDEX_VERSION,
      entries: retained.slice(0, Math.max(1, limit)),
    }, 0);
    return true;
  };

  const result = writeChain.then(write, write);
  writeChain = result.catch(() => {});
  return result;
}

export async function searchResolutionIndex(query, { threshold = 0.85 } = {}) {
  const normalizedQuery = normalizeTitle(String(query ?? ''));
  if (!normalizedQuery) return [];
  const sourceRank = { confirmed: 3, tradable: 2, profile: 1, automatic: 0 };
  return (await getResolutionSearchEntries())
    .map(entry => ({ ...entry, similarity: wordSimilarity(normalizedQuery, entry.normalizedTitle) }))
    .filter(entry => entry.similarity >= threshold)
    .sort((a, b) => (
      b.similarity - a.similarity
      || Number(b.normalizedTitle === normalizedQuery) - Number(a.normalizedTitle === normalizedQuery)
      || (sourceRank[b.source] ?? 0) - (sourceRank[a.source] ?? 0)
      || b.updatedAt - a.updatedAt
      || a.normalizedTitle.localeCompare(b.normalizedTitle)
    ));
}
