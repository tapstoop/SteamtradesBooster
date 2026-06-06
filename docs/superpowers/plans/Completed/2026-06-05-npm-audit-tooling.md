# npm Audit Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce or document development-tooling vulnerabilities reported by `npm audit --omit=optional` without forcing risky major upgrades.

**Architecture:** Run the audit work on an isolated branch because it can modify `package-lock.json`. Try non-breaking `npm audit fix` first, then evaluate a Vitest/Vite manual upgrade only if vulnerabilities remain.

**Tech Stack:** npm, Vitest/Vite dev dependencies, Chrome/Firefox extension build scripts.

**Execution Branch:** `chore/npm-audit-tooling`, based on `firefox-mv3-packaging`.

**Worktree Lifecycle:** Create this branch and its dedicated worktree from the latest `firefox-mv3-packaging` only when implementation begins. Do not keep an empty placeholder branch, because it will become stale as the base branch advances.

---

## File Structure

- Modify `package-lock.json`: expected from `npm audit fix`.
- Modify `package.json`: only if a manual `vitest` upgrade is required and reviewed.
- Create or update `docs/notes/2026-06-04-open-followups.md`: record remaining vulnerabilities and why they are dev-only if unresolved.

### Task 1: Baseline Audit

**Files:**
- No intended source changes.

- [ ] **Step 1: Confirm clean worktree**

Run: `rtk git status --short --branch`

Expected: clean branch `chore/npm-audit-tooling`.

- [ ] **Step 2: Run baseline audit**

Run: `rtk npm audit --omit=optional`

Expected: current vulnerability report for dev/test tooling. Save the package names, severity, and dependency path in the task notes.

- [ ] **Step 3: Commit nothing**

Run: `rtk git status --short`

Expected: no changes.

### Task 2: Non-Breaking Audit Fix

**Files:**
- Modify: `package-lock.json`
- Possibly modify: `package.json`

- [ ] **Step 1: Run non-breaking fix**

Run: `rtk npm audit fix --omit=optional`

Expected: npm updates dependency metadata without `--force`.

- [ ] **Step 2: Inspect dependency changes**

Run:

```bash
rtk git diff -- package.json package-lock.json
rtk npm audit --omit=optional
```

Expected: either fewer vulnerabilities or a clear remaining report that requires a manual decision.

- [ ] **Step 3: Run verification**

Run:

```bash
rtk npm test
rtk npm run build:chrome
rtk npm run build:firefox
```

Expected: PASS.

- [ ] **Step 4: Commit non-breaking fix**

```bash
rtk git add package.json package-lock.json
rtk git commit -m "chore: apply non-breaking npm audit fixes"
```

Skip this commit if `npm audit fix` made no changes.

### Task 3: Manual Vitest Upgrade Decision

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Update: `docs/notes/2026-06-04-open-followups.md`

- [ ] **Step 1: Decide whether vulnerabilities remain**

If `rtk npm audit --omit=optional` reports no vulnerabilities, skip to Task 4.

If vulnerabilities remain under Vitest/Vite, inspect current installed versions:

```bash
rtk npm ls vitest vite
```

- [ ] **Step 2: Review release notes before major upgrade**

Use official Vitest/Vite release notes for the target major version. Record breaking changes relevant to `vitest run`, JSDOM, ESM, globals, and coverage behavior.

- [ ] **Step 3: Apply reviewed manual upgrade**

Only after review, choose the smallest Vitest version that includes the fixed Vite dependency and keeps the current Vitest major when possible. Write the chosen exact command into the task notes before running it. For example, if the review shows `vitest@2.1.9` is the first safe fixed version, run:

```bash
rtk npm install -D vitest@2.1.9
```

Do not use `npm audit fix --force`.

- [ ] **Step 4: Run verification**

Run:

```bash
rtk npm test
rtk npm run build:chrome
rtk npm run build:firefox
rtk npm audit --omit=optional
```

Expected: tests/builds pass. Audit either passes or remaining items are documented as dev-only with rationale.

- [ ] **Step 5: Commit manual upgrade or documentation**

```bash
rtk git add package.json package-lock.json docs/notes/2026-06-04-open-followups.md
rtk git commit -m "chore: update vitest tooling after audit review"
```

### Task 4: Final Publication Note

**Files:**
- Update: `docs/notes/2026-06-04-open-followups.md`

- [ ] **Step 1: Record final audit status**

Add a short note:

```md
Audit status after remediation:

- `npm audit --omit=optional`: <result>
- Runtime extension impact: none identified; affected packages are development/test tooling.
- Follow-up required before publication: <none or exact package/version>.
```

- [ ] **Step 2: Commit**

```bash
rtk git add docs/notes/2026-06-04-open-followups.md
rtk git commit -m "docs: record npm audit remediation status"
```

## Self-Review

- Spec coverage: Non-breaking fix first, manual Vitest review second, no `--force`.
- Placeholder scan: The manual upgrade step requires release-note review before running a concrete versioned install command; no force upgrade is allowed.
- Type consistency: All verification commands match package scripts on `firefox-mv3-packaging`.
