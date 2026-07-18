/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { resolveBadges } from '../content/ui-badges.js';

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
});
