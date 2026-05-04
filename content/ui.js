// content/ui.js — Barrel file: re-exports from split modules + old sidebar helpers
// Old monolith is gone. All logic lives in focused modules.

export * from './ui-helpers.js';
export * from './ui-badges.js';
export * from './ui-pickers.js';
export { SidebarWorkstation } from './ui-workstation.js';

// ── Old Sidebar (still used by content.js) ────────────────────────────

let sidebar = null;
const sidebarRows = new Map();
let onFetchSelectedCallback = null;

export function initSidebar(onFetchSelected) {
  if (sidebar) return;
  sidebar = document.createElement('div');
  sidebar.id = 'stpt-sidebar';
  onFetchSelectedCallback = onFetchSelected;

  sidebar.innerHTML = `
    <div class="stpt-sidebar-strip"></div>
    <div class="stpt-sidebar-header">
      <span>ANALYSIS</span>
      <span class="stpt-sidebar-close">✕</span>
    </div>
    <div class="stpt-sidebar-body" id="stpt-sidebar-body"></div>
    <div class="stpt-sidebar-fetch" id="stpt-sidebar-fetch" style="display:none;">
      <span id="stpt-fetch-count">0</span> selected
      <button class="stpt-fetch-btn" id="stpt-fetch-btn">Fetch Prices</button>
    </div>
    <div class="stpt-sidebar-footer">
      <button class="stpt-sidebar-dashboard-btn">Open Dashboard →</button>
    </div>
  `;

  sidebar.querySelector('.stpt-sidebar-close').addEventListener('click', () => {
    sidebar.classList.add('collapsed');
  });
  sidebar.querySelector('.stpt-sidebar-strip').addEventListener('click', () => {
    sidebar.classList.remove('collapsed');
  });
  sidebar.querySelector('.stpt-sidebar-dashboard-btn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' });
  });
  sidebar.querySelector('.stpt-fetch-btn').addEventListener('click', () => {
    if (onFetchSelectedCallback) onFetchSelectedCallback();
  });

  document.body.appendChild(sidebar);
}

export function updateFetchButton() {
  if (!sidebar) return;
  const fetchDiv = sidebar.querySelector('.stpt-sidebar-fetch');
  const countSpan = sidebar.querySelector('#stpt-fetch-count');
  const checkboxes = document.querySelectorAll('.stpt-game-checkbox:checked');
  const count = checkboxes.length;

  if (count > 0) {
    fetchDiv.style.display = 'flex';
    countSpan.textContent = count;
  } else {
    fetchDiv.style.display = 'none';
  }
}

export function addSidebarRow(appId) {
  if (!sidebar) return;
  const row = document.createElement('div');
  row.className = 'stpt-sidebar-row';
  row.textContent = '—';
  row.dataset.appid = appId;
  sidebar.querySelector('#stpt-sidebar-body').appendChild(row);
  sidebarRows.set(appId, row);
  return row;
}

export function updateSidebarRow(appId, gameInfo) {
  const row = sidebarRows.get(appId);
  if (!row) return;

  row.className = 'stpt-sidebar-row';

  // Get price from badge or compute from priceData
  const badge = row.closest('.stpt-game-row')?.querySelector('.stpt-badge[data-type]');
  let bestCurrent = null;
  let currency = gameInfo.settings?.regions?.[0]?.toUpperCase() === 'US' ? 'USD' : 'EUR';

  if (badge) {
    const badgeType = badge.dataset.type;
    const priceEl = badge.querySelector('.stpt-badge-price');
    const priceText = priceEl?.textContent?.replace(/[^\d,.]/g, '').replace(',', '.') || '';

    // Only mark as wishlist if it's actually a WISH badge
    if (badgeType === 'WISH') {
      row.classList.add('in-wishlist');
    }

    // Get price from badge text
    if (priceText) {
      const numericMatch = priceText.match(/[\d,.]+/);
      if (numericMatch) {
        bestCurrent = parseFloat(numericMatch[0].replace(',', '.')) * 100; // Convert to cents
      }
    }
  }

  // Fallback to computing from priceData if no badge
  const priceData = gameInfo.priceData;
  if (priceData && bestCurrent == null) {
    const prices = priceData.prices ?? {};
    const keyshopsEnabled = gameInfo.settings?.keyshopsEnabled;
    currency = prices.currency ?? 'EUR';

    bestCurrent = prices.currentRetail;
    if (keyshopsEnabled && prices.currentKeyshops != null) {
      if (bestCurrent == null || prices.currentKeyshops < bestCurrent) {
        bestCurrent = prices.currentKeyshops;
      }
    }
  }

  if (bestCurrent == null) {
    row.textContent = 'N/A';
    return;
  }

  if (gameInfo.tier === 1) {
    row.classList.add('tier-1');
    row.textContent = `★ ${formatPrice(bestCurrent, currency)}`;
  } else if (gameInfo.tier === 2) {
    row.classList.add('tier-2');
    const prices = priceData?.prices ?? {};
    let bestAtl = prices.historicalRetail;
    if (gameInfo.settings?.keyshopsEnabled && prices.historicalKeyshops != null) {
      if (bestAtl == null || prices.historicalKeyshops < bestAtl) {
        bestAtl = prices.historicalKeyshops;
      }
    }
    const ratio = bestAtl > 0 ? (bestCurrent / bestAtl) : 1;
    const rangeLabel = ratio >= (gameInfo.settings?.rangeHighRatio ?? 3) ? 'HIGH'
      : ratio >= (gameInfo.settings?.rangeLowRatio ?? 1.5) ? 'MID' : 'LOW';
    row.textContent = `TRADE · ${formatPrice(bestCurrent, currency)} · ${rangeLabel}`;
  } else {
    row.textContent = formatPrice(bestCurrent, currency);
  }
}

export function syncSidebarHeights(rows) {
  // rows: [{ el: HTMLElement, appId: string }]
  rows.forEach(({ el, appId }) => {
    const sideRow = sidebarRows.get(appId);
    if (!sideRow) return;
    const h = el.getBoundingClientRect().height;
    if (h > 0) sideRow.style.minHeight = `${h}px`;
  });
}
