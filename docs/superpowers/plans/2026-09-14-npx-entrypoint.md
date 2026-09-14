# npx entrypoint implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx vibe-testing@latest init` resolve the CLI while preserving the existing CLI and MCP binary names.

**Architecture:** Package metadata exposes a package-name alias to the existing CLI artifact. A Vitest package-contract test guards the alias, and a packed-install smoke test verifies npm creates all three executable links.

**Tech Stack:** npm package metadata, TypeScript, Vitest, GitHub Actions trusted publishing.

---

### Task 1: Protect the executable contract

**Files:**
- Create: `test/package.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'

describe('package executables', () => {
  it('exposes the package name as the default npx command', () => {
    expect(packageJson.bin['vibe-testing']).toBe('dist/cli.js')
    expect(packageJson.bin['vibe-test']).toBe('dist/cli.js')
    expect(packageJson.bin['vibe-test-mcp']).toBe('dist/mcp-server.js')
  })
})
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `npm test -- test/package.test.ts`

Expected: FAIL because `packageJson.bin['vibe-testing']` is undefined.

- [ ] **Step 3: Add the package-name alias**

Add `"vibe-testing": "dist/cli.js"` to `package.json#bin`, preserving the existing entries.

- [ ] **Step 4: Run the package test and full suite**

Run: `npm test -- test/package.test.ts && npm test && npm run build`

Expected: 65 tests pass and TypeScript exits 0.

### Task 2: Verify the published artifact contract

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Date and update the 0.4.3 changelog**

Replace `unreleased` with `2026-09-14` and add an item explaining that `npx vibe-testing@latest` now resolves the CLI.

- [ ] **Step 2: Pack and install in a temporary project**

Run `npm pack --json`, install the resulting tarball in a temporary project, and inspect `node_modules/.bin`.

Expected links: `vibe-testing`, `vibe-test`, and `vibe-test-mcp`.

- [ ] **Step 3: Smoke-test the installed commands**

Run `npx --no-install vibe-testing --version`, `npx --no-install vibe-test --version`, and send an MCP initialize request to `npx --no-install vibe-test-mcp`.

Expected: both CLI commands print `0.4.3`; the MCP response reports `0.4.3`.

- [ ] **Step 4: Commit and push the release fix branch**

Commit only the package contract, test, changelog, design, and plan. Push `fix/npx-entrypoint` for review.

- [ ] **Step 5: Release after review**

Fast-forward `main`, create tag `v0.4.3`, push the tag, and verify both GitHub publish jobs and public registry metadata.
