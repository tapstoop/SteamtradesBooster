// background/ggdeals.js
import { cacheGet, cacheSet } from './cache.js';

const PRICE_TTL = 0; // Permanent until manual refresh
const BASE_URL = 'https://api.gg.deals/v1';

const rateLimitState = {
  remaining: 100,
  resetAt: 0,
};

const queue = [];
let processingQueue = false;

function priceKey(appId, region) {
  return `price:${appId}:${region}`;
}

function updateRateLimit(resp) {
  const remaining = parseInt(resp.headers.get('x-ratelimit-remaining') ?? '100');
  const resetAt = parseInt(resp.headers.get('x-ratelimit-reset') ?? '0') * 1000;
  rateLimitState.remaining = remaining;
  rateLimitState.resetAt = resetAt;
}

async function fetchBatch(apiKey, appIds, region) {
  const url = `${BASE_URL}/prices/by-steam-app-id/?ids=${appIds.join(',')}&key=${apiKey}&region=${region}`;
  const resp = await fetch(url);

  updateRateLimit(resp);

  if (resp.status === 429) {
    throw { rateLimited: true, resetAt: rateLimitState.resetAt };
  }
  if (!resp.ok) throw new Error(`GG.deals API error: ${resp.status}`);

  const json = await resp.json();
  const data = json.data ?? {};
  const converted = {};
  for (const [id, priceData] of Object.entries(data)) {
    if (priceData && priceData.prices) {
      converted[id] = {
        title: priceData.title,
        url: priceData.url,
        prices: {
          currentRetail: parsePriceToCents(priceData.prices.currentRetail),
          currentKeyshops: parsePriceToCents(priceData.prices.currentKeyshops),
          historicalRetail: parsePriceToCents(priceData.prices.historicalRetail),
          historicalKeyshops: parsePriceToCents(priceData.prices.historicalKeyshops),
          currency: priceData.prices.currency,
        }
      };
    }
  }
  return converted;
}

function parsePriceToCents(priceStr) {
  if (priceStr == null) return null;
  const num = parseFloat(priceStr);
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

async function processQueue() {
  if (processingQueue || queue.length === 0) return;
  processingQueue = true;

  try {
    while (queue.length > 0) {
      if (rateLimitState.remaining <= 0 && rateLimitState.resetAt > Date.now()) {
        const wait = rateLimitState.resetAt - Date.now() + 200;
        await new Promise(r => setTimeout(r, Math.max(200, wait)));
      }

      const job = queue.shift();
      try {
        const data = await fetchBatch(job.apiKey, job.appIds, job.region);
        for (const [id, priceData] of Object.entries(data)) {
          if (priceData) {
            await cacheSet(priceKey(id, job.region), priceData, PRICE_TTL);
          }
        }
        job.resolve({ region: job.region, data });
      } catch (err) {
        if (err.rateLimited) {
          queue.unshift(job);
          const rawWait = (err.resetAt || Date.now() + 60000) - Date.now() + 200;
          await new Promise(r => setTimeout(r, Math.max(200, rawWait)));
        } else {
          job.reject(err);
        }
      }
    }
  } finally {
    processingQueue = false;
  }
}

export async function getPrices(apiKey, appIds, regions) {
  const results = {};
  const toFetch = {};
  const subAppMap = {}; // Map Sub ID -> contained App IDs

  // First, check for Sub IDs and resolve them to their contained apps
  for (const id of appIds) {
    // Try to get apps contained in this sub/bundle
    const subApps = await getSubApps(id);
    if (subApps && subApps.length > 0) {
      subAppMap[id] = subApps;
      // Add contained apps to the fetch list (we'll use their prices for the sub)
      for (const region of regions) {
        if (!toFetch[region]) toFetch[region] = [];
        for (const subAppId of subApps) {
          if (!toFetch[region].includes(subAppId)) {
            toFetch[region].push(subAppId);
          }
        }
      }
    }
  }

  for (const region of regions) {
    const missing = [];
    for (const id of appIds) {
      // Skip Sub IDs - they'll get prices from contained apps
      if (subAppMap[id]) continue;

      const cached = await cacheGet(priceKey(id, region));
      if (cached) {
        if (!results[id]) results[id] = {};
        // cached is { value, cachedAt }
        results[id][region] = { ...cached.value, cachedAt: cached.cachedAt };
      } else {
        missing.push(id);
      }
    }
    if (missing.length > 0) {
      if (!toFetch[region]) toFetch[region] = [];
      for (const id of missing) {
        if (!toFetch[region].includes(id)) {
          toFetch[region].push(id);
        }
      }
    }
  }

  const fetchPromises = [];
  for (const [region, ids] of Object.entries(toFetch)) {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      fetchPromises.push(
        new Promise((resolve, reject) => {
          queue.push({ apiKey, appIds: batch, region, resolve, reject });
        })
      );
    }
  }

  processQueue().catch(console.error);

  const batchResults = await Promise.all(fetchPromises);
  const allFetchedPrices = {};
  for (const { region, data } of batchResults) {
    for (const [id, priceData] of Object.entries(data)) {
      if (priceData) {
        if (!allFetchedPrices[id]) allFetchedPrices[id] = {};
        allFetchedPrices[id][region] = { ...priceData, cachedAt: Date.now() };
      }
    }
  }

  // Merge fetched prices into results
  for (const [id, regionData] of Object.entries(allFetchedPrices)) {
    if (!results[id]) results[id] = {};
    for (const [region, priceData] of Object.entries(regionData)) {
      results[id][region] = priceData;
    }
  }

  // For Sub IDs, aggregate prices from contained apps
  for (const [subId, containedApps] of Object.entries(subAppMap)) {
    for (const region of regions) {
      const containedPrices = containedApps
        .map(appId => results[appId]?.[region])
        .filter(Boolean);

      if (containedPrices.length > 0) {
        // Sum prices for the bundle (simple aggregation)
        const currency = containedPrices[0].prices?.currency ?? 'EUR';
        const sumPrice = (field) => {
          const vals = containedPrices.map(p => p.prices?.[field]).filter(v => v != null);
          return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
        };

        // Use first app's URL as the bundle URL (GG.deals doesn't have bundle-specific URLs via API)
        const firstUrl = containedPrices[0].url;

        results[subId] = results[subId] || {};
        results[subId][region] = {
          title: `Bundle (${containedApps.length} games)`,
          url: firstUrl,
          prices: {
            currentRetail: sumPrice('currentRetail'),
            currentKeyshops: sumPrice('currentKeyshops'),
            historicalRetail: sumPrice('historicalRetail'),
            historicalKeyshops: sumPrice('historicalKeyshops'),
            currency,
          },
          cachedAt: Date.now(),
          isSub: true,
          containedApps,
        };
      }
    }
  }

  return results;
}

/**
 * Cache-only version of getPrices — no API calls, only returns cached data.
 * Missing entries are simply omitted from the result.
 * Note: Does NOT handle Sub IDs (bundles) - use getPrices for that.
 */
export async function getCachedPrices(appIds, regions) {
  const results = {};
  for (const region of regions) {
    for (const id of appIds) {
      const cached = await cacheGet(priceKey(id, region));
      if (cached) {
        if (!results[id]) results[id] = {};
        results[id][region] = { ...cached.value, cachedAt: cached.cachedAt };
      }
    }
  }
  return results;
}

/**
 * Get price data for Steam Sub IDs (bundles/packages).
 * GG.deals doesn't directly support Sub IDs, so we need to fetch the contained app IDs
 * and get prices for those individual apps.
 */
export async function getSubApps(subId) {
  try {
    const resp = await fetch(`https://store.steampowered.com/api/packagedetails?packageids=${subId}&l=english`);
    if (!resp.ok) return null;
    const data = await resp.json();
    const subData = data[subId];
    if (!subData?.success) return null;
    const apps = subData.data?.apps ?? [];
    return apps.map(a => String(a.id));
  } catch {
    return null;
  }
}

export async function getBundles(apiKey, appIds) {
  const url = `${BASE_URL}/bundles/?ids=${appIds.join(',')}&key=${apiKey}`;
  try {
    const resp = await fetch(url);
    updateRateLimit(resp);
    if (!resp.ok) return {};
    const json = await resp.json();
    return json.data ?? {};
  } catch {
    return {};
  }
}

export function getRateLimitState() {
  return { ...rateLimitState };
}
