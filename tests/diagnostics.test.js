import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const store = {};
const TEST_NOW_MS = Date.UTC(2026, 4, 31, 8, 0);

global.chrome = {
  storage: {
    local: {
      get: vi.fn((key, cb) => cb({ [key]: store[key] ?? null })),
      set: vi.fn((obj, cb) => { Object.assign(store, obj); if (cb) cb(); }),
    },
  },
};

const {
  DIAGNOSTICS_KEY,
  buildApiCallSummary,
  buildDiagnosticLog,
  buildQuotaBlockEvent,
  classifyQuotaWindow,
  formatDiagnosticDate,
  getBrowserLabel,
  getDiagnostics,
  recordGgDealsDiagnostics,
  sanitizeSteamTradesUrl,
  setDiagnostics,
  updateDiagnostics,
} = await import('../background/diagnostics.js');

beforeEach(() => {
  Object.keys(store).forEach(key => delete store[key]);
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(TEST_NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('diagnostic formatting', () => {
  it('formats timestamps as YYYY-MM-DD HH:MM', () => {
    expect(formatDiagnosticDate(new Date(2026, 4, 31, 7, 8, 25, 189).getTime()))
      .toBe('2026-05-31 07:08');
  });

  it('returns n/a for missing timestamps', () => {
    expect(formatDiagnosticDate(null)).toBe('n/a');
    expect(formatDiagnosticDate('not a date')).toBe('n/a');
  });

  it('labels Chrome on Linux without echoing the raw user agent', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

    expect(getBrowserLabel(ua)).toBe('Chrome 148 on Linux');
    expect(getBrowserLabel(ua)).not.toContain('Mozilla/5.0');
  });

  it('returns one best-effort browser label for common browsers', () => {
    expect(getBrowserLabel('Mozilla/5.0 Firefox/140.0')).toContain('Firefox 140');
    expect(getBrowserLabel('Mozilla/5.0 Edg/140.0.0.0')).toContain('Edge 140');
    expect(getBrowserLabel('', { brands: [{ brand: 'Brave' }], platform: 'Linux' })).toBe('Brave on Linux');
    expect(getBrowserLabel('')).toBe('Unknown browser on Unknown platform');
  });

  it('redacts SteamTrades query strings and fragments', () => {
    expect(sanitizeSteamTradesUrl('https://www.steamtrades.com/trade/abc/name?token=secret#reply'))
      .toBe('https://www.steamtrades.com/trade/abc/name');
    expect(sanitizeSteamTradesUrl('https://example.com/trade/abc')).toBe('');
  });
});

describe('quota diagnostics', () => {
  it('classifies per-minute 429 messages', () => {
    expect(classifyQuotaWindow({
      limit: 100,
      message: 'You can fetch prices info only for 100 games per minute. Try again later.',
    })).toBe('minute');
  });

  it('falls back to unknown when headers and messages do not identify the window', () => {
    expect(classifyQuotaWindow({ limit: 250, message: 'Too Many Requests' })).toBe('unknown');
  });

  it('builds quota block events with no partial data for 429 responses', () => {
    const event = buildQuotaBlockEvent({
      kind: '429',
      ids: ['10', '20', '30'],
      status: 429,
      limit: 100,
      remaining: 2,
      resetAt: Date.UTC(2026, 4, 31, 8, 0),
      message: 'You can fetch prices info only for 100 games per minute.',
      at: Date.UTC(2026, 4, 31, 7, 59),
      type: 'app',
      region: 'eu',
    });

    expect(event.bucket).toBe('minute');
    expect(event.requestedCount).toBe(3);
    expect(event.remaining).toBe(2);
    expect(event.noPartialData).toBe(true);
    expect(formatDiagnosticDate(event.observedAtMs)).toMatch(/^2026-05-31 \d{2}:59$/);
  });

  it('persists bounded API and quota histories', async () => {
    for (let i = 0; i < 12; i++) {
      const apiCall = buildApiCallSummary({
        ids: [String(i)],
        type: 'app',
        region: 'eu',
        status: i === 0 ? 429 : 200,
        at: Date.UTC(2026, 4, 31, 7, i),
      });
      const quotaBlock = buildQuotaBlockEvent({
        ids: [String(i)],
        status: 429,
        limit: 100,
        remaining: 0,
        at: Date.UTC(2026, 4, 31, 7, i),
      });
      await recordGgDealsDiagnostics({ apiCall, quotaBlock });
    }

    const stored = await getDiagnostics();
    expect(stored.lastApiCalls).toHaveLength(10);
    expect(stored.quotaBlocks).toHaveLength(10);
    expect(store[DIAGNOSTICS_KEY].lastApiCalls).toHaveLength(10);
  });
});

describe('classifyQuotaWindow', () => {
  it('classifies "limit of 1000 per hour" as hour bucket', () => {
    expect(classifyQuotaWindow({ message: 'limit of 1000 per hour' })).toBe('hour');
  });

  it('classifies "1000 hour" without "per" as hour bucket', () => {
    expect(classifyQuotaWindow({ message: '1000 hour limit' })).toBe('hour');
  });
});

describe('diagnostic log rendering', () => {
  it('renders redacted support log sections and retention policy', () => {
    const log = buildDiagnosticLog({
      manifestVersion: '0.1.3',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/148.0.0.0',
      activeUrl: 'https://www.steamtrades.com/trade/abc/test?secret=1#reply',
      generatedAt: Date.UTC(2026, 4, 31, 7, 48),
      diagnostics: {
        resolutionStats: { total: 3, hit: 1, ambiguous: 1, 'not-found': 1 },
        rateLimit: {
          limit: 100,
          remaining: 0,
          resetAt: Date.UTC(2026, 4, 31, 8, 0),
          lastUpdatedAt: Date.UTC(2026, 4, 31, 7, 47),
        },
        lastApiCalls: [buildApiCallSummary({ ids: ['1'], type: 'app', region: 'eu', status: 429, at: Date.UTC(2026, 4, 31, 7, 47) })],
        recent429Errors: [buildApiCallSummary({ ids: ['1'], type: 'app', region: 'eu', status: 429, at: Date.UTC(2026, 4, 31, 7, 47) })],
        quotaBlocks: [buildQuotaBlockEvent({ ids: ['1'], status: 429, limit: 100, remaining: 0, resetAt: Date.UTC(2026, 4, 31, 8, 0), at: Date.UTC(2026, 4, 31, 7, 47) })],
      },
    });

    expect(log).toContain('Browser: Chrome 148 on Linux');
    expect(log).toContain('Active SteamTrades URL: https://www.steamtrades.com/trade/abc/test');
    expect(log).not.toContain('secret=1');
    expect(log).toMatch(/Generated: 2026-05-31 \d{2}:48/);
    expect(log).toContain('Retention: last 10 API-call summaries');
    expect(log).toContain('Resolution stats (latest resolver run/current scope):');
    expect(log).toContain('Recent 429 errors:');
    expect(log).toContain('Recent quota blocks:');
    expect(log).toContain('bucket=minute');
  });
});

describe('updateDiagnostics', () => {
  it('serializes concurrent updates without data loss', async () => {
    // Fire 5 concurrent updates, each adding a unique failure
    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(updateDiagnostics({
        recentFailures: [{ title: `Game ${i}`, status: 'not-found', at: Date.now() + i }],
      }));
    }
    await Promise.all(promises);

    const final = await getDiagnostics();
    const failureTitles = (final.recentFailures ?? []).map(f => f.title);
    for (let i = 0; i < 5; i++) {
      expect(failureTitles).toContain(`Game ${i}`);
    }
  });
});
