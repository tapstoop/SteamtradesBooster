/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { cleanGameTitle, stripParentheses, parseGameRows, extractSteamIdentity } from '../content/parser.js';

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
    expect(bundleRow.type).toBe('app');
    expect(bundleRow.linkedType).toBe('bundle');
    expect(bundleRow.linkedAppId).toBe('1234');
  });

  it('extracts a removed app identity from a Steam Store list link', () => {
    document.body.innerHTML = `
      <div class="have"><div class="markdown"><ul>
        <li><a href="https://store.steampowered.com/app/970620/Castle_Rencounter/">Castle Rencounter</a></li>
      </ul></div></div>
    `;

    expect(parseGameRows()).toEqual([
      expect.objectContaining({
        title: 'Castle Rencounter',
        appId: null,
        type: 'app',
        linkedAppId: '970620',
        linkedType: 'app',
      }),
    ]);
  });

  it('extracts app identities from SteamDB links without treating other entity paths as apps', () => {
    expect(extractSteamIdentity('https://steamdb.info/app/970620/')).toEqual({ appId: '970620', type: 'app' });
    expect(extractSteamIdentity('https://steamdb.info/sub/970620/')).toBeNull();
    expect(extractSteamIdentity('https://store.steampowered.com/sub/1234/')).toEqual({ appId: '1234', type: 'sub' });
    expect(extractSteamIdentity('https://store.steampowered.com/bundle/5678/')).toEqual({ appId: '5678', type: 'bundle' });
  });

  it('rejects explanatory trade prose without using a hard word limit', () => {
    document.body.innerHTML = `
      <div class="have"><div class="markdown">
        <p>These games have now been banned or delisted and removed from Steam however they can still be activated and played. Most keys originate from old bundles and promotions.</p>
        <p>Because these keys are quite old I cannot guarantee they will all work. Also having multiple keys helps.</p>
        <p>No TF2, PayPal, Counterstrike or any of that...thanks.</p>
        <p>The Surprisingly Long Adventures of Baron Von Something and the Extremely Unlikely Return to the Kingdom Beyond Time</p>
      </div></div>
    `;

    expect(parseGameRows().map(row => row.title)).toEqual([
      'The Surprisingly Long Adventures of Baron Von Something and the Extremely Unlikely Return to the Kingdom Beyond Time',
    ]);
  });

  it('keeps long titles and known punctuation-heavy titles in list structure', () => {
    document.body.innerHTML = `
      <div class="have"><div class="markdown"><ul>
        <li>Super Shooty Skies Alpha II' Turbo Hyper Fighting - Champion Edition Pack</li>
        <li>I Have No Mouth, and I Must Scream: The Complete Collector Edition With Original Soundtrack</li>
      </ul></div></div>
    `;

    expect(parseGameRows().map(row => row.title)).toEqual([
      "Super Shooty Skies Alpha II' Turbo Hyper Fighting - Champion Edition Pack",
      'I Have No Mouth, and I Must Scream: The Complete Collector Edition With Original Soundtrack',
    ]);
  });
});
