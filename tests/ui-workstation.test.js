import { describe, it, expect } from 'vitest';
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
