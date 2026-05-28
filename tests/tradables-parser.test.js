// tests/tradables-parser.test.js
import { describe, it, expect } from 'vitest';
import { parseInput, classifyEntry, computeConfidence } from '../popup/tradables-parser.js';

describe('parseInput', () => {
  it('splits by comma', () => {
    expect(parseInput('Game A, Game B, Game C')).toEqual(['Game A', 'Game B', 'Game C']);
  });

  it('preserves commas inside titles', () => {
    expect(parseInput('Warhammer 40,000\nGame B')).toEqual(['Warhammer 40,000', 'Game B']);
  });

  it('preserves comma-containing titles in comma-separated input', () => {
    expect(parseInput('Warhammer 40,000, Game B')).toEqual(['Warhammer 40,000', 'Game B']);
  });

  it('splits compact numeric App ID CSV input', () => {
    expect(parseInput('236850,1145360')).toEqual(['236850', '1145360']);
  });

  it('splits compact numeric App ID CSV input with more than two IDs', () => {
    expect(parseInput('236850,1145360,367520')).toEqual(['236850', '1145360', '367520']);
  });

  it('splits by newline', () => {
    expect(parseInput('Game A\nGame B\nGame C')).toEqual(['Game A', 'Game B', 'Game C']);
  });

  it('handles mixed comma and newline', () => {
    expect(parseInput('Game A, 12345\nGame B')).toEqual(['Game A', '12345', 'Game B']);
  });

  it('trims whitespace', () => {
    expect(parseInput('  Game A  ,  12345  ')).toEqual(['Game A', '12345']);
  });

  it('ignores empty entries', () => {
    expect(parseInput('Game A,,Game B')).toEqual(['Game A', 'Game B']);
  });

  it('ignores empty strings', () => {
    expect(parseInput('')).toEqual([]);
  });

  it('returns [] for null', () => {
    expect(parseInput(null)).toEqual([]);
  });

  it('returns [] for undefined', () => {
    expect(parseInput(undefined)).toEqual([]);
  });

  it('returns [] for whitespace-only strings', () => {
    expect(parseInput('   ')).toEqual([]);
  });

  it('returns [] for newline-only strings', () => {
    expect(parseInput('\n\n')).toEqual([]);
  });
});

describe('classifyEntry', () => {
  it('classifies pure numeric as appId', () => {
    expect(classifyEntry('12345')).toEqual({ type: 'appId', value: '12345' });
    expect(classifyEntry('236850')).toEqual({ type: 'appId', value: '236850' });
  });

  it('classifies text as name', () => {
    expect(classifyEntry('Hollow Knight')).toEqual({ type: 'name', value: 'Hollow Knight' });
  });

  it('classifies alphanumeric as name', () => {
    expect(classifyEntry('Hollow Knight 2')).toEqual({ type: 'name', value: 'Hollow Knight 2' });
  });

  it('classifies empty string as name', () => {
    expect(classifyEntry('')).toEqual({ type: 'name', value: '' });
  });
});

describe('computeConfidence', () => {
  it('returns 100 for exact match', () => {
    expect(computeConfidence('Hollow Knight', 'Hollow Knight')).toBe(100);
  });

  it('is case insensitive', () => {
    expect(computeConfidence('hollow knight', 'Hollow Knight')).toBe(100);
  });

  it('returns high score for close match', () => {
    const score = computeConfidence('Hollow Kni', 'Hollow Knight');
    // Missing 3 chars of 13 = ratio 0.23 → score ~77
    expect(score).toBeGreaterThanOrEqual(75);
    expect(score).toBeLessThanOrEqual(80);
  });

  it('returns medium score for moderate match', () => {
    const score = computeConfidence('Celest', 'Celeste');
    // Missing 1 char of 7 = ratio 0.14 → score ~86
    expect(score).toBeGreaterThanOrEqual(80);
    expect(score).toBeLessThanOrEqual(90);
  });

  it('returns near 0 for completely different strings', () => {
    const score = computeConfidence('aaaa', 'bbbb');
    expect(score).toBeLessThanOrEqual(10);
  });
});
