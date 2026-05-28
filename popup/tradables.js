// popup/tradables.js
import { createBulkImportModal } from './tradables-bulk-modal.js';
import { getDisplayRegion } from '../utils/similarity.js';

function msg(type, data = {}) {
  return new Promise(resolve => chrome.runtime.sendMessage({ type, ...data }, resolve));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPrice(amount, currency = 'EUR') {
  if (amount == null) return '—';
  return new Intl.NumberFormat('en-EU', { style: 'currency', currency }).format(amount / 100);
}

/** Migrate old newline-string format to [{name, appId}] array */
function normalizeTradables(raw) {
  if (Array.isArray(raw)) {
    return raw.map(item => typeof item === 'string'
      ? { name: item, appId: null, type: 'app', qty: 1 }
      : { ...item, type: item.type ?? 'app', qty: Math.max(1, parseInt(item.qty) || 1) });
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split('\n').map(n => n.trim()).filter(Boolean).map(name => ({ name, appId: null, type: 'app', qty: 1 }));
  }
  return [];
}

/**
 * Render a price badge similar to the ones on SteamTrades pages.
 */
function renderPriceBadge(priceData, settings, item) {
  if (!priceData || !priceData.prices) {
    return '<span class="tradables-price-badge na">N/A</span>';
  }

  const prices = priceData.prices;
  const keyshopsEnabled = settings.keyshopsEnabled;
  
  // Determine best current price
  let bestCurrent = prices.currentRetail;
  if (keyshopsEnabled && prices.currentKeyshops != null) {
    if (bestCurrent == null || prices.currentKeyshops < bestCurrent) {
      bestCurrent = prices.currentKeyshops;
    }
  }

  // Determine best ATL
  let bestAtl = prices.historicalRetail;
  if (keyshopsEnabled && prices.historicalKeyshops != null) {
    if (bestAtl == null || prices.historicalKeyshops < bestAtl) {
      bestAtl = prices.historicalKeyshops;
    }
  }

  // Use settings.currency for consistency
  const currency = settings.currency ?? 'EUR';
  const priceFormatted = formatPrice(bestCurrent, currency);
  const timestamp = priceData.cachedAt ? formatTimestamp(priceData.cachedAt) : '';

  // Check if this is a DEAL (current price within threshold of ATL)
  if (bestCurrent != null && bestAtl != null && bestAtl > 0) {
    const pctAboveAtl = ((bestCurrent - bestAtl) / bestCurrent) * 100;
    if (pctAboveAtl <= (settings.dealThresholdPct ?? 10)) {
      return `<span class="tradables-price-badge deal" title="DEAL · ATL: ${formatPrice(bestAtl, currency)}${timestamp ? ' · ' + timestamp : ''}">${priceFormatted}</span>`;
    }
  }

  if (bestCurrent == null) {
    return '<span class="tradables-price-badge na">N/A</span>';
  }

  // Regular TRADE price
  const tooltip = bestAtl ? `ATL: ${formatPrice(bestAtl, currency)}${timestamp ? ' · ' + timestamp : ''}` : '';
  return `<span class="tradables-price-badge trade" title="${tooltip}">${priceFormatted}</span>`;
}

function formatTimestamp(cachedAt) {
  if (!cachedAt) return '';
  const now = Date.now();
  const diff = now - cachedAt;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'now';
}

export async function initTradables(container) {
  const settings = await msg('GET_SETTINGS');
  // Get tradables from separate storage (not from settings)
  let tradablesList = normalizeTradables(await msg('GET_TRADABLES'));

  // Resolve any tradables that have appId: null so prices can be fetched
  const unresolved = tradablesList.filter(t => !t.appId && t.name);
  if (unresolved.length > 0 && settings.apiKey) {
    const titles = unresolved.map(t => t.name);
    const resolutions = await msg('RESOLVE_TITLES', { titles });
    let changed = false;
    resolutions.forEach((res, i) => {
      if (res && (res.status === 'hit' || res.status === 'resolved') && res.appId) {
        unresolved[i].appId = String(res.appId);
        unresolved[i].type = res.type ?? 'app';
        if (res.title) unresolved[i].name = res.title;
        changed = true;
      }
    });
    if (changed) {
      await msg('SAVE_TRADABLES', { tradables: tradablesList });
    }
  }
  let searchQuery = '';
  let sortBy = 'name'; // 'name', 'name-desc', 'price', 'price-desc', 'acq', 'acq-desc'
  let undoStack = []; // Stack of {item, index} for undo functionality
  let undoTimeout = null;
  let modal = null;
  let priceData = {}; // appId -> price info
  let undoRenderTimeout = null; // For debounced undo bar rendering

  // Currency from settings (default EUR)
  let currency = settings.currency || 'EUR';
  let currencySymbol = currency === 'USD' ? '$' : '€';

  /**
   * Load cached prices first (no API calls), then optionally refresh.
   */
  async function loadCachedPrices() {
    if (!settings.apiKey) return;

    const appIds = tradablesList
      .filter(item => item.appId)
      .map(item => ({ id: item.appId, type: item.type ?? 'app' }));

    if (appIds.length === 0) return;

    try {
      const cached = await msg('GET_CACHED_PRICES', { items: appIds, regions: settings.regions });
      if (cached) {
        const region = getDisplayRegion(settings);
        for (const item of appIds) {
          const appId = item.id;
          if (cached[appId]?.[region]) {
            priceData[appId] = cached[appId][region];
          }
        }
      }
    } catch (err) {
      console.error('Failed to load cached prices:', err);
    }
  }

  /**
   * Fetch prices for all tradables with resolved appIds.
   * Manual refresh bypasses cache; normal loads preserve cached prices if the API is unavailable.
   */
  async function fetchPrices({ refresh = false } = {}) {
    if (!settings.apiKey) return;

    const appIds = tradablesList
      .filter(item => item.appId)
      .map(item => ({ id: item.appId, type: item.type ?? 'app' }));

    if (appIds.length === 0) return;

    try {
      const prices = await msg(refresh ? 'REFRESH_PRICES' : 'GET_PRICES', { items: appIds, regions: settings.regions });
      if (prices && !prices.error) {
        const region = getDisplayRegion(settings);
        for (const item of appIds) {
          const appId = item.id;
          if (prices[appId]?.[region]) {
            priceData[appId] = prices[appId][region];
          }
        }
      }
    } catch (err) {
      console.error('Failed to fetch prices:', err);
    }
  }

  /**
   * Clear the undo auto-dismiss timeout.
   */
  function clearUndoTimeout() {
    clearTimeout(undoTimeout);
    undoTimeout = null;
  }

  /**
   * Compute total estimated value from fetched prices.
   * PHASE 4A: Use acquisition price override when set, instead of GG.deals price.
   */
  function computeTotalValue() {
    let total = 0;
    let count = 0;

    for (const item of tradablesList) {
      if (!item.appId) continue;
      
      // PHASE 4A: Check if acquisition price is set — use it for EST. VALUE
      if (item.acqPrice != null) {
        total += Math.round(item.acqPrice * 100) * (item.qty ?? 1); // Convert to cents
        count += item.qty ?? 1;
        continue;
      }
      
      const data = priceData[item.appId];
      if (!data?.prices) continue;

      const prices = data.prices;
      const keyshopsEnabled = settings.keyshopsEnabled;
      
      let bestCurrent = prices.currentRetail;
      if (keyshopsEnabled && prices.currentKeyshops != null) {
        if (bestCurrent == null || prices.currentKeyshops < bestCurrent) {
          bestCurrent = prices.currentKeyshops;
        }
      }

      if (bestCurrent != null) {
        total += bestCurrent * (item.qty ?? 1);
        count += item.qty ?? 1;
      }
    }

    return count > 0 ? { total, count } : null;
  }

  /**
   * Get the display price for an item (for sorting).
   */
  function getItemPrice(item) {
    if (!item.appId) return Infinity;
    const data = priceData[item.appId];
    if (!data?.prices) return Infinity;
    const prices = data.prices;
    const keyshopsEnabled = settings.keyshopsEnabled;
    let best = prices.currentRetail;
    if (keyshopsEnabled && prices.currentKeyshops != null) {
      if (best == null || prices.currentKeyshops < best) {
        best = prices.currentKeyshops;
      }
    }
    return best != null ? best : Infinity;
  }

  /**
   * Get the acquisition price for an item (for sorting).
   */
  function getItemAcqPrice(item) {
    return item.acqPrice != null ? item.acqPrice : Infinity;
  }

  /**
   * Sort tradables list based on current sort mode.
   */
  function getSortedIndices() {
    const indices = tradablesList.map((_, i) => i);
    const dir = sortBy.endsWith('-desc') ? -1 : 1;
    const baseSort = sortBy.replace('-desc', '');

    indices.sort((a, b) => {
      if (baseSort === 'name') {
        return dir * (tradablesList[a].name || '').localeCompare(tradablesList[b].name || '');
      } else if (baseSort === 'price') {
        return dir * (getItemPrice(tradablesList[a]) - getItemPrice(tradablesList[b]));
      } else if (baseSort === 'acq') {
        return dir * (getItemAcqPrice(tradablesList[a]) - getItemAcqPrice(tradablesList[b]));
      }
      return 0;
    });
    return indices;
  }

  function render() {
    const sortedIndices = getSortedIndices();
    const filteredSorted = sortedIndices
      .filter(i => (tradablesList[i].name || '').toLowerCase().includes(searchQuery.toLowerCase()))
      .map(i => ({ ...tradablesList[i], _origIndex: i }));

    const sortOptions = [
      { value: 'name', label: 'Name A→Z' },
      { value: 'name-desc', label: 'Name Z→A' },
      { value: 'price', label: 'Price ↑' },
      { value: 'price-desc', label: 'Price ↓' },
      { value: 'acq', label: 'Acq. Price ↑' },
      { value: 'acq-desc', label: 'Acq. Price ↓' },
    ];

    const hasUndo = undoStack.length > 0;
    const lastUndo = undoStack[undoStack.length - 1];
    const undoLabel = lastUndo ? `Undo "${lastUndo.item.name}"` : 'Undo';

    container.innerHTML = `
      <div class="tradables-container">
        <div class="tradables-toolbar" style="margin-bottom:8px;">
          <input type="text" id="t-search" class="tradables-search" placeholder="Search tradables..." value="${escapeHtml(searchQuery)}">
          <select id="t-sort" class="tradables-sort" title="Sort by">
            ${sortOptions.map(opt => `<option value="${opt.value}" ${sortBy === opt.value ? 'selected' : ''}>${opt.label}</option>`).join('')}
          </select>
          <button id="t-refresh-btn" class="btn-primary" title="Refresh prices">↻ Refresh</button>
        </div>
        <div class="tradables-stats">
          <div class="stat-block">
            <span class="stat-value" id="t-total-count">${tradablesList.length}</span>
            <span class="stat-label">Games</span>
          </div>
          <div class="stat-block">
            <span class="stat-value" id="t-total-value">—</span>
            <span class="stat-label">Est. Value</span>
          </div>
          <div class="stat-block">
            <span class="stat-value" id="t-prices-count">0</span>
            <span class="stat-label">Priced</span>
          </div>
        </div>
        <div class="tradables-list" id="t-list"></div>
        <div class="tradables-footer">
          <div id="t-snapshots-section" style="display:none; margin-top:8px;">
            <div style="display:flex; gap:6px; align-items:center; margin-bottom:4px;">
              <button id="t-snapshot-create" class="btn-primary" style="font-size:9px; padding:3px 8px;">📸 Snapshot</button>
              <select id="t-snapshot-select" class="tradables-sort" style="flex:1; font-size:9px;">
                <option value="">No snapshots</option>
              </select>
              <button id="t-snapshot-restore" class="btn-primary" style="font-size:9px; padding:3px 6px; display:none;">Restore</button>
              <button id="t-snapshot-delete" class="btn-primary" style="font-size:9px; padding:3px 6px; background:#2a1a1a; border-color:#5a2a2a; color:#ff8888; display:none;">Delete</button>
            </div>
          </div>
          <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
            <button id="t-add-btn" class="btn-primary">+ Add Tradables</button>
            ${hasUndo ? `<button id="t-undo" class="btn-undo" title="${escapeHtml(undoLabel)}">↩ Undo</button>` : ''}
            <button id="t-delete-all" class="btn-danger" style="display:${tradablesList.length > 0 ? 'inline-block' : 'none'};">Delete All Tradables</button>
          </div>
        </div>
      </div>
    `;

    // Render list
    const listEl = container.querySelector('#t-list');
    if (filteredSorted.length === 0) {
      listEl.innerHTML = '<div class="tradables-empty">No tradables found.</div>';
    } else {
      listEl.innerHTML = filteredSorted.map((item, i) => {
        const itemPriceData = item.appId ? priceData[item.appId] : null;
        const priceBadge = renderPriceBadge(itemPriceData, settings, item);
        
        return `
          <div class="tradables-item" data-orig-index="${item._origIndex}" data-appid="${item.appId || ''}">
            <div class="tradables-item-main">
              <span class="tradables-name">${escapeHtml(item.name)}</span>
              ${item.qty > 1 ? `<span class="tradables-qty">x${item.qty}</span>` : ''}
              <div class="tradables-item-meta">
                ${item.appId
                  ? `<span class="tradables-appid">${item.type === 'bundle' ? 'Bundle' : item.type === 'sub' ? 'Sub' : 'App'} #${item.appId}</span>`
                  : `<span class="tradables-unresolved tradables-resolve-link" data-orig-index="${item._origIndex}" title="Click to search for this game">unresolved ↗</span>`
                }
                ${priceBadge}
              </div>
            </div>
            <div class="tradables-item-actions">
              <input type="number" class="tradables-acq-input" placeholder="Acq. ${currencySymbol}" step="0.01"
                value="${item.acqPrice != null ? item.acqPrice : ''}" data-orig-index="${item._origIndex}" title="Your acquisition price (optional)">
              <button class="tradables-remove" data-orig-index="${item._origIndex}" aria-label="Remove ${escapeHtml(item.name)}">×</button>
            </div>
          </div>
        `;
      }).join('');
    }

    // PHASE 2A: Prevent popup close on interaction
    container.addEventListener('mousedown', (e) => e.stopPropagation());
    container.addEventListener('click', (e) => e.stopPropagation());
    container.addEventListener('input', (e) => e.stopPropagation());
    container.addEventListener('change', (e) => e.stopPropagation());

    // Attach event listeners
    container.querySelector('#t-search').addEventListener('input', (e) => {
      e.stopPropagation();
      searchQuery = e.target.value;
      render();
    });

    container.querySelector('#t-sort').addEventListener('change', (e) => {
      e.stopPropagation();
      sortBy = e.target.value;
      render();
    });

    // PHASE 4C: Refresh prices button
    container.querySelector('#t-refresh-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = container.querySelector('#t-refresh-btn');
      btn.textContent = '↻ Loading…';
      btn.disabled = true;
      try {
        await fetchPrices({ refresh: true });
        render();
        updateStats();
      } catch (err) {
        console.error('Refresh failed:', err);
      }
      btn.textContent = '↻ Refresh';
      btn.disabled = false;
    });

    container.querySelector('#t-add-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (modal) modal.destroy();
      modal = createBulkImportModal(async ({ additions, increments }) => {
        for (const inc of increments ?? []) {
          if (tradablesList[inc.index]) {
            tradablesList[inc.index].qty = Math.max(1, parseInt(tradablesList[inc.index].qty) || 1) + inc.amount;
          }
        }
        tradablesList = [...tradablesList, ...(additions ?? [])];
        await save();
        await fetchPrices();
        render();
        updateStats();
      }, { existingTradables: tradablesList });
    });

    // Undo button (Phase 4D: ensure undo bar renders outside the loop)
    const undoBtn = container.querySelector('#t-undo');
    if (undoBtn) {
      undoBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (undoStack.length === 0) return;
        const lastDelete = undoStack.pop();
        // Restore item at its original position (or end of list)
        const restoreIdx = Math.min(lastDelete.index, tradablesList.length);
        tradablesList.splice(restoreIdx, 0, lastDelete.item);
        await save();
        render();
        updateStats();
        clearUndoTimeout();
      });
    }

    listEl.querySelectorAll('.tradables-remove').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const origIdx = parseInt(btn.dataset.origIndex);
        const item = tradablesList[origIdx];
        if (!item) return;

        // Push to undo stack
        undoStack.push({ item, index: origIdx });
        clearTimeout(undoTimeout);
        undoTimeout = setTimeout(() => {
          undoStack = [];
          render();
        }, 5000);

        tradablesList.splice(origIdx, 1);
        await save();
        render();
        updateStats();
      });
    });

    listEl.querySelectorAll('.tradables-acq-input').forEach(input => {
      input.addEventListener('change', async (e) => {
        e.stopPropagation();
        const origIdx = parseInt(input.dataset.origIndex);
        const item = tradablesList[origIdx];
        if (item) {
          item.acqPrice = input.value ? parseFloat(input.value) : null;
          await save();
          render();
          updateStats();
        }
      });
    });

    // Resolve unresolved games — click to search and pick a match
    listEl.querySelectorAll('.tradables-resolve-link').forEach(link => {
      link.addEventListener('click', async (e) => {
        e.stopPropagation();
        const origIdx = parseInt(link.dataset.origIndex);
        const item = tradablesList[origIdx];
        if (!item) return;

        // Build a tiny search popover
        const popover = document.createElement('div');
        popover.className = 'stpt-candidates';
        popover.style.minWidth = '260px';
        popover.innerHTML = `
          <div style="color:#888;font-size:9px;padding:3px 5px 5px;border-bottom:1px solid #1e1e2e;margin-bottom:3px;">
            Search for "${escapeHtml(item.name)}"
          </div>
          <div style="padding:5px;">
            <input type="text" class="tradables-resolve-search" placeholder="Search Steam..." value="${escapeHtml(item.name)}"
              style="width:100%;padding:4px 6px;border:1px solid #333;border-radius:3px;background:#1e1e2e;color:#cdd6f4;font-size:11px;box-sizing:border-box;">
          </div>
          <div class="tradables-resolve-results" style="max-height:150px;overflow-y:auto;"></div>
          <div class="stpt-cand-item stpt-cand-dismiss" style="margin-top:2px;">Cancel</div>
        `;

        // Position near the clicked link
        const rect = link.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        popover.style.position = 'absolute';
        popover.style.left = `${rect.left - containerRect.left}px`;
        popover.style.top = `${rect.bottom - containerRect.top + 4}px`;
        popover.style.zIndex = '9999';
        container.style.position = 'relative';
        container.appendChild(popover);

        const searchInput = popover.querySelector('.tradables-resolve-search');
        const resultsContainer = popover.querySelector('.tradables-resolve-results');

        searchInput.addEventListener('click', e2 => e2.stopPropagation());
        popover.addEventListener('click', e2 => e2.stopPropagation());

        let searchTimeout = null;
        const performSearch = async (query) => {
          resultsContainer.innerHTML = '<div style="padding:5px;color:#555;font-size:10px;">Searching...</div>';
          try {
            const results = await msg('SEARCH_STEAM', { query });
            resultsContainer.innerHTML = '';
            if (!results.items?.length) {
              resultsContainer.innerHTML = '<div style="padding:5px;color:#555;font-size:10px;">No results</div>';
              return;
            }
            results.items.forEach(r => {
              const resultItem = document.createElement('div');
              resultItem.className = 'stpt-cand-item';
              resultItem.innerHTML = `<span>${r.name}</span><span style="color:#555;font-size:9px;">App ${r.id}</span>`;
              resultItem.addEventListener('click', async () => {
                // Update the tradable with the new name and appId
                item.name = r.name;
                item.appId = String(r.id);
                item.type = r.type ?? 'app';
                await save();
                popover.remove();
                await fetchPrices();
                render();
                updateStats();
              });
              resultsContainer.appendChild(resultItem);
            });
          } catch {
            resultsContainer.innerHTML = '<div style="padding:5px;color:#f38ba8;font-size:10px;">Search failed</div>';
          }
        };

        searchInput.addEventListener('input', (e2) => {
          clearTimeout(searchTimeout);
          const query = e2.target.value.trim();
          if (query.length < 2) { resultsContainer.innerHTML = ''; return; }
          searchTimeout = setTimeout(() => performSearch(query), 300);
        });

        // Auto-search on open
        if (item.name && item.name.length >= 2) performSearch(item.name);

        popover.querySelector('.stpt-cand-dismiss').addEventListener('click', () => popover.remove());
        setTimeout(() => document.addEventListener('click', () => popover.remove(), { once: true }), 0);
        setTimeout(() => { searchInput.focus(); searchInput.select(); }, 0);
      });
    });

    // PHASE 4E: Delete All with double confirmation
    const deleteAllBtn = container.querySelector('#t-delete-all');
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Are you sure? This is going to delete your tradables list. This action is irreversible.')) return;
        if (!confirm('Are you really sure?')) return;
        tradablesList = [];
        await save();
        render();
        updateStats();
      });
    }

    // PHASE 1B: Snapshot UI
    const snapshotSection = container.querySelector('#t-snapshots-section');
    const snapshotSelect = container.querySelector('#t-snapshot-select');
    const snapshotRestoreBtn = container.querySelector('#t-snapshot-restore');
    const snapshotDeleteBtn = container.querySelector('#t-snapshot-delete');
    const snapshotCreateBtn = container.querySelector('#t-snapshot-create');

    async function loadSnapshots() {
      const snapshots = await msg('GET_TRADABLES_SNAPSHOTS');
      snapshotSelect.innerHTML = '<option value="">No snapshots</option>';
      if (snapshots && snapshots.length > 0) {
        for (const snap of snapshots) {
          const opt = document.createElement('option');
          opt.value = snap.id;
          opt.textContent = `${snap.label} (${snap.count} games)`;
          snapshotSelect.appendChild(opt);
        }
        snapshotSection.style.display = 'block';
      } else {
        snapshotSection.style.display = 'none';
      }
    }

    loadSnapshots();

    snapshotSelect.addEventListener('change', (e) => {
      e.stopPropagation();
      const hasSelection = snapshotSelect.value !== '';
      snapshotRestoreBtn.style.display = hasSelection ? 'inline-block' : 'none';
      snapshotDeleteBtn.style.display = hasSelection ? 'inline-block' : 'none';
    });

    snapshotCreateBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = `Snapshot ${new Date().toLocaleString()} (${tradablesList.length} games)`;
      await msg('SAVE_TRADABLES_SNAPSHOT', { label, tradables: tradablesList });
      loadSnapshots();
    });

    snapshotRestoreBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const snapId = snapshotSelect.value;
      if (!snapId) return;
      if (!confirm('Restore this snapshot? This will replace your current tradables list.')) return;
      await msg('RESTORE_TRADABLES_SNAPSHOT', { id: snapId });
      tradablesList = normalizeTradables(await msg('GET_TRADABLES'));
      render();
      updateStats();
      loadSnapshots();
    });

    snapshotDeleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const snapId = snapshotSelect.value;
      if (!snapId) return;
      if (!confirm('Delete this snapshot?')) return;
      await msg('DELETE_TRADABLES_SNAPSHOT', { id: snapId });
      loadSnapshots();
    });

    updateStats();
  }

  function updateStats() {
    const valueEl = container.querySelector('#t-total-value');
    const countEl = container.querySelector('#t-prices-count');
    
    if (!valueEl || !countEl) return;

    const pricedCount = tradablesList.filter(item => {
      if (!item.appId) return false;
      const data = priceData[item.appId];
      return data?.prices?.currentRetail != null || data?.prices?.currentKeyshops != null;
    }).length;

    countEl.textContent = pricedCount;

    if (!settings.apiKey) {
      valueEl.textContent = '—';
      valueEl.title = 'Add GG.deals API key in Settings to see estimated values';
      return;
    }

    const value = computeTotalValue();
    if (value) {
      // PHASE 4B: Use settings.currency for display
      const displayCurrency = settings.currency || 'EUR';
      const symbol = displayCurrency === 'USD' ? '$' : '€';
      valueEl.textContent = `${symbol}${(value.total / 100).toFixed(2)}`;
      valueEl.title = `Based on ${value.count} games with price data`;
    } else {
      valueEl.textContent = '—';
      valueEl.title = 'No price data available. Try refreshing.';
    }
  }

  // PHASE 1A: Save tradables to separate storage, not settings
  async function save() {
    await msg('SAVE_TRADABLES', { tradables: tradablesList });
  }

  // Listen for PRICE_UPDATED broadcasts (Phase 6B)
  const priceUpdatedListener = (message) => {
    if (message.type === 'PRICE_UPDATED' && message.appId && message.priceData) {
      const region = message.region || settings.regions?.[0];
      if (region && message.priceData) {
        priceData[message.appId] = message.priceData;
        render();
        updateStats();
      }
    }
  };
  chrome.runtime.onMessage.addListener(priceUpdatedListener);

  // Listen for SETTINGS_UPDATED — update currency and re-render
  const settingsUpdatedListener = (message) => {
    if (message.type !== 'SETTINGS_UPDATED') return;
    Object.assign(settings, message.settings);
    currency = settings.currency || 'EUR';
    currencySymbol = currency === 'USD' ? '$' : '€';
    render();
    updateStats();
  };
  chrome.runtime.onMessage.addListener(settingsUpdatedListener);

  // Initial: load cached prices first (fast, no API call), render immediately
  await loadCachedPrices();
  render();
  updateStats();

  // Then optionally refresh from API to get latest prices
  fetchPrices().then(() => {
    render();
    updateStats();
  }).catch(console.error);
}
