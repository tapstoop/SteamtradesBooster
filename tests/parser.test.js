/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { cleanGameTitle, stripParentheses, parseGameRows } from '../content/parser.js';

describe('cleanGameTitle', () => {
  it('preserves numeric commas in titles', () => {
    expect(cleanGameTitle('Warhammer 40,000')).toBe('Warhammer 40,000');
  });

  it('removes table/list noise without losing the title', () => {
    expect(cleanGameTitle('1. Hollow Knight (Steam Key) - 2.00€')).toBe('Hollow Knight');
  });

  it('keeps anchor text style titles clean for table rows', () => {
    expect(cleanGameTitle('  DARK SOULS™: REMASTERED  ')).toBe('DARK SOULS™: REMASTERED');
  });
});

describe('stripParentheses', () => {
  it('removes region annotations', () => {
    expect(stripParentheses('My Little Universe (region lock)')).toBe('My Little Universe');
  });
});

describe('parseGameRows', () => {
  it('extracts bundle type from Steam bundle links in table rows', () => {
    document.body.innerHTML = `
      <div class="have">
        <div class="markdown">
          <table><tr>
            <td><a href="https://store.steampowered.com/bundle/1234/Some_Bundle/">Some Bundle</a></td>
          </tr></table>
        </div>
      </div>
    `;
    const rows = parseGameRows();
    const bundleRow = rows.find(r => r.title.toLowerCase() === 'some bundle');
    expect(bundleRow).toBeDefined();
    expect(bundleRow.type).toBe('bundle');
  });
});
