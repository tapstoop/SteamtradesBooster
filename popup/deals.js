// popup/deals.js
import { getDisplayRegion } from '../utils/similarity.js';
import { runtimeSendMessage } from '../utils/chrome-api.js';

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
  return runtimeSendMessage(type, data);
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

export function normalizeGgDealsUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const isGgDealsHost = host === 'gg.deals' || host.endsWith('.gg.deals');
  if (parsed.protocol !== 'https:' || !isGgDealsHost || parsed.username || parsed.password) {
    return null;
  }

  return parsed.href;
}

function normalizeSafeExternalUrl(url) {
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const isSteamStore = host === 'store.steampowered.com';
  const isGgDeals = host === 'gg.deals' || host.endsWith('.gg.deals');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (!isSteamStore && !isGgDeals)) {
    return null;
  }

  return parsed.href;
}

function createExternalLink(url, text, options = {}) {
  const safeUrl = normalizeSafeExternalUrl(url);
  if (!safeUrl) return null;
  const link = document.createElement('a');
  link.href = safeUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = text;
  if (options.className) link.className = options.className;
  if (options.style) link.setAttribute('style', options.style);
  return link;
}

export function renderGgDealsLink(url) {
  const safeUrl = normalizeGgDealsUrl(url);
  if (!safeUrl) return '';
  return `· <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color:#66c0f4;">GG.deals ↗</a>`;
}

function createErrorLogLinkElement() {
  const link = document.createElement('a');
  link.className = 'error-log-inline';
  link.href = 'popup.html?tab=settings&focus=error-log';
  link.textContent = 'See error logs';
  return link;
}

function appendErrorLogLink(parent) {
  parent.append(' ');
  parent.append(createErrorLogLinkElement());
}

function createStateElement(className, message) {
  const state = document.createElement('div');
  state.className = className;
  state.textContent = message;
  return state;
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

function formatResetTime(ts) {
  const timestamp = Number(ts);
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
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
  const priceFor = (id) => {
    if (prices?.[id]) return prices[id];
    if (id.includes(':')) {
      const [type, rawId] = id.split(':');
      return type === 'app' ? prices?.[rawId] ?? null : null;
    }
    return null;
  };

  if (maxAgeMs === Infinity) return appIds.filter(id => !regions.every(region => priceFor(id)?.[region]));

  return appIds.filter(id => {
    const entryPrices = priceFor(id);
    for (const region of regions) {
      const cachedAt = entryPrices?.[region]?.cachedAt;
      if (!cachedAt || now - cachedAt > maxAgeMs) return true;
    }
    return false;
  });
}

const FREE_THRESHOLD_CENTS = 10;
const FINAL_PRICE_CHUNK_SIZE = 10;
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
let dealsLoadSequence = 0;
let activeWishlistRun = null;
let dealsPriceRefreshSequence = 0;

function createProfileRequestId(sequence) {
  try {
    return crypto.randomUUID();
  } catch {
    return `deals-${Date.now()}-${sequence}`;
  }
}

function createDealsRefreshToken(sequence) {
  try {
    return crypto.randomUUID();
  } catch {
    return `deals-refresh-${Date.now()}-${sequence}`;
  }
}

export function getDealsCacheIdentity(settings = {}) {
  const steamId = String(settings?.steamId ?? '').trim().toLowerCase();
  return steamId ? `steam:${steamId}` : 'steam:none';
}

export function mergePriceResponse(prices, livePrices) {
  if (!livePrices) return { prices, error: null };
  const merged = prices ?? {};
  for (const [key, value] of Object.entries(livePrices)) {
    if (key === 'error') continue;
    if (value) merged[key] = value;
  }
  return { prices: merged, error: livePrices.error ?? null };
}

function typedPriceResult(prices, id, type = 'app') {
  if (!prices || !id) return null;
  const normalizedType = ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
  const typed = prices[`${normalizedType}:${id}`];
  if (typed) return typed;
  return normalizedType === 'app' ? prices[id] ?? null : null;
}

function normalizeStoredAppId(appId) {
  const value = String(appId ?? '').trim();
  return /^\d+$/.test(value) ? value : null;
}

function normalizeSteamStoreType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
}

export function steamStoreUrl(id, type = 'app') {
  const appId = normalizeStoredAppId(id);
  if (!appId) return null;
  const normalizedType = normalizeSteamStoreType(type);
  return `https://store.steampowered.com/${normalizedType}/${encodeURIComponent(appId)}`;
}

export function createGgDealsLinkElement(url) {
  return createExternalLink(url, 'GG.deals ↗');
}

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

function createWishlistProgressCard(title, resolution = null) {
  return {
    title,
    appId: resolution?.appId,
    type: resolution?.type ?? 'app',
    pricesPerRegion: null,
    currency: 'EUR',
    isFree: false,
    scrapedAtl: null,
    url: null,
    ggdealsUrl: null,
    priceStatus: null,
    bestCurrent: null,
    bestAtl: null,
    pctAboveAtl: null,
  };
}

function getProgressCardsForWishlist(profileLoad, wishlist) {
  if (!profileLoad?.progressCardsByTitle || !Array.isArray(wishlist)) return null;
  const cards = wishlist.map(title => profileLoad.progressCardsByTitle.get(String(title))).filter(Boolean);
  return cards.length === wishlist.length ? cards.map(card => ({ ...card })) : null;
}

function isCurrentWishlistRun(run, identity = null) {
  if (!run || run.cancelled) return false;
  if (activeWishlistRun !== run) return false;
  if (run.sequence !== dealsLoadSequence) return false;
  if (identity && run.cacheIdentity !== identity) return false;
  return true;
}

function getRunCards(run = activeWishlistRun) {
  if (!run?.progressCardsByTitle) return [];
  return [...run.progressCardsByTitle.values()];
}

function progressPriceKey(item) {
  return `${item.type ?? 'app'}:${item.id}`;
}

function progressResolutionByTitle(message) {
  const byTitle = new Map();
  if (!Array.isArray(message?.resolved)) return byTitle;
  for (const item of message.resolved) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const appId = normalizeStoredAppId(item?.appId);
    if (!name || !appId) continue;
    byTitle.set(name, { appId, type: normalizeSteamStoreType(item.type ?? 'app'), status: 'hit' });
  }
  return byTitle;
}

function getWishlistRateLimitStatus(cards) {
  let hasRateLimit = false;
  let resetAt = null;
  for (const card of cards ?? []) {
    if (card?.priceStatus?.type !== 'rate-limited') continue;
    hasRateLimit = true;
    const candidate = Number(card.priceStatus.resetAt);
    if (Number.isFinite(candidate)) {
      resetAt = resetAt == null ? candidate : Math.min(resetAt, candidate);
    }
  }
  return hasRateLimit ? { resetAt } : null;
}

function appendWishlistSummaryRateLimit(summary, cards) {
  const status = getWishlistRateLimitStatus(cards);
  if (!status) return;
  const warning = document.createElement('span');
  warning.setAttribute('style', 'color:#e8a735');
  const resetTime = formatResetTime(status.resetAt);
  warning.textContent = `GG.deals API limit reached${resetTime ? ` — resets at ${resetTime}` : ''}`;
  summary.append(' — ', warning);
}

function renderWishlistSummary(summary, {
  cards = [],
  count = cards.length,
  countLabel = 'games on wishlist',
  withPrices = cards.filter(card => card.bestCurrent != null).length,
  settings = null,
  priceError = null,
  profileComplete = true,
  failedAppIds = [],
  tail = '',
} = {}) {
  if (!summary) return;
  const base = `${count} ${countLabel}`;
  if (profileComplete === false || failedAppIds.length > 0) {
    const warning = document.createElement('span');
    warning.setAttribute('style', 'color:#e8a735');
    warning.textContent = 'Wishlist partially loaded — some Steam items failed. Reload wishlist to retry.';
    summary.replaceChildren(`${base} — ${withPrices} with prices — `, warning);
    appendWishlistSummaryRateLimit(summary, cards);
  } else if (settings && !settings.apiKey) {
    const hint = document.createElement('span');
    hint.setAttribute('style', 'color:#66c0f4');
    hint.textContent = 'Add GG.deals API key for prices';
    summary.replaceChildren(`${base} — `, hint);
  } else if (priceError) {
    const errorParts = priceError.split('\n');
    const mainError = document.createElement('span');
    mainError.setAttribute('style', 'color:#e74c3c');
    mainError.textContent = `Price error: ${errorParts[0]}`;
    summary.replaceChildren(`${base} — `, mainError);
    appendWishlistSummaryRateLimit(summary, cards);
    for (const hintText of errorParts.slice(1)) {
      const lineBreak = document.createElement('br');
      const hint = document.createElement('span');
      hint.setAttribute('style', 'font-size:10px;color:#e8a735');
      hint.textContent = hintText;
      summary.append(lineBreak, hint);
    }
    appendErrorLogLink(summary);
  } else {
    summary.replaceChildren(`${base} — ${withPrices} with prices`);
    appendWishlistSummaryRateLimit(summary, cards);
  }
  if (tail) summary.append(` — ${tail}`);
}

function renderWishlistProgress(message, profileLoad) {
  const container = document.querySelector('#tab-deals');
  const summary = container?.querySelector('#deals-summary');
  const body = container?.querySelector('#deals-body');
  const settings = profileLoad?.settings;
  if (!summary || !body || !settings || !Array.isArray(message.wishlist)) return;
  profileLoad.progressCardsByTitle ??= new Map();
  const cards = message.wishlist.map(title => {
    const key = String(title);
    if (!profileLoad.progressCardsByTitle.has(key)) {
      profileLoad.progressCardsByTitle.set(key, createWishlistProgressCard(key));
    }
    return profileLoad.progressCardsByTitle.get(key);
  });
  applySettingsToCards(cards, settings);
  const withPrices = cards.filter(card => card.bestCurrent != null).length;
  const countLabel = message.done ? 'games on wishlist' : 'games received';
  renderWishlistSummary(summary, {
    cards,
    countLabel,
    withPrices,
    tail: message.done ? 'updating…' : 'loading…',
  });
  body.replaceChildren(createDealsGameListElement(cards, settings, profileLoad.sortMode ?? 'best-deal'));
}

async function beginDealsRefresh(cacheIdentity, refreshToken) {
  const beginResult = await msg('BEGIN_DEALS_REFRESH', { cacheIdentity, refreshToken });
  if (beginResult?.ok !== true) {
    throw new Error(beginResult?.error || 'Failed to start wishlist refresh.');
  }
}

function clearRunIfCurrent(run) {
  if (activeWishlistRun === run) {
    run.cancelled = true;
    activeWishlistRun = null;
  }
}

function clearWishlistDisplayForReload(container) {
  const body = container?.querySelector('#deals-body');
  const summary = container?.querySelector('#deals-summary');
  const freeSection = container?.querySelector('#deals-free-section');
  const cacheStatus = container?.querySelector('#deals-cache-status');
  if (summary) summary.textContent = '';
  if (freeSection) freeSection.replaceChildren();
  if (cacheStatus) cacheStatus.textContent = '';
  if (body) body.replaceChildren(createStateElement('empty-state', 'Loading wishlist…'));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function serializeDealsCards(cards) {
  return cards.map(c => ({
    title: c.title,
    appId: c.appId,
    type: c.type ?? 'app',
    pricesPerRegion: c.pricesPerRegion,
    currency: c.currency,
    isFree: c.isFree,
    scrapedAtl: c.scrapedAtl,
    url: c.url,
    ggdealsUrl: c.ggdealsUrl,
    priceStatus: c.priceStatus ?? null,
  }));
}

async function persistDealsRefreshProgress(run, cards) {
  if (!isCurrentWishlistRun(run, run?.cacheIdentity)) return;
  try {
    await msg('UPDATE_DEALS_REFRESH_PROGRESS', {
      cacheIdentity: run.cacheIdentity,
      refreshToken: run.refreshToken,
      cards: serializeDealsCards(cards),
      savedAt: Date.now(),
    });
  } catch {
    // Progress persistence is best-effort; the active popup state remains authoritative.
  }
}

function markCardsRateLimited(cards, message) {
  if (!Array.isArray(cards) || !Array.isArray(message?.items)) return false;
  const limitedKeys = new Set(message.items.map(item => progressPriceKey(item)));
  let changed = false;
  for (const card of cards) {
    if (!card?.appId || card.bestCurrent != null) continue;
    const key = progressPriceKey({ id: String(card.appId), type: card.type ?? 'app' });
    if (!limitedKeys.has(key)) continue;
    card.priceStatus = {
      type: 'rate-limited',
      resetAt: Number(message.resetAt) || null,
    };
    changed = true;
  }
  return changed;
}

function getActiveProgressCards() {
  return getRunCards(activeWishlistRun);
}

function getResolvedPriceItems(cards) {
  const seen = new Set();
  return cards
    .filter(card => card?.appId)
    .map(card => ({ id: String(card.appId), type: card.type ?? 'app' }))
    .filter(item => {
      const key = progressPriceKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function applyPriceResponseToCards(cards, prices) {
  if (!prices) return;
  for (const card of cards) {
    if (!card.appId) continue;
    const regionPrices = typedPriceResult(prices, card.appId, card.type ?? 'app');
    if (!regionPrices) continue;
    card.pricesPerRegion = regionPrices;
    card.priceStatus = null;
    for (const regionData of Object.values(regionPrices)) {
      if (regionData?.url) {
        card.url = regionData.url;
        card.ggdealsUrl = regionData.url;
        break;
      }
    }
  }
}

async function refreshDealsPrices(container) {
  const refreshSequence = ++dealsPriceRefreshSequence;
  const settings = dealsState?.settings ?? activeWishlistRun?.settings ?? await msg('GET_SETTINGS');
  const cards = dealsState?.cards ?? getActiveProgressCards();
  const summary = container?.querySelector('#deals-summary');
  if (!container || !settings || cards.length === 0) {
    if (summary) summary.textContent = 'Load wishlist first.';
    return;
  }
  if (!settings.apiKey) {
    if (summary) summary.textContent = `${cards.length} games on wishlist — Add GG.deals API key for prices`;
    return;
  }
  const items = getResolvedPriceItems(cards);
  if (items.length === 0) {
    if (summary) summary.textContent = `${cards.length} games on wishlist — no resolved games to price`;
    return;
  }
  const regions = settings.regions ?? [getDisplayRegion(settings)];
  if (summary) summary.textContent = `${cards.length} games on wishlist — refreshing prices…`;
  try {
    const prices = await msg('REFRESH_PRICES', { items, regions });
    if (refreshSequence !== dealsPriceRefreshSequence) return;
    applyPriceResponseToCards(cards, prices);
    applySettingsToCards(cards, settings);
    if (dealsState) {
      dealsState.withPrices = cards.filter(card => card.bestCurrent != null).length;
      dealsState.freeGamesCount = cards.filter(card => card.isFree).length;
      dealsState.priceError = prices?.error ?? null;
      dealsState.savedAt = Date.now();
      renderDeals(container);
    } else if (activeWishlistRun) {
      renderWishlistProgress({
        wishlist: [...activeWishlistRun.progressCardsByTitle.keys()],
        done: activeWishlistRun.phase !== 'steam-loading',
      }, activeWishlistRun);
    }
  } catch (err) {
    if (refreshSequence !== dealsPriceRefreshSequence) return;
    if (summary) summary.textContent = `${cards.length} games on wishlist — price refresh failed: ${err?.message ?? err}`;
  }
}

function clearDealsSessionState(container) {
  dealsLoadSequence++;
  dealsPriceRefreshSequence++;
  if (activeWishlistRun) activeWishlistRun.cancelled = true;
  dealsState = null;
  activeWishlistRun = null;
  const body = container?.querySelector('#deals-body') ?? document.querySelector('#deals-body');
  const summary = container?.querySelector('#deals-summary') ?? document.querySelector('#deals-summary');
  const freeSection = container?.querySelector('#deals-free-section') ?? document.querySelector('#deals-free-section');
  const cacheStatus = container?.querySelector('#deals-cache-status') ?? document.querySelector('#deals-cache-status');
  if (summary) summary.textContent = '';
  if (freeSection) freeSection.replaceChildren();
  if (cacheStatus) cacheStatus.textContent = '';
  if (body) body.replaceChildren(createStateElement('empty-state', 'Cache cleared. Reload wishlist to fetch again.'));
}

async function loadProgressPrices(priceItems, profileLoad, isCurrentProgress) {
  const container = document.querySelector('#tab-deals');
  const settings = profileLoad?.settings;
  if (!container || !settings || !settings.apiKey || priceItems.length === 0) return;
  const regions = settings.regions ?? [getDisplayRegion(settings)];
  const keys = priceItems.map(progressPriceKey);
  try {
    let prices = null;
    if (!profileLoad.forceReloadAll) {
      prices = await msg('GET_CACHED_PRICES', { items: priceItems, regions });
      if (!isCurrentProgress()) return;
    }
    const applyPrices = (priceResponse) => {
      if (!priceResponse) return;
      for (const item of priceItems) {
        const card = profileLoad.progressCardsByAppId?.get(String(item.id));
        if (!card) continue;
        const regionPrices = typedPriceResult(priceResponse, item.id, item.type ?? 'app');
        if (!regionPrices) continue;
        card.pricesPerRegion = regionPrices;
        card.priceStatus = null;
        for (const regionData of Object.values(regionPrices)) {
          if (regionData?.url) {
            card.url = regionData.url;
            card.ggdealsUrl = regionData.url;
            break;
          }
        }
      }
    };
    applyPrices(prices);
    renderWishlistProgress({
      wishlist: [...profileLoad.progressCardsByTitle.keys()],
      done: false,
    }, profileLoad);

    const missingPriceKeys = profileLoad.forceReloadAll ? keys : getStaleAppIds(keys, prices, regions, Infinity);
    if (missingPriceKeys.length === 0) return;
    const liveItems = priceItems.filter(item => missingPriceKeys.includes(progressPriceKey(item)));
    const livePrices = await msg(profileLoad.forceReloadAll ? 'REFRESH_PRICES' : 'GET_PRICES', { items: liveItems, regions });
    if (!isCurrentProgress()) return;
    const merged = mergePriceResponse(prices, livePrices);
    applyPrices(merged.prices);
    applySettingsToCards([...profileLoad.progressCardsByTitle.values()], settings);
    renderWishlistProgress({
      wishlist: [...profileLoad.progressCardsByTitle.keys()],
      done: false,
    }, profileLoad);
  } catch {
    if (!isCurrentProgress()) return;
    renderWishlistProgress({
      wishlist: [...profileLoad.progressCardsByTitle.keys()],
      done: false,
    }, profileLoad);
  }
}

async function hydrateWishlistProgressCards(message, profileLoad) {
  const container = document.querySelector('#tab-deals');
  const settings = profileLoad?.settings;
  if (!container || !settings || !Array.isArray(message.wishlist) || message.wishlist.length === 0) return;

  const titles = [...message.wishlist];
  const isCurrentProgress = () => (
    isCurrentWishlistRun(profileLoad)
    && container.isConnected
    && profileLoad.requestId === message.requestId
    && (message.generation == null || profileLoad.generation === message.generation)
  );

  try {
    profileLoad.progressCardsByTitle ??= new Map();
    profileLoad.progressCardsByAppId ??= new Map();
    profileLoad.progressPriceKeys ??= new Set();

    const progressResolved = progressResolutionByTitle(message);
    let resolutions = titles.map(title => progressResolved.get(String(title)) ?? null);
    const missing = titles
      .map((title, index) => (profileLoad.forceReloadAll || !resolutions[index]) ? { title, index } : null)
      .filter(Boolean);
    if (missing.length > 0) {
      const stillMissing = profileLoad.forceReloadAll
        ? missing
        : await (async () => {
          const cachedRes = await msg('GET_CACHED_RESOLUTIONS', { titles: missing.map(item => item.title) });
          if (!isCurrentProgress()) return [];
          missing.forEach(item => {
            resolutions[item.index] = cachedRes[item.title] ?? null;
          });
          return missing.filter(item => !resolutions[item.index]);
        })();
      if (!isCurrentProgress()) return;
      if (stillMissing.length > 0) {
        const missingResults = await msg('RESOLVE_TITLES', {
          titles: stillMissing.map(item => item.title),
          forceRefresh: profileLoad.forceReloadAll === true,
        });
        if (!isCurrentProgress()) return;
        stillMissing.forEach((item, index) => {
          resolutions[item.index] = missingResults[index] ?? null;
        });
      }
    }

    const cards = titles.map((title, i) => {
      const key = String(title);
      const card = profileLoad.progressCardsByTitle.get(key) ?? createWishlistProgressCard(key);
      card.appId = resolutions[i]?.appId;
      card.type = resolutions[i]?.type ?? card.type ?? 'app';
      profileLoad.progressCardsByTitle.set(key, card);
      if (card.appId) profileLoad.progressCardsByAppId.set(String(card.appId), card);
      return card;
    });

    applySettingsToCards(cards, settings);
    if (!isCurrentProgress()) return;
    titles.forEach((title, index) => {
      profileLoad.progressCardsByTitle.set(String(title), cards[index]);
    });
    renderWishlistProgress(message, profileLoad);

    const priceItems = resolutions
      .filter(r => r?.appId)
      .map(r => ({ id: r.appId, type: r.type ?? 'app' }))
      .filter(item => {
        const key = progressPriceKey(item);
        if (profileLoad.progressPriceKeys.has(key)) return false;
        profileLoad.progressPriceKeys.add(key);
        return true;
      });
    loadProgressPrices(priceItems, profileLoad, isCurrentProgress).catch(() => {});
  } catch {
    if (isCurrentProgress()) renderWishlistProgress(message, profileLoad);
  }
}

// Listen for SETTINGS_UPDATED — recompute display fields from stored multi-region data, then re-render
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'WISHLIST_PROGRESS') {
    if (dealsState || !activeWishlistRun || message.requestId !== activeWishlistRun.requestId) return;
    if (message.steamId !== activeWishlistRun.steamId) return;
    if (message.generation != null) {
      if (activeWishlistRun.generation == null) {
        activeWishlistRun.generation = message.generation;
      } else if (message.generation !== activeWishlistRun.generation) {
        return;
      }
    }
    activeWishlistRun.phase = message.done ? 'resolving' : 'steam-loading';
    renderWishlistProgress(message, activeWishlistRun);
    hydrateWishlistProgressCards(message, activeWishlistRun).catch(() => {});
    return;
  }
  if (message.type === 'CACHE_CLEARED') {
    clearDealsSessionState(document.querySelector('#tab-deals'));
    return;
  }
  if (message.type === 'GGDEALS_RATE_LIMITED') {
    const container = document.querySelector('#tab-deals');
    if (activeWishlistRun) {
      const cards = getRunCards(activeWishlistRun);
      if (markCardsRateLimited(cards, message)) {
        renderWishlistProgress({
          wishlist: [...activeWishlistRun.progressCardsByTitle.keys()],
          done: activeWishlistRun.phase !== 'steam-loading',
        }, activeWishlistRun);
        persistDealsRefreshProgress(activeWishlistRun, cards).catch(() => {});
      }
      return;
    }
    if (dealsState && markCardsRateLimited(dealsState.cards, message)) {
      applySettingsToCards(dealsState.cards, dealsState.settings);
      renderDeals(container);
    }
    return;
  }
  if (message.type !== 'SETTINGS_UPDATED') return;
  dealsLoadSequence++;
  const container = document.querySelector('#tab-deals');
  if (!dealsState) {
    if (container) loadDeals(container).catch(() => {});
    return;
  }
  if (dealsState) {
    const nextIdentity = getDealsCacheIdentity(message.settings);
    if (nextIdentity !== dealsState.cacheIdentity) {
      dealsState = null;
      if (container) loadDeals(container).catch(() => {});
      return;
    }
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
          <button class="btn-refresh" id="deals-refresh">↻ Refresh prices</button>
          <button class="btn-refresh" id="deals-reload">↻ Reload wishlist</button>
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
          <select id="deals-sort" class="tradables-sort" title="Sort by" style="font-size:10px;">
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
    container.querySelector('#deals-refresh').addEventListener('click', () => {
      refreshDealsPrices(container).catch(() => {});
    });
    container.querySelector('#deals-reload').addEventListener('click', () => {
      dealsState = null;
      if (activeWishlistRun) activeWishlistRun.cancelled = true;
      activeWishlistRun = null;
      clearWishlistDisplayForReload(container);
      loadDeals(container, { reloadWishlist: true, forceReloadAll: true }).catch(() => {});
    });
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

  const settings = await msg('GET_SETTINGS');
  const cacheIdentity = getDealsCacheIdentity(settings);

  if (activeWishlistRun?.cacheIdentity === cacheIdentity && activeWishlistRun.progressCardsByTitle?.size) {
    renderWishlistProgress({
      wishlist: [...activeWishlistRun.progressCardsByTitle.keys()],
      done: activeWishlistRun.phase !== 'steam-loading',
    }, activeWishlistRun);
    return;
  }

  // Session guard — instant when switching tabs, but only for the same Steam profile.
  if (dealsState && dealsState.cacheIdentity === cacheIdentity) {
    renderDeals(container);
    return;
  }
  dealsState = null;

  // Persistent cache — instant on popup reopen
  const snap = await new Promise(resolve => chrome.storage.local.get(DEALS_CACHE_KEY, resolve));
  if (snap[DEALS_CACHE_KEY]?.cards?.length && snap[DEALS_CACHE_KEY].profileComplete !== false) {
    const { cards, savedAt, cacheIdentity: cachedIdentity } = snap[DEALS_CACHE_KEY];
    if (cachedIdentity !== cacheIdentity) {
      await loadDeals(container);
      return;
    }
    const sortMode = await getSortMode();
    applySettingsToCards(cards, settings);
    dealsState = {
      cards,
      settings,
      sortMode,
      savedAt,
      withPrices: 0,
      freeGamesCount: 0,
      priceError: null,
      cacheIdentity,
      profileComplete: true,
      failedAppIds: [],
    };
    // Count priced cards
    for (const c of cards) {
      if (c.bestCurrent != null) dealsState.withPrices++;
      if (c.isFree) dealsState.freeGamesCount++;
    }
    renderDeals(container);
    return; // instant — zero async messages to service worker
  }

  const partialCards = snap[DEALS_CACHE_KEY]?.profileComplete === false && snap[DEALS_CACHE_KEY]?.cacheIdentity === cacheIdentity
    && Array.isArray(snap[DEALS_CACHE_KEY]?.partialCards)
    ? snap[DEALS_CACHE_KEY].partialCards
    : null;
  if (partialCards?.length) {
    applySettingsToCards(partialCards, settings);
    const body = container.querySelector('#deals-body');
    const summary = container.querySelector('#deals-summary');
    const sortMode = await getSortMode();
    if (summary) {
      const withPrices = partialCards.filter(card => card.bestCurrent != null).length;
      renderWishlistSummary(summary, {
        cards: partialCards,
        withPrices,
        tail: 'updating…',
      });
    }
    if (body) renderGameList(body, partialCards, settings, sortMode);
  }

  await loadDeals(container, { seedCards: partialCards });
}

async function loadDeals(container, options = {}) {
  return loadDealsInternal(container, options);
}

async function loadDealsInternal(container, {
  manualRefresh = false,
  reloadWishlist = false,
  forceReloadAll = false,
  seedCards = null,
} = {}) {
  const loadSequence = ++dealsLoadSequence;
  const isCurrentLoad = (identity = null) => {
    if (loadSequence !== dealsLoadSequence) return false;
    if (activeWishlistRun?.sequence === loadSequence && activeWishlistRun.cancelled) return false;
    if (!identity) return true;
    const activeIdentity = dealsState?.cacheIdentity;
    const runIdentity = activeWishlistRun?.sequence === loadSequence ? activeWishlistRun.cacheIdentity : null;
    return (!activeIdentity || activeIdentity === identity) && (!runIdentity || runIdentity === identity);
  };
  const summary = container.querySelector('#deals-summary');
  const freeSection = container.querySelector('#deals-free-section');
  const body = container.querySelector('#deals-body');

  const sortMode = await getSortMode();
  const refreshOptions = await getRefreshOptions();
  const settings = await msg('GET_SETTINGS');
  const cacheIdentity = getDealsCacheIdentity(settings);
  const refreshToken = createDealsRefreshToken(loadSequence);
  if (!isCurrentLoad()) return;
  summary.textContent = '';
  freeSection.replaceChildren();
  const usableSeedCards = forceReloadAll ? null : seedCards;
  if (Array.isArray(usableSeedCards) && usableSeedCards.length > 0) {
    applySettingsToCards(usableSeedCards, settings);
    const withPrices = usableSeedCards.filter(card => card.bestCurrent != null).length;
    renderWishlistSummary(summary, {
      cards: usableSeedCards,
      withPrices,
      tail: 'updating…',
    });
    renderGameList(body, usableSeedCards, settings, sortMode);
  } else if (!activeWishlistRun?.progressCardsByTitle?.size) {
    body.replaceChildren(createStateElement('empty-state', 'Loading wishlist…'));
  }
  if (!settings.steamId) {
    dealsState = null;
    const state = createStateElement('error-state', 'No Steam ID set. Add your profile URL in Settings.');
    appendErrorLogLink(state);
    body.replaceChildren(state);
    return;
  }

  // Try cached profile first
  let profile;
  let profileLoad = null;
  let refreshBegun = false;
  try {
    profile = reloadWishlist ? { wishlist: [] } : await msg('GET_CACHED_PROFILE');
    if (!profile.wishlist?.length) {
      profileLoad = {
        requestId: createProfileRequestId(loadSequence),
        steamId: String(settings.steamId),
        generation: null,
        sequence: loadSequence,
        phase: 'steam-loading',
        cancelled: false,
        forceReloadAll,
        refreshToken,
        settings,
        cacheIdentity,
        sortMode,
        progressCardsByTitle: new Map(),
        progressCardsByAppId: new Map(),
        progressPriceKeys: new Set(),
      };
      if (Array.isArray(usableSeedCards) && usableSeedCards.length > 0) {
        for (const card of usableSeedCards) {
          if (!card?.title) continue;
          profileLoad.progressCardsByTitle.set(String(card.title), card);
          if (card.appId) {
            profileLoad.progressCardsByAppId.set(String(card.appId), card);
            profileLoad.progressPriceKeys.add(progressPriceKey({ id: card.appId, type: card.type ?? 'app' }));
          }
        }
      }
      activeWishlistRun = profileLoad;
      try {
        await beginDealsRefresh(cacheIdentity, refreshToken);
      } catch (err) {
        if (!isCurrentWishlistRun(profileLoad, cacheIdentity)) return;
        clearRunIfCurrent(profileLoad);
        const state = createStateElement('error-state', err.message);
        appendErrorLogLink(state);
        body.replaceChildren(state);
        return;
      }
      if (!isCurrentWishlistRun(profileLoad, cacheIdentity)) return;
      refreshBegun = true;
      if (profile.partialWishlist?.length) {
        const resumedProgress = {
          requestId: profileLoad.requestId,
          steamId: profileLoad.steamId,
          wishlist: profile.partialWishlist,
          completed: profile.partialMeta?.completed ?? profile.partialWishlist.length,
          total: profile.partialMeta?.total ?? profile.partialWishlist.length,
          done: false,
          resumed: true,
        };
        renderWishlistProgress(resumedProgress, profileLoad);
        hydrateWishlistProgressCards(resumedProgress, profileLoad).catch(() => {});
      }
      profile = await msg('GET_PROFILE', { requestId: profileLoad.requestId, forceRefresh: reloadWishlist });
      if (!isCurrentWishlistRun(profileLoad, cacheIdentity)) return;
      profileLoad.phase = 'resolving';
    }
  } catch (err) {
    if (activeWishlistRun?.sequence === loadSequence) {
      activeWishlistRun.cancelled = true;
      activeWishlistRun = null;
    }
    if (!isCurrentLoad(cacheIdentity)) return;
    const state = createStateElement('error-state', `Failed to load wishlist: ${err.message}`);
    appendErrorLogLink(state);
    body.replaceChildren(state);
    return;
  }
  if (!isCurrentLoad(cacheIdentity)) return;

  if (profile.storageError) {
    clearRunIfCurrent(profileLoad);
    const state = createStateElement('error-state', profile.error || 'Tradables storage read failed.');
    appendErrorLogLink(state);
    body.replaceChildren(state);
    return;
  }

  if (profile.error === 'Profile request invalidated') {
    clearRunIfCurrent(profileLoad);
    body.replaceChildren(createStateElement('empty-state', 'Profile load was cancelled. Refresh to reload.'));
    return;
  }

  if (!profile.wishlist?.length) {
    clearRunIfCurrent(profileLoad);
    const state = document.createElement('div');
    state.className = 'error-state';
    state.append('No wishlist games found. Make sure your Steam wishlist is set to ');
    const strong = document.createElement('strong');
    strong.textContent = 'Public';
    state.append(strong, '.');
    appendErrorLogLink(state);
    body.replaceChildren(state);
    return;
  }

  if (profileLoad) {
    profileLoad.phase = 'resolving';
    renderWishlistProgress({ wishlist: profile.wishlist, done: true }, profileLoad);
  } else {
    summary.textContent = `${profile.wishlist.length} games on wishlist — updating…`;
  }

  // Resolve titles (try progressive results, then cache, then Steam)
  const cachedRes = forceReloadAll ? {} : await msg('GET_CACHED_RESOLUTIONS', { titles: profile.wishlist });
  if (!isCurrentLoad(cacheIdentity)) return;
  const progressCards = getProgressCardsForWishlist(profileLoad, profile.wishlist);
  const resolutions = profile.wishlist.map(title => {
    const progressCard = profileLoad?.progressCardsByTitle?.get(String(title));
    if (progressCard?.appId) {
      return { appId: progressCard.appId, type: progressCard.type ?? 'app', status: 'hit' };
    }
    return cachedRes[title] ?? null;
  });
  const missing = profile.wishlist
    .map((title, index) => (forceReloadAll || !resolutions[index]) ? { title, index } : null)
    .filter(Boolean);
  if (missing.length > 0) {
    const missingResults = await msg('RESOLVE_TITLES', {
      titles: missing.map(item => item.title),
      forceRefresh: forceReloadAll,
    });
    if (!isCurrentLoad(cacheIdentity)) return;
    missing.forEach((item, index) => {
      resolutions[item.index] = missingResults[index] ?? null;
    });
  }
  if (!isCurrentLoad(cacheIdentity)) return;

  // Build cards with multi-region price storage
  const cards = profile.wishlist.map((title, i) => ({
    ...(progressCards?.[i] ?? {}),
    title,
    appId: resolutions[i]?.appId,
    type: resolutions[i]?.type ?? progressCards?.[i]?.type ?? 'app',
    pricesPerRegion: progressCards?.[i]?.pricesPerRegion ?? null,
    currency: progressCards?.[i]?.currency ?? 'EUR',
    isFree: progressCards?.[i]?.isFree ?? false,
    scrapedAtl: progressCards?.[i]?.scrapedAtl ?? null,
    url: progressCards?.[i]?.url ?? null,
    ggdealsUrl: progressCards?.[i]?.ggdealsUrl ?? null,
    priceStatus: progressCards?.[i]?.priceStatus ?? null,
    // computed at render time by applySettingsToCards:
    bestCurrent: null,
    bestAtl: null,
    pctAboveAtl: null,
  }));
  if (profileLoad) {
    profileLoad.progressCardsByTitle = new Map(cards.map(card => [String(card.title), card]));
    profileLoad.progressCardsByAppId = new Map(cards.filter(card => card.appId).map(card => [String(card.appId), card]));
    applySettingsToCards(cards, settings);
    renderWishlistProgress({ wishlist: profile.wishlist, done: true }, profileLoad);
  }

  const priceItems = resolutions.filter(r => r?.appId).map(r => ({ id: r.appId, type: r.type ?? 'app' }));
  const itemKey = (item) => `${item.type ?? 'app'}:${item.id}`;
  const itemKeys = priceItems.map(itemKey);
  const appIds = priceItems.map(item => item.id);
  if (!appIds.length) {
    clearRunIfCurrent(profileLoad);
    summary.textContent = `${profile.wishlist.length} games on wishlist`;
    body.replaceChildren(createStateElement('empty-state', 'Could not resolve any wishlist games to App IDs.'));
    return;
  }

  let priceError = null;

  // Fetch prices. Initial loads fill missing cached entries; manual refreshes either
  // bypass all cache or refresh only entries older than the selected age.
  if (settings.apiKey) {
    if (profileLoad) profileLoad.phase = 'pricing';
    const regions = settings.regions ?? [getDisplayRegion(settings)];
    let prices = null;
    if (!forceReloadAll) {
      try { prices = await msg('GET_CACHED_PRICES', { items: priceItems, regions }); } catch {}
    }
    if (!isCurrentLoad(cacheIdentity)) return;

    const applyPricesAndRender = async () => {
      if (prices) applyPriceResponseToCards(cards, prices);
      applySettingsToCards(cards, settings);
      if (profileLoad) {
        renderWishlistProgress({ wishlist: profile.wishlist, done: true }, profileLoad);
        await persistDealsRefreshProgress(profileLoad, cards);
      }
    };
    await applyPricesAndRender();

    let itemKeysToFetch = [];
    if (forceReloadAll) {
      itemKeysToFetch = itemKeys;
    } else if (manualRefresh && !refreshOptions.ignoreCached) {
      itemKeysToFetch = itemKeys;
    } else if (manualRefresh && refreshOptions.ignoreCached) {
      itemKeysToFetch = getStaleAppIds(itemKeys, prices, regions, CACHE_AGE_OPTIONS[refreshOptions.maxAge]);
    } else {
      itemKeysToFetch = getStaleAppIds(itemKeys, prices, regions, Infinity);
    }

    if (itemKeysToFetch.length > 0) {
      const itemsToFetch = priceItems.filter(item => itemKeysToFetch.includes(itemKey(item)));
      for (const chunk of chunkArray(itemsToFetch, FINAL_PRICE_CHUNK_SIZE)) {
        try {
          const livePrices = await msg((manualRefresh || forceReloadAll) ? 'REFRESH_PRICES' : 'GET_PRICES', { items: chunk, regions });
          if (!isCurrentLoad(cacheIdentity)) return;
          const merged = mergePriceResponse(prices, livePrices);
          prices = merged.prices;
          if (merged.error) priceError = merged.error;
          await applyPricesAndRender();
        } catch (err) {
          priceError = err.message;
          break;
        }
      }
    }
    if (!isCurrentLoad(cacheIdentity)) return;

    await applyPricesAndRender();
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
        if (!isCurrentLoad(cacheIdentity)) return;
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
  const cardsToStore = serializeDealsCards(cards);
  if (!isCurrentLoad(cacheIdentity)) return;
  const savedAt = Date.now();
  let persistedAt = null;
  if (profile.profileComplete !== false) {
    if (!refreshBegun) {
      try {
        await beginDealsRefresh(cacheIdentity, refreshToken);
        refreshBegun = true;
      } catch (err) {
        priceError = err.message;
      }
      if (!isCurrentLoad(cacheIdentity)) return;
    }
    if (refreshBegun) {
      const commit = await msg('COMMIT_DEALS_REFRESH', {
        cacheIdentity,
        refreshToken,
        cards: cardsToStore,
        savedAt,
        failedAppIds: [],
      });
      if (commit?.ok === true) {
        persistedAt = savedAt;
      } else if (commit?.code !== 'STALE_REFRESH') {
        priceError = commit?.error || 'Wishlist cache could not be persisted.';
      }
    }
  }
  if (!isCurrentLoad(cacheIdentity)) return;

  const withPrices = cards.filter(c => c.bestCurrent != null).length;
  dealsState = {
    cards,
    settings,
    sortMode,
    withPrices,
    freeGamesCount,
    priceError,
    savedAt: persistedAt,
    cacheIdentity,
    profileComplete: profile.profileComplete !== false,
    failedAppIds: Array.isArray(profile.failedAppIds) ? profile.failedAppIds : [],
  };
  if (profileLoad && isCurrentWishlistRun(profileLoad, cacheIdentity)) {
    profileLoad.phase = 'complete';
    activeWishlistRun = null;
  }
  renderDeals(container);
}

function renderDeals(container) {
  if (!dealsState || !container) return;
  const body = container.querySelector('#deals-body');
  const summary = container.querySelector('#deals-summary');
  const freeSection = container.querySelector('#deals-free-section');
  const cacheStatus = container.querySelector('#deals-cache-status');

  const { cards, settings, withPrices, freeGamesCount, priceError, sortMode, savedAt, profileComplete, failedAppIds = [] } = dealsState;
  const sortSelect = container.querySelector('#deals-sort');
  if (sortSelect && sortSelect.value !== sortMode) sortSelect.value = sortMode;

  // Header timestamp
  cacheStatus.textContent = savedAt ? `Last: ${formatTimestamp(savedAt)}` : '';

  renderWishlistSummary(summary, {
    cards,
    withPrices,
    settings,
    priceError,
    profileComplete,
    failedAppIds,
  });

  // Free-game giveaway section
  if (freeGamesCount > 0) {
    const freeGames = cards.filter(c => c.isFree);
    const fetchedCount = freeGames.filter(c => c.scrapedAtl != null).length;
    const note = document.createElement('div');
    note.setAttribute('style', 'font-size:11px;color:#f1c40f;');
    note.textContent = `⚠ ${freeGamesCount} games were FREE (giveaway) ${fetchedCount > 0 ? `✓ ${fetchedCount} fetched` : ''}`;

    const button = document.createElement('button');
    button.className = 'btn-fetch-free';
    button.id = 'fetch-free-btn';
    button.setAttribute('style', `font-size:10px;padding:2px 8px;${fetchedCount === freeGamesCount ? 'opacity:0.5' : ''}`);
    button.textContent = fetchedCount === freeGamesCount ? 'Already fetched' : 'Fetch better ATL';

    const status = document.createElement('div');
    status.id = 'fetch-free-status';
    status.setAttribute('style', 'font-size:10px;color:#8a9bb0;');
    freeSection.replaceChildren(note, button, status);
  } else {
    freeSection.replaceChildren();
  }

  renderGameList(body, cards, settings, sortMode);
}

function renderGameList(body, cards, settings, sortMode) {
  body.replaceChildren(createDealsGameListElement(cards, settings, sortMode));
}

export function createDealsGameListElement(cards, settings, sortMode) {
  const sortedCards = [...cards];
  sortedCards.sort((a, b) => {
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

  const list = document.createElement('div');
  list.className = 'game-list';
  list.replaceChildren(...sortedCards.map(card => createDealsGameCardElement(card, settings)));
  return list;
}

function appendCardTitle(title, card, settings) {
  const steamUrl = card.appId ? steamStoreUrl(card.appId, card.type ?? 'app') : null;
  const steamLink = steamUrl
    ? createExternalLink(steamUrl, card.title ?? '', { style: 'color:inherit;text-decoration:none;' })
    : null;
  title.append(steamLink ?? String(card.title ?? ''));

  const refreshDate = formatRefreshDate(getCardRefreshTimestamp(card, settings));
  if (refreshDate) {
    const refresh = document.createElement('span');
    refresh.className = 'game-card-refresh';
    refresh.textContent = `- Last refresh ${refreshDate}`;
    title.append(' ', refresh);
  }
}

function appendGgDealsLink(meta, card) {
  const ggDealsUrl = card.ggdealsUrl ?? card.url;
  const link = createExternalLink(ggDealsUrl, 'GG.deals ↗', { style: 'color:#66c0f4;' });
  if (!link) return;
  meta.append(' · ', link);
}

export function createDealsGameCardElement(card, settings) {
  const gameCard = document.createElement('div');
  gameCard.className = 'game-card';

  const title = document.createElement('div');
  title.className = 'game-card-title';
  appendCardTitle(title, card, settings);

  const meta = document.createElement('div');
  meta.className = 'game-card-meta';

  if (card.isFree) {
    const badge = document.createElement('span');
    badge.className = 'badge-was-free';
    badge.textContent = 'Was free';
    title.append(' ', badge);

    const current = document.createElement('span');
    current.className = 'highlight';
    current.textContent = formatPrice(card.bestCurrent, card.currency);

    const atlDisplay = card.scrapedAtl != null
      ? `Best paid: ${formatPrice(card.scrapedAtl, card.currency)}`
      : 'Best paid: -- (not fetched)';
    const pctDisplay = card.scrapedAtl != null ? ` · ${Math.round(card.pctAboveAtl)}% above` : '';
    meta.append(current, ` · ${atlDisplay}${pctDisplay}`);
    appendGgDealsLink(meta, card);
    gameCard.replaceChildren(title, meta);
    return gameCard;
  }

  if (card.bestCurrent != null) {
    const deal = card.pctAboveAtl != null && card.pctAboveAtl <= (settings.dealThresholdPct ?? 10);
    const current = document.createElement('span');
    if (deal) current.className = 'highlight';
    current.textContent = formatPrice(card.bestCurrent, card.currency);

    const region = document.createElement('span');
    region.setAttribute('style', 'color:#666;font-size:10px;text-transform:uppercase;margin-left:2px');
    region.textContent = `(${card.usedRegion?.toUpperCase() ?? ''})`;

    const atl = document.createElement('span');
    atl.className = 'atl';
    atl.textContent = formatPrice(card.bestAtl, card.currency);

    const atlLabel = settings.keyshopsEnabled && card.historicalKeyshops != null
      && (card.historicalRetail == null || card.historicalKeyshops < card.historicalRetail)
      ? 'Keyshop ATL' : 'ATL';
    meta.append(current, ' ', region, ` · ${atlLabel}: `, atl);
    if (card.pctAboveAtl != null) {
      const pct = document.createElement('span');
      pct.textContent = `${Math.round(card.pctAboveAtl)}% above`;
      meta.append(' · ', pct);
    }
    appendGgDealsLink(meta, card);
    gameCard.replaceChildren(title, meta);
    return gameCard;
  }

  gameCard.setAttribute('style', 'opacity:0.7');
  if (card.priceStatus?.type === 'rate-limited') {
    const resetTime = formatResetTime(card.priceStatus.resetAt);
    meta.setAttribute('style', 'color:#e8a735');
    meta.textContent = `${card.appId ? `App ID: ${card.appId}` : 'Unresolved'} — GG.deals API limit reached — ${resetTime ? `resets at ${resetTime}` : 'retrying shortly'}`;
  } else {
    meta.setAttribute('style', 'color:#666');
    meta.textContent = `${card.appId ? `App ID: ${card.appId}` : 'Unresolved'} — Price unavailable`;
  }
  gameCard.replaceChildren(title, meta);
  return gameCard;
}
