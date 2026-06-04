# GG.deals Scraper Tab Validation

Date: 2026-06-04

## Change

`background/ggdeals-scraper.js` now accepts `GGDEALS_SCRAPED` messages only when `sender.tab.id` matches the tab opened for the active scrape.

## Reason

The scraper opens a GG.deals tab and waits for the content script to send scraped price data. Previously, the listener accepted any `GGDEALS_SCRAPED` message. If another tab or content script sent that message while a scrape was active, the scraper could close the active tab and attach the wrong result to the current game.

## Verification

Added `tests/ggdeals-scraper.test.js` to prove messages from unrelated tabs are ignored and the scrape resolves only after the opened tab responds.
