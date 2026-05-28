import { describe, it, expect } from 'vitest';
import { buildPopoverRefreshRequest } from '../content/ui-pickers.js';

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
