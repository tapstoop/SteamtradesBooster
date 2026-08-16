---
title: All Page Games Workstation Architecture
date: "2026-08-16"
module: content/progressive-page, content/ui-workstation, content/ui-components, content/parser
category: architecture
problem_type: implementation_reference
tags:
  - all-page-games
  - workstation
  - progressive-rendering
  - virtual-list
  - title-resolution
  - performance
  - chrome-mv3
---

# All Page Games Workstation Architecture

## Purpose

This document describes the architecture of the **All Page Games** column in the SteamTrades workstation. It explains where its data comes from, how it stays synchronized with progressive page resolution, how rendering is kept bounded on large lists, and which interaction and lifecycle guarantees future changes must preserve.

All Page Games is a view over the trade page's existing progressive row state. It is not a separate parser, resolver, profile loader, or price-fetching pipeline. This distinction prevents the workstation from duplicating network requests or keeping an independent version of page data.

For the surrounding badge and provider architecture, also see:

- `docs/progressive-badge-architecture.md` for page parsing, cache hydration, title resolution, profile reconciliation, and pricing;
- `docs/badge-architecture.md` for full trade-page badge composition and priority;
- `docs/dynamic-wishlist-refresh-architecture.md` for the Manifest V3 profile and cache lifecycle.

## User-Facing Scope

The All Page Games column provides:

- a virtualized list of games parsed from the page's `have` section;
- search by resolved or original title;
- title and price sorting;
- compact filters for every compact badge state;
- optional display of the original SteamTrades title;
- direct navigation from a listed title to its source row;
- manual resolution entry points for ambiguous, not-found, and fuzzy results;
- compact Wishlist, Tradables, removal, and resolution badges;
- adding eligible games to the trade simulator.

Dismissed rows are removed from the list. Decorative separator-only lines are rejected by the parser before they can become page rows. A user can still dismiss an unusual false positive manually from the resolution UI.

## Component Responsibilities

| Component | Responsibility |
| --- | --- |
| `content/parser.js` | Parses SteamTrades `have` and `want` rows, cleans titles, rejects decorative/non-game content, and returns page row objects. |
| `content/progressive-page.js` | Owns the authoritative page-local row state, progressive run lifecycle, profile/tier reconciliation, resolution, pricing, and workstation synchronization. |
| `content/progressive-resolution.js` | Resolves unresolved titles in bounded batches without owning DOM or workstation state. |
| `content/ui-workstation.js` | Owns workstation UI state, filtering, sorting, simulator state, targeted section rendering, navigation, and picker entry points. |
| `content/ui-components.js` | Builds compact rows and badges and provides the virtual-list primitive. |
| `content/ui-pickers.js` | Displays candidate, not-found, and fuzzy resolution popovers. |
| `content/content-handlers.js` | Applies manual resolution and runtime updates through a stable workstation bridge. |
| `styles/content.css` | Defines the compact visual language, filter menu, destructive dismiss action, fixed pickers, and jump highlight. |

## Data Ownership

### Authoritative page rows

`startProgressivePage()` parses the DOM once and creates `state.rows`. Each row receives a stable `stptId` and retains its original DOM element for the lifetime of the page run.

The page row is the authority for:

- `originalTitle` and the current resolved `title`;
- typed Steam identity (`appId` and `type`);
- `resolution`, `resolutionStatus`, `cacheKey`, candidates, fuzzy state, and similarity;
- Wishlist and Tradables membership and the derived tier;
- page section (`have` or `want`);
- Steam Tracker removal state;
- cached or fetched price data;
- the source DOM element.

Progressive work mutates these stable rows. It does not replace the row collection or create workstation-only resolution objects.

### Workstation projection

`toWorkstationGame(row, settings)` converts a page row into the smaller shape needed by the UI. The projection includes `stptId` and `el`, so navigation and manual resolution remain attached to the correct source row even when titles are duplicated.

`SidebarWorkstation.pageGames` is a UI projection, not durable state. `chrome.storage` and the service worker remain authoritative for persistent profile, resolution, removal, and price caches.

The workstation also owns interaction-only state that does not belong in page rows:

- search and sort values;
- active compact-badge filters;
- whether original titles are shown;
- collapsed and resized layout preferences;
- games currently placed in the simulator;
- pending render flags and the virtual-list viewport.

## Startup and Runtime Flow

```text
SteamTrades DOM
      |
      v
parseGameRows() -> stable state.rows with stptId and source element
      |
      +----> skeletons and page badges
      |
      +----> cache/profile/resolution/price pipeline
      |             |
      |             v
      |       mutate authoritative rows
      |             |
      |             v
      |       syncWorkstationRows(changed rows only)
      |             |
      v             v
ensureWorkstation() -> toWorkstationGame() -> SidebarWorkstation patches
                                              |
                                              v
                                   one targeted render per frame
                                              |
                                              v
                                      virtualized visible rows
```

The first `setPageGames()` call is a complete snapshot because the workstation needs an initial index and initial sections. Later progressive results use patches keyed by `stptId`.

Profile, title-resolution, removal, and price operations continue to use the page's shared progressive pipeline. Opening All Page Games does not issue its own `GET_PROFILE`, `RESOLVE_TITLES`, removal, or GG.deals request.

## Lazy Workstation Lifecycle

Workstation construction is controlled by `settings.showSidebar`:

- when `showSidebar` is false at startup, the workstation is not constructed;
- badge processing may still run when an API key enables page badges;
- when the setting changes to true, `ensureWorkstation()` creates the workstation and snapshots the latest authoritative rows and Tradables;
- when the setting changes back to false, the existing workstation is hidden rather than destroyed, preserving simulator and UI state;
- updates received while hidden mutate workstation state but defer DOM rendering;
- showing it again flushes the latest pending render state.

Manual-resolution and runtime handlers receive a stable bridge rather than the current instance. The bridge delegates to `state.workstation` when it exists. This lets handlers bind once at startup while still supporting a workstation created later by a settings update.

`destroy()` is responsible for final UI cleanup: it cancels pending workstation frames, destroys the virtual list, removes global filter listeners, clears jump highlighting, and removes the workstation element.

## Progressive Synchronization

`syncWorkstationRows(state, run, rows)` is the only normal progressive page-to-workstation patch path. It:

1. exits immediately when no workstation exists;
2. deduplicates changed rows by `stptId`;
3. projects only those rows through `toWorkstationGame()`;
4. calls `updateResolvedPageGames()` once for the group.

The workstation builds `_pageGameIndex`, a `stptId -> array index` map, when it receives the initial snapshot. Patches therefore update the affected entries without scanning or rebuilding the full `pageGames` array.

State changes are synchronous. Rendering is deferred. Code handling a completed batch can immediately observe the updated game identity, tier, price, or resolution state even though DOM work is coalesced until the next animation frame.

When the same `stptId` appears more than once in one patch group, the latest patch wins. Unknown IDs are ignored. A patch copies only the fields listed in `WORKSTATION_PATCH_FIELDS`, preventing unrelated or unsafe properties from being merged into UI state.

If a game already in the simulator is patched, its simulator copy is updated too. A dismissed row or a row that loses its usable AppID is removed from the simulator so stale or non-simulatable entries cannot remain selected.

## Targeted Render Scheduling

The workstation has independently dirty render sections:

- `data` for All Page Games;
- `wishlist` for the page Wishlist summary;
- `tradables` for the Tradables summary;
- `inTrade` for selected simulator rows;
- `sim` for simulator totals and difference.

`_requestRender()` merges dirty flags into `_pendingRender` and schedules at most one animation frame. `_flushPendingRender()` renders only the marked sections.

Examples:

- a plain page-row resolution patches All Page Games only;
- a Wishlist membership change also updates the Wishlist section;
- a Tradables update renders the Tradables section without rebuilding All Page Games;
- a price update for a selected simulator game also updates selected rows and totals;
- several resolution batches finishing within one frame cause one DOM pass with their combined final state.

When the workstation is hidden, dirty flags accumulate but no frame is scheduled. This avoids background DOM work while preserving the state needed for the next `show()`.

## Virtual List

All Page Games uses `createVirtualList()` rather than inserting every matching row into the DOM.

The virtual list:

- stores the complete filtered and sorted item array;
- calculates a visible index window from `scrollTop`, container height, and item height;
- absolutely positions only visible rows inside a correctly sized inner element;
- coalesces item, height, scroll, resize, and refresh requests into one calculation per frame;
- preserves or resets scroll explicitly according to the caller's intent;
- clamps scroll when filtering makes the list shorter;
- uses `ResizeObserver` when available;
- falls back to zero-delay timers when animation-frame APIs are unavailable in tests;
- cancels pending work and disconnects the observer on `destroy()`.

The row height changes between compact and dual-title modes. `setItemHeight()` is a no-op when the requested height is already active, preventing redundant viewport calculations.

Progressive patches preserve the current list scroll. Direct search, sort, filter, or display-option changes can intentionally rebuild the view from the top.

## Compact Badges and Filters

`COMPACT_BADGE_FILTERS` is the shared definition for the filter menu. It includes:

- Wishlist (`W`);
- Tradables (`T`);
- delisted (`D`);
- purchase disabled (`P`);
- banned (`B`);
- resolution pending (`…`);
- ambiguous resolution (`?`);
- not found (`N/A`);
- fuzzy match (`≈`, including its similarity when available);
- resolution failure (`ERR`).

Compact badges reuse the semantic color families of the larger trade-page badges. Their short labels reduce visual density without changing the meaning of a state. Accessible names and titles provide the expanded meaning.

Multiple active filters use **OR semantics**: a game is visible when it has at least one selected badge state. With no active filter, all non-dismissed `have` games are visible. A game may expose multiple filter keys, such as Wishlist plus Banned.

Removal badges are suppressed for fuzzy identities until the fuzzy result has been confirmed. This prevents an uncertain title match from presenting a removal classification as authoritative.

## Navigation and Resolution Pickers

Every listed game title is a navigation control, regardless of whether the game has a compact badge. Navigation uses `stptId` and the retained source element, not title text, so duplicate titles remain unambiguous.

On navigation the workstation:

1. closes the filter menu;
2. restarts the source-row highlight, even when the target is already near the previous target and no visible scroll movement occurs;
3. scrolls the source row to the center;
4. respects `prefers-reduced-motion` by disabling smooth scrolling.

Disconnected source elements fail safely and do not trigger a scroll or picker.

Interactive resolution badges stop event propagation, so opening a picker is distinct from clicking the title. Candidate, not-found, and fuzzy pickers are dynamically imported only when required. After import, the workstation re-reads the current row and resolution descriptor before opening the picker; stale, disconnected, or superseded requests are ignored.

Workstation pickers use fixed positioning next to the clicked badge. The page may scroll to the source row first, but the popover does not move with that page scroll after it opens.

## Parsing and Non-Game Lines

All Page Games consumes `parseGameRows()` output and never parses text independently.

The parser removes supported list prefixes and decorative borders while preserving legitimate punctuation inside game titles. A candidate without any Unicode letter or number is decoration-only and is rejected. This covers long separators made from `=`, box-drawing characters, or similar formatting symbols before they can appear in the workstation or enter title resolution.

When decoration surrounds actual text, sufficiently long decorative borders are removed and the remaining title is evaluated normally. Ambiguous content is kept when structure indicates a plausible game row; automatic rejection must remain conservative because a false negative would hide a real tradable game entirely.

The manual **Not a game — dismiss** action remains available for residual false positives. It is styled as a prominent destructive action because it removes the item from the working list and stores a dismissed resolution state; it does not delete the original SteamTrades page content.

## Run and Staleness Guards

The workstation inherits the progressive page's lifecycle protections:

- each page run has a sequence, resolution session ID, and profile request ID;
- `isCurrent(state, run)` rejects work from cancelled or superseded runs;
- profile generations reject progress from an older profile refresh;
- each row has a revision used to reject stale manual rechecks;
- disconnected DOM elements are not mutated;
- cache clearing cancels observers and the coordinator, resets rows, and starts a new run;
- delayed picker imports revalidate their token, row, anchor, and current descriptor.

These guards are required because Chrome MV3 responses, profile broadcasts, manual actions, and intersection events may finish in a different order from the one in which they started.

## Performance Guarantees

Future changes should preserve these properties:

1. All Page Games must not create a second fetch or resolution pipeline.
2. Initial construction may take one complete snapshot; progressive updates must remain keyed patches.
3. State must be updated synchronously before rendering is scheduled.
4. Multiple updates in one frame must produce at most one render per affected section.
5. Hidden or disabled workstation UI must not perform unnecessary DOM work.
6. Only viewport rows should exist in the All Page Games DOM.
7. Tradables or profile updates must not rebuild unrelated sections.
8. Event listeners, observers, timers, and animation frames must be cleaned up on destruction.
9. Rendering optimizations must not change GG.deals request policy, queue limits, cache semantics, or title-resolution batch limits.

The resolver continues to use batches of eight titles with at most two outstanding batches. Viewport and tier priority remain owned by the progressive page coordinator, not by the virtual list.

## Expected Scenarios

### Happy path

1. The page is parsed and stable rows receive IDs.
2. The workstation receives an immediate snapshot when enabled.
3. Cached states appear first.
4. Progressive resolution and price batches patch only changed rows.
5. The active search, filters, sort, scroll, and simulator selection remain stable.
6. Clicking a title highlights and reveals the corresponding SteamTrades row.

### Sidebar disabled at startup

Badges continue loading when enabled by settings, but no workstation DOM is created. Enabling the sidebar later creates it from the latest page-row state rather than restarting parsing or fetching.

### Sidebar hidden during updates

State and simulator identities remain current, no hidden DOM render occurs, and reopening flushes the latest combined state once.

### Rapid progressive batches

All patches apply synchronously. Dirty sections are merged and rendered once on the next frame. The final UI reflects the latest patch for each `stptId`.

### Duplicate titles

Rows remain distinct through `stptId`. Navigation, highlighting, resolution, and price patches target the correct source row.

### Ambiguous game

Clicking the `?` badge navigates to the source row, waits for scrolling to settle, revalidates the state, and opens a fixed candidate picker beside the workstation badge.

### Decorative Unicode or symbol line

The parser rejects a line without letters or numbers. It never becomes a resolution request, compact row, or dismissible false game.

### Cache clear or stale response

The old run is cancelled, pending page results are ignored, rows reset, and the new run progressively repopulates the same workstation projection.

## Test Coverage

The architecture is covered at three levels:

- parser unit tests cover decorative lines, border cleanup, Unicode titles, and legitimate punctuation;
- component and workstation unit tests cover compact filters, badge behavior, virtual-list coalescing and destruction, indexed patches, targeted rendering, hidden updates, navigation highlights, and fixed picker behavior;
- E2E regression tests cover full-page integration, interactive resolution, filters, navigation, and lazy sidebar creation through live settings changes.

When changing this architecture, run:

```bash
npm test
npm run test:e2e
npm run build:chrome
npm run build:firefox
```

Add a regression test whenever a change affects row identity, filter semantics, progressive patching, hidden-state behavior, navigation, picker anchoring, or render scheduling.

## Maintenance Checklist

Before extending All Page Games, verify:

- Is the new fact already available on the authoritative page row?
- Can it be added to `toWorkstationGame()` and `WORKSTATION_PATCH_FIELDS` instead of introducing another read or request?
- Which render sections actually depend on the fact?
- Does the update preserve `stptId`, source element, current scroll, and simulator identity?
- Does a compact badge need a matching filter definition, accessible name, and established color family?
- Can the UI be created after the fact when `showSidebar` changes?
- What happens if the row disconnects, the run is cancelled, or a newer patch arrives first?
- Are pending frames, observers, timers, and document listeners cleaned up?

The default design choice should be to extend the shared progressive row projection and targeted render flags. A workstation-specific data pipeline should be introduced only if the data is genuinely unrelated to trade-page state and cannot be supplied by the existing service-worker contracts.
