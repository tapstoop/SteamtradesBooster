---
title: Code review fixes for MV3 state loss, races, and unbounded API calls
module: background
date: "2026-05-31"
category: logic-errors
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - Unbounded Steam API calls with no rate limiting, risking IP blocks on large trade pages (300+ calls per page)
  - Service-worker rate-limit state resets on hibernation, allowing burst GG.deals requests
  - Diagnostics read-modify-write race condition silently drops patches from concurrent message handlers
  - Title resolver returns on first match instead of best candidate across all search terms
  - normalizeSteamType function duplicated across 6 files, risking silent type drift
root_cause: logic_error
resolution_type: code_fix
tags:
  - chrome-mv3
  - rate-limiting
  - code-review
  - service-worker
  - race-condition
  - state-persistence
  - resolver
related_components:
  - content
  - popup
  - utils
---

# Code Review Fixes for MV3 State Loss, Races, and Unbounded API Calls

## Problem

A structured multi-agent code review of the SteamTrades Booster Chrome extension identified 13 issues across background, content, and popup modules. The most critical were: unbounded Steam API calls risking IP blocks, service-worker state loss on hibernation causing burst requests, a diagnostics race condition that silently dropped data, and a resolver that could match the wrong game.

## Symptoms

- Large trade pages (50+ rows) trigger 200-300+ Steam store API calls per page load with no rate limiting
- `rateLimitState.resetAt` lost on service-worker wake, causing the rate limiter to think it has full quota
- `SEARCH_STEAM` responses in the resolve popover can arrive out of order, showing wrong results
- Title resolution for "Hollow Knight Deluxe Edition" may resolve to plain "Hollow Knight" because the edition-stripped term matches first
- `normalizeSteamType` defined in 6 separate files — adding `sub` type would require 6 edits

## What Didn't Work

- Module-level state (`rateLimitState`, `diagnosticsMemory`) — reset on every service-worker hibernation in MV3
- Simple `async` function calls in message handlers — concurrent handlers interleave without serialization
- Early-return resolution loops — first-match bias on edition-stripped titles causes wrong game resolution
- Individual spot fixes — needed systematic audit of all async state access patterns

## Solution

### 1. Rate-limit Steam API calls

Added a `rateLimitedFetch` wrapper with 200ms minimum delay between successive calls. Only the Steam store API path uses it; GG.deals calls have their own queue.

**Before:** `fetchSteamItems` used raw `fetch()` with no rate limiting:

```js
async function fetchSteamItems(term) {
  const url = `${STEAM_SEARCH}?term=${encodeURIComponent(term)}&l=english&cc=us`;
  const resp = await fetch(url);
  // ... no delay between calls
}
```

**After:** Every call goes through `rateLimitedFetch` which enforces a 200ms gap:

```js
const RESOLVE_REQUEST_INTERVAL_MS = 200;
let lastResolveRequestAt = 0;

async function rateLimitedFetch(url) {
  const now = Date.now();
  const waitMs = Math.max(0, RESOLVE_REQUEST_INTERVAL_MS - (now - lastResolveRequestAt));
  if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
  lastResolveRequestAt = Date.now();
  return fetch(url);
}
```

File: `background/resolver.js`

### 2. Persist rate-limit state across service-worker hibernation

The `rateLimitState` object resets to `{ remaining: 100, limit: null }` when the service worker wakes. Added fire-and-forget persistence to `chrome.storage.local` after every `updateRateLimit()` call, with restoration at the start of `processQueue()`.

```js
const RATE_LIMIT_STORAGE_KEY = 'ggdeals_rate_limit_state';

async function persistRateLimitState() {
  try {
    await new Promise(resolve => {
      chrome.storage.local.set({ [RATE_LIMIT_STORAGE_KEY]: { ...rateLimitState } }, resolve);
    });
  } catch { /* best-effort */ }
}
```

The restoration is guarded by a 1-hour freshness check — stale data is ignored in favor of module-level defaults.

File: `background/ggdeals.js`

### 3. Serialize diagnostics updates with promise-chain mutex

`updateDiagnostics` does an async read-modify-write (`getDiagnostics` → merge → `setDiagnostics`). Concurrent `RESOLVE_TITLES` and `REPORT_PAGE_DIAGNOSTICS` handlers can interleave, silently dropping patches.

```js
let diagnosticsLock = Promise.resolve();

export async function updateDiagnostics(patch) {
  diagnosticsLock = diagnosticsLock.then(async () => {
    const current = await getDiagnostics();
    await setDiagnostics({ ...current, ...patch, updatedAt: Date.now() });
  });
  return diagnosticsLock;
}
```

Each call chains off the previous one's `.then()`, ensuring serial execution. Errors are caught silently so the chain never breaks.

File: `background/diagnostics.js`

### 4. Collect best match across all search terms

The resolver previously returned on the first exact or fuzzy match, allowing an edition-stripped term (e.g., "Hollow Knight" from "Hollow Knight Deluxe Edition") to win over the original term.

Replaced early-return with accumulator variables:

```js
let bestExactMatch = null;
let bestFuzzyResult = null;
let bestFuzzyScore = 0;
let bestAmbiguous = null;

for (const term of getSearchTerms(title)) {
  const items = await fetchSteamItems(term);
  // Evaluate each term, update best candidates
  // Exact match on original title preferred over stripped title
}

if (bestExactMatch) return { ...bestExactMatch, status: 'resolved' };
if (bestFuzzyResult) return { ...bestFuzzyResult, status: 'resolved', fuzzy: true };
```

File: `background/resolver.js`

### 5. Extract shared utilities (6x deduplication)

`normalizeSteamType` was defined identically in 6 files (`resolver.js`, `profile.js`, `service-worker.js`, `content.js`, `ui-pickers.js`, `ui-workstation.js`). Extracted to `utils/similarity.js`:

```js
export function normalizeSteamType(type) {
  return ['app', 'bundle', 'sub'].includes(type) ? type : 'app';
}
```

Also added `typedPriceKey` which was duplicated in `content.js`.

### 6. Additional fixes

- **Popover search race**: Added `searchSequence` counter to discard stale `SEARCH_STEAM` responses
- **Qty save debounce**: 300ms debounce on `SAVE_TRADABLES` messages to prevent storage spam on rapid qty arrow clicks
- **Table parser type extraction**: `extractSteamType(href)` extracts `app`/`bundle`/`sub` from Steam link URLs
- **Operator precedence**: Explicit parens in `quotaBucketFromMessage` boolean expression
- **`cacheDelete` utility**: Added `cacheDelete(key)` for explicit cache key eviction
- **Misleading indentation**: Fixed `sawItems` indentation in resolver
- **Backward compat tests**: Added tests for legacy `{ appIds }` message format

## Why This Works

All four critical bugs share a root cause: **asynchronous state access without serialization or persistence in an event-driven environment (MV3 service worker)**. The fixes add one of three guards:

1. **Rate limiting** (temporal guard) — prevents burst-driven IP blocks
2. **Storage persistence** (durable guard) — survives SW lifecycle across hibernation cycles
3. **Promise-chain mutex** (serialization guard) — prevents interleaved concurrent handler execution
4. **Accumulator pattern** (algorithmic guard) — removes first-match bias from search loops

## Prevention

- **Audit all module-level state** in service-worker code for MV3 persistence via `chrome.storage`. Any object that lives at module scope will reset on SW wake.
- **Review async read-modify-write patterns** for concurrent handler races. Use promise-chain mutexes when two or more message handlers can update the same state.
- **Use accumulator patterns** in multi-term search functions instead of early-return. Collect all candidates, then pick the best.
- Set up a static-analysis rule: "could two messages arrive concurrently and corrupt this state?"
- After each code review, document the findings in `docs/solutions/` before the context grows cold.

## Related

- Pattern: `docs/solutions/architecture-patterns/bounded-diagnostic-state-mv3-2026-05-31.md` — diagnostics architecture that this session extended with mutex/race prevention
- Plan: `docs/superpowers/plans/2025-05-31-code-review-fixes.md`
- Tests: `tests/resolver.test.js`, `tests/diagnostics.test.js`, `tests/ggdeals.test.js`, `tests/service-worker.test.js`, `tests/similarity.test.js`
