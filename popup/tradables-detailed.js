// popup/tradables-detailed.js
import { getPriceRange } from '../background/snapshots.js';

function msg(type, data = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...data }, resolve));
}

const tradablesDetailedState = {
  revision: null,
  tradables: [],
  cards: [],
  loading: false,
  error: null,
  generation: 0,
  settings: null,
};

let detailedListenersRegistered = false;
let activeDetailedContainer = null;

async function safeGetPriceRange(appId, region, days) {
  try {
    if (typeof indexedDB === 'undefined') return null;
    return await getPriceRange(appId, region, days);
  } catch {
    return null;
  }
}

function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

function normalizePriceType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
}

function normalizeStoredAppId(appId) {
  const value = String(appId ?? '').trim();
  return /^\d+$/.test(value) ? value : null;
}

function steamStoreUrl(id, type = 'app') {
  const appId = normalizeStoredAppId(id);
  if (!appId) return null;
  return `https://store.steampowered.com/${normalizePriceType(type)}/${encodeURIComponent(appId)}`;
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
  if (options.title) link.title = options.title;
  return link;
}

function readPriceRegion(prices, id, type = 'app', region) {
  if (!prices || !id) return null;
  const normalizedType = normalizePriceType(type);
  const typed = prices[`${normalizedType}:${id}`]?.[region];
  if (typed) return typed;
  return normalizedType === 'app' ? prices[id]?.[region] ?? null : null;
}

function rangeLabel(ratio, settings) {
  if (ratio >= (settings.rangeHighRatio ?? 3.0)) return 'HIGH';
  if (ratio >= (settings.rangeLowRatio ?? 1.5)) return 'MID';
  return 'LOW';
}

export function createDetailedStateElement(type, message, { includeErrorLogLink = false } = {}) {
  const state = document.createElement('div');
  state.className = type === 'error' ? 'error-state' : 'empty-state';
  state.appendChild(document.createTextNode(String(message ?? '')));

  if (includeErrorLogLink) {
    state.appendChild(document.createTextNode(' '));
    const link = document.createElement('a');
    link.className = 'error-log-inline';
    link.href = 'popup.html?tab=settings&focus=error-log';
    link.textContent = 'See error logs';
    state.appendChild(link);
  }

  return state;
}

export function createEmptyTradablesDetailedElement() {
  const state = document.createElement('div');
  state.className = 'empty-state';
  state.append('No tradable games found. Add your tradables in ');
  const link = document.createElement('a');
  link.href = 'popup.html?tab=tradables';
  link.textContent = 'Tradables';
  link.style.color = 'inherit';
  link.style.textDecoration = 'underline';
  state.append(link, '.');
  return state;
}

function tradableTitle(item) {
  return typeof item === 'string' ? item : item?.name;
}

function normalizeDetailedTradables(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map(item => (typeof item === 'string' ? { name: item, type: 'app' } : item))
    .filter(item => typeof item?.name === 'string' && item.name.trim())
    .map(item => ({ ...item, name: item.name.trim(), type: normalizePriceType(item.type ?? 'app') }));
}

function detailedRevisionFromPayload(payload) {
  return payload?.revision ?? payload?.tradablesRevision ?? null;
}

function renderDetailedState(container) {
  if (!container) return;
  const body = container.querySelector('#tradables-detailed-body');
  if (!body) return;
  if (tradablesDetailedState.error) {
    body.replaceChildren(createDetailedStateElement('error', tradablesDetailedState.error, { includeErrorLogLink: true }));
    return;
  }
  if (tradablesDetailedState.tradables.length === 0 && !tradablesDetailedState.loading) {
    body.replaceChildren(createEmptyTradablesDetailedElement());
    return;
  }
  if (tradablesDetailedState.cards.length > 0) {
    const list = document.createElement('div');
    list.className = 'game-list';
    list.append(...tradablesDetailedState.cards);
    body.replaceChildren(list);
    return;
  }
  if (tradablesDetailedState.loading) {
    const list = document.createElement('div');
    list.className = 'game-list';
    const placeholders = tradablesDetailedState.tradables.map(item => {
      const card = document.createElement('div');
      card.className = 'game-card';
      const title = document.createElement('div');
      title.className = 'game-card-title';
      title.textContent = item.name;
      const meta = document.createElement('div');
      meta.className = 'game-card-meta';
      meta.textContent = 'Loading price details…';
      card.append(title, meta);
      return card;
    });
    list.append(...placeholders);
    body.replaceChildren(list);
    return;
  }
  body.replaceChildren(createDetailedStateElement('empty', 'No tradables data available.'));
}

async function buildDetailedCards({ settings, tradables, generation, refreshPrices = false }) {
  const titles = tradables.map(tradableTitle).filter(Boolean);
  const resolutions = await msg('RESOLVE_TITLES', { titles });
  if (generation !== tradablesDetailedState.generation) return null;
  const appIds = resolutions
    .filter(r => r?.status === 'hit' || r?.status === 'resolved')
    .map(r => ({ id: r.appId, type: r.type ?? 'app' }));
  if (appIds.length === 0) return [];
  const prices = await msg(refreshPrices ? 'REFRESH_PRICES' : 'GET_PRICES', {
    items: appIds,
    regions: settings.regions,
    fetchIntent: refreshPrices ? 'manual-refresh' : 'automatic',
  });
  if (generation !== tradablesDetailedState.generation) return null;
  const region = settings.regions?.[0] ?? 'eu';
  const cards = [];
  for (let i = 0; i < titles.length; i++) {
    const title = titles[i];
    const appId = resolutions[i]?.appId;
    const type = resolutions[i]?.type ?? 'app';
    if (!appId) continue;
    const data = readPriceRegion(prices, appId, type, region);
    if (!data) continue;
    const currentRetail = data.prices?.currentRetail;
    const historicalRetail = data.prices?.historicalRetail;
    const historicalKeyshops = data.prices?.historicalKeyshops;
    const currentKeyshops = data.prices?.currentKeyshops;
    const currency = data.prices?.currency ?? 'EUR';
    if (currentRetail == null) continue;
    const snapRange = await safeGetPriceRange(appId, region, settings.snapshotWindowDays ?? 180);
    if (generation !== tradablesDetailedState.generation) return null;
    const { price: acqPrice } = await msg('GET_ACQ_PRICE', { appId, itemType: type });
    if (generation !== tradablesDetailedState.generation) return null;
    cards.push(createTradablesDetailedCardElement({
      title,
      appId,
      type,
      ggDealsUrl: data.url,
      currentRetail,
      historicalRetail,
      historicalKeyshops,
      currentKeyshops,
      currency,
      snapRange,
      acqPrice,
      settings,
    }));
  }
  return cards;
}

async function loadTradablesDetailed({ container = activeDetailedContainer, force = false, refreshPrices = false } = {}) {
  const generation = ++tradablesDetailedState.generation;
  const settings = await msg('GET_SETTINGS');
  if (generation !== tradablesDetailedState.generation) return;
  tradablesDetailedState.settings = settings;
  if (!settings.apiKey || !settings.steamId) {
    tradablesDetailedState.error = 'Set API key and Steam ID in Settings first.';
    tradablesDetailedState.loading = false;
    renderDetailedState(container);
    return;
  }
  const tradablesRead = await msg('GET_TRADABLES');
  if (generation !== tradablesDetailedState.generation) return;
  if (tradablesRead?.storageError) {
    tradablesDetailedState.error = tradablesRead.error || 'Tradables storage read failed';
    tradablesDetailedState.loading = false;
    renderDetailedState(container);
    return;
  }
  const revision = detailedRevisionFromPayload(tradablesRead);
  const tradables = normalizeDetailedTradables(tradablesRead?.tradables ?? tradablesRead);
  if (!force && !refreshPrices && tradablesDetailedState.revision === revision && tradablesDetailedState.cards.length > 0) {
    renderDetailedState(container);
    return;
  }
  tradablesDetailedState.revision = revision;
  tradablesDetailedState.tradables = tradables;
  tradablesDetailedState.error = null;
  tradablesDetailedState.loading = tradables.length > 0;
  if (tradables.length === 0) {
    tradablesDetailedState.cards = [];
    tradablesDetailedState.loading = false;
    renderDetailedState(container);
    return;
  }
  renderDetailedState(container);
  const cards = await buildDetailedCards({ settings, tradables, generation, refreshPrices });
  if (cards == null || generation !== tradablesDetailedState.generation) return;
  tradablesDetailedState.cards = cards;
  tradablesDetailedState.loading = false;
  renderDetailedState(container);
}

function ensureDetailedRuntimeListeners() {
  if (detailedListenersRegistered) return;
  if (!globalThis.chrome?.runtime?.onMessage?.addListener) return;
  detailedListenersRegistered = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'TRADABLES_UPDATED') return;
    const tradables = normalizeDetailedTradables(message.tradables);
    tradablesDetailedState.revision = message.revision ?? null;
    tradablesDetailedState.tradables = tradables;
    tradablesDetailedState.cards = [];
    tradablesDetailedState.error = null;
    tradablesDetailedState.loading = tradables.length > 0;
    renderDetailedState(activeDetailedContainer);
    if (tradables.length > 0) {
      loadTradablesDetailed({ force: true }).catch(() => {});
    }
  });
}

ensureDetailedRuntimeListeners();

export function createTradablesDetailedCardElement({
  title,
  appId = null,
  type = 'app',
  ggDealsUrl = null,
  currentRetail,
  historicalRetail,
  historicalKeyshops,
  currentKeyshops,
  currency = 'EUR',
  snapRange = null,
  acqPrice = null,
  settings = {},
}) {
  let bestAtl = historicalRetail;
  if (settings.keyshopsEnabled && historicalKeyshops != null
    && (bestAtl == null || historicalKeyshops < bestAtl)) {
    bestAtl = historicalKeyshops;
  }

  const card = document.createElement('div');
  card.className = 'game-card';

  const titleElement = document.createElement('div');
  titleElement.className = 'game-card-title';
  const steamUrl = steamStoreUrl(appId, type);
  const steamLink = steamUrl
    ? createExternalLink(steamUrl, title ?? '', {
      style: 'color:inherit;text-decoration:underline;',
      title: 'Open on Steam',
    })
    : null;
  titleElement.append(steamLink ?? String(title ?? ''));

  const priceMeta = document.createElement('div');
  priceMeta.className = 'game-card-meta';
  const ggDealsLink = createExternalLink(ggDealsUrl, 'GG.deals ↗', { style: 'color:#66c0f4;' });
  if (ggDealsLink) {
    priceMeta.append(ggDealsLink, document.createTextNode(': '));
  }
  const current = document.createElement('strong');
  current.textContent = formatPrice(currentRetail, currency);
  priceMeta.append(current, document.createTextNode(` · ${settings.keyshopsEnabled ? 'Historical ATL' : 'ATL'}: `));
  const atl = document.createElement('span');
  atl.className = 'atl';
  atl.textContent = formatPrice(bestAtl ?? historicalRetail, currency);
  priceMeta.appendChild(atl);

  const range = document.createElement('div');
  range.className = 'game-card-range';
  let rangeBasis = '';
  let ratio = null;
  if (snapRange) {
    ratio = snapRange.min > 0 ? currentRetail / snapRange.min : 1;
    rangeBasis = '(180d history)';
  } else if (bestAtl > 0) {
    ratio = currentRetail / bestAtl;
    rangeBasis = '(ATL basis)';
  }
  if (ratio != null) {
    const label = rangeLabel(ratio, settings);
    const labelElement = document.createElement('span');
    labelElement.className = `range-${label}`;
    labelElement.textContent = label;
    const basis = document.createElement('span');
    basis.style.color = '#555';
    basis.textContent = ` ${rangeBasis}`;
    range.append(labelElement, basis);
  }

  card.append(titleElement, priceMeta, range);

  if (acqPrice != null) {
    const diff = currentRetail - acqPrice;
    const acquisition = document.createElement('div');
    acquisition.className = `game-card-meta ${diff >= 0 ? 'high' : 'low'}`;
    const percentage = acqPrice === 0 ? '' : ` (${Math.round(diff / acqPrice * 100)}%)`;
    acquisition.textContent = `Paid ${formatPrice(acqPrice, currency)} → Now ${formatPrice(currentRetail, currency)} → ${diff >= 0 ? '+' : ''}${formatPrice(diff, currency)}${percentage}`;
    card.appendChild(acquisition);
  }

  if (settings.keyshopsEnabled && currentKeyshops != null) {
    const fees = settings.keyshopFees ?? {};
    const enabledShops = settings.keyshops ?? [];
    if (enabledShops.length > 0) {
      const minFee = Math.min(...enabledShops.map(shop => fees[shop]?.min ?? 8));
      const maxFee = Math.max(...enabledShops.map(shop => fees[shop]?.max ?? 15));
      const costMin = Math.round(currentKeyshops * (1 + minFee / 100));
      const costMax = Math.round(currentKeyshops * (1 + maxFee / 100));
      const gapMin = currentRetail - costMax;
      const gapMax = currentRetail - costMin;
      if (gapMin > 0) {
        const keyshop = document.createElement('div');
        keyshop.className = 'game-card-meta';
        keyshop.appendChild(document.createTextNode(`Keyshop flip: Buy ${formatPrice(currentKeyshops, currency)} +${minFee}–${maxFee}% fee → `));
        const gap = document.createElement('span');
        gap.className = 'high';
        gap.textContent = `Gap ${formatPrice(gapMin, currency)}–${formatPrice(gapMax, currency)}`;
        const estimate = document.createElement('span');
        estimate.style.color = '#555';
        estimate.style.fontSize = '9px';
        estimate.textContent = ' (est.)';
        keyshop.append(gap, estimate);
        card.appendChild(keyshop);
      }
    }
  }

  return card;
}

export async function initTradablesDetailed(container) {
  activeDetailedContainer = container;
  ensureDetailedRuntimeListeners();
  // Set up persistent wrapper with refresh button on first call
  if (!container.querySelector('#tradables-detailed-header')) {
    // Static shell only: no user or remote data is interpolated here.
    container.innerHTML = `
      <div id="tradables-detailed-header" style="text-align:right;padding:0 0 6px">
        <button class="btn-refresh" id="tradables-detailed-refresh">↻ Refresh</button>
      </div>
      <div id="tradables-detailed-body"></div>
    `;
    container.querySelector('#tradables-detailed-refresh').addEventListener('click', () => {
      loadTradablesDetailed({ container, force: true, refreshPrices: true }).catch(() => {});
    });
  }
  renderDetailedState(container);
  await loadTradablesDetailed({ container });
}
