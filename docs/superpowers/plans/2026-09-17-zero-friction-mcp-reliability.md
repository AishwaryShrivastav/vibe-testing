# Zero-friction MCP reliability implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vibe-testing work reliably through `npx` and MCP on TanStack and unfamiliar web frameworks, with truthful reports and a canonical custom domain.

**Architecture:** Preserve static code analysis as the primary source of product context, then add bounded runtime detection and same-origin crawling as recovery paths. Keep the existing 13 MCP tools compatible, add one idempotent `configure` tool, and centralize detection/configuration logic outside the large MCP handler.

**Tech Stack:** TypeScript, Node.js ESM, Commander, MCP SDK, Playwright, Vitest, GitHub Pages, Cloudflare DNS.

---

## File map

- Create `src/utils/direct-execution.ts`: symlink-safe ESM entrypoint detection.
- Create `src/engine/context/server-detector.ts`: bounded live-server candidate discovery and validation.
- Create `src/engine/context/auth-detector.ts`: source/page authentication classification.
- Create `src/engine/browser/live-routes.ts`: same-origin live-link discovery and smoke scenarios.
- Create `src/configure.ts`: idempotent project configuration shared by CLI and MCP.
- Modify `src/cli.ts`: use the direct-execution helper, shared configuration, and clean output.
- Modify `src/mcp-server.ts`: server instructions, `configure`, optional URL handling, and recovery orchestration.
- Modify `src/engine/context/detector.ts`: TanStack detection and evidence-based URL hints.
- Modify `src/engine/context/router.ts`: TanStack file-route parsing.
- Modify `src/engine/context/test-reader.ts`: dependency/build exclusions.
- Modify `src/engine/index.ts`: return a diagnostic no-scenario result instead of throwing for expected discovery gaps.
- Modify `src/types/index.ts` and `src/types/config.ts`: typed detection and diagnostic fields.
- Modify `README.md`, `MCP-SETUP.md`, `CHANGELOG.md`, `package.json`, `server.json`, `mcp.json`, `plugin.json`, `site/index.html`, `site/app.js`, and `site/CNAME`: document and publish the MCP-first workflow and canonical domain.
- Add focused tests under `test/` for each new boundary.

### Task 1: Repair CLI execution and generated setup

**Files:**
- Create: `src/utils/direct-execution.ts`
- Modify: `src/cli.ts`
- Test: `test/cli-entrypoint.test.ts`
- Test: `test/configure.test.ts`

- [ ] **Step 1: Write failing entrypoint tests**

Test `isDirectExecution(import.meta.url, argvPath)` with the real file, a temporary symlink, and `/tmp` versus `/private/tmp` canonical paths. Spawn `node_modules/.bin/vibe-testing --help` and assert visible help and exit code zero.

```ts
expect(isDirectExecution(moduleUrl, symlinkPath)).toBe(true)
expect(spawned.stdout).toContain('Usage: vibe-testing')
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `npx vitest run test/cli-entrypoint.test.ts test/configure.test.ts`

Expected: failure because the helper does not exist and the current symlink invocation prints nothing.

- [ ] **Step 3: Implement canonical direct-execution detection**

Resolve both paths with `realpathSync.native`, tolerate missing paths, and compare canonical filesystem paths. Replace the exact `process.argv[1] === fileURLToPath(import.meta.url)` guard with:

```ts
if (isDirectExecution(import.meta.url, process.argv[1])) {
  program.parseAsync(process.argv).catch(handleCliFailure)
}
```

- [ ] **Step 4: Repair init output and generated guidance**

Render actual line breaks, remove assumed `/login` credentials from the default `VIBE.md`, and idempotently add `.vibe/` to `.gitignore`. Preserve existing user-authored guidance.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run test/cli-entrypoint.test.ts test/configure.test.ts test/cli-init-prompt.test.ts && npm run build && npx vibe-testing --help`

Expected: all tests pass, TypeScript builds, and CLI help is visible.

Commit: `fix: make CLI setup reliable through npx`

### Task 2: Add TanStack support and trustworthy scanning

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/engine/context/detector.ts`
- Modify: `src/engine/context/router.ts`
- Modify: `src/engine/context/test-reader.ts`
- Modify: `src/utils/file.ts`
- Test: `test/detector.test.ts`
- Test: `test/router.test.ts`
- Create: `test/test-reader.test.ts`

- [ ] **Step 1: Write failing TanStack detection and route tests**

Cover `@tanstack/react-start`, `@tanstack/react-router`, `src/routes/__root.tsx`, `index.tsx`, `_authenticated/dashboard.tsx`, and `users/$userId.tsx`. Expected public paths are `/`, `/dashboard`, and `/users/:userId`; `__root` is not emitted.

- [ ] **Step 2: Write failing exclusion tests**

Create real tests under `src/` and noise under `node_modules`, `.output`, `dist`, `build`, `.next`, `.vibe`, and `coverage`. Assert only the source test contributes to coverage and scenario names.

- [ ] **Step 3: Run tests and confirm failure**

Run: `npx vitest run test/detector.test.ts test/router.test.ts test/test-reader.test.ts`

Expected: TanStack is classified as `react-spa`, no TanStack routes are found, and dependency/build tests are counted.

- [ ] **Step 4: Implement TanStack detection and file routes**

Add `tanstack-router` to the framework type. Prefer explicit TanStack dependencies before generic React detection. Parse route paths using one normalization function that removes pathless groups, maps `index` to the parent route, converts `$param` to `:param`, and ignores `__root`.

- [ ] **Step 5: Centralize scan exclusions**

Give the shared glob wrapper an ignore list:

```ts
export const SCAN_IGNORES = [
  '**/node_modules/**', '**/.git/**', '**/.vibe/**', '**/.next/**',
  '**/.output/**', '**/dist/**', '**/build/**', '**/coverage/**'
]
```

Apply it to test and route discovery without excluding legitimate source folders.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run test/detector.test.ts test/router.test.ts test/test-reader.test.ts test/scope.test.ts && npm run build`

Expected: focused and compatibility tests pass.

Commit: `feat: support TanStack routes with trustworthy scans`

### Task 3: Detect the live server and authentication method

**Files:**
- Create: `src/engine/context/server-detector.ts`
- Create: `src/engine/context/auth-detector.ts`
- Modify: `src/engine/context/detector.ts`
- Modify: `src/types/index.ts`
- Create: `test/server-detector.test.ts`
- Create: `test/auth-detector.test.ts`

- [ ] **Step 1: Write failing server detector tests**

Start local HTTP fixtures on random ports. Assert precedence for explicit URL and configured URL, detection from a Vite `--port 8080` script, and rejection of non-HTML or unreachable candidates. Inject candidate ports and fetch into tests so no arbitrary network scan occurs.

- [ ] **Step 2: Write failing authentication tests**

Cover a Google OAuth button, email/password fields, and an app with no visible authentication. Return a typed result:

```ts
type AuthDetection = {
  method: 'oauth' | 'password' | 'unknown' | 'none'
  provider?: 'google' | 'github' | 'microsoft' | 'other'
  loginPath?: string
  evidence: string[]
}
```

- [ ] **Step 3: Run tests and confirm failure**

Run: `npx vitest run test/server-detector.test.ts test/auth-detector.test.ts`

Expected: modules are missing.

- [ ] **Step 4: Implement bounded server detection**

Evaluate explicit URL, config URL, script/config hints, currently listening loopback ports, then `[3000, 3001, 4173, 4321, 5173, 5174, 8080]`. Probe only loopback HTTP endpoints with short timeouts and require HTML. Return the chosen URL plus evidence and attempted candidates.

- [ ] **Step 5: Implement authentication classification**

Combine route/source hints with visible browser controls. Never return credentials. OAuth detection must produce a user action explaining that an interactive or stored browser session is required.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run test/server-detector.test.ts test/auth-detector.test.ts test/detector.test.ts && npm run build`

Expected: all tests pass without external network access.

Commit: `feat: detect running apps and authentication`

### Task 4: Add MCP configuration and self-healing full tests

**Files:**
- Create: `src/configure.ts`
- Create: `src/engine/browser/live-routes.ts`
- Modify: `src/mcp-server.ts`
- Modify: `src/engine/index.ts`
- Modify: `src/engine/context/index.ts`
- Modify: `src/types/index.ts`
- Create: `test/mcp-configure.test.ts`
- Create: `test/live-routes.test.ts`
- Modify: `test/scenario-reliability.test.ts`
- Modify: `test/empty-run.test.ts`
- Modify: `test/package.test.ts`

- [ ] **Step 1: Write failing MCP manifest and configuration tests**

Assert the tool list contains the existing 13 names plus `configure`. Invoke `configure` against a temporary TanStack project and assert a minimal config, idempotent `.gitignore`, no placeholder password, and structured framework/server/auth output.

- [ ] **Step 2: Write failing live-route fallback tests**

Serve a fixture with same-origin links, duplicate fragments, an external link, logout/delete paths, and a dynamic query. Assert the crawler returns unique safe paths and creates non-destructive navigate/assert smoke scenarios only.

- [ ] **Step 3: Rewrite zero-scenario expectations**

Replace stack-trace expectations with a diagnostic outcome containing framework, static route count, crawl status, and next action. Preserve a non-success verdict when nothing can safely execute.

- [ ] **Step 4: Run tests and confirm failure**

Run: `npx vitest run test/mcp-configure.test.ts test/live-routes.test.ts test/scenario-reliability.test.ts test/empty-run.test.ts test/package.test.ts`

Expected: `configure` and fallback behavior are absent.

- [ ] **Step 5: Implement shared configuration**

Expose:

```ts
export async function configureProject(input: {
  codebasePath: string
  url?: string
}): Promise<ConfigureResult>
```

Use it from both CLI init and MCP. Writes must be idempotent and never overwrite authored `VIBE.md` content.

- [ ] **Step 6: Add MCP instructions and `configure`**

Initialize the server with concise instructions describing `configure -> run_full_test -> generate_report`. Add `configure` to `ListTools`, dispatch it in `CallTool`, and keep every existing schema unchanged.

- [ ] **Step 7: Implement same-origin recovery**

When static scenarios are empty, launch Playwright, crawl from `/` within a fixed page/depth budget, filter the action blocklist, and create smoke scenarios with explicit page-health assertions. Store route origin metadata so reports distinguish `static` from `live-crawl`.

- [ ] **Step 8: Make `run_full_test` orchestrate recovery**

Allow `url` to be omitted. Resolve project, server, framework, routes, auth, static scenarios, live fallback, execution, and report in order. Return a structured diagnostic report even when execution cannot proceed safely.

- [ ] **Step 9: Verify and commit**

Run: `npx vitest run test/mcp-configure.test.ts test/live-routes.test.ts test/scenario-reliability.test.ts test/empty-run.test.ts test/package.test.ts test/browser-reliability.test.ts && npm run build`

Expected: existing tools remain compatible, configuration is idempotent, and empty static discovery recovers or reports clearly.

Commit: `feat: make MCP setup and full testing self-healing`

### Task 5: Correct report metrics and complete regression coverage

**Files:**
- Modify: `src/engine/reporter/html.ts`
- Modify: `src/engine/reporter/markdown.ts`
- Modify: `src/engine/context/index.ts`
- Create: `test/report-metrics.test.ts`
- Modify: `test/html-report-verification.test.ts`

- [ ] **Step 1: Write failing metric tests**

Build a product model with 19 static routes, 11 crawled pages, and 14 executed scenarios. Include 700 ignored dependency tests. Assert reports say `19 routes discovered`, `11 live pages observed`, and `14 scenarios executed`; they must never say `700 routes tested`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npx vitest run test/report-metrics.test.ts test/html-report-verification.test.ts`

Expected: current report wording or source counts fail the assertions.

- [ ] **Step 3: Implement typed report metrics**

Derive every displayed metric from `ProductModel.routes`, crawl results, and `TestResult[]`. Reserve “tested” and “executed” for browser runs. Label source-test coverage separately.

- [ ] **Step 4: Run the full suite and build**

Run: `npm test && npm run build`

Expected: all tests pass and TypeScript emits cleanly.

- [ ] **Step 5: Commit**

Commit: `fix: make QA report counts match executed evidence`

### Task 6: Dogfood on AI Astrology Guru

**Files:**
- Modify only if required by verified failures: files from Tasks 1–5
- Do not commit Guruji's unrelated working tree changes.

- [ ] **Step 1: Pack the candidate package**

Run: `npm pack --dry-run` and then create a local tarball for testing.

Expected: package contains `dist`, metadata, README, and no repository-only artifacts.

- [ ] **Step 2: Test CLI through a temporary npx-style install**

Install the tarball into a disposable directory and run `npx vibe-testing --help`, `npx vibe-testing init`, and a public test against Guruji's running app or a local fixture.

Expected: visible output, TanStack detection, active URL selection, OAuth guidance, `.vibe/` ignore, and no stack trace.

- [ ] **Step 3: Test MCP over stdio**

Run a real MCP initialize/list-tools/configure/run flow against the package tarball.

Expected: instructions are present, 14 tools are listed, TanStack routes are found, and a report is generated without patching Guruji's `node_modules`.

- [ ] **Step 4: Record verification in the changelog**

Document the observed framework, URL, auth method, discovered routes, attempted scenarios, and report path without committing generated Guruji artifacts.

- [ ] **Step 5: Commit**

Commit: `docs: record Guruji reliability dogfood`

### Task 7: Publish the release and canonical website

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `MCP-SETUP.md`
- Modify: `server.json`
- Modify: `mcp.json`
- Modify: `plugin.json`
- Modify: `site/index.html`
- Modify: `site/app.js`
- Create: `site/CNAME`
- Modify: `test/site.test.ts`
- Modify: `test/package.test.ts`

- [ ] **Step 1: Update release metadata and public copy**

Bump the patch version, document the CLI/TanStack/recovery fixes, make MCP-first setup the primary flow, and use `https://vibetesting.tfgstudio.com` as canonical. Keep copy consistent with the repository writing guidelines.

- [ ] **Step 2: Add SEO and package tests**

Assert canonical URL, title/description, sitemap/robots links where present, `SoftwareApplication` structured data, `site/CNAME`, and matching package/repository URLs.

- [ ] **Step 3: Run release verification**

Run: `npm test && npm run build && npm pack --dry-run && npm run build:mcpb`

Expected: all tests pass, package contents are correct, and the MCPB bundle builds.

- [ ] **Step 4: Commit and push main**

Commit: `release: vibe-testing <next-patch-version>`

Push: `git push origin main`

- [ ] **Step 5: Publish npm and GitHub release**

Publish the verified package using the existing npm authentication, tag the exact release commit, push the tag, and create/update the GitHub release. Verify `npm view vibe-testing version` and a clean temporary `npx` invocation.

- [ ] **Step 6: Configure the custom domain**

Create Cloudflare DNS `CNAME vibetesting.tfgstudio.com -> aishwaryshrivastav.github.io`, configure the GitHub Pages custom domain, enforce HTTPS after certificate issuance, and verify the canonical site and old GitHub Pages URL.

- [ ] **Step 7: Submit the repaired listing**

Update existing MCP directory entries and submit to the approved testing/MCP directories using the canonical domain and verified install command. Record links and status under `docs/distribution/launch-status.md`.
