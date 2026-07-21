import { describe, expect, it, vi } from 'vitest';
import {
  createSteamTrackerClient,
  mapTrackerCategory,
  parseSteamTrackerPayload,
  STEAM_TRACKER_CACHE_KEY,
  STEAM_TRACKER_REQUEST_STATE_KEY,
  STEAM_TRACKER_SECURITY_ALERT_KEY,
  STEAM_TRACKER_SECURITY_STATE_KEY,
  STEAM_TRACKER_MAX_BODY_BYTES,
} from '../background/steam-tracker.js';

function createStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter(key => key in values).map(key => [key, structuredClone(values[key])]));
    },
    async set(patch) {
      Object.assign(values, structuredClone(patch));
    },
  };
}

function response(payload, { status = 200, headers = {} } = {}) {
  const responseHeaders = { 'content-type': 'application/json', ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => responseHeaders[name] ?? responseHeaders[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}

const payload = {
  success: true,
  removed_apps: [
    { appid: 10, name: 'Delisted Game', type: 'game', category_id: 1, category: 'Delisted' },
    { appid: 20, name: 'Disabled Game', type: 'game', category_id: 3, category: 'Purchase disabled' },
    { appid: 30, name: 'Banned Game', type: 'game', category_id: 20, category: 'Banned' },
    { appid: 40, type: 'video', category_id: 1, category: 'Delisted video' },
    { appid: 50, type: 'game', category_id: 13, category: 'Unreleased' },
  ],
};

describe('Steam Tracker payload parsing', () => {
  it('maps only supported game categories', () => {
    expect(mapTrackerCategory(payload.removed_apps[0])).toEqual({
      appId: '10', status: 'removed_delisted', categoryId: 1, name: 'Delisted Game',
    });
    expect(mapTrackerCategory(payload.removed_apps[3])).toBeNull();
    expect(mapTrackerCategory(payload.removed_apps[4])).toBeNull();

    const parsed = parseSteamTrackerPayload(payload);
    expect(parsed.byId).toEqual({
      10: { categoryId: 1, name: 'Delisted Game' },
      20: { categoryId: 3, name: 'Disabled Game' },
      30: { categoryId: 20, name: 'Banned Game' },
    });
    expect(parsed.itemCount).toBe(3);
    expect(parsed.unknownCategoryCount).toBe(1);
    expect(parsed.categoryCounts).toEqual({
      removed_delisted: 1,
      removed_disabled: 1,
      removed_banned: 1,
    });
  });

  it('uses deterministic severity for duplicate app records', () => {
    const parsed = parseSteamTrackerPayload({
      success: true,
      removed_apps: [
        { appid: 99, name: 'Conflict', type: 'game', category_id: 1 },
        { appid: 99, name: 'Conflict', type: 'game', category_id: 20 },
        { appid: 99, name: 'Conflict', type: 'game', category_id: 3 },
      ],
    });
    expect(parsed.byId['99'].categoryId).toBe(20);
  });

  it('rejects malformed and empty supported datasets', () => {
    expect(() => parseSteamTrackerPayload({ success: false, removed_apps: [] })).toThrow();
    expect(() => parseSteamTrackerPayload({
      success: true,
      removed_apps: [{ appid: 1, type: 'video', category_id: 1 }],
    })).toThrow();
  });
});

describe('Steam Tracker client', () => {
  it('discards a stale alert that has no active lock for the packaged baseline', async () => {
    const storage = createStorage({
      [STEAM_TRACKER_SECURITY_STATE_KEY]: {
        locked: true,
        incidentId: 'old-incident',
        baselineRevision: 'old-baseline',
      },
      [STEAM_TRACKER_SECURITY_ALERT_KEY]: {
        id: 'old-incident',
        baselineRevision: 'old-baseline',
        dismissed: false,
      },
    });
    const client = createSteamTrackerClient({
      storage,
      fetchImpl: vi.fn(),
      baselineRevision: 'current-baseline',
    });

    await expect(client.getActiveSecurityAlert()).resolves.toBeNull();
    expect(storage.values[STEAM_TRACKER_SECURITY_STATE_KEY]).toBeNull();
    expect(storage.values[STEAM_TRACKER_SECURITY_ALERT_KEY]).toBeNull();
    await expect(client.dismissSecurityAlert('old-incident')).resolves.toEqual({ ok: true, stale: true });
  });

  it('rejects a non-JSON response and persists a security lock without replacing safe data', async () => {
    const safe = {
      schemaVersion: 3,
      fetchedAt: 1,
      revision: 'safe',
      byId: { 10: { categoryId: 1, name: 'Delisted' } },
      byTitle: { delisted: ['10'] },
    };
    const storage = createStorage({ [STEAM_TRACKER_CACHE_KEY]: safe });
    const fetchImpl = vi.fn(async () => response(payload, {
      headers: { 'content-type': 'text/html' },
    }));
    const client = createSteamTrackerClient({ storage, fetchImpl, now: () => 10_000 });

    const result = await client.ensureSteamTrackerData({ forceRefresh: true });

    expect(result).toMatchObject({ ok: false, securityLocked: true, status: 'invalid-mime' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(storage.values[STEAM_TRACKER_CACHE_KEY]).toEqual(safe);
    expect(storage.values[STEAM_TRACKER_SECURITY_STATE_KEY]).toMatchObject({
      locked: true, reasonCode: 'invalid-mime',
    });
    expect(storage.values[STEAM_TRACKER_SECURITY_ALERT_KEY]).toMatchObject({
      reasonCode: 'invalid-mime', dismissed: false, lastSafeFetchedAt: 1,
    });
  });

  it('rejects a declared response larger than 4.5 MiB before reading it', async () => {
    const storage = createStorage();
    const fetchImpl = vi.fn(async () => response(payload, {
      headers: { 'content-length': String(STEAM_TRACKER_MAX_BODY_BYTES + 1) },
    }));
    const client = createSteamTrackerClient({ storage, fetchImpl, now: () => 1_000 });

    await expect(client.ensureSteamTrackerData()).resolves.toMatchObject({
      securityLocked: true,
      status: 'body-too-large',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a structurally valid but anomalous dataset', async () => {
    const storage = createStorage();
    const client = createSteamTrackerClient({
      storage,
      fetchImpl: vi.fn(async () => response(payload)),
      now: () => 1_000,
      securityProfile: {
        rawItemCount: 100,
        itemCount: 100,
        categoryCounts: {},
        maxRawDelta: 0.01,
        maxItemDelta: 0.01,
        maxCategoryDelta: 0.01,
      },
    });

    await expect(client.ensureSteamTrackerData()).resolves.toMatchObject({
      securityLocked: true,
      status: 'raw-count-anomaly',
    });
    expect(storage.values[STEAM_TRACKER_CACHE_KEY]).toBeUndefined();
  });

  it('matches titles without links and handles duplicate/conflicting candidates safely', async () => {
    const storage = createStorage({
      [STEAM_TRACKER_CACHE_KEY]: {
        schemaVersion: 3,
        fetchedAt: 9_500,
        revision: 'titles',
        byId: {
          10: { categoryId: 20, name: 'Castle Rencounter' },
          20: { categoryId: 1, name: 'Same Name' },
          21: { categoryId: 1, name: 'Same Name' },
          30: { categoryId: 1, name: 'Conflict' },
          31: { categoryId: 3, name: 'Conflict' },
          40: { categoryId: 20, name: 'The Great Adventures of Castle Rencounter Deluxe' },
        },
        byTitle: {
          'castle rencounter': ['10'],
          'same name': ['20', '21'],
          conflict: ['30', '31'],
          'the great adventures of castle rencounter deluxe': ['40'],
        },
      },
    });
    const client = createSteamTrackerClient({ storage, fetchImpl: vi.fn(), now: () => 10_000 });

    const result = await client.getRemovalMatches([
      { title: 'Castle Rencounter' },
      { title: 'Same Name' },
      { title: 'Conflict' },
      { title: 'Conflict', linkedAppId: '31' },
      { title: 'The Great Adventures of Castle Rencounter' },
    ]);

    expect(result.matches[0]).toMatchObject({ kind: 'resolved', appId: '10' });
    expect(result.matches[1]).toMatchObject({ kind: 'status-only', removal: { status: 'removed_delisted' } });
    expect(result.matches[2]).toMatchObject({ kind: 'ambiguous' });
    expect(result.matches[3]).toMatchObject({ kind: 'resolved', appId: '31', match: 'exact-linked' });
    expect(result.matches[4]).toMatchObject({ kind: 'fuzzy' });
  });

  it('serves typed cache-only lookups without fetching', async () => {
    const storage = createStorage({
      [STEAM_TRACKER_CACHE_KEY]: {
        schemaVersion: 3,
        fetchedAt: 9_500,
        revision: 'r1',
        byId: {
          10: { categoryId: 1, name: 'Delisted' },
          20: { categoryId: 3, name: 'Disabled' },
        },
        byTitle: { delisted: ['10'], disabled: ['20'] },
      },
    });
    const fetchImpl = vi.fn();
    const client = createSteamTrackerClient({ storage, fetchImpl, now: () => 10_000 });

    const result = await client.getRemovalStatuses([
      { id: '10', type: 'app' },
      { id: '20', type: 'bundle' },
      { id: 'missing', type: 'app' },
    ]);

    expect(result.statuses['app:10']).toMatchObject({
      status: 'removed_delisted', categoryId: 1, categoryName: 'Delisted', observedAt: 9_500,
    });
    expect(result.statuses['app:20']).toBeUndefined();
    expect(result.revision).toBe('r1');
    expect(result.stale).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('coalesces concurrent cold refreshes and stores a compact map', async () => {
    const storage = createStorage();
    let release;
    const fetchImpl = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const client = createSteamTrackerClient({ storage, fetchImpl, now: () => 1000, random: () => 0 });

    const first = client.ensureSteamTrackerData();
    const second = client.ensureSteamTrackerData();
    while (!release) await Promise.resolve();
    release(response(payload));
    const [left, right] = await Promise.all([first, second]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(left.ok).toBe(true);
    expect(right.snapshot.revision).toBe(left.snapshot.revision);
    expect(storage.values[STEAM_TRACKER_CACHE_KEY].byId).toEqual({
      10: { categoryId: 1, name: 'Delisted Game' },
      20: { categoryId: 3, name: 'Disabled Game' },
      30: { categoryId: 20, name: 'Banned Game' },
    });
    expect(storage.values[STEAM_TRACKER_CACHE_KEY].removed_apps).toBeUndefined();
  });

  it('preserves stale data and persists cooldown across worker restarts', async () => {
    let clock = 10_000_000;
    const storage = createStorage({
      [STEAM_TRACKER_CACHE_KEY]: {
        schemaVersion: 3,
        fetchedAt: 1,
        revision: 'stale',
        byId: { 10: { categoryId: 1, name: 'Delisted' } },
        byTitle: { delisted: ['10'] },
      },
    });
    const fetchImpl = vi.fn(async () => response({}, { status: 503 }));
    const client = createSteamTrackerClient({
      storage,
      fetchImpl,
      now: () => clock,
      sleep: async ms => { clock += ms; },
      random: () => 0,
    });

    const failed = await client.ensureSteamTrackerData();
    expect(failed.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(storage.values[STEAM_TRACKER_CACHE_KEY].revision).toBe('stale');
    expect(storage.values[STEAM_TRACKER_REQUEST_STATE_KEY].nextAllowedAt).toBeGreaterThan(clock);

    const nextFetch = vi.fn();
    const restarted = createSteamTrackerClient({ storage, fetchImpl: nextFetch, now: () => clock });
    const cooldown = await restarted.ensureSteamTrackerData();
    expect(cooldown.cooldown).toBe(true);
    expect(nextFetch).not.toHaveBeenCalled();
    expect((await restarted.getRemovalStatuses([{ id: 10, type: 'app' }])).statuses['app:10']).toBeTruthy();
  });

  it('rejects a late refresh after reset', async () => {
    const storage = createStorage();
    let release;
    const fetchImpl = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const client = createSteamTrackerClient({ storage, fetchImpl, now: () => 1000 });
    const pending = client.ensureSteamTrackerData();
    while (!release) await Promise.resolve();
    await client.reset();
    release(response(payload));
    const result = await pending;

    expect(result.cancelled).toBe(true);
    expect(storage.values[STEAM_TRACKER_CACHE_KEY]).toBeUndefined();
  });

  it('returns a controlled failure when tracker storage writes fail', async () => {
    const storage = createStorage();
    storage.set = vi.fn(async () => { throw new Error('storage unavailable'); });
    let clock = 1_000;
    const fetchImpl = vi.fn(async () => response(payload));
    const client = createSteamTrackerClient({
      storage,
      fetchImpl,
      now: () => clock,
      sleep: async ms => { clock += ms; },
      random: () => 0,
    });

    await expect(client.ensureSteamTrackerData()).resolves.toMatchObject({
      ok: false,
      refreshed: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.getRequestState().failureCount).toBe(1);
  });

  it('does not start another retry after reset during backoff', async () => {
    const storage = createStorage();
    let releaseSleep;
    const fetchImpl = vi.fn(async () => response({}, { status: 503 }));
    const client = createSteamTrackerClient({
      storage,
      fetchImpl,
      now: () => 1_000,
      sleep: () => new Promise(resolve => { releaseSleep = resolve; }),
    });

    const pending = client.ensureSteamTrackerData();
    while (!releaseSleep) await Promise.resolve();
    await client.reset();
    releaseSleep();

    await expect(pending).resolves.toMatchObject({ cancelled: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
