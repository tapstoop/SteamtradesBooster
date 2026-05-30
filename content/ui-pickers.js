// content/ui-pickers.js
// Candidate pickers, fuzzy pickers, not-found pickers, and the popover

import { sendMessage, formatPrice, formatTimestamp, formatFullTimestamp, closeAll, positionNear } from './ui-helpers.js';
import { injectSkeleton, injectNotFoundBadge, injectDismissedBadge, injectDelistedBadge, replaceBadge } from './ui-badges.js';
import { getDisplayRegion } from '../utils/similarity.js';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeGgDealsUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl, location.href);
    const isGgDeals = parsed.hostname === 'gg.deals' || parsed.hostname.endsWith('.gg.deals');
    if (parsed.protocol !== 'https:' || !isGgDeals || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function readTypedPrice(prices, id, type = 'app', region) {
  if (!prices || !id) return null;
  const normalizedType = ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
  const typed = prices[`${normalizedType}:${id}`]?.[region];
  if (typed) return typed;
  return normalizedType === 'app' ? prices[id]?.[region] ?? null : null;
}

function normalizeSteamType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
}

export function anchorStillMatches(anchorEl, gameInfo, itemType) {
  if (!document.body.contains(anchorEl)) return false;
  const expectedType = normalizeSteamType(itemType);
  return (
    String(anchorEl.dataset.appid ?? '') === String(gameInfo.appId ?? '') &&
    normalizeSteamType(anchorEl.dataset.itemType ?? gameInfo.type ?? 'app') === expectedType
  );
}

export function buildPopoverRefreshRequest(gameInfo, settings) {
  const itemType = gameInfo.type ?? gameInfo.resolution?.type ?? 'app';
  return {
    type: 'REFRESH_PRICES',
    payload: { items: [{ id: gameInfo.appId, type: itemType }], regions: settings.regions },
    itemType,
  };
}

function appendErrorLogLink(container) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'stpt-error-log-link';
  link.textContent = 'See error logs';
  link.addEventListener('click', async e => {
    e.stopPropagation();
    await sendMessage('OPEN_POPUP_TAB', { tab: 'settings', focus: 'error-log' });
  });
  container.appendChild(link);
  return link;
}

// ── Candidate / Fuzzy / Not-found pickers ─────────────────────────────

export function openCandidatePicker(anchorEl, candidates, cacheKey, rowEl) {
  closeAll('.stpt-candidates');
  const picker = document.createElement('div');
  picker.className = 'stpt-candidates';

  const header = document.createElement('div');
  header.style.cssText = 'color:#888;font-size:9px;padding:3px 5px 5px;border-bottom:1px solid #1e1e2e;margin-bottom:3px;';
  header.textContent = 'Which game?';
  picker.appendChild(header);

  candidates.forEach(c => {
    const item = document.createElement('div');
    item.className = 'stpt-cand-item';
    item.innerHTML = `<span>${escapeHtml(c.name)}</span><span style="color:#555;font-size:9px;">${escapeHtml(c.type === 'bundle' ? 'Bundle' : c.type === 'sub' ? 'Sub' : 'App')} ${escapeHtml(c.id)}</span>`;
    item.addEventListener('click', async () => {
      picker.remove();
      await sendMessage('CONFIRM_RESOLUTION', { cacheKey, appId: c.id, title: c.name, type: c.type ?? 'app' });
      rowEl.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: c.id, title: c.name, cacheKey, type: c.type ?? 'app' } }));
    });
    picker.appendChild(item);
  });

  const dismiss = document.createElement('div');
  dismiss.className = 'stpt-cand-item stpt-cand-dismiss';
  dismiss.textContent = 'None of these — not a game';
  dismiss.addEventListener('click', async () => {
    picker.remove();
    await sendMessage('SET_DISMISSED', { cacheKey });
    const existing = rowEl.querySelector('.stpt-badge');
    if (existing) existing.remove();
    const checkbox = rowEl.previousElementSibling?.classList?.contains('stpt-game-checkbox')
      ? rowEl.previousElementSibling
      : null;
    if (checkbox) checkbox.remove();
    injectDismissedBadge(rowEl, cacheKey, rowEl.dataset.stptTitle);
  });
  picker.appendChild(dismiss);
  appendErrorLogLink(picker);

  positionNear(picker, anchorEl);
  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 0);
}

export function openFuzzyPicker(anchorEl, resolution) {
  closeAll('.stpt-candidates');
  const picker = document.createElement('div');
  picker.className = 'stpt-candidates';

  const header = document.createElement('div');
  header.style.cssText = 'color:#888;font-size:9px;padding:3px 5px 5px;border-bottom:1px solid #1e1e2e;margin-bottom:3px;';
  header.textContent = `Auto-matched (${resolution.similarity}% similar)`;
  picker.appendChild(header);
  appendErrorLogLink(picker);

  const matchedItem = document.createElement('div');
  matchedItem.className = 'stpt-cand-item';
  matchedItem.innerHTML = `<span style="color:#7fff7f;">✓ ${escapeHtml(resolution.title || `App ${resolution.appId}`)}</span>`;
  picker.appendChild(matchedItem);

  const dismiss = document.createElement('div');
  dismiss.className = 'stpt-cand-item stpt-cand-dismiss';
  dismiss.textContent = 'Wrong game — dismiss';
  dismiss.addEventListener('click', async () => {
    picker.remove();
    await sendMessage('SET_DISMISSED', { cacheKey: resolution.cacheKey });
    const results = await sendMessage('RESOLVE_TITLES', { titles: [resolution.title] });
    if (results[0]?.status === 'ambiguous') {
      const existing = anchorEl.closest('.stpt-game-item');
      if (existing) {
        const skeleton = existing.querySelector('.stpt-badge');
        if (skeleton) skeleton.remove();
        // Import here to avoid top-level circular dependency
        const { injectQuestionBadge } = await import('./ui-badges.js');
        injectQuestionBadge(existing, results[0].candidates, results[0].cacheKey);
      }
    }
  });
  picker.appendChild(dismiss);

  positionNear(picker, anchorEl);
  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 0);
}

export function openNotFoundPicker(anchorEl, cacheKey, title, rowEl) {
  closeAll('.stpt-candidates');
  const picker = document.createElement('div');
  picker.className = 'stpt-candidates';
  picker.style.minWidth = '240px';

  const header = document.createElement('div');
  header.style.cssText = 'color:#888;font-size:9px;padding:3px 5px 5px;border-bottom:1px solid #1e1e2e;margin-bottom:3px;';
  header.textContent = 'Game not found';
  picker.appendChild(header);

  // Search input with real-time suggestions
  const searchWrapper = document.createElement('div');
  searchWrapper.style.cssText = 'padding:5px;';

  const label = document.createElement('div');
  label.style.cssText = 'color:#66c0f4;font-size:11px;margin-bottom:4px;';
  label.textContent = 'Search for a game:';
  searchWrapper.appendChild(label);

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search Steam...';
  searchInput.value = title;
  searchInput.style.cssText = 'width:100%;padding:4px 6px;border:1px solid #333;border-radius:3px;background:#1e1e2e;color:#cdd6f4;font-size:11px;box-sizing:border-box;';
  searchWrapper.appendChild(searchInput);
  picker.appendChild(searchWrapper);

  const resultsContainer = document.createElement('div');
  resultsContainer.className = 'stpt-search-results';
  resultsContainer.style.cssText = 'max-height:150px;overflow-y:auto;';
  picker.appendChild(resultsContainer);

  searchInput.addEventListener('click', e => e.stopPropagation());
  picker.addEventListener('click', e => e.stopPropagation());

  let searchTimeout = null;
  const performSearch = async (query) => {
    resultsContainer.innerHTML = '<div style="padding:5px;color:#555;font-size:10px;">Searching...</div>';
    try {
      const results = await sendMessage('SEARCH_STEAM', { query });
      resultsContainer.innerHTML = '';
      if (!results.items?.length) {
        resultsContainer.innerHTML = '<div style="padding:5px;color:#555;font-size:10px;">No results</div>';
        return;
      }
      results.items.forEach(item => {
        const resultItem = document.createElement('div');
        resultItem.className = 'stpt-cand-item';
        const type = item.type ?? 'app';
        resultItem.innerHTML = `<span>${escapeHtml(item.name)}</span><span style="color:#555;font-size:9px;">${escapeHtml(type === 'bundle' ? 'Bundle' : type === 'sub' ? 'Sub' : 'App')} ${escapeHtml(String(item.id))}</span>`;
        resultItem.addEventListener('click', async () => {
          picker.remove();
          await sendMessage('CONFIRM_RESOLUTION', { cacheKey, appId: String(item.id), title: item.name, type });
          rowEl.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: String(item.id), title: item.name, cacheKey, type } }));
        });
        resultsContainer.appendChild(resultItem);
      });
    } catch (e) {
      resultsContainer.innerHTML = '<div style="padding:5px;color:#f38ba8;font-size:10px;">Search failed</div>';
    }
  };

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    if (query.length < 2) {
      resultsContainer.innerHTML = '';
      return;
    }
    searchTimeout = setTimeout(() => performSearch(query), 300);
  });

  if (title && title.length >= 2) {
    performSearch(title);
  }

  const dismiss = document.createElement('div');
  dismiss.className = 'stpt-cand-item stpt-cand-dismiss';
  dismiss.textContent = 'Not a game — dismiss';
  dismiss.style.cssText = 'border-top:1px solid #1e1e2e;margin-top:5px;';
  dismiss.addEventListener('click', async () => {
    picker.remove();
    await sendMessage('SET_DISMISSED', { cacheKey });
    const existing = rowEl.querySelector('.stpt-badge');
    if (existing) existing.remove();
    const checkbox = rowEl.previousElementSibling?.classList?.contains('stpt-game-checkbox')
      ? rowEl.previousElementSibling
      : null;
    if (checkbox) checkbox.remove();
    injectDismissedBadge(rowEl, cacheKey, title);
  });
  picker.appendChild(dismiss);

  const delisted = document.createElement('div');
  delisted.className = 'stpt-cand-item';
  delisted.textContent = 'Delisted game';
  delisted.style.cssText = 'color:#ff4444;border-top:1px solid #1e1e2e;margin-top:2px;padding-top:5px;';
  delisted.addEventListener('click', async () => {
    picker.remove();
    await sendMessage('SET_DELISTED', { cacheKey });
    const existing = rowEl.querySelector('.stpt-badge');
    if (existing) existing.remove();
    const checkbox = rowEl.previousElementSibling?.classList?.contains('stpt-game-checkbox')
      ? rowEl.previousElementSibling
      : null;
    if (checkbox) checkbox.remove();
    injectDelistedBadge(rowEl, cacheKey, title);
  });
  picker.appendChild(delisted);
  appendErrorLogLink(picker);

  positionNear(picker, anchorEl);

  setTimeout(() => {
    searchInput.focus();
    searchInput.select();
  }, 0);

  setTimeout(() => document.addEventListener('click', () => picker.remove(), { once: true }), 0);
}

// ── Popover ───────────────────────────────────────────────────────────

let activePopover = null;

export function openPopover(anchorEl, priceData, gameInfo) {
  closeAll('.stpt-popover');
  const pop = document.createElement('div');
  pop.className = 'stpt-popover';

  const currency = priceData?.prices?.currency ?? 'EUR';
  const currentRetail = priceData?.prices?.currentRetail;
  const historicalRetail = priceData?.prices?.historicalRetail;
  const currentKeyshops = priceData?.prices?.currentKeyshops;
  const historicalKeyshops = priceData?.prices?.historicalKeyshops;
  const cachedAt = priceData?.cachedAt;
  const keyshopsEnabled = gameInfo.settings?.keyshopsEnabled;

  let bestAtl = historicalRetail;
  if (keyshopsEnabled && historicalKeyshops != null) {
    if (bestAtl == null || historicalKeyshops < bestAtl) {
      bestAtl = historicalKeyshops;
    }
  }

  const safeUrl = normalizeGgDealsUrl(priceData?.url);
  const safeTitle = escapeHtml(gameInfo.title ?? 'Unknown');
  pop.innerHTML = `
    <div class="stpt-popover-title">${safeTitle}</div>
    ${cachedAt ? `
    <div class="stpt-popover-row stpt-popover-ts">
      <span class="stpt-popover-label">Updated</span>
      <span class="stpt-popover-val">${formatFullTimestamp(cachedAt)}</span>
    </div>
    ` : ''}
    <div class="stpt-popover-row">
      <span class="stpt-popover-label">Current retail</span>
      <span class="stpt-popover-val">${formatPrice(currentRetail, currency)}</span>
    </div>
    <div class="stpt-popover-row">
      <span class="stpt-popover-label">Retail ATL</span>
      <span class="stpt-popover-val atl">${formatPrice(historicalRetail, currency)}</span>
    </div>
    ${keyshopsEnabled && currentKeyshops != null ? `
    <div class="stpt-popover-row">
      <span class="stpt-popover-label">Keyshop price</span>
      <span class="stpt-popover-val deal">${formatPrice(currentKeyshops, currency)}</span>
    </div>
    <div class="stpt-popover-row">
      <span class="stpt-popover-label">Keyshop ATL</span>
      <span class="stpt-popover-val">${formatPrice(historicalKeyshops, currency)}</span>
    </div>
    ` : ''}
    ${bestAtl != null ? `
    <div class="stpt-popover-row">
      <span class="stpt-popover-label" style="font-weight:600;">Historical ATL</span>
      <span class="stpt-popover-val atl" style="color:#7fff7f;font-weight:600;">${formatPrice(bestAtl, currency)}</span>
    </div>
    ` : ''}
    ${safeUrl ? `<a class="stpt-popover-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">View on GG.deals ↗</a>` : ''}
  `;

  // Acquisition price section for tradables
  if (gameInfo.tier === 2 && gameInfo.appId) {
    const acqSection = document.createElement('div');
    acqSection.className = 'stpt-acq-section';
    const acqValue = Number.isFinite(gameInfo.acqPrice) ? (gameInfo.acqPrice / 100).toFixed(2) : '';
    acqSection.innerHTML = `
      <div style="color:#8a9bb0;margin-bottom:4px;">Acquisition price:</div>
      <input class="stpt-acq-input" type="number" step="0.01" placeholder="€0.00"
             value="${acqValue}">
      <button class="stpt-acq-save">Save</button>
      ${gameInfo.acqPrice != null && currentRetail != null ? `
        <div style="margin-top:6px;color:${currentRetail >= gameInfo.acqPrice ? '#7fff7f' : '#ff8888'}">
          Paid ${formatPrice(gameInfo.acqPrice, currency)} →
          Now ${formatPrice(currentRetail, currency)} →
          ${currentRetail >= gameInfo.acqPrice ? '+' : ''}${formatPrice(currentRetail - gameInfo.acqPrice, currency)}
          (${Math.round((currentRetail - gameInfo.acqPrice) / gameInfo.acqPrice * 100)}%)
        </div>
      ` : ''}
    `;
    const saveBtn = acqSection.querySelector('.stpt-acq-save');
    saveBtn.addEventListener('click', async () => {
      const val = parseFloat(acqSection.querySelector('.stpt-acq-input').value);
      if (!isNaN(val)) {
        await sendMessage('SAVE_ACQ_PRICE', {
          appId: gameInfo.appId,
          itemType: gameInfo.type ?? gameInfo.resolution?.type ?? 'app',
          price: Math.round(val * 100),
        });
        pop.remove();
      }
    });
    pop.appendChild(acqSection);
  }

  positionNear(pop, anchorEl);
  activePopover = pop;

  // Refresh button
  if (gameInfo.appId) {
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'stpt-popover-refresh';
    refreshBtn.textContent = '↻ Refresh price';
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.textContent = '↻ Loading…';
      refreshBtn.disabled = true;
      try {
        const s = await sendMessage('GET_SETTINGS');
        const refreshRequest = buildPopoverRefreshRequest(gameInfo, s);
        const prices = await sendMessage(refreshRequest.type, refreshRequest.payload);
        const freshPrice = readTypedPrice(prices, gameInfo.appId, refreshRequest.itemType, getDisplayRegion(s));
        const gameItem = anchorEl.closest('.stpt-game-item') ?? anchorEl.parentElement?.closest('.stpt-game-item');
        if (gameItem && anchorStillMatches(anchorEl, gameInfo, refreshRequest.itemType)) {
          gameItem.querySelectorAll('.stpt-skeleton, .stpt-badge').forEach(e => e.remove());
          replaceBadge(gameItem, freshPrice, { ...gameInfo, settings: s });
        }
        pop.remove();
        activePopover = null;
      } catch {
        refreshBtn.textContent = '↻ Error';
        refreshBtn.disabled = false;
      }
    });
    pop.appendChild(refreshBtn);

    // Change game button
    const changeBtn = document.createElement('button');
    changeBtn.className = 'stpt-popover-refresh';
    changeBtn.style.marginTop = '4px';
    changeBtn.textContent = 'Change game';
    changeBtn.addEventListener('click', async e => {
      e.stopPropagation();
      pop.remove();
      activePopover = null;
      if (gameInfo.cacheKey) {
        await sendMessage('CLEAR_RESOLUTION', { cacheKey: gameInfo.cacheKey });
        await sendMessage('SET_UNDISMISSED', { cacheKey: gameInfo.cacheKey });
      }
      const gameItem = anchorEl.closest('.stpt-game-item');
      if (gameItem) {
        const existing = gameItem.querySelector('.stpt-badge');
        if (existing) existing.remove();
        injectSkeleton(gameItem, true);
        const cacheKey = gameInfo.cacheKey;
        const title = gameInfo.title;
        injectNotFoundBadge(gameItem, cacheKey, title);
        const badge = gameItem.querySelector('.stpt-badge');
        if (badge) badge.click();
      }
    });
    pop.appendChild(changeBtn);

    // Mark as delisted / Undo delisted button
    const isCurrentlyDelisted = gameInfo.resolution?.status === 'delisted';
    const delistBtn = document.createElement('button');
    delistBtn.className = 'stpt-popover-refresh';
    delistBtn.style.marginTop = '4px';
    delistBtn.style.color = isCurrentlyDelisted ? '#4ecdc4' : '#ff6666';
    delistBtn.textContent = isCurrentlyDelisted ? 'Undo delisted' : 'Mark as delisted';
    delistBtn.addEventListener('click', async e => {
      e.stopPropagation();
      pop.remove();
      activePopover = null;
      const gameItem = anchorEl.closest('.stpt-game-item');
      if (!gameItem) return;

      if (isCurrentlyDelisted) {
        if (gameInfo.cacheKey) {
          await sendMessage('SET_UNDELISTED', { cacheKey: gameInfo.cacheKey });
        }
        const existing = gameItem.querySelector('.stpt-badge');
        if (existing) existing.remove();
        injectSkeleton(gameItem, true);
        gameItem.dispatchEvent(new CustomEvent('stpt-recheck', { bubbles: true, detail: { title: gameInfo.title, cacheKey: gameInfo.cacheKey } }));
      } else {
        if (gameInfo.cacheKey && gameInfo.appId) {
          await sendMessage('CONFIRM_RESOLUTION', { cacheKey: gameInfo.cacheKey, appId: gameInfo.appId, type: gameInfo.type ?? gameInfo.resolution?.type ?? 'app' });
        }
        if (gameInfo.cacheKey) {
          await sendMessage('SET_DELISTED', { cacheKey: gameInfo.cacheKey });
        }
        injectDelistedBadge(gameItem, gameInfo.cacheKey, gameInfo.title, priceData, gameInfo);
      }
    });
    pop.appendChild(delistBtn);
  }
  setTimeout(() => document.addEventListener('click', () => { pop.remove(); activePopover = null; }, { once: true }), 0);
}
