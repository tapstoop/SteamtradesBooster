---
title: Progressive Trade-Page Badge Architecture
date: "2026-07-18"
module: content/progressive-page, content/progressive-resolution, background/service-worker, background/diagnostics
category: architecture
problem_type: performance_and_lifecycle
tags:
  - badges
  - progressive-rendering
  - title-resolution
  - wishlist
  - large-lists
  - chrome-mv3
---

# Progressive Trade-Page Badge Architecture

## Purpose

This document describes how SteamTrades Booster progressively resolves and renders badges on large trade pages. It complements `docs/badge-architecture.md`, which remains the reference for badge composition, primary/secondary priority, visual states, and interaction behavior.

The main objective is simple: a page with 50 or 100 games must not wait for every profile, title, and price operation before showing its first useful badge. Cached information appears first, uncached titles are resolved in small batches, and each completed batch updates only the rows it affects.

## Why the Previous Startup Was Slow

The former content-script startup was organized as one long asynchronous chain:

```text
settings and exclusions
        |
        v
wait for complete profile
        |
        v
parse rows and inject skeletons
        |
        v
wait for one full-page RESOLVE_TITLES request
        |
        v
resolve and price the user's other tradables
        |
        v
read cached prices and acquisition prices
        |
        v
start normal badge rendering and remote pricing
```

This created several blocking barriers:

- No row parsing or skeleton appeared until `GET_PROFILE` finished. A slow Steam Wishlist refresh therefore delayed the entire page.
- Every page title was sent in one `RESOLVE_TITLES` request. The first row could not render until the slowest title in the full list completed.
- Sidebar-only tradables work was awaited before page pricing, even though it was not required to render visible page rows.
- Acquisition prices were requested with sequential `await` calls. The latency of each Tier 2 row was added to the next.
- Large all-at-once responses caused broad DOM and workstation updates rather than small targeted patches.

The price viewport observer was already progressive, but it could not help until the blocking profile and title-resolution stages had completed.

## Architectural Principles

The progressive implementation follows these rules:

1. Create stable page-row state before starting slow profile or network work.
2. Render cache-derived information immediately.
3. Resolve uncached titles in bounded, independent batches.
4. Let completed work update its rows without waiting for unrelated rows.
5. Treat partial profile information as positive evidence only.
6. Preserve resolved identity and known prices when a row's tier changes.
7. Reject results from cancelled or superseded page runs.
8. Keep remote pricing policy unchanged: progressive title resolution must not silently increase GG.deals API usage.

## Runtime Flow

```text
settings/exclusion gate
        |
        v
parse DOM rows, assign stable stptId values
        |
        +----> inject static skeletons, checkboxes, workstation placeholders
        |
        v
start one page run with request/session identity
        |
        +----> cached profile + Tradables ------> provisional tiers
        |
        +----> cached resolution states --------> immediate status/identity badges
        |
        +----> GET_PROFILE + WISHLIST_PROGRESS -> dynamic tier reconciliation
        |
        v
enqueue unresolved titles by priority
        |
        v
resolve batches (8 titles, at most 2 messages outstanding)
        |
        +----> apply each result to stable row objects
        +----> read cached prices/bundles for the completed batch
        +----> patch affected badges and workstation rows together
        |
        v
remote prices according to selective/automatic policy
```

The content entry point remains deliberately small. `content/content.js` starts the page orchestrator, `content/progressive-page.js` owns the page lifecycle, and `content/progressive-resolution.js` owns the title queue without owning DOM or Chrome APIs.

## Stable Row State

Rows are parsed early and receive a permanent `stptId`. Each row keeps its original SteamTrades title and DOM element while resolution, tier, badge, and price fields are filled progressively.

Important invariants are:

- `originalTitle` is never discarded when a canonical Steam title arrives;
- resolution mutates the existing row object rather than replacing the row;
- the row retains its typed Steam identity (`app`, `sub`, or `bundle`);
- a tier change does not trigger title resolution again;
- checkbox and workstation identity remain attached to the stable `stptId`;
- disconnected DOM rows are not mutated by late callbacks.

This stable state is page-local and ephemeral. Durable profile, resolution, and price data remain owned by the service worker and its storage-backed caches, which is required for Manifest V3 worker suspension.

## Cache-First Hydration

Startup reads independent cached sources concurrently:

- `GET_CACHED_PROFILE` supplies cached or in-progress Wishlist positives;
- `GET_TRADABLES` supplies the storage-backed Tradables list;
- `GET_CACHED_RESOLUTION_STATES` supplies input-aligned resolution results, including confirmed, fuzzy, dismissed, delisted, ambiguous, hit, and resolved states;
- cached prices and bundle information are read as soon as a batch has typed Steam identities.

Cache hits are applied immediately and are marked hydrated in the coordinator, so they are never sent through remote resolution again. A known badge remains visible while fresher work runs; it is not replaced by a blank loading spinner.

## Resolution Coordinator

`ProgressiveResolutionCoordinator` is a page-local scheduler with centralized, testable limits:

- default batch size: 8 normalized titles;
- maximum outstanding resolver messages: 2;
- duplicate normalized titles are resolved once and fanned out to every matching live row;
- rows move through `pending`, `queued`, `resolving`, `resolved`, or `failed` states;
- repeated viewport, tier, or user triggers cannot enqueue the same title twice;
- malformed, missing, or rejected batch results become controlled failure/not-found states;
- cancellation empties pending work and prevents in-flight responses from applying;
- callbacks preserve document order within a returned batch.

These limits bound content-script message concurrency. The background Steam scheduler remains responsible for actual Steam request concurrency, retry, and 429 backoff.

## Scheduling Priority

Resolution work is ordered as follows:

1. Wishlist and Tradables rows (Tier 1 and Tier 2).
2. Rows in or near the viewport.
3. Remaining Tier 4 rows when automatic mode is enabled.

In selective mode, an offscreen Tier 4 row remains in a neutral pending state until it enters the observer margin or the user selects/interacts with it. Switching settings from selective to automatic drains the remaining eligible queue.

Remote price fetching is a separate decision. Resolving a title establishes identity; it does not automatically authorize a GG.deals request. Tier 1/2 automatic pricing and viewport-driven Tier 4 pricing retain their existing policy.

## Dynamic Wishlist Reconciliation

Profile loading is no longer a startup gate. `GET_PROFILE` runs alongside resolution, and matching `WISHLIST_PROGRESS` messages can update already parsed or already rendered rows.

The authority rules are asymmetric:

- Presence in cached or progressive Wishlist data may promote a row to Tier 1 immediately.
- Absence from partial data proves nothing and cannot remove `WISH`.
- Only a successful final `GET_PROFILE` result with `profileComplete: true` is authoritative for Wishlist demotions.
- A private, incomplete, failed, cancelled, or storage-error profile may contribute positive entries but cannot demote existing Wishlist rows.
- Tradables removals are authoritative only after a successful storage-backed Tradables read.

When a tier changes, the implementation recomputes the complete badge descriptor set. For example, a bundled row promoted to Wishlist becomes `WISH` plus secondary `BUNDLE`; if it is also a deal, `DEAL` remains primary while `WISH` and `BUNDLE` remain secondary.

Affected rows are patched together. Unchanged rows are not rebuilt, and resolved identity, cached price, manual resolution, checkbox state, and workstation state are preserved.

## Prices, Bundles, and Acquisition Prices

After a resolution batch completes, app-ID-bearing rows are grouped for downstream reads:

- cached prices are requested for the batch;
- bundle history is requested for the batch;
- applicable acquisition prices are gathered without serially blocking every other row;
- normal remote price fetching follows the current tier and selective-mode rules.

The workstation receives batched row patches so one completed resolver batch does not rerender every sidebar section once per row.

When GG.deals reports a known wait or rate limit, a cached value is retained when available. Otherwise the row receives an explicit `WAIT` state rather than an indefinitely animated skeleton.

## Run Identity and Stale-Result Protection

Every page lifecycle has explicit identity, including a page sequence/session, profile request ID, adopted profile generation, and settings revision. Async continuations verify that their run is still current before changing rows.

`CACHE_CLEARED` cancels the coordinator and observers, invalidates the current run, clears cache-derived row state, and starts a fresh run against the surviving DOM rows. Responses from the old run cannot repaint the page afterward.

Wishlist progress is accepted only for the active request and generation. Settings and region revisions similarly prevent an older price response from overwriting newer badge state.

## Diagnostics Across Batches

Chunking must still report totals for the full page. The content script starts a resolution diagnostics session with `BEGIN_RESOLUTION_SESSION` and supplies a session ID, unique batch ID, and row multiplicities with each `RESOLVE_TITLES` batch.

The service worker serializes session updates, ignores replayed batch IDs, keeps concurrent tabs separate, and exposes the active/recent aggregate through the existing resolution diagnostics. Row multiplicity preserves user-facing page-row counts even when duplicate titles are deduplicated for network work.

## Maintenance: Latency Patterns to Avoid

Future updates should preserve progressive independence between rows. In particular, do not restore any of these patterns:

### Do not put profile completion before page initialization

Do not await `GET_PROFILE` before parsing rows, assigning IDs, or rendering skeletons/cache hits. Profile data enriches row tiers; it is not a prerequisite for discovering or resolving page titles.

### Do not restore one full-list resolution barrier

Do not collect every page title into one `RESOLVE_TITLES` call and await it before rendering any result. Keep bounded batches and apply each batch independently. Increasing the batch size to the whole page recreates the original slowest-title-blocks-every-row problem.

### Do not serialize independent per-row requests

Avoid code such as:

```js
for (const row of rows) {
  await loadIndependentRowData(row);
}
```

When operations are independent, use the existing bounded scheduler or grouped batch messages. A serial loop adds every network/storage round trip together and becomes increasingly visible as the list grows.

### Do not make sidebar enrichment a badge-rendering gate

Resolving or pricing the user's complete Tradables collection for the workstation must not block visible page-row badges. Page badges and non-page sidebar enrichment should progress independently.

### Do not replace cache hits with loading states

A refresh should keep known resolution and price information visible until newer authoritative data replaces it. Regressing a valid badge to a spinner makes warm-cache pages feel slow and can leave permanent loaders after errors or rate limits.

### Do not rebuild the entire page for one change

Wishlist progress, one resolver batch, one price broadcast, or one settings response should patch only affected rows. Avoid reparsing the page, recreating checkboxes, replacing stable row objects, or rerendering every workstation section per row.

### Do not treat incomplete absence as authoritative

Never remove a Wishlist or Tradables badge because an in-progress, failed, private, or storage-error response omitted the title. Negative reconciliation requires the appropriate successful authoritative result.

### Do not bypass concurrency and lifecycle guards

All new enqueue triggers must remain idempotent, respect the batch/concurrency limits, and reject stale responses after settings changes, cache clearing, navigation, or manual resolution. A second ad-hoc resolver loop can defeat both rate limiting and row revision safety.

### Do not couple title resolution to unconditional remote pricing

Progressively resolving more rows must not cause every resolved Tier 4 item to hit GG.deals immediately. Preserve selective mode and viewport/tier pricing policy to avoid API bursts and rate-limit regressions.

## Verification Expectations

Changes to this architecture should verify at least:

- the first completed batch renders while later rows are still pending;
- cache hits do not enter remote resolution;
- no more than the configured number of batches are outstanding;
- duplicate triggers and duplicate titles do not duplicate requests;
- partial Wishlist data promotes but never demotes;
- a complete profile updates only affected badge sets;
- cache clearing and stale generations cannot repaint old state;
- badge composition preserves all applicable secondary labels;
- diagnostics aggregate the entire page rather than the last batch;
- unit tests, E2E extension scenarios, and Chrome/Firefox builds remain green.
