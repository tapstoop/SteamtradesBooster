# Issue #17 - Steam/GG.deals links in Tradables views

## Goal and dependencies

Add safe, consistent external links to the compact Tradables list and Tradables Detailed cards. This issue is popup-only and may be implemented immediately after #20. It must reuse the URL validation and link-building behavior already owned by `popup/deals.js`; no second URL sanitizer should be introduced.

## Current architecture and constraints

- `steamStoreUrl(id, type)` exists in `popup/deals.js` but is not exported.
- `renderGgDealsLink(url)` is exported but returns an HTML string. The tradables views build DOM nodes with `document.createElement`, so injecting that string with `innerHTML` would weaken the existing XSS protections.
- `buildTradablesListItemElement()` already receives the typed tradable and region-specific `priceData`.
- `createTradablesDetailedCardElement()` does not currently receive `appId`, `type`, or the GG.deals URL; its caller has all three and must pass them explicitly.
- Existing Steam IDs are numeric and types are normalized to `app`, `sub`, or `bundle`. Invalid IDs must continue to render as unresolved/plain text rather than producing malformed links.

## Design

### Shared external-link helpers (`popup/deals.js`)

1. Export `steamStoreUrl(id, type)` without changing its validation or typed URL behavior.
2. Add/export a DOM-oriented GG.deals helper, for example `createGgDealsLinkElement(url, options)`, implemented on top of `normalizeGgDealsUrl()` and the existing safe external-link creation path.
3. Keep `renderGgDealsLink()` for existing string-rendering call sites, but make both helpers share URL normalization, text (`GG.deals ↗`), `target="_blank"`, and `rel="noopener noreferrer"` rules.
4. Do not parse the HTML returned by `renderGgDealsLink()` and do not duplicate hostname/protocol checks in either tradables module.

### Compact Tradables (`popup/tradables.js`)

1. In `buildTradablesListItemElement()`:
   - Compute the Steam URL from the already-normalized `appId` and `item.type`.
   - Render `.tradables-name` as an anchor only when the URL is valid; otherwise retain the current span and text behavior.
   - Preserve the class name so current layout and tests remain stable.
   - Set `target`, `rel`, and a useful title. Stop propagation only if current delegated row handling would otherwise open the resolver popover when the link is clicked.
2. Append the DOM GG.deals link in `.tradables-item-meta` only when `priceData?.url` passes validation. Keep the app/sub/bundle ID and price badge unchanged.
3. Missing price data, missing URL, unsafe URL, unresolved item, zero price, and stale-cache price data must all render without exceptions.

### Tradables Detailed (`popup/tradables-detailed.js`)

1. Extend `createTradablesDetailedCardElement()` with optional `appId`, `type`, and `ggDealsUrl` inputs.
2. Render the title inside a Steam anchor only when `steamStoreUrl()` returns a valid URL; retain plain text otherwise.
3. Replace the literal `GG.deals:` prefix with the shared DOM link when valid. If no valid GG.deals URL exists, omit the link without leaving a dangling separator or empty label.
4. Pass `appId`, resolved type, and `data.url` from `initTradablesDetailed()` when constructing each card.
5. Do not change price selection, ATL calculations, acquisition-price calculations, or card filtering in this issue.

## Edge cases and failure behavior

- Typed links must use `/app/`, `/sub/`, or `/bundle/` correctly; unknown types fall back consistently with existing normalization.
- Invalid/non-numeric IDs produce no Steam link.
- Reject HTTP, credentialed, lookalike, javascript/data URLs, and non-GG.deals hosts.
- Titles containing markup remain text, never executable DOM.
- External-link clicks must not trigger quantity controls, removal, row selection, or resolver popovers.
- Multiple cards with the same appId remain independent DOM nodes.
- Link rendering must not alter list sorting, quantities, acquisition inputs, or price refresh rerenders.

## Tests

### Unit tests

- `tests/deals.test.js`: export behavior; app/sub/bundle Steam URL generation; invalid IDs/types; DOM GG.deals helper acceptance and rejection; `target`/`rel`; malicious URLs and text.
- `tests/tradables.test.js`: resolved item gets Steam title link and optional GG.deals link; unresolved item keeps plain title; invalid price URL is omitted; bundle/sub paths are correct; malicious title remains inert; existing quantity/removal/acquisition assertions remain green.
- `tests/tradables-detailed.test.js`: card receives and renders Steam/GG.deals links; missing/invalid values fall back cleanly; title safety; no dangling `GG.deals:` text; all range and acquisition calculations remain unchanged.

### Integration/no-regression tests

- Exercise a render followed by a price update to ensure links survive rerendering and use the new region's URL.
- Verify settings/region changes do not duplicate links.
- Run the complete popup unit suite, not only the three modified test files.

### E2E/manual smoke

- Add a Playwright popup scenario with one app, one sub/bundle, one unresolved item, and one invalid GG.deals URL fixture.
- Confirm links open the expected HTTPS URL in a new tab and do not open the resolve popover.
- Run `npm test`, `npm run build`, and `npm run test:e2e`; manually inspect both Tradables tabs at popup width and pop-out-tab width.

## Completion criteria

Both tradables views use the same validated link services as Deals, all unsafe/missing inputs fail closed, existing controls still work, and all unit/build/E2E verification is green.
