import { describe, it, expect } from 'vitest';
import { TradeSimulator } from '../content/trade-logic.js';

describe('TradeSimulator', () => {
  it('calculates correct difference and percentage', () => {
    const sim = new TradeSimulator(0.1);
    sim.addTraderGame({ appId: '1', price: 100 });
    sim.addMyGame({ appId: '2', price: 90 });
    const stats = sim.getStats();
    expect(stats.diff).toBe(-10);
    expect(stats.diffPercent).toBeCloseTo(0.1);
  });

  it('calculates totals correctly for multiple games', () => {
    const sim = new TradeSimulator(0.1);
    sim.addTraderGame({ appId: '1', price: 50 });
    sim.addTraderGame({ appId: '2', price: 100 });
    sim.addMyGame({ appId: '3', price: 80 });
    sim.addMyGame({ appId: '4', price: 120 });
    const stats = sim.getStats();
    expect(stats.traderTotal).toBe(150);
    expect(stats.myTotal).toBe(200);
    expect(stats.diff).toBe(50);
    expect(stats.diffPercent).toBeCloseTo(0.333);
  });

  it('returns zero percent when trader total is zero', () => {
    const sim = new TradeSimulator(0.1);
    sim.addMyGame({ appId: '1', price: 50 });
    const stats = sim.getStats();
    expect(stats.traderTotal).toBe(0);
    expect(stats.myTotal).toBe(50);
    expect(stats.diff).toBe(50);
    expect(stats.diffPercent).toBe(0);
  });

  it('stores threshold for later use', () => {
    const sim = new TradeSimulator(0.15);
    expect(sim.threshold).toBe(0.15);
  });

  it('determines if trade is fair based on threshold', () => {
    const sim = new TradeSimulator(0.1);
    sim.addTraderGame({ appId: '1', price: 100 });
    sim.addMyGame({ appId: '2', price: 95 });
    expect(sim.isFair()).toBe(true);
  });

  it('determines if trade is unfair based on threshold', () => {
    const sim = new TradeSimulator(0.1);
    sim.addTraderGame({ appId: '1', price: 100 });
    sim.addMyGame({ appId: '2', price: 80 });
    expect(sim.isFair()).toBe(false);
  });

  it('can clear all games', () => {
    const sim = new TradeSimulator(0.1);
    sim.addTraderGame({ appId: '1', price: 100 });
    sim.addMyGame({ appId: '2', price: 90 });
    sim.clear();
    const stats = sim.getStats();
    expect(stats.traderTotal).toBe(0);
    expect(stats.myTotal).toBe(0);
  });
});