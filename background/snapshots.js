// background/snapshots.js

const DB_NAME = 'st-price-tracker';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const DEFAULT_WINDOW_DAYS = 180;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { autoIncrement: true });
        store.createIndex('byAppRegion', ['appId', 'region'], { unique: false });
        store.createIndex('byTimestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
  return dbPromise;
}

/**
 * Write a daily snapshot for a game.
 * @param {{ appId: string, region: string, currentRetail: number, currentKeyshops: number|null }} snap
 */
export async function writeSnapshot(snap) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.add({ ...snap, timestamp: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

/**
 * Get all snapshots for a game+region within the rolling window.
 * @returns {{ timestamp: number, currentRetail: number, currentKeyshops: number|null }[]}
 */
export async function getSnapshots(appId, region, windowDays = DEFAULT_WINDOW_DAYS) {
  const db = await openDB();
  const cutoff = Date.now() - windowDays * 86400 * 1000;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('byAppRegion');
    const req = index.getAll([appId, region]);
    req.onsuccess = () => {
      resolve(req.result.filter(s => s.timestamp >= cutoff));
    };
    req.onerror = e => reject(e.target.error);
  });
}

/**
 * Returns { min, max, median, count } for currentRetail over the window.
 * Returns null if fewer than 7 days of data exist.
 */
export async function getPriceRange(appId, region, windowDays = DEFAULT_WINDOW_DAYS) {
  const snaps = await getSnapshots(appId, region, windowDays);
  // Check if we have data from at least 7 distinct days
  const days = new Set(snaps.map(s => new Date(s.timestamp).toDateString()));
  if (days.size < 7) return null;

  const prices = snaps.map(s => s.currentRetail).filter(p => p != null).sort((a, b) => a - b);
  if (prices.length === 0) return null;

  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 0
    ? (prices[mid - 1] + prices[mid]) / 2
    : prices[mid];

  return { min: prices[0], max: prices[prices.length - 1], median, count: prices.length };
}

/**
 * Delete snapshots older than windowDays. Run after each daily fetch.
 */
export async function pruneOldSnapshots(windowDays = DEFAULT_WINDOW_DAYS) {
  const db = await openDB();
  const cutoff = Date.now() - windowDays * 86400 * 1000;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const index = tx.objectStore(STORE_NAME).index('byTimestamp');
    const range = IDBKeyRange.upperBound(cutoff);
    const req = index.openCursor(range);
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}
