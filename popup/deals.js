// popup/deals.js
import { getDisplayRegion } from '../utils/similarity.js';

const DEALS_CACHE_KEY = 'deals_cards_cache';

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

let dealsState = null;

/**
 * Apply current settings (region + keyshops preference) to all cards at render time.
 * Cards store pricesPerRegion: { eu: {...}, us: {...} } so we can switch regions without re-fetching.
 */
function applySettingsToCards(cards, settings) {
  const region = getDisplayRegion(settings);
  for (const card of cards) {
    const data = card.pricesPerRegion?.[region];
    if (!data) {
      card.bestCurrent = null;
      card.bestAtl = null;
      card.currency = settings.currency ?? 'EUR';
      card.pctAboveAtl = null;
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
      <div id="deals-header" style="display:flex; justify-content:space-between; align-items:center; padding:0 0 6px;">
        <div style="display:flex; gap:6px; align-items:center;">
          <button class="btn-refresh" id="deals-refresh">↻ Refresh</button>
          <select id="deals-sort" class="tradables-sort" title="Sort by" style="font-size:10px; padding:2px 4px;">
            <option value="best-deal">Best Deal</option>
            <option value="name-asc">Name A→Z</option>
            <option value="name-desc">Name Z→A</option>
            <option value="price-asc">Price ↑</option>
            <option value="price-desc">Price ↓</option>
          </select>
        </div>
        <span id="deals-cache-status" style="font-size:9px; color:#555;"></span>
      </div>
      <div id="deals-summary" style="font-size:11px;color:#8a9bb0;padding:0 0 6px"></div>
      <div id="deals-free-section" style="display:none;padding:6px 0;border-bottom:1px solid #333;margin-bottom:6px"></div>
      <div id="deals-body"></div>
    `;
    container.querySelector('#deals-refresh').addEventListener('click', () => loadDeals(container));
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

async function loadDeals(container) {
  const summary = container.querySelector('#deals-summary');
  const freeSection = container.querySelector('#deals-free-section');
  const body = container.querySelector('#deals-body');
  const cacheStatus = container.querySelector('#deals-cache-status');

  const sortMode = await getSortMode();
  body.innerHTML = '<div class="empty-state">Loading wishlist…</div>';
  summary.textContent = '';
  freeSection.style.display = 'none';
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

  // Fetch prices (try cache, fall through to API)
  if (settings.apiKey) {
    let prices = null;
    try { prices = await msg('GET_CACHED_PRICES', { appIds, regions: settings.regions }); } catch {}
    if (!prices || Object.keys(prices).length === 0) {
      try {
        prices = await msg('GET_PRICES', { appIds, regions: settings.regions });
        if (prices?.error) { priceError = prices.error; prices = null; }
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

  // Header timestamp
  cacheStatus.textContent = savedAt ? `Last: ${formatTimestamp(savedAt)}` : '';

  // Summary
  if (!settings.apiKey) {
    summary.innerHTML = `${cards.length} games on wishlist — <span style="color:#66c0f4">Add GG.deals API key for prices</span>`;
  } else if (priceError) {
    summary.innerHTML = `${cards.length} games on wishlist — <span style="color:#e74c3c">Price error: ${escapeHtml(priceError)}</span>`;
  } else {
    summary.textContent = `${cards.length} games on wishlist — ${withPrices} with prices`;
  }

  // Free-game giveaway section
  if (freeGamesCount > 0) {
    const freeGames = cards.filter(c => c.isFree);
    const fetchedCount = freeGames.filter(c => c.scrapedAtl != null).length;
    freeSection.style.display = 'block';
    freeSection.innerHTML = `
      <div style="font-size:11px;color:#f1c40f;margin-bottom:4px">
        ⚠ ${freeGamesCount} games were FREE (giveaway) ${fetchedCount > 0 ? `✓ ${fetchedCount} fetched` : ''}
      </div>
      <button class="btn-fetch-free" id="fetch-free-btn" style="font-size:10px;padding:2px 8px;${fetchedCount === freeGamesCount ? 'opacity:0.5' : ''}">
        ${fetchedCount === freeGamesCount ? 'Already fetched' : 'Fetch better ATL'}
      </button>
      <div id="fetch-free-status" style="font-size:10px;color:#8a9bb0;margin-top:4px"></div>`;
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

    if (c.isFree) {
      const atlDisplay = c.scrapedAtl != null
        ? `Best paid: ${formatPrice(c.scrapedAtl, c.currency)}`
        : 'Best paid: -- (not fetched)';
      const pctDisplay = c.scrapedAtl != null ? ` · ${Math.round(c.pctAboveAtl)}% above` : '';
      return `<div class="game-card">
        <div class="game-card-title">
          ${steamUrl ? `<a href="${steamUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHtml(c.title)}</a>` : escapeHtml(c.title)}
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
        <div class="game-card-title">${steamUrl ? `<a href="${steamUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHtml(c.title)}</a>` : escapeHtml(c.title)}</div>
        <div class="game-card-meta">
          <span class="${deal ? 'highlight' : ''}">${formatPrice(c.bestCurrent, c.currency)}</span>
          · ${atlLabel}: <span class="atl">${formatPrice(c.bestAtl, c.currency)}</span>
          ${c.pctAboveAtl != null ? `· <span>${Math.round(c.pctAboveAtl)}% above</span>` : ''}
          ${c.url ? `· <a href="${c.url}" target="_blank" style="color:#66c0f4;">GG.deals ↗</a>` : ''}
        </div>
      </div>`;
    }

    return `<div class="game-card" style="opacity:0.7">
      <div class="game-card-title">${steamUrl ? `<a href="${steamUrl}" target="_blank" style="color:inherit;text-decoration:none;">${escapeHtml(c.title)}</a>` : escapeHtml(c.title)}</div>
      <div class="game-card-meta" style="color:#666">
        ${c.appId ? `App ID: ${c.appId}` : 'Unresolved'} — Price unavailable
      </div>
    </div>`;
  }).join('')}</div>`;
}
