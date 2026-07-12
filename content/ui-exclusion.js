// content/ui-exclusion.js
// Floating button to mark/unmark the current page as "personal" (excluded from plugin)

import { isPageExcluded } from '../utils/excluded-pages.js';
import { runtimeSendMessage } from '../utils/chrome-api.js';

let exclusionBtn = null;
let exclusionMessageListenerBound = false;
let reloadPending = false;

function setExclusionButtonState(isExcluded) {
  if (!exclusionBtn) return;
  if (isExcluded) {
    exclusionBtn.textContent = '✓ Personal page (click to re-enable)';
    exclusionBtn.classList.add('active');
  } else {
    exclusionBtn.textContent = 'Mark as personal page';
    exclusionBtn.classList.remove('active');
  }
}

function reloadForExclusionChange() {
  if (reloadPending) return;
  reloadPending = true;
  location.reload();
}

export function injectExclusionButton() {
  if (exclusionBtn) return;

  exclusionBtn = document.createElement('button');
  exclusionBtn.id = 'stpt-exclusion-btn';
  exclusionBtn.className = 'stpt-exclusion-btn';

  exclusionBtn.addEventListener('click', async () => {
    try {
      const excluded = await runtimeSendMessage({ type: 'GET_EXCLUDED_PAGES' });
      const list = excluded ?? [];
      const wasExcluded = isPageExcluded(location.href, list);

      const result = wasExcluded
        ? await runtimeSendMessage({ type: 'REMOVE_EXCLUDED_PAGE', page: location.href })
        : await runtimeSendMessage({ type: 'ADD_EXCLUDED_PAGE', url: location.href });
      if (Array.isArray(result)) {
        const isExcluded = isPageExcluded(location.href, result);
        if (isExcluded !== wasExcluded) {
          reloadForExclusionChange();
          return;
        }
        setExclusionButtonState(isExcluded);
      } else {
        await updateExclusionButtonLabel();
      }
    } catch (err) {
      console.warn('[STPT] Exclusion toggle failed:', err);
    }
  });

  exclusionBtn.textContent = 'Mark as personal page';
  document.body.appendChild(exclusionBtn);
  if (!exclusionMessageListenerBound && chrome.runtime.onMessage?.addListener) {
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type !== 'EXCLUDED_PAGES_UPDATED' || !Array.isArray(message.pages)) return;
      const wasExcluded = exclusionBtn?.classList.contains('active') ?? false;
      const isExcluded = isPageExcluded(location.href, message.pages);
      if (wasExcluded !== isExcluded) {
        reloadForExclusionChange();
      } else {
        setExclusionButtonState(isExcluded);
      }
    });
    exclusionMessageListenerBound = true;
  }
  updateExclusionButtonLabel();
}

export async function updateExclusionButtonLabel() {
  if (!exclusionBtn) return;

  try {
    const excluded = await runtimeSendMessage({ type: 'GET_EXCLUDED_PAGES' });
    setExclusionButtonState(isPageExcluded(location.href, excluded ?? []));
  } catch {
    setExclusionButtonState(false);
  }
}
