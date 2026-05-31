import { parseInput, classifyEntry, computeConfidence, parseSteamStoreUrl, hasBundleKeywords } from './tradables-parser.js';
import { normalizeTitle } from '../utils/similarity.js';

const CATEGORY_CONFIG = {
  exact: { label: 'Exact Matches', color: '#a1cd44', defaultChecked: true },
  appid: { label: 'App ID Resolved', color: '#66c0f4', defaultChecked: true },
  'fuzzy-auto': { label: 'Fuzzy Auto-Selected (≥90%)', color: '#f1c40f', defaultChecked: true },
  'fuzzy-manual': { label: 'Fuzzy Manual', color: '#e67e22', defaultChecked: true },
  notfound: { label: 'Not Found', color: '#e74c3c', defaultChecked: true }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildPreviewItemHtml(entry, idx, borderColor) {
  const tooltip = entry.confidence
    ? `Auto-selected: closest match for '${entry.raw}' → '${entry.matchedName}' (${entry.confidence}%)`
    : '';
  const safeTooltip = escapeHtml(tooltip);
  const safeName = escapeHtml(entry.matchedName || entry.raw);
  const safeAppId = escapeHtml(entry.appId ?? '');

  const showResolve = entry.category !== 'exact' && entry.category !== 'appid';
  const resolveBtn = showResolve
    ? `<button class="preview-resolve-btn" data-ri="${idx}" title="Resolve this game">↗ resolve</button>`
    : '';

  let bundleHint = '';
  const rawName = entry.raw || entry.matchedName || '';
  if (hasBundleKeywords(rawName)) {
    if (entry.category === 'notfound') {
      bundleHint = '<div class="preview-bundle-hint">💡 Paste the Steam bundle URL to resolve this item.</div>';
    } else if (entry.category === 'fuzzy-manual' || entry.category === 'fuzzy-auto') {
      bundleHint = '<div class="preview-bundle-hint preview-bundle-hint-soft">💡 This may be a bundle — consider pasting the Steam bundle URL for exact matching.</div>';
    }
  }

  return `
    <div class="preview-item" style="border-left: 3px solid ${borderColor};" title="${safeTooltip}">
      <input type="checkbox" class="preview-checkbox" data-index="${idx}" ${entry.checked ? 'checked' : ''}>
      <span class="preview-name">${safeName}</span>
      ${entry.appId ? `<span class="preview-appid">#${safeAppId}</span>` : ''}
      ${resolveBtn}
      ${bundleHint}
    </div>
  `;
}

export function categorizeSingle(entry) {
  let category;

  if (entry.status === 'hit' || entry.status === 'resolved') {
    category = 'exact';
  } else if (entry.status === 'appid-resolved') {
    category = 'appid';
  } else if (entry.status === 'ambiguous') {
    if (entry.confidence >= 90) {
      category = 'fuzzy-auto';
    } else {
      category = 'fuzzy-manual';
    }
  } else {
    category = 'notfound';
  }

  // PHASE 4F: All categories checked by default
  return {
    ...entry,
    category,
    checked: true,
    visible: true
  };
}

export function categorizeResults(resolvedEntries) {
  return resolvedEntries.map(entry => categorizeSingle(entry));
}

export function filterVisible(entries, activeFilters) {
  return entries.map(e => ({
    ...e,
    visible: activeFilters.has(e.category)
  }));
}

export function getAddCount(entries) {
  return entries.filter(e => e.checked && e.visible).length;
}

export function toggleAllVisible(entries, checked) {
  return entries.map(e =>
    e.visible ? { ...e, checked } : e
  );
}

export function getEntriesToAdd(entries, activeFilters) {
  return filterVisible(entries, activeFilters).filter(e => e.checked && e.visible);
}

function normalizeTradableType(type) {
  return String(type ?? 'app').trim().toLowerCase() || 'app';
}

function tradableKeys(item) {
  const keys = [];
  if (item.appId) {
    keys.push(`${normalizeTradableType(item.type)}:${item.appId}`);
  }
  const title = normalizeTitle(item.name ?? item.matchedName ?? item.raw ?? '');
  if (title) keys.push(`title:${title}`);
  return keys;
}

function tradableKey(item) {
  return tradableKeys(item)[0] ?? 'title:';
}

export function dedupeTradableEntries(entries) {
  const seen = new Set();
  const deduped = [];
  for (const entry of entries) {
    const key = tradableKey({ appId: entry.appId, type: entry.type, name: entry.matchedName || entry.raw });
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

export function findDuplicateTradables(entries, existingTradables) {
  const existingMap = new Map();
  (existingTradables ?? []).forEach((item, index) => {
    for (const key of tradableKeys(item)) {
      if (!existingMap.has(key)) existingMap.set(key, { item, index });
    }
  });
  return entries
    .map(entry => {
      const keys = tradableKeys({ appId: entry.appId, type: entry.type, name: entry.matchedName || entry.raw });
      const duplicate = keys.map(key => existingMap.get(key)).find(Boolean);
      return duplicate ? { entry, existing: duplicate.item, index: duplicate.index } : null;
    })
    .filter(Boolean);
}

export function prepareTradablesToAdd(entries, existingTradables, duplicateAction = 'skip') {
  const uniqueEntries = dedupeTradableEntries(entries);
  const duplicates = findDuplicateTradables(uniqueEntries, existingTradables);
  const duplicateKeys = new Set(duplicates.flatMap(d => tradableKeys(d.entry)));
  const additions = uniqueEntries
    .filter(entry => !tradableKeys({ appId: entry.appId, type: entry.type, name: entry.matchedName || entry.raw }).some(key => duplicateKeys.has(key)))
    .map(e => ({
      name: e.matchedName || e.raw,
      appId: e.appId,
      type: e.type ?? 'app',
      qty: 1,
    }));
  const increments = duplicateAction === 'increment'
    ? duplicates.map(d => ({ index: d.index, amount: 1, name: d.existing.name }))
    : [];
  return { additions, increments, duplicates };
}

/**
 * Resolve entries via background service worker.
 * Returns array of resolved entry objects.
 */
export async function resolveEntries(entries) {
  const appIdEntries = entries.filter(e => e.type === 'appId');
  const typedIdEntries = entries.filter(e => e.type === 'typedId');
  const nameEntries = entries.filter(e => e.type === 'name');

  const [appIdResults, typedIdResults, nameResults] = await Promise.all([
    resolveAppIds(appIdEntries),
    resolveTypedIds(typedIdEntries),
    resolveNames(nameEntries)
  ]);

  // Merge back in original order
  const results = [];
  let appIdx = 0;
  let typedIdx = 0;
  let nameIdx = 0;

  for (const entry of entries) {
    if (entry.type === 'appId') {
      results.push(appIdResults[appIdx++]);
    } else if (entry.type === 'typedId') {
      results.push(typedIdResults[typedIdx++]);
    } else {
      results.push(nameResults[nameIdx++]);
    }
  }

  return results;
}

async function resolveTypedIds(entries) {
  if (entries.length === 0) return [];

  const appEntries = entries.filter(e => e.itemType === 'app');
  const appResults = await resolveAppIds(appEntries);
  let appIdx = 0;

  return entries.map(entry => {
    if (entry.itemType === 'app') {
      const resolved = appResults[appIdx++] ?? {};
      return { ...resolved, raw: entry.raw ?? entry.value, type: 'app' };
    }
    const label = entry.itemType === 'bundle' ? 'Bundle' : 'Sub';
    return {
      raw: entry.raw ?? entry.value,
      status: 'appid-resolved',
      appId: entry.value,
      type: entry.itemType,
      matchedName: `Steam ${label} ${entry.value}`,
    };
  });
}

async function resolveAppIds(entries) {
  if (entries.length === 0) return [];

  return new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'RESOLVE_APP_IDS', appIds: entries.map(e => e.value) },
      resolve
    );
  });
}

async function resolveNames(entries) {
  if (entries.length === 0) return [];

  const results = await new Promise(resolve => {
    chrome.runtime.sendMessage(
      { type: 'RESOLVE_TITLES', titles: entries.map(e => e.value) },
      resolve
    );
  });

  // Normalize results: map resolver output to modal expected format
  return results.map((result, i) => {
    const raw = entries[i].value;
    
    // Handle fuzzy matches from resolver
    if (result.fuzzy && result.similarity) {
      return {
        raw,
        status: 'ambiguous', // Treat as ambiguous for confidence-based categorization
        appId: result.appId,
        type: result.type ?? 'app',
        matchedName: result.title || raw,
        confidence: result.similarity
      };
    }
    
    // Handle exact/resolved matches
    if (result.status === 'hit' || result.status === 'resolved') {
      return {
        raw,
        status: result.status,
        appId: result.appId,
        type: result.type ?? 'app',
        matchedName: result.title || raw
      };
    }
    
    // Handle ambiguous (multiple candidates)
    if (result.status === 'ambiguous') {
      return {
        raw,
        status: 'ambiguous',
        appId: null,
        matchedName: raw,
        confidence: 0,
        candidates: result.candidates
      };
    }
    
    // Handle not found and other cases
    return {
      raw,
      status: result.status || 'not-found',
      appId: result.appId || null,
      type: result.type ?? 'app',
      matchedName: result.title || raw
    };
  });
}

/**
 * Build the modal DOM and return control interface.
 */
export function createBulkImportModal(onAdd, options = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-dialog tradables-import-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-header">
        <h3 id="modal-title">Add Tradables</h3>
        <button class="modal-close" aria-label="Close">×</button>
      </div>
      <div class="modal-body">
        <div class="import-input-section">
          <label>Paste game names or Steam App IDs. Separate by commas or one per line.</label>
          <textarea id="bulk-input" rows="8" placeholder="Hollow Knight, 236850&#10;Celeste&#10;Stardew Valley, 1145360"></textarea>
          <div class="import-help-text">
            💡 For bundles (collections, packs, anthologies), paste the Steam bundle URL:<br>
            <code>https://store.steampowered.com/bundle/&lt;id&gt;/&lt;name&gt;/</code>
          </div>
          <button id="bulk-preview-btn" class="btn-primary">Preview Matches</button>
        </div>
        <div class="import-preview-section" id="preview-section" style="display:none;">
          <div class="preview-header">
            <span id="preview-summary">0 of 0 games ready to add</span>
            <div class="preview-header-actions">
              <button id="preview-select-all" class="btn-small">Select All</button>
              <button id="preview-deselect-all" class="btn-small">Deselect All</button>
            </div>
          </div>
          <div class="preview-filters" id="preview-filters"></div>
          <div class="preview-list" id="preview-list"></div>
          <div class="duplicate-warning" id="duplicate-warning" style="display:none;"></div>
          <div class="preview-actions">
            <button id="bulk-add-btn" class="btn-success">Add <span id="add-count">0</span> Tradables</button>
            <button id="bulk-cancel-btn" class="btn-secondary">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // PHASE 2A: Prevent popup close on interaction with modal elements
  overlay.addEventListener('mousedown', (e) => e.stopPropagation());
  overlay.addEventListener('click', (e) => e.stopPropagation());
  overlay.addEventListener('input', (e) => e.stopPropagation());
  overlay.addEventListener('change', (e) => e.stopPropagation());

  // Elements
  const closeBtn = overlay.querySelector('.modal-close');
  const cancelBtn = overlay.querySelector('#bulk-cancel-btn');
  const previewBtn = overlay.querySelector('#bulk-preview-btn');
  const addBtn = overlay.querySelector('#bulk-add-btn');
  const inputArea = overlay.querySelector('#bulk-input');
  const previewSection = overlay.querySelector('#preview-section');
  const previewList = overlay.querySelector('#preview-list');
  const previewSummary = overlay.querySelector('#preview-summary');
  const addCountSpan = overlay.querySelector('#add-count');
  const filtersContainer = overlay.querySelector('#preview-filters');
  const selectAllBtn = overlay.querySelector('#preview-select-all');
  const deselectAllBtn = overlay.querySelector('#preview-deselect-all');
  const duplicateWarning = overlay.querySelector('#duplicate-warning');

  let resolvedEntries = [];
  let submitting = false;
  // PHASE 4F: All 5 categories active by default
  let activeFilters = new Set(['exact', 'appid', 'fuzzy-auto', 'fuzzy-manual', 'notfound']);
  let currentPopover = null;

  function msg(type, data = {}) {
    return new Promise(resolve => chrome.runtime.sendMessage({ type, ...data }, resolve));
  }

  // Render filter checkboxes
  function renderFilters() {
    filtersContainer.innerHTML = Object.entries(CATEGORY_CONFIG).map(([key, config]) => `
      <label class="filter-label" style="border-left: 3px solid ${config.color}; padding-left: 6px;">
        <input type="checkbox" data-filter="${key}" ${activeFilters.has(key) ? 'checked' : ''}>
        ${config.label}
      </label>
    `).join('');

    filtersContainer.querySelectorAll('input[data-filter]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          activeFilters.add(cb.dataset.filter);
        } else {
          activeFilters.delete(cb.dataset.filter);
        }
        refreshPreview();
      });
    });
  }

  // Refresh preview list based on filters and state
  function refreshPreview() {
    if (currentPopover) {
      currentPopover.remove();
      currentPopover = null;
    }

    const filtered = filterVisible(resolvedEntries, activeFilters);
    const addCount = getAddCount(filtered);

    previewList.innerHTML = filtered.map((entry, idx) => {
      if (!entry.visible) return '';
      const config = CATEGORY_CONFIG[entry.category];
      return buildPreviewItemHtml(entry, idx, config.color);
    }).join('');

    // Re-attach checkbox listeners
    previewList.querySelectorAll('.preview-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const idx = parseInt(cb.dataset.index);
        resolvedEntries[idx].checked = cb.checked;
        refreshPreview();
      });
    });

    // Re-attach resolve button listeners
    previewList.querySelectorAll('.preview-resolve-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.ri);
        const entry = resolvedEntries[idx];
        if (!entry) return;
        showResolvePopover(btn, entry, idx);
      });
    });

    previewSummary.textContent = `${addCount} of ${resolvedEntries.length} games ready to add`;
    addCountSpan.textContent = addCount;
    addBtn.disabled = submitting || addCount === 0;
  }

  function showResolvePopover(anchor, entry, idx) {
    // Close existing popover
    if (currentPopover) {
      currentPopover.remove();
      currentPopover = null;
    }

    const popover = document.createElement('div');
    popover.className = 'preview-resolve-popover';

    const isBundle = entry.type === 'bundle';
    const bundleGuidance = isBundle ? `
      <div class="trp-bundle-guidance">
        <div class="trp-bundle-warning">⚠️ Bundles cannot be searched by name.</div>
        <div class="trp-bundle-help">Paste a Steam bundle URL to resolve:</div>
        <code class="trp-bundle-url">https://store.steampowered.com/bundle/&lt;id&gt;/&lt;name&gt;/</code>
        <a href="https://store.steampowered.com/search/?term=${encodeURIComponent(entry.raw || entry.matchedName || '')}" target="_blank" class="trp-bundle-search-link">Search on Steam ↗</a>
      </div>
    ` : '';

    popover.innerHTML = `
      <div class="trp-header">
        Search for "${escapeHtml(entry.matchedName || entry.raw)}"
      </div>
      ${bundleGuidance}
      <div class="trp-search-wrap">
        <input type="text" class="tradables-resolve-search" placeholder="Search Steam or paste URL..." value="${escapeHtml(entry.raw || entry.matchedName || '')}">
      </div>
      <div class="tradables-resolve-results"></div>
      <div class="trp-cancel">Cancel</div>
    `;

    anchor.parentNode.insertBefore(popover, anchor.nextSibling);
    currentPopover = popover;

    const searchInput = popover.querySelector('.tradables-resolve-search');
    const resultsContainer = popover.querySelector('.tradables-resolve-results');

    let searchTimeout = null;
    const performSearch = async (query) => {
      const steamUrl = parseSteamStoreUrl(query);
      if (steamUrl) {
        resultsContainer.innerHTML = '';
        const resultItem = document.createElement('div');
        resultItem.className = 'trp-result-item trp-url-result';
        const nameSpan = document.createElement('span');
        nameSpan.textContent = `Use ${steamUrl.type} ${steamUrl.id}`;
        const metaSpan = document.createElement('span');
        metaSpan.style.color = '#66c0f4';
        metaSpan.style.fontSize = '9px';
        metaSpan.textContent = steamUrl.type.charAt(0).toUpperCase() + steamUrl.type.slice(1);
        resultItem.append(nameSpan, metaSpan);
        resultItem.addEventListener('click', () => {
          applyResolve(idx, steamUrl.id, steamUrl.type);
        });
        resultsContainer.appendChild(resultItem);
        return;
      }

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
          resultItem.className = 'trp-result-item';
          const nameSpan = document.createElement('span');
          nameSpan.textContent = r.name ?? `App ${r.id}`;
          const metaSpan = document.createElement('span');
          metaSpan.style.cssText = 'color:#555;font-size:9px';
          const itemType = r.type === 'bundle' ? 'Bundle' : r.type === 'sub' ? 'Sub' : 'App';
          metaSpan.textContent = `${itemType} ${r.id}`;
          resultItem.append(nameSpan, metaSpan);
          resultItem.addEventListener('click', () => {
            applyResolve(idx, String(r.id), r.type ?? 'app', r.name);
          });
          resultsContainer.appendChild(resultItem);
        });
      } catch {
        resultsContainer.innerHTML = '<div style="padding:5px;color:#f38ba8;font-size:10px;">Search failed</div>';
      }
    };

    searchInput.addEventListener('input', (e2) => {
      clearTimeout(searchTimeout);
      const q = e2.target.value.trim();
      if (q.length < 2) { resultsContainer.innerHTML = ''; return; }
      searchTimeout = setTimeout(() => performSearch(q), 300);
    });

    if ((entry.raw || entry.matchedName || '').length >= 2) {
      performSearch(entry.raw || entry.matchedName);
    }

    popover.querySelector('.trp-cancel').addEventListener('click', () => {
      popover.remove();
      currentPopover = null;
    });
  }

  function applyResolve(idx, appId, type, name) {
    const entry = resolvedEntries[idx];
    if (!entry) return;
    entry.appId = appId;
    entry.type = type ?? 'app';
    if (name) entry.matchedName = name;
    entry.status = 'resolved';
    resolvedEntries[idx] = categorizeSingle(entry);
    if (currentPopover) {
      currentPopover.remove();
      currentPopover = null;
    }
    refreshPreview();
  }

  function setSubmitControlsDisabled(disabled) {
    addBtn.disabled = disabled;
    duplicateWarning.querySelectorAll('button').forEach(btn => { btn.disabled = disabled; });
  }

  // Event handlers
  closeBtn.addEventListener('click', destroy);
  cancelBtn.addEventListener('click', destroy);

  previewBtn.addEventListener('click', async () => {
    const raw = inputArea.value;
    const parsed = parseInput(raw);
    const classified = parsed.map(classifyEntry);

    previewBtn.disabled = true;
    previewBtn.textContent = 'Resolving...';

    try {
      const results = await resolveEntries(classified);
      resolvedEntries = categorizeResults(results);
      renderFilters();
      previewSection.style.display = 'block';
      refreshPreview();
    } catch (err) {
      alert('Error resolving games: ' + err.message);
    } finally {
      previewBtn.disabled = false;
      previewBtn.textContent = 'Preview Matches';
    }
  });

  selectAllBtn.addEventListener('click', () => {
    resolvedEntries = toggleAllVisible(resolvedEntries, true);
    refreshPreview();
  });

  deselectAllBtn.addEventListener('click', () => {
    resolvedEntries = toggleAllVisible(resolvedEntries, false);
    refreshPreview();
  });

  async function submitAdd(duplicateAction = null) {
    if (submitting) return;
    const toAdd = getEntriesToAdd(resolvedEntries, activeFilters);
    const prepared = prepareTradablesToAdd(toAdd, options.existingTradables ?? [], duplicateAction ?? 'skip');
    if (prepared.duplicates.length > 0 && duplicateAction == null) {
      duplicateWarning.style.display = 'block';
      duplicateWarning.innerHTML = `
        <div class="duplicate-title">Duplicate tradables found</div>
        <div class="duplicate-body">${prepared.duplicates.map(d => escapeHtml(d.existing.name || d.entry.raw)).join(', ')}</div>
        <div class="duplicate-actions">
          <button class="btn-small" id="dup-increment">Yes, increment quantity</button>
          <button class="btn-small" id="dup-skip">No, skip duplicates</button>
        </div>
      `;
      duplicateWarning.querySelector('#dup-increment').addEventListener('click', () => submitAdd('increment'));
      duplicateWarning.querySelector('#dup-skip').addEventListener('click', () => submitAdd('skip'));
      return;
    }
    submitting = true;
    setSubmitControlsDisabled(true);
    try {
      await onAdd(prepared);
      destroy();
    } finally {
      submitting = false;
      setSubmitControlsDisabled(false);
    }
  }

  addBtn.addEventListener('click', async () => submitAdd());

  // Focus trap and escape key
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') destroy();
  });

  function destroy() {
    // PHASE 4G: Refocus a safe element before removing overlay
    // This prevents Chrome from detecting "nothing focused in popup" and closing it
    const focused = document.activeElement;
    if (focused && focused.closest('.modal-overlay')) {
      // Find the nearest active tab content to refocus
      const activeTab = document.querySelector('.tab-content.active');
      if (activeTab) {
        activeTab.focus();
      } else {
        document.body.focus();
      }
    }
    overlay.remove();
  }

  return { destroy };
}
