import { describe, it, expect, vi, beforeAll } from 'vitest';

global.chrome = {
  runtime: {
    getManifest: vi.fn(() => ({ version: 'test' })),
    lastError: null,
    onMessage: { addListener: vi.fn() },
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: vi.fn((keys, cb) => cb({})),
      set: vi.fn((obj, cb) => { if (cb) cb(); }),
    },
  },
  notifications: {
    create: vi.fn(),
  },
};

let normalizePriceMessageItems;

beforeAll(async () => {
  const mod = await import('../background/service-worker.js');
  normalizePriceMessageItems = mod.normalizePriceMessageItems;
});

describe('normalizePriceMessageItems', () => {
  it('handles legacy appIds format', () => {
    const result = normalizePriceMessageItems({ appIds: ['123', '456'] });
    expect(result).toEqual([
      { id: '123', type: 'app' },
      { id: '456', type: 'app' },
    ]);
  });

  it('handles new items format with types', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: '123', type: 'bundle' },
      { id: '456', type: 'app' },
    ] });
    expect(result).toEqual([
      { id: '123', type: 'bundle' },
      { id: '456', type: 'app' },
    ]);
  });

  it('handles items with appId field (legacy item shape)', () => {
    const result = normalizePriceMessageItems({ items: [
      { appId: '789', type: 'sub' },
    ] });
    expect(result).toEqual([
      { id: '789', type: 'sub' },
    ]);
  });

  it('defaults unknown type to app', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: '123', type: 'unknown' },
    ] });
    expect(result).toEqual([
      { id: '123', type: 'app' },
    ]);
  });

  it('deduplicates by type:id', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: '123', type: 'app' },
      { id: '123', type: 'app' },
    ] });
    expect(result).toHaveLength(1);
  });

  it('filters out undefined ids', () => {
    const result = normalizePriceMessageItems({ items: [
      { id: undefined, type: 'app' },
      { id: '123', type: 'app' },
    ] });
    expect(result).toEqual([{ id: '123', type: 'app' }]);
  });
});
