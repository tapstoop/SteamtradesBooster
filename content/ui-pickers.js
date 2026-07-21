// content/ui-pickers.js
// Candidate pickers, fuzzy pickers, not-found pickers, and the popover

import { sendMessage, formatPrice, formatTimestamp, formatFullTimestamp, closeAll, positionNear } from './ui-helpers.js';
import { injectSkeleton, injectNotFoundBadge, injectDismissedBadge, replaceBadge } from './ui-badges.js';
import { getDisplayRegion, normalizeSteamType } from '../utils/similarity.js';

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
  const normalizedType = normalizeSteamType(type);
  const typed = prices[`${normalizedType}:${id}`]?.[region];
  if (typed) return typed;
  return normalizedType === 'app' ? prices[id]?.[region] ?? null : null;
}

function formatPickerItemType(type) {
  if (type === 'bundle') return 'Bundle';
  if (type === 'sub') return 'Sub';
  return 'App';
}

function formatRemovalStatus(status) {
  return ({
    removed_delisted: 'Delisted',
    removed_disabled: 'Purchase disabled',
    removed_banned: 'Banned',
  })[status] ?? null;
}

export function createPickerResultRow({
  name,
  meta = null,
  className = 'stpt-cand-item',
  nameColor = null,
  metaColor = '#555',
}) {
  const row = document.createElement('div');
  row.className = className;

  const nameEl = document.createElement('span');
  if (nameColor) nameEl.style.color = nameColor;
  nameEl.textContent = String(name ?? '');
  row.appendChild(nameEl);

  if (meta != null) {
    const metaEl = document.createElement('span');
    metaEl.style.color = metaColor;
    metaEl.style.fontSize = '9px';
    metaEl.textContent = String(meta);
    row.appendChild(metaEl);
  }

  return row;
}

export function createPickerStatusMessage(text, color = '#555') {
  const status = document.createElement('div');
  status.style.padding = '5px';
  status.style.color = color;
  status.style.fontSize = '10px';
  status.textContent = String(text ?? '');
  return status;
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
    payload: {
      items: [{ id: gameInfo.appId, type: itemType }],
      regions: settings.regions,
      fetchIntent: 'manual-refresh',
    },
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
    const removalLabel = formatRemovalStatus(c.removalStatus);
    const item = createPickerResultRow({
      name: c.name,
      meta: `${formatPickerItemType(c.type)} ${c.id}${removalLabel ? ` · ${removalLabel}` : ''}`,
    });
    item.addEventListener('click', () => {
      picker.remove();
      rowEl.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: c.id, title: c.name, cacheKey, type: c.type ?? 'app' } }));
      sendMessage('CONFIRM_RESOLUTION', { cacheKey, appId: c.id, title: c.name, type: c.type ?? 'app' }).catch(err => console.error('[STPT] CONFIRM_RESOLUTION failed:', err));
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

  const matchedItem = createPickerResultRow({
    name: `✓ ${resolution.title || `App ${resolution.appId}`}`,
    nameColor: '#7fff7f',
  });
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
  let localSearchSequence = 0;
  let activeSearchRequestId = null;
  const createRequestId = () => `picker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cancelActiveSearch = () => {
    if (!activeSearchRequestId) return;
    sendMessage('CANCEL_STEAM_SEARCH', { requestId: activeSearchRequestId }).catch(() => {});
    activeSearchRequestId = null;
  };
  const closePicker = () => {
    cancelActiveSearch();
    picker.remove();
  };
  const performSearch = async (query) => {
    cancelActiveSearch();
    const sequence = ++localSearchSequence;
    const requestId = createRequestId();
    activeSearchRequestId = requestId;
    resultsContainer.replaceChildren(createPickerStatusMessage('Searching...'));
    try {
      const results = await sendMessage('SEARCH_STEAM', { query, requestId });
      if (sequence !== localSearchSequence || activeSearchRequestId !== requestId || searchInput.value.trim() !== query || !picker.isConnected || results?.cancelled) return;
      activeSearchRequestId = null;
      resultsContainer.replaceChildren();
      if (!results.items?.length) {
        resultsContainer.replaceChildren(createPickerStatusMessage('No results'));
        return;
      }
      const resultItems = results.items.map(item => {
        const type = item.type ?? 'app';
        const resultItem = createPickerResultRow({
          name: item.name,
          meta: `${formatPickerItemType(type)} ${String(item.id)}`,
        });
        resultItem.addEventListener('click', () => {
          closePicker();
          rowEl.dispatchEvent(new CustomEvent('stpt-resolve', { bubbles: true, detail: { appId: String(item.id), title: item.name, cacheKey, type } }));
          sendMessage('CONFIRM_RESOLUTION', { cacheKey, appId: String(item.id), title: item.name, type }).catch(err => console.error('[STPT] CONFIRM_RESOLUTION failed:', err));
        });
        return resultItem;
      });
      resultsContainer.replaceChildren(...resultItems);
    } catch (e) {
      if (sequence !== localSearchSequence || !picker.isConnected) return;
      resultsContainer.replaceChildren(createPickerStatusMessage('Search failed', '#f38ba8'));
    }
  };

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim();
    if (query.length < 2) {
      cancelActiveSearch();
      localSearchSequence++;
      resultsContainer.replaceChildren();
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
    closePicker();
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

  appendErrorLogLink(picker);

  positionNear(picker, anchorEl);

  setTimeout(() => {
    searchInput.focus();
    searchInput.select();
  }, 0);

  setTimeout(() => document.addEventListener('click', closePicker, { once: true }), 0);
}

// ── Popover ───────────────────────────────────────────────────────────

let activePopover = null;

function createPopoverRow(label, value, {
  rowClass = '',
  valueClass = '',
  labelStyle = '',
  valueStyle = '',
} = {}) {
  const row = document.createElement('div');
  row.className = `stpt-popover-row${rowClass ? ` ${rowClass}` : ''}`;

  const labelEl = document.createElement('span');
  labelEl.className = 'stpt-popover-label';
  if (labelStyle) labelEl.style.cssText = labelStyle;
  labelEl.textContent = label;

  const valueEl = document.createElement('span');
  valueEl.className = `stpt-popover-val${valueClass ? ` ${valueClass}` : ''}`;
  if (valueStyle) valueEl.style.cssText = valueStyle;
  valueEl.textContent = value;

  row.append(labelEl, valueEl);
  return row;
}

export function createPopoverBody(priceData, gameInfo) {
  const body = document.createDocumentFragment();
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
  const title = document.createElement('div');
  title.className = 'stpt-popover-title';
  title.textContent = gameInfo.title ?? 'Unknown';
  body.appendChild(title);

  if (cachedAt) {
    body.appendChild(createPopoverRow('Updated', formatFullTimestamp(cachedAt), {
      rowClass: 'stpt-popover-ts',
    }));
  }
  body.appendChild(createPopoverRow('Current retail', formatPrice(currentRetail, currency)));
  body.appendChild(createPopoverRow('Retail ATL', formatPrice(historicalRetail, currency), {
    valueClass: 'atl',
  }));

  if (keyshopsEnabled && currentKeyshops != null) {
    body.appendChild(createPopoverRow('Keyshop price', formatPrice(currentKeyshops, currency), {
      valueClass: 'deal',
    }));
    body.appendChild(createPopoverRow('Keyshop ATL', formatPrice(historicalKeyshops, currency)));
  }

  if (bestAtl != null) {
    body.appendChild(createPopoverRow('Historical ATL', formatPrice(bestAtl, currency), {
      labelStyle: 'font-weight:600;',
      valueClass: 'atl',
      valueStyle: 'color:#7fff7f;font-weight:600;',
    }));
  }

  if (safeUrl) {
    const link = document.createElement('a');
    link.className = 'stpt-popover-link';
    link.href = safeUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'View on GG.deals ↗';
    body.appendChild(link);
  }

  // Acquisition price section for tradables
  if (gameInfo.tier === 2 && gameInfo.appId) {
    const acqSection = document.createElement('div');
    acqSection.className = 'stpt-acq-section';

    const label = document.createElement('div');
    label.style.cssText = 'color:#8a9bb0;margin-bottom:4px;';
    label.textContent = 'Acquisition price:';

    const input = document.createElement('input');
    input.className = 'stpt-acq-input';
    input.type = 'number';
    input.step = '0.01';
    input.placeholder = '€0.00';
    const acqValue = Number.isFinite(gameInfo.acqPrice) ? (gameInfo.acqPrice / 100).toFixed(2) : '';
    input.value = acqValue;

    const saveBtn = document.createElement('button');
    saveBtn.className = 'stpt-acq-save';
    saveBtn.textContent = 'Save';
    acqSection.append(label, input, saveBtn);

    if (gameInfo.acqPrice != null && currentRetail != null) {
      const comparison = document.createElement('div');
      comparison.style.marginTop = '6px';
      comparison.style.color = currentRetail >= gameInfo.acqPrice ? '#7fff7f' : '#ff8888';
      const difference = currentRetail - gameInfo.acqPrice;
      comparison.textContent = [
        `Paid ${formatPrice(gameInfo.acqPrice, currency)}`,
        `Now ${formatPrice(currentRetail, currency)}`,
        `${difference >= 0 ? '+' : ''}${formatPrice(difference, currency)}`,
      ].join(' → ');
      if (gameInfo.acqPrice !== 0) {
        comparison.textContent += ` (${Math.round(difference / gameInfo.acqPrice * 100)}%)`;
      }
      acqSection.appendChild(comparison);
    }

    saveBtn.addEventListener('click', async () => {
      const val = parseFloat(input.value);
      if (!isNaN(val)) {
        await sendMessage('SAVE_ACQ_PRICE', {
          appId: gameInfo.appId,
          itemType: gameInfo.type ?? gameInfo.resolution?.type ?? 'app',
          price: Math.round(val * 100),
        });
        saveBtn.closest('.stpt-popover')?.remove();
      }
    });
    body.appendChild(acqSection);
  }

  return body;
}

export function openPopover(anchorEl, priceData, gameInfo) {
  closeAll('.stpt-popover');
  const pop = document.createElement('div');
  pop.className = 'stpt-popover';
  pop.replaceChildren(createPopoverBody(priceData, gameInfo));

  positionNear(pop, anchorEl);
  activePopover = pop;

  // Refresh button
  if (gameInfo.appId) {
    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'stpt-popover-refresh';
    refreshBtn.textContent = gameInfo.ggDealsNoData ? '↻ Retry GG.deals' : '↻ Refresh price';
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

  }
  setTimeout(() => document.addEventListener('click', () => { pop.remove(); activePopover = null; }, { once: true }), 0);
}
