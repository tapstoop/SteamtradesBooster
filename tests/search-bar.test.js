import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { createSearchBar } from '../utils/search-bar.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = dom.window.document;

describe('createSearchBar', () => {
  it('preserves the All games debounce behavior and supports popup classes', () => {
    vi.useFakeTimers();
    const onSearch = vi.fn();
    const searchBar = createSearchBar({
      placeholder: 'Search tradables...',
      containerClass: 'tradables-search-wrap',
      inputClass: 'tradables-search',
      inputId: 't-search',
      onSearch,
    });
    const input = searchBar.querySelector('#t-search');

    expect(searchBar.className).toBe('tradables-search-wrap');
    expect(input.className).toBe('tradables-search');
    expect(input.placeholder).toBe('Search tradables...');

    input.value = 'asterix';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    vi.advanceTimersByTime(199);
    expect(onSearch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSearch).toHaveBeenCalledWith('asterix');
    vi.useRealTimers();
  });
});
