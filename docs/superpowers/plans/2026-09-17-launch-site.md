# vibe-testing launch site implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a distinctive evidence-led product site and prepare accurate marketplace submissions without changing the npm package.

**Architecture:** A dependency-free site lives in `site/` and deploys through GitHub Pages. A small Node test checks critical copy, links, analytics hooks, and accessibility structure. Distribution documents keep marketplace-specific copy separate from the product runtime.

**Tech Stack:** HTML, CSS, browser JavaScript, Node.js assertions, GitHub Actions.

**Completed:** 2026-09-17. Commit `0b600ac` shipped the site and distribution assets. GitHub Pages is live, CI and Pages passed, and the current state is recorded in `docs/distribution/launch-status.md`.

---

### Task 1: Build the release dossier

**Files:**
- Create: `site/index.html`
- Create: `site/styles.css`
- Create: `site/app.js`

- [x] Write semantic page structure with real install links and product evidence.
- [x] Implement the ruled QA dossier visual system and responsive layouts.
- [x] Add command copying, regression switching, and stable analytics events.

### Task 2: Verify the site

**Files:**
- Create: `test/site.test.ts`
- Modify: `package.json`

- [x] Assert the site exposes npm, GitHub, install, report evidence, all thirteen tools, and first-user CTA.
- [x] Run `npm test` and `npm run build`.
- [x] Serve `site/`, inspect desktop and mobile screenshots, and fix visible defects.

### Task 3: Deploy through GitHub Pages

**Files:**
- Create: `.github/workflows/pages.yml`

- [x] Upload `site/` as the Pages artifact on pushes to `main`.
- [x] Deploy with `pages: write` and `id-token: write` permissions.
- [x] Enable GitHub Pages with the Actions build type and verify the public URL.

### Task 4: Prepare distribution submissions

**Files:**
- Create: `docs/distribution/marketplace-listings.md`
- Create: `docs/distribution/glama-diagnosis.md`
- Modify: `README.md`

- [x] Record exact title, description, install command, repository, icon, and submission steps for Cursor, Claude, Smithery, PulseMCP, and mcp.so.
- [x] Document the public Glama state and the credential-free repair path.
- [x] Link the product site and distribution formats from the README.

### Task 5: Ship

- [x] Run the complete test, build, manifest, link, and working-tree checks.
- [x] Commit the site and distribution assets.
- [x] Push `main`, watch CI and Pages, then verify the deployed site.
