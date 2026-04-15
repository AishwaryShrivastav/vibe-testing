# Vibe Testing — Full Project Knowledge Dump

> Generated: 2026-04-15 | Covers entire development history, architecture, current state, and future vision.

---

## 1. Original Vision

The original idea was a **testing tool that coding editors (Cursor, Claude Code, etc.) can invoke** to validate code changes. The tool would:

1. **Read the codebase** — understand routes, components, existing tests, and expected behaviors
2. **Understand functionality** — know what each page does, what forms exist, what APIs are called
3. **Generate test scenarios** — fill coverage gaps automatically
4. **Execute in a real browser** — using Playwright, headed so the user can watch
5. **Verify results** — determine pass/fail using heuristics (originally AI vision, now heuristic-only)
6. **Report** — HTML report with screenshots, coverage gaps, and suggestions
7. **Be available as an MCP server** — so Cursor/Claude Code can call `run_vibe_tests` as a tool, meaning the editor has **full control** over the testing agent

The **two key interfaces** were always:
- **CLI** (`vibe-test run <url>`) — for manual full end-to-end testing
- **MCP Server** (`vibe-test mcp`) — for editor integration, enabling the editor to test specific routes or the whole app

---

## 2. Directory Structure Problem

There are **two copies** of the codebase:

```
/vibe-testing/
├── src/                    ← ORIGINAL (v1) — older, has Anthropic SDK, markdown reports only
│   ├── cli.ts
│   ├── mcp-server.ts
│   ├── engine/
│   │   ├── browser/        (runner.ts, auth.ts, verifier.ts — no explorer)
│   │   ├── context/        (detector, router, extractor, enricher, gap-analyzer, test-reader)
│   │   ├── memory/
│   │   └── reporter/       (markdown only)
│   ├── types/
│   └── utils/
├── package.json            ← Still has @anthropic-ai/sdk dependency
│
└── vibe-test/              ← ACTIVE (v2) — all recent work, no Anthropic SDK, HTML reports
    ├── src/
    │   ├── cli.ts
    │   ├── mcp-server.ts
    │   ├── engine/
    │   │   ├── browser/    (runner.ts, auth.ts, verifier.ts, explorer.ts ← NEW)
    │   │   ├── context/    (same modules, heavily enhanced)
    │   │   ├── memory/     (enhanced with ProjectIntel, credentials persistence)
    │   │   └── reporter/   (html.ts ← NEW, markdown.ts)
    │   ├── types/
    │   └── utils/
    ├── package.json        ← No Anthropic SDK, clean dependencies
    └── README.md
```

**Decision needed**: The root `src/` is the **abandoned v1**. All active development is in `vibe-test/src/`. The root `src/` should be removed or archived, and `vibe-test/` should become the canonical source.

---

## 3. Architecture — Current Working Engine (`vibe-test/src/`)

### 3.1 Context Engine (`engine/context/`)

Performs static analysis of the target codebase:

| Module | Role |
|--------|------|
| `detector.ts` | Detects framework (Next.js App/Pages, React SPA, Express) from package.json |
| `router.ts` | Parses routes from the codebase (file-based for Next.js, react-router for SPAs, Express routes) |
| `extractor.ts` | Extracts route behaviors: forms, fields, labels, placeholders, buttons, dialogs, navigation flows, CRUD features, state variables, data display labels |
| `test-reader.ts` | Reads existing test files (Jest, Cypress, Playwright), extracts selectors, user flows, assertions, mock data keys → builds `TestIntelligence` per route |
| `gap-analyzer.ts` | Compares routes vs test coverage, scores gaps by priority |
| `enricher.ts` | Generates `TestScenario[]` from gaps + behaviors + intelligence. Auth flows, form tests, CRUD tests, search/filter, navigation, dialog lifecycle |
| `index.ts` | Orchestrates all 6 stages into `buildProductModel()` |

### 3.2 Browser Engine (`engine/browser/`)

| Module | Role |
|--------|------|
| `runner.ts` | Main orchestrator. Launches Playwright browser(s), splits scenarios into unauth/auth phases, establishes authenticated session by replaying login steps, extracts tokens, injects into new context. Runs each scenario step-by-step with screenshots. |
| `auth.ts` | Simple credential-based login (used when `auth.strategy === 'credentials'` in config). Not the primary auth path — `runner.ts` handles auth establishment itself by replaying the login scenario. |
| `explorer.ts` | **Runtime page explorer**: Discovers all interactive DOM elements (buttons, links, inputs, tabs, checkboxes), interacts with each, captures outcomes (dialog opened, navigated, toast shown, content changed, error), monitors API calls. |
| `verifier.ts` | Heuristic-based pass/fail verification. Checks URL changes, error indicators, success indicators, form validation, toasts, redirects. No LLM calls. |

### 3.3 Memory Engine (`engine/memory/`)

Persistent intelligence across runs:

- **`Memory`**: Bug tracking, flaky flows, verified flows (the original simple memory)
- **`ProjectIntel`**: Route-level intelligence (auth needs, form detection, load times, working/failed selectors), auth state, credential persistence, run history with trend tracking
- **`SavedCredentials`**: Email + password persisted from successful login, reused on subsequent runs to avoid re-registering users every time

### 3.4 Reporter (`engine/reporter/`)

- **`html.ts`**: Self-contained HTML report with dark theme. Sections: summary bar, failures/errors, passed scenarios, element exploration, coverage gaps & suggested tests, API monitoring, route coverage table, intelligence section. Step-level screenshots with click-to-enlarge modal.
- **`markdown.ts`**: Simpler markdown report (legacy)

### 3.5 MCP Server (`mcp-server.ts`)

Exposes one tool: `run_vibe_tests` with parameters: `url`, `codebase_path`, `mode`, `scope`, `headed`. Returns markdown summary + full report. This is how Cursor/Claude Code would invoke the tool.

### 3.6 CLI (`cli.ts`)

Commands: `run [url]`, `init`, `report`

---

## 4. Key Types (`types/index.ts`)

```
Framework → nextjs-app | nextjs-pages | react-spa | express | unknown
Route → { path, method, type, requires_auth, dynamic_segments, file_path }
FormField → { name, type, required, validations, label, placeholder, id }
PageFunctionality → { features[], buttons[], dialogs[], navigation_flows[], data_display[], state_vars[] }
RouteBehaviour → { route, forms[][], api_calls[], functionality, expected_success, expected_error }
TestIntelligence → { selectors, interactions, assertions, mock_data_keys, user_flows }
TestScenario → { id, name, route, priority, steps[], expected_outcome, requires_auth }
TestStep → { action, selector, value, url, timeout, description }
StepLog → { step, status, url_before, url_after, duration_ms, error, selector_used, screenshot_path }
TestResult → { scenario, status, duration_ms, screenshot_path, current_url, ai_verdict, step_logs, api_errors }
PageExploration → { route, elements_discovered, elements_by_type, interactions[], api_calls[], errors[] }
CoverageGapSuggestion → { route, missing, severity, suggested_test }
VibeRunResult → { product_model, results[], report, report_path, coverage_gaps[], summary }
```

---

## 5. Configuration (`types/config.ts`)

```typescript
{
  url: string              // Required — target URL
  codebase_path?: string   // Path to source code for static analysis
  auth?: {
    strategy: 'credentials' | 'skip'
    login_url?: string
    fields?: { email: string, password: string }
    credentials?: { email: string, password: string }
  }
  scope?: {
    include: string[]      // Route glob patterns
    exclude: string[]
    max_routes: number
  }
  memory?: {
    verify_after_n_passes: number
    max_runs_stored: number
  }
  browser?: {
    headed: boolean
    slowMo: number
    timeout: number
  }
  mode: 'fast' | 'deep'
}
```

---

## 6. Current Test Results (Joynaut)

### Latest Run (Run 3 — credentials saved):
- **8/21 passed (38%)** — all unauthenticated scenarios pass
- **Explorer working**: Discovered 17 elements across 6 public pages (buttons, links, inputs)
- **Auth issue**: Login form fills correctly, submit clicks, but page stays on `/login` — no tokens captured, no redirect. Likely the app requires email verification or the API response isn't being caught.
- **Credentials saved**: `vtcgbe6m@gmail.com` / `Test1234!` persisted for future runs
- **No registration on re-run**: Second run correctly said "Login with saved credentials" (skipped register)

### Known Issues:
1. **Auth session not establishing** — login API may fail silently or require email verification
2. **`label=` selector in enricher** — generates `label=X` pseudo-selectors, now handled in `runner.ts` via `page.getByLabel()`
3. **Explorer on protected pages** — never runs because auth doesn't establish
4. **Some step screenshots missing** — newly added step-level screenshots not yet verified in report

---

## 7. What Deviated from the Original Idea

### Original Intent:
- **MCP-first**: The coding editor (Cursor/Claude Code) is the primary consumer, calling the tool as needed
- **Targeted testing**: Editor says "test this route" or "test this function I just changed" — not always full E2E
- **Editor controls the LLM**: If LLM reasoning is needed, the editor's own LLM handles it, not a built-in Anthropic call
- **Small + fast**: Quick focused tests, not 90-second full-app sweeps

### What We Built Instead:
- **CLI-first**: Most usage is `vibe-test run <url>` — a full E2E sweep every time
- **Always full sweep**: No way to test just one route or one function
- **Self-contained**: Removed Anthropic SDK but also lost the "editor calls us" workflow
- **Heavy**: Full codebase analysis + all routes + explorer = slow for quick checks

### What Should Change:
1. **MCP server should be the primary interface** — not just a wrapper around the full CLI
2. **Add granular MCP tools**: `test_route`, `test_function`, `explore_page`, `check_auth`, `get_coverage_report`
3. **URL-only mode**: User can just pass a URL without codebase — explore + test dynamically
4. **Incremental testing**: Test only changed routes, not everything
5. **Editor awareness**: The MCP server should accept the current file/function being edited and auto-scope

---

## 8. Dependencies

```json
{
  "@modelcontextprotocol/sdk": "^1.0.0",
  "playwright": "^1.44.0",
  "commander": "^12.0.0",
  "glob": "^11.0.0",
  "chalk": "^5.3.0",
  "ora": "^8.0.1",
  "zod": "^3.23.0"
}
```

No external LLM dependencies. TypeScript compiled with `ES2022` + `DOM` lib targets.

---

## 9. File-by-File Summary (Active Codebase: `vibe-test/src/`)

### `cli.ts` (113 lines)
CLI entry point. Commands: `run`, `init`, `report`. Parses vibe.config.json, merges with CLI options, creates `VibeTester`, calls `run()`.

### `mcp-server.ts` (96 lines)
MCP server with single `run_vibe_tests` tool. Needs expansion to support granular tools.

### `engine/index.ts` (264 lines)
`VibeTester` class. Orchestrates: load memory → build product model → execute scenarios → learn from results → generate coverage gaps → write HTML report.

### `engine/context/detector.ts` (31 lines)
Framework detection from package.json dependencies.

### `engine/context/router.ts` (266 lines)
Route parsing per framework. React SPA: reads router files, extracts `<Route path="...">` and `navigate()` calls. Next.js: file-system routing.

### `engine/context/extractor.ts` (~500 lines)
Heavy static analysis. Reads each route's source file. Extracts: forms, input fields, labels, placeholders, buttons (with action type), dialogs, navigation flows, CRUD features, state variables, data display labels. Builds `RouteBehaviour[]`.

### `engine/context/test-reader.ts` (~340 lines)
Reads Jest/Cypress/Playwright test files. Extracts per-route: selectors (by text, role, placeholder, test-id, label), interactions, assertions, mock data keys, user flows. Builds `CoverageMap`.

### `engine/context/gap-analyzer.ts` (~65 lines)
Scores each route's test gap (50 for no tests, +15 for missing error states, +10 for no auth test, etc.). Prioritizes high/medium/low.

### `engine/context/enricher.ts` (647 lines)
Scenario generation engine. Auth flows (register + login), redirect checks, CRUD dialog lifecycle (create, cancel, empty submit), search/filter, edit/save, navigation, data display verification. Uses `TestIntelligence` for smart selectors and values.

### `engine/browser/runner.ts` (697 lines)
Playwright execution. Two-phase architecture (unauth browser → close → fresh auth browser). Step-by-step execution with locator resolution cascade (label → placeholder → id → name → type → text → role → raw CSS). Submit detection with settle waiting (URL change, network idle, toast). Step-level screenshots.

### `engine/browser/explorer.ts` (648 lines)
Runtime element discovery (string-eval in browser context for compatibility). Interaction testing: buttons (click → detect dialog/toast/navigate/content change), inputs (fill with smart test values), tabs, links, checkboxes. API call monitoring. Dialog exploration and auto-close.

### `engine/browser/verifier.ts` (~200 lines)
Heuristic pass/fail. Checks: URL matches expected, no error indicators visible, success indicators present, form validation errors shown when expected, redirects correct, API errors detected.

### `engine/browser/auth.ts` (49 lines)
Simple login helper for `auth.strategy === 'credentials'`. Not the primary auth path.

### `engine/memory/index.ts` (407 lines)
`MemoryManager` with `Memory` (bugs, flaky/verified flows) + `ProjectIntel` (route-level intel, auth state, saved credentials, run history, working selectors). Learns from each run: which routes need auth, which selectors work, what to skip.

### `engine/reporter/html.ts` (443 lines)
Self-contained HTML report. Dark theme. Sections: header, summary bar, failures, passes, element exploration table, coverage gaps with suggested test steps, API monitoring, route coverage, intelligence. Step thumbnails with click-to-enlarge.

### `types/index.ts` (238 lines)
All shared types. See section 4.

### `types/config.ts` (39 lines)
Zod schema for config. See section 5.

### `utils/file.ts` (37 lines)
readJSON, writeJSON, fileExists, glob, readFile, ensureDir.

### `utils/env.ts` (19 lines)
Environment variable interpolation for config values like `${VIBE_EMAIL}`.

### `utils/logger.ts` (~60 lines)
Colored console logger with section headers, success/error/warn/dim/spinner.

---

## 10. Selector Resolution Strategy

The enricher generates selectors in this priority:
1. `placeholder=X` → `page.getByPlaceholder(X)`
2. `label=X` → `page.getByLabel(X)`
3. `#id` → `page.locator('#id')`
4. `[name="x"]` → `page.locator('[name="x"]')`
5. `[type="x"]` → `page.locator('[type="x"]')`
6. `text=X` → `page.getByText(X)`
7. `role=button[name="X"]` → `page.getByRole('button', {name: X})`
8. Raw CSS fallback

The runner's `resolveLocator()` tries each strategy, picks first visible match.

---

## 11. Credential Persistence Flow

1. First run: generates random email (`vt{rand}@gmail.com`) + password `Test1234!`
2. Generates register + login scenarios
3. After run, `learnAuth()` saves credentials to `ProjectIntel.credentials`
4. Next run: `getRecommendations()` includes `saved_credentials`
5. `enricher.ts` checks `recs.saved_credentials` — if present, skips register, uses saved email/password for login
6. Credentials only fully confirmed when `auth.session_established === true`

---

## 12. Proposed Modular Architecture (Next Phase)

### Core Modules (independent, composable):

```
@vibe-test/core
├── context/        ← Static analysis (framework detection, route parsing, behavior extraction)
├── browser/        ← Playwright automation (page navigation, element interaction, screenshots)
├── explorer/       ← Runtime element discovery and testing
├── verifier/       ← Pass/fail heuristics
├── memory/         ← Persistent intelligence
├── reporter/       ← Report generation (HTML, markdown, JSON)
└── types/          ← Shared types and config schema

@vibe-test/cli      ← CLI wrapper
@vibe-test/mcp      ← MCP server with granular tools
```

### MCP Tools (proposed):

| Tool | Description | Use Case |
|------|-------------|----------|
| `run_full_test` | Full E2E sweep (current behavior) | "Test the whole app" |
| `test_route` | Test a single route | "I changed /clients, test it" |
| `test_url` | Test any URL without codebase | "Test https://staging.app.com/login" |
| `explore_page` | Discover and interact with all elements | "What's on this page?" |
| `check_auth` | Verify authentication works | "Is login working?" |
| `get_coverage` | Return coverage gaps | "What's not tested?" |
| `suggest_tests` | Generate test scenarios for a route | "What should I test for /checkout?" |
| `run_scenario` | Execute a specific scenario by ID | "Run VTS-005 again" |

---

## 13. Open Questions

1. **Should the root `src/` be deleted?** It's the abandoned v1 and creates confusion.
2. **Should `vibe-test/` be flattened to root?** The extra nesting is confusing.
3. **Auth establishment**: The login API on Joynaut may require email verification — how to handle apps that do this?
4. **LLM integration**: The MCP server lets the editor's LLM call our tools, but should we also allow the editor's LLM to help with verification (passing page content back to the editor for analysis)?
5. **URL-only mode**: When no codebase path is given, should we still try to discover routes by crawling, or just explore the given URL?
