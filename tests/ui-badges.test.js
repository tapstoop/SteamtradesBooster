/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { replaceBadge, resolveBadges } from '../content/ui-badges.js';

const dealPrice = {
  cachedAt: Date.now(),
  prices: {
    currentRetail: 1000,
    historicalRetail: 950,
    currency: 'EUR',
  },
};

describe('badge composition', () => {
  it('keeps tier and bundle labels as secondary badges when DEAL is primary', () => {
    const badges = resolveBadges(dealPrice, {
      tier: 1,
      inBundle: true,
      settings: { dealThresholdPct: 10, keyshopsEnabled: false },
    });

    expect(badges.map(badge => [badge.type, badge.isPrimary])).toEqual([
      ['DEAL', true],
      ['WISH', false],
      ['BUNDLE', false],
    ]);
  });

  it('makes WISH primary while preserving BUNDLE as secondary without a deal', () => {
    const badges = resolveBadges({ prices: { currentRetail: 1000, historicalRetail: 500, currency: 'EUR' } }, {
      tier: 1,
      inBundle: true,
      settings: { dealThresholdPct: 10, keyshopsEnabled: false },
    });

    expect(badges.map(badge => [badge.type, badge.isPrimary])).toEqual([
      ['WISH', true],
      ['BUNDLE', false],
    ]);
  });

  it('promotes a late removal warning and moves normal facts to the right', () => {
    const badges = resolveBadges(dealPrice, {
      tier: 1,
      inBundle: true,
      removal: { status: 'removed_banned' },
      settings: { dealThresholdPct: 10, keyshopsEnabled: false },
    });

    expect(badges.map(badge => [badge.type, badge.isPrimary])).toEqual([
      ['removed_banned', true],
      ['DEAL', false],
      ['WISH', false],
      ['BUNDLE', false],
    ]);
    expect(badges[0].label).toBe('BANNED');
    expect(badges[0].title).toContain('steam-tracker.com');
  });

  it.each([
    ['removed_delisted', 'DELISTED'],
    ['removed_disabled', 'NO PURCHASE'],
    ['removed_banned', 'BANNED'],
  ])('renders %s with its stable label', (status, label) => {
    const [badge] = resolveBadges(null, {
      tier: 4,
      removal: { status },
      settings: {},
    });
    expect(badge).toMatchObject({ type: status, label, isPrimary: true, priceText: '—' });
  });

  it('explains a successful empty GG.deals lookup only on a removed game', () => {
    const badges = resolveBadges(null, {
      tier: 4,
      removal: { status: 'removed_disabled' },
      ggDealsNoData: true,
      settings: {},
    });
    expect(badges.at(-1)).toMatchObject({
      type: 'no-ggdeals-data',
      label: 'NO GG.DEALS DATA',
      isPrimary: false,
      title: 'GG.deals returned no data for this Steam AppID.',
    });
  });

  it('keeps an unconfirmed fuzzy identity authoritative over tentative removal data', () => {
    const badges = resolveBadges(dealPrice, {
      tier: 1,
      fuzzy: true,
      removal: { status: 'removed_banned' },
      settings: { dealThresholdPct: 10 },
    });
    expect(badges[0].type).toBe('DEAL');
    expect(badges.some(badge => badge.type === 'removed_banned')).toBe(false);
  });

  it('atomically replaces an already-rendered normal set when Tracker arrives later', () => {
    const row = document.createElement('span');
    const base = {
      appId: '30',
      type: 'app',
      tier: 1,
      inBundle: true,
      settings: { dealThresholdPct: 10 },
    };
    replaceBadge(row, dealPrice, base);
    expect([...row.querySelectorAll('.stpt-badge')].map(el => el.dataset.type)).toEqual(['DEAL', 'WISH', 'BUNDLE']);

    replaceBadge(row, dealPrice, { ...base, removal: { status: 'removed_banned' } });
    const types = [...row.querySelectorAll('.stpt-badge')].map(el => el.dataset.type);
    expect(types).toEqual(['removed_banned', 'DEAL', 'WISH', 'BUNDLE']);
    expect(row.querySelectorAll('.stpt-badge[data-secondary="1"]')).toHaveLength(3);
    expect(row.querySelector('.stpt-badge')?.title).toContain('Banned');
  });
});
