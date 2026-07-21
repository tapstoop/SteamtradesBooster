---
title: Trade Page Badge Architecture
date: "2026-07-18"
module: content/parser, content/content, content/ui-badges, content/ui-pickers, content/content-handlers
category: architecture
problem_type: implementation_reference
tags:
  - badges
  - content-script
  - steamtrades
  - ggdeals
  - resolution
  - pricing
  - chrome-mv3
---

# Trade Page Badge Architecture

## Goal

This document describes how SteamTrades Booster classifies, composes, renders, and updates badges on SteamTrades game rows.

Badges combine several independent facts:

- whether the game is on the user's Steam Wishlist;
- whether it is in the user's Tradables list;
- whether GG.deals reports it in a bundle;
- whether its current price is close to its all-time low (ATL);
- whether title resolution is pending, uncertain, dismissed, or not found;
- whether steam-tracker.com classifies the row title or resolved app as delisted, purchase-disabled, or banned;
- the selected region, keyshop preference, cached timestamp, and Steam entity type.

The central rule is that priority chooses the **primary presentation**, not necessarily the only visible label. Normal resolved games may display one full primary badge followed by compact secondary badges.

## Ownership

### `content/parser.js`

The parser discovers game rows in `.have` and `.want`, cleans titles, records the section, and assigns profile tiers through `prioritize()`. Steam Store and SteamDB identities are preserved only as disambiguation hints; rows without links use the same Steam Tracker title index.

Current tier assignment is exclusive:

- Tier 1: exact or fuzzy Wishlist match;
- Tier 2: exact or fuzzy Tradables match, only when the row was not Tier 1;
- Tier 4: neither Wishlist nor Tradables.

There is no active Tier 3 assignment. Because Wishlist matching is checked first, a title found in both collections is Tier 1 and receives `WISH`, not both `WISH` and `TRADE`.

### `content/content.js`

The content entry point owns the page-level lifecycle:

- reads settings, exclusions, and profile data;
- parses and prioritizes rows;
- injects skeletons;
- resolves titles to typed Steam identities;
- handles special resolution statuses;
- reads cached prices and bundle information;
- schedules remote prices according to selective/automatic mode;
- sends complete row context to the badge renderer;
- keeps the workstation synchronized.

### `content/ui-badges.js`

This module owns badge composition and DOM construction:

- `injectSkeleton()` and `setSkeletonLoading()` represent pending work;
- `resolveBadges()` converts price and row facts into ordered badge descriptors;
- `replaceBadge()` atomically replaces the normal badge set;
- dedicated injectors render ambiguous, fuzzy, not-found, and dismissed states;
- `resolveBadgeType()` remains as a backward-compatible primary-badge-only helper.

### `content/ui-pickers.js`

Badge clicks dynamically load picker/popover behavior. This module owns candidate selection, manual Steam search, dismissal controls, acquisition-price editing, and manual price refresh.

### `content/content-handlers.js`

Testable handlers apply manual resolutions and react to `SETTINGS_UPDATED` and `PRICE_UPDATED`. They guard settings revisions and regions so an older asynchronous price response cannot repaint newer state.

### `styles/content.css`

CSS owns badge colors, primary/secondary sizing, timestamp presentation, skeleton animation, and picker layout. Secondary badges use `data-secondary="1"`; their price element is hidden so only the compact label remains visible.

## Row Inputs

Normal badge composition receives `priceData` plus a `gameInfo` object. The important fields are:

| Field | Meaning |
| --- | --- |
| `appId` | Steam entity ID represented as a string |
| `type` | Typed identity: `app`, `sub`, or `bundle` |
| `title` | Current resolved/display title |
| `originalTitle` | Original parsed SteamTrades title |
| `tier` | Exclusive profile tier used for `WISH` or `TRADE` |
| `inBundle` | True for a Steam bundle entity or a game with bundle history |
| `resolution` | Resolver result and status metadata |
| `removal` | Optional read-only steam-tracker.com classification; same-status duplicate titles may carry it without an AppID |
| `cacheKey` | Resolution cache identity used by manual actions |
| `settings` | Regions, keyshop preference, deal threshold, timestamp preference |
| `acqPrice` | Optional acquisition price used by the popover/workstation |

`priceData.prices` may contain:

- `currentRetail`;
- `currentKeyshops`;
- `historicalRetail`;
- `historicalKeyshops`;
- `currency`.

`priceData.cachedAt` supplies the timestamp shown on the primary badge.

## End-to-End Badge Flow

```text
SteamTrades DOM
      |
      v
parse row and clean title
      |
      v
classify Tier 1 / Tier 2 / Tier 4 from profile
      |
      v
inject static or loading skeleton
      |
      v
resolve title to app/sub/bundle
      |
      +---- uncertain/special status ----> dedicated status badge
      |
      v
read cached or remote GG.deals price and bundle data
      |
      v
resolveBadges(priceData, gameInfo)
      |
      v
replaceBadge(): one primary + zero or more secondary badges
      |
      v
click opens picker/popover; later settings/price messages may rerender
```

Resolution and pricing are separate stages. A row can have a known Steam identity without a price, and a missing price does not erase Wishlist, Tradables, or bundle classification.

## Primary and Secondary Badges

For a normally resolved row, `resolveBadges()` collects every applicable label and orders the resulting descriptors.

Primary priority is:

```text
REMOVAL > DEAL > WISH > TRADE > BUNDLE > plain/NA
```

The primary badge shows its label when applicable, the formatted price, and the cache timestamp. Other applicable labels remain visible as compact secondary badges without duplicated price or timestamp text.

Examples:

| Facts | Primary badge | Secondary badges |
| --- | --- | --- |
| Banned, Deal, Wishlist | `BANNED` | `DEAL`, `WISH` |
| Purchase-disabled and Tradable | `NO PURCHASE` | `TRADE` |
| Deal, Wishlist, bundle history | `DEAL` | `WISH`, `BUNDLE` |
| Wishlist and bundle history | `WISH` | `BUNDLE` |
| Tradable and bundle history | `TRADE` | `BUNDLE` |
| Deal and Tradable | `DEAL` | `TRADE` |
| Bundle history only | `BUNDLE` | none |
| Price only | plain price | none |
| No price or labels | `N/A` | none |

`WISH` and `TRADE` are mutually exclusive under the current single-tier model. This is a classification rule in `prioritize()`, not a general limitation of the multi-badge renderer.

`BUNDLE` and `DEAL` are independent of the tier and may coexist with the tier label. A typed Steam bundle also sets bundle state even when no separate bundle-history lookup is available.

## Price and DEAL Calculation

When keyshops are disabled, the current and historical retail values are used. When keyshops are enabled, the renderer chooses the lower available value from retail and keyshops independently for current price and historical ATL.

The current implementation considers a row a deal when both values exist, ATL is greater than zero, and:

```text
((bestCurrent - bestATL) / bestCurrent) * 100 <= dealThresholdPct
```

The default threshold is 10 percent. A `DEAL` primary badge renders the current price followed by `· ATL`.

When no current price exists, `formatPrice()` produces the unavailable display and normal composition falls back to an `NA` primary when no label applies. Tier/bundle labels can still be primary even when their accompanying price is unavailable.

Only the primary badge shows `cachedAt`. `showFullTimestamp` selects between the full timestamp and the compact timestamp with the full value in a tooltip.

## Resolution and Removal Status Badges

Resolution/status badges are distinct from the normal multi-label composition path.

| State | Rendering | Interaction |
| --- | --- | --- |
| Static skeleton | Neutral, non-animated placeholder | Waiting or intentionally deferred |
| Loading skeleton | Animated placeholder | Active resolution or price fetch |
| `ambiguous` | `?` and `ambiguous ▾` | Opens candidate picker |
| Fuzzy | `≈` and similarity percentage | Opens fuzzy-match explanation/actions |
| `not-found` | Clickable `N/A ▾` | Opens manual Steam search |
| `dismissed` | Dimmed `×` | Clears dismissal and dispatches `stpt-recheck` |
| steam-tracker category 1 | Red `DELISTED`, optionally with price | Read-only upstream fact; opens the normal priced popover |
| steam-tracker category 3 | Orange `NO PURCHASE`, optionally with price | Read-only upstream fact; opens the normal priced popover |
| steam-tracker category 20 | Dark red `BANNED`, optionally with price | Read-only upstream fact; opens the normal priced popover |

Uncertain resolution states use `injectQuestionBadge()`, `injectFuzzyBadge()`, `injectNotFoundBadge()`, or `injectDismissedBadge()` instead of `resolveBadges()`. Removal facts participate in normal `resolveBadges()` composition because they must preserve and reorder price/tier/bundle labels.

Uncertain resolution states are exclusive row states. A fuzzy match is not decorated until the user confirms a stable Steam identity. Every normal or special transition removes the complete old badge/skeleton set, preventing stale secondary labels.

The normal no-price `NA` and the resolution `not-found` badge share `data-type="NA"`, but their behavior differs: normal `NA` displays `N/A`, while not-found displays `N/A ▾` and opens resolution controls.

## DOM Contract

`replaceBadge()` removes all existing `.stpt-skeleton` and `.stpt-badge` children from the row before creating the new descriptor set. For each badge it writes:

- `data-type` for visual type and behavior;
- `data-appid` for the Steam identity;
- `data-item-type` for `app`, `sub`, or `bundle`;
- `data-secondary="1"` for compact secondary labels.

All user-controlled titles and values are inserted with DOM text nodes or `textContent`; badge rendering does not inject title HTML.

Badge clicks stop propagation so they do not trigger unrelated row controls. Normal badges dynamically import `ui-pickers.js` and open a price popover. The popover verifies that its anchor is still connected and still represents the same typed Steam identity before applying asynchronous refresh results.

`replaceBadge()` returns the primary DOM element for compatibility. Code that needs the complete logical set should use `resolveBadges()` rather than `resolveBadgeType()`.

## Update Paths

### Initial rendering

The progressive page lifecycle parses stable rows first, hydrates cached resolution/pricing facts, and applies completed resolver batches independently. Steam Tracker refresh begins concurrently and never gates Steam title resolution, profile work, GG.deals pricing, or the first badge paint.

### Selective pricing

In selective mode, rows receive checkboxes. The user chooses which resolved rows should fetch prices, including removed rows even when automatic removed-game fetching is disabled. Successful results call `replaceBadge()` with current row, bundle, price, and settings state. Completed rows are unchecked; unresolved or failed rows remain selected, and the floating button shows success, partial, timeout, or error feedback.

### Automatic pricing

Tier 1 and Tier 2 rows are fetched first. Resolved Tier 4 rows are observed with an `IntersectionObserver` and fetched when they enter the configured margin.

### Manual resolution

Candidate selection or manual search updates the row's typed identity before price requests. `handleManualResolution()` then replaces the resolution badge, updates the workstation identity, and renders the normal badge set with the available price.

Manual recheck currently has a separate path in `content.js`. Any refactor must keep it behaviorally aligned with `handleManualResolution()` and the normal renderer.

### Settings changes

`SETTINGS_UPDATED` can change region, keyshop behavior, timestamp formatting, and deal threshold. Resolved rows read cached prices or fetch the new region and call `replaceBadge()` again. A settings revision guard prevents an older response from clearing or repainting state created by a newer settings update.

### Price broadcasts

`PRICE_UPDATED` finds rows by typed identity. When older senders omit the type, it falls back to App ID matching for backward compatibility. Matching rows are rerendered and corresponding workstation prices are updated.

### Steam Tracker reconciliation

`GET_REMOVAL_STATUSES` is cache-only and batches typed identities. A separate `ENSURE_STEAM_TRACKER_DATA` refresh updates the durable global cache; when its revision changes, `STEAM_TRACKER_UPDATED` asks each active page to reconcile its current rows. A late removal fact calls `replaceBadge()` with the row's existing price/tier/bundle state, so the removal badge becomes primary and applicable badges move right as secondaries without flicker or data loss.

The extension ships a generated, reviewed baseline snapshot, then accepts a remote replacement only after the [Steam Tracker security pipeline](./progressive-badge-architecture.md#steam-tracker-data-security-and-cache-lifecycle). A refused update leaves the last safe snapshot active and creates one dismissible alert in the extension popup. Provider strings are always inserted with `textContent`; neither the feed nor the alert can inject markup.

## Dynamic Profile and Badge Reconciliation

Any progressive profile/badge implementation must preserve the complete row state and recompute the full descriptor set rather than editing one label in isolation.

The required rules are:

- cached or progressive Wishlist presence may promote a row to Tier 1 immediately;
- absence from an incomplete profile must not remove `WISH`;
- only a successful complete profile may authoritatively remove Wishlist membership;
- Tradables removals require a valid storage-backed Tradables read;
- only rows whose tier or bundle/deal inputs changed should rerender;
- targeted row changes should be coalesced into one browser paint and one batched workstation patch;
- a new primary must preserve every still-applicable secondary badge;
- a bundled row promoted to Wishlist becomes primary `WISH` plus secondary `BUNDLE`;
- if that row is also a deal, `DEAL` remains primary and `WISH` plus `BUNDLE` remain secondary;
- title resolution and cached price state must not be discarded merely because tier changed;
- request IDs, generations, row revisions, settings revisions, and `CACHE_CLEARED` must reject stale async continuations.

This reuses the async-run principles from `docs/dynamic-wishlist-refresh-architecture.md`, but not its popup-specific transactional card cache. Trade-page DOM state is ephemeral; durable resolution, profile, and price data remain service-worker/cache responsibilities.

## Manifest V3 Boundaries

The content script owns row DOM and badge rendering. The service worker owns API access, durable caches, rate limiting, and broadcasts. Badge correctness must not depend on a persistent service-worker module variable because the worker may suspend between messages.

Content-side row state may live in memory for the lifetime of the page. Anything that must survive page reload, popup close, browser restart, or service-worker suspension belongs in `chrome.storage.local` through an existing background message contract.

## Failure and Safety Rules

- Profile failure must not corrupt stored Wishlist or Tradables data.
- A Tradables storage error must not be interpreted as an authoritative empty list.
- Missing GG.deals data renders a controlled unavailable state and must not erase resolution identity.
- Rate-limited pricing should preserve a known cached badge or show an explicit rate-limit state instead of an indefinite active skeleton.
- Late settings, profile, resolution, price, and removal responses must not repaint newer state.
- Steam Tracker facts apply only to confirmed typed `app` identities; bundles, subs, fuzzy matches, disconnected rows, and identities changed during the request are ignored.
- App IDs alone are not globally unique; all price and update paths should preserve `app`/`sub`/`bundle` type.
- Unsafe or malformed titles remain text and never become executable DOM.
- Badge clicks must not trigger checkbox, workstation, or parent-row actions.

## Reference Tests

The relevant test areas are:

- parser tier assignment and title cleanup;
- `resolveBadges()` primary/secondary combinations;
- missing-price and timestamp behavior;
- ambiguous, fuzzy, not-found, dismissed, and automatic removal interactions;
- typed App/Sub/Bundle identity propagation;
- manual-resolution row and workstation synchronization;
- `SETTINGS_UPDATED` revision/region stale-response guards;
- `PRICE_UPDATED` typed matching;
- selective and automatic fetch behavior;
- dynamic reconciliation preserving secondary labels;
- cache-clear, tracker-generation, row-identity, and profile-generation races;
- Chrome and Firefox extension builds after content/style changes.

## Maintenance Rules

- Treat `resolveBadges()` as the source of truth for normal badge composition.
- Say **primary badge priority**, not merely badge priority; secondary labels can coexist.
- Do not hand-edit one normal badge label when row facts change. Recompute the complete descriptor set.
- Preserve typed identity, original title, cache key, resolution status, and known price data across rerenders.
- Keep normal composition separate from uncertain/manual resolution states, but make state transitions remove the complete previous set.
- Add new independent labels as secondary-capable descriptors and define their primary ordering explicitly.
- Batch repeated row/workstation updates on large pages.
- Keep the dynamic import boundary between badge rendering and picker UI unless the architecture is intentionally changed.
