/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { createSteamTrackerAlertBanner } from '../popup/security-alert.js';

describe('Steam Tracker security alert banner', () => {
  it('renders only static text and exposes accessible log and dismiss actions', async () => {
    const onGenerateLog = vi.fn(async () => true);
    const onDismiss = vi.fn(async () => true);
    const banner = createSteamTrackerAlertBanner({
      id: 'incident-1',
      reasonCode: '<img src=x onerror=alert(1)>',
      lastSafeFetchedAt: 1_700_000_000_000,
      dismissed: false,
    }, { onGenerateLog, onDismiss });

    document.body.appendChild(banner);
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.querySelector('img')).toBeNull();
    expect(banner.textContent).toContain('failed a security validation');

    banner.querySelector('.steam-tracker-alert-details').click();
    await vi.waitFor(() => expect(onGenerateLog).toHaveBeenCalledTimes(1));

    banner.querySelector('.steam-tracker-alert-close').click();
    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: 'incident-1' })));
    await vi.waitFor(() => expect(banner.isConnected).toBe(false));
  });

  it('does not render a dismissed incident', () => {
    expect(createSteamTrackerAlertBanner({ id: 'old', dismissed: true })).toBeNull();
  });
});
