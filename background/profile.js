// background/profile.js
import { cacheGet, cacheSet } from './cache.js';
import { normalizeTitle } from './resolver.js';

const WISHLIST_TTL = 1800;
const APP_DETAILS_TTL = 86400 * 7;

function normalizeSteamType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
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
    const resp = await fetch(`https://steamcommunity.com/id/${encodeURIComponent(vanityName)}/?xml=1`);
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
  const cached = await cacheGet(cacheKey);
  return {
    wishlist: cached?.value ?? [],
    tradables: [],
  };
}

export async function fetchProfile(steamIdInput, tradables) {
  console.log('[profile] fetchProfile called with:', steamIdInput);
  const steamId = await parseSteamIdInput(steamIdInput);
  console.log('[profile] Parsed Steam ID:', steamId);
  if (!steamId) {
    console.warn('[profile] Could not parse Steam ID from input:', steamIdInput);
    return { wishlist: [], tradables: parseTradables(tradables), error: 'Invalid Steam ID or profile URL' };
  }
  const wishlist = await fetchWishlist(steamId);
  console.log('[profile] Fetched wishlist, length:', wishlist.length);
  if (Array.isArray(tradables)) {
    for (const item of tradables) {
      if (item?.appId && item?.name) {
        try {
          await cacheTradableResolution(item);
        } catch (err) {
          console.warn('[profile] Failed to cache tradable resolution:', err?.message ?? err);
        }
      }
    }
  }
  return { wishlist, tradables: parseTradables(tradables) };
}

async function cacheTradableResolution(item) {
  const key = `resolve:${normalizeTitle(item.name)}`;
  const confirmed = await cacheGet(`${key}:confirmed`);
  if (confirmed?.value) return;

  const value = resolutionValue(item);
  const cached = await cacheGet(key);
  if (wouldDowngradeResolution(cached?.value, value.type)) return;

  await cacheSet(key, value, 0);
}

async function fetchWishlist(steamId) {
  if (!steamId) return [];
  const cacheKey = `wishlist:${steamId}`;
  const cached = await cacheGet(cacheKey);
  if (cached?.value) {
    console.log('[profile] Using cached wishlist');
    return cached.value;
  }
  const appIds = [];
  try {
    const url = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamId}`;
    console.log('[profile] Fetching wishlist from:', url);
    const resp = await fetch(url);
    console.log('[profile] Wishlist response status:', resp.status);
    if (!resp.ok) {
      console.warn('[profile] Wishlist HTTP error:', resp.status);
      return [];
    }
    const data = await resp.json();
    console.log('[profile] Wishlist data keys:', Object.keys(data));
    const items = data?.response?.items;
    console.log('[profile] Items count:', items?.length);
    if (!items || !Array.isArray(items)) {
      console.warn('[profile] No wishlist items found or private wishlist');
      return [];
    }
    for (const item of items) {
      if (item?.appid) {
        appIds.push(item.appid);
      }
    }
    console.log('[profile] Extracted appIds:', appIds.length);
  } catch (err) {
    console.warn('[profile] Wishlist fetch error:', err.message);
    return [];
  }
  console.log('[profile] Fetching app names for', appIds.length, 'apps');
  const names = await fetchAppNames(appIds);
  console.log('[profile] Got names:', names.length);
  if (names.length > 0) {
    await cacheSet(cacheKey, names, WISHLIST_TTL);
  }
  return names;
}

async function fetchAppNames(appIds) {
  if (!appIds.length) return [];
  console.log('[profile] fetchAppNames called with', appIds.length, 'appIds');
  const names = [];
  const batchSize = 10;
  for (let i = 0; i < appIds.length; i += batchSize) {
    const batch = appIds.slice(i, i + batchSize);
    console.log('[profile] Processing batch', Math.floor(i/batchSize), 'of', Math.ceil(appIds.length/batchSize));
    const results = await Promise.all(batch.map(appId => fetchAppName(appId)));
    console.log('[profile] Batch results:', results.filter(r => r.name).length, 'names found');
    for (const result of results) {
      if (result.name) {
        names.push(result.name);
        await cacheSet(`resolve:${normalizeTitle(result.name)}`, String(result.appId), 0);
      }
    }
  }
  console.log('[profile] Total names found:', names.length);
  return names;
}

async function fetchAppName(appId) {
  const cacheKey = `appname:${appId}`;
  const cached = await cacheGet(cacheKey);
  if (cached?.value) {
    return { appId, name: cached.value };
  }
  try {
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn('[profile] App details HTTP error for', appId, ':', resp.status);
      return { appId, name: null };
    }
    const data = await resp.json();
    const appData = data?.[appId];
    if (appData?.success && appData?.data?.name) {
      const name = appData.data.name;
      await cacheSet(cacheKey, name, APP_DETAILS_TTL);
      return { appId, name };
    } else {
      console.warn('[profile] App details no name for', appId, ':', JSON.stringify(appData));
    }
  } catch (err) {
    console.warn(`[profile] App details fetch error for ${appId}:`, err.message);
  }
  return { appId, name: null };
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
