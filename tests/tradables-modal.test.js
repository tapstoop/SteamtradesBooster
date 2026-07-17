/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  categorizeResults,
  categorizeSingle,
  filterVisible,
  getEntriesToAdd,
  getAddCount,
  toggleAllVisible,
  findDuplicateTradables,
  prepareTradablesToAdd,
  dedupeTradableEntries,
  buildPreviewItemHtml,
  buildPreviewEntryElement,
  buildDuplicateWarningElement,
  buildSearchResultElement,
  buildSearchStatusElement,
  createBulkImportModal
} from '../popup/tradables-bulk-modal.js';

function flushPromises() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

afterEach(() => {
  document.body.innerHTML = '';
  delete globalThis.chrome;
  vi.restoreAllMocks();
});

describe('categorizeResults', () => {
  it('categorizes exact matches as exact', () => {
    const results = [
      { raw: 'Hollow Knight', status: 'hit', appId: '367520', matchedName: 'Hollow Knight' }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('exact');
    expect(categorized[0].checked).toBe(true);
  });

  it('categorizes appId resolved', () => {
    const results = [
      { raw: '236850', status: 'appid-resolved', appId: '236850', matchedName: 'Europa Universalis IV' }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('appid');
    expect(categorized[0].checked).toBe(true);
  });

  it('auto-checks fuzzy >= 90', () => {
    const results = [
      { raw: 'Hollow Kni', status: 'ambiguous', appId: '367520', matchedName: 'Hollow Knight', confidence: 92 }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('fuzzy-auto');
    expect(categorized[0].checked).toBe(true);
  });

  it('checks fuzzy < 90 by default (all categories checked)', () => {
    const results = [
      { raw: 'Celest', status: 'ambiguous', appId: null, matchedName: 'Celeste', confidence: 85 }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('fuzzy-manual');
    expect(categorized[0].checked).toBe(true);
  });

  it('checks not-found by default (all categories checked)', () => {
    const results = [
      { raw: 'asdfghjkl', status: 'not-found', appId: null, matchedName: null }
    ];
    const categorized = categorizeResults(results);
    expect(categorized[0].category).toBe('notfound');
    expect(categorized[0].checked).toBe(true);
  });
});

describe('filterVisible', () => {
  it('shows only categories in active filter set', () => {
    const entries = [
      { category: 'exact', visible: true },
      { category: 'notfound', visible: true }
    ];
    const filters = new Set(['exact']);
    const result = filterVisible(entries, filters);
    expect(result[0].visible).toBe(true);
    expect(result[1].visible).toBe(false);
  });
});

describe('getAddCount', () => {
  it('counts only checked and visible entries', () => {
    const entries = [
      { category: 'exact', checked: true, visible: true },
      { category: 'notfound', checked: false, visible: true },
      { category: 'exact', checked: true, visible: false }
    ];
    expect(getAddCount(entries)).toBe(1);
  });
});

describe('getEntriesToAdd', () => {
  it('excludes entries hidden by inactive filters', () => {
    const entries = [
      { category: 'exact', checked: true, visible: true, matchedName: 'Hollow Knight' },
      { category: 'notfound', checked: true, visible: true, raw: 'Unknown Game' }
    ];

    expect(getEntriesToAdd(entries, new Set(['exact']))).toEqual([
      { category: 'exact', checked: true, visible: true, matchedName: 'Hollow Knight' }
    ]);
  });

  it('excludes unchecked unresolved entries', () => {
    const entries = [
      { category: 'notfound', checked: false, visible: true, raw: 'Unknown Game' }
    ];

    expect(getEntriesToAdd(entries, new Set(['notfound']))).toEqual([]);
  });
});

describe('toggleAllVisible', () => {
  it('checks all visible entries', () => {
    const entries = [
      { category: 'exact', checked: false, visible: true },
      { category: 'notfound', checked: false, visible: false }
    ];
    const result = toggleAllVisible(entries, true);
    expect(result[0].checked).toBe(true);
    expect(result[1].checked).toBe(false); // invisible, unchanged
  });

  it('unchecks all visible entries', () => {
    const entries = [
      { category: 'exact', checked: true, visible: true },
      { category: 'appid', checked: true, visible: true }
    ];
    const result = toggleAllVisible(entries, false);
    expect(result[0].checked).toBe(false);
    expect(result[1].checked).toBe(false);
  });
});

describe('duplicate tradables', () => {
  it('keeps the original import title long enough to confirm a resolved selection', () => {
    const prepared = prepareTradablesToAdd([
      { raw: 'Original Collection', matchedName: 'Resolved Collection', appId: '99', type: 'bundle' },
    ], [], 'skip');

    expect(prepared.additions[0]).toMatchObject({
      name: 'Resolved Collection',
      appId: '99',
      type: 'bundle',
      _resolutionTitle: 'Original Collection',
    });
  });

  it('dedupes same-batch typed entries before preparing additions', () => {
    const entries = [
      { matchedName: 'Hollow Knight', appId: '367520', type: 'app' },
      { matchedName: 'Hollow Knight duplicate', appId: '367520', type: 'app' },
      { matchedName: 'Hollow Knight Bundle', appId: '367520', type: 'bundle' },
    ];

    expect(dedupeTradableEntries(entries)).toEqual([
      entries[0],
      entries[2],
    ]);

    expect(prepareTradablesToAdd(entries, [], 'skip').additions).toEqual([
      { name: 'Hollow Knight', appId: '367520', type: 'app', qty: 1 },
      { name: 'Hollow Knight Bundle', appId: '367520', type: 'bundle', qty: 1 },
    ]);
  });

  it('detects duplicates by app id', () => {
    const duplicates = findDuplicateTradables(
      [{ matchedName: 'Hollow Knight', appId: '367520', type: 'app' }],
      [{ name: 'Hollow Knight', appId: '367520', type: 'app', qty: 1 }]
    );
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].index).toBe(0);
  });

  it('keeps app, bundle, and sub duplicate keys distinct for the same numeric id', () => {
    const duplicates = findDuplicateTradables(
      [
        { matchedName: 'App Item', appId: '123', type: 'app' },
        { matchedName: 'Bundle Item', appId: '123', type: 'bundle' },
        { matchedName: 'Sub Item', appId: '123', type: 'sub' },
      ],
      [
        { name: 'Existing Bundle', appId: '123', type: 'bundle', qty: 1 },
      ]
    );

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].entry.type).toBe('bundle');
    expect(duplicates[0].index).toBe(0);
  });

  it('falls back to normalized title for unresolved duplicates', () => {
    const duplicates = findDuplicateTradables(
      [{ raw: 'Warhammer 40,000' }],
      [{ name: 'Warhammer 40000', appId: null, qty: 1 }]
    );
    expect(duplicates).toHaveLength(1);
  });

  it('detects resolved imports that match unresolved existing tradables by title', () => {
    const duplicates = findDuplicateTradables(
      [{ raw: 'Hollow Knight', matchedName: 'Hollow Knight', appId: '367520', type: 'app' }],
      [{ name: 'Hollow Knight', appId: null, qty: 1 }]
    );

    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].index).toBe(0);
  });

  it('prepares increments instead of duplicate additions', () => {
    const prepared = prepareTradablesToAdd(
      [
        { matchedName: 'Hollow Knight', appId: '367520', type: 'app' },
        { matchedName: 'Celeste', appId: '504230', type: 'app' },
      ],
      [{ name: 'Hollow Knight', appId: '367520', type: 'app', qty: 1 }],
      'increment'
    );
    expect(prepared.increments).toEqual([{ index: 0, amount: 1, name: 'Hollow Knight' }]);
    expect(prepared.additions).toEqual([{ name: 'Celeste', appId: '504230', type: 'app', qty: 1 }]);
  });

  it('skips resolved imports that duplicate unresolved existing tradables by title', () => {
    const prepared = prepareTradablesToAdd(
      [
        { raw: 'Hollow Knight', matchedName: 'Hollow Knight', appId: '367520', type: 'app' },
        { matchedName: 'Celeste', appId: '504230', type: 'app' },
      ],
      [{ name: 'Hollow Knight', appId: null, qty: 1 }],
      'skip'
    );

    expect(prepared.duplicates).toHaveLength(1);
    expect(prepared.additions).toEqual([{ name: 'Celeste', appId: '504230', type: 'app', qty: 1 }]);
  });

  it('prepares app, bundle, and sub additions independently when ids collide', () => {
    const prepared = prepareTradablesToAdd(
      [
        { matchedName: 'App Item', appId: '123', type: 'app' },
        { matchedName: 'Bundle Item', appId: '123', type: 'bundle' },
        { matchedName: 'Sub Item', appId: '123', type: 'sub' },
      ],
      [{ name: 'Existing Bundle', appId: '123', type: 'bundle', qty: 1 }],
      'skip'
    );

    expect(prepared.duplicates).toHaveLength(1);
    expect(prepared.additions).toEqual([
      { name: 'App Item', appId: '123', type: 'app', qty: 1 },
      { name: 'Sub Item', appId: '123', type: 'sub', qty: 1 },
    ]);
  });
});

describe('categorizeSingle', () => {
  it('categorizes hit as exact', () => {
    expect(categorizeSingle({ status: 'hit', appId: '367520' }).category).toBe('exact');
  });

  it('categorizes resolved as exact', () => {
    expect(categorizeSingle({ status: 'resolved', appId: '367520' }).category).toBe('exact');
  });

  it('categorizes appid-resolved as appid', () => {
    expect(categorizeSingle({ status: 'appid-resolved', appId: '236850' }).category).toBe('appid');
  });

  it('categorizes ambiguous >= 90 as fuzzy-auto', () => {
    expect(categorizeSingle({ status: 'ambiguous', confidence: 95 }).category).toBe('fuzzy-auto');
  });

  it('categorizes ambiguous < 90 as fuzzy-manual', () => {
    expect(categorizeSingle({ status: 'ambiguous', confidence: 75 }).category).toBe('fuzzy-manual');
  });

  it('all entries default to checked and visible', () => {
    const result = categorizeSingle({ status: 'hit', appId: '367520' });
    expect(result.checked).toBe(true);
    expect(result.visible).toBe(true);
  });
});

describe('buildPreviewItemHtml', () => {
  it('escapes dynamic content in preview entries', () => {
    const html = buildPreviewItemHtml({
      raw: '<img src=x onerror=alert(1)>',
      matchedName: 'Bad "Name"',
      appId: '123',
      confidence: 95,
      checked: true,
    }, 0, '#fff');

    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Bad &quot;Name&quot;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('shows bundle hint for not-found entries with bundle keywords', () => {
    const html = buildPreviewItemHtml({
      raw: 'Asterix & Obelix XXL Collection',
      matchedName: 'Asterix & Obelix XXL Collection',
      category: 'notfound',
      status: 'not-found',
      checked: true,
    }, 0, '#e74c3c');

    expect(html).toContain('preview-bundle-hint');
    expect(html).toContain('Paste the Steam bundle URL');
  });

  it('does not show bundle hint for not-found entries without bundle keywords', () => {
    const html = buildPreviewItemHtml({
      raw: 'Hollow Knight',
      matchedName: 'Hollow Knight',
      category: 'notfound',
      status: 'not-found',
      checked: true,
    }, 0, '#e74c3c');

    expect(html).not.toContain('preview-bundle-hint');
  });

  it('shows soft bundle hint for fuzzy entries with bundle keywords', () => {
    const html = buildPreviewItemHtml({
      raw: 'Valve Complete Pack',
      matchedName: 'Valve Complete Pack',
      category: 'fuzzy-manual',
      status: 'ambiguous',
      confidence: 75,
      checked: true,
    }, 0, '#e67e22');

    expect(html).toContain('preview-bundle-hint');
    expect(html).toContain('preview-bundle-hint-soft');
    expect(html).toContain('may be a bundle');
  });

  it('does not show bundle hint for exact entries with bundle keywords', () => {
    const html = buildPreviewItemHtml({
      raw: 'Asterix & Obelix XXL Collection',
      matchedName: 'Asterix & Obelix XXL Collection',
      category: 'exact',
      status: 'hit',
      appId: '12345',
      checked: true,
    }, 0, '#a1cd44');

    expect(html).not.toContain('preview-bundle-hint');
  });

  it('fallback to matchedName when raw is absent', () => {
    const html = buildPreviewItemHtml({
      matchedName: 'Starter Pack',
      category: 'notfound',
      status: 'not-found',
      checked: true,
    }, 0, '#e74c3c');

    expect(html).toContain('preview-bundle-hint');
  });

  it('shows resolve button for fuzzy-manual entries', () => {
    const html = buildPreviewItemHtml({
      raw: 'Hollow Knight',
      category: 'fuzzy-manual',
      status: 'ambiguous',
      checked: true,
    }, 0, '#e67e22');

    expect(html).toContain('preview-resolve-btn');
    expect(html).toContain('resolve');
  });

  it('shows resolve button for notfound entries', () => {
    const html = buildPreviewItemHtml({
      raw: 'asdfghjkl',
      category: 'notfound',
      status: 'not-found',
      checked: true,
    }, 0, '#e74c3c');

    expect(html).toContain('preview-resolve-btn');
  });

  it('does not show resolve button for exact entries', () => {
    const html = buildPreviewItemHtml({
      raw: 'Hollow Knight',
      matchedName: 'Hollow Knight',
      category: 'exact',
      status: 'hit',
      appId: '367520',
      checked: true,
    }, 0, '#a1cd44');

    expect(html).not.toContain('preview-resolve-btn');
  });

  it('does not show resolve button for appid entries', () => {
    const html = buildPreviewItemHtml({
      raw: '236850',
      category: 'appid',
      status: 'appid-resolved',
      appId: '236850',
      checked: true,
    }, 0, '#66c0f4');

    expect(html).not.toContain('preview-resolve-btn');
  });
});

function expectNoExecutableMarkup(element) {
  expect(element.querySelector('script')).toBeNull();
  expect(element.querySelector('img')).toBeNull();
  expect(element.querySelector('[onerror]')).toBeNull();
  expect(element.querySelector('[onclick]')).toBeNull();
  expect(element.querySelector('[onfocus]')).toBeNull();
}

describe('DOM data rendering', () => {
  it('renders preview entry data as text while preserving event selectors', () => {
    const entry = {
      raw: '<img src=x onerror=alert(1)> Raw',
      matchedName: '<script>alert(1)</script> Matched',
      appId: '123" onclick="alert(1)',
      category: 'fuzzy-manual',
      confidence: 91,
      checked: true,
    };

    const element = buildPreviewEntryElement(entry, 2, '#e67e22');

    expect(element.classList.contains('preview-item')).toBe(true);
    expect(element.querySelector('.preview-checkbox')?.dataset.index).toBe('2');
    expect(element.querySelector('.preview-checkbox')?.checked).toBe(true);
    expect(element.querySelector('.preview-resolve-btn')?.dataset.ri).toBe('2');
    expect(element.querySelector('.preview-name')?.textContent).toBe(entry.matchedName);
    expect(element.querySelector('.preview-appid')?.textContent).toBe(`#${entry.appId}`);
    expect(element.title).toContain(entry.raw);
    expect(element.title).toContain(entry.matchedName);
    expectNoExecutableMarkup(element);
  });

  it('renders duplicate warning text without executable markup and keeps controls', () => {
    const element = buildDuplicateWarningElement([
      { existing: { name: '<img src=x onerror=alert(1)> Existing' }, entry: { raw: 'Ignored' } },
      { existing: {}, entry: { raw: '<script>alert(2)</script> Raw' } },
    ]);

    expect(element.querySelector('.duplicate-title')?.textContent).toBe('Duplicate tradables found');
    expect(element.querySelector('.duplicate-body')?.textContent).toContain('<img src=x onerror=alert(1)> Existing');
    expect(element.querySelector('.duplicate-body')?.textContent).toContain('<script>alert(2)</script> Raw');
    expect(element.querySelector('#dup-increment')).not.toBeNull();
    expect(element.querySelector('#dup-skip')).not.toBeNull();
    expectNoExecutableMarkup(element);
  });

  it('renders search result titles as text while preserving result selectors', () => {
    const result = { id: '456" onclick="alert(1)', name: '<img src=x onerror=alert(1)> Result', type: 'bundle' };

    const element = buildSearchResultElement(result);

    expect(element.classList.contains('trp-result-item')).toBe(true);
    expect(element.querySelector('span')?.textContent).toBe(result.name);
    expect(element.textContent).toContain(`Bundle ${result.id}`);
    expectNoExecutableMarkup(element);
  });

  it('renders search status messages as text', () => {
    const element = buildSearchStatusElement('<script>alert(1)</script> Searching', '#555');

    expect(element.textContent).toBe('<script>alert(1)</script> Searching');
    expectNoExecutableMarkup(element);
  });

  it('keeps preview checkbox indexes mapped to original entries after filters hide rows', async () => {
    const onAdd = vi.fn();
    globalThis.chrome = {
      runtime: {
        sendMessage: vi.fn((message, callback) => {
          if (message.type === 'RESOLVE_TITLES') {
            callback([
              { status: 'hit', appId: '367520', title: 'Hollow Knight' },
              { status: 'not-found', appId: null, title: null },
              { status: 'ambiguous', candidates: [{ appId: '504230', title: 'Celeste' }] },
            ]);
          }
        }),
      },
    };

    const modal = createBulkImportModal(onAdd);
    document.querySelector('#bulk-input').value = [
      'Hollow Knight',
      'Unknown Game',
      'Celest',
    ].join('\n');

    document.querySelector('#bulk-preview-btn').click();
    await flushPromises();

    const filters = document.querySelector('#preview-filters');
    expect(filters).not.toBeNull();
    expect(filters.querySelector('input[data-filter="exact"]')).not.toBeNull();
    expect(document.querySelector('.preview-checkbox')).not.toBeNull();
    expect(document.querySelector('.preview-resolve-btn')).not.toBeNull();

    filters.querySelector('input[data-filter="exact"]').click();

    const visibleCheckboxes = [...document.querySelectorAll('.preview-checkbox')];
    expect(visibleCheckboxes.map(cb => cb.dataset.index)).toEqual(['1', '2']);

    visibleCheckboxes[0].click();
    document.querySelector('#bulk-add-btn').click();
    await flushPromises();

    expect(onAdd).toHaveBeenCalledWith({
      additions: [{ name: 'Celest', appId: null, type: 'app', qty: 1 }],
      increments: [],
      duplicates: [],
    });

    modal.destroy();
    delete globalThis.chrome;
  });
});
