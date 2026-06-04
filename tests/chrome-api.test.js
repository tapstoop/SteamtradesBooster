import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeSendMessage, tabsCreate, tabsRemove } from '../utils/chrome-api.js';

describe('chrome api wrappers', () => {
  beforeEach(() => {
    global.chrome = {
      runtime: {
        lastError: null,
        sendMessage: vi.fn()
      },
      tabs: {
        create: vi.fn(),
        remove: vi.fn()
      }
    };
  });

  it('resolves tabsCreate with the created tab', async () => {
    const tab = { id: 42, url: 'https://gg.deals/game/example/' };
    chrome.tabs.create.mockImplementation((options, callback) => callback(tab));

    await expect(tabsCreate({ url: tab.url, active: true })).resolves.toEqual(tab);
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: tab.url, active: true }, expect.any(Function));
  });

  it('rejects tabsCreate when chrome reports lastError', async () => {
    chrome.tabs.create.mockImplementation((options, callback) => {
      chrome.runtime.lastError = { message: 'Cannot create tab' };
      callback(undefined);
    });

    await expect(tabsCreate({ url: 'https://example.com/' })).rejects.toThrow('Cannot create tab');
  });

  it('rejects tabsCreate when chrome reports lastError with an empty message', async () => {
    chrome.tabs.create.mockImplementation((options, callback) => {
      chrome.runtime.lastError = { message: '' };
      callback(undefined);
    });

    await expect(tabsCreate({ url: 'https://example.com/' })).rejects.toThrow(Error);
  });

  it('resolves tabsRemove after removing a tab', async () => {
    chrome.tabs.remove.mockImplementation((tabId, callback) => callback());

    await expect(tabsRemove(42)).resolves.toBeUndefined();
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42, expect.any(Function));
  });

  it('rejects tabsRemove when chrome reports lastError', async () => {
    chrome.tabs.remove.mockImplementation((tabId, callback) => {
      chrome.runtime.lastError = { message: 'No tab with id: 42' };
      callback();
    });

    await expect(tabsRemove(42)).rejects.toThrow('No tab with id: 42');
  });

  it('rejects tabsRemove when chrome reports lastError with an empty message', async () => {
    chrome.tabs.remove.mockImplementation((tabId, callback) => {
      chrome.runtime.lastError = { message: '' };
      callback();
    });

    await expect(tabsRemove(42)).rejects.toThrow(Error);
  });

  it('resolves runtimeSendMessage with the response', async () => {
    chrome.runtime.sendMessage.mockImplementation((message, callback) => callback({ ok: true }));

    await expect(runtimeSendMessage({ type: 'PING' })).resolves.toEqual({ ok: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'PING' }, expect.any(Function));
  });

  it('rejects runtimeSendMessage when chrome reports lastError', async () => {
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      chrome.runtime.lastError = { message: 'Receiving end does not exist' };
      callback(undefined);
    });

    await expect(runtimeSendMessage({ type: 'PING' })).rejects.toThrow('Receiving end does not exist');
  });

  it('rejects runtimeSendMessage when chrome reports lastError with an empty message', async () => {
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      chrome.runtime.lastError = { message: '' };
      callback(undefined);
    });

    await expect(runtimeSendMessage({ type: 'PING' })).rejects.toThrow(Error);
  });
});
