# Issue #19 - Workstation resolution states and dual titles

## Goal and dependencies

Make All Page Games a complete operational view: unresolved/fuzzy/removed rows are visible with meaningful status badges, every listed title can jump to its SteamTrades row, resolvable badges open the correct picker, and changed titles can show both page and Steam source names. Keep the toolbar compact and reject formatting-only rows before they reach resolution or the workstation.

Implement after #14 supplies stable progressive row state and after #15 finalizes removed-status semantics. This avoids adding a temporary delisted exception and then reopening the workstation.

## Current implementation to extend

The issue's original proposal is partly stale relative to main:

- `originalTitle` is already captured and passed to the workstation.
- `createGameRow()` already has an Original names rendering path.
- `SidebarWorkstation.updateResolvedPageGame(stptId, update)` already patches page/trade collections and rerenders.
- The virtual list already supports dynamic item height.

Extend these paths; do not add parallel `updateGameByEl()` state or duplicate `.stpt-game-original-title` styles.

## Workstation row contract

#14 should provide complete placeholder/resolved objects. Ensure `setPageGames()` receives and preserves:

```js
{
  stptId,
  el,
  section,
  originalTitle,
  title,
  appId,
  type,
  resolutionStatus,
  resolution,
  cacheKey,
  candidates,
  fuzzy,
  similarity,
  inWishlist,
  inTradables,
  price,
  currency
}
```

`stptId` is the stable update identity. DOM element identity is used only for scrolling/event dispatch, not as the primary data key.

Extend `updateResolvedPageGame()` to patch all resolution fields atomically and preserve unspecified fields. Continue propagating applicable updates to `inTrade.mine`/`inTrade.trader`, but do not insert unresolved games into the simulator.

## Visibility and filtering policy

- All Page Games remains limited to the page's `have` section.
- Show pending/resolving, ambiguous, not-found, fuzzy, resolved, manual-delisted, and #15 `removed_*` rows.
- Hide dismissed rows because the user explicitly marked them as not a game.
- Search matches both `originalTitle` and resolved/source `title`, case-insensitively.
- Counts reflect visible rows after dismissed/status/search filtering and keep the existing `Total:` label behavior.
- Unresolved rows do not show an Add-to-trade action until they have a usable appId. Resolved removed games follow #15's explicit simulator policy; default to non-addable if no meaningful price is available.
- Replace the separate Wishlist and Tradables toggles with one temporary multi-select dropdown. Include every compact badge category currently rendered: Wishlist, Tradables, Delisted, Purchase disabled, Banned, Pending, Ambiguous, Not found, Fuzzy, and Resolution failed.
- Multiple selected badge filters use OR semantics. The resulting badge-filtered set is then combined with text search using AND semantics. No selection means no badge filtering.

## Resolution badges (`content/ui-components.js`)

Extend `createGameRow()` with an `onResolve(game, anchorEl)` callback and render one compact, dimensionally stable status control:

- `pending`/`resolving`: neutral non-clickable pending indicator only if needed; avoid an animated control that shifts virtual rows.
- `ambiguous`: amber `? N`, where N is validated candidate count.
- `not-found`: red `N/A`.
- fuzzy resolved: yellow `≈ <percent>%`, clamped to 0-100 and tolerant of missing similarity.
- manual delisted and `removed_*`: use #15 shared read-only status metadata; these are not resolver buttons.

Use a real button for clickable resolution statuses with `type="button"`, accessible label/title, keyboard focus, and click propagation stopped. Do not use a clickable span. Keep row height fixed for single-title and dual-title modes.

Define the compact badge descriptors and filter keys in one shared source so rendering and filtering cannot drift. Do not add filters for concepts that have no compact badge in this list, such as Deal, Bundle, or an unbadged state. Preserve the existing SteamTrades color meaning while using the minimal W/T/D/P/B and resolution labels.

## Title navigation

Render the title container as a button in All Page Games, including rows without badges. Clicking the title only scrolls to the current connected source row; it must not open a picker or add a game to the simulator. Resolution-badge clicks retain their combined scroll-and-picker behavior.

Resolve the source row from the current `stptId` state, apply and restart the temporary highlight before scrolling, and use reduced-motion-safe scrolling. The highlight must appear even when the browser does not move because the target is already visible. Repeated navigation, including the same target, restarts the effect and its timeout. Detached or replaced source rows are ignored safely, and all timers/listeners are removed when the workstation is destroyed.

## Picker orchestration (`content/ui-workstation.js`)

Add one private method such as `_openResolutionForGame(game, anchorEl)`:

1. Validate the game still exists, is not dismissed, and has the required cacheKey/candidates/resolution fields.
2. Call `game.el.scrollIntoView({ behavior:'smooth', block:'center' })` when connected.
3. After approximately 150 ms, dynamically import `ui-pickers.js` and revalidate both the game row and anchor.
4. Call the picker with distinct roles:
   - ambiguous: `openCandidatePicker(anchorEl, candidates, cacheKey, game.el, { position: 'fixed' })`;
   - not-found: `openNotFoundPicker(anchorEl, cacheKey, originalTitle || title, game.el, { position: 'fixed' })`;
   - fuzzy: `openFuzzyPicker(anchorEl, resolution, game.el, { position: 'fixed' })`.

The workstation badge is `anchorEl` for popup positioning; the SteamTrades game element is `rowEl` for `stpt-resolve`/dismiss/recheck events. Never pass the page row as both arguments. Extend `positionNear()` with an optional fixed strategy so workstation pickers remain beside their listing badge during page scroll; preserve absolute positioning for existing SteamTrades callers.

Update `openFuzzyPicker()` compatibly: the optional third `rowEl` defaults to its current page-anchor behavior for existing callers, but workstation calls use it explicitly so “wrong game/dismiss” updates the correct SteamTrades row.

If the virtual list rerenders and removes the anchor during the delay, cancel cleanly or locate the current badge by stable `stptId`; do not position against a detached node. Import/picker failure should leave the row usable and may log a concise warning.

## Dual-title behavior

Reconcile the issue with the existing Original names toggle:

- Toggle off: retain current compact resolved/source title display.
- Toggle on and titles differ: show the original SteamTrades title as the primary line and the resolved Steam source title as the subdued second line (`→ ...`).
- Toggle on and titles match/missing: render one line.
- Apply to any changed resolution, not only `manuallyResolved`; fuzzy and confirmed source-title differences are equally relevant.

Reuse the existing title container and original-title styles, adding only a source-title class if necessary. Update `_hasAnyDualTitle()` to use actual title difference rather than `manuallyResolved`, so virtual item height matches rendered rows. Search/sort must remain stable when the toggle changes.

## Input cleanup and dismiss presentation

- Reject extracted titles that contain no Unicode letter or number, including repeated ASCII/Unicode separators, symbol borders, emoji-only rows, and invisible formatting-only rows.
- Keep symbol-only titles when an explicit valid Steam or SteamDB app identity proves the row is intentional.
- Conservatively remove long leading/trailing decorative borders around a real title. Preserve internal punctuation, one-sided meaningful punctuation, numeric-only titles, accented Latin, Cyrillic, and CJK titles.
- Apply cleanup before deduplication and do not mark rejected DOM nodes as game rows.
- Render every picker dismissal action as a real button with red, non-italic, semi-bold text and clear red hover/focus treatment. This is presentation and accessibility only; persistence, events, and dismissal semantics remain unchanged.

Keep the filter trigger narrow, allow its menu to remain open while several options are selected, give the search input the flexible width, keep the sort selector compact, and wrap controls at narrow column widths.

## Progressive rendering and performance

All Page Games consumes the existing page-local progressive state; it must not start its own profile, resolver, Steam, Steam Tracker, bundle, or GG.deals requests. Preserve the shared cache-first batches, tier/viewport priorities, concurrency limits, selective-fetch policy, run identity, and stale-result guards.

Apply row patches synchronously by indexed `stptId`, but coalesce their DOM work into at most one animation-frame render. Invalidate only the data list and the Wishlist, Tradables, in-trade, or simulator sections whose visible inputs changed. Remove the unused workstation Wishlist collection, and do not rerender All Page Games when only the external Tradables collection changes.

Coalesce virtual-list calculations, skip unchanged row heights, keep rendered nodes bounded to the viewport, and release its pending frame and `ResizeObserver` on destruction. When `showSidebar` is false at startup, do not construct the workstation; page badges continue progressively. A later enable creates it from current row state without restarting resolution or pricing. An existing hidden workstation retains state while deferring DOM work and flushes once when shown.

## Synchronization after resolution

- Existing `content-handlers.js` calls to `updateResolvedPageGame()` remain the single workstation update path.
- Ensure startup progressive results, candidate confirmation, not-found search selection, fuzzy correction, recheck, dismiss, manual delisted, and #15 removed-status updates all patch status/candidates/fuzzy/title/appId consistently.
- A successful resolution removes the clickable unresolved badge, enables normal appId actions, and updates price asynchronously without rebuilding unrelated rows.
- Dismissal removes the row from All Page Games and adjusts count immediately.
- If price fetch fails, the resolved title/status remains; do not revert to unresolved.

## Edge cases

- Candidate arrays missing/empty, cacheKey missing, similarity null/out of range, disconnected page row, detached virtual anchor, rapid repeated badge clicks, and picker import failure.
- Resolution completes while smooth-scroll delay is pending; revalidate and avoid opening a stale picker.
- Two rows with the same title/appId remain independently addressable by `stptId`.
- Sorting/filtering/virtual scrolling during a patch preserves scroll position as far as the current virtual-list API allows.
- Original/resolved titles containing markup remain text.
- Very long titles truncate without overlapping status, price, or action controls.
- Removed/manual-delisted indicators are read-only unless #15 explicitly exposes a valid manual action.
- Dismissed rows do not reappear on price/settings updates.
- Wishlist/tradable highlighted sections use compatible title rendering but need not expose resolve controls unless intentionally included.
- Opening/closing the filter menu, selecting several options, outside click, Escape/focus return, collapsing/hiding the workstation, and destroying/recreating an instance do not leak menu state or document listeners.
- Progressive status changes immediately enter or leave active badge filters, and a shrinking result set clamps virtual scroll to a valid position.
- Decoration cleanup handles spaced and attached borders, trusted/untrusted links, duplicate cleaned titles, and all supported DOM structures (`li`, `p`/`br`, and table rows).
- Multiple progressive patches in one frame render only the latest state once; hidden workstations accumulate state without DOM churn and stale runs cannot schedule obsolete UI.

## Tests

### Component unit tests

- `createGameRow()` renders every status badge class/text/accessibility state.
- Ambiguous/not-found/fuzzy buttons invoke `onResolve` with the current button anchor and stop propagation.
- Removed/delisted/pending indicators are non-clickable.
- Add-to-trade is absent for unresolved rows.
- Dual-title toggle semantics, equal/missing titles, long/malicious titles, and dynamic row-height predicate.
- Shared compact descriptor/filter-key parity for all ten filter categories, including fuzzy/removal precedence and malformed states.
- Navigable and passive title-container semantics.

### Workstation unit tests

- `updateResolvedPageGame()` patches all new fields, preserves unspecified state, updates duplicate collections by `stptId`, and rerenders once per logical update.
- Search matches original and resolved names; dismissed filtering and counts are correct.
- Picker dispatch uses workstation anchor plus page row, waits for scroll, and chooses the correct picker.
- Fake-timer tests cover resolution changing during delay, detached anchors/rows, rapid double-click, and dynamic-import rejection.
- Fuzzy picker optional `rowEl` preserves existing page-badge callers.
- Virtual-list item heights update when the Original names toggle changes or resolutions create/remove dual titles.
- Dropdown lifecycle, OR badge filtering, search AND filters, progressive state transitions, virtual-scroll clamping, title navigation/highlight replacement, reduced motion, and detached source rows.
- Repeated same-target highlighting resets its timer, and workstation pickers use fixed viewport positioning while page pickers remain absolute.

### Content/integration tests

- #14 progressive ambiguous/not-found/fuzzy results appear in workstation immediately.
- Candidate/not-found/fuzzy resolution updates inline badge and workstation row together.
- Dismiss removes the row; recheck restores it with the current status.
- #15 removed statuses propagate as read-only rows.
- Price and settings updates do not erase resolution metadata or duplicate rows.
- Existing simulator totals, selection, quantity, sorting, search, and original-title tests remain green.
- Parser cleanup rejects decoration-only rows without mutating them and preserves valid Unicode, numeric, punctuated, and explicitly linked symbol-only titles.
- Large-list tests verify indexed patches, one render per frame, targeted section invalidation, bounded virtual DOM, and virtual-list cleanup.

### E2E/manual verification

- Large fixture with ambiguous, not-found, fuzzy, removed, dismissed, and resolved rows.
- Click each resolver badge: verify smooth scroll, correctly anchored picker, selection, row update, count, and action availability.
- Toggle Original names and verify original-primary/resolved-secondary display without layout overlap at minimum and expanded sidebar widths.
- Resolve while list is filtered/scrolled to exercise virtual rerender stability.
- Verify all ten dropdown options, multi-selection without auto-closing, title-only navigation for an unbadged row, and the conspicuous keyboard-focusable dismiss action.
- With `showSidebar` disabled, verify that badges still resolve without workstation DOM; enabling it later must hydrate existing rows without a second resolution or price pipeline.
- Run `npm test`, Chrome/Firefox builds, full E2E suite, and manual smoke on a real mixed-resolution trade page.

## Completion criteria

All meaningful page-game states are represented coherently in the workstation, resolution actions target the correct DOM row, existing title/update infrastructure is reused, virtual-list behavior remains stable, and every state transition is covered by unit/integration/E2E tests.
