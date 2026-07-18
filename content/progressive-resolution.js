import { normalizeTitle } from '../utils/similarity.js';

export const DEFAULT_RESOLUTION_BATCH_SIZE = 8;
export const DEFAULT_MAX_OUTSTANDING_BATCHES = 2;

/**
 * Page-local title-resolution scheduler.
 *
 * The coordinator deduplicates resolver work by normalized title while keeping
 * row state independent: one result is applied to every still-live row that
 * requested that title. It deliberately owns no DOM or Chrome APIs.
 */
export class ProgressiveResolutionCoordinator {
  constructor({
    rows,
    resolveTitles,
    onResolved,
    onBatchResolved,
    batchSize = DEFAULT_RESOLUTION_BATCH_SIZE,
    maxOutstandingBatches = DEFAULT_MAX_OUTSTANDING_BATCHES,
    normalize = normalizeTitle,
  }) {
    this.rows = rows ?? [];
    this.resolveTitles = resolveTitles;
    this.onResolved = onResolved ?? (() => {});
    this.onBatchResolved = onBatchResolved ?? (() => {});
    this.batchSize = Math.max(1, Number(batchSize) || DEFAULT_RESOLUTION_BATCH_SIZE);
    this.maxOutstandingBatches = Math.max(1, Number(maxOutstandingBatches) || DEFAULT_MAX_OUTSTANDING_BATCHES);
    this.normalize = normalize;
    this.groups = new Map();
    this.queue = [];
    this.queuedKeys = new Set();
    this.inFlight = 0;
    this.cancelled = false;
    this.batchSequence = 0;
    this.idleResolvers = [];

    for (const row of this.rows) this._registerRow(row);
  }

  _titleFor(row) {
    return String(row?.originalTitle ?? row?.title ?? '').trim();
  }

  _keyFor(row) {
    const title = this._titleFor(row);
    return title ? this.normalize(title) : '';
  }

  _registerRow(row) {
    const key = this._keyFor(row);
    if (!key) return;
    let group = this.groups.get(key);
    if (!group) {
      group = { key, title: this._titleFor(row), rows: [], state: 'pending' };
      this.groups.set(key, group);
    }
    group.rows.push(row);
    row.resolutionStatus ??= 'pending';
  }

  markHydrated(rows) {
    for (const row of rows ?? []) {
      const group = this.groups.get(this._keyFor(row));
      if (!group) continue;
      group.state = 'resolved';
      row.resolutionStatus = 'resolved';
    }
  }

  enqueue(rows, { priority = false } = {}) {
    if (this.cancelled) return;
    const keys = [];
    for (const row of rows ?? []) {
      const key = this._keyFor(row);
      const group = this.groups.get(key);
      if (!key || !group || group.state !== 'pending' || this.queuedKeys.has(key)) continue;
      group.state = 'queued';
      group.rows.forEach(item => { item.resolutionStatus = 'queued'; });
      keys.push(key);
      this.queuedKeys.add(key);
    }
    if (priority) this.queue.unshift(...keys);
    else this.queue.push(...keys);
    this._pump();
  }

  cancel() {
    this.cancelled = true;
    this.queue.length = 0;
    this.queuedKeys.clear();
    this._settleIdle();
  }

  whenIdle() {
    if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  _settleIdle() {
    if (this.inFlight !== 0 || this.queue.length !== 0) return;
    const resolvers = this.idleResolvers.splice(0);
    resolvers.forEach(resolve => resolve());
  }

  _pump() {
    if (this.cancelled) return this._settleIdle();
    while (this.inFlight < this.maxOutstandingBatches && this.queue.length > 0) {
      const keys = this.queue.splice(0, this.batchSize);
      keys.forEach(key => this.queuedKeys.delete(key));
      this.inFlight++;
      this._runBatch(keys, ++this.batchSequence).finally(() => {
        this.inFlight--;
        this._pump();
        this._settleIdle();
      });
    }
    this._settleIdle();
  }

  async _runBatch(keys, batchId) {
    const groups = keys.map(key => this.groups.get(key)).filter(Boolean);
    groups.forEach(group => {
      group.state = 'resolving';
      group.rows.forEach(row => { row.resolutionStatus = 'resolving'; });
    });
    if (this.cancelled) return;

    let results;
    try {
      results = await this.resolveTitles(groups.map(group => group.title), {
        batchId,
        rowMultiplicities: groups.map(group => group.rows.length),
      });
    } catch {
      results = null;
    }
    if (this.cancelled) return;

    const applied = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const resolution = Array.isArray(results) && results[index]
        ? results[index]
        : { status: 'not-found', failed: true };
      group.state = resolution.failed ? 'failed' : 'resolved';
      for (const row of group.rows) {
        if (!row?.el?.isConnected) continue;
        row.resolutionStatus = group.state;
        await this.onResolved(row, resolution, { batchId, key: group.key, source: 'remote' });
        applied.push({ row, resolution });
      }
    }
    if (!this.cancelled && applied.length > 0) {
      await this.onBatchResolved(applied, { batchId, source: 'remote' });
    }
  }
}
