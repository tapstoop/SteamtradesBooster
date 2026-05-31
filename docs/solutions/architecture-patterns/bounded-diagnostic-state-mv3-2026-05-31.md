---
title: Bounded-on-generation diagnostic state for Chrome MV3 extensions
module: background/diagnostics
date: "2026-05-31"
category: architecture-patterns
problem_type: architecture_pattern
component: background_job
severity: medium
applies_when:
  - "Chrome MV3 extension needs diagnostic state to survive service-worker restarts"
  - "Rate-limited API context must persist across popup close/reopen cycles"
  - "User-facing diagnostic text should be generated on demand from structured data"
symptoms:
  - "Diagnostic context lost after service-worker restart or popup close"
  - "Settings panel permanently consumed by a large invasive textarea"
  - "Raw user-agent strings and ISO timestamps in diagnostic output"
  - "Ambiguous section headers like 'Resolution stats' or 'Recent 429s'"
tags:
  - chrome-mv3
  - diagnostics
  - rate-limiting
  - chrome-storage
  - service-worker
  - ggdeals
related_components:
  - background/ggdeals
  - background/service-worker
  - popup/settings
  - background/cache
---

# Bounded-on-generation diagnostic state for Chrome MV3 extensions

## Context

The SteamTrades Booster extension talks to the GG.deals API, which enforces rate limits (100 records/minute, 1000/hour). When things go wrong — 429s, resolution failures, quota blocks — users need a diagnostic log to paste into bug reports.

The original diagnostics were a permanently-open textarea in settings that dominated the UI, stored raw strings that were lost when the popup closed or the service worker hibernated, and printed opaque section headers alongside raw user-agent strings and ISO timestamps. This made the log hard to read and easy to lose.

The fix introduced a dedicated `background/diagnostics.js` module that persists structured diagnostic state in `chrome.storage.local` with bounded retention, and generates the human-readable log on demand only when the user opens or refreshes the diagnostics panel.

## Guidance

### 1. Persist structured data in `chrome.storage.local`, not `session` or module variables

Service workers hibernate; module-local state disappears. `chrome.storage.session` clears on browser restart. Use `chrome.storage.local` for diagnostics that must survive across popup closes and SW restarts.

Every read and write prune by **age cap** and **count cap** so storage never grows unbounded:

```js
// background/diagnostics.js
export const DIAGNOSTICS_RETENTION = {
  maxAgeMs: 48 * 60 * 60 * 1000,   // 48 hours
  maxApiCalls: 10,
  maxQuotaEvents: 10,
  maxResolutionFailures: 25,
};

export function pruneDiagnostics(diagnostics, now = Date.now()) {
  const next = { ...diagnostics };
  next.lastApiCalls = pruneByAge(next.lastApiCalls, now, DIAGNOSTICS_RETENTION.maxAgeMs)
    .slice(0, DIAGNOSTICS_RETENTION.maxApiCalls);
  next.recent429Errors = pruneByAge(next.recent429Errors, now, DIAGNOSTICS_RETENTION.maxAgeMs)
    .slice(0, DIAGNOSTICS_RETENTION.maxQuotaEvents);
  next.quotaBlocks = pruneByAge(next.quotaBlocks, now, DIAGNOSTICS_RETENTION.maxAgeMs)
    .slice(0, DIAGNOSTICS_RETENTION.maxQuotaEvents);
  next.recentFailures = pruneByAge(next.recentFailures, now, DIAGNOSTICS_RETENTION.maxAgeMs)
    .slice(0, DIAGNOSTICS_RETENTION.maxResolutionFailures);
  return next;
}
```

The module keeps an in-memory mirror (`diagnosticsMemory`) that is refreshed from storage on every `getDiagnostics()` call and written back on every `setDiagnostics()` / `updateDiagnostics()`, so the canonical source is always `chrome.storage.local`.

### 2. Generate the text log on demand, not ahead of time

Stored data is structured — objects with timestamps, status codes, counts. `buildDiagnosticLog()` formats a human-readable string **only when the settings panel requests it** via the `GET_DIAGNOSTIC_LOG` message:

```js
// background/service-worker.js — message handler
case 'GET_DIAGNOSTIC_LOG': {
  return { log: await buildDiagnosticLog() };
}

// background/service-worker.js — on-demand generation
async function buildDiagnosticLog() {
  const diagnostics = await getDiagnostics();
  const manifest = chrome.runtime.getManifest();
  const activeUrl = await queryActiveTabUrl();

  return renderDiagnosticLog({
    diagnostics,
    manifestVersion: manifest.version,
    userAgent: navigator.userAgent,
    userAgentData: navigator.userAgentData,
    activeUrl,
  });
}
```

This means timestamps, browser detection, and labeling are always current — no stale pre-formatted strings.

### 3. Classify quota windows conservatively

GG.deals has distinct minute and hour limits. `classifyQuotaWindow()` only labels a bucket as `minute` or `hour` when the evidence is explicit (header values or the sanitized 429 message); otherwise it records `unknown` with the raw numbers preserved:

```js
// background/diagnostics.js
export function classifyQuotaWindow({ limit, message } = {}) {
  const messageBucket = quotaBucketFromMessage(message);
  if (messageBucket !== 'unknown') return messageBucket;
  return quotaBucketFromLimit(limit);
}
```

This prevents misleading "minute" labels when the response does not clearly identify the rate-limit window.

### 4. Sanitize active-tab URLs with fallback chain

Content scripts report the current page URL via `REPORT_PAGE_DIAGNOSTICS`. The service worker also queries the active tab directly when generating diagnostics. If the active tab is not on steamtrades.com, it falls back to the stored `activeUrl`. All URLs are stripped of query strings and fragments:

```js
// background/diagnostics.js
export function sanitizeSteamTradesUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    if (!['steamtrades.com', 'www.steamtrades.com'].includes(url.hostname)) return '';
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}
```

### 5. Collapsed-by-default panel with `focus=error-log` escape hatch

The settings UI renders diagnostics as a collapsed section. `?focus=error-log` in the popup URL expands it once without changing the saved preference. The user's expand/collapse preference is persisted in `chrome.storage.local` separately:

```js
// popup/settings.js
const focusErrorLog = new URLSearchParams(location.search).get('focus') === 'error-log';
let diagnosticsExpanded = focusErrorLog || Boolean(savedDiagnosticsExpanded);

// User toggle persists preference:
diagnosticsExpanded = !diagnosticsExpanded;
await storageSet({ diagnosticsPanelExpanded: diagnosticsExpanded });
```

### 6. Human-readable browser labels instead of raw UA

```js
// background/diagnostics.js — produces "Chrome 148 on Linux" instead of the full UA string
export function getBrowserLabel(userAgent = '', userAgentData = null) {
  const ua = String(userAgent || '');
  const brands = userAgentData?.brands ?? userAgentData?.uaList ?? [];
  // Detects Chrome, Brave, Firefox, Edge with version; platform from userAgentData or UA
  return `${browser}${version} on ${platform}`;
}
```

### 7. Uniform YYYY-MM-DD HH:MM timestamps

All diagnostic timestamps use `formatDiagnosticDate()`, which outputs a consistent `2026-05-31 14:23` format. Missing or invalid timestamps return `n/a`.

### 8. Structured quota-block events

`buildQuotaBlockEvent()` records a rich object — kind (`429` vs `local-wait`), bucket (`minute`/`hour`/`unknown`), endpoint type, region, requested/remaining counts, limit value, reset time, and a `noPartialData` flag for 429s that returned no pricing data. The GG.deals client persists quota-block events **before** entering retry sleeps so rate-limit evidence survives service-worker suspension:

```js
// background/ggdeals.js — persisted before retry sleep
const quotaBlock = buildCurrentQuotaBlock({
  kind: '429', type, ids, region, status: resp.status, message
});
await safeRecordDiagnostics(() => recordGgDealsDiagnostics({
  rateLimit: rateSnapshot, apiCall, quotaBlock
}));
// Only then: throw { rateLimited: true, resetAt }
```

### 9. Retention policy is visible in the generated log

The log includes a `Retention: last 10 API-call summaries, last 10 429/quota events, last 25 resolution failures, max age 48h` line so users and maintainers know the scope of what they are reading.

### 10. Serialize diagnostic writes with a promise-chain mutex

`updateDiagnostics` does an async read-modify-write (`getDiagnostics` → merge → `setDiagnostics`). If two message handlers (`RESOLVE_TITLES` and `REPORT_PAGE_DIAGNOSTICS`) call it concurrently, their `get`/`set` pairs can interleave, silently dropping one patch.

Guard with a promise chain — each call chains off the previous one:

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

This ensures serial execution without adding a full lock library. Failed promises are caught silently so the chain never breaks.

## Why This Matters

- **Survivability**: Diagnostic data persists across service-worker restarts and popup closes, so users do not lose context between interactions.
- **Bounded storage**: Count and age caps on every list field prevent unbounded growth in `chrome.storage.local`.
- **Readability**: Browser labels, uniform timestamps, and self-documenting section headers make the log immediately useful in bug reports without manual interpretation.
- **Conservatism**: `unknown` quota buckets preserve raw data instead of guessing, preventing misleading reports.
- **Non-invasive UI**: Collapsed-by-default panel with on-demand generation means diagnostics do not dominate settings unless the user opens them.

## When to Apply

- Chrome extensions with service workers that need to retain diagnostic or rate-limit state across hibernation cycles.
- Any client that logs API rate-limit responses and needs human-readable, loss-resistant diagnostic snapshots.
- Settings or debug panels where the diagnostic view should be non-invasive until explicitly opened.
- Any system where structured data should be stored and text-formatted only on generation, not stored pre-formatted.

## Examples

### Before: Lossy, invasive, opaque

```
User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/148.0.0.0 Safari/537.36
...
Resolution stats: {"total":42,"hit":12,"not-found":8}
Recent 429s: 2026-05-30T18:42:33.789Z app EU count=5 status=429
```

- Full textarea always visible in settings
- Data lost on popup close or SW restart
- Raw ISO timestamps, raw UA, ambiguous headers

### After: Bounded, on-demand, readable

```
SteamTrades Booster v1.2.0
Browser: Chrome 148 on Linux
Active SteamTrades URL: https://www.steamtrades.com/trade/abc123
Generated: 2026-05-31 14:23
Retention: last 10 API-call summaries, last 10 429/quota events, last 25 resolution failures, max age 48h

Resolution stats (latest resolver run/current scope):
total=42 hit=12 resolved=0 fuzzy=0 ambiguous=0 not-found=8 dismissed=0 delisted=0

Rate limit:
limit=100 remaining=83 resetAt=2026-05-31 14:35 updatedAt=2026-05-31 14:23

Recent 429 errors:
2026-05-31 14:23 app eu count=5 status=429

Recent quota blocks:
2026-05-31 14:22 kind=429 bucket=minute type=app region=eu count=5 remaining=95 limit=100 resetAt=2026-05-31 14:23 noPartialData=true
```

- Collapsed panel, generated on click, data persisted in `chrome.storage.local`
- Human-readable browser label, uniform timestamps, labeled sections
- Quota blocks classified conservatively (`minute`/`hour`/`unknown`) with raw numbers preserved

## Related

- Plan: `docs/plans/2026-05-31-001-fix-diagnostics-log-polish-plan.md`
- Requirements: `docs/brainstorms/2026-05-31-diagnostics-log-polish-requirements.md`
- GitHub Issue #9: Add error log and About section to Settings
- Module: `background/diagnostics.js`
- Tests: `tests/diagnostics.test.js`, `tests/settings.test.js`