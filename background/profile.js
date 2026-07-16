// background/profile.js
import { cacheSet, cacheDelete, safeCacheGet } from './cache.js';
import { normalizeTitle } from './resolver.js';
import { normalizeSteamType } from '../utils/similarity.js';
import { steamFetch, mapSteamTasks } from './steam-rate-limiter.js';

const WISHLIST_FINAL_TTL = 1800;
const WISHLIST_PROGRESS_TTL = 86400;
const APP_DETAILS_TTL = 86400 * 7;
const APP_DETAILS_NEGATIVE_TTL = 86400;
const APP_DETAILS_NEGATIVE_MARKER = { status: 'not-found' };

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))];
}

function normalizeWishlistProgress(value) {
  if (!value || typeof value !== 'object' || value.complete !== false) return null;
  const total = Number(value.total);
  if (!Number.isFinite(total) || total < 0) return null;
  if (value.schemaVersion === 2 && Array.isArray(value.resolved)) {
    const resolved = value.resolved
      .map(item => ({
        appId: String(item?.appId ?? ''),
        name: typeof item?.name === 'string' ? item.name.trim() : '',
        type: normalizeSteamType(item?.type ?? 'app'),
      }))
      .filter(item => /^\d+$/.test(item.appId) && item.name);
    return {
      schemaVersion: 2,
      wishlist: uniqueStrings(value.wishlist),
      resolved,
      failedAppIds: Array.isArray(value.failedAppIds) ? value.failedAppIds.map(String) : [],
      completed: Math.max(0, Number(value.completed) || resolved.length),
      total,
      updatedAt: Number(value.updatedAt) || 0,
    };
  }
  if (value.schemaVersion === 1 && Array.isArray(value.wishlist)) {
    return {
      schemaVersion: 1,
      wishlist: uniqueStrings(value.wishlist),
      resolved: [],
      failedAppIds: Array.isArray(value.failedAppIds) ? value.failedAppIds.map(String) : [],
      completed: Math.max(0, Number(value.completed) || 0),
      total,
      updatedAt: Number(value.updatedAt) || 0,
    };
  }
  return null;
}

function normalizeFinalWishlistCache(value) {
  if (value?.schemaVersion === 2 && value.complete === true) {
    if (!Array.isArray(value.wishlist)) return null;
    const names = uniqueStrings(value.wishlist);
    return {
      names,
      complete: true,
      total: Math.max(Number(value.total) || 0, names.length),
      legacy: false,
    };
  }
  if (Array.isArray(value)) {
    const names = uniqueStrings(value);
    return {
      names,
      complete: null,
      total: names.length,
      legacy: true,
    };
  }
  return null;
}


function resolutionValue(item) {
  return { appId: String(item.appId), type: normalizeSteamType(item.type) };
}

function hasTypedResolution(value) {
  return Boolean(value && typeof value === 'object' && (value.appId || value.id) && value.type);
}

function wouldDowngradeResolution(existingValue, nextType) {
  return hasTypedResolution(existingValue)
    && normalizeSteamType(existingValue.type) !== 'app'
    && nextType === 'app';
}

export function extractSteamId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^\d{17}$/.test(trimmed)) {
    return trimmed;
  }
  const profileMatch = trimmed.match(/steamcommunity\.com\/profiles\/(\d{17})/);
  if (profileMatch) {
    return profileMatch[1];
  }
  const idMatch = trimmed.match(/steamcommunity\.com\/id\/([^/]+)/);
  if (idMatch) {
    return null;
  }
  if (/^\d{17}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export async function resolveVanityUrl(vanityUrl) {
  const match = vanityUrl.match(/steamcommunity\.com\/id\/([^/]+)/);
  if (!match) return null;
  const vanityName = match[1];
  try {
    const resp = await steamFetch(`https://steamcommunity.com/id/${encodeURIComponent(vanityName)}/?xml=1`, {}, { kind: 'vanity' });
    if (!resp.ok) return null;
    const text = await resp.text();
    const idMatch = text.match(/<steamID64>(\d{17})<\/steamID64>/);
    if (idMatch) return idMatch[1];
  } catch (err) {
    console.warn('[profile] ResolveVanityURL error:', err.message);
  }
  return null;
}

export async function parseSteamIdInput(input) {
  if (!input) return null;
  const directId = extractSteamId(input);
  if (directId) return directId;
  if (input.includes('/id/')) {
    const resolved = await resolveVanityUrl(input);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Get cached profile data without making any API calls.
 * Returns { wishlist, tradables } from cache only.
 */
export async function getCachedProfile(steamId) {
  if (!steamId) return { wishlist: [], tradables: [] };
  const cacheKey = `wishlist:${steamId}`;
  const cached = await safeCacheGet(cacheKey);
  const progress = await safeCacheGet(`wishlist-progress:${steamId}`);
  const partial = normalizeWishlistProgress(progress?.value);
  const finalCache = normalizeFinalWishlistCache(cached?.value);
  const wishlist = partial ? [] : (finalCache?.names ?? []);
  return {
    wishlist,
    partialWishlist: partial?.wishlist ?? [],
    partialMeta: partial,
    tradables: [],
  };
}

export async function fetchProfile(steamIdInput, tradables, { onWishlistProgress, shouldCommit = () => true, forceRefresh = false } = {}) {
  console.log('[profile] fetchProfile called with:', steamIdInput);
  const steamId = await parseSteamIdInput(steamIdInput);
  console.log('[profile] Parsed Steam ID:', steamId);
  if (!steamId) {
    console.warn('[profile] Could not parse Steam ID from input:', steamIdInput);
    return {
      wishlist: [],
      tradables: parseTradables(tradables),
      profileComplete: false,
      failedAppIds: [],
      wishlistTotal: 0,
      error: 'Invalid Steam ID or profile URL',
    };
  }
  const wishlistResult = await fetchWishlist(steamId, { onProgress: onWishlistProgress, shouldCommit, forceRefresh });
  const wishlist = wishlistResult.names;
  console.log('[profile] Fetched wishlist, length:', wishlist.length);
  if (Array.isArray(tradables)) {
    for (const item of tradables) {
      if (item?.appId && item?.name && shouldCommit()) {
        try {
          await cacheTradableResolution(item, shouldCommit);
        } catch (err) {
          console.warn('[profile] Failed to cache tradable resolution:', err?.message ?? err);
        }
      }
    }
  }
  return {
    wishlist,
    tradables: parseTradables(tradables),
    profileComplete: wishlistResult.complete,
    failedAppIds: wishlistResult.failedAppIds,
    wishlistTotal: wishlistResult.total,
  };
}

async function cacheTradableResolution(item, shouldCommit = () => true) {
  if (!shouldCommit()) return;
  const key = `resolve:${normalizeTitle(item.name)}`;
  const confirmed = await safeCacheGet(`${key}:confirmed`);
  if (!shouldCommit()) return;
  if (confirmed?.value) return;

  const value = resolutionValue(item);
  const cached = await safeCacheGet(key);
  if (!shouldCommit()) return;
  if (wouldDowngradeResolution(cached?.value, value.type)) return;

  if (!shouldCommit()) return;
  await cacheSet(key, value, 0);
}

async function fetchWishlist(steamId, { onProgress, shouldCommit = () => true, forceRefresh = false } = {}) {
  if (!steamId) return { names: [], complete: false, failedAppIds: [], total: 0 };
  const cacheKey = `wishlist:${steamId}`;
  const cached = await safeCacheGet(cacheKey);
  const progressCache = await safeCacheGet(`wishlist-progress:${steamId}`);
  const progress = normalizeWishlistProgress(progressCache?.value);
  const finalCache = normalizeFinalWishlistCache(cached?.value);
  if (!forceRefresh && finalCache?.complete === true) {
    console.log('[profile] Using cached wishlist');
    return { names: finalCache.names, complete: true, failedAppIds: [], total: finalCache.total };
  }
  if (!forceRefresh && finalCache?.legacy && finalCache.names.length && !progress) {
    console.log('[profile] Using legacy cached wishlist');
    return { names: finalCache.names, complete: true, failedAppIds: [], total: finalCache.total };
  }
  const appIds = [];
  try {
    const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`;
    console.log('[profile] Fetching wishlist from:', url);
    const resp = await steamFetch(url, {}, { kind: 'wishlist' });
    console.log('[profile] Wishlist response status:', resp.status);
    if (!resp.ok) {
      console.warn('[profile] Wishlist HTTP error:', resp.status);
      return { names: [], complete: false, failedAppIds: [], total: 0 };
    }
    const data = await resp.json();
    console.log('[profile] Wishlist data keys:', Object.keys(data));
    const items = data?.response?.items;
    console.log('[profile] Items count:', items?.length);
    if (!items || !Array.isArray(items)) {
      console.warn('[profile] No wishlist items found or private wishlist');
      return { names: [], complete: false, failedAppIds: [], total: 0 };
    }
    for (const item of items) {
      if (item?.appid) {
        appIds.push(item.appid);
      }
  }
  console.log('[profile] Extracted appIds:', appIds.length);
  } catch (err) {
    console.warn('[profile] Wishlist fetch error:', err.message);
    return { names: [], complete: false, failedAppIds: [], total: 0 };
  }
  const total = new Set(appIds.map(appId => String(appId))).size;
  if (appIds.length === 0) {
    await safeProgress(onProgress, { wishlist: [], completed: 0, total: 0, done: true, complete: true });
    if (shouldCommit()) {
      await bestEffortCacheSet(cacheKey, {
        schemaVersion: 2,
        complete: true,
        wishlist: [],
        total: 0,
        failedAppIds: [],
        updatedAt: Date.now(),
      }, WISHLIST_FINAL_TTL, shouldCommit);
      await bestEffortCacheDelete(`wishlist-progress:${steamId}`, shouldCommit);
    }
    return { names: [], complete: true, failedAppIds: [], total: 0 };
  }
  if (!forceRefresh && progress) {
    await safeProgress(onProgress, {
      wishlist: progress.wishlist,
      completed: progress.completed,
      total,
      done: false,
      resumed: true,
      complete: false,
      failedAppIds: progress.failedAppIds,
      resolved: progress.resolved,
    });
  }
  console.log('[profile] Fetching app names for', appIds.length, 'apps');
  const result = await fetchAppNames(appIds, { onProgress, steamId, progress: forceRefresh ? null : progress, shouldCommit });
  const names = result.names;
  await safeProgress(onProgress, {
    wishlist: names,
    completed: result.completed,
    total,
    done: true,
    complete: result.complete,
    failedAppIds: result.failedAppIds,
    resolved: result.resolved,
  });
  console.log('[profile] Got names:', names.length);
  if (result.complete) {
    if (names.length > 0) {
      await bestEffortCacheSet(cacheKey, {
        schemaVersion: 2,
        complete: true,
        wishlist: names,
        total,
        failedAppIds: [],
        updatedAt: Date.now(),
      }, WISHLIST_FINAL_TTL, shouldCommit);
    }
    await bestEffortCacheDelete(`wishlist-progress:${steamId}`, shouldCommit);
  }
  return { names, complete: result.complete, failedAppIds: result.failedAppIds, total };
}

async function fetchAppNames(appIds, { onProgress, steamId, progress = null, shouldCommit = () => true } = {}) {
  if (!appIds.length) return { names: [], completed: 0, complete: true, failedAppIds: [] };
  console.log('[profile] fetchAppNames called with', appIds.length, 'appIds');
  const uniqueAppIds = [...new Set(appIds.map(appId => String(appId)))];
  const resultsByAppId = new Map();
  const resolutionCacheNames = new Set();
  const failedAppIds = new Set();
  const currentAppIds = new Set(uniqueAppIds);
  if (progress?.schemaVersion === 2) {
    for (const item of progress.resolved) {
      if (!currentAppIds.has(item.appId)) continue;
      resultsByAppId.set(item.appId, { appId: item.appId, name: item.name, status: 'resolved' });
    }
  }
  let completed = resultsByAppId.size;
  let progressChain = Promise.resolve();
  const pendingAppIds = uniqueAppIds.filter(appId => !resultsByAppId.has(appId));

  const persistProgress = async (completedAt) => {
    const snapshot = uniqueAppIds
      .map(id => resultsByAppId.get(id)?.name)
      .filter(Boolean);
    await bestEffortCacheSet(`wishlist-progress:${steamId}`, {
      wishlist: snapshot,
      schemaVersion: 2,
      complete: false,
      total: uniqueAppIds.length,
      completed: completedAt,
      resolved: [...resultsByAppId.entries()]
        .filter(([, item]) => item.status === 'resolved')
        .map(([id, item]) => ({ appId: id, name: item.name, type: 'app' })),
      failedAppIds: [...failedAppIds],
      updatedAt: Date.now(),
    }, WISHLIST_PROGRESS_TTL, shouldCommit);
    await safeProgress(onProgress, {
      wishlist: snapshot,
      completed: completedAt,
      total: uniqueAppIds.length,
      done: false,
      complete: false,
      failedAppIds: [...failedAppIds],
      resolved: [...resultsByAppId.entries()]
        .filter(([, item]) => item.status === 'resolved')
        .map(([id, item]) => ({ appId: id, name: item.name, type: 'app' })),
    });
  };

  if (completed > 0 && pendingAppIds.length > 0) {
    progressChain = progressChain.then(() => persistProgress(completed));
  }

  await mapSteamTasks(pendingAppIds, appId => fetchAppName(appId, { shouldCommit }), {
    concurrency: 2,
    onSettled: result => {
      completed++;
      const completedAt = completed;
      resultsByAppId.set(String(result.appId), result);
      if (result.status !== 'resolved') failedAppIds.add(String(result.appId));
      progressChain = progressChain.then(async () => {
        if (result.name) {
          const resolutionKey = normalizeTitle(result.name);
          if (!resolutionCacheNames.has(resolutionKey)) {
            resolutionCacheNames.add(resolutionKey);
            await bestEffortCacheSet(`resolve:${resolutionKey}`, String(result.appId), 0, shouldCommit);
          }
        }
        await persistProgress(completedAt);
      });
    },
  });
  await progressChain;
  const names = uniqueAppIds.map(id => resultsByAppId.get(id)?.name).filter(Boolean);
  console.log('[profile] Total names found:', names.length);
  return {
    names,
    completed,
    complete: failedAppIds.size === 0 && names.length === uniqueAppIds.length,
    failedAppIds: [...failedAppIds],
    resolved: [...resultsByAppId.entries()]
      .filter(([, item]) => item.status === 'resolved')
      .map(([id, item]) => ({ appId: id, name: item.name, type: 'app' })),
  };
}

async function fetchAppName(appId, { shouldCommit = () => true } = {}) {
  const cacheKey = `appname:${appId}`;
  const cached = await safeCacheGet(cacheKey);
  if (typeof cached?.value === 'string' && cached.value.trim()) {
    return { appId, name: cached.value.trim(), status: 'resolved' };
  }
  if (cached?.value && typeof cached.value === 'object' && cached.value.status === 'not-found') {
    return { appId, name: null, status: 'not-found' };
  }
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
    const resp = await steamFetch(url, {}, { kind: 'appdetails' });
    if (!resp.ok) {
      console.warn('[profile] App details HTTP error for', appId, ':', resp.status);
      if (resp.status === 404) {
        await bestEffortCacheSet(cacheKey, APP_DETAILS_NEGATIVE_MARKER, APP_DETAILS_NEGATIVE_TTL, shouldCommit);
        return { appId, name: null, status: 'not-found' };
      }
      return { appId, name: null, status: 'failed' };
    }
    const data = await resp.json();
    const appData = data?.[appId];
    if (appData?.success && appData?.data?.name) {
      const name = appData.data.name;
      await bestEffortCacheSet(cacheKey, name, APP_DETAILS_TTL, shouldCommit);
      return { appId, name, status: 'resolved' };
    } else {
      console.warn('[profile] App details no name for', appId, ':', JSON.stringify(appData));
      await bestEffortCacheSet(cacheKey, APP_DETAILS_NEGATIVE_MARKER, APP_DETAILS_NEGATIVE_TTL, shouldCommit);
      return { appId, name: null, status: 'not-found' };
    }
  } catch (err) {
    console.warn(`[profile] App details fetch error for ${appId}:`, err.message);
  }
  return { appId, name: null, status: 'failed' };
}

async function bestEffortCacheSet(key, value, ttlSeconds, shouldCommit = () => true) {
  try {
    if (!shouldCommit()) return;
    await cacheSet(key, value, ttlSeconds);
  } catch (err) {
    console.warn('[profile] Cache write failed:', key, err?.message ?? err);
  }
}

async function safeProgress(onProgress, value) {
  try {
    await onProgress?.(value);
  } catch (err) {
    console.warn('[profile] Progress notification failed:', err?.message ?? err);
  }
}

async function bestEffortCacheDelete(key, shouldCommit = () => true) {
  try {
    if (!shouldCommit()) return;
    await cacheDelete(key);
  } catch (err) {
    console.warn('[profile] Cache delete failed:', key, err?.message ?? err);
  }
}

function parseTradables(tradables) {
  if (Array.isArray(tradables)) {
    return tradables
      .map(item => (typeof item === 'string' ? item : item?.name))
      .filter(Boolean);
  }
  if (!tradables) return [];
  return String(tradables).split('\n').map(t => t.trim()).filter(t => t.length > 1);
}
