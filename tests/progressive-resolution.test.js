/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { ProgressiveResolutionCoordinator } from '../content/progressive-resolution.js';

function row(title) {
  const el = document.createElement('span');
  document.body.appendChild(el);
  return { title, originalTitle: title, el, resolutionStatus: 'pending' };
}

describe('ProgressiveResolutionCoordinator', () => {
  it('deduplicates titles, fans one result out, and preserves queued order', async () => {
    const alphaA = row('Alpha');
    const alphaB = row('Alpha');
    const beta = row('Beta');
    const resolveTitles = vi.fn(async titles => titles.map(title => ({ status: 'resolved', appId: title === 'Alpha' ? '1' : '2' })));
    const resolved = [];
    const coordinator = new ProgressiveResolutionCoordinator({
      rows: [alphaA, alphaB, beta],
      resolveTitles,
      onResolved: (item, result) => resolved.push([item.title, result.appId]),
      batchSize: 8,
    });

    coordinator.enqueue([alphaA, alphaB, beta]);
    await coordinator.whenIdle();

    expect(resolveTitles).toHaveBeenCalledWith(['Alpha', 'Beta'], expect.objectContaining({ rowMultiplicities: [2, 1] }));
    expect(resolved).toEqual([['Alpha', '1'], ['Alpha', '1'], ['Beta', '2']]);
  });

  it('honors the outstanding-batch limit and allows priority promotion', async () => {
    const rows = ['One', 'Two', 'Three'].map(row);
    const deferred = [];
    const resolveTitles = vi.fn(titles => new Promise(resolve => deferred.push({ titles, resolve })));
    const coordinator = new ProgressiveResolutionCoordinator({ rows, resolveTitles, batchSize: 1, maxOutstandingBatches: 2 });

    coordinator.enqueue([rows[0]]);
    coordinator.enqueue([rows[1]]);
    coordinator.enqueue([rows[2]], { priority: true });
    expect(resolveTitles).toHaveBeenCalledTimes(2);
    expect(deferred.map(call => call.titles)).toEqual([['One'], ['Two']]);

    deferred[0].resolve([{ status: 'resolved', appId: '1' }]);
    await vi.waitFor(() => expect(resolveTitles).toHaveBeenCalledTimes(3));
    expect(deferred[2].titles).toEqual(['Three']);

    deferred[1].resolve([{ status: 'resolved', appId: '2' }]);
    deferred[2].resolve([{ status: 'resolved', appId: '3' }]);
    await coordinator.whenIdle();
  });

  it('converts failed batches into controlled not-found results and skips disconnected rows', async () => {
    const connected = row('Connected');
    const disconnected = row('Disconnected');
    disconnected.el.remove();
    const onResolved = vi.fn();
    const coordinator = new ProgressiveResolutionCoordinator({
      rows: [connected, disconnected],
      resolveTitles: async () => { throw new Error('service worker unavailable'); },
      onResolved,
    });

    coordinator.enqueue([connected, disconnected]);
    await coordinator.whenIdle();

    expect(onResolved).toHaveBeenCalledTimes(1);
    expect(onResolved.mock.calls[0][1]).toMatchObject({ status: 'not-found', failed: true });
  });
});
