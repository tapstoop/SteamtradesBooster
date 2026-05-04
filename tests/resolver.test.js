// tests/resolver.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store = {};
global.chrome = {
  runtime: { lastError: null },
  storage: {
    local: {
      get: vi.fn((key, cb) => cb({ [key]: store[key] ?? null })),
      set: vi.fn((obj, cb) => { Object.assign(store, obj); if (cb) cb(); }),
    }
  }
};

// Mock fetch for Steam search API
global.fetch = vi.fn();

import { resolveTitle, normalizeTitle } from '../background/resolver.js';

beforeEach(() => {
  Object.keys(store).forEach(k => delete store[k]);
  vi.clearAllMocks();
});

describe('normalizeTitle', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeTitle("Dark Souls™: Remastered")).toBe('dark souls remastered');
  });

  it('collapses whitespace', () => {
    expect(normalizeTitle('  Elden  Ring  ')).toBe('elden ring');
  });
});

describe('resolveTitle', () => {
  it('returns cached appId without fetching', async () => {
    store['resolve:sekiro'] = { value: '814380', expiresAt: 0 };
    const result = await resolveTitle('Sekiro');
    expect(result).toMatchObject({ appId: '814380', status: 'hit' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches Steam search and returns single match', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [{ id: 1245620, name: 'Elden Ring' }]
      })
    });
    const result = await resolveTitle('Elden Ring');
    expect(result).toMatchObject({ appId: '1245620', status: 'resolved' });
  });

  it('auto-resolves when top result exactly matches normalized title', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { id: 570940, name: 'Dark Souls' },
          { id: 211420, name: 'Dark Souls PTD Edition' },
        ]
      })
    });
    const result = await resolveTitle('Dark Souls');
    expect(result).toMatchObject({ appId: '570940', status: 'resolved' });
  });

  it('returns ambiguous status when multiple close matches', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          { id: 570940, name: 'Dark Souls Remastered' },
          { id: 211420, name: 'Dark Souls PTD Edition' },
        ]
      })
    });
    const result = await resolveTitle('Dark Souls');
    expect(result.status).toBe('ambiguous');
    expect(result.candidates.length).toBe(2);
  });

  it('returns not-found when Steam returns empty', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ items: [] })
    });
    const result = await resolveTitle('Nonexistent Game XYZ');
    expect(result).toMatchObject({ status: 'not-found' });
  });
});
