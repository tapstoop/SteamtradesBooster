function rejectLastError(reject) {
  const lastError = chrome.runtime.lastError;
  if (lastError) {
    reject(new Error(lastError.message));
    return true;
  }
  return false;
}

export function tabsCreate(options) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(options, tab => {
      if (rejectLastError(reject)) return;
      resolve(tab);
    });
  });
}

export function tabsRemove(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      if (rejectLastError(reject)) return;
      resolve();
    });
  });
}

export function runtimeSendMessage(typeOrMessage, data = {}) {
  // Support both call patterns:
  //   runtimeSendMessage('GET_SETTINGS') → sends { type: 'GET_SETTINGS' }
  //   runtimeSendMessage({ type: 'GET_EXCLUDED_PAGES' }) → sends the object directly
  const message = typeof typeOrMessage === 'string'
    ? { type: typeOrMessage, ...data }
    : typeOrMessage;
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (rejectLastError(reject)) return;
      resolve(response);
    });
  });
}
