/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPACT_BADGE_FILTERS,
  canAddGameToTrade,
  createGameRow,
  createVirtualList,
  getCompactBadgeFilterKeys,
  getResolutionBadgeDescriptor,
} from '../content/ui-components.js';

describe('workstation game rows', () => {
  it('renders compact membership and removal badges with accessible labels', () => {
    const row = createGameRow({
      game: {
        appId: '1',
        title: 'Game',
        removalStatus: 'removed_banned',
        price: 100,
        currency: 'EUR',
      },
      isInWishlist: true,
      isInTradables: true,
    });

    const badges = [...row.querySelectorAll('.stpt-game-compact-badge')];
    expect(badges.map(badge => badge.textContent)).toEqual(['B', 'W', 'T']);
    expect(badges.map(badge => badge.getAttribute('aria-label'))).toEqual([
      'Banned',
      'Wishlist',
      'Tradables',
    ]);
    expect(badges[0].classList).toContain('removed_banned');
  });

  it('renders interactive resolution states and keeps pending states passive', () => {
    const onResolve = vi.fn();
    const sourceRow = document.createElement('div');
    const ambiguous = {
      el: sourceRow,
      title: 'Unknown',
      cacheKey: 'resolve:unknown',
      resolutionStatus: 'ambiguous',
      resolution: { status: 'ambiguous', candidates: [{ id: '1', name: 'Candidate' }] },
      candidates: [{ id: '1', name: 'Candidate' }],
    };
    const row = createGameRow({ game: ambiguous, onResolve });
    const badge = row.querySelector('.stpt-game-compact-badge.resolution');

    expect(badge.tagName).toBe('BUTTON');
    expect(badge.textContent).toBe('? 1');
    badge.click();
    expect(onResolve).toHaveBeenCalledWith(ambiguous, badge);

    const pendingRow = createGameRow({
      game: { title: 'Pending', resolutionStatus: 'pending' },
      onResolve,
    });
    expect(pendingRow.querySelector('.stpt-game-compact-badge.pending').tagName).toBe('SPAN');
  });

  it('describes not-found, fuzzy, and failed resolution states', () => {
    const sourceRow = document.createElement('div');
    expect(getResolutionBadgeDescriptor({
      el: sourceRow,
      resolutionStatus: 'not-found',
      cacheKey: 'resolve:missing',
      resolution: { status: 'not-found' },
    })).toMatchObject({ kind: 'not-found', label: 'N/A', interactive: true });
    expect(getResolutionBadgeDescriptor({
      el: sourceRow,
      resolutionStatus: 'hit',
      cacheKey: 'resolve:fuzzy',
      fuzzy: true,
      similarity: 87.6,
      resolution: { status: 'hit', fuzzy: true },
    })).toMatchObject({ kind: 'fuzzy', label: '≈ 88%', interactive: true });
    expect(getResolutionBadgeDescriptor({ resolutionStatus: 'failed' }))
      .toMatchObject({ kind: 'failed', label: 'ERR', interactive: false });
  });

  it('defines every visible compact badge as a filter option', () => {
    expect(COMPACT_BADGE_FILTERS.map(filter => filter.key)).toEqual([
      'wish',
      'trade',
      'removed_delisted',
      'removed_disabled',
      'removed_banned',
      'pending',
      'ambiguous',
      'not-found',
      'fuzzy',
      'failed',
    ]);
  });

  it.each([
    [{ inWishlist: true }, ['wish']],
    [{ inTradables: true }, ['trade']],
    [{ removalStatus: 'removed_delisted' }, ['removed_delisted']],
    [{ removalStatus: 'removed_disabled' }, ['removed_disabled']],
    [{ removalStatus: 'removed_banned' }, ['removed_banned']],
    [{ resolutionStatus: 'pending' }, ['pending']],
    [{ resolutionStatus: 'queued' }, ['pending']],
    [{ resolutionStatus: 'resolving' }, ['pending']],
    [{ resolution: { status: 'ambiguous' } }, ['ambiguous']],
    [{ resolution: { status: 'not-found' } }, ['not-found']],
    [{ fuzzy: true }, ['fuzzy']],
    [{ resolutionStatus: 'failed' }, ['failed']],
  ])('maps compact state %# to its filter key', (game, expected) => {
    expect([...getCompactBadgeFilterKeys(game)]).toEqual(expected);
  });

  it('matches rendered badge precedence for fuzzy, dismissed, and unknown states', () => {
    expect([...getCompactBadgeFilterKeys({
      resolution: { status: 'hit', fuzzy: true },
      removalStatus: 'removed_banned',
    })]).toEqual(['fuzzy']);
    expect([...getCompactBadgeFilterKeys({
      resolution: { status: 'dismissed' },
    })]).toEqual([]);
    expect([...getCompactBadgeFilterKeys({
      resolutionStatus: 'unexpected',
      removalStatus: 'unexpected',
    })]).toEqual([]);
  });

  it('makes the title navigable only when a navigation callback is provided', () => {
    const game = { title: 'Game without a badge' };
    const onNavigate = vi.fn();
    const navigableRow = createGameRow({ game, onNavigate });
    const titleButton = navigableRow.querySelector('.stpt-game-title-container');

    expect(titleButton.tagName).toBe('BUTTON');
    expect(titleButton.type).toBe('button');
    expect(titleButton.getAttribute('aria-label')).toBe('Go to Game without a badge on the SteamTrades page');
    titleButton.click();
    expect(onNavigate).toHaveBeenCalledWith(game, titleButton);

    const passiveRow = createGameRow({ game });
    expect(passiveRow.querySelector('.stpt-game-title-container').tagName).toBe('DIV');
  });

  it('only allows removed games into the simulator when a price is available', () => {
    expect(canAddGameToTrade({ appId: '1', removalStatus: 'removed_delisted', price: null })).toBe(false);
    expect(canAddGameToTrade({ appId: '1', removalStatus: 'removed_delisted', price: 0 })).toBe(true);
    expect(canAddGameToTrade({ appId: null, price: 100 })).toBe(false);
  });
});

describe('virtual list scheduling', () => {
  it('coalesces item and height changes into one viewport render', () => {
    vi.useFakeTimers();
    const renderItem = vi.fn(game => {
      const row = document.createElement('div');
      row.textContent = game.title;
      return row;
    });
    const list = createVirtualList({ itemHeight: 36, renderItem });
    const games = Array.from({ length: 100 }, (_, index) => ({ title: `Game ${index}` }));

    list.setItems(games);
    list.setItems(games);
    list.setItemHeight(40);
    list.setItemHeight(40);
    vi.runAllTimers();

    expect(renderItem).toHaveBeenCalledTimes(6);
    expect(list.container.querySelectorAll('.stpt-game-row')).toHaveLength(0);
    expect(list.container.querySelectorAll('.stpt-virtual-content > div')).toHaveLength(6);
    list.destroy();
    vi.useRealTimers();
  });

  it('cancels a pending viewport render when destroyed', () => {
    vi.useFakeTimers();
    const renderItem = vi.fn(() => document.createElement('div'));
    const list = createVirtualList({ itemHeight: 36, renderItem });

    list.setItems([{ title: 'Pending' }]);
    list.destroy();
    vi.runAllTimers();

    expect(renderItem).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
