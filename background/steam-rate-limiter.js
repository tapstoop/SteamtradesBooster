const STATE_KEY = 'steam_rate_limit_state';
const STATE_VERSION = 1;
const RETRY_JOB = Symbol('retry-job');

const DEFAULT_POLICIES = {
  storesearch: { bucket: 'store', minIntervalMs: 200 },
  storepage: { bucket: 'store', minIntervalMs: 500 },
  appdetails: { bucket: 'store', minIntervalMs: 200 },
  packagedetails: { bucket: 'store', minIntervalMs: 200 },
  wishlist: { bucket: 'api', minIntervalMs: 200 },
  vanity: { bucket: 'community', minIntervalMs: 200 },
};

const HOST_KINDS = [
  ['store.steampowered.com', 'storesearch'],
  ['api.steampowered.com', 'wishlist'],
  ['steamcommunity.com', 'vanity'],
];

function defaultStorage() {
  return {
    get(key) {
      return new Promise((resolve, reject) => chrome.storage.local.get(key, result => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(result?.[key]);
      }));
    },
    set(key, value) {
      return new Promise((resolve, reject) => chrome.storage.local.set({ [key]: value }, () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      }));
    },
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function policyFor(kind, policies) {
  return { ...DEFAULT_POLICIES[kind] ?? DEFAULT_POLICIES.storesearch, ...(policies[kind] ?? {}) };
}

function normalizeState(value) {
  const source = value?.version === STATE_VERSION ? value : {};
  return {
    version: STATE_VERSION,
    policies: Object.fromEntries(Object.entries(source.policies ?? {}).map(([key, item]) => [key, {
      nextAllowedAt: Number(item?.nextAllowedAt) || 0,
      blockedUntil: Number(item?.blockedUntil) || 0,
      consecutive429: Number(item?.consecutive429) || 0,
      exponent: Number(item?.exponent) || 0,
      updatedAt: Number(item?.updatedAt) || 0,
      lastStatus: item?.lastStatus ?? null,
    }])),
  };
}

function retryAfterMs(response, now) {
  const value = response.headers?.get?.('Retry-After') ?? response.headers?.get?.('retry-after');
  if (value != null) {
    const seconds = Number(value.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - now);
  }
  return null;
}

export class SteamRateLimitError extends Error {
  constructor({ status, kind, retryAt, attempts }) {
    super(`Steam rate limit exhausted for ${kind} (HTTP ${status})`);
    this.name = 'SteamRateLimitError';
    this.status = status;
    this.kind = kind;
    this.retryAt = retryAt;
    this.attempts = attempts;
  }
}

export function createSteamRequestScheduler({
  fetchImpl = (...args) => globalThis.fetch(...args),
  storage = defaultStorage(),
  now = () => Date.now(),
  sleep = wait,
  random = Math.random,
  policies = {},
  maxConcurrency = 2,
  maxRetries = 2,
} = {}) {
  const state = normalizeState(null);
  const queue = [];
  let active = 0;
  let pumping = false;
  let initialized;
  let writeChain = Promise.resolve();
  const blockRevisions = new Map();
  const activeJobs = new Set();
  let wakeTimer = null;
  let storageGeneration = 0;
  let lifecycleGeneration = 0;

  const save = () => {
    const generation = storageGeneration;
    const snapshot = typeof structuredClone === 'function'
      ? structuredClone(state)
      : JSON.parse(JSON.stringify(state));
    writeChain = writeChain.then(() => {
      if (generation === storageGeneration) return storage.set(STATE_KEY, snapshot);
      return undefined;
    }).catch(() => {});
    return writeChain;
  };

  async function initialize() {
    const generation = lifecycleGeneration;
    try {
      const restored = normalizeState(await storage.get(STATE_KEY));
      if (generation !== lifecycleGeneration) return;
      const timestamp = now();
      for (const item of Object.values(restored.policies)) {
        if (item.updatedAt > timestamp || (item.updatedAt === 0
          && Math.max(item.nextAllowedAt, item.blockedUntil) > timestamp)) {
          item.nextAllowedAt = timestamp;
          item.blockedUntil = timestamp;
          item.updatedAt = timestamp;
        }
      }
      Object.assign(state, restored);
    } catch {
      // In-memory pacing remains authoritative when storage is unavailable.
    }
  }

  function ensureInitialized() {
    initialized ??= initialize();
    return initialized;
  }

  function kindFor(url, metadata) {
    if (metadata.kind) return metadata.kind;
    try {
      const host = new URL(url).hostname;
      return HOST_KINDS.find(([name]) => host === name)?.[1] ?? 'storesearch';
    } catch {
      return 'storesearch';
    }
  }

  function policyState(policy) {
    return state.policies[policy] ??= {
      nextAllowedAt: 0, blockedUntil: 0, consecutive429: 0, exponent: 0, updatedAt: 0, lastStatus: null,
    };
  }

  function bumpBlockRevision(key) {
    const next = (blockRevisions.get(key) ?? 0) + 1;
    blockRevisions.set(key, next);
    return next;
  }

  function currentBlockRevision(key) {
    return blockRevisions.get(key) ?? 0;
  }

  function abortError() {
    return new DOMException('The operation was aborted.', 'AbortError');
  }

  function sleepWithAbort(delay, signal) {
    if (!signal) return sleep(delay);
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => sleep(delay)).then(() => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
    });
  }

  function jobReadyAt(job) {
    const kind = kindFor(job.url, job.metadata);
    const policy = policyFor(kind, policies);
    const bucket = policy.bucket ?? kind;
    const kindState = policyState(kind);
    const bucketState = policyState(bucket);
    return Math.max(
      job.notBefore ?? 0,
      kindState.nextAllowedAt,
      kindState.blockedUntil,
      bucketState.nextAllowedAt,
      bucketState.blockedUntil,
    );
  }

  async function dispatch(job) {
    const kind = kindFor(job.url, job.metadata);
    const policy = policyFor(kind, policies);
    const bucket = policy.bucket ?? kind;
    const kindState = policyState(kind);
    const bucketState = policyState(bucket);
    if (job.generation !== lifecycleGeneration || job.cancelled || job.signal?.aborted) throw abortError();
    while (true) {
      if (job.generation !== lifecycleGeneration || job.cancelled || job.signal?.aborted) throw abortError();
      const timestamp = now();
      const waitUntil = jobReadyAt(job);
      if (waitUntil <= timestamp) break;
      await sleepWithAbort(waitUntil - timestamp, job.signal);
    }
    if (job.generation !== lifecycleGeneration || job.cancelled || job.signal?.aborted) throw abortError();
    job.notBefore = 0;
    const nextAllowedAt = Math.max(now(), kindState.nextAllowedAt, bucketState.nextAllowedAt) + (policy.minIntervalMs ?? 0);
    kindState.nextAllowedAt = nextAllowedAt;
    bucketState.nextAllowedAt = nextAllowedAt;
    kindState.updatedAt = now();
    bucketState.updatedAt = now();
    await save();
    const attempts = (job.attempts ?? 0) + 1;
    const kindRevision = currentBlockRevision(kind);
    const bucketRevision = currentBlockRevision(bucket);
    const response = await fetchImpl(job.url, { ...job.fetchOptions, signal: job.signal ?? job.fetchOptions.signal });
    if (job.generation !== lifecycleGeneration || job.cancelled) throw abortError();
    kindState.lastStatus = response.status;
    bucketState.lastStatus = response.status;
    kindState.updatedAt = now();
    bucketState.updatedAt = now();
    if (response.status !== 429) {
      if (currentBlockRevision(kind) === kindRevision) {
        kindState.consecutive429 = 0;
        kindState.exponent = 0;
        kindState.blockedUntil = 0;
      }
      if (currentBlockRevision(bucket) === bucketRevision) {
        bucketState.consecutive429 = 0;
        bucketState.exponent = 0;
        bucketState.blockedUntil = 0;
      }
      await save();
      return response;
    }
    kindState.consecutive429++;
    kindState.exponent = Math.min(30, kindState.exponent + 1);
    bumpBlockRevision(kind);
    bumpBlockRevision(bucket);
    bucketState.consecutive429 = Math.max(bucketState.consecutive429, kindState.consecutive429);
    bucketState.exponent = Math.max(bucketState.exponent, kindState.exponent);
    const explicitDelay = retryAfterMs(response, now());
    const fallback = Math.min(60000, 2000 * (2 ** (kindState.exponent - 1))) + random() * 250;
    const delay = explicitDelay ?? fallback;
    const blockedUntil = now() + Math.max(0, explicitDelay == null ? Math.min(60000, delay) : delay);
    const effectiveBlockedUntil = Math.max(kindState.blockedUntil, bucketState.blockedUntil, blockedUntil);
    kindState.blockedUntil = effectiveBlockedUntil;
    bucketState.blockedUntil = effectiveBlockedUntil;
    await save();
    if (attempts > maxRetries || (explicitDelay != null && explicitDelay > 60000)) {
      throw new SteamRateLimitError({ status: response.status, kind, retryAt: effectiveBlockedUntil, attempts });
    }
    job.attempts = attempts;
    job.notBefore = effectiveBlockedUntil;
    return RETRY_JOB;
  }

  function takeReadyJob() {
    const timestamp = now();
    const index = queue.findIndex(job => jobReadyAt(job) <= timestamp);
    return index === -1 ? null : queue.splice(index, 1)[0];
  }

  function rejectLongBlockedJobs() {
    const timestamp = now();
    for (let index = queue.length - 1; index >= 0; index--) {
      const job = queue[index];
      const retryAt = jobReadyAt(job);
      if (retryAt - timestamp <= 60000) continue;
      queue.splice(index, 1);
      job.cleanup?.();
      const kind = kindFor(job.url, job.metadata);
      job.reject(new SteamRateLimitError({
        status: 429,
        kind,
        retryAt,
        attempts: job.attempts ?? 0,
      }));
    }
  }

  function releaseJob(job) {
    if (job.released) return false;
    job.released = true;
    activeJobs.delete(job);
    active = Math.max(0, active - 1);
    job.cleanup?.();
    return true;
  }

  function scheduleWake() {
    if (wakeTimer || !queue.length) return;
    const nextAt = Math.min(...queue.map(job => jobReadyAt(job)));
    wakeTimer = true;
    Promise.resolve().then(() => sleep(Math.max(0, nextAt - now()))).then(() => {
      wakeTimer = null;
      pump();
    }, () => {
      wakeTimer = null;
      pump();
    });
  }

  async function reset() {
    lifecycleGeneration++;
    storageGeneration++;
    for (const job of queue.splice(0)) {
      job.cleanup?.();
      job.reject(abortError());
    }
    wakeTimer = null;
    for (const job of activeJobs) {
      job.cancelled = true;
      job.controller?.abort();
      job.reject(abortError());
      releaseJob(job);
    }
    for (const key of Object.keys(state.policies)) delete state.policies[key];
    blockRevisions.clear();
    initialized = null;
    await writeChain;
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      rejectLongBlockedJobs();
      while (active < maxConcurrency && queue.length) {
        rejectLongBlockedJobs();
        if (!queue.length) break;
        const job = takeReadyJob();
        if (!job) {
          scheduleWake();
          break;
        }
        if (job.signal?.aborted) {
          job.cleanup?.();
          job.reject(abortError());
          continue;
        }
        active++;
        activeJobs.add(job);
        let retrying = false;
        dispatch(job).then(result => {
          if (result === RETRY_JOB) {
            retrying = true;
            queue.push(job);
          }
          else job.resolve(result);
        }, job.reject).finally(() => {
          if (retrying) {
            activeJobs.delete(job);
            active = Math.max(0, active - 1);
          } else {
            releaseJob(job);
          }
          pump();
        });
      }
    } finally {
      pumping = false;
    }
  }

  function steamFetch(url, fetchOptions = {}, metadata = {}) {
    const signal = fetchOptions.signal ?? metadata.signal;
    const requestGeneration = lifecycleGeneration;
    return ensureInitialized().then(() => new Promise((resolve, reject) => {
      if (requestGeneration !== lifecycleGeneration) {
        reject(abortError());
        return;
      }
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const controller = new AbortController();
      const job = {
        url,
        fetchOptions,
        metadata,
        signal: controller.signal,
        userSignal: signal,
        controller,
        generation: requestGeneration,
        resolve,
        reject,
      };
      const abort = () => {
        const index = queue.indexOf(job);
        job.cancelled = true;
        job.controller.abort();
        if (index !== -1) {
          queue.splice(index, 1);
          job.cleanup();
          reject(abortError());
          pump();
        } else if (activeJobs.has(job)) {
          reject(abortError());
          releaseJob(job);
          pump();
        }
      };
      job.cleanup = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(job);
      pump();
    }));
  }

  async function mapSteamTasks(items, worker, { concurrency = 2, onSettled } = {}) {
    if (!items.length) return [];
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
        onSettled?.(results[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
  }

  return { steamFetch, mapSteamTasks, ensureInitialized, reset, getState: () => state };
}

const production = createSteamRequestScheduler();
export const steamFetch = production.steamFetch;
export const mapSteamTasks = production.mapSteamTasks;
export const steamRequestScheduler = production;
