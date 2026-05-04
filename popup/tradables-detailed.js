// popup/tradables-detailed.js
import { getPriceRange } from '../background/snapshots.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function msg(type, data = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...data }, resolve));
}

function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

function rangeLabel(ratio, settings) {
  if (ratio >= (settings.rangeHighRatio ?? 3.0)) return 'HIGH';
  if (ratio >= (settings.rangeLowRatio ?? 1.5)) return 'MID';
  return 'LOW';
}

export async function initTradablesDetailed(container) {
  // Set up persistent wrapper with refresh button on first call
  if (!container.querySelector('#tradables-detailed-header')) {
    container.innerHTML = `
      <div id="tradables-detailed-header" style="text-align:right;padding:0 0 6px">
        <button class="btn-refresh" id="tradables-detailed-refresh">↻ Refresh</button>
      </div>
      <div id="tradables-detailed-body"></div>
    `;
    container.querySelector('#tradables-detailed-refresh').addEventListener('click', () => initTradablesDetailed(container));
  }
  const body = container.querySelector('#tradables-detailed-body');

  body.innerHTML = '<div class="empty-state">Loading tradables detailed…</div>';

  const settings = await msg('GET_SETTINGS');
  if (!settings.apiKey || !settings.steamId) {
    body.innerHTML = '<div class="error-state">Set API key and Steam ID in Settings first.</div>';
    return;
  }

  const profile = await msg('GET_PROFILE');
  if (profile.error) {
    body.innerHTML = `<div class="error-state">${escapeHtml(profile.error)}</div>`;
    return;
  }
  const tradables = profile.tradables ?? [];
  if (!tradables.length) {
    body.innerHTML = '<div class="empty-state">No tradable games found. Add your tradables in Settings.</div>';
    return;
  }

  const resolutions = await msg('RESOLVE_TITLES', { titles: tradables });
  const appIds = resolutions
    .filter(r => r?.status === 'hit' || r?.status === 'resolved')
    .map(r => r.appId);

  const prices = await msg('GET_PRICES', { appIds, regions: settings.regions });
  const region = settings.regions[0];

  const html = [];

  for (let i = 0; i < tradables.length; i++) {
    const title = tradables[i];
    const appId = resolutions[i]?.appId;
    if (!appId) continue;

    const data = prices[appId]?.[region];
    if (!data) continue;

    const currentRetail = data.prices?.currentRetail;
    const historicalRetail = data.prices?.historicalRetail;
    const historicalKeyshops = data.prices?.historicalKeyshops;
    const currentKeyshops = data.prices?.currentKeyshops;
    const currency = data.prices?.currency ?? 'EUR';
    if (currentRetail == null) continue;

    // Determine best ATL (min of retail and keyshop)
    let bestAtl = historicalRetail;
    if (settings.keyshopsEnabled && historicalKeyshops != null) {
      if (bestAtl == null || historicalKeyshops < bestAtl) {
        bestAtl = historicalKeyshops;
      }
    }

    // Price range indicator
    let rangeStr = '';
    const snapRange = await getPriceRange(appId, region, settings.snapshotWindowDays ?? 180);
    if (snapRange) {
      const ratio = snapRange.min > 0 ? currentRetail / snapRange.min : 1;
      const rl = rangeLabel(ratio, settings);
      rangeStr = `<span class="range-${rl}">${rl}</span> <span style="color:#555">(180d history)</span>`;
    } else if (bestAtl > 0) {
      const ratio = currentRetail / bestAtl;
      const rl = rangeLabel(ratio, settings);
      rangeStr = `<span class="range-${rl}">${rl}</span> <span style="color:#555">(ATL basis)</span>`;
    }

    // Acquisition price P/L
    const { price: acqPrice } = await msg('GET_ACQ_PRICE', { appId });
    let acqHtml = '';
    if (acqPrice != null) {
      const diff = currentRetail - acqPrice;
      const pct = Math.round(diff / acqPrice * 100);
      acqHtml = `<div class="game-card-meta ${diff >= 0 ? 'high' : 'low'}">
        Paid ${formatPrice(acqPrice, currency)} → Now ${formatPrice(currentRetail, currency)} → ${diff >= 0 ? '+' : ''}${formatPrice(diff, currency)} (${pct}%)
      </div>`;
    }

    // Keyshop flip opportunity
    let keyshopHtml = '';
    if (settings.keyshopsEnabled && currentKeyshops != null) {
      const fees = settings.keyshopFees ?? {};
      const enabledShops = settings.keyshops ?? [];
      if (enabledShops.length > 0) {
        const minFee = Math.min(...enabledShops.map(s => fees[s]?.min ?? 8));
        const maxFee = Math.max(...enabledShops.map(s => fees[s]?.max ?? 15));
        const costMin = Math.round(currentKeyshops * (1 + minFee / 100));
        const costMax = Math.round(currentKeyshops * (1 + maxFee / 100));
        const gapMin = currentRetail - costMax;
        const gapMax = currentRetail - costMin;
        if (gapMin > 0) {
          keyshopHtml = `<div class="game-card-meta">
            Keyshop flip: Buy ${formatPrice(currentKeyshops, currency)} +${minFee}–${maxFee}% fee →
            <span class="high">Gap ${formatPrice(gapMin, currency)}–${formatPrice(gapMax, currency)}</span>
            <span style="color:#555;font-size:9px"> (est.)</span>
          </div>`;
        }
      }
    }

    const atlLabel = settings.keyshopsEnabled ? 'Historical ATL' : 'ATL';
    html.push(`
      <div class="game-card">
        <div class="game-card-title">${escapeHtml(title)}</div>
        <div class="game-card-meta">
          GG.deals: <strong>${formatPrice(currentRetail, currency)}</strong>
          · ${atlLabel}: <span class="atl">${formatPrice(bestAtl ?? historicalRetail, currency)}</span>
        </div>
        <div class="game-card-range">${rangeStr}</div>
        ${acqHtml}
        ${keyshopHtml}
      </div>
    `);
  }

  body.innerHTML = html.length
    ? `<div class="game-list">${html.join('')}</div>`
    : '<div class="empty-state">No tradables data available.</div>';
}
