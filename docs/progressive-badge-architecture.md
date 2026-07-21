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
9. Run independent provider lanes concurrently and reconcile whichever authoritative fact arrives later.

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
        +----> cached Steam Tracker facts ------> removal reconciliation
        +----> Steam Tracker refresh ----------> revision broadcast/reconciliation
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

### Structure-first row parsing

The parser does not reject a candidate merely because it contains more than 15 words. Length is only a weak prose signal. List items, table cells, Steam/SteamDB-linked titles, and lines separated with `<br>` are trusted row structures and retain even long or sentence-like game names.

An unlinked, standalone paragraph is rejected only when several prose signals agree, such as an explanatory opening, trade/payment wording, explanatory subject/verb patterns, multiple sentence endings, or a trailing explanation. Explicit boilerplate such as “These games…” and “No TF2…” is rejected directly. An uncertain long candidate remains a row so the resolver or user can decide it; this avoids trading false positives for silently missing real games.

## Stable Row State

Rows are parsed early and receive a permanent `stptId`. Each row keeps its original SteamTrades title and DOM element while resolution, tier, badge, and price fields are filled progressively.

Important invariants are:

- `originalTitle` is never discarded when a canonical Steam title arrives;
- a typed identity embedded in a Steam Store or SteamDB row link is a duplicate-disambiguation hint, not the primary resolver;
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
- `GET_CACHED_RESOLUTION_STATES` supplies input-aligned resolution results, including confirmed, fuzzy, dismissed, ambiguous, hit, and resolved states;
- `GET_REMOVAL_MATCHES` supplies input-aligned cached title matches before Steam resolution, while `GET_REMOVAL_STATUSES` reconciles resolved typed apps;
- cached prices and bundle information are read as soon as a batch has typed Steam identities.

Cache hits are applied immediately and are marked hydrated in the coordinator, so they are never sent through remote resolution again. A known badge remains visible while fresher work runs; it is not replaced by a blank loading spinner.

Rows without hyperlinks follow the same title-index hydration path as linked rows. Links may choose among exact duplicate Tracker candidates, but cannot silently override a title or provider conflict. Same-status duplicates render a removal fact without an AppID and are excluded from downstream schedulers.

## Independent Steam Tracker Lane

Steam Tracker is intentionally not part of the Steam/GG.deals scheduler. It provides one global removed-app dataset, while the other providers operate per title, identity, region, or price. The content script starts `ENSURE_STEAM_TRACKER_DATA` without awaiting it and continues profile, resolution, and pricing work normally.

The service worker keeps compact AppID records and a normalized title-to-AppIDs index in `chrome.storage.local` for one hour. Cache reads do not call the provider. Refreshes are single-flight across tabs, use a ten-second request budget and at most two attempts, respect `Retry-After`, and persist exponential cooldown state so Manifest V3 suspension or restart cannot bypass rate limiting. Malformed or empty responses never replace the last known-good cache.

The first safe dataset is packaged in the extension, so a cold page never depends on a remote database download. Remote refreshes require the exact HTTPS endpoint, no redirect, `application/json`, no attachment disposition, valid UTF-8/JSON, and a body no larger than 4.5 MiB. Record, category, identifier, title, and duplicate bounds are checked before a new snapshot can become authoritative. A security failure locks remote Tracker refreshes for the current packaged baseline, retains the safe cache, and exposes a dismissible popup banner.

When a refresh changes the dataset revision, the worker broadcasts `STEAM_TRACKER_UPDATED`. Each page rematches titles and typed identities and atomically recomputes affected badge sets. Removal becomes primary and existing `DEAL`, `WISH`, `TRADE`, or `BUNDLE` facts remain ordered secondaries. Row/run/revision guards and coordinator invalidation prevent an old lookup from decorating a reused, manually changed, disconnected, or superseded row.

## Steam Tracker Data Security and Cache Lifecycle

Steam Tracker is a data provider, not a code provider. The extension never downloads or executes a file, script, module, HTML fragment, archive, or native binary from it. It performs an HTTPS `fetch()` for JSON, parses the response in memory, validates individual scalar fields, and stores only a compact reconstruction in extension storage.

This distinction keeps the integration within the same data-fetch model already used for Steam and GG.deals. It does not make remote data inherently trustworthy: the complete response is handled as hostile input until every validation has passed.

### Packaged baseline

`scripts/update-steam-tracker-baseline.mjs` is a maintainer-only release tool. It fetches and filters the provider list and generates `background/steam-tracker-baseline.js`. The generated module contains:

- baseline metadata and a source SHA-256 for review;
- the complete supported AppID map for categories 1, 3, and 20;
- the complete normalized title-to-AppIDs index;
- raw, supported, and per-category record counts used by runtime anomaly checks.

The packaged snapshot means first paint, cold startup, and offline use do not depend on a live provider request. It is bundled JavaScript produced before release and reviewed with the rest of the extension source; it is not remote code. Updating it is an explicit maintainer action, never something the installed extension performs by rewriting its own package.

### Runtime snapshots and storage keys

At runtime the service worker may keep these versioned records in `chrome.storage.local`:

| Storage key | Purpose |
| --- | --- |
| `steam_tracker_cache_v2` | Current last-known-good compact snapshot |
| `steam_tracker_cache_previous_v1` | Previous safe snapshot for recovery and diagnostics |
| `steam_tracker_request_state_v1` | Persistent cooldown, failure count, last status, and next allowed request time |
| `steam_tracker_security_state_v1` | Baseline-scoped remote-refresh security lock |
| `steam_tracker_security_alert_v1` | Popup incident state, including dismissal |

Only one current and one previous runtime snapshot are retained. There is no list of parallel downloaded databases. Concurrent callers share one in-flight refresh promise, and snapshot/security writes are serialized. A safe changed snapshot receives a new revision; unchanged content keeps the existing revision. The current snapshot is replaced only after the complete response passes validation and the storage write succeeds. Until then, every page continues reading the previous safe or packaged snapshot.

The cache TTL is one hour. An hourly alarm and install/startup warming may request an update, but a fresh cache, persisted cooldown, security lock, or existing single-flight request prevents redundant calls. Page lookups through `GET_REMOVAL_MATCHES` and `GET_REMOVAL_STATUSES` are cache-only and never contact Steam Tracker.

### Network and body validation

The refresh request is limited to `https://steam-tracker.com/api?action=GetAppListV3` with:

- the Steam Tracker HTTPS host permission;
- redirects refused and the final response URL checked when the browser exposes it;
- cookies and credentials omitted;
- no referrer;
- `cache: no-store` and `Accept: application/json`;
- an exact `Content-Type: application/json` media type requirement, allowing only normal parameters such as a charset;
- responses marked with an attachment disposition rejected;
- both declared and streamed body sizes capped at 4,718,592 bytes (4.5 MiB);
- immediate stream cancellation as soon as the cap is exceeded;
- fatal UTF-8 decoding followed by `JSON.parse()`.

The cap applies to the response bytes delivered to and processed by the extension. The full source response measured when the packaged baseline was generated was about 3.58 MB, so 4.5 MiB leaves bounded growth room without accepting an eight-times-current-size payload.

MIME validation is only one layer. A compromised provider can label arbitrary bytes as JSON, so MIME never substitutes for size, encoding, syntax, schema, scalar, duplicate, and statistical validation.

### Schema, scalar, and anomaly validation

The root must report success and contain a non-empty `removed_apps` array. The parser retains a record only when:

- `type` is exactly `game`;
- the AppID is numeric, positive, and no greater than the unsigned 32-bit maximum;
- the category is 1 (delisted), 3 (purchase disabled), or 20 (banned);
- the title is a non-empty, well-formed Unicode string;
- the title is at most 192 Unicode code points;
- the title contains no control characters or bidirectional override/isolate controls.

Duplicate AppID records resolve deterministically by severity: banned, then purchase disabled, then delisted. Normalized title candidate groups are sorted deterministically and capped at five AppIDs; an oversized group rejects the complete update rather than being truncated silently.

For a live update, the raw record count and supported unique-AppID count must each remain within 10% of the packaged baseline. Each supported category count must remain within 15%. These checks prevent a syntactically valid but largely replaced, truncated, or category-skewed dataset from becoming authoritative. Game-shaped records with a valid AppID that fail supported-category/title mapping contribute to the unknown-record diagnostic count but never become badge facts.

Provider titles are never passed to `innerHTML`. Badge labels and security messages use extension-owned static strings; provider titles and diagnostic values are inserted through safe text nodes.

### Request limits and ordinary failures

A refresh has a ten-second total budget and at most two attempts. A 429 response respects `Retry-After` only when the retry still fits inside that budget. Retryable 5xx and network failures use bounded backoff. After failure, `nextAllowedAt`, failure count, last status, and failure time are persisted, so Manifest V3 suspension, a service-worker restart, another tab, or another page cannot reset the limiter.

Network errors, timeouts, 5xx, and 429 responses never replace the safe snapshot. They also never manufacture removal facts or GG.deals negative results.

### Security incidents, lock, and notification

A redirect, unexpected final URL, wrong MIME, attachment, oversized body, invalid UTF-8/JSON, invalid or empty schema, duplicate overflow, or count/category anomaly creates a security incident. The response is discarded and remote Tracker refresh is locked for the current packaged baseline.

While locked:

- alarms, tabs, popup openings, worker restarts, and general cache clearing cannot retry against the same baseline;
- the last safe runtime snapshot, or the packaged baseline when necessary, continues answering lookups;
- diagnostics retain the reason code, last safe timestamp, counts, and request state;
- the popup shows one visible `Steam Tracker update blocked` banner.

The banner can be dismissed immediately and remains dismissed for the same incident. Dismissal hides the notification only: it does not unlock refreshes, accept the rejected response, or weaken later validation. `Generate log` opens the existing diagnostics section and runs the same diagnostic-log generator as its Generate button. Alerts whose incident or baseline no longer matches an active lock are deleted instead of being rendered; dismissing such a stale ID is idempotently successful. A later extension release with a new reviewed packaged baseline scopes validation and any future incident lock to that new baseline.

### Races, cache clearing, and provider independence

The Tracker client is single-flight across messages. General cache clear increments its generation and aborts an active request. Even if abort arrives too late to stop the network, the old generation is checked again before persistence, so that response cannot repopulate storage. The security lock and alert intentionally survive general cache clearing; deleting ordinary cache data is not a security bypass.

Steam Tracker refresh, Steam title/profile resolution, and GG.deals pricing remain independent lanes. Pages start Tracker warming without awaiting it. A late safe revision broadcasts `STEAM_TRACKER_UPDATED`, after which current rows recompute their complete badge composition. Removal becomes primary and existing price, tier, and bundle facts move right without restarting either other provider.

Page-run, row-revision, connected-DOM, and typed-identity guards prevent stale reconciliation after navigation, manual resolution, identity change, disconnection, cache clear, or a newer result. The GG.deals removed-game toggle is likewise independent from fetch mode: settings broadcasts are cache-only, selective mode schedules nothing, and scheduler-originated automatic requests are rejected again by the service worker while selective mode remains active.

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
- bundle history is requested remotely only when automatic mode is active; selective hydration stays cache/local-only;
- applicable acquisition prices are gathered without serially blocking every other row;
- normal remote price fetching follows the current tier and selective-mode rules.

The workstation receives batched row patches so one completed resolver batch does not rerender every sidebar section once per row.

Interactive GG.deals work has a 15-second queue/network deadline. A job that cannot start before the known quota reset is rejected without a later surprise request; the manual button leaves unresolved/failed rows selected and shows a visible retry message instead of an indefinitely animated loading state.

Removed-game automatic GG.deals requests are independently gated by `Automatically fetch prices for removed Steam games`, which defaults off and is enforced before queue admission. It does not remove checkboxes or block explicit selection, manual resolution, or manual refresh. A successful response that omits a removed AppID creates a permanent typed/region negative entry; transport/rate-limit failures do not. The entry produces the final secondary `NO GG.DEALS DATA` fact and is cleared by identity confirmation/change, explicit refresh, a positive response, or global cache clear.

Changing settings is a cache-only render operation. It may recompute badges from `GET_CACHED_PRICES`, but it cannot call GG.deals. The only transition that starts the global automatic scheduler is `selectiveFetch: true -> false`. Enabling removed-game pricing while already automatic schedules only resolved removed rows; enabling it while selective schedules nothing. Every price, bundle, and refresh request has a normalized intent. Missing or unknown intents are treated as `automatic`, and the service worker rejects them while selective mode is active. Explicit checkbox, resolution, and refresh actions use `selected`, `manual-resolution`, or `manual-refresh` and remain usable.

## Run Identity and Stale-Result Protection

Every page lifecycle has explicit identity, including a page sequence/session, profile request ID, adopted profile generation, and settings revision. Async continuations verify that their run is still current before changing rows.

`CACHE_CLEARED` cancels the coordinator and observers, invalidates the current run, clears cache-derived row state, and starts a fresh run against the surviving DOM rows. Responses from the old run cannot repaint the page afterward.

Cache clearing also increments the Steam Tracker client generation and aborts its active request. A response from the old generation cannot repopulate the cleared cache. The one-time migration marker is preserved while obsolete manual-delisted cache flags are removed.

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
- concurrent Steam Tracker single-flight, cooldown persistence, stale-cache preservation, and late badge reordering remain correct;
- badge composition preserves all applicable secondary labels;
- diagnostics aggregate the entire page rather than the last batch;
- unit tests, E2E extension scenarios, and Chrome/Firefox builds remain green.
