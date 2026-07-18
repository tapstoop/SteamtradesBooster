export const DIAGNOSTICS_KEY = 'diagnostics_session';

export const DIAGNOSTICS_RETENTION = {
  maxAgeMs: 48 * 60 * 60 * 1000,
  maxApiCalls: 10,
  maxQuotaEvents: 10,
  maxResolutionFailures: 25,
};

export const DEFAULT_RESOLUTION_STATS = {
  total: 0,
  hit: 0,
  resolved: 0,
  fuzzy: 0,
  ambiguous: 0,
  'not-found': 0,
  dismissed: 0,
  delisted: 0,
};

const DEFAULT_DIAGNOSTICS = {
  activeUrl: '',
  resolutionStats: { ...DEFAULT_RESOLUTION_STATS },
  recentFailures: [],
  rateLimit: {
    limit: null,
    remaining: 100,
    resetAt: 0,
    lastUpdatedAt: null,
  },
  lastApiCalls: [],
  recent429Errors: [],
  quotaBlocks: [],
  updatedAt: null,
};

let diagnosticsMemory = { ...DEFAULT_DIAGNOSTICS };

let diagnosticsLock = Promise.resolve();

function storageGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, result => resolve(result?.[key] ?? null));
  });
}

function storageSet(key, value) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function pad(num) {
  return String(num).padStart(2, '0');
}

export function formatDiagnosticDate(ts) {
  if (!ts) return 'n/a';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return 'n/a';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function cloneDefaultDiagnostics() {
  return {
    ...DEFAULT_DIAGNOSTICS,
    resolutionStats: { ...DEFAULT_RESOLUTION_STATS },
    rateLimit: { ...DEFAULT_DIAGNOSTICS.rateLimit },
    lastApiCalls: [],
    recent429Errors: [],
    quotaBlocks: [],
    recentFailures: [],
  };
}

function mergeDiagnostics(raw = {}) {
  const next = {
    ...cloneDefaultDiagnostics(),
    ...raw,
    resolutionStats: { ...DEFAULT_RESOLUTION_STATS, ...(raw.resolutionStats ?? {}) },
    rateLimit: { ...DEFAULT_DIAGNOSTICS.rateLimit, ...(raw.rateLimit ?? {}) },
    lastApiCalls: raw.lastApiCalls ?? raw.rateLimit?.lastCalls ?? [],
    recent429Errors: raw.recent429Errors ?? raw.rateLimit?.recent429s ?? [],
    quotaBlocks: raw.quotaBlocks ?? [],
    recentFailures: raw.recentFailures ?? [],
  };
  return pruneDiagnostics(next, Date.now());
}

function pruneByAge(entries, now, maxAgeMs) {
  return (entries ?? []).filter(entry => {
    const ts = entry.observedAtMs ?? entry.at ?? entry.updatedAt ?? 0;
    return ts && now - ts <= maxAgeMs;
  });
}

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

export async function getDiagnostics() {
  const stored = await storageGet(DIAGNOSTICS_KEY);
  const next = mergeDiagnostics(stored ?? diagnosticsMemory);
  diagnosticsMemory = next;
  return next;
}

export async function setDiagnostics(next) {
  const pruned = pruneDiagnostics(mergeDiagnostics(next), Date.now());
  diagnosticsMemory = pruned;
  await storageSet(DIAGNOSTICS_KEY, pruned);
}

export async function updateDiagnostics(patch) {
  // Serialize updates to prevent read-modify-write races.
  diagnosticsLock = diagnosticsLock.then(async () => {
    const current = await getDiagnostics();
    const merged = { ...current, ...patch };
    // Concatenate array fields so concurrent patches append rather than overwrite.
    for (const key of ['recentFailures', 'lastApiCalls', 'recent429Errors', 'quotaBlocks']) {
      if (patch[key]) {
        merged[key] = [...(current[key] ?? []), ...patch[key]];
      }
    }
    await setDiagnostics({ ...merged, updatedAt: Date.now() });
  }).catch(() => {
    // Best-effort; must not break callers.
  });
  return diagnosticsLock;
}

/**
 * Serialize page-resolution diagnostics by session and batch so concurrent
 * content batches cannot reset or double-count each other.
 */
export async function updateResolutionSession({
  sessionId,
  batchId = null,
  stats = null,
  failures = [],
  activeUrl = null,
  totalRows = null,
} = {}) {
  if (!sessionId) return null;
  let snapshot = null;
  diagnosticsLock = diagnosticsLock.then(async () => {
    const current = await getDiagnostics();
    const sessions = { ...(current.resolutionSessions ?? {}) };
    const existing = sessions[sessionId] ?? {
      stats: { ...DEFAULT_RESOLUTION_STATS },
      failures: [],
      batchIds: [],
      totalRows: Number(totalRows) || 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const knownBatch = batchId != null && existing.batchIds.includes(String(batchId));
    if (!knownBatch && stats) {
      Object.entries(stats).forEach(([key, value]) => {
        existing.stats[key] = (existing.stats[key] ?? 0) + (Number(value) || 0);
      });
      existing.failures = [...failures, ...existing.failures]
        .slice(0, DIAGNOSTICS_RETENTION.maxResolutionFailures);
      if (batchId != null) existing.batchIds = [...existing.batchIds, String(batchId)].slice(-100);
    }
    existing.updatedAt = Date.now();
    sessions[sessionId] = existing;
    const retained = Object.entries(sessions)
      .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, 5);
    const nextSessions = Object.fromEntries(retained);
    snapshot = existing;
    await setDiagnostics({
      ...current,
      ...(activeUrl ? { activeUrl } : {}),
      resolutionSessions: nextSessions,
      resolutionStats: existing.stats,
      recentFailures: existing.failures,
      updatedAt: Date.now(),
    });
  }).catch(() => {});
  await diagnosticsLock;
  return snapshot;
}

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

export function getBrowserLabel(userAgent = '', userAgentData = null) {
  const ua = String(userAgent || '');
  const brands = userAgentData?.brands ?? userAgentData?.uaList ?? [];
  const brandText = brands.map(brand => brand.brand ?? '').join(' ');
  const combined = `${brandText} ${ua}`;
  let browser = 'Unknown browser';

  if (/Edg\//.test(ua) || /Microsoft Edge/i.test(combined)) browser = 'Edge';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Brave/i.test(combined)) browser = 'Brave';
  else if (/Chrome\//.test(ua) || /Chromium/i.test(combined)) browser = 'Chrome';

  const platformSource = userAgentData?.platform || ua;
  let platform = 'Unknown platform';
  if (/Linux/i.test(platformSource)) platform = 'Linux';
  else if (/Windows/i.test(platformSource)) platform = 'Windows';
  else if (/Mac OS|macOS|Macintosh/i.test(platformSource)) platform = 'macOS';
  else if (/Android/i.test(platformSource)) platform = 'Android';
  else if (/iPhone|iPad|iOS/i.test(platformSource)) platform = 'iOS';

  const versionMatch = ua.match(/(?:Chrome|Firefox|Edg)\/(\d+)/);
  const version = versionMatch ? ` ${versionMatch[1]}` : '';
  return `${browser}${version} on ${platform}`;
}

function quotaBucketFromMessage(message = '') {
  const lower = String(message).toLowerCase();
  if (lower.includes('per minute') || lower.includes('100 games per minute') || lower.includes('100 records per minute')) return 'minute';
  if (lower.includes('per hour') || (lower.includes('1000') && lower.includes('hour'))) return 'hour';
  return 'unknown';
}

function quotaBucketFromLimit(limit) {
  if (Number(limit) === 100) return 'minute';
  if (Number(limit) === 1000) return 'hour';
  return 'unknown';
}

export function classifyQuotaWindow({ limit, message } = {}) {
  const messageBucket = quotaBucketFromMessage(message);
  if (messageBucket !== 'unknown') return messageBucket;
  return quotaBucketFromLimit(limit);
}

export function buildApiCallSummary({ type, ids = [], region, status, at = Date.now() } = {}) {
  return {
    type: type ?? 'app',
    count: ids.length,
    region: region ?? 'n/a',
    status: status ?? 'n/a',
    observedAtMs: at,
  };
}

export function buildQuotaBlockEvent({
  kind,
  type,
  ids = [],
  region,
  status,
  resetAt,
  limit,
  remaining,
  message,
  at = Date.now(),
} = {}) {
  return {
    kind: kind ?? (status === 429 ? '429' : 'local-wait'),
    bucket: classifyQuotaWindow({ limit, message }),
    type: type ?? 'app',
    region: region ?? 'n/a',
    count: ids.length,
    requestedCount: ids.length,
    status: status ?? 'n/a',
    resetAt: resetAt || 0,
    limit: Number.isFinite(Number(limit)) ? Number(limit) : null,
    remaining: Number.isFinite(Number(remaining)) ? Number(remaining) : null,
    noPartialData: status === 429,
    observedAtMs: at,
  };
}

export async function recordGgDealsDiagnostics({ rateLimit, apiCall, quotaBlock } = {}) {
  const current = await getDiagnostics();
  await setDiagnostics({
    ...current,
    rateLimit: rateLimit ? {
      ...current.rateLimit,
      ...rateLimit,
      lastUpdatedAt: rateLimit.lastUpdatedAt ?? Date.now(),
    } : current.rateLimit,
    lastApiCalls: apiCall ? [apiCall, ...(current.lastApiCalls ?? [])] : (current.lastApiCalls ?? []),
    recent429Errors: apiCall?.status === 429
      ? [apiCall, ...(current.recent429Errors ?? [])]
      : (current.recent429Errors ?? []),
    quotaBlocks: quotaBlock ? [quotaBlock, ...(current.quotaBlocks ?? [])] : (current.quotaBlocks ?? []),
    updatedAt: Date.now(),
  });
}

function retentionLabel() {
  const hours = Math.round(DIAGNOSTICS_RETENTION.maxAgeMs / (60 * 60 * 1000));
  return `Retention: last ${DIAGNOSTICS_RETENTION.maxApiCalls} API-call summaries, last ${DIAGNOSTICS_RETENTION.maxQuotaEvents} 429/quota events, last ${DIAGNOSTICS_RETENTION.maxResolutionFailures} resolution failures, max age ${hours}h`;
}

function formatStats(stats = {}) {
  return `total=${stats.total ?? 0} hit=${stats.hit ?? 0} resolved=${stats.resolved ?? 0} fuzzy=${stats.fuzzy ?? 0} ambiguous=${stats.ambiguous ?? 0} not-found=${stats['not-found'] ?? 0} dismissed=${stats.dismissed ?? 0} delisted=${stats.delisted ?? 0}`;
}

function formatApiCall(call) {
  return `${formatDiagnosticDate(call.observedAtMs ?? call.at)} ${call.type ?? 'app'} ${call.region ?? 'n/a'} count=${call.count ?? 0} status=${call.status ?? 'n/a'}`;
}

function formatQuotaBlock(event) {
  const parts = [
    `${formatDiagnosticDate(event.observedAtMs)} kind=${event.kind ?? 'n/a'}`,
    `bucket=${event.bucket ?? 'unknown'}`,
    `type=${event.type ?? 'app'}`,
    `region=${event.region ?? 'n/a'}`,
    `count=${event.requestedCount ?? event.count ?? 0}`,
    `remaining=${event.remaining ?? 'n/a'}`,
    `limit=${event.limit ?? 'n/a'}`,
    `resetAt=${formatDiagnosticDate(event.resetAt)}`,
  ];
  if (event.noPartialData) parts.push('noPartialData=true');
  return parts.join(' ');
}

export function buildDiagnosticLog({
  diagnostics,
  manifestVersion = 'unknown',
  userAgent = '',
  userAgentData = null,
  activeUrl = '',
  generatedAt = Date.now(),
} = {}) {
  const merged = mergeDiagnostics(diagnostics ?? {});
  const stats = merged.resolutionStats ?? {};
  const failures = merged.recentFailures ?? [];
  const calls = merged.lastApiCalls ?? [];
  const rateErrors = merged.recent429Errors ?? [];
  const quotaBlocks = merged.quotaBlocks ?? [];
  const rate = merged.rateLimit ?? {};

  return [
    `SteamTrades Booster v${manifestVersion}`,
    `Browser: ${getBrowserLabel(userAgent, userAgentData)}`,
    `Active SteamTrades URL: ${sanitizeSteamTradesUrl(activeUrl) || sanitizeSteamTradesUrl(merged.activeUrl) || 'n/a'}`,
    `Generated: ${formatDiagnosticDate(generatedAt)}`,
    retentionLabel(),
    '',
    'Resolution stats (latest resolver run/current scope):',
    formatStats(stats),
    '',
    'Rate limit:',
    `limit=${rate.limit ?? 'n/a'} remaining=${rate.remaining ?? 'n/a'} resetAt=${formatDiagnosticDate(rate.resetAt)} updatedAt=${formatDiagnosticDate(rate.lastUpdatedAt)}`,
    '',
    'Last API-call summaries:',
    ...(calls.length ? calls.map(formatApiCall) : ['none']),
    '',
    'Recent resolution failures:',
    ...(failures.length ? failures.map(f => `${formatDiagnosticDate(f.observedAtMs ?? f.at)} ${f.status}: ${f.title}`) : ['none']),
    '',
    'Recent 429 errors:',
    ...(rateErrors.length ? rateErrors.map(formatApiCall) : ['none']),
    '',
    'Recent quota blocks:',
    ...(quotaBlocks.length ? quotaBlocks.map(formatQuotaBlock) : ['none']),
  ].join('\n');
}
