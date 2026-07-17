---
title: Steam Search and Bundle Discovery
date: "2026-07-17"
module: background/steam-search, background/steam-bundle-discovery, background/resolver
category: architecture
problem_type: implementation_reference
tags:
  - steam
  - search
  - bundles
  - resolution
  - fuzzy-matching
  - cache
  - rate-limiting
  - chrome-mv3
---

# Steam Search and Bundle Discovery

## Goal

Steam's `storesearch` API returns apps, but it does not reliably return Steam bundles. The extension therefore discovers bundles through the store pages of related apps while keeping network traffic bounded and cancellable.

The feature is used by both automatic title resolution and manual search in the Tradables interfaces. An exact bundle title is resolved automatically. A fuzzy bundle candidate is shown for user confirmation.

Example behavior:

- `Asterix & Obelix XXL Collection` resolves automatically to `bundle:16628`.
- `Asterix & Obelix Collection` matches the same bundle at 75% and requires confirmation.
- Ordinary app matches still require at least 85% similarity.

## Search Pipeline

The runtime message contracts are:

- `SEARCH_STEAM { query, requestId, limit?, locale?, country? }`
- `CANCEL_STEAM_SEARCH { requestId }`
- `RESOLVE_TITLES { titles, forceRefresh? }`
- `CONFIRM_RESOLUTION { cacheKey, appId, title, type }`

For each query, the search pipeline:

1. normalizes the title and reads confirmed or automatic resolution caches;
2. searches the local resolution index;
3. builds useful query variants, including a title with bundle keywords removed;
4. calls Steam `storesearch` for those variants;
5. when the title contains a bundle keyword, inspects up to three related app pages;
6. extracts up to eight unique Steam bundle IDs from strict Steam Store links;
7. loads bundle pages and extracts their canonical titles;
8. ranks exact matches, discovered bundles, store results, and indexed candidates;
9. returns at most the requested result limit.

Recognized bundle keywords are `collection`, `bundle`, `pack`, `package`, `anthology`, `trilogy`, and `quadrilogy`.

Query variants are important because Steam returns no results for some complete bundle titles. For example, the full Asterix collection title returns an empty response, while `Asterix & Obelix XXL` returns the related apps needed for discovery.

## Matching Rules

Matching uses normalized word-set Jaccard similarity.

- Exact normalized title: automatic resolution, no fuzzy state.
- Bundle fuzzy threshold: `0.75`.
- App and sub fuzzy threshold: `0.85`.
- Fuzzy bundle: provisional result requiring confirmation.

For bundle-oriented queries, app candidates are scored against the original title, not a shortened search variant. Search variants are discovery tools and must not inflate an app's confidence.

Exact automatic resolutions are stored with resolver metadata:

```json
{
  "appId": "16628",
  "type": "bundle",
  "resolverVersion": 2,
  "match": "exact",
  "source": "steam-related-bundle"
}
```

Fuzzy bundle results are indexed for later search but are not written as permanent direct resolutions. `CONFIRM_RESOLUTION` remains the only operation that makes a fuzzy user choice authoritative.

Confirmed resolutions always take precedence. Legacy unversioned automatic app resolutions for bundle-like titles are deleted and recalculated once; confirmed values are never migrated automatically.

## Network Limits and Cancellation

All Steam requests use the shared Steam scheduler.

Bundle discovery is bounded by:

- maximum 3 app store pages;
- maximum 8 bundle store pages;
- maximum 2 concurrent Steam requests;
- one discovery page request start every 500 ms, or 2 requests per second;
- 8 second discovery timeout.

Identical searches are coalesced. Each UI caller remains a separate subscriber through its `requestId`. Cancelling one subscriber does not abort shared work while another subscriber still needs it. The final cancellation aborts active page requests.

`CLEAR_CACHE` cancels all active Steam searches before clearing storage. Popup code also verifies its request sequence, current input value, and connected DOM node before rendering asynchronous results.

## Cache Model

The cache keys and default lifetimes are:

| Data | Key prefix | TTL |
| --- | --- | --- |
| Raw `storesearch` results | `steam-search:v1:` | 45 seconds |
| Bundle IDs found on an app page | `steam-related-bundles:v1:` | 24 hours |
| Parsed bundle title | `steam-bundle-metadata:v1:` | 7 days |
| Final discovery result for a query | `steam-bundle-discovery:v2:` | 1 hour |
| Exact automatic resolution | `resolve:` | Permanent |
| Confirmed user resolution | `resolve:*:confirmed` | Permanent |

Invalid HTML, age gates, oversized pages, failed requests, timeouts, and incomplete discoveries are not cached as authoritative empty results. A complete discovery or an exact result may populate the aggregate cache.

The discovery cache is versioned independently from parsed page caches. Changing matching behavior should increment the aggregate discovery version so older empty results do not suppress new candidates.

## Security and Parsing

Bundle extraction accepts only:

- HTTPS URLs;
- hostname exactly `store.steampowered.com`;
- paths matching `/bundle/<numeric-id>/`.

The parser rejects age-gate pages and HTML larger than 2 MB. Bundle titles are extracted from the Steam page header, with a bounded `<title>` fallback. Markup is stripped and HTML entities are decoded without inserting remote HTML into the extension UI.

## Failure Behavior

- A failed store query contributes no candidates but does not fail the entire search.
- A failed app or bundle page marks discovery incomplete and prevents empty aggregate caching.
- A timeout returns only candidates collected before the deadline.
- A cancelled request returns `{ items: [], cancelled: true }`.
- A missing exact bundle remains ambiguous or not found; it is never silently converted to an unrelated app.

Manual Steam URLs remain supported as a deterministic fallback for app, sub, and bundle IDs.

## Tests and Verification

Unit and integration coverage includes:

- title variant generation;
- strict bundle-link and title parsing;
- the 75% bundle threshold and 85% app threshold;
- exact automatic bundle resolution through `RESOLVE_TITLES`;
- legacy cache revalidation and confirmed-cache precedence;
- fuzzy bundles remaining non-permanent;
- search coalescing, cancellation, timeout behavior, and failed-page retries;
- shared Steam scheduler pacing;
- typed app, sub, and bundle IDs with numeric collisions.

The Playwright regression opens the Tradables import modal, resolves the exact Asterix bundle through intercepted Steam pages, verifies that no manual resolve button is shown, adds it, and asserts that storage contains `appId: "16628"` with `type: "bundle"`.

Run:

```bash
npm test
npm run build
npm run test:e2e
```

## Maintenance Rules

- Do not call Steam directly outside the shared scheduler.
- Keep discovery limits explicit and covered by tests.
- Do not lower the app fuzzy threshold when adjusting bundle matching.
- Do not persist fuzzy bundles before user confirmation.
- Increment aggregate cache versions when result-selection semantics change.
- Preserve typed identity as `<type>:<id>`; app, sub, and bundle IDs may collide numerically.
