// content/ui-components.js
import { isNotGameBadge } from './parser.js';
import { getRemovalStatusMeta } from '../utils/removal-status.js';

export function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

const REMOVAL_COMPACT_LABELS = Object.freeze({
  removed_delisted: 'D',
  removed_disabled: 'P',
  removed_banned: 'B',
});

export const COMPACT_BADGE_FILTERS = Object.freeze([
  Object.freeze({ key: 'wish', label: 'Wishlist', badgeLabel: 'W', className: 'wish' }),
  Object.freeze({ key: 'trade', label: 'Tradables', badgeLabel: 'T', className: 'trade' }),
  Object.freeze({ key: 'removed_delisted', label: 'Delisted', badgeLabel: 'D', className: 'removed_delisted' }),
  Object.freeze({ key: 'removed_disabled', label: 'Purchase disabled', badgeLabel: 'P', className: 'removed_disabled' }),
  Object.freeze({ key: 'removed_banned', label: 'Banned', badgeLabel: 'B', className: 'removed_banned' }),
  Object.freeze({ key: 'pending', label: 'Resolution pending', badgeLabel: '…', className: 'resolution pending' }),
  Object.freeze({ key: 'ambiguous', label: 'Ambiguous resolution', badgeLabel: '?', className: 'resolution ambiguous' }),
  Object.freeze({ key: 'not-found', label: 'Not found', badgeLabel: 'N/A', className: 'resolution not-found' }),
  Object.freeze({ key: 'fuzzy', label: 'Fuzzy match', badgeLabel: '≈', className: 'resolution fuzzy' }),
  Object.freeze({ key: 'failed', label: 'Resolution failed', badgeLabel: 'ERR', className: 'resolution failed' }),
]);

export function hasDualTitle(game) {
  return Boolean(game?.originalTitle && game?.title && game.originalTitle !== game.title);
}

export function getResolutionBadgeDescriptor(game) {
  if (game?.resolution?.status === 'dismissed') return null;
  if (game?.resolutionStatus === 'failed') {
    return { kind: 'failed', filterKey: 'failed', label: 'ERR', accessibleName: 'Resolution failed', interactive: false };
  }
  if (['pending', 'queued', 'resolving'].includes(game?.resolutionStatus)) {
    const accessibleName = game.resolutionStatus === 'queued'
      ? 'Resolution queued'
      : game.resolutionStatus === 'resolving'
        ? 'Resolving game'
        : 'Resolution pending';
    return { kind: 'pending', filterKey: 'pending', label: '…', accessibleName, interactive: false };
  }

  const status = game?.resolution?.status;
  const cacheKey = game?.cacheKey ?? game?.resolution?.cacheKey;
  if (status === 'ambiguous') {
    const candidates = Array.isArray(game.candidates)
      ? game.candidates
      : Array.isArray(game.resolution?.candidates) ? game.resolution.candidates : [];
    return {
      kind: 'ambiguous',
      filterKey: 'ambiguous',
      label: candidates.length > 0 ? `? ${candidates.length}` : '?',
      accessibleName: candidates.length > 0
        ? `Choose from ${candidates.length} resolution candidates`
        : 'Ambiguous game resolution',
      interactive: Boolean(cacheKey && candidates.length > 0 && game.el),
    };
  }
  if (status === 'not-found') {
    return {
      kind: 'not-found',
      filterKey: 'not-found',
      label: 'N/A',
      accessibleName: 'Search for this game manually',
      interactive: Boolean(cacheKey && game.el),
    };
  }
  if (game?.fuzzy || game?.resolution?.fuzzy) {
    const rawSimilarity = Number(game.similarity ?? game.resolution?.similarity);
    const similarity = Number.isFinite(rawSimilarity)
      ? Math.min(100, Math.max(0, Math.round(rawSimilarity)))
      : null;
    return {
      kind: 'fuzzy',
      filterKey: 'fuzzy',
      label: similarity == null ? '≈' : `≈ ${similarity}%`,
      accessibleName: similarity == null
        ? 'Review fuzzy game match'
        : `Review fuzzy game match at ${similarity} percent similarity`,
      interactive: Boolean(cacheKey && game.resolution && game.el),
    };
  }
  return null;
}

export function getCompactBadgeDescriptors(game, {
  isInWishlist = game?.inWishlist === true,
  isInTradables = game?.inTradables === true,
} = {}) {
  const descriptors = [];
  const resolution = getResolutionBadgeDescriptor(game);
  if (resolution) {
    descriptors.push({
      ...resolution,
      className: `resolution ${resolution.kind}`,
    });
  }

  const removalMeta = getRemovalStatusMeta(game?.removalStatus);
  if (removalMeta && !(game?.fuzzy || game?.resolution?.fuzzy)) {
    descriptors.push({
      filterKey: removalMeta.styleKey,
      label: REMOVAL_COMPACT_LABELS[removalMeta.styleKey],
      accessibleName: removalMeta.categoryName,
      className: removalMeta.styleKey,
      interactive: false,
    });
  }
  if (isInWishlist) {
    descriptors.push({ filterKey: 'wish', label: 'W', accessibleName: 'Wishlist', className: 'wish', interactive: false });
  }
  if (isInTradables) {
    descriptors.push({ filterKey: 'trade', label: 'T', accessibleName: 'Tradables', className: 'trade', interactive: false });
  }
  return descriptors;
}

export function getCompactBadgeFilterKeys(game) {
  return new Set(getCompactBadgeDescriptors(game).map(descriptor => descriptor.filterKey));
}

export function canAddGameToTrade(game) {
  if (!game?.appId || game.resolution?.status === 'dismissed') return false;
  if (getRemovalStatusMeta(game.removalStatus) && !Number.isFinite(game.price)) return false;
  return true;
}

function appendCompactBadge(row, { label, accessibleName, className, interactive = false, onClick }) {
  const badge = document.createElement(interactive ? 'button' : 'span');
  badge.className = `stpt-game-compact-badge ${className}`;
  badge.textContent = label;
  badge.title = accessibleName;
  badge.setAttribute('aria-label', accessibleName);
  if (interactive) {
    badge.type = 'button';
    badge.addEventListener('click', event => {
      event.stopPropagation();
      onClick?.(badge);
    });
  }
  row.appendChild(badge);
  return badge;
}

export function createGameRow({ game, isSelected, isInWishlist, isInTradables, isHighlighted, isInTrade, showOriginalTitle, onNavigate, onResolve, onAction, onRemove }) {
  const row = document.createElement('div');
  row.className = 'stpt-game-row';
  if (isSelected) row.classList.add('selected');
  if (isInWishlist) row.classList.add('in-wishlist');
  if (isInTradables) row.classList.add('in-tradables');
  if (isHighlighted) row.classList.add('highlight');
  if (isInTrade) row.classList.add('in-trade-used');

  const titleContainer = document.createElement(onNavigate ? 'button' : 'div');
  titleContainer.className = 'stpt-game-title-container';
  if (onNavigate) {
    titleContainer.type = 'button';
    titleContainer.classList.add('stpt-game-title-link');
    titleContainer.setAttribute('aria-label', `Go to ${game.originalTitle || game.title || game.name || 'game'} on the SteamTrades page`);
    titleContainer.addEventListener('click', event => {
      event.stopPropagation();
      onNavigate(game, titleContainer);
    });
  }

  const dualTitle = Boolean(showOriginalTitle && hasDualTitle(game));
  const title = document.createElement('span');
  title.className = 'stpt-game-title';
  title.textContent = dualTitle
    ? game.originalTitle
    : game.title || game.name || 'Unknown';
  title.title = title.textContent;
  titleContainer.appendChild(title);

  if (dualTitle) {
    const source = document.createElement('span');
    source.className = 'stpt-game-source-title';
    source.textContent = '→ ' + game.title;
    source.title = 'Resolved Steam name: ' + game.title;
    titleContainer.appendChild(source);
  }

  row.appendChild(titleContainer);

  const compactBadges = getCompactBadgeDescriptors(game, {
    isInWishlist: isInWishlist === true,
    isInTradables: isInTradables === true,
  });
  for (const descriptor of compactBadges) {
    appendCompactBadge(row, {
      ...descriptor,
      onClick: anchorEl => onResolve?.(game, anchorEl),
      interactive: Boolean(onResolve && descriptor.interactive),
    });
  }

  const price = document.createElement('span');
  price.className = 'stpt-game-price';
  if (game.price != null) {
    price.textContent = formatPrice(game.price, game.currency);
    row.appendChild(price);
  }

  if (onAction && !isInTrade && canAddGameToTrade(game)) {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'stpt-game-action';
    actionBtn.textContent = '+';
    actionBtn.title = 'Add to trade';
    actionBtn.addEventListener('click', e => {
      e.stopPropagation();
      onAction(game);
    });
    row.appendChild(actionBtn);
  }

  if (onRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'stpt-game-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove from trade';
    removeBtn.addEventListener('click', e => {
      e.stopPropagation();
      onRemove(game);
    });
    row.appendChild(removeBtn);
  }

  return row;
}

export { createSearchBar } from '../utils/search-bar.js';

export function createSortSelect({ options, onSort }) {
  const select = document.createElement('select');
  select.className = 'stpt-ws-sort-select';

  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    select.appendChild(option);
  });

  select.addEventListener('change', e => {
    if (onSort) onSort(e.target.value);
  });

  return select;
}

export function createSectionHeader({ title, titleClass, count }) {
  const header = document.createElement('div');
  header.className = 'stpt-ws-col-header';

  const titleEl = document.createElement('span');
  titleEl.className = `stpt-ws-section-title ${titleClass || ''}`;
  titleEl.textContent = title;

  if (count !== undefined) {
    const countEl = document.createElement('span');
    countEl.style.marginLeft = 'auto';
    countEl.style.marginRight = '8px';
    countEl.style.color = '#64748b';
    countEl.textContent = count;
    header.appendChild(countEl);
  }

  header.appendChild(titleEl);
  return header;
}

export function createVirtualList({ itemHeight, renderItem, getItems }) {
  const container = document.createElement('div');
  container.className = 'stpt-virtual-list';
  container.style.overflow = 'auto';
  container.style.position = 'relative';

  const inner = document.createElement('div');
  inner.className = 'stpt-virtual-content';
  container.appendChild(inner);

  let items = [];
  let scrollTop = 0;
  let containerHeight = 200;
  let _itemHeight = itemHeight;
  let renderFrame = null;
  let resizeObserver = null;
  let destroyed = false;

  const requestFrame = globalThis.requestAnimationFrame
    ?? (callback => globalThis.setTimeout(callback, 0));
  const cancelFrame = globalThis.cancelAnimationFrame
    ?? (frame => globalThis.clearTimeout(frame));

  function calculate() {
    if (destroyed) return;
    const h = container.clientHeight;
    if (h > 0) containerHeight = h;

    const totalHeight = items.length * _itemHeight;
    const maxScrollTop = Math.max(0, totalHeight - containerHeight);
    if (scrollTop > maxScrollTop) {
      scrollTop = maxScrollTop;
      container.scrollTop = maxScrollTop;
    }
    inner.style.height = `${totalHeight}px`;

    const startIndex = Math.floor(scrollTop / _itemHeight);
    const endIndex = Math.min(items.length - 1, Math.ceil((scrollTop + containerHeight) / _itemHeight));

    inner.innerHTML = '';
    for (let i = startIndex; i <= endIndex && i < items.length; i++) {
      const el = renderItem(items[i], i);
      el.style.position = 'absolute';
      el.style.top = `${i * _itemHeight}px`;
      el.style.left = '0';
      el.style.right = '0';
      el.style.height = `${_itemHeight}px`;
      inner.appendChild(el);
    }
  }

  function scheduleCalculate() {
    if (destroyed || renderFrame != null) return;
    renderFrame = requestFrame(() => {
      renderFrame = null;
      calculate();
    });
  }

  container.addEventListener('scroll', e => {
    scrollTop = e.target.scrollTop;
    scheduleCalculate();
  });

  function setItems(newItems, { preserveScroll = false } = {}) {
    items = newItems || [];
    if (!preserveScroll) {
      scrollTop = 0;
      container.scrollTop = 0;
    }
    scheduleCalculate();
  }

  function setItemHeight(h) {
    if (h === _itemHeight) return;
    _itemHeight = h;
    scheduleCalculate();
  }

  function refresh() {
    scheduleCalculate();
  }

  function destroy() {
    destroyed = true;
    if (renderFrame != null) cancelFrame(renderFrame);
    renderFrame = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => scheduleCalculate());
    resizeObserver.observe(container);
  }

  return { container, setItems, setItemHeight, refresh, destroy, getItems: () => items };
}

export function createEmptyState({ message }) {
  const el = document.createElement('div');
  el.className = 'stpt-empty-state';
  el.textContent = message || 'No items';
  return el;
}
