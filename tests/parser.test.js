/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { cleanGameTitle, stripParentheses, parseGameRows, extractSteamIdentity, isNotGame, prioritize } from '../content/parser.js';

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

  it('removes long decorative borders while preserving meaningful punctuation', () => {
    expect(cleanGameTitle('════ Hollow Knight ════')).toBe('Hollow Knight');
    expect(cleanGameTitle('====Game Title====')).toBe('Game Title');
    expect(cleanGameTitle('◆ ◇ ◆ ◇ Game Title ◆ ◇ ◆ ◇')).toBe('Game Title');
    expect(cleanGameTitle('[Game Title]')).toBe('[Game Title]');
    expect(cleanGameTitle('Game Title!!!!')).toBe('Game Title!!!!');
    expect(cleanGameTitle('NieR:Automata')).toBe('NieR:Automata');
  });

  it('rejects formatting-only text but preserves Unicode and numeric titles', () => {
    expect(isNotGame('==================================================================================')).toBe(true);
    expect(isNotGame('══════')).toBe(true);
    expect(isNotGame('◆◇◆◇')).toBe(true);
    expect(isNotGame('🎮🎮🎮🎮')).toBe(true);
    expect(isNotGame('\u200b\u200c\u200d')).toBe(true);
    expect(isNotGame('140')).toBe(false);
    expect(isNotGame('Été')).toBe(false);
    expect(isNotGame('Игры')).toBe(false);
    expect(isNotGame('日本語')).toBe(false);
  });
});

describe('stripParentheses', () => {
  it('removes region annotations', () => {
    expect(stripParentheses('My Little Universe (region lock)')).toBe('My Little Universe');
  });
});

describe('prioritize', () => {
  it('preserves independent wishlist and tradables membership', () => {
    const [game] = prioritize(
      [{ title: 'Shared Game', el: document.createElement('div') }],
      ['Shared Game'],
      ['Shared Game']
    );

    expect(game).toMatchObject({ tier: 1, inWishlist: true, inTradables: true });
  });
});

describe('parseGameRows', () => {
  it('ignores decorative rows across list, paragraph, and table structures without mutating them', () => {
    document.body.innerHTML = `
      <div class="have"><div class="markdown">
        <ul><li id="list-separator">================================</li></ul>
        <p><span id="paragraph-separator">══════</span><br>Real Game</p>
        <table><tr id="table-separator"><td>◆◇◆◇◆◇</td></tr></table>
      </div></div>
    `;

    expect(parseGameRows().map(row => row.title)).toEqual(['Real Game']);
    expect(document.querySelector('#list-separator').classList.contains('stpt-game-item')).toBe(false);
    expect(document.querySelector('#paragraph-separator').classList.contains('stpt-game-item')).toBe(false);
    expect(document.querySelector('#table-separator .stpt-game-item')).toBeNull();
  });

  it('deduplicates decorated variants after cleaning', () => {
    document.body.innerHTML = `
      <div class="have"><div class="markdown"><ul>
        <li>════ Hollow Knight ════</li>
        <li>Hollow Knight</li>
      </ul></div></div>
    `;

    expect(parseGameRows().map(row => row.title)).toEqual(['Hollow Knight']);
  });

  it('keeps symbol-only titles only when backed by a trusted Steam identity', () => {
    document.body.innerHTML = `
      <div class="have"><div class="markdown"><ul>
        <li><a href="#">★★★★</a></li>
        <li><a href="https://store.steampowered.com/app/1234/">!!!!</a></li>
        <li><a href="https://steamdb.info/app/5678/">++++</a></li>
      </ul></div></div>
    `;

    expect(parseGameRows()).toEqual([
      expect.objectContaining({ title: '!!!!', linkedAppId: '1234', linkedType: 'app' }),
      expect.objectContaining({ title: '++++', linkedAppId: '5678', linkedType: 'app' }),
    ]);
  });
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
