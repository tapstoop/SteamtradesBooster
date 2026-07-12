// popup/tradables-detailed.js
import { getPriceRange } from '../background/snapshots.js';
import { createExternalLink, createGgDealsLinkElement, steamStoreUrl } from './deals.js';

function msg(type, data = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...data }, resolve));
}

function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

function normalizePriceType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
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

export function createTradablesDetailedCardElement({
  title,
  currentRetail,
  historicalRetail,
  historicalKeyshops,
  currentKeyshops,
  currency = 'EUR',
  snapRange = null,
  acqPrice = null,
  settings = {},
  appId = null,
  type = 'app',
  ggDealsUrl = null,
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
  const steamUrl = appId ? steamStoreUrl(appId, type) : null;
  const steamLink = steamUrl
    ? createExternalLink(steamUrl, title ?? '', { title: 'Open on Steam', style: 'color:inherit;text-decoration:underline;' })
    : null;
  titleElement.append(steamLink ?? String(title ?? ''));

  const priceMeta = document.createElement('div');
  priceMeta.className = 'game-card-meta';
  const ggDealsLink = createGgDealsLinkElement(ggDealsUrl);
  if (ggDealsLink) priceMeta.append(ggDealsLink, document.createTextNode(': '));
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
  // Set up persistent wrapper with refresh button on first call
  if (!container.querySelector('#tradables-detailed-header')) {
    // Static shell only: no user or remote data is interpolated here.
    container.innerHTML = `
      <div id="tradables-detailed-header" style="text-align:right;padding:0 0 6px">
        <button class="btn-refresh" id="tradables-detailed-refresh">↻ Refresh</button>
      </div>
      <div id="tradables-detailed-body"></div>
    `;
    container.querySelector('#tradables-detailed-refresh').addEventListener('click', () => initTradablesDetailed(container));
  }
  const body = container.querySelector('#tradables-detailed-body');

  body.replaceChildren(createDetailedStateElement('empty', 'Loading tradables detailed…'));

  const settings = await msg('GET_SETTINGS');
  if (!settings.apiKey || !settings.steamId) {
    body.replaceChildren(createDetailedStateElement(
      'error',
      'Set API key and Steam ID in Settings first.',
      { includeErrorLogLink: true },
    ));
    return;
  }

  const profile = await msg('GET_PROFILE');
  if (profile.error) {
    body.replaceChildren(createDetailedStateElement('error', profile.error, { includeErrorLogLink: true }));
    return;
  }
  const tradables = profile.tradables ?? [];
  if (!tradables.length) {
    body.replaceChildren(createDetailedStateElement(
      'empty',
      'No tradable games found. Add your tradables in Settings.',
    ));
    return;
  }

  const resolutions = await msg('RESOLVE_TITLES', { titles: tradables });
  const appIds = resolutions
    .filter(r => r?.status === 'hit' || r?.status === 'resolved')
    .map(r => ({ id: r.appId, type: r.type ?? 'app' }));

  const prices = await msg('GET_PRICES', { items: appIds, regions: settings.regions });
  const region = settings.regions[0];

  const cards = [];

  for (let i = 0; i < tradables.length; i++) {
    const title = tradables[i];
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

    const snapRange = await getPriceRange(appId, region, settings.snapshotWindowDays ?? 180);

    const { price: acqPrice } = await msg('GET_ACQ_PRICE', { appId, itemType: type });
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

  if (cards.length) {
    const list = document.createElement('div');
    list.className = 'game-list';
    list.append(...cards);
    body.replaceChildren(list);
  } else {
    body.replaceChildren(createDetailedStateElement('empty', 'No tradables data available.'));
  }
}
