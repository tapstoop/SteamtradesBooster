import { describe, it, expect } from 'vitest';
import { buildDiagnosticsPanelHtml, formatPopupDiagnosticDate } from '../popup/settings.js';

describe('settings diagnostics panel', () => {
  it('renders collapsed and ungenererated by default', () => {
    const html = buildDiagnosticsPanelHtml();

    expect(html).toContain('data-expanded="false"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden');
    expect(html).toContain('Not generated yet');
    expect(html).toContain('Click Generate to create a diagnostic snapshot.');
    expect(html).toContain('id="s-copy-log" type="button" disabled');
  });

  it('renders generated logs expanded with refresh and copy actions enabled', () => {
    const html = buildDiagnosticsPanelHtml({
      expanded: true,
      log: 'SteamTrades Booster v0.1.2',
      generatedAt: new Date(2026, 4, 31, 7, 48).getTime(),
    });

    expect(html).toContain('data-expanded="true"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('class="diagnostics-body" hidden');
    expect(html).toContain('Refresh');
    expect(html).toContain('SteamTrades Booster v0.1.2');
    expect(html).not.toContain('id="s-copy-log" type="button" disabled');
    expect(html).toMatch(/Generated 2026-05-31 \d{2}:48/);
  });

  it('escapes generated log content and error text', () => {
    const html = buildDiagnosticsPanelHtml({
      expanded: true,
      log: '<script>alert(1)</script>',
      error: '<b>failed</b>',
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;failed&lt;/b&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('formats popup diagnostic timestamps without seconds', () => {
    expect(formatPopupDiagnosticDate(new Date(2026, 4, 31, 7, 8, 25).getTime()))
      .toMatch(/^2026-05-31 \d{2}:08$/);
  });
});
