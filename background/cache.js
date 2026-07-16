// background/cache.js
import { DIAGNOSTICS_KEY } from './diagnostics.js';

let revisionSequence = 0;

function createRevision() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  revisionSequence += 1;
  return `${Date.now()}-${revisionSequence}-${Math.random().toString(36).slice(2)}`;
}

export function cacheRevision(entry) {
  if (!entry) return 'missing';
  if (typeof entry.revision === 'string' && entry.revision) return entry.revision;
  return `legacy:${Number(entry.cachedAt) || 0}`;
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, result => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result[key] ?? null);
      }
    });
  });
}

function storageSet(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * @param {string} key
 * @param {*} value
 * @param {number} ttlSeconds — 0 means permanent
 */
export async function cacheSet(key, value, ttlSeconds) {
  const entry = {
    value,
    cachedAt: Date.now(),
    expiresAt: ttlSeconds === 0 ? 0 : Date.now() + ttlSeconds * 1000,
    revision: createRevision(),
  };
  await storageSet(key, entry);
  return entry.revision;
}

/**
 * @param {string} key
 * @returns {{ value: *, cachedAt: number }|null} — null if missing or expired
 */
export async function cacheGet(key) {
  const entry = await storageGet(key);
  if (!entry) return null;
  if (entry.expiresAt !== 0 && Date.now() > entry.expiresAt) return null;
  return {
    value: entry.value,
    cachedAt: entry.cachedAt,
    revision: cacheRevision(entry),
  };
}

export async function safeCacheGet(key) {
  try {
    return await cacheGet(key);
  } catch (err) {
    console.warn('[cache] Read failed:', key, err?.message ?? err);
    return null;
  }
}

/** @returns {boolean} */
export async function cacheHas(key) {
  return (await safeCacheGet(key)) !== null;
}

/**
 * Delete a specific key from storage.
 * @param {string} key
 */
export async function cacheDelete(key) {
  return new Promise(resolve => {
    chrome.storage.local.remove(key, () => {
      if (chrome.runtime.lastError) {
        console.warn('[cache] Failed to delete key:', key, chrome.runtime.lastError.message);
      }
      resolve();
    });
  });
}

function shouldPreserveKey(key, preserveKeys, preservePrefixes) {
  return key === DIAGNOSTICS_KEY
    || preserveKeys.includes(key)
    || preservePrefixes.some(prefix => key.startsWith(prefix));
}

export async function cacheClear({ preserveKeys = [], preservePrefixes = [] } = {}) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(null, stored => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const preserved = Object.fromEntries(Object.entries(stored ?? {})
        .filter(([key]) => shouldPreserveKey(key, preserveKeys, preservePrefixes)));
      chrome.storage.local.clear(() => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (Object.keys(preserved).length === 0) {
          resolve();
          return;
        }
        chrome.storage.local.set(preserved, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      });
    });
  });
}

/**
 * Mark a title resolution as dismissed (not a game).
 * @param {string} cacheKey — The resolution cache key
 */
export async function setDismissed(cacheKey) {
  await storageSet(`${cacheKey}:dismissed`, { value: '1', cachedAt: Date.now() });
}

/**
 * Mark a title resolution as undismissed (re-enable resolution).
 * @param {string} cacheKey — The resolution cache key
 */
export async function setUndismissed(cacheKey) {
  await storageSet(`${cacheKey}:dismissed`, { value: '0', cachedAt: Date.now() });
}

/**
 * Check if a title resolution was dismissed.
 * @param {string} cacheKey — The resolution cache key
 * @returns {boolean}
 */
export async function isDismissed(cacheKey) {
  try {
    const entry = await storageGet(`${cacheKey}:dismissed`);
    return entry?.value === '1';
  } catch (err) {
    console.warn('[cache] Dismissed read failed:', cacheKey, err?.message ?? err);
    return false;
  }
}

/**
 * Mark a title resolution as delisted.
 * @param {string} cacheKey — The resolution cache key
 */
export async function setDelisted(cacheKey) {
  await storageSet(`${cacheKey}:delisted`, { value: '1', cachedAt: Date.now() });
}

/**
 * Mark a title resolution as not delisted (undo delisted).
 * @param {string} cacheKey — The resolution cache key
 */
export async function setUndelisted(cacheKey) {
  await storageSet(`${cacheKey}:delisted`, { value: '0', cachedAt: Date.now() });
}

/**
 * Check if a title resolution was marked as delisted.
 * @param {string} cacheKey — The resolution cache key
 * @returns {boolean}
 */
export async function isDelisted(cacheKey) {
  try {
    const entry = await storageGet(`${cacheKey}:delisted`);
    return entry?.value === '1';
  } catch (err) {
    console.warn('[cache] Delisted read failed:', cacheKey, err?.message ?? err);
    return false;
  }
}
