// popup/popup.js
import { initSettings } from './settings.js';
import { initDeals } from './deals.js';
import { initTradablesDetailed } from './tradables-detailed.js';
import { initTradables } from './tradables.js';

// Tab state tracking
const tabInitStatus = { deals: false, tradablesDetailed: false, tradables: false, settings: false };

function renderTabError(tabContent, error) {
  if (!tabContent) return;
  const message = error?.message ?? String(error ?? 'Unknown error');
  tabContent.innerHTML = '';
  const state = document.createElement('div');
  state.className = 'error-state';
  state.textContent = `Failed to load this tab: ${message}`;
  tabContent.append(state);
}

function runTabInit(tabName, tabContent) {
  try {
    let initPromise;
    if (tabName === 'deals') initPromise = initDeals(tabContent);
    else if (tabName === 'tradablesDetailed') initPromise = initTradablesDetailed(tabContent);
    else if (tabName === 'tradables') initPromise = initTradables(tabContent);
    else if (tabName === 'settings') initPromise = initSettings(tabContent);
    if (initPromise?.catch) {
      initPromise.catch(error => renderTabError(tabContent, error));
    }
  } catch (error) {
    renderTabError(tabContent, error);
  }
}

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
  runTabInit(tabName, tabContent);
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
