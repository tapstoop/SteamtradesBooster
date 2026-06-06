import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;

const {
  createDetailedStateElement,
  createTradablesDetailedCardElement,
} = await import('../popup/tradables-detailed.js');

describe('createDetailedStateElement', () => {
  it('renders malicious errors as inert text with the error-log link', () => {
    const message = 'Failed <img src=x onerror=alert(1)>';
    const state = createDetailedStateElement('error', message, { includeErrorLogLink: true });

    expect(state.className).toBe('error-state');
    expect(state.childNodes[0].textContent).toBe(message);
    expect(state.querySelector('img')).toBeNull();
    expect(state.querySelector('[onerror]')).toBeNull();
    const link = state.querySelector('.error-log-inline');
    expect(link.textContent).toBe('See error logs');
    expect(link.getAttribute('href')).toBe('popup.html?tab=settings&focus=error-log');
  });

  it('renders empty-state text without markup', () => {
    const state = createDetailedStateElement('empty', '<script>alert(1)</script>');

    expect(state.className).toBe('empty-state');
    expect(state.textContent).toBe('<script>alert(1)</script>');
    expect(state.querySelector('script')).toBeNull();
  });
});

describe('createTradablesDetailedCardElement', () => {
  it('renders malicious titles as text and preserves normal card classes', () => {
    const title = 'Bad <img src=x onerror=alert(1)>';
    const card = createTradablesDetailedCardElement({
      title,
      currentRetail: 1200,
      historicalRetail: 800,
      currency: 'EUR',
      settings: { keyshopsEnabled: false },
    });

    expect(card.className).toBe('game-card');
    expect(card.querySelector('.game-card-title').textContent).toBe(title);
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('[onerror]')).toBeNull();
    expect(card.querySelector('.game-card-meta strong').textContent).toContain('12.00');
    expect(card.querySelector('.game-card-meta .atl').textContent).toContain('8.00');
    expect(card.querySelector('.game-card-range')).not.toBeNull();
  });

  it('renders range, acquisition, and keyshop opportunity content', () => {
    const card = createTradablesDetailedCardElement({
      title: 'Example Game',
      currentRetail: 1500,
      historicalRetail: 1000,
      historicalKeyshops: 900,
      currentKeyshops: 500,
      currency: 'EUR',
      snapRange: { min: 400, max: 1600 },
      acqPrice: 1000,
      settings: {
        keyshopsEnabled: true,
        keyshops: ['eneba', 'g2a'],
        keyshopFees: {
          eneba: { min: 8, max: 12 },
          g2a: { min: 10, max: 15 },
        },
        rangeHighRatio: 3,
        rangeLowRatio: 1.5,
      },
    });

    expect(card.querySelector('.game-card-range .range-HIGH').textContent).toBe('HIGH');
    expect(card.querySelector('.game-card-range').textContent).toContain('(180d history)');
    expect(card.textContent).toContain('Historical ATL');
    expect(card.querySelector('.atl').textContent).toContain('9.00');
    expect(card.querySelector('.game-card-meta.high').textContent).toContain('(50%)');
    expect(card.textContent).toContain('Keyshop flip: Buy');
    expect(card.textContent).toContain('Gap');
    expect(card.querySelector('.game-card-meta .high')).not.toBeNull();
  });

  it('omits acquisition percentage when acquisition price is zero', () => {
    const card = createTradablesDetailedCardElement({
      title: 'Free Acquisition',
      currentRetail: 1000,
      historicalRetail: 800,
      currency: 'EUR',
      acqPrice: 0,
      settings: { keyshopsEnabled: false },
    });

    const acquisition = card.querySelector('.game-card-meta.high');
    expect(acquisition.textContent).toContain('Paid');
    expect(acquisition.textContent).not.toContain('Infinity');
    expect(acquisition.textContent).not.toContain('NaN');
    expect(acquisition.textContent).not.toMatch(/\(\d+%\)/);
  });
});
