# AGENTS.md

## Project summary

SteamTrades Booster is a Chrome Manifest V3 extension for steamtrades.com. It adds Steam/GG.deals price tracking, visual badges, candidate pickers, a trade simulator sidebar, and a popup dashboard for wishlist and tradables management.

## Architecture map

- `manifest.json`: Chrome MV3 manifest, permissions, host permissions, content scripts, background service worker, popup.
- `background/`: service worker, API gateway, cache, title resolver, Steam profile/wishlist helpers, GG.deals client, snapshots.
- `content/`: steamtrades.com content script, page parser, badges, pickers, sidebar workstation, trade simulator UI.
- `popup/`: extension popup dashboard, settings, wishlist deals, tradables manager, bulk import.
- `styles/`: content and popup CSS.
- `utils/`: shared title/region/fuzzy-match helpers.
- `tests/`: Vitest unit tests with mocked Chrome APIs and network calls.
- `build.js`: packages the extension into `steamtrades_booster_v<version>/` and `steamtrades_booster_v<version>.zip`.
- `docs/solutions/`: documented solutions to past problems (bugs, best practices, architecture patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.

## Setup

Install dependencies with:

```bash
npm ci
```

## Verification commands

Use the smallest command that proves the change.

```bash
npm test
npm run build
```

Run `npm test` after changing logic in `background/`, `content/`, `popup/`, `utils/`, or `tests/`.
Run `npm run build` after changing bundling, manifest behavior, entry points, imports, popup shell, styles copied by the build, or anything that may affect the packaged extension.

The build writes ignored artifacts:

- `steamtrades_booster_v*/`
- `steamtrades_booster_v*.zip`

Do not commit generated build artifacts unless explicitly requested.

## Coding guidelines

- Keep changes focused on the requested issue; do not introduce unrelated refactors.
- Preserve Manifest V3 constraints: the background service worker is event-based and cannot rely on persistent in-memory state.
- Persist durable state in `chrome.storage` or IndexedDB, not module-level service-worker variables.
- Prefer existing message types and storage keys over parallel mechanisms.
- Update all relevant call sites when changing message payloads, storage shapes, or exported functions.
- Do not add mocks in production code. Tests may mock Chrome APIs and network calls following existing test patterns.
- Avoid unnecessary allocation, repeated DOM scans, and repeated normalization in hot content-script paths.
- Keep DOM mutations batched or targeted where possible; trade pages can contain many game rows.
- Preserve the current dynamic-import boundary between badge and picker UI unless there is a clear reason to change it.
- Do not store API keys, Steam IDs, or user-specific settings in source files.

## Chrome extension constraints

- Content script entry is `content/content.js`; it is bundled as an IIFE into `dist/content.js` for the packaged extension.
- Background service worker and popup are also bundled by `build.js` for Brave/Chrome compatibility.
- Content scripts communicate with the service worker through `chrome.runtime.sendMessage`.
- Background-to-content broadcasts use `chrome.tabs.sendMessage` for events such as `SETTINGS_UPDATED` and `PRICE_UPDATED`.
- Host permissions cover SteamTrades, Steam, Steam Community, GG.deals, and GG.deals API.

## Domain concepts

- Game rows are parsed from `.have` and `.want` sections on SteamTrades pages.
- Tiers:
  - Tier 1: game is on the user's Steam wishlist.
  - Tier 2: game is in the user's tradables list.
  - Tier 4: neither wishlist nor tradable; fetched selectively or lazily depending on settings.
- Resolution statuses include `hit`, `resolved`, `fuzzy`, `ambiguous`, `not-found`, `dismissed`, and `delisted`.
- Badge priority is `DEAL` > `WISH` > `TRADE` > `BUNDLE` > plain/NA, with secondary badges for fuzzy, delisted, dismissed, and related states.
- GG.deals API calls are rate-limited and cached. Respect the existing queue/rate-limit behavior.
- Steam Sub IDs may need expansion into contained app IDs before pricing.

## Review guidelines

When reviewing changes, focus on issues that can break users or corrupt data:

- Chrome MV3 lifecycle bugs, especially service-worker state assumptions.
- Broken `chrome.runtime.sendMessage` contracts or unhandled asynchronous responses.
- Storage migration regressions, especially around `settings`, `tradables_list`, and cached resolution/price keys.
- Rate-limit regressions in GG.deals calls.
- Incorrect title normalization or fuzzy matching that can attach prices to the wrong game.
- DOM injection bugs on SteamTrades pages with large or unusual `.have`/`.want` sections.
- Popup flows that can overwrite settings, tradables, acquisition prices, or snapshots.
- Build/package regressions that prevent the extension from loading in Chrome/Brave.
- Leaking API keys or user identifiers into logs, source, generated artifacts, or PR comments.

Do not spend review comments on subjective style unless it affects correctness, maintainability, accessibility, or extension reliability.

## Common change entry points

- Trade-page pricing or fetch behavior: start in `content/content.js`.
- Game parsing, tier assignment, checkboxes: start in `content/parser.js`.
- Badge rendering or resolution UI: start in `content/ui-badges.js` and `content/ui-pickers.js`.
- Trade simulator/sidebar: start in `content/ui-workstation.js` and `content/trade-logic.js`.
- Popup wishlist deals: start in `popup/deals.js`.
- Popup tradables management: start in `popup/tradables.js`, `popup/tradables-bulk-modal.js`, and `popup/tradables-parser.js`.
- Settings: start in `popup/settings.js` and `background/service-worker.js`.
- API, cache, title resolution: start in `background/ggdeals.js`, `background/resolver.js`, `background/cache.js`, and `background/service-worker.js`.

## Pull request expectations

Before opening or updating a PR:

1. Explain the user-visible behavior change.
2. List the files changed and why.
3. Run the relevant verification command(s).
4. Report exact command results.
5. Call out any verification that could not be run and the concrete reason.
