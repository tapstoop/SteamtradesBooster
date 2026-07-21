import { parseRetryAfterMs } from './steam-rate-limiter.js';
import { createRemovalRecord, getRemovalStatusMeta, removalStatusFromCategoryId } from '../utils/removal-status.js';
import { normalizeTitle, wordSimilarity } from '../utils/similarity.js';
import { STEAM_TRACKER_BASELINE_META, STEAM_TRACKER_BASELINE_SNAPSHOT } from './steam-tracker-baseline.js';

export const STEAM_TRACKER_URL = 'https://steam-tracker.com/api?action=GetAppListV3';
export const STEAM_TRACKER_CACHE_KEY = 'steam_tracker_cache_v2';
export const STEAM_TRACKER_REQUEST_STATE_KEY = 'steam_tracker_request_state_v1';
export const STEAM_TRACKER_SECURITY_STATE_KEY = 'steam_tracker_security_state_v1';
export const STEAM_TRACKER_SECURITY_ALERT_KEY = 'steam_tracker_security_alert_v1';
export const STEAM_TRACKER_PREVIOUS_CACHE_KEY = 'steam_tracker_cache_previous_v1';
export const STEAM_TRACKER_SCHEMA_VERSION = 3;
export const STEAM_TRACKER_TTL_MS = 60 * 60 * 1000;
export const STEAM_TRACKER_FUZZY_THRESHOLD = 0.85;
export const STEAM_TRACKER_MAX_BODY_BYTES = 4_718_592;

const DEFAULT_SECURITY_PROFILE = {
  rawItemCount: STEAM_TRACKER_BASELINE_META.rawItemCount,
  itemCount: STEAM_TRACKER_BASELINE_META.itemCount,
  categoryCounts: STEAM_TRACKER_BASELINE_META.categoryCounts,
  maxRawDelta: 0.1,
  maxItemDelta: 0.1,
  maxCategoryDelta: 0.15,
};

const MAX_ATTEMPTS = 2;
const REQUEST_BUDGET_MS = 10_000;
const BASE_FAILURE_COOLDOWN_MS = 60_000;
const MAX_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

function defaultStorage() {
  return {
    get(keys) {
      return new Promise((resolve, reject) => chrome.storage.local.get(keys, result => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result ?? {});
      }));
    },
    set(values) {
      return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      }));
    },
  };
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validAppId(value) {
  const appId = String(value ?? '').trim();
  if (!/^\d+$/.test(appId)) return null;
  const numeric = Number(appId);
  return Number.isSafeInteger(numeric) && numeric > 0 && numeric <= 0xFFFFFFFF ? appId : null;
}

export class SteamTrackerSecurityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SteamTrackerSecurityError';
    this.code = code;
    Object.assign(this, details);
  }
}

function rejectSecurity(code, message, details) {
  throw new SteamTrackerSecurityError(code, message, details);
}

function safeTitle(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || [...name].length > 192) return null;
  if (/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u.test(name)) return null;
  try {
    new TextEncoder().encode(name);
    if (typeof name.isWellFormed === 'function' && !name.isWellFormed()) return null;
  } catch { return null; }
  return name;
}

function normalizeRequestState(value) {
  if (value?.schemaVersion !== STEAM_TRACKER_SCHEMA_VERSION) {
    return {
      schemaVersion: STEAM_TRACKER_SCHEMA_VERSION,
      nextAllowedAt: 0,
      failureCount: 0,
      lastStatus: null,
      lastFailureAt: 0,
    };
  }
  return {
    schemaVersion: STEAM_TRACKER_SCHEMA_VERSION,
    nextAllowedAt: Number(value.nextAllowedAt) || 0,
    failureCount: Math.max(0, Number(value.failureCount) || 0),
    lastStatus: value.lastStatus ?? null,
    lastFailureAt: Number(value.lastFailureAt) || 0,
  };
}

function normalizeCache(value) {
  if (value?.schemaVersion !== STEAM_TRACKER_SCHEMA_VERSION
    || !value.byId || typeof value.byId !== 'object'
    || !value.byTitle || typeof value.byTitle !== 'object') {
    return null;
  }
  return {
    schemaVersion: STEAM_TRACKER_SCHEMA_VERSION,
    fetchedAt: Number(value.fetchedAt) || 0,
    revision: String(value.revision ?? ''),
    byId: value.byId,
    byTitle: value.byTitle,
    itemCount: Math.max(0, Number(value.itemCount) || Object.keys(value.byId).length),
    rawItemCount: Math.max(0, Number(value.rawItemCount) || 0),
    unknownCategoryCount: Math.max(0, Number(value.unknownCategoryCount) || 0),
    categoryCounts: { ...(value.categoryCounts ?? {}) },
  };
}

function newRevision(now) {
  try { return crypto.randomUUID(); } catch {
    return `${now}-${Math.random().toString(36).slice(2)}`;
  }
}

function mapsEqual(left = {}, right = {}) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}

export function mapTrackerCategory(record) {
  if (!record || record.type !== 'game') return null;
  const appId = validAppId(record.appid);
  const status = removalStatusFromCategoryId(record.category_id);
  const meta = getRemovalStatusMeta(status);
  if (!appId || !meta) return null;
  const name = safeTitle(record.name);
  if (!name) return null;
  return { appId, status, categoryId: meta.categoryId, name };
}

export function parseSteamTrackerPayload(payload, { securityProfile = null } = {}) {
  if (payload?.success !== true || !Array.isArray(payload.removed_apps) || payload.removed_apps.length === 0) {
    if (securityProfile) rejectSecurity('invalid-schema', 'Steam Tracker returned an invalid or empty schema');
    throw new Error('Malformed or empty Steam Tracker response');
  }

  if (securityProfile) {
    const min = Math.ceil(securityProfile.rawItemCount * (1 - securityProfile.maxRawDelta));
    const max = Math.floor(securityProfile.rawItemCount * (1 + securityProfile.maxRawDelta));
    if (payload.removed_apps.length < min || payload.removed_apps.length > max) {
      rejectSecurity('raw-count-anomaly', 'Steam Tracker raw record count is outside the trusted range');
    }
  }
  const byId = Object.create(null);
  const categoryCounts = Object.create(null);
  let unknownCategoryCount = 0;
  for (const record of payload.removed_apps) {
    const mapped = mapTrackerCategory(record);
    if (!mapped) {
      if (record?.type === 'game' && validAppId(record?.appid)) unknownCategoryCount++;
      continue;
    }
    const currentStatus = removalStatusFromCategoryId(byId[mapped.appId]?.categoryId);
    const currentSeverity = getRemovalStatusMeta(currentStatus)?.severity ?? 0;
    const nextSeverity = getRemovalStatusMeta(mapped.status)?.severity ?? 0;
    if (nextSeverity >= currentSeverity) {
      byId[mapped.appId] = { categoryId: mapped.categoryId, name: mapped.name };
    }
  }
  const byTitle = Object.create(null);
  for (const [appId, record] of Object.entries(byId)) {
    const status = removalStatusFromCategoryId(record.categoryId);
    categoryCounts[status] = (categoryCounts[status] ?? 0) + 1;
    const normalized = normalizeTitle(record.name);
    if (!normalized) continue;
    if (!byTitle[normalized]) byTitle[normalized] = [];
    byTitle[normalized].push(appId);
  }
  for (const ids of Object.values(byTitle)) ids.sort((left, right) => Number(left) - Number(right));
  if (Object.keys(byId).length === 0) {
    if (securityProfile) rejectSecurity('invalid-schema', 'Steam Tracker returned no supported game records');
    throw new Error('Steam Tracker response contains no supported game records');
  }
  if (Object.values(byTitle).some(ids => ids.length > 5)) {
    rejectSecurity('duplicate-limit', 'Steam Tracker contains too many duplicate title candidates');
  }
  const itemCount = Object.keys(byId).length;
  if (securityProfile) {
    const minItems = Math.ceil(securityProfile.itemCount * (1 - securityProfile.maxItemDelta));
    const maxItems = Math.floor(securityProfile.itemCount * (1 + securityProfile.maxItemDelta));
    if (itemCount < minItems || itemCount > maxItems) {
      rejectSecurity('supported-count-anomaly', 'Steam Tracker supported record count is outside the trusted range');
    }
    for (const [status, baselineCount] of Object.entries(securityProfile.categoryCounts)) {
      const actual = categoryCounts[status] ?? 0;
      const delta = baselineCount ? Math.abs(actual - baselineCount) / baselineCount : actual ? 1 : 0;
      if (delta > securityProfile.maxCategoryDelta) {
        rejectSecurity('category-count-anomaly', `Steam Tracker ${status} count changed unexpectedly`);
      }
    }
  }
  return { byId, byTitle, itemCount, rawItemCount: payload.removed_apps.length, unknownCategoryCount, categoryCounts };
}

async function readBoundedJsonResponse(response) {
  if (response.redirected) rejectSecurity('redirect', 'Steam Tracker redirected to another URL');
  if (response.url && response.url !== STEAM_TRACKER_URL) rejectSecurity('unexpected-url', 'Steam Tracker response URL changed');
  const contentType = String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') rejectSecurity('invalid-mime', 'Steam Tracker did not return application/json');
  const disposition = String(response.headers?.get?.('content-disposition') ?? '').toLowerCase();
  if (disposition.includes('attachment')) rejectSecurity('attachment', 'Steam Tracker returned an attachment');
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > STEAM_TRACKER_MAX_BODY_BYTES) {
    rejectSecurity('body-too-large', 'Steam Tracker response exceeds 4.5 MiB', { receivedBytes: declaredLength });
  }

  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > STEAM_TRACKER_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        rejectSecurity('body-too-large', 'Steam Tracker response exceeds 4.5 MiB', { receivedBytes: total });
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  } else {
    const text = typeof response.text === 'function'
      ? await response.text()
      : JSON.stringify(await response.json());
    bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > STEAM_TRACKER_MAX_BODY_BYTES) {
      rejectSecurity('body-too-large', 'Steam Tracker response exceeds 4.5 MiB', { receivedBytes: bytes.byteLength });
    }
  }
  try {
    return {
      payload: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      receivedBytes: bytes.byteLength,
    };
  } catch {
    rejectSecurity('invalid-json', 'Steam Tracker returned invalid UTF-8 JSON', { receivedBytes: bytes.byteLength });
  }
}

function trackerCandidate(snapshot, appId) {
  const record = snapshot?.byId?.[appId];
  if (!record) return null;
  return {
    appId,
    type: 'app',
    title: record.name,
    removal: createRemovalRecord(record.categoryId, snapshot.fetchedAt),
  };
}

function classifyCandidates(snapshot, appIds, linkedAppId = null) {
  const candidates = appIds.map(appId => trackerCandidate(snapshot, appId)).filter(Boolean);
  if (candidates.length === 0) return null;
  const linked = linkedAppId && candidates.find(candidate => candidate.appId === String(linkedAppId));
  if (linked) return { kind: 'resolved', match: 'exact-linked', ...linked, candidates };
  if (candidates.length === 1) return { kind: 'resolved', match: 'exact', ...candidates[0], candidates };
  const statuses = new Set(candidates.map(candidate => candidate.removal?.status).filter(Boolean));
  if (statuses.size === 1) {
    return { kind: 'status-only', match: 'exact-duplicate', removal: candidates[0].removal, candidates };
  }
  return { kind: 'ambiguous', match: 'exact-duplicate', candidates };
}

export function createSteamTrackerClient({
  fetchImpl = (...args) => globalThis.fetch(...args),
  storage = defaultStorage(),
  now = () => Date.now(),
  sleep = wait,
  random = Math.random,
  securityProfile = null,
  fallbackSnapshot = null,
  baselineRevision = null,
} = {}) {
  let snapshot = null;
  let requestState = normalizeRequestState(null);
  let securityState = null;
  let securityAlert = null;
  let loadPromise = null;
  let refreshPromise = null;
  let activeController = null;
  let generation = 0;
  let writeChain = Promise.resolve();

  function serializeWrite(task) {
    const result = writeChain.then(task, task);
    writeChain = result.catch(() => {});
    return result;
  }

  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      const stored = await storage.get([
        STEAM_TRACKER_CACHE_KEY,
        STEAM_TRACKER_REQUEST_STATE_KEY,
        STEAM_TRACKER_SECURITY_STATE_KEY,
        STEAM_TRACKER_SECURITY_ALERT_KEY,
      ]);
      snapshot = normalizeCache(stored[STEAM_TRACKER_CACHE_KEY])
        ?? normalizeCache(fallbackSnapshot ? structuredClone(fallbackSnapshot) : null);
      requestState = normalizeRequestState(stored[STEAM_TRACKER_REQUEST_STATE_KEY]);
      const storedSecurity = stored[STEAM_TRACKER_SECURITY_STATE_KEY];
      securityState = storedSecurity?.locked === true && storedSecurity.baselineRevision === baselineRevision
        ? storedSecurity
        : null;
      const storedAlert = stored[STEAM_TRACKER_SECURITY_ALERT_KEY];
      const alertMatchesLock = securityState
        && storedAlert?.id === securityState.incidentId
        && (!storedAlert.baselineRevision || storedAlert.baselineRevision === baselineRevision);
      securityAlert = alertMatchesLock ? {
        ...storedAlert,
        baselineRevision,
        reasonCode: storedAlert.reasonCode ?? securityState.reasonCode ?? null,
        lastSafeFetchedAt: storedAlert.lastSafeFetchedAt ?? snapshot?.fetchedAt ?? null,
      } : null;
      if ((storedSecurity || storedAlert) && (!securityState || !securityAlert)) {
        await storage.set({
          [STEAM_TRACKER_SECURITY_STATE_KEY]: null,
          [STEAM_TRACKER_SECURITY_ALERT_KEY]: null,
        }).catch(() => {});
      }
      return snapshot;
    })().catch(() => snapshot);
    return loadPromise;
  }

  function isFresh(cache = snapshot) {
    return !!cache && now() - cache.fetchedAt < STEAM_TRACKER_TTL_MS;
  }

  async function getRemovalStatuses(items = []) {
    await load();
    const statuses = {};
    for (const item of items) {
      const type = item?.type ?? 'app';
      const appId = validAppId(item?.id ?? item?.appId);
      if (type !== 'app' || !appId) continue;
      const categoryId = snapshot?.byId?.[appId]?.categoryId;
      if (categoryId == null) continue;
      statuses[`app:${appId}`] = createRemovalRecord(categoryId, snapshot.fetchedAt);
    }
    return {
      statuses,
      revision: snapshot?.revision ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null,
      stale: snapshot ? !isFresh(snapshot) : true,
      hasCache: !!snapshot,
      nextAllowedAt: requestState.nextAllowedAt || null,
    };
  }

  async function getRemovalMatches(items = [], { includeFuzzy = true } = {}) {
    await load();
    const matches = items.map(item => {
      const title = String(item?.title ?? '').trim();
      const normalized = normalizeTitle(title);
      if (!snapshot || !normalized) return null;
      const exactIds = snapshot.byTitle[normalized] ?? [];
      const exact = classifyCandidates(snapshot, exactIds, item?.linkedAppId);
      if (exact) return exact;
      if (!includeFuzzy) return null;

      let bestScore = 0;
      let bestTitles = [];
      for (const indexedTitle of Object.keys(snapshot.byTitle)) {
        const score = wordSimilarity(normalized, indexedTitle);
        if (score < STEAM_TRACKER_FUZZY_THRESHOLD) continue;
        if (score > bestScore) {
          bestScore = score;
          bestTitles = [indexedTitle];
        } else if (score === bestScore) {
          bestTitles.push(indexedTitle);
        }
      }
      if (bestTitles.length === 0) return null;
      const candidateIds = [...new Set(bestTitles.flatMap(key => snapshot.byTitle[key] ?? []))];
      return {
        kind: 'fuzzy',
        match: 'fuzzy',
        similarity: Math.round(bestScore * 100),
        candidates: candidateIds.map(appId => trackerCandidate(snapshot, appId)).filter(Boolean).slice(0, 5),
      };
    });
    return {
      matches,
      revision: snapshot?.revision ?? null,
      fetchedAt: snapshot?.fetchedAt ?? null,
      stale: snapshot ? !isFresh(snapshot) : true,
      hasCache: !!snapshot,
    };
  }

  async function persistFailure(status, retryAfter = null) {
    const timestamp = now();
    const failureCount = requestState.failureCount + 1;
    const exponential = Math.min(
      MAX_FAILURE_COOLDOWN_MS,
      BASE_FAILURE_COOLDOWN_MS * (2 ** Math.max(0, failureCount - 1))
    );
    const jitter = Math.round(exponential * 0.1 * random());
    requestState = {
      schemaVersion: STEAM_TRACKER_SCHEMA_VERSION,
      nextAllowedAt: timestamp + Math.max(retryAfter ?? 0, exponential + jitter),
      failureCount,
      lastStatus: status ?? 'network-error',
      lastFailureAt: timestamp,
    };
    await serializeWrite(() => storage.set({ [STEAM_TRACKER_REQUEST_STATE_KEY]: requestState }));
  }

  async function persistSecurityFailure(error) {
    const timestamp = now();
    const id = `${baselineRevision ?? 'unversioned'}:${error.code}:${error.receivedBytes ?? 0}`;
    securityState = {
      locked: true,
      baselineRevision,
      incidentId: id,
      reasonCode: error.code,
      lockedAt: timestamp,
    };
    securityAlert = {
      id,
      baselineRevision,
      severity: 'critical',
      reasonCode: error.code,
      firstSeenAt: securityAlert?.id === id ? securityAlert.firstSeenAt : timestamp,
      lastSeenAt: timestamp,
      receivedBytes: Number(error.receivedBytes) || null,
      lastSafeFetchedAt: snapshot?.fetchedAt ?? null,
      dismissed: securityAlert?.id === id ? securityAlert.dismissed === true : false,
    };
    await serializeWrite(() => storage.set({
      [STEAM_TRACKER_SECURITY_STATE_KEY]: securityState,
      [STEAM_TRACKER_SECURITY_ALERT_KEY]: securityAlert,
    }));
  }

  async function refresh(forceRefresh) {
    await load();
    if (securityState?.locked) {
      return { ok: false, refreshed: false, changed: false, securityLocked: true, securityAlert, snapshot };
    }
    if (!forceRefresh && isFresh()) {
      return { ok: true, refreshed: false, changed: false, snapshot };
    }
    if (now() < requestState.nextAllowedAt) {
      return { ok: false, refreshed: false, changed: false, cooldown: true, snapshot, nextAllowedAt: requestState.nextAllowedAt };
    }

    const myGeneration = generation;
    const deadline = now() + REQUEST_BUDGET_MS;
    let lastStatus = null;
    let lastRetryAfter = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && now() < deadline; attempt++) {
      if (myGeneration !== generation) {
        return { ok: false, cancelled: true, refreshed: false, changed: false, snapshot };
      }
      const remaining = Math.max(1, deadline - now());
      const controller = new AbortController();
      activeController = controller;
      const timeout = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await fetchImpl(STEAM_TRACKER_URL, {
          signal: controller.signal,
          cache: 'no-store',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          headers: { Accept: 'application/json' },
        });
        lastStatus = response.status;
        if (response.status === 429) {
          lastRetryAfter = parseRetryAfterMs(response, now());
          if (attempt + 1 < MAX_ATTEMPTS && lastRetryAfter != null && lastRetryAfter < deadline - now()) {
            await sleep(lastRetryAfter);
            continue;
          }
          break;
        }
        if (!response.ok) {
          if (response.status >= 500 && attempt + 1 < MAX_ATTEMPTS) {
            await sleep(Math.min(500 * (2 ** attempt), Math.max(0, deadline - now())));
            continue;
          }
          break;
        }
        const { payload: responsePayload, receivedBytes } = await readBoundedJsonResponse(response);
        const parsed = parseSteamTrackerPayload(responsePayload, { securityProfile });
        if (myGeneration !== generation) return { ok: false, cancelled: true, refreshed: false, changed: false, snapshot };
        const timestamp = now();
        const changed = !mapsEqual(snapshot?.byId, parsed.byId);
        const nextSnapshot = {
          schemaVersion: STEAM_TRACKER_SCHEMA_VERSION,
          fetchedAt: timestamp,
          revision: changed || !snapshot?.revision ? newRevision(timestamp) : snapshot.revision,
          ...parsed,
        };
        const nextRequestState = normalizeRequestState({ schemaVersion: STEAM_TRACKER_SCHEMA_VERSION });
        await serializeWrite(async () => {
          if (myGeneration !== generation) return;
          await storage.set({
            ...(snapshot ? { [STEAM_TRACKER_PREVIOUS_CACHE_KEY]: snapshot } : {}),
            [STEAM_TRACKER_CACHE_KEY]: nextSnapshot,
            [STEAM_TRACKER_REQUEST_STATE_KEY]: nextRequestState,
            [STEAM_TRACKER_SECURITY_STATE_KEY]: null,
            [STEAM_TRACKER_SECURITY_ALERT_KEY]: null,
          });
        });
        if (myGeneration !== generation) return { ok: false, cancelled: true, refreshed: false, changed: false, snapshot };
        snapshot = nextSnapshot;
        requestState = nextRequestState;
        securityState = null;
        securityAlert = null;
        return { ok: true, refreshed: true, changed, receivedBytes, snapshot };
      } catch (error) {
        if (error instanceof SteamTrackerSecurityError) {
          if (myGeneration === generation) await persistSecurityFailure(error).catch(() => {});
          return {
            ok: false,
            refreshed: false,
            changed: false,
            securityLocked: true,
            securityAlert,
            status: error.code,
            snapshot,
          };
        }
        lastStatus = error?.name === 'AbortError' ? 'timeout' : 'network-error';
        if (attempt + 1 < MAX_ATTEMPTS && now() < deadline) {
          await sleep(Math.min(500 * (2 ** attempt), Math.max(0, deadline - now())));
          continue;
        }
      } finally {
        clearTimeout(timeout);
        if (activeController === controller) activeController = null;
      }
    }
    if (myGeneration === generation) {
      try {
        await persistFailure(lastStatus, lastRetryAfter);
      } catch {
        // Keep the in-memory cooldown even when extension storage is unavailable.
      }
    }
    return {
      ok: false,
      refreshed: false,
      changed: false,
      snapshot,
      status: lastStatus,
      nextAllowedAt: requestState.nextAllowedAt,
    };
  }

  function ensureSteamTrackerData({ forceRefresh = false } = {}) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = refresh(forceRefresh).finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function getActiveSecurityAlert() {
    await load();
    return securityState?.locked && securityAlert && !securityAlert.dismissed
      ? { ...securityAlert }
      : null;
  }

  async function dismissSecurityAlert(alertId) {
    await load();
    if (!securityAlert || securityAlert.id !== alertId) return { ok: true, stale: true };
    securityAlert = { ...securityAlert, dismissed: true, dismissedAt: now() };
    await serializeWrite(() => storage.set({ [STEAM_TRACKER_SECURITY_ALERT_KEY]: securityAlert }));
    return { ok: true };
  }

  async function reset() {
    generation++;
    activeController?.abort();
    activeController = null;
    refreshPromise = null;
    loadPromise = null;
    snapshot = null;
    requestState = normalizeRequestState(null);
    securityState = null;
    securityAlert = null;
    await writeChain;
  }

  return {
    ensureSteamTrackerData,
    getRemovalStatuses,
    getRemovalMatches,
    getActiveSecurityAlert,
    dismissSecurityAlert,
    reset,
    getSnapshot: () => snapshot,
    getRequestState: () => requestState,
    getSecurityState: () => securityState,
    getSecurityAlert: () => securityAlert,
  };
}

export const steamTrackerClient = createSteamTrackerClient({
  securityProfile: DEFAULT_SECURITY_PROFILE,
  fallbackSnapshot: STEAM_TRACKER_BASELINE_SNAPSHOT,
  baselineRevision: STEAM_TRACKER_BASELINE_META.revision,
});
export const ensureSteamTrackerData = steamTrackerClient.ensureSteamTrackerData;
export const getRemovalStatuses = steamTrackerClient.getRemovalStatuses;
export const getRemovalMatches = steamTrackerClient.getRemovalMatches;
