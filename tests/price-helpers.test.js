/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { setWorkstationPrice } from '../content/price-helpers.js';

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
