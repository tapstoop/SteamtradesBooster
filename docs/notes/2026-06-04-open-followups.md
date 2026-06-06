# Open Follow-ups

Date: 2026-06-04

This note consolidates the follow-ups from the Firefox MV3 packaging pass and records their current status.

## Worktree Lifecycle

For each implementation plan in `docs/superpowers/plans/`, create its documented branch and a dedicated worktree from the latest `firefox-mv3-packaging` only when work on that plan begins. Do not create empty placeholder branches in advance; they become stale while the base branch continues to move. After a feature is merged and verified, remove its worktree and feature branch.

## DOM Rendering Hardening (Completed 2026-06-06)

### Current status

The data-bearing renderers listed below were converted to DOM builders with focused malicious-input and interaction tests. Final verification passed with 242 tests, successful Chrome and Firefox builds, and Firefox lint reporting zero errors and one warning.

The remaining warning is the documented structured settings shell assignment. Its dynamic values are escaped and event-bound after rendering; rewriting that entire static shell was deferred to avoid disproportionate UI regression risk.

### Scope

Prioritize data-bearing render paths in:

- `popup/tradables.js`
- `popup/deals.js`
- `popup/tradables-bulk-modal.js`
- `popup/tradables-detailed.js`
- `popup/settings.js`
- `content/ui-pickers.js`
- `content/ui-workstation.js`

### Implementation approach

1. Convert data-bearing render helpers from HTML strings to DOM builders.
   - Prefer `document.createElement`, `textContent`, `className`, `dataset`, and `replaceChildren`.
   - Use `setAttribute` only after validating the value being assigned.
2. Convert `renderPriceBadge()` in `popup/tradables.js` to return an `HTMLElement` instead of an HTML string.
3. Convert card/list HTML helper patterns to element builders where they still mix UI structure and dynamic data.
4. Add small local DOM helper functions where they reduce repeated boilerplate.
   - Example: `createTextSpan(className, text)`.
   - Example: `createSafeExternalLink(url, label)`.
5. Work through remaining `innerHTML` warnings.
   - Static shell templates can be migrated after data-bearing renderers are done.
   - If a warning is intentionally left because the markup is static, document why near the assignment, while recognizing this may not silence Firefox lint by itself.

### Testing

Use test-first changes for each converted renderer. Add or update tests that parse rendered output with `JSDOM` and assert:

- malicious text remains text, not markup
- no unexpected `img`, `script`, or unsafe links are created
- no event-handler attributes such as `onerror`, `onclick`, or `onfocus` are present
- invalid cached or stored Steam IDs render as unresolved
- valid app, sub, and bundle IDs still render as expected

Recommended focused commands:

```bash
rtk npm test -- tests/tradables.test.js
rtk npm test -- tests/deals.test.js
rtk npm test -- tests/tradables-modal.test.js
```

Final verification:

```bash
rtk npm test
rtk npm run build:firefox
rtk npx web-ext lint --source-dir <current firefox package directory>
```

Result: Firefox unsafe-DOM warnings were reduced from 25 to 1, with no remaining user-controlled injection path found during review.

## Firefox Smoke-Test Follow-ups

Manual Firefox temporary add-on smoke testing passed at a high level. Core behavior appeared to match Chrome: fetching worked, wishlist updates worked, and tradables were added as expected.

### Extension icon not displayed

The browser extension icon was not shown in the toolbar/action UI.

Follow-up checks:

1. Confirm icons are present in the packaged output.
2. Confirm `manifest.json` declares both top-level `icons` and `action.default_icon` if needed.
3. Verify Chrome and Firefox toolbar display behavior after rebuilding.

### Settings arrows render as browser-native controls

In the Tradables detailed/settings UI, arrow controls rendered as browser-native arrows instead of the custom styled arrows seen in Chrome.

Follow-up checks:

1. Identify the source component/CSS for these arrows.
2. Check whether Firefox uses native `<select>`, `<details>`, numeric input spinners, or scrollbar/appearance styling differently.
3. Replace browser-native arrow rendering with explicit styled buttons/icons where appropriate.
4. Verify Chrome and Firefox visual parity.

Verification after fixes:

```bash
rtk npm test
rtk npm run build:chrome
rtk npm run build:firefox
```

Then manually load both packages and compare toolbar icon plus Tradables detailed/settings arrows.

## Product Follow-ups

These are not Firefox-specific, but were identified during the packaging/lint pass.

### All games list count

Add a total game count to the "All games list" header so the user can immediately see how many games are in the list.

Acceptance criteria:

- Header displays total count for the current all-games list.
- Count updates when the list changes.
- Count remains readable in both sidebar and relevant responsive layouts.

### Dynamic price update after manual title resolution

When a game's name is manually changed to resolve an ambiguous match or fetch a different game, the price shown in the sidebar panel's All games list does not update dynamically.

Expected behavior:

- Manual resolution updates the displayed price in the All games list without requiring a full refresh.
- Behavior matches the dynamic update path already used after fetching prices.
- Cached/resolved state stays consistent with the selected title/game.

Follow-up checks:

1. Trace the dynamic update path used after price fetch.
2. Trace the manual title-resolution path.
3. Reuse the same UI update/broadcast mechanism where possible.
4. Add a focused regression test if the relevant UI/update helper is testable.

## npm Audit Follow-up

### Current status

Remediation completed on 2026-06-06. The June 4 baseline from `npm audit --omit=optional` reported six development/test-tooling vulnerabilities:

- 1 critical: `vitest <4.1.0`.
- 5 moderate: transitive `vite`, `vite-node`, `@vitest/mocker`, Vite's nested `esbuild`, and `postcss`.

These dependencies are not shipped in the packaged extension runtime. The practical risk is local development exposure, especially if Vitest UI or Vite development servers are exposed beyond localhost or used on untrusted networks.

The non-breaking audit fix updated `postcss` from 8.5.8 to 8.5.15 and `nanoid` from 3.3.11 to 3.3.12. The remaining advisories required a reviewed Vitest major upgrade. Updating `vitest` from 2.1.9 to 4.1.8 also updated its transitive Vite toolchain and removed the vulnerable nested `esbuild`.

### Verification

```bash
rtk npm test
rtk npm run build:chrome
rtk npm run build:firefox
rtk npm audit --omit=optional
```

Results:

- Tests: 20 files passed, 244 tests passed.
- Chrome build: passed.
- Firefox build: passed.
- Audit: found 0 vulnerabilities.
- Runtime extension impact: none identified; the changed packages are development/test tooling and are not included in the packaged extension.
- Compatibility requirement: Vitest 4's Vite toolchain requires Node.js `^20.19.0` or `>=22.12.0`. Verification used Node.js 24.14.0.

### Publication impact

The completed tooling remediation does not block Firefox packaging or publication.
