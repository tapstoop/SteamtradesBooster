import { describe, expect, it, vi } from 'vitest';
import { createSteamRequestScheduler, SteamRateLimitError } from '../background/steam-rate-limiter.js';

function makeStorage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    get: vi.fn(async key => values[key]),
    set: vi.fn(async (key, value) => { values[key] = value; }),
  };
}

describe('Steam request scheduler', () => {
  it('paces store page discovery at no more than two request starts per second', async () => {
    let clock = 0;
    const sleep = vi.fn(async ms => { clock += ms; });
    const fetchImpl = vi.fn(async () => ({ status: 200, ok: true, headers: { get: () => null } }));
    const scheduler = createSteamRequestScheduler({ fetchImpl, storage: makeStorage(), now: () => clock, sleep });

    await scheduler.steamFetch('https://store.steampowered.com/app/1', {}, { kind: 'storepage' });
    await scheduler.steamFetch('https://store.steampowered.com/bundle/2', {}, { kind: 'storepage' });

    expect(sleep).toHaveBeenCalledWith(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caps global in-flight requests and preserves map ordering', async () => {
    const storage = makeStorage();
    let clock = 0;
    const pending = [];
    const fetchImpl = vi.fn(() => new Promise(resolve => pending.push(resolve)));
    const scheduler = createSteamRequestScheduler({ fetchImpl, storage, now: () => clock, sleep: async ms => { clock += ms; } });
    const resultPromise = scheduler.mapSteamTasks([1, 2, 3, 4], async id => {
      await scheduler.steamFetch(`https://store.steampowered.com/${id}`, {}, { kind: 'appdetails' });
      return id;
    }, { concurrency: 4 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    pending.splice(0, 2).forEach(resolve => resolve({ status: 200, ok: true }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(4));
    pending.splice(0).forEach(resolve => resolve({ status: 200, ok: true }));
    await expect(resultPromise).resolves.toEqual([1, 2, 3, 4]);
  });

  it('restores durable blocks and throws a bounded typed error', async () => {
    let clock = 1000;
    const storage = makeStorage({ steam_rate_limit_state: {
      version: 1,
      policies: { store: { blockedUntil: 5000, nextAllowedAt: 0, consecutive429: 1 } },
    } });
    const sleep = vi.fn(async ms => { clock += ms; });
    const fetchImpl = vi.fn(async () => ({
      status: 429,
      ok: false,
      headers: { get: () => 'invalid' },
    }));
    const scheduler = createSteamRequestScheduler({ fetchImpl, storage, now: () => clock, sleep, random: () => 0, maxRetries: 2 });
    await expect(scheduler.steamFetch('https://store.steampowered.com/api/storesearch', {}, { kind: 'storesearch' }))
      .rejects.toBeInstanceOf(SteamRateLimitError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(storage.values.steam_rate_limit_state.policies.store.blockedUntil).toBeGreaterThan(clock);
    expect(sleep).toHaveBeenCalled();
  });

  it('does not clear a newer concurrent 429 block after another request succeeds', async () => {
    let clock = 0;
    const responses = [];
    const fetchImpl = vi.fn(() => new Promise(resolve => responses.push(resolve)));
    const scheduler = createSteamRequestScheduler({
      fetchImpl,
      storage: makeStorage(),
      now: () => clock,
      sleep: async ms => { clock += ms; },
      random: () => 0,
    });
    const first = scheduler.steamFetch('https://store.steampowered.com/1', {}, { kind: 'appdetails' });
    const second = scheduler.steamFetch('https://store.steampowered.com/2', {}, { kind: 'appdetails' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    responses.shift()({ status: 429, ok: false, headers: { get: () => null } });
    responses.shift()({ status: 200, ok: true, headers: { get: () => null } });
    await second;
    expect(scheduler.getState().policies.store.blockedUntil).toBeGreaterThanOrEqual(clock);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    responses.shift()({ status: 200, ok: true, headers: { get: () => null } });
    await first;
  });

  it('keeps the longest deadline when concurrent 429 responses disagree', async () => {
    let clock = 0;
    const responses = [];
    const fetchImpl = vi.fn(() => new Promise(resolve => responses.push(resolve)));
    const scheduler = createSteamRequestScheduler({
      fetchImpl,
      storage: makeStorage(),
      now: () => clock,
      sleep: async ms => { clock += ms; },
      random: () => 0,
      maxRetries: 0,
    });
    const first = scheduler.steamFetch('https://store.steampowered.com/1', {}, { kind: 'appdetails' });
    const second = scheduler.steamFetch('https://store.steampowered.com/2', {}, { kind: 'appdetails' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    responses.shift()({ status: 429, ok: false, headers: { get: () => '60' } });
    responses.shift()({ status: 429, ok: false, headers: { get: () => '1' } });
    await expect(first).rejects.toBeInstanceOf(SteamRateLimitError);
    await expect(second).rejects.toBeInstanceOf(SteamRateLimitError);
    expect(scheduler.getState().policies.store.blockedUntil).toBeGreaterThanOrEqual(60200);
  });

  it('honors an explicit long Retry-After without holding a retry slot', async () => {
    let clock = 1000;
    const fetchImpl = vi.fn(async () => ({
      status: 429,
      ok: false,
      headers: { get: () => '300' },
    }));
    const scheduler = createSteamRequestScheduler({
      fetchImpl,
      storage: makeStorage(),
      now: () => clock,
      sleep: async ms => { clock += ms; },
    });
    await expect(scheduler.steamFetch('https://store.steampowered.com/search', {}, { kind: 'storesearch' }))
      .rejects.toMatchObject({ name: 'SteamRateLimitError', retryAt: 301000, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ignores persisted timing when the clock moved backwards', async () => {
    let clock = 1000;
    const storage = makeStorage({ steam_rate_limit_state: {
      version: 1,
      policies: { storesearch: { nextAllowedAt: 20000, blockedUntil: 30000, updatedAt: 5000 } },
    } });
    const sleep = vi.fn(async ms => { clock += ms; });
    const fetchImpl = vi.fn(async () => ({ status: 200, ok: true, headers: { get: () => null } }));
    const scheduler = createSteamRequestScheduler({ fetchImpl, storage, now: () => clock, sleep });
    await scheduler.steamFetch('https://store.steampowered.com/search', {}, { kind: 'storesearch' });
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('releases a slot immediately when aborted during retry delay', async () => {
    const controller = new AbortController();
    let resolveSleep;
    const sleep = vi.fn(() => new Promise(resolve => { resolveSleep = resolve; }));
    const fetchImpl = vi.fn(async () => ({ status: 429, ok: false, headers: { get: () => null } }));
    const scheduler = createSteamRequestScheduler({ fetchImpl, storage: makeStorage(), sleep });
    const request = scheduler.steamFetch('https://store.steampowered.com/search', { signal: controller.signal }, { kind: 'storesearch' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveSleep?.();
  });

  it('removes an aborted queued request without dispatching it', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const scheduler = createSteamRequestScheduler({ fetchImpl, storage: makeStorage(), sleep: async () => {}, maxConcurrency: 1 });
    const first = scheduler.steamFetch('https://store.steampowered.com/1', {}, { kind: 'appdetails' });
    const second = scheduler.steamFetch('https://store.steampowered.com/2', { signal: controller.signal }, { kind: 'appdetails' });
    controller.abort();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    void first;
  });

  it('aborts active work and ignores stale state after reset', async () => {
    let rejectFetch;
    const fetchImpl = vi.fn((url, options) => new Promise((resolve, reject) => {
      rejectFetch = reject;
      options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    const scheduler = createSteamRequestScheduler({ fetchImpl, storage: makeStorage() });
    const request = scheduler.steamFetch('https://store.steampowered.com/1', {}, { kind: 'appdetails' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    await scheduler.reset();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(Object.keys(scheduler.getState().policies)).toHaveLength(0);
    rejectFetch?.(new DOMException('The operation was aborted.', 'AbortError'));
  });

  it('releases active slots on reset even when fetch ignores abort', async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const scheduler = createSteamRequestScheduler({
      fetchImpl,
      storage: makeStorage(),
      maxConcurrency: 1,
    });
    const first = scheduler.steamFetch('https://store.steampowered.com/1', {}, { kind: 'appdetails' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    await scheduler.reset();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });

    const second = scheduler.steamFetch('https://store.steampowered.com/2', {}, { kind: 'appdetails' });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    void second;
  });
});
