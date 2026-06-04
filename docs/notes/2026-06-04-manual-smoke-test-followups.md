# Manual Smoke Test Follow-ups

Date: 2026-06-04

## Context

Manual Firefox temporary add-on smoke test passed at a high level. Core behavior appears to match Chrome: fetching works, wishlist updates, and tradables are added as expected.

## Cross-browser / shared UI issues

These were observed in Firefox and may also affect Chrome.

### Extension icon not displayed

The browser extension icon is not shown in the toolbar/action UI.

Follow-up checks:

1. Confirm icons are present in the packaged output.
2. Confirm `manifest.json` declares both top-level `icons` and `action.default_icon` if needed.
3. Verify Chrome and Firefox toolbar display behavior after rebuilding.

### Settings arrows render as browser-native controls

In the Tradables detailed/settings UI, arrow controls render as browser-native arrows instead of the custom styled arrows seen in Chrome.

Follow-up checks:

1. Identify the source component/CSS for these arrows.
2. Check whether Firefox uses native `<select>`, `<details>`, numeric input spinners, or scrollbar/appearance styling differently.
3. Replace browser-native arrow rendering with explicit styled buttons/icons where appropriate.
4. Verify Chrome and Firefox visual parity.

## Verification target

After fixes:

```bash
rtk npm test
rtk npm run build:chrome
rtk npm run build:firefox
```

Then manually load both packages and compare toolbar icon plus Tradables detailed/settings arrows.
