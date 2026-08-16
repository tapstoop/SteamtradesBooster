import { JSDOM } from 'jsdom';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  anchorStillMatches,
  buildPopoverRefreshRequest,
  createPickerResultRow,
  createPickerStatusMessage,
  createPopoverBody,
  openCandidatePicker,
  openFuzzyPicker,
  openNotFoundPicker,
  openPopover,
} from '../content/ui-pickers.js';
import { positionNear } from '../content/ui-helpers.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://www.steamtrades.com/trade/example',
});
globalThis.document = dom.window.document;
globalThis.window = dom.window;
globalThis.location = dom.window.location;
globalThis.CustomEvent = dom.window.CustomEvent;
globalThis.requestAnimationFrame = callback => callback();

const sendMessageMock = vi.fn((message, callback) => callback?.({}));
globalThis.chrome = {
  runtime: {
    sendMessage: sendMessageMock,
    lastError: null,
  },
};

beforeEach(() => {
  document.body.replaceChildren();
  sendMessageMock.mockClear();
  sendMessageMock.mockImplementation((message, callback) => callback?.({}));
});

function expectNoExecutableMarkup(element) {
  expect(element.querySelector('img')).toBeNull();
  expect(element.querySelector('script')).toBeNull();
  expect(element.querySelector('[onerror], [onclick], [onfocus]')).toBeNull();
}

describe('picker DOM builders', () => {
  it('renders malicious candidate names and metadata as text', () => {
    const name = 'Candidate <img src=x onerror=alert(1)>';
    const meta = 'App <script>alert(2)</script>';
    const row = createPickerResultRow({
      name,
      meta,
      className: 'stpt-cand-item',
    });

    expect(row.classList.contains('stpt-cand-item')).toBe(true);
    expect(row.children).toHaveLength(2);
    expect(row.children[0].textContent).toBe(name);
    expect(row.children[1].textContent).toBe(meta);
    expectNoExecutableMarkup(row);
  });

  it('renders malicious search results and statuses without markup', () => {
    const resultName = 'Result <script>alert(1)</script>';
    const result = createPickerResultRow({
      name: resultName,
      meta: 'Bundle 123',
      className: 'stpt-cand-item',
    });
    const statusText = 'No results <img src=x onerror=alert(2)>';
    const status = createPickerStatusMessage(statusText, '#555');

    expect(result.querySelector('span')?.textContent).toBe(resultName);
    expect(result.classList.contains('stpt-cand-item')).toBe(true);
    expect(status.textContent).toBe(statusText);
    expect(status.style.padding).toBe('5px');
    expectNoExecutableMarkup(result);
    expectNoExecutableMarkup(status);
  });
});

describe('picker positioning', () => {
  it('uses viewport coordinates for fixed pickers and document coordinates otherwise', () => {
    Object.defineProperties(window, {
      scrollX: { configurable: true, value: 30 },
      scrollY: { configurable: true, value: 500 },
    });
    const anchor = document.createElement('button');
    anchor.getBoundingClientRect = () => ({
      top: 90,
      right: 140,
      bottom: 120,
      left: 40,
      width: 100,
      height: 30,
    });
    document.body.appendChild(anchor);

    const fixed = document.createElement('div');
    positionNear(fixed, anchor, { position: 'fixed' });
    expect(fixed.style.position).toBe('fixed');
    expect(fixed.style.left).toBe('40px');
    expect(fixed.style.top).toBe('124px');

    const absolute = document.createElement('div');
    positionNear(absolute, anchor);
    expect(absolute.style.position).toBe('absolute');
    expect(absolute.style.left).toBe('70px');
    expect(absolute.style.top).toBe('624px');

    Object.defineProperties(window, {
      scrollX: { configurable: true, value: 0 },
      scrollY: { configurable: true, value: 0 },
    });
  });
});

describe('picker interactions', () => {
  it('confirms a candidate and dispatches the resolution event', async () => {
    const anchor = document.createElement('button');
    const container = document.createElement('div');
    const row = document.createElement('div');
    container.appendChild(row);
    document.body.append(anchor, container);
    const resolutionEvents = [];
    container.addEventListener('stpt-resolve', event => resolutionEvents.push(event.detail));

    openCandidatePicker(
      anchor,
      [{ id: '321', name: 'Candidate Game', type: 'sub' }],
      'candidate-key',
      row
    );
    expect(document.querySelector('.stpt-candidates').style.position).toBe('absolute');
    document.querySelector('.stpt-cand-item')?.click();
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalled());

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'CONFIRM_RESOLUTION',
      cacheKey: 'candidate-key',
      appId: '321',
      title: 'Candidate Game',
      type: 'sub',
    }, expect.any(Function));
    expect(resolutionEvents).toEqual([{
      appId: '321',
      title: 'Candidate Game',
      cacheKey: 'candidate-key',
      type: 'sub',
    }]);
  });

  it('keeps a workstation candidate picker fixed to its viewport anchor', () => {
    const anchor = document.createElement('button');
    const row = document.createElement('div');
    document.body.append(anchor, row);

    openCandidatePicker(
      anchor,
      [{ id: '321', name: 'Candidate Game', type: 'app' }],
      'candidate-key',
      row,
      { position: 'fixed' }
    );

    expect(document.querySelector('.stpt-candidates').style.position).toBe('fixed');
  });

  it('persists and broadcasts a fuzzy dismissal from the source row', async () => {
    const row = document.createElement('div');
    row.className = 'stpt-game-item';
    row.dataset.stptTitle = 'Original title';
    const anchor = document.createElement('button');
    row.appendChild(anchor);
    document.body.appendChild(row);
    const dismissals = [];
    document.addEventListener('stpt-dismiss', event => dismissals.push(event.detail), { once: true });

    openFuzzyPicker(anchor, {
      status: 'hit',
      fuzzy: true,
      similarity: 80,
      title: 'Resolved title',
      cacheKey: 'resolve:original-title',
    }, row);
    document.querySelector('.stpt-cand-dismiss').click();

    await vi.waitFor(() => expect(dismissals).toHaveLength(1));
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'SET_DISMISSED',
      cacheKey: 'resolve:original-title',
    }, expect.any(Function));
    expect(dismissals[0]).toEqual({
      cacheKey: 'resolve:original-title',
      title: 'Original title',
    });
    expect(row.querySelector('[data-type="dismissed"]')).not.toBeNull();
  });
});

describe('createPopoverBody', () => {
  it('renders data-bearing popover and acquisition values as text', () => {
    const maliciousTitle = 'Game <img src=x onerror=alert(1)><script>alert(2)</script>';
    const body = createPopoverBody(
      {
        url: 'javascript:alert(3)',
        cachedAt: Date.UTC(2026, 0, 2, 12, 0),
        prices: {
          currency: 'EUR',
          currentRetail: 1000,
          historicalRetail: 800,
          currentKeyshops: 700,
          historicalKeyshops: 600,
        },
      },
      {
        title: maliciousTitle,
        appId: '123',
        type: 'app',
        tier: 2,
        acqPrice: 500,
        settings: { keyshopsEnabled: true },
      }
    );

    expect(body.querySelector('.stpt-popover-title')?.textContent).toBe(maliciousTitle);
    expect(body.querySelectorAll('.stpt-popover-row').length).toBeGreaterThanOrEqual(5);
    expect(body.querySelector('.stpt-popover-link')).toBeNull();
    expect(body.querySelector('.stpt-acq-input')?.value).toBe('5.00');
    expect(body.querySelector('.stpt-acq-save')?.textContent).toBe('Save');
    expect(body.querySelector('.stpt-acq-section')?.textContent).toContain('Paid');
    expectNoExecutableMarkup(body);
  });

  it('keeps a validated GG.deals link and normal popover selectors', () => {
    const body = createPopoverBody(
      {
        url: 'https://gg.deals/game/example/',
        prices: { currency: 'EUR', currentRetail: 1000, historicalRetail: 800 },
      },
      {
        title: 'Example',
        settings: { keyshopsEnabled: false },
      }
    );

    const link = body.querySelector('.stpt-popover-link');
    const childClasses = [...body.children].map(element => element.className);
    const rowLabels = [...body.querySelectorAll('.stpt-popover-label')]
      .map(element => element.textContent);
    expect(link?.href).toBe('https://gg.deals/game/example/');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(childClasses).toEqual([
      'stpt-popover-title',
      'stpt-popover-row',
      'stpt-popover-row',
      'stpt-popover-row',
      'stpt-popover-link',
    ]);
    expect(rowLabels).toEqual(['Current retail', 'Retail ATL', 'Historical ATL']);
    expect(body.querySelector('.stpt-popover-title')).not.toBeNull();
    expect(body.querySelector('.stpt-popover-label')).not.toBeNull();
    expect(body.querySelector('.stpt-popover-val')).not.toBeNull();
    expectNoExecutableMarkup(body);
  });

  it('omits the percentage when acquisition price is zero', () => {
    const body = createPopoverBody(
      {
        prices: { currency: 'EUR', currentRetail: 1000, historicalRetail: 800 },
      },
      {
        title: 'Free acquisition',
        appId: '123',
        tier: 2,
        acqPrice: 0,
        settings: { keyshopsEnabled: false },
      }
    );

    const comparisonText = body.querySelector('.stpt-acq-section')?.textContent ?? '';
    expect(comparisonText).toContain('Paid');
    expect(comparisonText).toContain('Now');
    expect(comparisonText).toContain('+');
    expect(comparisonText).not.toContain('Infinity%');
    expect(comparisonText).not.toContain('NaN%');
    expect(comparisonText).not.toMatch(/\(\d+%\)/);
  });
});

describe('openPopover', () => {
  it('renders acquisition controls after price rows and saves the entered price', async () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);

    openPopover(
      anchor,
      {
        prices: { currency: 'EUR', currentRetail: 1000, historicalRetail: 800 },
      },
      {
        title: 'Tradable',
        appId: '123',
        type: 'sub',
        tier: 2,
        acqPrice: 500,
        settings: { keyshopsEnabled: false },
      }
    );

    const popover = document.querySelector('.stpt-popover');
    const acquisition = popover?.querySelector('.stpt-acq-section');
    const rows = [...(popover?.querySelectorAll('.stpt-popover-row') ?? [])];
    const input = popover?.querySelector('.stpt-acq-input');
    const save = popover?.querySelector('.stpt-acq-save');

    expect(popover).not.toBeNull();
    expect(rows.length).toBeGreaterThan(0);
    expect(acquisition).not.toBeNull();
    expect(rows.every(row => (row.compareDocumentPosition(acquisition) & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0)).toBe(true);
    expect(input).not.toBeNull();
    expect(save).not.toBeNull();

    input.value = '7.25';
    save.click();
    await vi.waitFor(() => expect(sendMessageMock).toHaveBeenCalled());

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'SAVE_ACQ_PRICE',
      appId: '123',
      itemType: 'sub',
      price: 725,
    }, expect.any(Function));
    expect(document.querySelector('.stpt-popover')).toBeNull();
  });

  it('does not expose legacy manual-delisted controls', () => {
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    openPopover(anchor, null, { title: 'Game', appId: '123', type: 'app', tier: 4, settings: {} });
    expect(document.querySelector('.stpt-popover')?.textContent).not.toMatch(/mark as delisted|undo delisted/i);
  });
});

describe('openNotFoundPicker', () => {
  it('does not offer a manual delisted action', () => {
    const anchor = document.createElement('button');
    const row = document.createElement('span');
    document.body.append(anchor, row);
    openNotFoundPicker(anchor, 'resolve:missing', '', row);
    expect(document.querySelector('.stpt-candidates')?.textContent).not.toMatch(/delisted game/i);
  });

  it('renders the dismiss action as a keyboard-focusable button', () => {
    const anchor = document.createElement('button');
    const row = document.createElement('span');
    document.body.append(anchor, row);
    openNotFoundPicker(anchor, 'resolve:missing', '', row);

    const dismiss = document.querySelector('.stpt-cand-dismiss');
    expect(dismiss.tagName).toBe('BUTTON');
    expect(dismiss.type).toBe('button');
    expect(dismiss.textContent).toBe('Not a game — dismiss');
  });
});

describe('buildPopoverRefreshRequest', () => {
  it('uses REFRESH_PRICES with typed items for popover refreshes', () => {
    const req = buildPopoverRefreshRequest(
      { appId: '232', type: 'bundle' },
      { regions: ['eu', 'us'] }
    );
    expect(req.type).toBe('REFRESH_PRICES');
    expect(req.payload).toEqual({
      items: [{ id: '232', type: 'bundle' }],
      regions: ['eu', 'us'],
      fetchIntent: 'manual-refresh',
    });
  });

  it('falls back to resolved type metadata when direct type is missing', () => {
    const req = buildPopoverRefreshRequest(
      { appId: '500', resolution: { type: 'sub' } },
      { regions: ['eu'] }
    );
    expect(req.payload.items[0]).toEqual({ id: '500', type: 'sub' });
  });
});

describe('anchorStillMatches', () => {
  it('matches the captured typed app identity', () => {
    const anchor = document.createElement('button');
    anchor.dataset.appid = '123';
    anchor.dataset.itemType = 'sub';
    document.body.appendChild(anchor);

    expect(anchorStillMatches(anchor, { appId: '123', type: 'sub' }, 'sub')).toBe(true);
    expect(anchorStillMatches(anchor, { appId: '123', type: 'app' }, 'app')).toBe(false);
    expect(anchorStillMatches(anchor, { appId: '456', type: 'sub' }, 'sub')).toBe(false);
  });
});
