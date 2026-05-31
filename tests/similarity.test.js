import { describe, it, expect } from 'vitest';
import { normalizeSteamType, typedPriceKey } from '../utils/similarity.js';

describe('normalizeSteamType', () => {
  it('returns app for undefined', () => {
    expect(normalizeSteamType(undefined)).toBe('app');
  });

  it('returns app for null', () => {
    expect(normalizeSteamType(null)).toBe('app');
  });

  it('returns app for unknown string', () => {
    expect(normalizeSteamType('game')).toBe('app');
  });

  it('returns bundle for bundle', () => {
    expect(normalizeSteamType('bundle')).toBe('bundle');
  });

  it('returns sub for sub', () => {
    expect(normalizeSteamType('sub')).toBe('sub');
  });

  it('returns app for app', () => {
    expect(normalizeSteamType('app')).toBe('app');
  });
});

describe('typedPriceKey', () => {
  it('returns app:key format for app type', () => {
    expect(typedPriceKey('123', 'app')).toBe('app:123');
  });

  it('returns bundle:key format for bundle type', () => {
    expect(typedPriceKey('456', 'bundle')).toBe('bundle:456');
  });

  it('returns sub:key format for sub type', () => {
    expect(typedPriceKey('789', 'sub')).toBe('sub:789');
  });

  it('defaults to app type when type is undefined', () => {
    expect(typedPriceKey('123')).toBe('app:123');
  });

  it('normalizes unknown type to app', () => {
    expect(typedPriceKey('123', 'game')).toBe('app:123');
  });
});
