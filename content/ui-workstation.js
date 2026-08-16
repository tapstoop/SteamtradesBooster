// content/ui-workstation.js
// Sidebar Workstation - Trade simulation sidebar with game lists

import {
  createGameRow,
  createSearchBar,
  createSortSelect,
  createSectionHeader,
  createVirtualList,
  createEmptyState,
  COMPACT_BADGE_FILTERS,
  formatPrice,
  getCompactBadgeFilterKeys,
  getResolutionBadgeDescriptor,
  hasDualTitle,
} from './ui-components.js';
import { normalizeSteamType } from '../utils/similarity.js';

const WORKSTATION_PATCH_FIELDS = Object.freeze([
  'el',
  'section',
  'originalTitle',
  'title',
  'name',
  'appId',
  'type',
  'tier',
  'manuallyResolved',
  'resolutionStatus',
  'resolution',
  'cacheKey',
  'candidates',
  'fuzzy',
  'similarity',
  'removalStatus',
  'ggDealsNoData',
  'inWishlist',
  'inTradables',
  'price',
  'currency',
]);

let workstationInstanceSequence = 0;


export function tradeEntityKey(game) {
  if (!game?.appId) return `title:${String(game?.title ?? game?.name ?? '').toLowerCase()}`;
  return `${normalizeSteamType(game.type)}:${String(game.appId)}`;
}

export class SidebarWorkstation {
  constructor(tradeSimulator) {
    this.sim = tradeSimulator;
    this.pageGames = [];
    this.tradableGames = [];
    this.inTrade = { trader: [], mine: [] };
    this.sortBy = 'title';
    this.sortDir = 'asc';
    this.tradableSortBy = 'title';
    this.tradableSortDir = 'asc';
    this.searchQuery = '';
    this.tradableSearchQuery = '';
    this.showOriginalTitle = true;
    this.activeBadgeFilters = new Set();
    this._resolutionOpenToken = 0;
    this._instanceId = ++workstationInstanceSequence;
    this._jumpTarget = null;
    this._jumpHighlightTimer = null;
    this._pageGameIndex = new Map();
    this._renderFrame = null;
    this._pendingRender = this._emptyRenderRequest();
    this.onGamesUpdated = null;
    this._init();
  }

  _init() {
    this.el = document.createElement('div');
    this.el.className = 'stpt-workstation';
    this.el.innerHTML = `
      <div class="stpt-ws-resize-handle"></div>
      <div class="stpt-ws-header">
        <span class="stpt-ws-title">ANALYSIS</span>
        <span class="stpt-ws-close" title="Close">✕</span>
      </div>
      <div class="stpt-ws-body">
        <div class="stpt-ws-data">
          <div class="stpt-ws-col-header">
            <span class="stpt-ws-section-title">All Page Games</span>
            <span class="stpt-ws-all-count" title="Visible all-games count">0</span>
          </div>
          <div class="stpt-ws-options"></div>
          <div class="stpt-ws-search"></div>
          <div class="stpt-ws-list"></div>
        </div>
        <div class="stpt-ws-col-resize"></div>
        <div class="stpt-ws-action">
          <div class="stpt-in-trade-section"></div>
          <div class="stpt-sim-section"></div>
          <div class="stpt-wishlist-section"></div>
          <div class="stpt-tradables-section"></div>
        </div>
      </div>
      <button class="stpt-ws-col-toggle" title="Collapse sidebar">›</button>
      <div class="stpt-ws-collapsed-strip" title="Expand sidebar">‹</div>
    `;

    this._dataCol = this.el.querySelector('.stpt-ws-data');
    this._actionCol = this.el.querySelector('.stpt-ws-action');
    this._dataList = this.el.querySelector('.stpt-ws-list');
    this._simSection = this.el.querySelector('.stpt-sim-section');
    this._wishlistSection = this.el.querySelector('.stpt-wishlist-section');
    this._tradablesSection = this.el.querySelector('.stpt-tradables-section');
    this._inTradeSection = this.el.querySelector('.stpt-in-trade-section');
    this._allGamesCountEl = this.el.querySelector('.stpt-ws-all-count');

    this._restoreShowOriginalTitle();
    this._setupDataColumn();
    this._setupSimBox();
    this._setupInTradeSection();
    this._setupResizeHandlers();

    this.el.querySelector('.stpt-ws-close').addEventListener('click', () => {
      this._setFilterMenuOpen(false);
      this.el.style.display = 'none';
    });

    this.el.querySelector('.stpt-ws-col-toggle').addEventListener('click', () => {
      this._setFilterMenuOpen(false);
      this.el.classList.add('collapsed');
      this._saveCollapsedState(true);
    });

    this.el.querySelector('.stpt-ws-collapsed-strip').addEventListener('click', () => {
      this.el.classList.remove('collapsed');
      this._saveCollapsedState(false);
    });

    document.body.appendChild(this.el);
    this._restoreCollapsedState();
    this._setupViewOptions();
  }

  _restoreShowOriginalTitle() {
    try {
      const saved = localStorage.getItem('stpt-ws-show-original-title');
      if (saved !== null) {
        this.showOriginalTitle = saved !== 'false';
      }
    } catch {
      // Ignore localStorage errors
    }
  }

  _setupViewOptions() {
    const optionsRow = this.el.querySelector('.stpt-ws-data .stpt-ws-options');
    if (!optionsRow) return;

    const filterGroup = document.createElement('div');
    filterGroup.className = 'stpt-ws-filter-group';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'stpt-ws-filter-trigger';
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    const triggerText = document.createElement('span');
    triggerText.textContent = 'Filters';
    const triggerCount = document.createElement('span');
    triggerCount.className = 'stpt-ws-filter-count';
    triggerCount.hidden = true;
    const caret = document.createElement('span');
    caret.className = 'stpt-ws-filter-caret';
    caret.textContent = '▾';
    trigger.append(triggerText, triggerCount, caret);
    filterGroup.appendChild(trigger);

    const menu = document.createElement('div');
    menu.id = `stpt-ws-filter-menu-${this._instanceId}`;
    menu.className = 'stpt-ws-filter-menu';
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Game badge filters');
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);

    for (const option of COMPACT_BADGE_FILTERS) {
      const label = document.createElement('label');
      label.className = 'stpt-ws-filter-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = false;
      checkbox.value = option.key;
      const badge = document.createElement('span');
      badge.className = `stpt-game-compact-badge ${option.className}`;
      badge.textContent = option.badgeLabel;
      const optionText = document.createElement('span');
      optionText.className = 'stpt-ws-filter-option-text';
      optionText.textContent = option.label;
      label.append(checkbox, badge, optionText);
      menu.appendChild(label);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.activeBadgeFilters.add(option.key);
        else this.activeBadgeFilters.delete(option.key);
        const count = this.activeBadgeFilters.size;
        triggerCount.textContent = String(count);
        triggerCount.hidden = count === 0;
        trigger.setAttribute('aria-label', count === 0 ? 'Filters' : `Filters, ${count} active`);
        this._renderDataList();
      });
    }
    filterGroup.appendChild(menu);
    optionsRow.appendChild(filterGroup);
    this._filterTriggerEl = trigger;
    this._filterMenuEl = menu;
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      this._setFilterMenuOpen(menu.hidden);
    });
    this._onFilterDocumentClick = event => {
      if (!filterGroup.contains(event.target)) this._setFilterMenuOpen(false);
    };
    this._onFilterDocumentKeydown = event => {
      if (event.key !== 'Escape' || menu.hidden) return;
      event.preventDefault();
      this._setFilterMenuOpen(false, { focusTrigger: true });
    };
    document.addEventListener('click', this._onFilterDocumentClick);
    document.addEventListener('keydown', this._onFilterDocumentKeydown);

    const label = document.createElement('label');
    label.className = 'stpt-ws-option-toggle stpt-ws-orig-title-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.showOriginalTitle;
    this._origTitleCheckboxEl = cb;
    label.appendChild(cb);
    label.appendChild(document.createTextNode('Original names'));
    optionsRow.appendChild(label);
    cb.addEventListener('change', () => {
      this.showOriginalTitle = cb.checked;
      try {
        localStorage.setItem('stpt-ws-show-original-title', String(cb.checked));
      } catch {
        // Ignore
      }
      this._renderDataList();
    });
  }

  _setFilterMenuOpen(open, { focusTrigger = false } = {}) {
    if (!this._filterMenuEl || !this._filterTriggerEl) return;
    this._filterMenuEl.hidden = !open;
    this._filterTriggerEl.setAttribute('aria-expanded', String(open));
    if (focusTrigger) this._filterTriggerEl.focus();
  }

  _setupResizeHandlers() {
    const sidebarResize = this.el.querySelector('.stpt-ws-resize-handle');
    const colResize = this.el.querySelector('.stpt-ws-col-resize');

    let isResizingSidebar = false;
    let isResizingCol = false;
    let startX = 0;
    let startWidth = 0;

    // Restore saved sizes
    this._restoreSizes();

    // Sidebar width resize
    sidebarResize.addEventListener('mousedown', (e) => {
      isResizingSidebar = true;
      startX = e.clientX;
      startWidth = this.el.offsetWidth;
      sidebarResize.classList.add('active');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });

    // Column resize
    colResize.addEventListener('mousedown', (e) => {
      if (e.target.closest('.stpt-ws-col-toggle')) return;
      isResizingCol = true;
      startX = e.clientX;
      startWidth = this._dataCol.offsetWidth;
      colResize.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (isResizingSidebar) {
        const diff = startX - e.clientX;
        const newWidth = Math.min(800, Math.max(300, startWidth + diff));
        this.el.style.width = `${newWidth}px`;
      }
      if (isResizingCol) {
        const diff = e.clientX - startX;
        const bodyWidth = this.el.querySelector('.stpt-ws-body').offsetWidth;
        const newDataWidth = Math.min(600, Math.max(150, startWidth + diff));
        this._dataCol.style.width = `${newDataWidth}px`;
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizingSidebar) {
        this._saveSizes();
        sidebarResize.classList.remove('active');
        isResizingSidebar = false;
      }
      if (isResizingCol) {
        this._saveSizes();
        colResize.classList.remove('active');
        isResizingCol = false;
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  _saveSizes() {
    try {
      const data = {
        sidebarWidth: this.el.offsetWidth,
        colWidth: this._dataCol.offsetWidth
      };
      localStorage.setItem('stpt-ws-sizes', JSON.stringify(data));
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  _restoreSizes() {
    try {
      const saved = localStorage.getItem('stpt-ws-sizes');
      if (saved) {
        const data = JSON.parse(saved);
        if (data.sidebarWidth) {
          this.el.style.width = `${Math.min(800, Math.max(300, data.sidebarWidth))}px`;
        }
        if (data.colWidth) {
          this._dataCol.style.width = `${Math.min(600, Math.max(150, data.colWidth))}px`;
        }
      }
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  _saveCollapsedState(collapsed) {
    try {
      localStorage.setItem('stpt-ws-collapsed', String(collapsed));
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  _restoreCollapsedState() {
    try {
      const saved = localStorage.getItem('stpt-ws-collapsed');
      if (saved === 'true') {
        this.el.classList.add('collapsed');
      }
    } catch (e) {
      // Ignore localStorage errors
    }
  }

  _setupDataColumn() {
    const searchContainer = this._dataCol.querySelector('.stpt-ws-search');

    const searchControl = createSearchBar({
      placeholder: 'Search games...',
      onSearch: (query) => {
        this.searchQuery = query.toLowerCase();
        this._renderDataList();
      }
    });
    const searchInput = searchControl.querySelector('input');
    searchContainer.appendChild(searchInput);

    const sortSelect = createSortSelect({
      options: [
        { value: 'title-asc', label: 'A → Z' },
        { value: 'title-desc', label: 'Z → A' },
        { value: 'price-asc', label: 'Price ↑' },
        { value: 'price-desc', label: 'Price ↓' }
      ],
      onSort: (value) => {
        const [field, dir] = value.split('-');
        this.sortBy = field;
        this.sortDir = dir;
        this._renderDataList();
      }
    });
    searchContainer.appendChild(sortSelect);

    this._virtualList = createVirtualList({
      itemHeight: this.showOriginalTitle ? 42 : 36,
      renderItem: (game, index) => this._renderDataRow(game, index)
    });
    this._dataList.appendChild(this._virtualList.container);
  }

  _emptyRenderRequest() {
    return {
      data: false,
      wishlist: false,
      tradables: false,
      inTrade: false,
      sim: false,
      preserveScroll: true,
    };
  }

  _requestRender(flags, { preserveScroll = true } = {}) {
    for (const key of ['data', 'wishlist', 'tradables', 'inTrade', 'sim']) {
      if (flags?.[key]) this._pendingRender[key] = true;
    }
    if (flags?.data && !preserveScroll) this._pendingRender.preserveScroll = false;
    if (this.el.style.display === 'none' || this._renderFrame != null) return;
    const requestFrame = globalThis.requestAnimationFrame
      ?? (callback => globalThis.setTimeout(callback, 0));
    this._renderFrame = requestFrame(() => {
      this._renderFrame = null;
      this._flushPendingRender();
    });
  }

  _flushPendingRender() {
    if (this.el.style.display === 'none') return;
    const request = this._pendingRender;
    this._pendingRender = this._emptyRenderRequest();
    if (request.data) this._renderDataList({ preserveScroll: request.preserveScroll });
    if (request.wishlist) this._renderWishlistSection();
    if (request.tradables) this._renderTradablesSection();
    if (request.inTrade) this._renderInTrade();
    if (request.sim) this._updateSimStats();
  }

  _rebuildPageGameIndex() {
    this._pageGameIndex = new Map();
    this.pageGames.forEach((game, index) => {
      if (game?.stptId != null) this._pageGameIndex.set(String(game.stptId), index);
    });
  }

  _renderDataRow(game, index) {
    const isInTrade = this._isInTrade(game);
    return createGameRow({
      game,
      isSelected: isInTrade,
      isInWishlist: game.inWishlist,
      isInTradables: game.inTradables,
      isInTrade,
      showOriginalTitle: this.showOriginalTitle,
      onNavigate: selectedGame => this._navigateToPageGame(selectedGame),
      onResolve: (selectedGame, anchorEl) => this._openResolutionForGame(selectedGame, anchorEl),
      onAction: () => this._addToMyGames(game)
    });
  }

  _clearJumpHighlight() {
    if (this._jumpHighlightTimer) clearTimeout(this._jumpHighlightTimer);
    this._jumpHighlightTimer = null;
    this._jumpTarget?.classList?.remove('stpt-game-jump-target');
    this._jumpTarget = null;
  }

  _highlightPageGame(target) {
    this._clearJumpHighlight();
    target.classList.remove('stpt-game-jump-target');
    void target.offsetWidth;
    target.classList.add('stpt-game-jump-target');
    this._jumpTarget = target;
    this._jumpHighlightTimer = setTimeout(() => this._clearJumpHighlight(), 1400);
  }

  _navigateToPageGame(game) {
    const stptId = String(game?.stptId ?? '');
    const currentGame = this.pageGames.find(item => String(item.stptId ?? '') === stptId);
    const target = currentGame?.el;
    if (!target?.isConnected) return false;

    this._setFilterMenuOpen(false);
    this._highlightPageGame(target);
    const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    target.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
    return true;
  }

  async _openResolutionForGame(game, anchorEl) {
    const token = ++this._resolutionOpenToken;
    const stptId = String(game?.stptId ?? '');
    const initialGame = this.pageGames.find(item => String(item.stptId ?? '') === stptId);
    const initialDescriptor = getResolutionBadgeDescriptor(initialGame);
    if (!initialGame?.el?.isConnected || !anchorEl?.isConnected || !initialDescriptor?.interactive) return;

    if (!this._navigateToPageGame(initialGame)) return;
    try {
      const [pickers] = await Promise.all([
        import('./ui-pickers.js'),
        new Promise(resolve => setTimeout(resolve, 150)),
      ]);
      if (token !== this._resolutionOpenToken) return;
      const currentGame = this.pageGames.find(item => String(item.stptId ?? '') === stptId);
      const currentDescriptor = getResolutionBadgeDescriptor(currentGame);
      if (!currentGame?.el?.isConnected || !anchorEl.isConnected) return;
      if (!currentDescriptor?.interactive || currentDescriptor.kind !== initialDescriptor.kind) return;

      if (currentDescriptor.kind === 'ambiguous') {
        pickers.openCandidatePicker(
          anchorEl,
          currentGame.candidates ?? currentGame.resolution?.candidates ?? [],
          currentGame.cacheKey ?? currentGame.resolution?.cacheKey,
          currentGame.el,
          { position: 'fixed' }
        );
      } else if (currentDescriptor.kind === 'not-found') {
        pickers.openNotFoundPicker(
          anchorEl,
          currentGame.cacheKey ?? currentGame.resolution?.cacheKey,
          currentGame.originalTitle || currentGame.title,
          currentGame.el,
          { position: 'fixed' }
        );
      } else if (currentDescriptor.kind === 'fuzzy') {
        pickers.openFuzzyPicker(anchorEl, currentGame.resolution, currentGame.el, { position: 'fixed' });
      }
    } catch (error) {
      console.warn('[STPT] Failed to open workstation resolution picker:', error?.message ?? error);
    }
  }

  _setupSimBox() {
    this._simSection.innerHTML = `
      <div class="stpt-sim-box">
        <div class="stpt-sim-diff">
          <span class="stpt-sim-label">Difference</span>
          <span class="stpt-sim-diff-badge fair" id="stpt-sim-badge">Fair trade</span>
          <span class="stpt-sim-value diff" id="stpt-sim-diff">€0.00</span>
        </div>
        <div class="stpt-sim-threshold">
          <label>Threshold:</label>
          <input type="range" min="1" max="50" value="10" id="stpt-sim-threshold">
          <span id="stpt-sim-threshold-val">10%</span>
        </div>
      </div>
    `;

    this._simSection.querySelector('#stpt-sim-threshold').addEventListener('input', e => {
      const val = parseInt(e.target.value);
      this.sim.threshold = val / 100;
      document.getElementById('stpt-sim-threshold-val').textContent = `${val}%`;
      this._updateSimStats();
    });
  }

  _setupInTradeSection() {
    this._inTradeSection.innerHTML = `
      <div class="stpt-ws-col-header">
        <span class="stpt-ws-section-title in-trade">Currently in Trade</span>
        <span id="stpt-in-trade-count" style="margin-left:auto;margin-right:8px;color:#64748b;"></span>
      </div>
      <div class="stpt-ws-section-list" id="stpt-in-trade-list"></div>
    `;
  }

  _isInTrade(game) {
    const key = tradeEntityKey(game);
    return this.inTrade.mine.some(g => tradeEntityKey(g) === key) ||
           this.inTrade.trader.some(g => tradeEntityKey(g) === key);
  }

  _addToMyGames(game) {
    // Route to correct side based on which page section the game belongs to:
    // - "I have" section (trader's offerings) → Trader's side
    // - "I want" section (what trader wants from you) → Your side
    if (game.section === 'have') {
      this._addToTraderGames(game);
      return;
    }
    if (game.section === 'want') {
      this._addToMyGamesCore(game);
      return;
    }
    // No section = user's own tradables (from profile), add to Your side
    this._addToMyGamesCore(game);
  }

  _addToMyGamesCore(game) {
    // Try to get price from the page badge if not already set
    if (game.price == null && game.el) {
      const badge = game.el.querySelector('.stpt-badge-price');
      if (badge) {
        const priceText = badge.textContent.replace(',', '');
        const match = priceText.match(/([\d.]+)/);
        if (match) {
          game.price = Math.round(parseFloat(match[1]) * 100);
        }
      }
    }
    if (!this._isInTrade(game)) {
      this.inTrade.mine.push(game);
      this._renderInTrade();
      this._renderDataList();
      this._updateSimStats();
    }
  }

  _addToTraderGames(game) {
    // Try to get price from the page badge if not already set
    if (game.price == null && game.el) {
      const badge = game.el.querySelector('.stpt-badge-price');
      if (badge) {
        const priceText = badge.textContent.replace(',', '');
        const match = priceText.match(/([\d.]+)/);
        if (match) {
          game.price = Math.round(parseFloat(match[1]) * 100);
        }
      }
    }
    const key = tradeEntityKey(game);
    if (!this.inTrade.trader.some(g => tradeEntityKey(g) === key)) {
      this.inTrade.trader.push(game);
      this._renderInTrade();
      this._updateSimStats();
    }
  }

  _removeFromTrade(game) {
    const key = tradeEntityKey(game);
    this.inTrade.mine = this.inTrade.mine.filter(g => tradeEntityKey(g) !== key);
    this.inTrade.trader = this.inTrade.trader.filter(g => tradeEntityKey(g) !== key);
    this._renderInTrade();
    this._renderDataList();
    this._updateSimStats();
  }

  _renderInTrade() {
    const list = document.getElementById('stpt-in-trade-list');
    const count = this.inTrade.mine.length + this.inTrade.trader.length;
    document.getElementById('stpt-in-trade-count').textContent = count;

    list.innerHTML = '';

    if (count === 0) {
      list.appendChild(createEmptyState({ message: 'Add games to simulate a trade' }));
      return;
    }

    // Show traders games
    if (this.inTrade.trader.length > 0) {
      const traderTotal = this.inTrade.trader.reduce((sum, g) => sum + (g.price || 0), 0);
      const traderHeader = createSectionHeader({ title: `Traders  ${formatPrice(traderTotal) ?? '—'}` });
      list.appendChild(traderHeader);
      this.inTrade.trader.forEach(game => {
        const row = createGameRow({
          game,
          onRemove: () => this._removeFromTrade(game)
        });
        list.appendChild(row);
      });
    }

    // Show yours games
    if (this.inTrade.mine.length > 0) {
      const myTotal = this.inTrade.mine.reduce((sum, g) => sum + (g.price || 0), 0);
      const mineHeader = createSectionHeader({ title: `Yours  ${formatPrice(myTotal) ?? '—'}` });
      list.appendChild(mineHeader);
      this.inTrade.mine.forEach(game => {
        const row = createGameRow({
          game,
          onRemove: () => this._removeFromTrade(game)
        });
        list.appendChild(row);
      });
    }
  }

  _updateSimStats() {
    const traderTotal = this.inTrade.trader.reduce((sum, g) => sum + (g.price || 0), 0);
    const myTotal = this.inTrade.mine.reduce((sum, g) => sum + (g.price || 0), 0);
    const diff = myTotal - traderTotal;
    const diffPercent = (traderTotal === 0 || myTotal === 0) ? Infinity : Math.abs(diff / Math.max(traderTotal, myTotal));

    const diffEl = document.getElementById('stpt-sim-diff');
    const badgeEl = document.getElementById('stpt-sim-badge');

    const sign = diff >= 0 ? '+' : '';
    diffEl.textContent = `${sign}${formatPrice(diff)}`;

    if (traderTotal === 0 && myTotal === 0) {
      badgeEl.textContent = 'No games';
      badgeEl.className = 'stpt-sim-diff-badge fair';
    } else if (diff === 0) {
      badgeEl.textContent = 'Even trade';
      badgeEl.className = 'stpt-sim-diff-badge fair';
    } else if (diffPercent <= this.sim.threshold) {
      badgeEl.textContent = 'Fair trade';
      badgeEl.className = 'stpt-sim-diff-badge fair';
    } else {
      badgeEl.textContent = 'Unfair';
      badgeEl.className = 'stpt-sim-diff-badge unfair';
    }
  }

  _sortGames(games) {
    const sorted = [...games];
    const dir = this.sortDir === 'asc' ? 1 : -1;

    sorted.sort((a, b) => {
      if (this.sortBy === 'title') {
        const aName = (a.title || a.name || '').toLowerCase();
        const bName = (b.title || b.name || '').toLowerCase();
        return aName.localeCompare(bName) * dir;
      }
      if (this.sortBy === 'price') {
        return ((a.price || 0) - (b.price || 0)) * dir;
      }
      return 0;
    });

    return sorted;
  }

  _filterGames(games, query) {
    if (!query) return games;
    return games.filter(g => {
      const resolvedName = (g.title || g.name || '').toLowerCase();
      const originalName = (g.originalTitle || '').toLowerCase();
      return resolvedName.includes(query) || originalName.includes(query);
    });
  }

  _renderDataList({ preserveScroll = false } = {}) {
    // Only show games from the "I have" (have) section, not "I want"
    const haveGames = this.pageGames.filter(game => (
      game.section === 'have' && game.resolution?.status !== 'dismissed'
    ));
    const badgeFiltered = haveGames.filter(game => {
      if (this.activeBadgeFilters.size === 0) return true;
      const keys = getCompactBadgeFilterKeys(game);
      for (const key of this.activeBadgeFilters) {
        if (keys.has(key)) return true;
      }
      return false;
    });
    const filtered = this._filterGames(badgeFiltered, this.searchQuery);
    const sorted = this._sortGames(filtered);
    if (this._allGamesCountEl) {
      this._allGamesCountEl.textContent = `Total: ${filtered.length}`;
      this._allGamesCountEl.title = this.searchQuery
        ? `${filtered.length} matching games`
        : `${filtered.length} games`;
    }
    this._updateVirtualListHeight(sorted);
    this._virtualList.setItems(sorted, { preserveScroll });
  }

  _hasAnyDualTitle(games) {
    if (!this.showOriginalTitle) return false;
    return games.some(hasDualTitle);
  }

  _updateVirtualListHeight(games) {
    if (!this._virtualList || !this._virtualList.setItemHeight) return;
    this._virtualList.setItemHeight(this._hasAnyDualTitle(games) ? 42 : 36);
  }

  _renderWishlistSection() {
    this._wishlistSection.innerHTML = `
      <div class="stpt-ws-section">
        <div class="stpt-ws-section-title wishlist">In your wishlist:</div>
        <div class="stpt-ws-list-inner" id="stpt-wishlist-games"></div>
      </div>
    `;

    const list = document.getElementById('stpt-wishlist-games');
    const wishlistOnPage = this.pageGames.filter(g => g.inWishlist && g.section === 'have');

    if (wishlistOnPage.length === 0) {
      list.appendChild(createEmptyState({ message: 'No wishlist games on this page' }));
      return;
    }

    wishlistOnPage.forEach(game => {
      const isInTrade = this._isInTrade(game);
      const row = createGameRow({
        game,
        isHighlighted: true,
        isInTrade,
        onAction: () => this._addToMyGames(game)
      });
      list.appendChild(row);
    });
  }

  _renderTradablesSection() {
    this._tradablesSection.innerHTML = `
      <div class="stpt-ws-section">
        <div class="stpt-ws-section-header">
          <div class="stpt-ws-section-title tradables">In your tradables:</div>
          <button class="stpt-ws-manage-btn" title="Open Tradables Manager">Manage →</button>
        </div>
        <div class="stpt-ws-list-inner" id="stpt-tradables-on-page"></div>
        <div class="stpt-sub-label" id="stpt-other-tradables-label">Your other tradables:</div>
        <div class="stpt-ws-search" id="stpt-tradables-search"></div>
        <div class="stpt-ws-list-inner" id="stpt-tradables-games"></div>
      </div>
    `;

    // Manage button click handler
    const manageBtn = this._tradablesSection.querySelector('.stpt-ws-manage-btn');
    if (manageBtn) {
      manageBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_POPUP_TAB', tab: 'tradables' });
      });
    }

    // Games on page that are in user's tradables (tier 2)
    const tradablesOnPage = this.pageGames.filter(g => g.inTradables && g.section === 'want');

    const onPageList = document.getElementById('stpt-tradables-on-page');
    if (tradablesOnPage.length > 0) {
      tradablesOnPage.forEach(game => {
        const isInTrade = this._isInTrade(game);
        const row = createGameRow({
          game,
          isHighlighted: true,
          isInTrade,
          onAction: () => this._addToMyGames(game)
        });
        onPageList.appendChild(row);
      });
    } else {
      onPageList.appendChild(createEmptyState({ message: 'None on this page' }));
    }

    // All user's tradables (excluding ones already shown on page)
    const allTradables = this.tradableGames || [];
    const onPageNames = new Set(tradablesOnPage.map(g => (g.title || '').toLowerCase()));
    const otherTradables = allTradables.filter(g => {
      const name = (g.name || g.title || '').toLowerCase();
      return !onPageNames.has(name);
    });

    const otherLabel = document.getElementById('stpt-other-tradables-label');
    const searchContainer = document.getElementById('stpt-tradables-search');
    const otherList = document.getElementById('stpt-tradables-games');

    if (otherTradables.length > 0) {
      otherLabel.style.display = 'block';

      const searchInput = createSearchBar({
        placeholder: 'Search your tradables...',
        onSearch: (query) => {
          this.tradableSearchQuery = query.toLowerCase();
          this._renderTradablesList(otherTradables, otherList);
        }
      });
      searchContainer.appendChild(searchInput);

      const sortSelect = createSortSelect({
        options: [
          { value: 'title-asc', label: 'A → Z' },
          { value: 'title-desc', label: 'Z → A' },
          { value: 'price-asc', label: 'Price ↑' },
          { value: 'price-desc', label: 'Price ↓' }
        ],
        onSort: (value) => {
          const [field, dir] = value.split('-');
          this.tradableSortBy = field;
          this.tradableSortDir = dir;
          this._renderTradablesList(otherTradables, otherList);
        }
      });
      searchContainer.appendChild(sortSelect);

      this._renderTradablesList(otherTradables, otherList);
    } else {
      otherLabel.style.display = 'none';
      searchContainer.style.display = 'none';
      otherList.appendChild(createEmptyState({ message: 'No other tradables' }));
    }
  }

  _renderTradablesList(sourceGames, container) {
    const filtered = this._filterGames(sourceGames, this.tradableSearchQuery);
    const sortBy = this.tradableSortBy || 'title';
    const sortDir = this.tradableSortDir || 'asc';
    const sorted = this._sortGamesWithParams(filtered, sortBy, sortDir);

    container.innerHTML = '';
    if (filtered.length === 0) {
      container.appendChild(createEmptyState({ message: 'No matching tradables' }));
      return;
    }

    sorted.forEach(game => {
      const isInTrade = this._isInTrade(game);
      const row = createGameRow({
        game,
        isInTrade,
        onAction: () => this._addToMyGames(game)
      });
      container.appendChild(row);
    });
  }

  _sortGamesWithParams(games, sortBy, sortDir) {
    const sorted = [...games];
    const dir = sortDir === 'asc' ? 1 : -1;

    sorted.sort((a, b) => {
      if (sortBy === 'title') {
        const aName = (a.title || a.name || '').toLowerCase();
        const bName = (b.title || b.name || '').toLowerCase();
        return aName.localeCompare(bName) * dir;
      }
      if (sortBy === 'price') {
        return ((a.price || 0) - (b.price || 0)) * dir;
      }
      return 0;
    });

    return sorted;
  }

  setPageGames(games) {
    this.pageGames = games || [];
    this._rebuildPageGameIndex();
    this._renderDataList();
    this._renderWishlistSection();
    this._renderTradablesSection();
  }

  updateGamePrices(priceMap) {
    // priceMap: { appId: { price: numberInCents, currency: string } }
    if (!priceMap) return;
    let changed = false;
    let wishlist = false;
    let tradables = false;
    let inTrade = false;
    this.pageGames.forEach(game => {
      if (game.appId) {
        const type = normalizeSteamType(game.type);
        const typedKey = `${type}:${game.appId}`;
        const data = priceMap[typedKey] ?? (type === 'app' ? priceMap[game.appId] : null);
        if (!data) return;
        if (game.price === (data.price ?? null) && game.currency === (data.currency ?? 'EUR')) return;
        game.price = data.price ?? null;
        game.currency = data.currency ?? 'EUR';
        changed = true;
        wishlist ||= game.section === 'have' && game.inWishlist === true;
        tradables ||= game.section === 'want' && game.inTradables === true;
        inTrade ||= this._isInTrade(game);
      }
    });
    if (!changed) return;
    this._requestRender({ data: true, wishlist, tradables, inTrade, sim: inTrade });
  }

  updateResolvedPageGame(stptId, update) {
    this.updateResolvedPageGames([{ stptId, update }]);
  }

  /**
   * Applies multiple identity/price patches before rendering once. Progressive
   * content batches use this to avoid rebuilding the virtual list for every
   * resolved title.
   */
  updateResolvedPageGames(patches) {
    const updates = new Map((patches ?? [])
      .filter(patch => patch?.stptId != null && patch?.update)
      .map(patch => [String(patch.stptId), patch.update]));
    if (updates.size === 0) return;

    const apply = (game, update = updates.get(String(game.stptId ?? ''))) => {
      if (!update) return game;
      const next = { ...game };
      for (const field of WORKSTATION_PATCH_FIELDS) {
        if (Object.hasOwn(update, field)) next[field] = update[field];
      }
      if (Object.hasOwn(update, 'title') && !Object.hasOwn(update, 'name')) {
        next.name = update.title;
      }
      if (Object.hasOwn(update, 'tier')) {
        if (!Object.hasOwn(update, 'inWishlist')) next.inWishlist = update.tier === 1;
        if (!Object.hasOwn(update, 'inTradables')) next.inTradables = update.tier === 2;
      }
      return next;
    };

    let changed = false;
    let wishlist = false;
    let tradables = false;
    for (const [stptId, update] of updates) {
      const index = this._pageGameIndex.get(stptId);
      if (index == null) continue;
      const previous = this.pageGames[index];
      const next = apply(previous, update);
      this.pageGames[index] = next;
      changed = true;
      wishlist ||= (previous.section === 'have' && previous.inWishlist === true)
        || (next.section === 'have' && next.inWishlist === true);
      tradables ||= (previous.section === 'want' && previous.inTradables === true)
        || (next.section === 'want' && next.inTradables === true);
    }
    if (!changed) return;

    let inTradeChanged = false;
    const keepSimulatableIdentity = game => {
      if (!updates.has(String(game.stptId ?? ''))) return true;
      return game.resolution?.status !== 'dismissed' && game.appId != null;
    };
    const patchTrade = games => games.map(game => {
      const update = updates.get(String(game.stptId ?? ''));
      if (!update) return game;
      inTradeChanged = true;
      return apply(game, update);
    }).filter(keepSimulatableIdentity);
    this.inTrade.mine = patchTrade(this.inTrade.mine);
    this.inTrade.trader = patchTrade(this.inTrade.trader);
    this._requestRender({
      data: true,
      wishlist,
      tradables,
      inTrade: inTradeChanged,
      sim: inTradeChanged,
    });
  }

  setTradableGames(games) {
    this.tradableGames = (games || []).map(g => {
      if (typeof g === 'string') return { name: g };
      return { appId: g.appId, type: g.type ?? 'app', name: g.name ?? g.title };
    });
    this._requestRender({ tradables: true });
  }

  updateTradablePrices(priceMap) {
    // priceMap: { 'lowercase name': { appId, price, currency } }
    if (!priceMap) return;
    this.tradableGames.forEach(game => {
      const key = (game.name || game.title || '').toLowerCase();
      const data = priceMap[key];
      if (data) {
        game.appId = data.appId;
        game.price = data.price ?? null;
        game.currency = data.currency ?? 'EUR';
      }
    });
    this._requestRender({ tradables: true });
  }

  addTraderGame(game) {
    this._addToTraderGames(game);
  }

  removeTraderGame(game) {
    const key = tradeEntityKey(game);
    this.inTrade.trader = this.inTrade.trader.filter(g => tradeEntityKey(g) !== key);
    this._renderInTrade();
    this._updateSimStats();
  }

  clearTrade() {
    this.inTrade = { trader: [], mine: [] };
    this._renderInTrade();
    this._renderDataList();
    this._updateSimStats();
  }

  show() {
    this.el.style.display = 'flex';
    this._requestRender({});
  }

  hide() {
    this._setFilterMenuOpen(false);
    this.el.style.display = 'none';
  }

  destroy() {
    this._clearJumpHighlight();
    const cancelFrame = globalThis.cancelAnimationFrame
      ?? (frame => globalThis.clearTimeout(frame));
    if (this._renderFrame != null) cancelFrame(this._renderFrame);
    this._renderFrame = null;
    this._pendingRender = this._emptyRenderRequest();
    this._virtualList?.destroy?.();
    if (this._onFilterDocumentClick) document.removeEventListener('click', this._onFilterDocumentClick);
    if (this._onFilterDocumentKeydown) document.removeEventListener('keydown', this._onFilterDocumentKeydown);
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}
