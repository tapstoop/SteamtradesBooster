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

export function runtimeSendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      if (rejectLastError(reject)) return;
      resolve(response);
    });
  });
}
