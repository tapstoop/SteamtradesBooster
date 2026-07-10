// content/ui-exclusion.js
// Floating button to mark/unmark the current page as "personal" (excluded from plugin)

import { normalizePageUrl, isPageExcluded } from '../utils/excluded-pages.js';
import { runtimeSendMessage } from '../utils/chrome-api.js';

let exclusionBtn = null;

export function injectExclusionButton() {
  if (exclusionBtn) return;

  exclusionBtn = document.createElement('button');
  exclusionBtn.id = 'stpt-exclusion-btn';
  exclusionBtn.className = 'stpt-exclusion-btn';

  exclusionBtn.addEventListener('click', async () => {
    try {
      const normalized = normalizePageUrl(location.href);
      const excluded = await runtimeSendMessage({ type: 'GET_EXCLUDED_PAGES' });
      const list = excluded ?? [];

      if (list.includes(normalized)) {
        // Remove from list using granular REMOVE handler
        await runtimeSendMessage({ type: 'REMOVE_EXCLUDED_PAGE', page: location.href });
      } else {
        // Add to list
        await runtimeSendMessage({ type: 'ADD_EXCLUDED_PAGE', url: location.href });
      }
      location.reload();
    } catch (err) {
      console.warn('[STPT] Exclusion toggle failed:', err);
    }
  });

  exclusionBtn.textContent = 'Mark as personal page';
  document.body.appendChild(exclusionBtn);
  updateExclusionButtonLabel();
}

export async function updateExclusionButtonLabel() {
  if (!exclusionBtn) return;

  try {
    const excluded = await runtimeSendMessage({ type: 'GET_EXCLUDED_PAGES' });
    const isExcluded = isPageExcluded(location.href, excluded ?? []);

    if (isExcluded) {
      exclusionBtn.textContent = '✓ Personal page (click to re-enable)';
      exclusionBtn.classList.add('active');
    } else {
      exclusionBtn.textContent = 'Mark as personal page';
      exclusionBtn.classList.remove('active');
    }
  } catch {
    exclusionBtn.textContent = 'Mark as personal page';
  }
}
