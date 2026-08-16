/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { toWorkstationGame } from '../content/progressive-page.js';

describe('progressive page workstation state', () => {
  it('maps semantic resolution and independent membership before price hydration', () => {
    const el = document.createElement('div');
    el.dataset.stptId = '12';
    const resolution = {
      status: 'ambiguous',
      cacheKey: 'resolve:unknown',
      candidates: [{ id: '1', name: 'Candidate' }],
    };

    expect(toWorkstationGame({
      el,
      section: 'have',
      title: 'Unknown',
      originalTitle: 'Unknown',
      appId: null,
      type: 'app',
      tier: 1,
      inWishlist: true,
      inTradables: true,
      resolutionStatus: 'ambiguous',
      resolution,
      cacheKey: resolution.cacheKey,
      fuzzy: false,
      similarity: null,
      removal: null,
      priceData: null,
      ggDealsNoData: false,
    }, { currency: 'USD' })).toMatchObject({
      stptId: '12',
      el,
      section: 'have',
      resolutionStatus: 'ambiguous',
      resolution,
      candidates: resolution.candidates,
      inWishlist: true,
      inTradables: true,
      price: null,
      currency: 'USD',
    });
  });
});
