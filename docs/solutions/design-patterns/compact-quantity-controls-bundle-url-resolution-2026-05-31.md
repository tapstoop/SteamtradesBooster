---
title: "Compact Quantity Controls and Bundle URL Resolution for Tradables UI"
date: 2026-05-31
category: design-patterns
module: "popup/tradables"
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Building compact form controls with limited horizontal space"
  - "Working with APIs that don't index certain entity types (e.g., bundles)"
  - "Displaying quantity-aware pricing in trade or inventory interfaces"
tags:
  - quantity-controls
  - bundle-resolution
  - steam-api
  - url-parsing
  - compact-ui
  - pricing-display
  - tradables-popup
---

# Compact Quantity Controls and Bundle URL Resolution for Tradables UI

> Historical note (17-07-2026): bundle URL resolution remains available as a deterministic fallback, but name-based bundle discovery is now supported. See `docs/steam-search-and-bundle-discovery.md` for the current architecture, limits, cache policy, and matching rules.

## Context

The tradables management popup needed three UI improvements:

1. **Quantity controls**: Users tracking multiple copies of games needed inline quantity adjustment, but the popup's constrained width made standard horizontal +/- buttons too bulky.

2. **Bundle resolution**: Steam's search API (`/api/storesearch/`) does not index bundles, collections, packs, or anthologies. When users manually type a bundle name (e.g., "Asterix & Obelix XXL Collection"), automatic resolution fails because no official API exists to map bundle names to bundle IDs. GG.deals also lacks a name-based search endpoint for bundles.

3. **Quantity-aware display**: Price calculations and header statistics needed to account for quantities to provide accurate portfolio valuations.

## Guidance

### Pattern A: Compact Quantity Control (Vertical Stack)

**HTML Structure** (`popup/tradables.js:457-461`):
```javascript
<div class="tradables-qty" data-orig-index="${item._origIndex}">
  <button class="tradables-qty-arrow tradables-qty-up" data-orig-index="${item._origIndex}" aria-label="Increase quantity">▲</button>
  <input type="number" min="1" max="999" class="tradables-qty-input" value="${item.qty ?? 1}" data-orig-index="${item._origIndex}" title="Quantity">
  <button class="tradables-qty-arrow tradables-qty-down" data-orig-index="${item._origIndex}" aria-label="Decrease quantity">▼</button>
</div>
```

**CSS Layout** (`popup/tradables.css:206-253`):
```css
.tradables-qty {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
  margin-right: 6px;
  gap: 0;
}

.tradables-qty-arrow {
  background: none;
  border: none;
  color: #4a6a8a;
  font-size: 7px;
  line-height: 1;
  padding: 1px 0;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}
.tradables-qty-arrow:hover {
  color: #66c0f4;
}

.tradables-qty-input {
  width: 24px;
  -moz-appearance: textfield;
  -webkit-appearance: none;
  appearance: none;
  background: #0d1117;
  border: none;
  border-radius: 2px;
  padding: 1px 0;
  color: #c6d4df;
  font-size: 11px;
  font-family: monospace;
  text-align: center;
  line-height: 1;
}
/* Hide native spin buttons */
.tradables-qty-input::-webkit-inner-spin-button,
.tradables-qty-input::-webkit-outer-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
```

**Event Handlers** (`popup/tradables.js:590-622`):
```javascript
// Arrow button clicks
listEl.querySelectorAll('.tradables-qty-arrow').forEach(btn => {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const origIdx = parseInt(btn.dataset.origIndex);
    const item = tradablesList[origIdx];
    if (!item) return;
    const delta = btn.classList.contains('tradables-qty-up') ? 1 : -1;
    let qty = (item.qty ?? 1) + delta;
    if (qty < 1) qty = 1;
    if (qty > 999) qty = 999;
    item.qty = qty;
    await save();
    render();
    updateStats();
  });
});

// Direct input changes
listEl.querySelectorAll('.tradables-qty-input').forEach(input => {
  input.addEventListener('change', async (e) => {
    e.stopPropagation();
    const origIdx = parseInt(input.dataset.origIndex);
    const item = tradablesList[origIdx];
    if (!item) return;
    let qty = parseInt(input.value) || 1;
    if (qty < 1) qty = 1;
    if (qty > 999) qty = 999;
    input.value = qty;
    item.qty = qty;
    await save();
    render();
    updateStats();
  });
});
```

### Pattern B: Bundle URL Detection

**parseSteamUrl Helper** (`popup/tradables.js:673-686`):
```javascript
const parseSteamUrl = (input) => {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    if (host !== 'store.steampowered.com' && host !== 'steampowered.com' && !host.endsWith('.steampowered.com')) {
      return null;
    }
    const match = url.pathname.match(/^\/(app|bundle|sub)\/(\d+)(?:\/|$)/);
    if (!match) return null;
    return { type: match[1], id: match[2] };
  } catch {
    return null;
  }
};
```

**URL Detection in Search** (`popup/tradables.js:689-714`):
```javascript
const performSearch = async (query) => {
  // Check if query is a Steam URL
  const steamUrl = parseSteamUrl(query);
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
    resultItem.addEventListener('click', async () => {
      item.appId = steamUrl.id;
      item.type = steamUrl.type;
      await save();
      popover.remove();
      await fetchPrices();
      render();
      updateStats();
    });
    resultsContainer.appendChild(resultItem);
    return;
  }
  // ... normal search continues
};
```

### Pattern C: Bundle Guidance UI (Conditional Popover Content)

**Bundle Keyword Detection** (`popup/tradables.js:15-19`):
```javascript
const BUNDLE_KEYWORDS = /\b(collection|bundle|pack|package|anthology|trilogy|quadrilogy)\b/i;

function hasBundleKeywords(name) {
  return BUNDLE_KEYWORDS.test(name);
}
```

**Conditional Guidance Rendering** (`popup/tradables.js:636-644`):
```javascript
const isBundle = hasBundleKeywords(item.name);
const bundleGuidance = isBundle ? `
  <div class="trp-bundle-guidance">
    <div class="trp-bundle-warning">⚠️ Bundles cannot be searched by name.</div>
    <div class="trp-bundle-help">Paste a Steam bundle URL to resolve:</div>
    <code class="trp-bundle-url">https://store.steampowered.com/bundle/&lt;id&gt;/&lt;name&gt;/</code>
    <a href="https://store.steampowered.com/search/?term=${encodeURIComponent(item.name)}" target="_blank" class="trp-bundle-search-link">Search on Steam ↗</a>
  </div>
` : '';
```

### Pattern D: Quantity-Aware Price Display

**Price Badge with Quantity Suffix** (`popup/tradables.js:71-74`):
```javascript
const qty = item?.qty ?? 1;
const qtySuffix = qty > 1 && bestCurrent != null
  ? `<span class="tradables-qty-suffix"> x ${qty} = ${formatPrice(bestCurrent * qty, currency)}</span>`
  : '';
```

**Header Stats with Quantity** (`popup/tradables.js:412-414`):
```javascript
<span class="stat-value" id="t-total-count">${tradablesList.reduce((sum, item) => sum + (item.qty ?? 1), 0)}</span>
<span class="stat-label" id="t-total-count-label">Games ${tradablesList.length !== tradablesList.reduce((sum, item) => sum + (item.qty ?? 1), 0) ? `<span class="stat-unique">(${tradablesList.length} unique)</span>` : ''}</span>
```

## Why This Matters

**API Limitations Require UX Workarounds:**
When technical solutions don't exist (Steam doesn't index bundles), the only path forward is guiding users to provide the data manually. Clear, contextual guidance prevents frustration and support requests.

**Compact UI in Constrained Spaces:**
Chrome extension popups have limited real estate. The vertical stacked arrow design (24px wide) saves horizontal space while remaining usable, allowing more room for game names and metadata.

**Quantity-Aware Calculations Prevent Confusion:**
Users tracking multiple copies need to see both per-unit and total values. Showing "€10 x 3 = €30" in the price badge and "15 games (12 unique)" in the header makes the data model transparent.

**Defensive URL Parsing:**
The `parseSteamUrl` function validates hostname and path structure, preventing false positives from unrelated URLs while supporting all Steam item types (app, bundle, sub).

## When to Apply

**Use compact vertical quantity controls when:**
- UI space is constrained (popups, sidebars, mobile)
- Users need quick increment/decrement without typing
- Direct numeric input is still valuable for large quantities
- Native spin buttons are visually inconsistent across browsers

**Use bundle keyword detection when:**
- Your system cannot automatically resolve certain item types
- Users can manually provide identifiers (URLs, IDs)
- You want to proactively guide users before they encounter errors
- The keyword list is stable and domain-specific

**Use URL parsing for manual resolution when:**
- Official APIs don't support name-based search
- Users can easily find URLs from the source platform
- You want to bypass API limitations without scraping
- The URL structure is stable and well-defined

**Use quantity-aware display when:**
- Items can have quantities > 1
- Users need to see both unit and aggregate values
- Portfolio/collection valuation is a core feature
- Header stats must reflect actual inventory counts

## Examples

### Before: No Bundle Guidance
```javascript
// User clicks "unresolved ↗" on "Asterix & Obelix XXL Collection"
popover.innerHTML = `
  <div class="trp-header">
    Search for "${escapeHtml(item.name)}"
  </div>
  <div class="trp-search-wrap">
    <input type="text" class="tradables-resolve-search" placeholder="Search Steam..." value="${escapeHtml(item.name)}">
  </div>
  <div class="tradables-resolve-results"></div>
  <div class="trp-cancel">Cancel</div>
`;
// Search returns 0 results, user is confused
```

### After: Bundle-Aware Guidance
```javascript
const isBundle = hasBundleKeywords(item.name);
const bundleGuidance = isBundle ? `
  <div class="trp-bundle-guidance">
    <div class="trp-bundle-warning">⚠️ Bundles cannot be searched by name.</div>
    <div class="trp-bundle-help">Paste a Steam bundle URL to resolve:</div>
    <code class="trp-bundle-url">https://store.steampowered.com/bundle/&lt;id&gt;/&lt;name&gt;/</code>
    <a href="https://store.steampowered.com/search/?term=${encodeURIComponent(item.name)}" target="_blank" class="trp-bundle-search-link">Search on Steam ↗</a>
  </div>
` : '';

popover.innerHTML = `
  <div class="trp-header">
    Search for "${escapeHtml(item.name)}"
  </div>
  ${bundleGuidance}
  <div class="trp-search-wrap">
    <input type="text" class="tradables-resolve-search" placeholder="Search Steam or paste URL..." value="${escapeHtml(item.name)}">
  </div>
  <div class="tradables-resolve-results"></div>
  <div class="trp-cancel">Cancel</div>
`;
// User sees clear guidance, can search on Steam or paste URL
```

### Before: Horizontal Quantity Controls (Bulky)
```html
<!-- Hypothetical earlier design -->
<div class="tradables-qty-horizontal">
  <button class="qty-btn">-</button>
  <input type="number" value="1" class="qty-input">
  <button class="qty-btn">+</button>
</div>
```
```css
.tradables-qty-horizontal {
  display: flex;
  flex-direction: row;
  gap: 4px;
  width: 80px; /* Too wide for compact rows */
}
```

### After: Vertical Stacked Arrows (Compact)
```html
<div class="tradables-qty">
  <button class="tradables-qty-arrow tradables-qty-up">▲</button>
  <input type="number" class="tradables-qty-input" value="1">
  <button class="tradables-qty-arrow tradables-qty-down">▼</button>
</div>
```
```css
.tradables-qty {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 24px; /* 70% narrower */
}
.tradables-qty-arrow {
  font-size: 7px; /* Tiny triangles */
  padding: 1px 0;
}
.tradables-qty-input {
  width: 24px;
  font-size: 11px;
  text-align: center;
}
```

## Related

- GitHub Issue #10: ✨ Prevent duplicate tradable entries with quantity prompt
- GitHub Issue #11: ✨ Add Steam Bundle price support with automatic App vs Bundle detection
- `docs/plans/2026-05-31-003-fix-bundle-resolution-limitation-plan.md` - Original plan documenting the Steam API limitation
