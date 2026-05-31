// popup/popup.js
import { initSettings } from './settings.js';
import { initDeals } from './deals.js';
import { initTradablesDetailed } from './tradables-detailed.js';
import { initTradables } from './tradables.js';

// Tab state tracking
const tabInitStatus = { deals: false, tradablesDetailed: false, tradables: false, settings: false };

function activateTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const tabBtn = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tabBtn) tabBtn.classList.add('active');
  const tabContent = document.getElementById(`tab-${tabName}`);
  if (tabContent) tabContent.classList.add('active');
  // Persist active tab
  chrome.storage.local.set({ popupActiveTab: tabName });
  // Lazy init: only init when tab becomes active for the first time
  if (!tabInitStatus[tabName]) {
    tabInitStatus[tabName] = true;
  }
  // Always re-init the tab content so it re-binds listeners and refreshes data
  if (tabName === 'deals') initDeals(tabContent);
  else if (tabName === 'tradablesDetailed') initTradablesDetailed(tabContent);
  else if (tabName === 'tradables') initTradables(tabContent);
  else if (tabName === 'settings') initSettings(tabContent);
}

// Bind tab clicks with stopPropagation to prevent popup close on blur
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    e.stopPropagation();
    // Pop-out button: open in new tab
    if (tab.id === 'pop-out-btn') {
      const popupUrl = chrome.runtime.getURL('popup/popup.html');
      chrome.tabs.create({ url: popupUrl });
      return;
    }
    activateTab(tab.dataset.tab);
  });
});

// Init active tab on load (lazy)
chrome.storage.local.get('popupActiveTab', (result) => {
  const requestedTab = new URLSearchParams(location.search).get('tab');
  const activeTab = requestedTab || result.popupActiveTab || 'deals';
  activateTab(activeTab);
});

// Handle OPEN_POPUP_TAB message to focus specific tab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_POPUP_TAB') {
    const targetTab = message.tab || 'tradables';
    activateTab(targetTab);
    sendResponse({ success: true });
  }
  return true;
});
