---
title: Dynamic Wishlist, Tradables, and MV3 Cache Refresh Architecture
date: "2026-07-16"
module: popup/deals, popup/tradables, popup/tradables-detailed, background/service-worker
category: architecture
problem_type: implementation_reference
tags:
  - chrome-mv3
  - wishlist
  - ggdeals
  - steam
  - cache
  - rate-limiting
  - popup
  - service-worker
---

# Dynamic Wishlist, Tradables, and MV3 Cache Refresh Architecture

## Goal

This document describes the architecture used to make Wishlist, Tradables, and Clear Cache flows reliable in a Chrome Manifest V3 extension.

The main problems addressed were:

- stale async responses rewriting UI or storage after a cache clear;
- old wishlist caches reappearing during an incomplete refresh;
- wishlist loading losing progressive state when the popup is closed or reopened;
- GG.deals prices being applied only after the full Steam wishlist had finished loading;
- GG.deals 429 responses being shown as generic unavailable prices;
- users with long wishlists missing API-limit warnings because they were visible only on individual cards;
- Tradables quantity mutations being lost or leaving stale views visible;
- concurrent or obsolete Steam searches rendering incorrect results.

The core rule is simple: durable data lives in `chrome.storage.local`, while currently active service-worker and popup operations are coordinated with epochs, tokens, request IDs, and sequence guards.

## Responsibilities

### Background service worker

The service worker is the authority for:

- Chrome runtime messages;
- `chrome.storage.local` access;
- Steam API calls;
- GG.deals API calls;
- cache writes;
- broadcasts to popup and content scripts.

Because MV3 can suspend the service worker, in-memory state is used only to coordinate currently running work. Durable state must be persisted.

Important mechanisms:

- a lifecycle barrier around `CLEAR_CACHE`;
- one shared storage write lock;
- refresh tokens for wishlist cache transactions;
- progressive wishlist messages;
- broadcasts such as `CACHE_CLEARED`, `TRADABLES_UPDATED`, and `GGDEALS_RATE_LIMITED`.

### Popup Wishlist

`popup/deals.js` owns the Wishlist user experience:

- rendering an authoritative complete cache immediately;
- rendering progressively while Steam and GG.deals calls are still running;
- persisting non-authoritative partial cards;
- committing the final complete cache;
- keeping `Refresh prices` and `Reload wishlist` as separate actions.

The Wishlist view should not fall back to an empty loading state when cards are already known for the current refresh.

### Popup Tradables

`popup/tradables.js` and `popup/tradables-detailed.js` share consistency rules:

- visible Tradables mutations are saved immediately;
- only one visible mutation is allowed at a time;
- the service worker broadcasts `TRADABLES_UPDATED` after each write;
- Tradables Detailed preloads and updates without waiting for the user to click the tab.

## Clear Cache Lifecycle Barrier

`CLEAR_CACHE` is a global lifecycle operation.

The service worker:

1. closes admission for new operations;
2. increments the lifecycle epoch;
3. invalidates coalesced profile runs;
4. cancels active Steam searches;
5. resets the Steam scheduler;
6. waits for already admitted operations to drain;
7. clears non-preserved storage;
8. reopens admission;
9. broadcasts `CACHE_CLEARED`.

Messages received during a clear wait for the clear to finish, then run as new post-clear work.

Preserved user data includes:

- settings;
- GG.deals API key;
- Steam ID;
- Tradables;
- Tradables snapshots;
- acquisition data;
- refresh options.

The complete wishlist cache and secondary price/resolution caches are not preserved by `CLEAR_CACHE`.

## Transactional Wishlist Cache

The historical storage key is still `deals_cards_cache`. It now represents either a complete authoritative wishlist cache or an incomplete refresh marker.

The transaction is structured by two messages:

- `BEGIN_DEALS_REFRESH`
- `COMMIT_DEALS_REFRESH`

An incomplete marker contains:

- `profileComplete: false`
- `cacheIdentity`
- `refreshToken`
- `startedAt`
- optional `previousComplete`
- optional `partialCards`
- optional `partialSavedAt`

A complete cache contains:

- `profileComplete: true`
- `cacheIdentity`
- `cards`
- `savedAt`
- `failedAppIds`

Rules:

- only `COMMIT_DEALS_REFRESH` writes an authoritative complete cache;
- `UPDATE_DEALS_REFRESH_PROGRESS` stores only non-authoritative partial cards;
- commits verify both `cacheIdentity` and `refreshToken`;
- an older refresh cannot replace a newer refresh;
- an incomplete profile never produces a complete cache.

The storage key should eventually be renamed from `deals_cards_cache` to `wishlist_cards_cache`, but that migration is intentionally separate from the concurrency fixes.

## Progressive Wishlist Rendering

The popup keeps an active wishlist run for the whole Steam -> resolution -> price -> commit pipeline.

The run tracks:

- `sequence`
- `requestId`
- `generation`
- `cacheIdentity`
- `refreshToken`
- `phase`
- `cancelled`
- `settings`
- `sortMode`
- `progressCardsByTitle`
- `progressCardsByAppId`
- `progressPriceKeys`

Main phases:

- `steam-loading`
- `resolving`
- `pricing`
- `complete`

The run is not destroyed immediately after `GET_PROFILE`. This ensures:

- switching tabs does not lose cards already received;
- closing and reopening the popup can rehydrate partial cards;
- the `resolving` phase does not fall back to a blank `Loading wishlist...` screen;
- Steam and GG.deals links appear as soon as the required data exists;
- GG.deals prices are applied chunk by chunk.

## Refresh Prices vs Reload Wishlist

The two Wishlist buttons intentionally do different work.

### Refresh prices

`Refresh prices` is a lightweight price refresh:

- does not reload Steam;
- does not rebuild the wishlist;
- uses the currently displayed list;
- calls GG.deals for prices according to the cache/stale policy;
- does not start a new transactional wishlist cache refresh.

### Reload wishlist

`Reload wishlist` is a full forced rebuild:

- ignores the cached Steam wishlist;
- ignores existing partial cards;
- calls `GET_PROFILE` with `forceRefresh: true`;
- skips `GET_CACHED_RESOLUTIONS`;
- calls `RESOLVE_TITLES` for the full wishlist with `forceRefresh: true`;
- skips `GET_CACHED_PRICES`;
- calls `REFRESH_PRICES` for all resolved App IDs;
- persists partial cards while loading;
- commits the new complete cache at the end.

The final result of `Reload wishlist` becomes the latest authoritative wishlist cache.

## GG.deals Rate Limiting and Progressive Prices

The Steam wishlist API and the GG.deals API are separate APIs with separate rate limits.

The correct pipeline is:

1. Steam returns a batch of games;
2. the popup renders those cards immediately;
3. titles are resolved to Steam App IDs;
4. GG.deals is called for resolved games;
5. prices are applied as soon as they arrive;
6. partial cards are persisted;
7. the final commit replaces the complete cache.

GG.deals calls remain governed by the rate limiter. On a 429 or known local quota wait, the service worker broadcasts:

- `GGDEALS_RATE_LIMITED`

The popup marks affected cards with:

- `priceStatus: { type: "rate-limited", resetAt }`

Card-level rendering shows:

- `GG.deals API limit reached — resets at HH:MM`

or, when the reset time is unknown:

- `GG.deals API limit reached — retrying shortly`

The Wishlist summary also derives a global warning from the same card state and displays it next to the count, for example:

- `76 games on wishlist — 6 with prices — GG.deals API limit reached — resets at 14:24`

During progressive loading, the warning is appended without hiding the current loading phase, for example:

- `12 games received — 6 with prices — GG.deals API limit reached — resets at 14:24 — loading...`

This keeps the warning visible for long wishlists without requiring the user to scroll to a specific affected card. When prices later arrive for affected cards, `priceStatus` is cleared and the global warning disappears automatically.

## Tradables and Tradables Detailed

Tradables are treated as sensitive durable data.

Principles:

- `SAVE_TRADABLES` writes immediately through the service worker;
- quantities are no longer saved through a fragile debounce;
- visible mutations disable controls until confirmation;
- on failure, the UI restores the last confirmed list;
- after saving, the service worker broadcasts `TRADABLES_UPDATED`.

Tradables Detailed:

- does not reload unnecessarily on every tab click;
- preloads in the background when Tradables change;
- renders progressively if the user opens the tab during loading;
- shows an immediate empty state when the Tradables list is empty;
- links to the Tradables tab to guide the user.

## Cancellable Steam Searches

Steam searches use a `requestId` contract.

Messages:

- `SEARCH_STEAM { query, requestId }`
- `CANCEL_STEAM_SEARCH { requestId }`

The service worker coalesces identical searches while keeping subscribers separate.

Rules:

- each keystroke invalidates the previous search immediately;
- cancellation aborts the network only when the final subscriber disappears;
- cancelled or obsolete responses are ignored;
- `CLEAR_CACHE` cancels all active searches;
- UIs verify the input value, local counter, and connected DOM container after each `await`.

## Strict Tradables Reads for Profiles

The Tradables read path used by `GET_PROFILE` distinguishes:

- missing key;
- valid list;
- malformed data;
- storage read error.

On a storage read error:

- `GET_PROFILE` returns `storageError: true`;
- no valid empty profile is produced;
- the content script does not enrich the page with misleading classifications;
- popup views show the real error.

This prevents games from being reclassified as non-tradable because of a transient storage failure.

## Important Invariants

- An older refresh can never overwrite a newer refresh.
- An incomplete cache is never authoritative.
- Clear cache cancels late writes and stale renders.
- An incomplete profile never produces a complete wishlist cache.
- `Refresh prices` never reloads Steam.
- `Reload wishlist` forces Steam, resolution, and GG.deals without using secondary caches.
- Prices already received stay visible during GG.deals waits.
- GG.deals API-limit states are explicit both on cards and in the Wishlist summary.
- Durable data must survive MV3 suspension through `chrome.storage.local`.

## Reference Tests

The test suite covers:

- concurrent cache clearing;
- stale refresh tokens;
- incomplete caches being non-authoritative;
- progressive Wishlist rendering;
- tab switching during loading;
- popup close/reopen during refresh;
- partial card persistence;
- GG.deals 429 states on cards and in the Wishlist summary;
- forced Wishlist reload without resolution or price cache reads;
- immediate Tradables mutations;
- `TRADABLES_UPDATED` broadcasts;
- cancellable Steam searches;
- Chrome and Firefox builds;
- targeted Playwright regression scenarios when Chromium can launch.

## Watch Points

- `deals_cards_cache` is a historical name and should later migrate to `wishlist_cards_cache`.
- Several popup functions still use `deals` naming; a future refactor should rename these symbols toward `wishlist`.
- Resolution and price caches are useful for normal refreshes, but must not be used by `Reload wishlist`.
- The GG.deals rate limiter must not be bypassed; the UI should explain waits instead of hiding them.
