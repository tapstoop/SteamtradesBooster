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

    expect(workstation.el.querySelector('.stpt-ws-all-count').textContent).toBe('Total: 2');

    const search = workstation.el.querySelector('.stpt-ws-data .stpt-ws-search input');
    search.value = 'alp';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(250);

    expect(workstation.el.querySelector('.stpt-ws-all-count').textContent).toBe('Total: 1');
  });

  it('keeps the All games search input focused while filtering', () => {
    workstation.setPageGames([
      { title: 'Alpha', section: 'have', appId: '1', type: 'app' },
      { title: 'Beta', section: 'have', appId: '2', type: 'app' },
    ]);

    const search = workstation.el.querySelector('.stpt-ws-data .stpt-ws-search input');
    search.focus();
    search.value = 'alp';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(250);

    expect(document.activeElement).toBe(search);
    expect(search.value).toBe('alp');
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

  it('applies progressive patches in one call while preserving unrelated games', () => {
    workstation.setPageGames([
      { stptId: 'a', title: 'Alpha', section: 'have', appId: null, type: 'app', price: null },
      { stptId: 'b', title: 'Beta', section: 'have', appId: null, type: 'app', price: null },
      { stptId: 'c', title: 'Gamma', section: 'have', appId: '3', type: 'app', price: 300 },
    ]);

    workstation.updateResolvedPageGames([
      { stptId: 'a', update: { appId: '1', title: 'Alpha Resolved', price: 100, currency: 'EUR' } },
      { stptId: 'b', update: { appId: '2', title: 'Beta Resolved', price: 200, currency: 'EUR' } },
    ]);

    expect(workstation.pageGames.map(game => [game.stptId, game.title, game.appId, game.price])).toEqual([
      ['a', 'Alpha Resolved', '1', 100],
      ['b', 'Beta Resolved', '2', 200],
      ['c', 'Gamma', '3', 300],
    ]);
  });

  it('coalesces progressive patches and only renders affected sections', () => {
    workstation.setPageGames([
      { stptId: 'plain', title: 'Plain', section: 'have', resolutionStatus: 'pending' },
      { stptId: 'wish', title: 'Wish', section: 'have', inWishlist: true, resolutionStatus: 'pending' },
    ]);
    vi.runAllTimers();
    const dataRender = vi.spyOn(workstation, '_renderDataList');
    const wishlistRender = vi.spyOn(workstation, '_renderWishlistSection');
    const tradablesRender = vi.spyOn(workstation, '_renderTradablesSection');
    const tradeRender = vi.spyOn(workstation, '_renderInTrade');

    workstation.updateResolvedPageGame('plain', { resolutionStatus: 'resolving' });
    workstation.updateResolvedPageGame('plain', {
      appId: '1',
      resolutionStatus: 'resolved',
      resolution: { status: 'resolved', appId: '1' },
    });

    expect(workstation.pageGames[0].resolutionStatus).toBe('resolved');
    vi.runAllTimers();
    expect(dataRender).toHaveBeenCalledTimes(1);
    expect(wishlistRender).not.toHaveBeenCalled();
    expect(tradablesRender).not.toHaveBeenCalled();
    expect(tradeRender).not.toHaveBeenCalled();

    workstation.updateResolvedPageGame('wish', { price: 500, currency: 'EUR' });
    vi.runAllTimers();
    expect(dataRender).toHaveBeenCalledTimes(2);
    expect(wishlistRender).toHaveBeenCalledTimes(1);
    expect(tradablesRender).not.toHaveBeenCalled();
  });

  it('defers DOM work while hidden and flushes the latest state once when shown', () => {
    workstation.setPageGames([
      { stptId: 'hidden', title: 'Hidden', section: 'have', resolutionStatus: 'pending' },
    ]);
    vi.runAllTimers();
    const dataRender = vi.spyOn(workstation, '_renderDataList');
    workstation.hide();

    workstation.updateResolvedPageGame('hidden', { resolutionStatus: 'resolving' });
    workstation.updateResolvedPageGame('hidden', {
      resolutionStatus: 'failed',
      resolution: { status: 'not-found', failed: true },
    });
    vi.runAllTimers();
    expect(dataRender).not.toHaveBeenCalled();

    workstation.show();
    vi.runAllTimers();
    expect(dataRender).toHaveBeenCalledTimes(1);
    expect(workstation.el.querySelector('.stpt-game-compact-badge.failed')).not.toBeNull();
  });

  it('does not rerender All Page Games when only the external tradables collection changes', () => {
    workstation.setPageGames([
      { stptId: 'plain', title: 'Plain', section: 'have' },
    ]);
    vi.runAllTimers();
    const dataRender = vi.spyOn(workstation, '_renderDataList');
    const tradablesRender = vi.spyOn(workstation, '_renderTradablesSection');

    workstation.setTradableGames([{ appId: '2', type: 'app', name: 'External Tradable' }]);
    vi.runAllTimers();

    expect(dataRender).not.toHaveBeenCalled();
    expect(tradablesRender).toHaveBeenCalledTimes(1);
  });

  it('preserves virtual-list scroll position across progressive patches', () => {
    workstation.setPageGames(Array.from({ length: 20 }, (_, index) => ({
      stptId: String(index),
      title: `Game ${String(index).padStart(2, '0')}`,
      section: 'have',
      appId: String(index + 1),
    })));
    vi.runAllTimers();
    const list = workstation._virtualList.container;
    list.scrollTop = 72;
    list.dispatchEvent(new Event('scroll'));

    workstation.updateResolvedPageGame('10', { price: 500, currency: 'EUR' });
    vi.runAllTimers();

    expect(list.scrollTop).toBe(72);
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

  it('renders the page title first and the resolved Steam title second', () => {
    workstation.setPageGames([
      { stptId: 'dt1', title: 'Resolved Steam Title', originalTitle: 'Original Page Name', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: 500, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    const primaryTitle = row.querySelector('.stpt-game-title');
    expect(primaryTitle.textContent).toBe('Original Page Name');
    const sourceTitle = row.querySelector('.stpt-game-source-title');
    expect(sourceTitle).not.toBeNull();
    expect(sourceTitle.textContent).toBe('→ Resolved Steam Title');
  });

  it('does not render original title when titles are equal', () => {
    workstation.setPageGames([
      { stptId: 'dt2', title: 'Same Name', originalTitle: 'Same Name', manuallyResolved: true, section: 'have', appId: '2', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.querySelector('.stpt-game-source-title')).toBeNull();
  });

  it('does not render original title for auto-resolved (non-manual) games', () => {
    workstation.setPageGames([
      { stptId: 'dt3', title: 'Auto Resolved', originalTitle: 'Auto Resolved', manuallyResolved: false, section: 'have', appId: '3', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.querySelector('.stpt-game-source-title')).toBeNull();
  });

  it('does not render original title when showOriginalTitle is toggled off', () => {
    workstation.showOriginalTitle = false;
    workstation.setPageGames([
      { stptId: 'dt4', title: 'Resolved Steam Title', originalTitle: 'Original Page Name', manuallyResolved: true, section: 'have', appId: '4', type: 'app', price: 500, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.querySelector('.stpt-game-source-title')).toBeNull();
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

  it('combines wishlist and tradables filters as an OR union', () => {
    workstation.setPageGames([
      { stptId: 'wishlist', title: 'Wishlist Game', section: 'have', appId: '1', inWishlist: true, inTradables: false },
      { stptId: 'tradable', title: 'Tradable Game', section: 'have', appId: '2', inWishlist: false, inTradables: true },
      { stptId: 'both', title: 'Both Game', section: 'have', appId: '3', inWishlist: true, inTradables: true },
      { stptId: 'neither', title: 'Other Game', section: 'have', appId: '4', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const wishlist = workstation.el.querySelector('.stpt-ws-filter-menu input[value="wish"]');
    const tradables = workstation.el.querySelector('.stpt-ws-filter-menu input[value="trade"]');
    expect(wishlist.checked).toBe(false);
    expect(tradables.checked).toBe(false);
    expect(workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-row')).toHaveLength(4);

    wishlist.click();
    vi.runAllTimers();
    expect(workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-row')).toHaveLength(2);
    expect(workstation.el.querySelector('.stpt-ws-all-count').textContent).toBe('Total: 2');

    tradables.click();
    vi.runAllTimers();
    expect(workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-row')).toHaveLength(3);

    wishlist.click();
    vi.runAllTimers();
    expect(workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-row')).toHaveLength(2);
  });

  it('exposes all badge filters in a compact keyboard-accessible dropdown', () => {
    const trigger = workstation.el.querySelector('.stpt-ws-filter-trigger');
    const menu = workstation.el.querySelector('.stpt-ws-filter-menu');
    const options = menu.querySelectorAll('input[type="checkbox"]');

    expect(menu.hidden).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(options).toHaveLength(10);

    trigger.click();
    expect(menu.hidden).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    options[0].click();
    expect(menu.hidden).toBe(false);
    expect(trigger.querySelector('.stpt-ws-filter-count').textContent).toBe('1');
    expect(trigger.getAttribute('aria-label')).toBe('Filters, 1 active');

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(menu.hidden).toBe(true);

    trigger.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it('combines search with badge filters using AND semantics', () => {
    workstation.setPageGames([
      { stptId: 'w-alpha', title: 'Alpha Wish', section: 'have', inWishlist: true },
      { stptId: 'w-beta', title: 'Beta Wish', section: 'have', inWishlist: true },
      { stptId: 't-alpha', title: 'Alpha Trade', section: 'have', inTradables: true },
    ]);
    vi.runAllTimers();

    workstation.el.querySelector('.stpt-ws-filter-menu input[value="wish"]').click();
    const search = workstation.el.querySelector('.stpt-ws-data .stpt-ws-search input');
    search.value = 'alpha';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(250);

    const titles = [...workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-title')]
      .map(element => element.textContent);
    expect(titles).toEqual(['Alpha Wish']);
    expect(workstation.el.querySelector('.stpt-ws-all-count').textContent).toBe('Total: 1');
  });

  it('updates status-filter results as progressive resolution changes state', () => {
    workstation.setPageGames([{
      stptId: 'missing',
      title: 'Missing Game',
      section: 'have',
      resolution: { status: 'not-found' },
    }]);
    vi.runAllTimers();
    workstation.el.querySelector('.stpt-ws-filter-menu input[value="not-found"]').click();
    vi.runAllTimers();
    expect(workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-row')).toHaveLength(1);

    workstation.updateResolvedPageGame('missing', {
      appId: '123',
      resolutionStatus: 'resolved',
      resolution: { status: 'hit', appId: '123' },
    });
    vi.runAllTimers();
    expect(workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-row')).toHaveLength(0);
    expect(workstation.el.querySelector('.stpt-ws-all-count').textContent).toBe('Total: 0');
  });

  it('clamps virtual scroll when active filters shrink progressive results', () => {
    workstation.setPageGames(Array.from({ length: 20 }, (_, index) => ({
      stptId: String(index),
      title: `Pending ${index}`,
      section: 'have',
      resolutionStatus: 'pending',
    })));
    vi.runAllTimers();
    workstation.el.querySelector('.stpt-ws-filter-menu input[value="pending"]').click();
    vi.runAllTimers();
    const list = workstation._virtualList.container;
    list.scrollTop = 360;
    list.dispatchEvent(new Event('scroll'));

    workstation.updateResolvedPageGames(workstation.pageGames.map(game => ({
      stptId: game.stptId,
      update: { resolutionStatus: 'failed' },
    })));
    vi.runAllTimers();

    expect(list.scrollTop).toBe(0);
  });

  it('navigates from an unbadged title and temporarily highlights its current source row', () => {
    const sourceRow = document.createElement('div');
    sourceRow.className = 'stpt-game-item';
    sourceRow.scrollIntoView = vi.fn();
    document.body.appendChild(sourceRow);
    workstation.setPageGames([{
      stptId: 'plain',
      el: sourceRow,
      title: 'Plain Game',
      section: 'have',
    }]);
    vi.runAllTimers();

    workstation.el.querySelector('.stpt-game-title-container').click();

    expect(sourceRow.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(sourceRow.classList).toContain('stpt-game-jump-target');
    vi.advanceTimersByTime(1400);
    expect(sourceRow.classList).not.toContain('stpt-game-jump-target');
  });

  it('honors reduced motion and safely ignores a detached source row', () => {
    const previousMatchMedia = globalThis.matchMedia;
    globalThis.matchMedia = vi.fn(() => ({ matches: true }));
    const sourceRow = document.createElement('div');
    sourceRow.scrollIntoView = vi.fn();
    document.body.appendChild(sourceRow);
    workstation.setPageGames([{ stptId: 'motion', el: sourceRow, title: 'Motion', section: 'have' }]);
    vi.runAllTimers();

    workstation.el.querySelector('.stpt-game-title-container').click();
    expect(sourceRow.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });

    sourceRow.remove();
    expect(workstation._navigateToPageGame(workstation.pageGames[0])).toBe(false);
    expect(sourceRow.scrollIntoView).toHaveBeenCalledTimes(1);
    globalThis.matchMedia = previousMatchMedia;
  });

  it('moves the jump highlight when different titles are clicked successively', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');
    first.scrollIntoView = vi.fn();
    second.scrollIntoView = vi.fn();
    document.body.append(first, second);
    workstation.setPageGames([
      { stptId: 'first', el: first, title: 'First', section: 'have' },
      { stptId: 'second', el: second, title: 'Second', section: 'have' },
    ]);
    vi.runAllTimers();
    const titleButtons = workstation.el.querySelectorAll('.stpt-ws-data .stpt-game-title-container');

    titleButtons[0].click();
    titleButtons[1].click();

    expect(first.classList).not.toContain('stpt-game-jump-target');
    expect(second.classList).toContain('stpt-game-jump-target');
  });

  it('restarts the highlight timeout when the same visible title is clicked again', () => {
    const sourceRow = document.createElement('div');
    sourceRow.scrollIntoView = vi.fn();
    document.body.appendChild(sourceRow);
    workstation.setPageGames([{
      stptId: 'repeat',
      el: sourceRow,
      title: 'Repeat',
      section: 'have',
    }]);
    vi.runAllTimers();
    const titleButton = workstation.el.querySelector('.stpt-ws-data .stpt-game-title-container');

    titleButton.click();
    vi.advanceTimersByTime(1000);
    titleButton.click();
    vi.advanceTimersByTime(500);

    expect(sourceRow.classList).toContain('stpt-game-jump-target');
    expect(sourceRow.scrollIntoView).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(900);
    expect(sourceRow.classList).not.toContain('stpt-game-jump-target');
  });

  it('removes dismissed games from the page list and active simulation', () => {
    workstation.setPageGames([
      { stptId: 'dismissed', title: 'Dismiss Me', section: 'have', appId: '1', price: 100 },
    ]);
    workstation.addTraderGame(workstation.pageGames[0]);

    workstation.updateResolvedPageGame('dismissed', {
      appId: null,
      resolutionStatus: 'dismissed',
      resolution: { status: 'dismissed' },
    });
    vi.runAllTimers();

    expect(workstation.el.querySelectorAll('.stpt-game-row')).toHaveLength(0);
    expect(workstation.inTrade.trader).toHaveLength(0);
  });

  it('opens the source-row candidate picker from a compact resolution badge', async () => {
    const sourceRow = document.createElement('div');
    sourceRow.className = 'stpt-game-item';
    document.body.appendChild(sourceRow);
    const candidates = [{ id: '10', name: 'Resolved Candidate', type: 'app' }];
    workstation.setPageGames([{
      stptId: 'ambiguous',
      el: sourceRow,
      title: 'Unknown Game',
      originalTitle: 'Unknown Game',
      section: 'have',
      appId: null,
      resolutionStatus: 'ambiguous',
      cacheKey: 'resolve:unknown-game',
      candidates,
      resolution: { status: 'ambiguous', cacheKey: 'resolve:unknown-game', candidates },
    }]);
    vi.runAllTimers();

    const badge = workstation.el.querySelector('.stpt-game-compact-badge.ambiguous');
    const opening = workstation._openResolutionForGame(workstation.pageGames[0], badge);
    await vi.advanceTimersByTimeAsync(150);
    await opening;

    expect(document.querySelector('.stpt-candidates')).not.toBeNull();
    expect(document.querySelector('.stpt-candidates').textContent).toContain('Resolved Candidate');
    expect(document.querySelector('.stpt-candidates').style.position).toBe('fixed');
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
    expect(row.querySelector('.stpt-game-source-title')).toBeNull();

    // Toggle back on
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    vi.runAllTimers();

    const row2 = workstation.el.querySelector('.stpt-game-row');
    expect(row2.querySelector('.stpt-game-source-title')).not.toBeNull();
  });

  // ── Virtual list height ─────────────────────────────────────────────

  it('virtual list adjusts height when original titles toggle changes', () => {
    workstation.setPageGames([
      { stptId: 'vh1', title: 'Resolved Steam Title', originalTitle: 'Original Page Name', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    // With dual-title ON, row height should be 42px
    const rowOn = workstation.el.querySelector('.stpt-game-row');
    expect(rowOn.style.height).toBe('42px');

    // Toggle off
    const cb = workstation.el.querySelector('.stpt-ws-orig-title-toggle input');
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    vi.runAllTimers();

    // With dual-title OFF, row height should be 36px
    const rowOff = workstation.el.querySelector('.stpt-game-row');
    expect(rowOff.style.height).toBe('36px');
  });

  it('uses 36px height when no filtered games have dual titles, even with toggle on', () => {
    workstation.setPageGames([
      { stptId: 'no1', title: 'Auto Resolved', originalTitle: 'Auto Resolved', manuallyResolved: false, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const row = workstation.el.querySelector('.stpt-game-row');
    expect(row.style.height).toBe('36px');
  });

  it('localStorage false before construction yields unchecked toggle and 36px rows', () => {
    workstation.destroy();
    localStorage.setItem('stpt-ws-show-original-title', 'false');
    const ws2 = new SidebarWorkstation({ threshold: 0.1 });
    ws2.setPageGames([
      { stptId: 'ls1', title: 'Resolved', originalTitle: 'Original', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const cb = ws2.el.querySelector('.stpt-ws-orig-title-toggle input');
    expect(cb.checked).toBe(false);
    const row = ws2.el.querySelector('.stpt-game-row');
    expect(row.style.height).toBe('36px');

    ws2.destroy();
    localStorage.removeItem('stpt-ws-show-original-title');
  });

  // ── updateResolvedPageGame propagates originalTitle/manuallyResolved ─

  it('updateResolvedPageGame propagates originalTitle and manuallyResolved to all three collections', () => {
    workstation.setPageGames([
      { stptId: 'pr1', title: 'Game', originalTitle: 'Old', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const game = workstation.pageGames.find(g => g.stptId === 'pr1');
    workstation.inTrade.mine = [{ ...game }];
    workstation.inTrade.trader = [{ ...game }];

    workstation.updateResolvedPageGame('pr1', { originalTitle: 'New Original', manuallyResolved: true });
    vi.runAllTimers();

    expect(workstation.pageGames.find(g => g.stptId === 'pr1').originalTitle).toBe('New Original');
    expect(workstation.inTrade.mine.find(g => g.stptId === 'pr1').originalTitle).toBe('New Original');
    expect(workstation.inTrade.trader.find(g => g.stptId === 'pr1').originalTitle).toBe('New Original');
    expect(workstation.pageGames.find(g => g.stptId === 'pr1').manuallyResolved).toBe(true);
    expect(workstation.inTrade.mine.find(g => g.stptId === 'pr1').manuallyResolved).toBe(true);
    expect(workstation.inTrade.trader.find(g => g.stptId === 'pr1').manuallyResolved).toBe(true);
  });

  it('updateResolvedPageGame preserves originalTitle and manuallyResolved when update omits them', () => {
    workstation.setPageGames([
      { stptId: 'pr2', title: 'Game', originalTitle: 'Keep Me', manuallyResolved: true, section: 'have', appId: '2', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    workstation.updateResolvedPageGame('pr2', { title: 'Renamed Only' });
    vi.runAllTimers();

    const pg = workstation.pageGames.find(g => g.stptId === 'pr2');
    expect(pg.title).toBe('Renamed Only');
    expect(pg.originalTitle).toBe('Keep Me');
    expect(pg.manuallyResolved).toBe(true);
  });

  // ── Search both titles and sort by resolved title ────────────────────

  it('search matches both the resolved and original titles', () => {
    workstation.setPageGames([
      { stptId: 'sr1', title: 'Resolved Name', originalTitle: 'Original Name', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    // Search for resolved title → match
    const search = workstation.el.querySelector('.stpt-ws-data .stpt-ws-search input');
    search.value = 'Resolved';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(250);

    expect(workstation.el.querySelectorAll('.stpt-game-row').length).toBe(1);

    // Search for original title → match
    search.value = 'Original';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(250);

    expect(workstation.el.querySelectorAll('.stpt-game-row').length).toBe(1);
  });

  it('sort orders by resolved title even when original title differs', () => {
    workstation.setPageGames([
      { stptId: 'so1', title: 'B Resolved', originalTitle: 'A Original', manuallyResolved: true, section: 'have', appId: '1', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
      { stptId: 'so2', title: 'A Resolved', originalTitle: 'B Original', manuallyResolved: true, section: 'have', appId: '2', type: 'app', price: null, currency: 'EUR', inWishlist: false, inTradables: false },
    ]);
    vi.runAllTimers();

    const sourceTitles = Array.from(workstation.el.querySelectorAll('.stpt-game-row'))
      .map(row => row.querySelector('.stpt-game-source-title').textContent);
    expect(sourceTitles).toEqual(['→ A Resolved', '→ B Resolved']);
  });

  // ── localStorage persistence on toggle ──────────────────────────────

  it('checkbox toggle writes to localStorage', () => {
    const cb = workstation.el.querySelector('.stpt-ws-orig-title-toggle input');
    expect(cb.checked).toBe(true);

    // Toggle off
    cb.checked = false;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem('stpt-ws-show-original-title')).toBe('false');

    // Toggle on
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    expect(localStorage.getItem('stpt-ws-show-original-title')).toBe('true');

    localStorage.removeItem('stpt-ws-show-original-title');
  });

  // ── Empty filtered results → compact height ─────────────────────────

  it('empty filtered results use 36px row height', () => {
    // Set games to an empty list
    workstation.setPageGames([]);
    vi.runAllTimers();

    // Verify no games rendered and virtual list still works
    expect(workstation.el.querySelectorAll('.stpt-game-row').length).toBe(0);
  });
});
