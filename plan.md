# Issue #15 - Automatic removed-game status via steam-tracker.com

## Goal

Classify trade-row titles as delisted, purchase-disabled, or banned from the global steam-tracker.com list, including removed games that Steam search and GG.deals cannot resolve. The provider runs independently from Steam title/profile work and GG.deals pricing, so no provider delays another badge lane.

Manual delisted state is removed. Dismissed and uncertain title-resolution states remain separate. Automatic removal facts are read-only and disappear only after a later successful authoritative tracker refresh omits the app.

## Provider and cache architecture

Add an injectable `background/steam-tracker.js` client around `GetAppListV3`:

- keep a compact versioned `appId -> { categoryId, name }` map plus normalized `title -> appIds` index in `chrome.storage.local` for one hour;
- map only `type: game` category 1 (delisted), 3 (purchase disabled), and 20 (banned);
- ignore invalid/unknown records and resolve duplicates deterministically as banned > disabled > delisted;
- reject malformed, empty, or unsupported successful responses without replacing the last good cache;
- expose a cache-only batched lookup for typed apps and a separate refresh operation;
- single-flight concurrent refreshes across page messages;
- use a ten-second budget, at most two attempts, `Retry-After`, and bounded exponential cooldown;
- persist cooldown/failure state so MV3 worker restart cannot reset rate limiting;
- abort/invalidate in-flight refreshes during cache clear so late responses cannot repopulate storage;
- never send titles, Steam IDs, settings, API keys, or other user data to the provider.

Harden every refresh as untrusted data: exact HTTPS endpoint with redirects refused, credentials/referrer omitted, `application/json` required, attachments rejected, fatal UTF-8 and JSON parsing, and a 4.5 MiB maximum response body. Validate numeric AppIDs, bounded well-formed titles, duplicate candidate limits, total counts, supported counts, and per-category changes against the packaged baseline. On any security failure, keep the last safe snapshot, persist a baseline-scoped refresh lock, and show a popup-only dismissible banner.

Add the provider host permission, an independent hourly alarm, install/startup warming, aggregate diagnostics, and one-time cleanup of obsolete `resolve:*:delisted` flags.

## Concurrent progressive integration

The page starts `ENSURE_STEAM_TRACKER_DATA` without awaiting it. Steam profile/title schedulers and GG.deals pricing continue at the same time.

Batch-read cached tracker matches by normalized row title immediately, while the Steam resolver runs independently. When a tracker refresh changes revision, broadcast `STEAM_TRACKER_UPDATED` and reconcile active rows against the authoritative cache.

Hyperlinks are hints only: rows without links follow the same title-index path. A linked Steam/SteamDB AppID may disambiguate duplicate tracker names, but it never replaces title matching as the primary architecture.

Matching is deterministic: one exact candidate resolves; same-status duplicates show the removal status without assigning an AppID; conflicting duplicates remain ambiguous; a link may select only inside an exact duplicate group; fuzzy matches require at least 85% similarity and confirmation; and a Steam/tracker AppID disagreement remains ambiguous.

Every late reconciliation verifies:

- the page run is still current;
- the row is still connected;
- the row revision/typed identity still matches the request;
- the identity/status is not fuzzy, dismissed, or stale after an authoritative refresh.

Update the stable row and workstation in one path, then call `replaceBadge()` to rebuild the complete descriptor set. Do not edit one DOM badge in isolation. If a later authoritative revision removes a tracker-only match, invalidate that row and suppress stale in-flight resolver results.

## Badge composition

Removal status is the primary presentation:

```text
REMOVAL > DEAL > WISH > TRADE > BUNDLE > plain/NA
```

Labels and styles:

- category 1: red `DELISTED`;
- category 3: orange `NO PURCHASE`;
- category 20: dark red `BANNED`.

If a removal result arrives after an existing price/tier badge, recompute atomically: removal moves to the left as primary while applicable `DEAL`, `WISH`, `TRADE`, and `BUNDLE` labels move right as compact secondaries. Preserve price, timestamp, acquisition data, title identity, and workstation state. Fuzzy identities are never decorated before confirmation.

## GG.deals relief and negative results

Add `Automatically fetch prices for removed Steam games`, default off. Disabled blocks scheduler-originated price/bundle requests for tracker-classified AppIDs before the GG.deals queue, but explicit checkbox selection, manual resolution, and manual refresh remain available.

When enabled, only a successful GG.deals response that omits a removed AppID creates a permanent typed/region negative cache entry. Failures, timeouts, and rate limits never create it. Render `NO GG.DEALS DATA` last with tooltip `GG.deals returned no data for this Steam AppID.` Clear it on identity confirmation/change, explicit retry, a later positive response, or global cache clear.

Settings changes are cache-only. Enabling removed-game pricing must never switch selective mode into automatic behavior. In automatic mode the toggle schedules only removed rows; in selective mode it schedules none. Automatic price messages are tagged and rejected again by the service worker while selective mode is enabled, while a user-selected fetch remains allowed.

## Tests and verification

Add or update:

- tracker client unit tests for schema mapping, no-link title matching, homogeneous/conflicting duplicates, link disambiguation, fuzzy confirmation, malformed data, cache-only lookup, single-flight, cooldown persistence, stale preservation, and reset races;
- badge unit tests for all labels, priority composition, fuzzy exclusion, and late atomic reordering;
- picker/resolver/service-worker tests proving manual-delisted controls are gone, legacy flags are ignored/cleaned, and only typed apps are classified;
- content/coordinator coverage for late removal lookup, identity guards, authoritative invalidation, and stale-response suppression;
- GG.deals tests for disabled admission, permanent successful no-data caching, reset paths, and failure exclusion;
- manifest tests for both packaged targets;
- an extension E2E scenario in which GG.deals renders first and a delayed Steam Tracker response becomes primary without losing the existing secondary badge;
- an extension E2E regression that enables removed-game pricing in selective mode, proves zero global GG.deals requests, then proves one explicitly selected row can still fetch;
- full unit suite and Chrome/Firefox builds.

## Completion criteria

The tracker lane is cached, rate-limited, race-safe, privacy-safe, and non-blocking. Both API-provider paths can render in either order, and the same dynamic full-state reconciliation architecture described in the badge and progressive-badge documents determines the final clean badge order.
