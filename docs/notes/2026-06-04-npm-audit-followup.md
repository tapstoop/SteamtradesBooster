# npm Audit Follow-up

Date: 2026-06-04

## Current status

`npm audit --omit=optional` reports 6 vulnerabilities:

- 1 critical: `vitest <4.1.0`, arbitrary file read/execute when the Vitest UI server is listening.
- 5 moderate: transitive `vite`, `vite-node`, `@vitest/mocker`, `vite`'s nested `esbuild`, and `postcss`.

Dependency tree observed:

```text
steamtrades-price-tracker@0.1.2
├── esbuild@0.27.4
└─┬ vitest@2.1.9
  ├─┬ @vitest/mocker@2.1.9
  │ └── vite@5.4.21
  ├─┬ vite-node@2.1.9
  │ └── vite@5.4.21
  └─┬ vite@5.4.21
    ├── esbuild@0.21.5
    └── postcss@8.5.8
```

## Risk assessment

These vulnerabilities are in development/test tooling, not in the packaged extension runtime. The generated Chrome/Firefox extension bundles application code with the direct `esbuild@0.27.4`; it does not ship Vitest, Vite, Vite Node, or PostCSS as runtime dependencies.

The practical risk is local development exposure, especially if Vitest UI or Vite development servers are exposed beyond localhost or used on untrusted networks.

## Follow-up approach

1. Try a non-breaking `npm audit fix` on a separate branch/worktree.
2. Run:

```bash
rtk npm test
rtk npm run build:chrome
rtk npm run build:firefox
```

3. If vulnerabilities remain, evaluate upgrading `vitest` from 2.x to 4.x manually.
4. Treat the Vitest major upgrade as potentially breaking: review release notes and test behavior before merging.
5. Avoid `npm audit fix --force` without review, because it upgrades Vitest across major versions.

## Publication impact

This should not block Firefox packaging smoke-test validation, but it should be reviewed before publishing or distributing development tooling instructions broadly.
