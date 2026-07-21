import { runtimeSendMessage } from '../utils/chrome-api.js';

const REASONS = {
  redirect: 'The provider redirected the database request.',
  'unexpected-url': 'The database response came from an unexpected URL.',
  'invalid-mime': 'The provider returned an unexpected content type.',
  attachment: 'The provider returned a downloadable attachment.',
  'body-too-large': 'The database exceeded the 4.5 MiB safety limit.',
  'invalid-json': 'The provider returned invalid JSON data.',
  'invalid-schema': 'The provider returned an invalid database structure.',
  'raw-count-anomaly': 'The database record count changed unexpectedly.',
  'supported-count-anomaly': 'The supported-game count changed unexpectedly.',
  'category-count-anomaly': 'The removal categories changed unexpectedly.',
  'duplicate-limit': 'The database contained an unsafe number of duplicate titles.',
};

function formatDate(timestamp) {
  if (!timestamp) return 'not available';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'not available' : date.toLocaleString();
}

export function createSteamTrackerAlertBanner(alert, { onDismiss, onGenerateLog } = {}) {
  if (!alert || alert.dismissed) return null;
  const banner = document.createElement('section');
  banner.className = 'steam-tracker-security-alert';
  banner.setAttribute('role', 'alert');

  const content = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = 'Steam Tracker update blocked';
  const message = document.createElement('div');
  message.textContent = 'An unsafe or unexpected database update was rejected. The last safe local database is still in use, but its statuses may become outdated.';
  const detail = document.createElement('small');
  detail.textContent = `${REASONS[alert.reasonCode] ?? 'The response failed a security validation.'} Last safe update: ${formatDate(alert.lastSafeFetchedAt)}.`;
  const logButton = document.createElement('button');
  logButton.type = 'button';
  logButton.className = 'steam-tracker-alert-details';
  logButton.textContent = 'Generate log';
  logButton.addEventListener('click', async () => {
    logButton.disabled = true;
    logButton.textContent = 'Generating…';
    try {
      await onGenerateLog?.();
    } finally {
      if (logButton.isConnected) {
        logButton.disabled = false;
        logButton.textContent = 'Generate log';
      }
    }
  });
  content.append(title, message, detail, logButton);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'steam-tracker-alert-close';
  close.setAttribute('aria-label', 'Dismiss Steam Tracker alert');
  close.textContent = '×';
  close.addEventListener('click', () => {
    banner.remove();
    Promise.resolve(onDismiss?.(alert)).catch(() => {});
  });
  banner.append(content, close);
  return banner;
}

export function initSteamTrackerAlert(container, { onGenerateLog } = {}) {
  let currentId = null;
  const render = alert => {
    if (!container || alert?.id === currentId && container.firstElementChild) return;
    currentId = alert?.id ?? null;
    container.replaceChildren();
    const banner = createSteamTrackerAlertBanner(alert, {
      onGenerateLog,
      onDismiss: async current => {
        const result = await runtimeSendMessage('DISMISS_STEAM_TRACKER_SECURITY_ALERT', { alertId: current.id });
        return result?.ok === true;
      },
    });
    if (banner) container.appendChild(banner);
  };
  runtimeSendMessage('GET_STEAM_TRACKER_SECURITY_ALERT').then(render).catch(() => {});
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'STEAM_TRACKER_SECURITY_ALERT') render(message.alert);
  });
}
