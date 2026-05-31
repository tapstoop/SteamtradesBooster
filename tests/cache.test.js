// tests/cache.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock chrome.storage.local
const store = {};
global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((keys, cb) => {
        const result = {};
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(k => { if (store[k] !== undefined) result[k] = store[k]; });
        cb(result);
      }),
      set: vi.fn((obj, cb) => {
        Object.assign(store, obj);
        if (cb) cb();
      }),
      remove: vi.fn((keys, cb) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        keyList.forEach(k => delete store[k]);
        if (cb) cb();
      }),
      clear: vi.fn((cb) => {
        Object.keys(store).forEach(k => delete store[k]);
        if (cb) cb();
      }),
    }
  }
};

import { DIAGNOSTICS_KEY } from '../background/diagnostics.js';
import { cacheGet, cacheSet, cacheHas, cacheClear, cacheDelete } from '../background/cache.js';

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
  vi.clearAllMocks();
});

describe('cacheSet / cacheGet', () => {
  it('stores and retrieves a value', async () => {
    await cacheSet('test:key', { foo: 'bar' }, 3600);
    const result = await cacheGet('test:key');
    expect(result.value).toEqual({ foo: 'bar' });
    expect(typeof result.cachedAt).toBe('number');
  });

  it('returns null for missing key', async () => {
    const result = await cacheGet('missing:key');
    expect(result).toBeNull();
  });

  it('returns null for expired entry', async () => {
    const pastTs = Date.now() - 10000;
    store['test:expired'] = { value: 'old', expiresAt: pastTs };
    const result = await cacheGet('test:expired');
    expect(result).toBeNull();
  });

  it('returns value for permanent entry (ttl = 0)', async () => {
    await cacheSet('test:perm', 'hello', 0);
    const result = await cacheGet('test:perm');
    expect(result.value).toBe('hello');
    expect(typeof result.cachedAt).toBe('number');
  });
});

describe('cacheHas', () => {
  it('returns true for valid cached entry', async () => {
    await cacheSet('test:has', 42, 3600);
    expect(await cacheHas('test:has')).toBe(true);
  });

  it('returns false for expired entry', async () => {
    store['test:exp'] = { value: 1, expiresAt: Date.now() - 1 };
    expect(await cacheHas('test:exp')).toBe(false);
  });
});

describe('cacheDelete', () => {
  it('removes a key from storage', async () => {
    await cacheSet('price:10:eu', { currentRetail: 500 }, 0);
    const before = await cacheGet('price:10:eu');
    expect(before).not.toBeNull();

    await cacheDelete('price:10:eu');

    const after = await cacheGet('price:10:eu');
    expect(after).toBeNull();
  });
});

describe('cacheClear', () => {
  it('preserves diagnostics while clearing cache data', async () => {
    store[DIAGNOSTICS_KEY] = { activeUrl: 'https://www.steamtrades.com/trade/abc/test' };
    store['price:10:eu'] = { value: { title: 'Game' }, expiresAt: 0 };

    await cacheClear();

    expect(store[DIAGNOSTICS_KEY]).toEqual({ activeUrl: 'https://www.steamtrades.com/trade/abc/test' });
    expect(store['price:10:eu']).toBeUndefined();
  });
});
