function getLastErrorMessage() {
  return chrome.runtime.lastError?.message || null;
}

function rejectLastError(reject) {
  const message = getLastErrorMessage();
  if (message) {
    reject(new Error(message));
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
