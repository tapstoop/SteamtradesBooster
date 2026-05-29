import { parseInput, classifyEntry, computeConfidence } from './tradables-parser.js';
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
  return `
    <div class="preview-item" style="border-left: 3px solid ${borderColor};" title="${safeTooltip}">
      <input type="checkbox" class="preview-checkbox" data-index="${idx}" ${entry.checked ? 'checked' : ''}>
      <span class="preview-name">${safeName}</span>
      ${entry.appId ? `<span class="preview-appid">#${safeAppId}</span>` : ''}
    </div>
  `;
}

export function categorizeResults(resolvedEntries) {
  return resolvedEntries.map(entry => {
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
  });
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
  const duplicates = findDuplicateTradables(entries, existingTradables);
  const duplicateKeys = new Set(duplicates.flatMap(d => tradableKeys(d.entry)));
  const additions = entries
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
  const nameEntries = entries.filter(e => e.type === 'name');

  const [appIdResults, nameResults] = await Promise.all([
    resolveAppIds(appIdEntries),
    resolveNames(nameEntries)
  ]);

  // Merge back in original order
  const results = [];
  let appIdx = 0;
  let nameIdx = 0;

  for (const entry of entries) {
    if (entry.type === 'appId') {
      results.push(appIdResults[appIdx++]);
    } else {
      results.push(nameResults[nameIdx++]);
    }
  }

  return results;
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
  // PHASE 4F: All 5 categories active by default
  let activeFilters = new Set(['exact', 'appid', 'fuzzy-auto', 'fuzzy-manual', 'notfound']);

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

    previewSummary.textContent = `${addCount} of ${resolvedEntries.length} games ready to add`;
    addCountSpan.textContent = addCount;
    addBtn.disabled = addCount === 0;
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
    addBtn.disabled = true;
    try {
      await onAdd(prepared);
      destroy();
    } finally {
      addBtn.disabled = false;
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
