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
});
