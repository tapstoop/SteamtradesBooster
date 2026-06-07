/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tradeEntityKey } from '../content/ui-workstation.js';

describe('tradeEntityKey', () => {
  it('keeps app, bundle, and sub entities distinct when numeric ids collide', () => {
    expect(tradeEntityKey({ appId: '123', type: 'app' })).toBe('app:123');
    expect(tradeEntityKey({ appId: '123', type: 'bundle' })).toBe('bundle:123');
    expect(tradeEntityKey({ appId: '123', type: 'sub' })).toBe('sub:123');
  });

  it('defaults legacy app-only game objects to app identity', () => {
    expect(tradeEntityKey({ appId: '123' })).toBe('app:123');
  });
});

import { SidebarWorkstation } from '../content/ui-workstation.js';

describe('SidebarWorkstation all games count', () => {
  let workstation;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    global.chrome = { runtime: { sendMessage: vi.fn() } };
    workstation = new SidebarWorkstation({ threshold: 0.1 });
  });

  afterEach(() => {
    workstation.destroy();
    delete global.chrome;
    vi.useRealTimers();
  });

  it('shows the count of have-section games and updates when searching', () => {
    workstation.setPageGames([
      { title: 'Alpha', section: 'have', appId: '1', type: 'app' },
      { title: 'Beta', section: 'have', appId: '2', type: 'app' },
      { title: 'Wanted', section: 'want', appId: '3', type: 'app' },
    ]);

    expect(workstation.el.querySelector('.stpt-ws-all-count').textContent).toBe('2');

    const search = workstation.el.querySelector('.stpt-ws-data .stpt-ws-search input');
    search.value = 'alp';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(250);

    expect(workstation.el.querySelector('.stpt-ws-all-count').textContent).toBe('1');
  });

  it('updates a page game by stptId after manual resolution', () => {
    workstation.setPageGames([
      { stptId: '7', title: 'Ambiguous Name', section: 'have', appId: null, type: 'app', price: null },
    ]);
    vi.runAllTimers(); // flush RAF for virtual list render

    workstation.updateResolvedPageGame('7', {
      title: 'Resolved Game',
      appId: '456',
      type: 'app',
      price: 1234,
      currency: 'EUR',
    });
    vi.runAllTimers(); // flush RAF for re-render

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row).not.toBeNull();
    expect(row.querySelector('.stpt-game-title').textContent).toBe('Resolved Game');
    expect(row.querySelector('.stpt-game-price').textContent).toBe('€12.34');
  });

  it('clears price when update explicitly passes null, and recalculates simulator totals', () => {
    workstation.setPageGames([
      { stptId: 'a', title: 'Game A', section: 'have', appId: '1', type: 'app', price: 1234, currency: 'EUR' },
      { stptId: 'b', title: 'Game B', section: 'have', appId: '2', type: 'app', price: 5678, currency: 'EUR' },
    ]);
    vi.runAllTimers();

    // Add game A to inTrade so we can assert it gets cleared there too
    workstation.addTraderGame(workstation.pageGames.find(g => g.stptId === 'a'));

    // Game B gets added to mine side
    workstation._addToMyGamesCore(workstation.pageGames.find(g => g.stptId === 'b'));

    // Simulator should reflect both prices
    const diffElBefore = document.getElementById('stpt-sim-diff');
    expect(diffElBefore.textContent).not.toBe('€0.00');

    workstation.updateResolvedPageGame('b', { price: null });
    vi.runAllTimers();

    // Page game price cleared
    const pgB = workstation.pageGames.find(g => g.stptId === 'b');
    expect(pgB.price).toBeNull();

    // In-trade copy cleared
    const tradeB = workstation.inTrade.mine.find(g => g.stptId === 'b');
    expect(tradeB.price).toBeNull();

    // Game A price preserved (not targeted by update)
    const pgA = workstation.pageGames.find(g => g.stptId === 'a');
    expect(pgA.price).toBe(1234);

    // Rendered row for B has no price span
    const rows = workstation.el.querySelectorAll('.stpt-game-row');
    const rowB = Array.from(rows).find(r => r.querySelector('.stpt-game-title')?.textContent === 'Game B');
    expect(rowB.querySelector('.stpt-game-price')).toBeNull();

    // Game A row still shows price
    const rowA = Array.from(rows).find(r => r.querySelector('.stpt-game-title')?.textContent === 'Game A');
    expect(rowA.querySelector('.stpt-game-price')).not.toBeNull();
    expect(rowA.querySelector('.stpt-game-price').textContent).toBe('€12.34');

    // Simulator totals recalculated without stale price
    const diffElAfter = document.getElementById('stpt-sim-diff');
    expect(diffElAfter.textContent).toBe('-€12.34');
  });

  it('preserves the current price when the update omits the price property', () => {
    workstation.setPageGames([
      { stptId: 'x', title: 'Keep Price', section: 'have', appId: '99', type: 'app', price: 500, currency: 'EUR' },
    ]);
    vi.runAllTimers();

    workstation.updateResolvedPageGame('x', { title: 'Renamed', appId: '100' });
    vi.runAllTimers();

    const pg = workstation.pageGames.find(g => g.stptId === 'x');
    expect(pg.price).toBe(500);
    expect(pg.currency).toBe('EUR');

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.querySelector('.stpt-game-title').textContent).toBe('Renamed');
    expect(row.querySelector('.stpt-game-price').textContent).toBe('€5.00');
  });

  it('updates all three collections (pageGames, inTrade.mine, inTrade.trader) and renders trade sections', () => {
    workstation.setPageGames([
      { stptId: 'g1', title: 'Game 1', section: 'have', appId: '10', type: 'app', price: 1000, currency: 'EUR' },
    ]);
    vi.runAllTimers();

    const game = workstation.pageGames.find(g => g.stptId === 'g1');

    // Add same-stptId copies to both trade sides
    workstation.inTrade.mine = [{ ...game }];
    workstation.inTrade.trader = [{ ...game }];

    // Also add game 1 to the virtual trade list via public API
    // (addTraderGame creates a proper entry; we re-add for the DL count)
    workstation.inTrade.trader = [];
    workstation.addTraderGame(workstation.pageGames[0]);
    workstation._addToMyGamesCore(workstation.pageGames[0]);
    vi.runAllTimers();

    // Now update all fields
    workstation.updateResolvedPageGame('g1', {
      title: 'Updated Game',
      appId: '20',
      type: 'sub',
      price: 2000,
      currency: 'USD',
    });
    vi.runAllTimers();

    function assertFields(obj) {
      expect(obj.title).toBe('Updated Game');
      expect(obj.appId).toBe('20');
      expect(obj.type).toBe('sub');
      expect(obj.price).toBe(2000);
      expect(obj.currency).toBe('USD');
    }

    assertFields(workstation.pageGames.find(g => g.stptId === 'g1'));
    assertFields(workstation.inTrade.mine.find(g => g.stptId === 'g1'));
    assertFields(workstation.inTrade.trader.find(g => g.stptId === 'g1'));

    // Rendered in-trade list shows updated title/price
    const inTradeList = document.getElementById('stpt-in-trade-list');
    expect(inTradeList.textContent).toContain('Updated Game');
    expect(inTradeList.textContent).toContain('$20.00');

    // Simulator totals reflect update
    const diffEl = document.getElementById('stpt-sim-diff');
    expect(diffEl.textContent).toContain('0.00'); // trader === mine value
  });

  // ── Dual-title rendering ────────────────────────────────────────────

  it('renders original title as secondary line when manuallyResolved and titles differ', () => {
    workstation.setPageGames([
      { stptId: 'dt1', title: 'Resolved Steam Title', originalTitle: 'Original Page Name', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: 500, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.classList.contains('has-original-title')).toBe(true);
    const primaryTitle = row.querySelector('.stpt-game-title');
    expect(primaryTitle.textContent).toBe('Resolved Steam Title');
    const originalTitle = row.querySelector('.stpt-game-original-title');
    expect(originalTitle).not.toBeNull();
    expect(originalTitle.textContent).toBe('→ Original Page Name');
  });

  it('does not render original title when titles are equal', () => {
    workstation.setPageGames([
      { stptId: 'dt2', title: 'Same Name', originalTitle: 'Same Name', manuallyResolved: true, section: 'have', appId: '2', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.classList.contains('has-original-title')).toBe(false);
    expect(row.querySelector('.stpt-game-original-title')).toBeNull();
  });

  it('does not render original title for auto-resolved (non-manual) games', () => {
    workstation.setPageGames([
      { stptId: 'dt3', title: 'Auto Resolved', originalTitle: 'Auto Resolved', manuallyResolved: false, section: 'have', appId: '3', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.classList.contains('has-original-title')).toBe(false);
    expect(row.querySelector('.stpt-game-original-title')).toBeNull();
  });

  it('does not render original title when showOriginalTitle is toggled off', () => {
    workstation.showOriginalTitle = false;
    workstation.setPageGames([
      { stptId: 'dt4', title: 'Resolved Steam Title', originalTitle: 'Original Page Name', manuallyResolved: true, section: 'have', appId: '4', type: 'app', price: 500, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.querySelector('.stpt-game-original-title')).toBeNull();
  });

  // ── Have-only: want-section games are excluded from All Page Games ───

  it('only shows have-section games in the data list', () => {
    workstation.setPageGames([
      { stptId: 'h1', title: 'Have Game 1', section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
      { stptId: 'h2', title: 'Have Game 2', section: 'have', appId: '2', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
      { stptId: 'w1', title: 'Want Game', section: 'want', appId: '3', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const rows = workstation.el.querySelectorAll('.stpt-game-row');
    expect(rows.length).toBe(2);
    const titles = Array.from(rows).map(r => r.querySelector('.stpt-game-title').textContent);
    expect(titles).toEqual(['Have Game 1', 'Have Game 2']);
  });

  // ── Checkbox toggle ─────────────────────────────────────────────────

  it('Show original names checkbox defaults to checked and toggles rendering', () => {
    workstation.setPageGames([
      { stptId: 'cb1', title: 'Resolved Steam Title', originalTitle: 'Original Page Name', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const cb = workstation.el.querySelector('.stpt-ws-orig-title-toggle input');
    expect(cb).not.toBeNull();
    expect(cb.checked).toBe(true);

    // Toggle off
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.querySelector('.stpt-game-original-title')).toBeNull();

    // Toggle back on
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    vi.runAllTimers();

    const row2 = workstation.el.querySelector('.stpt-game-row');
    expect(row2.querySelector('.stpt-game-original-title')).not.toBeNull();
  });

  // ── Virtual list height ─────────────────────────────────────────────

  it('virtual list adjusts height when original titles toggle changes', () => {
    workstation.setPageGames([
      { stptId: 'vh1', title: 'Resolved Steam Title', originalTitle: 'Original Page Name', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    // With dual-title ON, row height should be 50px
    const rowOn = workstation.el.querySelector('.stpt-game-row');
    expect(rowOn.style.height).toBe('50px');

    // Toggle off
    const cb = workstation.el.querySelector('.stpt-ws-orig-title-toggle input');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    vi.runAllTimers();

    // With dual-title OFF, row height should be 36px
    const rowOff = workstation.el.querySelector('.stpt-game-row');
    expect(rowOff.style.height).toBe('36px');
  });
});
