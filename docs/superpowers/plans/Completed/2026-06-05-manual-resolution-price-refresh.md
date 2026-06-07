# Manual Resolution Price Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user manually resolves a page game to a different title/app, the sidebar All Page Games list updates its displayed title/id/price immediately without a full refresh.

**Architecture:** Reuse the existing workstation price update path, but make it update by row identity as well as current app id. The manual `stpt-resolve` handler already fetches prices and updates rowData; it needs to push the resolved identity and price into the workstation's `pageGames` before re-rendering.

**Tech Stack:** Content script event handling, `SidebarWorkstation`, vanilla DOM, Vitest/JSDOM.

**Execution Branch:** `feature/manual-resolution-price-refresh`, based on `firefox-mv3-packaging`.

**Worktree Lifecycle:** Create this branch and its dedicated worktree from the latest `firefox-mv3-packaging` only when implementation begins. Do not keep an empty placeholder branch, because it will become stale as the base branch advances.

---

## File Structure

- Modify `content/ui-workstation.js`: add `updateResolvedPageGame(stptId, update)` and use it before/with `updateGamePrices()`.
- Modify `content/content.js`: call the new workstation method in the `stpt-resolve` handler after rowData updates and before rendering price updates.
- Modify `tests/ui-workstation.test.js`: assert resolved title/app/price replaces the row in the all-games list.

### Task 1: Workstation Row Identity Update

**Files:**
- Modify: `content/ui-workstation.js`
- Modify: `tests/ui-workstation.test.js`

- [ ] **Step 1: Write failing workstation update test**

Add:

```js
it('updates a page game by stpt id after manual resolution', () => {
  const workstation = new SidebarWorkstation({ threshold: 0.1 });
  workstation.setPageGames([
    { stptId: '7', title: 'Ambiguous Name', section: 'have', appId: null, type: 'app', price: null },
  ]);

  workstation.updateResolvedPageGame('7', {
    title: 'Resolved Game',
    appId: '456',
    type: 'app',
    price: 1234,
    currency: 'EUR',
  });

  const row = workstation.el.querySelector('.stpt-game-row');
  expect(row.textContent).toContain('Resolved Game');
  expect(row.textContent).toContain('€12.34');
  workstation.destroy();
});
```

If `createGameRow()` formats price through a specific class, prefer that selector assertion after checking existing markup.

- [ ] **Step 2: Run focused test**

Run: `rtk npm test -- tests/ui-workstation.test.js`

Expected: FAIL because `updateResolvedPageGame()` does not exist.

- [ ] **Step 3: Include row id in page games**

In `content/content.js`, update the initial `workstation.setPageGames(rowData.map(...))` object:

```js
stptId: r.el.dataset.stptId,
```

- [ ] **Step 4: Add workstation update method**

In `SidebarWorkstation`:

```js
updateResolvedPageGame(stptId, update) {
  if (stptId == null) return;
  const id = String(stptId);
  const apply = game => {
    if (String(game.stptId ?? '') !== id) return game;
    return {
      ...game,
      title: update.title ?? game.title,
      name: update.name ?? update.title ?? game.name,
      appId: update.appId ?? game.appId,
      type: update.type ?? game.type,
      price: update.price ?? game.price ?? null,
      currency: update.currency ?? game.currency ?? 'EUR',
    };
  };
  this.pageGames = this.pageGames.map(apply);
  this.inTrade.mine = this.inTrade.mine.map(apply);
  this.inTrade.trader = this.inTrade.trader.map(apply);
  this._renderDataList();
  this._renderWishlistSection();
  this._renderTradablesSection();
  this._renderInTrade();
  this._updateSimStats();
}
```

- [ ] **Step 5: Run focused test**

Run: `rtk npm test -- tests/ui-workstation.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add content/ui-workstation.js tests/ui-workstation.test.js
rtk git commit -m "feat: update workstation rows after manual resolution"
```

### Task 2: Wire Manual Resolution Event

**Files:**
- Modify: `content/content.js`
- Test: `tests/ui-workstation.test.js` or new focused content helper test if event logic is extracted

- [ ] **Step 1: Extract price payload helper if needed**

If `stpt-resolve` remains hard to test directly, extract:

```js
function buildResolvedWorkstationUpdate({ title, appId, type, priceData, settings }) {
  const update = { title, appId, type };
  if (priceData) {
    update.price = _getBadgePrice(priceData, settings);
    update.currency = priceData.prices?.currency ?? getDisplayRegion(settings);
  }
  return update;
}
```

Export it only for tests if existing test patterns allow.

- [ ] **Step 2: Add helper test**

Assert that `buildResolvedWorkstationUpdate()` returns `{ title, appId, type, price, currency }` from a region price object.

- [ ] **Step 3: Call workstation update in `stpt-resolve`**

After `priceData` is computed and `gameInfo` is created:

```js
if (window.__stpt_workstation) {
  const resolvedUpdate = buildResolvedWorkstationUpdate({ title, appId, type, priceData, settings });
  window.__stpt_workstation.updateResolvedPageGame(rowEl.dataset.stptId, resolvedUpdate);
}
```

Keep the existing `setWorkstationPrice()` call for compatibility with price broadcasts. The new row-id update fixes the case where the old page game had no app id or had a different app id.

- [ ] **Step 4: Run focused tests**

Run: `rtk npm test -- tests/ui-workstation.test.js`

Expected: PASS.

- [ ] **Step 5: Run full content-relevant tests**

Run: `rtk npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add content/content.js tests/ui-workstation.test.js
rtk git commit -m "fix: refresh sidebar price after manual resolution"
```

## Self-Review

- Spec coverage: Manual resolution updates title, app id, type, and price in the All Page Games list without reload.
- Placeholder scan: All code paths and commands are concrete.
- Type consistency: `stptId` is the row identity used from DOM dataset through workstation updates.
