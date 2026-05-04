// content/ui-components.js
import { isNotGameBadge } from './parser.js';

export function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

export function createGameRow({ game, isSelected, isInWishlist, isInTradables, isHighlighted, isInTrade, onAction, onRemove }) {
  const row = document.createElement('div');
  row.className = 'stpt-game-row';
  if (isSelected) row.classList.add('selected');
  if (isInWishlist) row.classList.add('in-wishlist');
  if (isInTradables) row.classList.add('in-tradables');
  if (isHighlighted) row.classList.add('highlight');
  if (isInTrade) row.classList.add('in-trade-used');

  const title = document.createElement('span');
  title.className = 'stpt-game-title';
  title.textContent = game.title || game.name || 'Unknown';
  title.title = game.title || game.name || 'Unknown';
  row.appendChild(title);

  const badge = document.createElement('span');
  badge.className = 'stpt-game-badge';
  if (isInWishlist) {
    badge.classList.add('w');
    badge.textContent = 'W';
    badge.title = 'In your wishlist';
  } else if (isInTradables) {
    badge.classList.add('t');
    badge.textContent = 'T';
    badge.title = 'In your tradables';
  }
  if (isInWishlist || isInTradables) {
    row.appendChild(badge);
  }

  const price = document.createElement('span');
  price.className = 'stpt-game-price';
  if (game.price != null) {
    price.textContent = formatPrice(game.price, game.currency);
    row.appendChild(price);
  }

  if (onAction && !isInTrade) {
    const actionBtn = document.createElement('button');
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

export function createSearchBar({ placeholder, onSearch }) {
  const container = document.createElement('div');
  container.className = 'stpt-ws-search';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'stpt-ws-search-input';
  input.placeholder = placeholder || 'Search...';

  let timeout = null;
  input.addEventListener('input', e => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      if (onSearch) onSearch(e.target.value);
    }, 200);
  });

  container.appendChild(input);
  return container;
}

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

  function calculate() {
    const h = container.clientHeight;
    if (h > 0) containerHeight = h;

    const totalHeight = items.length * itemHeight;
    inner.style.height = `${totalHeight}px`;

    const startIndex = Math.floor(scrollTop / itemHeight);
    const endIndex = Math.min(items.length - 1, Math.ceil((scrollTop + containerHeight) / itemHeight));

    inner.innerHTML = '';
    for (let i = startIndex; i <= endIndex && i < items.length; i++) {
      const el = renderItem(items[i], i);
      el.style.position = 'absolute';
      el.style.top = `${i * itemHeight}px`;
      el.style.left = '0';
      el.style.right = '0';
      inner.appendChild(el);
    }
  }

  container.addEventListener('scroll', e => {
    scrollTop = e.target.scrollTop;
    calculate();
  });

  function setItems(newItems) {
    items = newItems || [];
    scrollTop = 0;
    container.scrollTop = 0;
    requestAnimationFrame(() => calculate());
  }

  function refresh() {
    calculate();
  }

  // Observe resize to recalculate when container size changes
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => calculate()).observe(container);
  }

  return { container, setItems, refresh, getItems: () => items };
}

export function createEmptyState({ message }) {
  const el = document.createElement('div');
  el.className = 'stpt-empty-state';
  el.textContent = message || 'No items';
  return el;
}
