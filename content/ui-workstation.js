// content/ui-workstation.js
// Sidebar Workstation - Trade simulation sidebar with game lists

import {
  createGameRow,
  createSearchBar,
  createSortSelect,
  createSectionHeader,
  createVirtualList,
  createEmptyState,
  formatPrice
} from './ui-components.js';
import { normalizeSteamType } from '../utils/similarity.js';


export function tradeEntityKey(game) {
  if (!game?.appId) return `title:${String(game?.title ?? game?.name ?? '').toLowerCase()}`;
  return `${normalizeSteamType(game.type)}:${String(game.appId)}`;
}

export class SidebarWorkstation {
  constructor(tradeSimulator) {
    this.sim = tradeSimulator;
    this.pageGames = [];
    this.wishlistGames = [];
    this.tradableGames = [];
    this.inTrade = { trader: [], mine: [] };
    this.sortBy = 'title';
    this.sortDir = 'asc';
    this.tradableSortBy = 'title';
    this.tradableSortDir = 'asc';
    this.searchQuery = '';
    this.tradableSearchQuery = '';
    this.showOriginalTitle = true;
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

    this._setupDataColumn();
    this._setupSimBox();
    this._setupInTradeSection();
    this._setupResizeHandlers();

    this.el.querySelector('.stpt-ws-close').addEventListener('click', () => {
      this.el.style.display = 'none';
    });

    this.el.querySelector('.stpt-ws-col-toggle').addEventListener('click', () => {
      this.el.classList.add('collapsed');
      this._saveCollapsedState(true);
    });

    this.el.querySelector('.stpt-ws-collapsed-strip').addEventListener('click', () => {
      this.el.classList.remove('collapsed');
      this._saveCollapsedState(false);
    });

    document.body.appendChild(this.el);
    this._restoreCollapsedState();
    this._restoreShowOriginalTitle();
    this._setupOriginalTitleToggle();
  }

  _restoreShowOriginalTitle() {
    try {
      const saved = localStorage.getItem('stpt-ws-show-original-title');
      if (saved !== null) {
        this.showOriginalTitle = saved !== 'false';
      }
      this._origTitleCheckboxEl = null;
    } catch {
      // Ignore localStorage errors
    }
  }

  _setupOriginalTitleToggle() {
    const header = this.el.querySelector('.stpt-ws-data .stpt-ws-col-header');
    if (!header) return;
    const label = document.createElement('label');
    label.className = 'stpt-ws-orig-title-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.showOriginalTitle;
    this._origTitleCheckboxEl = cb;
    label.appendChild(cb);
    label.appendChild(document.createTextNode('Show original names'));
    header.appendChild(label);
    cb.addEventListener('change', () => {
      this.showOriginalTitle = cb.checked;
      try {
        localStorage.setItem('stpt-ws-show-original-title', String(cb.checked));
      } catch {
        // Ignore
      }
      if (this._virtualList && this._virtualList.setItemHeight) {
        this._virtualList.setItemHeight(this.showOriginalTitle ? 50 : 36);
      }
      this._renderDataList();
    });
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

    const searchInput = createSearchBar({
      placeholder: 'Search games...',
      onSearch: (query) => {
        this.searchQuery = query.toLowerCase();
        this._renderDataList();
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
        this.sortBy = field;
        this.sortDir = dir;
        this._renderDataList();
      }
    });
    searchContainer.appendChild(sortSelect);

    this._virtualList = createVirtualList({
      itemHeight: this.showOriginalTitle ? 50 : 36,
      renderItem: (game, index) => this._renderDataRow(game, index)
    });
    this._dataList.appendChild(this._virtualList.container);
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
      onAction: () => this._addToMyGames(game)
    });
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
      const name = (g.title || g.name || '').toLowerCase();
      return name.includes(query);
    });
  }

  _renderDataList() {
    // Only show games from the "I have" (have) section, not "I want"
    const haveGames = this.pageGames.filter(g => g.section === 'have');
    const filtered = this._filterGames(haveGames, this.searchQuery);
    const sorted = this._sortGames(filtered);
    if (this._allGamesCountEl) {
      this._allGamesCountEl.textContent = String(filtered.length);
      this._allGamesCountEl.title = this.searchQuery
        ? `${filtered.length} matching games`
        : `${filtered.length} games`;
    }
    this._virtualList.setItems(sorted);
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
    this._renderDataList();
    this._renderWishlistSection();
    this._renderTradablesSection();
  }

  updateGamePrices(priceMap) {
    // priceMap: { appId: { price: numberInCents, currency: string } }
    if (!priceMap) return;
    this.pageGames.forEach(game => {
      if (game.appId) {
        const type = normalizeSteamType(game.type);
        const typedKey = `${type}:${game.appId}`;
        const data = priceMap[typedKey] ?? (type === 'app' ? priceMap[game.appId] : null);
        if (!data) return;
        game.price = data.price ?? null;
        game.currency = data.currency ?? 'EUR';
      }
    });
    this._renderDataList();
    this._renderWishlistSection();
    this._renderTradablesSection();
    this._renderInTrade();
    this._updateSimStats();
  }

  updateResolvedPageGame(stptId, update) {
    if (stptId == null) return;
    const id = String(stptId);
    const apply = game => {
      if (String(game.stptId ?? '') !== id) return game;
      return {
        ...game,
        title: update.title ?? game.title,
        name: update.name ?? update.title ?? game.name,
        appId: update.appId ?? game.appId,
        type: update.type ?? game.type,
        originalTitle: ('originalTitle' in update) ? update.originalTitle : game.originalTitle,
        manuallyResolved: ('manuallyResolved' in update) ? update.manuallyResolved : game.manuallyResolved,
        price: ('price' in update) ? update.price : (game.price ?? null),
        currency: ('currency' in update) ? update.currency : (game.currency ?? 'EUR'),
      };
    };
    this.pageGames = this.pageGames.map(apply);
    this.inTrade.mine = this.inTrade.mine.map(apply);
    this.inTrade.trader = this.inTrade.trader.map(apply);
    this._renderDataList();
    this._renderWishlistSection();
    this._renderTradablesSection();
    this._renderInTrade();
    this._updateSimStats();
  }

  setWishlistGames(games) {
    this.wishlistGames = games || [];
    this._renderDataList();
    this._renderWishlistSection();
    this._renderTradablesSection();
  }

  setTradableGames(games) {
    this.tradableGames = (games || []).map(g => {
      if (typeof g === 'string') return { name: g };
      return { appId: g.appId, type: g.type ?? 'app', name: g.name ?? g.title };
    });
    this._renderDataList();
    this._renderTradablesSection();
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
    this._renderTradablesSection();
    this._renderInTrade();
    this._updateSimStats();
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
  }

  hide() {
    this.el.style.display = 'none';
  }

  destroy() {
    if (this.el && this.el.parentNode) {
      this.el.parentNode.removeChild(this.el);
    }
  }
}
