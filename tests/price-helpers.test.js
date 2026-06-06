/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _getBadgePrice, setWorkstationPrice } from '../content/price-helpers.js';

describe('_getBadgePrice', () => {
  it('selects and converts the lower keyshop price to cents when keyshopsEnabled is true', () => {
    const priceData = {
      prices: { currentRetail: 1500, currentKeyshops: 800, currency: 'EUR' },
    };
    const settings = { keyshopsEnabled: true };

    expect(_getBadgePrice(priceData, settings)).toBe(800);
  });

  it('selects the retail price when keyshopsEnabled is false', () => {
    const priceData = {
      prices: { currentRetail: 1500, currentKeyshops: 800, currency: 'EUR' },
    };
    const settings = { keyshopsEnabled: false };

    expect(_getBadgePrice(priceData, settings)).toBe(1500);
  });

  it('handles values above 100,000 cents without thousands-separator ambiguity', () => {
    const priceData = {
      prices: { currentRetail: 125000, currency: 'EUR' },
    };
    const settings = {};

    expect(_getBadgePrice(priceData, settings)).toBe(125000);
  });

  it('returns retail price when only retail is available', () => {
    const priceData = {
      prices: { currentRetail: 2999, currency: 'USD' },
    };
    const settings = { keyshopsEnabled: true };

    expect(_getBadgePrice(priceData, settings)).toBe(2999);
  });

  it('returns keyshop price when only keyshop is available (keyshops enabled)', () => {
    const priceData = {
      prices: { currentKeyshops: 1999, currency: 'GBP' },
    };
    const settings = { keyshopsEnabled: true };

    expect(_getBadgePrice(priceData, settings)).toBe(1999);
  });

  it('returns null when neither retail nor keyshop price is present', () => {
    const priceData = {
      prices: { currency: 'EUR' },
    };
    const settings = { keyshopsEnabled: true };

    expect(_getBadgePrice(priceData, settings)).toBeNull();
  });
});

describe('setWorkstationPrice', () => {
  let priceMap;

  beforeEach(() => {
    priceMap = {};
  });

  function makePriceData(currentRetail, currency) {
    return { prices: { currentRetail, currency } };
  }

  it('populates a typed key and a legacy app-id key', () => {
    const priceData = makePriceData(1234, 'EUR');
    setWorkstationPrice(priceMap, '100', 'app', priceData, {});

    expect(priceMap['app:100']).toEqual({ price: 1234, currency: 'EUR' });
    expect(priceMap['100']).toEqual({ price: 1234, currency: 'EUR' });
  });

  it('populates typed key only for non-app types (no legacy key)', () => {
    const priceData = makePriceData(999, 'USD');
    setWorkstationPrice(priceMap, '200', 'bundle', priceData, {});

    expect(priceMap['bundle:200']).toEqual({ price: 999, currency: 'USD' });
    expect(priceMap['200']).toBeUndefined();
  });

  it('uses API price-data currency when present', () => {
    setWorkstationPrice(priceMap, '1', 'app', makePriceData(500, 'GBP'), {});

    expect(priceMap['app:1'].currency).toBe('GBP');
  });

  it('falls back to settings.currency when price data omits currency', () => {
    setWorkstationPrice(priceMap, '2', 'app', { prices: { currentRetail: 300 } }, { currency: 'USD' });

    expect(priceMap['app:2'].currency).toBe('USD');
  });

  it('falls back to EUR when neither price data nor settings provide currency', () => {
    setWorkstationPrice(priceMap, '3', 'app', { prices: { currentRetail: 200 } }, {});

    expect(priceMap['app:3'].currency).toBe('EUR');
  });

  it('returns early without populating when price is null/N/A', () => {
    setWorkstationPrice(priceMap, '4', 'app', { prices: { currentRetail: null } }, {});
    expect(Object.keys(priceMap)).toHaveLength(0);
  });

  it('sub type gets a typed key but no legacy key', () => {
    setWorkstationPrice(priceMap, '5', 'sub', makePriceData(800, 'EUR'), {});

    expect(priceMap['sub:5']).toEqual({ price: 800, currency: 'EUR' });
    expect(priceMap['5']).toBeUndefined();
  });
});
