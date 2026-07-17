import { describe, expect, it } from 'vitest';

const {
  extractSteamBundleIds,
  extractSteamBundleTitle,
} = await import('../background/steam-bundle-discovery.js');

describe('Steam bundle page parsing', () => {
  it('extracts and deduplicates strict numeric Steam bundle links', () => {
    const html = `
      <a href="https://store.steampowered.com/bundle/16628/Asterix/">First</a>
      <a href="/bundle/16628/Asterix/">Duplicate</a>
      <a href="/bundle/not-an-id/">Invalid</a>
      <a href="https://example.com/bundle/999/">Foreign host</a>
    `;

    expect(extractSteamBundleIds(html)).toEqual(['16628']);
  });

  it('decodes the page header without executing or retaining markup', () => {
    const html = '<div class="pageheader">Asterix &amp; <strong>Obelix</strong> XXL Collection</div>';
    expect(extractSteamBundleTitle(html)).toBe('Asterix & Obelix XXL Collection');
  });

  it('rejects age gates and oversized or malformed pages', () => {
    expect(extractSteamBundleIds('<form id="agecheck_form"></form>')).toBeNull();
    expect(extractSteamBundleTitle('<html>No title</html>')).toBeNull();
    expect(extractSteamBundleIds('x'.repeat(2_000_001))).toBeNull();
  });
});
