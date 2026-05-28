// popup/deals.js
import { getDisplayRegion } from '../utils/similarity.js';

const DEALS_CACHE_KEY = 'deals_cards_cache';
const DEALS_REFRESH_OPTIONS_KEY = 'dealsRefreshOptions';
const CACHE_AGE_OPTIONS = {
  '1d': 1 * 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '2w': 14 * 24 * 60 * 60 * 1000,
  '1m': 30 * 24 * 60 * 60 * 1000,
  '1y': 365 * 24 * 60 * 60 * 1000,
  forever: Infinity,
};

function msg(type, data = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...data }, resolve));
}

function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  return `${m}m ago`;
}

export function formatRefreshDate(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

export function getCardRefreshTimestamp(card, settings = {}) {
  const region = getDisplayRegion(settings);
  const allRegions = settings?.regions ?? [region];
  const preferred = card.pricesPerRegion?.[region]?.cachedAt;
  if (preferred) return preferred;

  for (const fallback of allRegions) {
    const cachedAt = card.pricesPerRegion?.[fallback]?.cachedAt;
    if (cachedAt) return cachedAt;
  }

  return null;
}

export function getStaleAppIds(appIds, prices, regions, maxAgeMs, now = Date.now()) {
  if (maxAgeMs === Infinity) return appIds.filter(id => !regions.every(region => prices?.[id]?.[region]));

  return appIds.filter(id => {
    for (const region of regions) {
      const cachedAt = prices?.[id]?.[region]?.cachedAt;
      if (!cachedAt || now - cachedAt > maxAgeMs) return true;
    }
    return false;
  });
}

const FREE_THRESHOLD_CENTS = 10;
let progressListener = null;

async function getSortMode() {
  try {
    const r = await new Promise(resolve => chrome.storage.local.get('dealsSortMode', resolve));
    return r.dealsSortMode || 'best-deal';
  } catch { return 'best-deal'; }
}
async function setSortMode(mode) {
  try { await chrome.storage.local.set({ dealsSortMode: mode }); } catch {}
}

async function getRefreshOptions() {
  try {
    const r = await new Promise(resolve => chrome.storage.local.get(DEALS_REFRESH_OPTIONS_KEY, resolve));
    const stored = r[DEALS_REFRESH_OPTIONS_KEY] ?? {};
    return {
      ignoreCached: Boolean(stored.ignoreCached),
      maxAge: Object.hasOwn(CACHE_AGE_OPTIONS, stored.maxAge) ? stored.maxAge : '1w',
    };
  } catch {
    return { ignoreCached: false, maxAge: '1w' };
  }
}

async function setRefreshOptions(options) {
  try { await chrome.storage.local.set({ [DEALS_REFRESH_OPTIONS_KEY]: options }); } catch {}
}

let dealsState = null;

/**
 * Apply current settings (region + keyshops preference) to all cards at render time.
 * Cards store pricesPerRegion: { eu: {...}, us: {...} } so we can switch regions without re-fetching.
 */
function applySettingsToCards(cards, settings) {
  const region = getDisplayRegion(settings);
  const allRegions = settings?.regions ?? [region];
  for (const card of cards) {
    // Try display region first, then fallback to any available region
    let data = card.pricesPerRegion?.[region];
    let usedRegion = region;
    if (!data && card.pricesPerRegion) {
      for (const fallback of allRegions) {
        if (card.pricesPerRegion[fallback]) {
          data = card.pricesPerRegion[fallback];
          usedRegion = fallback;
          break;
        }
      }
    }
    if (!data) {
      card.bestCurrent = null;
      card.bestAtl = null;
      card.currency = settings.currency ?? 'EUR';
      card.pctAboveAtl = null;
      card.usedRegion = null;
      continue;
    }
    const retail = data.prices?.currentRetail;
    const ksop = data.prices?.currentKeyshops;
    const atlRetail = data.prices?.historicalRetail;
    const atlKsop = data.prices?.historicalKeyshops;
    card.currency = data.prices?.currency ?? 'EUR';
    card.url = data.url ?? card.url;
    card.ggdealsUrl = data.url ?? card.ggdealsUrl;
    card.bestCurrent = (settings.keyshopsEnabled && ksop != null && (retail == null || ksop < retail)) ? ksop : retail;
    card.bestAtl = (settings.keyshopsEnabled && atlKsop != null && (atlRetail == null || atlKsop < atlRetail)) ? atlKsop : atlRetail;
    card.pctAboveAtl = (card.bestCurrent != null && card.bestAtl > 0)
      ? ((card.bestCurrent - card.bestAtl) / card.bestCurrent) * 100
      : null;
    card.usedRegion = usedRegion;
    card.refreshTimestamp = data.cachedAt ?? null;
  }
}

// Listen for SETTINGS_UPDATED — recompute display fields from stored multi-region data, then re-render
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'SETTINGS_UPDATED') return;
  if (dealsState) {
    // Update stored settings in dealsState
    Object.assign(dealsState.settings, message.settings);
    applySettingsToCards(dealsState.cards, message.settings);
    renderDeals(document.querySelector('#tab-deals'));
  }
});

export async function initDeals(container) {
  if (!container.querySelector('#deals-header')) {
    container.innerHTML = `
      <div id="deals-header" style="display:flex; justify-content:space-between; align-items:center; gap:8px; padding:0 0 6px;">
        <div class="deals-refresh-row">
          <button class="btn-refresh" id="deals-refresh">↻ Refresh</button>
          <label class="deals-cache-control" title="When enabled, only prices older than this age are refreshed.">
            <input type="checkbox" id="deals-ignore-cache">
            <span>Ignore cached prices from:</span>
          </label>
          <select id="deals-cache-age" class="deals-compact-select" title="Cached price age">
            <option value="1d">1 day</option>
            <option value="3d">3 days</option>
            <option value="1w">1 week</option>
            <option value="2w">2 weeks</option>
            <option value="1m">1 month</option>
            <option value="1y">1 year</option>
            <option value="forever">Forever</option>
          </select>
        </div>
        <span id="deals-cache-status" style="font-size:9px; color:#555; white-space:nowrap;"></span>
      </div>
      <div id="deals-summary" style="font-size:11px;color:#8a9bb0;padding:0 0 6px"></div>
      <div id="deals-tools">
        <div id="deals-free-section"></div>
        <div class="deals-sort-row">
          <select id="deals-sort" class="tradables-sort" title="Sort by" style="font-size:10px; padding:2px 4px;">
            <option value="best-deal">Best Deal</option>
            <option value="name-asc">Name A→Z</option>
            <option value="name-desc">Name Z→A</option>
            <option value="price-asc">Price ↑</option>
            <option value="price-desc">Price ↓</option>
          </select>
        </div>
      </div>
      <div id="deals-body"></div>
    `;
    const refreshOptions = await getRefreshOptions();
    const ignoreCache = container.querySelector('#deals-ignore-cache');
    const cacheAge = container.querySelector('#deals-cache-age');
    ignoreCache.checked = refreshOptions.ignoreCached;
    cacheAge.value = refreshOptions.maxAge;
    cacheAge.disabled = !ignoreCache.checked;
    container.querySelector('#deals-refresh').addEventListener('click', () => loadDeals(container, { manualRefresh: true }));
    ignoreCache.addEventListener('change', async (e) => {
      cacheAge.disabled = !e.target.checked;
      await setRefreshOptions({ ignoreCached: e.target.checked, maxAge: cacheAge.value });
    });
    cacheAge.addEventListener('change', async (e) => {
      await setRefreshOptions({ ignoreCached: ignoreCache.checked, maxAge: e.target.value });
    });
    container.querySelector('#deals-sort').addEventListener('change', async (e) => {
      await setSortMode(e.target.value);
      if (dealsState) {
        dealsState.sortMode = e.target.value;
        renderDeals(container);
      }
    });
  }

  // Session guard — instant when switching tabs
  if (dealsState) {
    renderDeals(container);
    return;
  }

  // Persistent cache — instant on popup reopen
  const snap = await new Promise(resolve => chrome.storage.local.get(DEALS_CACHE_KEY, resolve));
  if (snap[DEALS_CACHE_KEY]?.cards?.length) {
    const { cards, savedAt } = snap[DEALS_CACHE_KEY];
    const settings = await msg('GET_SETTINGS');
    const sortMode = await getSortMode();
    applySettingsToCards(cards, settings);
    dealsState = { cards, settings, sortMode, savedAt, withPrices: 0, freeGamesCount: 0, priceError: null };
    // Count priced cards
    for (const c of cards) {
      if (c.bestCurrent != null) dealsState.withPrices++;
      if (c.isFree) dealsState.freeGamesCount++;
    }
    renderDeals(container);
    return; // instant — zero async messages to service worker
  }

  await loadDeals(container);
}

async function loadDeals(container, options = {}) {
  return loadDealsInternal(container, options);
}

async function loadDealsInternal(container, { manualRefresh = false } = {}) {
  const summary = container.querySelector('#deals-summary');
  const freeSection = container.querySelector('#deals-free-section');
  const body = container.querySelector('#deals-body');

  const sortMode = await getSortMode();
  const refreshOptions = await getRefreshOptions();
  body.innerHTML = '<div class="empty-state">Loading wishlist…</div>';
  summary.textContent = '';
  freeSection.innerHTML = '';

  const settings = await msg('GET_SETTINGS');
  if (!settings.steamId) {
    body.innerHTML = '<div class="error-state">No Steam ID set. Add your profile URL in Settings.</div>';
    return;
  }

  // Try cached profile first
  let profile;
  try {
    profile = await msg('GET_CACHED_PROFILE');
    if (!profile.wishlist?.length) profile = await msg('GET_PROFILE');
  } catch (err) {
    body.innerHTML = `<div class="error-state">Failed to load wishlist: ${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!profile.wishlist?.length) {
    body.innerHTML = '<div class="error-state">No wishlist games found. Make sure your Steam wishlist is set to <strong>Public</strong>.</div>';
    return;
  }

  summary.textContent = `${profile.wishlist.length} games on wishlist — resolving…`;

  // Resolve titles (try cache first)
  const cachedRes = await msg('GET_CACHED_RESOLUTIONS', { titles: profile.wishlist });
  const allCached = profile.wishlist.every(t => cachedRes[t] != null);
  const resolutions = allCached
    ? profile.wishlist.map(t => cachedRes[t])
    : await msg('RESOLVE_TITLES', { titles: profile.wishlist });

  // Build cards with multi-region price storage
  const cards = profile.wishlist.map((title, i) => ({
    title,
    appId: resolutions[i]?.appId,
    pricesPerRegion: null,
    currency: 'EUR',
    isFree: false,
    scrapedAtl: null,
    url: null,
    ggdealsUrl: null,
    // computed at render time by applySettingsToCards:
    bestCurrent: null,
    bestAtl: null,
    pctAboveAtl: null,
  }));

  const appIds = resolutions.filter(r => r?.appId).map(r => r.appId);
  if (!appIds.length) {
    summary.textContent = `${profile.wishlist.length} games on wishlist`;
    body.innerHTML = '<div class="empty-state">Could not resolve any wishlist games to App IDs.</div>';
    return;
  }

  let priceError = null;

  // Fetch prices. Initial loads fill missing cached entries; manual refreshes either
  // bypass all cache or refresh only entries older than the selected age.
  if (settings.apiKey) {
    const regions = settings.regions ?? [getDisplayRegion(settings)];
    let prices = null;
    try { prices = await msg('GET_CACHED_PRICES', { appIds, regions }); } catch {}

    let appIdsToFetch = [];
    if (manualRefresh && !refreshOptions.ignoreCached) {
      appIdsToFetch = appIds;
    } else if (manualRefresh && refreshOptions.ignoreCached) {
      appIdsToFetch = getStaleAppIds(appIds, prices, regions, CACHE_AGE_OPTIONS[refreshOptions.maxAge]);
    } else {
      appIdsToFetch = getStaleAppIds(appIds, prices, regions, Infinity);
    }

    if (appIdsToFetch.length > 0) {
      try {
        const livePrices = await msg(manualRefresh ? 'REFRESH_PRICES' : 'GET_PRICES', { appIds: appIdsToFetch, regions });
        if (livePrices?.error) { priceError = livePrices.error; }
        else if (livePrices) {
          // Merge live prices into cache results
          prices = prices ?? {};
          for (const id of Object.keys(livePrices)) {
            if (livePrices[id]) {
              prices[id] = livePrices[id];
            }
          }
        }
      } catch (err) { priceError = err.message; }
    }

    // Store ALL regions per card (multi-region switching support)
    if (prices) {
      for (const card of cards) {
        if (!card.appId) continue;
        if (prices[card.appId]) {
          card.pricesPerRegion = prices[card.appId]; // { eu: {...}, us: {...} }
          // Grab URL from any available region
          for (const r of Object.values(prices[card.appId])) {
            if (r?.url) { card.url = r.url; card.ggdealsUrl = r.url; break; }
          }
        }
      }
    }
  }

  // Free-game detection
  let freeGamesCount = 0;
  const region = getDisplayRegion(settings);
  for (const card of cards) {
    const rData = card.pricesPerRegion?.[region];
    if (rData?.prices?.historicalRetail != null && rData.prices.historicalRetail <= FREE_THRESHOLD_CENTS) {
      card.isFree = true;
      freeGamesCount++;
      if (card.appId && !card.scrapedAtl) {
        const scraped = await msg('GET_SCRAPED_DATA', { gameId: card.appId });
        if (scraped?.data?.secondBest) {
          const sb = settings.keyshopsEnabled
            ? scraped.data.secondBest.keyshops
            : scraped.data.secondBest.retail;
          if (sb != null && sb > FREE_THRESHOLD_CENTS) card.scrapedAtl = sb;
        }
      }
    }
  }

  // Apply settings to compute display fields
  applySettingsToCards(cards, settings);

  // Persist to chrome.storage.local for instant open on next popup
  const cardsToStore = cards.map(c => ({
    title: c.title,
    appId: c.appId,
    pricesPerRegion: c.pricesPerRegion,
    currency: c.currency,
    isFree: c.isFree,
    scrapedAtl: c.scrapedAtl,
    url: c.url,
    ggdealsUrl: c.ggdealsUrl,
  }));
  await new Promise(resolve => chrome.storage.local.set({ [DEALS_CACHE_KEY]: { cards: cardsToStore, savedAt: Date.now() } }, resolve));

  const withPrices = cards.filter(c => c.bestCurrent != null).length;
  dealsState = { cards, settings, sortMode, withPrices, freeGamesCount, priceError, savedAt: Date.now() };
  renderDeals(container);
}

function renderDeals(container) {
  if (!dealsState || !container) return;
  const body = container.querySelector('#deals-body');
  const summary = container.querySelector('#deals-summary');
  const freeSection = container.querySelector('#deals-free-section');
  const cacheStatus = container.querySelector('#deals-cache-status');

  const { cards, settings, withPrices, freeGamesCount, priceError, sortMode, savedAt } = dealsState;
  const sortSelect = container.querySelector('#deals-sort');
  if (sortSelect && sortSelect.value !== sortMode) sortSelect.value = sortMode;

  // Header timestamp
  cacheStatus.textContent = savedAt ? `Last: ${formatTimestamp(savedAt)}` : '';

  // Summary
  if (!settings.apiKey) {
    summary.innerHTML = `${cards.length} games on wishlist — <span style="color:#66c0f4">Add GG.deals API key for prices</span>`;
  } else if (priceError) {
    // Split error message and actionable hint onto separate lines
    const errorParts = priceError.split('\n');
    const mainError = escapeHtml(errorParts[0]);
    const hint = errorParts.slice(1).map(h => `<br><span style="font-size:10px;color:#e8a735">${escapeHtml(h)}</span>`).join('');
    summary.innerHTML = `${cards.length} games on wishlist — <span style="color:#e74c3c">Price error: ${mainError}</span>${hint}`;
  } else {
    summary.textContent = `${cards.length} games on wishlist — ${withPrices} with prices`;
  }

  // Free-game giveaway section
  if (freeGamesCount > 0) {
    const freeGames = cards.filter(c => c.isFree);
    const fetchedCount = freeGames.filter(c => c.scrapedAtl != null).length;
    freeSection.innerHTML = `
      <div style="font-size:11px;color:#f1c40f;">
        ⚠ ${freeGamesCount} games were FREE (giveaway) ${fetchedCount > 0 ? `✓ ${fetchedCount} fetched` : ''}
      </div>
      <button class="btn-fetch-free" id="fetch-free-btn" style="font-size:10px;padding:2px 8px;${fetchedCount === freeGamesCount ? 'opacity:0.5' : ''}">
        ${fetchedCount === freeGamesCount ? 'Already fetched' : 'Fetch better ATL'}
      </button>
      <div id="fetch-free-status" style="font-size:10px;color:#8a9bb0;"></div>`;
  } else {
    freeSection.innerHTML = '';
  }

  renderGameList(body, cards, settings, sortMode);
}

function renderGameList(body, cards, settings, sortMode) {
  cards.sort((a, b) => {
    if (a.isFree !== b.isFree) return a.isFree ? 1 : -1;
    switch (sortMode) {
      case 'name-asc': return (a.title || '').localeCompare(b.title || '');
      case 'name-desc': return (b.title || '').localeCompare(a.title || '');
      case 'price-asc': return (a.bestCurrent ?? Infinity) - (b.bestCurrent ?? Infinity);
      case 'price-desc': return (b.bestCurrent ?? Infinity) - (a.bestCurrent ?? Infinity);
      case 'best-deal':
      default:
        if (a.pctAboveAtl == null && b.pctAboveAtl == null) return 0;
        if (a.pctAboveAtl == null) return 1;
        if (b.pctAboveAtl == null) return -1;
        return a.pctAboveAtl - b.pctAboveAtl;
    }
  });

  body.innerHTML = `<div class="game-list">${cards.map(c => {
    const steamUrl = c.appId ? `https://store.steampowered.com/app/${c.appId}` : null;
    const refreshDate = formatRefreshDate(getCardRefreshTimestamp(c, settings));
    const titleSuffix = refreshDate ? ` <span class="game-card-refresh">- Last refresh ${refreshDate}</span>` : '';

    if (c.isFree) {
      const atlDisplay = c.scrapedAtl != null
        ? `Best paid: ${formatPrice(c.scrapedAtl, c.currency)}`
        : 'Best paid: -- (not fetched)';
      const pctDisplay = c.scrapedAtl != null ? ` · ${Math.round(c.pctAboveAtl)}% above` : '';
      return `<div class="game-card">
        <div class="game-card-title">
          ${steamUrl ? `<a href="${steamUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHtml(c.title)}</a>` : escapeHtml(c.title)}
          ${titleSuffix}
          <span class="badge-was-free">Was free</span>
        </div>
        <div class="game-card-meta">
          <span class="highlight">${formatPrice(c.bestCurrent, c.currency)}</span>
          · ${atlDisplay}${pctDisplay}
          ${c.url ? `· <a href="${c.url}" target="_blank" style="color:#66c0f4;">GG.deals ↗</a>` : ''}
        </div>
      </div>`;
    }

    if (c.bestCurrent != null) {
      const deal = c.pctAboveAtl != null && c.pctAboveAtl <= (settings.dealThresholdPct ?? 10);
      const atlLabel = settings.keyshopsEnabled && c.historicalKeyshops != null
        && (c.historicalRetail == null || c.historicalKeyshops < c.historicalRetail)
        ? 'Keyshop ATL' : 'ATL';
      return `<div class="game-card">
        <div class="game-card-title">${steamUrl ? `<a href="${steamUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHtml(c.title)}</a>` : escapeHtml(c.title)}${titleSuffix}</div>
        <div class="game-card-meta">
          <span class="${deal ? 'highlight' : ''}">${formatPrice(c.bestCurrent, c.currency)}</span>
          <span style="color:#666;font-size:10px;text-transform:uppercase;margin-left:2px">(${c.usedRegion?.toUpperCase() ?? ''})</span>
          · ${atlLabel}: <span class="atl">${formatPrice(c.bestAtl, c.currency)}</span>
          ${c.pctAboveAtl != null ? `· <span>${Math.round(c.pctAboveAtl)}% above</span>` : ''}
          ${c.url ? `· <a href="${c.url}" target="_blank" style="color:#66c0f4;">GG.deals ↗</a>` : ''}
        </div>
      </div>`;
    }

    return `<div class="game-card" style="opacity:0.7">
      <div class="game-card-title">${steamUrl ? `<a href="${steamUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHtml(c.title)}</a>` : escapeHtml(c.title)}${titleSuffix}</div>
      <div class="game-card-meta" style="color:#666">
        ${c.appId ? `App ID: ${c.appId}` : 'Unresolved'} — Price unavailable
      </div>
    </div>`;
  }).join('')}</div>`;
}
