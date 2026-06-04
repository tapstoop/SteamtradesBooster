# Firefox Lint DOM Warning Follow-up

Date: 2026-06-04

## Current status

`web-ext lint --source-dir steamtrades_booster_firefox_v0.1.2` passes with zero errors, but reports 25 warnings for dynamic assignments to `innerHTML` or `outerHTML` in the bundled content and popup scripts.

These warnings are pre-existing and were not introduced by the Firefox packaging work.

## Why it matters

Mozilla flags dynamic `innerHTML` and `outerHTML` assignments because they can become cross-site scripting risks when unsanitized user, page, or API data reaches the DOM. The extension renders SteamTrades, Steam, and GG.deals-derived data, so each warning should be reviewed before Firefox publication.

## Implementation approach

1. Run `rtk npx web-ext lint --source-dir steamtrades_booster_firefox_v0.1.2` after a fresh Firefox build.
2. Map each bundled warning back to source files in `content/`, `popup/`, or shared UI helpers.
3. Classify each assignment:
   - Static trusted template markup.
   - Escaped/sanitized dynamic content.
   - Unsanitized dynamic content that should be replaced.
4. Replace risky dynamic HTML with DOM construction, `textContent`, or narrowly escaped template helpers.
5. Add focused tests for any helper or rendering path that changes behavior.
6. Rebuild and rerun Firefox lint until warnings are either eliminated or documented with a clear reason.

## Verification target

A future hardening pass should aim for:

```bash
rtk npm test
rtk npm run build:firefox
rtk npx web-ext lint --source-dir steamtrades_booster_firefox_v0.1.2
```

Expected result: zero lint errors and fewer or no unsafe DOM assignment warnings.
