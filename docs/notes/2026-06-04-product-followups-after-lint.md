# Product Follow-ups After Firefox Lint Review

Date: 2026-06-04

## Context

These are not Firefox-specific and should be handled after reviewing the 25 Firefox DOM assignment lint warnings.

## All games list count

Add a total game count to the "All games list" header so the user can immediately see how many games are in the list.

Acceptance criteria:

- Header displays total count for the current all-games list.
- Count updates when the list changes.
- Count remains readable in both sidebar and relevant responsive layouts.

## Dynamic price update after manual title resolution

When a game's name is manually changed to resolve an ambiguous match or fetch a different game, the price shown in the sidebar panel's All games list does not update dynamically.

Expected behavior:

- Manual resolution should update the displayed price in the All games list without requiring a full refresh.
- Behavior should match the dynamic update path already used after fetching prices.
- Any cached/resolved state should stay consistent with the selected title/game.

Follow-up checks:

1. Trace the dynamic update path used after price fetch.
2. Trace the manual title-resolution path.
3. Reuse the same UI update/broadcast mechanism where possible.
4. Add a focused regression test if the relevant UI/update helper is testable.
