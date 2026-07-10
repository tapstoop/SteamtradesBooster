// tests/excluded-pages.test.js
import { describe, it, expect } from 'vitest';
import { normalizePageUrl, isPageExcluded, isSteamTradesUrl } from '../utils/excluded-pages.js';

describe('normalizePageUrl', () => {
  it('collapses trade page URLs to trade:<id>', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/trade/12345/some-slug'))
      .toBe('trade:12345');
  });

  it('handles trade edit pages', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/trade/12345/edit'))
      .toBe('trade:12345');
  });

  it('handles bare trade URLs without slug', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/trade/12345'))
      .toBe('trade:12345');
  });

  it('handles steamtrades.com without www', () => {
    expect(normalizePageUrl('https://steamtrades.com/trade/99999/the-slug'))
      .toBe('trade:99999');
  });

  it('returns pathname for non-trade pages', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/forums/123'))
      .toBe('/forums/123');
  });

  it('returns root pathname', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/'))
      .toBe('/');
  });

  it('strips query and fragment from non-trade pages', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/page?foo=bar#baz'))
      .toBe('/page');
  });

  it('handles invalid URLs by returning the input', () => {
    expect(normalizePageUrl('not-a-url')).toBe('not-a-url');
  });

  it('handles trade URL with query/fragment', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/trade/123?x=1#y'))
      .toBe('trade:123');
  });

  it('handles trailing slash', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/trade/123/'))
      .toBe('trade:123');
  });

  it('handles slug+edit path', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/trade/123/slug/edit'))
      .toBe('trade:123');
  });

  it('handles empty string', () => {
    expect(normalizePageUrl('')).toBe('');
  });

  it('handles leading-zero IDs', () => {
    expect(normalizePageUrl('https://www.steamtrades.com/trade/007'))
      .toBe('trade:007');
  });

  it('handles very long trade IDs', () => {
    const longId = '9'.repeat(20);
    expect(normalizePageUrl(`https://www.steamtrades.com/trade/${longId}/slug`))
      .toBe(`trade:${longId}`);
  });

  it('collapses non-steamtrades /trade/ URLs to trade:<id> (host-agnostic by design; SW gate rejects them)', () => {
    // normalizePageUrl matches /trade/<digits> on pathname alone, regardless of host.
    // ADD_EXCLUDED_PAGE's isSteamTradesUrl gate is what prevents foreign /trade/ URLs entering storage.
    expect(normalizePageUrl('https://example.com/trade/123')).toBe('trade:123');
  });
});

describe('isPageExcluded', () => {
  it('returns false for empty list', () => {
    expect(isPageExcluded('https://www.steamtrades.com/trade/1/x', [])).toBe(false);
  });

  it('returns false for null/undefined list', () => {
    expect(isPageExcluded('https://www.steamtrades.com/trade/1/x', null)).toBe(false);
    expect(isPageExcluded('https://www.steamtrades.com/trade/1/x', undefined)).toBe(false);
  });

  it('returns true when normalized URL is in the list', () => {
    expect(isPageExcluded('https://www.steamtrades.com/trade/12345/x', ['trade:12345']))
      .toBe(true);
  });

  it('returns false when normalized URL is not in the list', () => {
    expect(isPageExcluded('https://www.steamtrades.com/trade/99999/x', ['trade:12345']))
      .toBe(false);
  });

  it('matches edit and view variants to the same trade:id', () => {
    const list = ['trade:42'];
    expect(isPageExcluded('https://www.steamtrades.com/trade/42/some-game', list)).toBe(true);
    expect(isPageExcluded('https://www.steamtrades.com/trade/42/edit', list)).toBe(true);
  });

  it('matches non-trade page by pathname', () => {
    expect(isPageExcluded('https://www.steamtrades.com/forums/123', ['/forums/123']))
      .toBe(true);
  });

  it('returns false for non-array list', () => {
    expect(isPageExcluded('https://www.steamtrades.com/trade/1/x', null)).toBe(false);
    expect(isPageExcluded('https://www.steamtrades.com/trade/1/x', undefined)).toBe(false);
    expect(isPageExcluded('https://www.steamtrades.com/trade/1/x', {})).toBe(false);
    expect(isPageExcluded('https://www.steamtrades.com/trade/1/x', 'trade:1')).toBe(false);
  });

  it('handles mixed-type list entries gracefully', () => {
    const list = ['trade:123', 456, null, undefined, true];
    expect(() => isPageExcluded('https://www.steamtrades.com/trade/123/x', list)).not.toThrow();
    expect(isPageExcluded('https://www.steamtrades.com/trade/123/x', list)).toBe(true);
  });
});

describe('isSteamTradesUrl', () => {
  it('returns true for www.steamtrades.com trade URL', () => {
    expect(isSteamTradesUrl('https://www.steamtrades.com/trade/123')).toBe(true);
  });

  it('returns true for steamtrades.com without www', () => {
    expect(isSteamTradesUrl('https://steamtrades.com/trade/123')).toBe(true);
  });

  it('returns false for gg.deals URLs', () => {
    expect(isSteamTradesUrl('https://gg.deals/game/foo')).toBe(false);
  });

  it('returns false for Steam store URLs', () => {
    expect(isSteamTradesUrl('https://store.steampowered.com/app/123')).toBe(false);
  });

  it('returns false for non-URL strings', () => {
    expect(isSteamTradesUrl('not-a-url')).toBe(false);
  });

  it('returns true for other steamtrades.com paths', () => {
    expect(isSteamTradesUrl('https://steamtrades.com/other/path')).toBe(true);
  });

  it('returns false for non-steamtrades hosts with a /trade/ path', () => {
    expect(isSteamTradesUrl('https://example.com/trade/123')).toBe(false);
    expect(isSteamTradesUrl('http://evil.com/trade/456/slug')).toBe(false);
  });
});
