# Vibe Testing — Audit: Original Vision vs Current Product

> Comprehensive gap analysis comparing the founding document against what we've built.
> Generated: 2026-04-15

---

## Executive Summary

The current product delivers approximately **60% of the original vision**. The context engine, browser execution, memory layer, element-level testing, and HTML reporting are solid and working. The major gaps are: the MCP server is a monolithic single-tool wrapper instead of the granular multi-tool interface the doc specifies; there's no VIBE.md guidance file; no action blocklist; no API endpoint testing (only API *monitoring*); no test file generation; no dependency graph; no coverage audit with blocker detection; no permission modes; no JSON output; and the verification is heuristic-only rather than delegating to the editor's LLM for vision-based judgment.

What we built is genuinely good — particularly the explorer, the credential persistence, the step-level screenshots, and the multi-phase browser architecture. Several of these are **improvements beyond the original doc** (the doc didn't specify credential persistence, step screenshots, or the intelligent selector resolution cascade). The foundation is production-quality. The gaps are all additive — nothing needs to be torn down.

---

## Feature-by-Feature Comparison

### CONTEXT ENGINE

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Stage 1: Framework detection** | Detect Next.js App/Pages, React SPA, Express, unknown | **DONE** | Identical to spec. Falls back to `unknown`. |
| **Stage 2: Route parsing** | Parse routes per framework, detect auth-required, dynamic segments | **DONE** | Covers Next.js App/Pages, React SPA, Express. Dynamic segments detected. Auth detection via `useAuth`/`withAuth` patterns. |
| **Stage 3: Behaviour extraction** | Extract forms, fields, validation rules (Zod/Yup), expected outcomes | **PARTIAL** | Forms, fields, labels, placeholders, buttons, dialogs, features extracted. **Missing**: Zod/Yup schema parsing for validation rules. Expected outcomes are inferred strings, not LLM-enriched (by design — we don't call LLMs). |
| **Stage 4: Test file reading** | Read Jest, Cypress, Playwright test files, extract coverage | **DONE** | Reads all three frameworks. Extracts selectors, interactions, assertions, mock data, user flows. Builds `TestIntelligence` per route. **Improved beyond doc**: extracts 463 selectors and 313 user flows from Joynaut's test suite. |
| **Stage 5: Gap analysis** | Score gaps 0-100, factor in memory/flaky history | **DONE** | Scoring implemented with memory integration. Flaky flows boost priority, verified flows reduce it. |
| **Stage 6: Scenario generation** | Heuristic (fast) + LLM-enriched (deep) | **PARTIAL** | Heuristic generation is comprehensive: auth flows, CRUD lifecycle, search/filter, form validation, navigation, data display. **Missing**: Deep mode LLM enrichment (by design — no internal LLM calls). The MCP server should delegate this to the editor's LLM but currently doesn't have the granular tools to do so. |
| **VIBE.md project guidance** | Read project-specific knowledge from `VIBE.md` | **NOT BUILT** | No `VIBE.md` support at all. The tool has no way to receive project-specific guidance (known flaky flows, payment testing notes, env vars, auth strategy explanations). |
| **URL crawl fallback** | When framework is unknown, discover routes by crawling | **NOT BUILT** | Unknown framework returns empty routes. Should fall back to following links in the browser. |

### BROWSER ENGINE

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Playwright headed browser** | Chromium, headed, slowMo, 1280x800 | **DONE** | Identical to spec. |
| **Authentication** | Login via credentials, preserve session, handle failure gracefully | **DONE, IMPROVED** | Two-phase auth: replay login scenario → extract tokens → inject into new context. Graceful fallback when auth fails (marks auth scenarios as skipped). **Improved beyond doc**: Credential persistence across runs, fresh browser for auth phase to avoid resource exhaustion. |
| **Scenario execution** | Step-by-step: navigate, fill, click, select, wait, hover. Timeout per step. | **DONE** | All step types implemented. 15s default timeout. Screenshots at each step. **Missing**: `hover` action not implemented. |
| **Screenshot capture** | Full-page screenshot after each scenario | **DONE, IMPROVED** | Full-page final screenshot + step-level screenshots after each state-changing step + error screenshots on failure. Click-to-enlarge in report. **Significant improvement** over the doc. |
| **Action blocklist** | `never_interact` config: CSS selectors and text patterns the tool will never click | **NOT BUILT** | The explorer has `DESTRUCTIVE_PATTERNS` regex (delete, logout, etc.) which it skips, but there's no user-configurable blocklist, no config key, and the scenario execution doesn't check it. |
| **Verification (heuristic)** | Error indicators = fail, success indicators = pass, neither = inconclusive | **DONE, ENHANCED** | Goes beyond the doc: checks toasts (Sonner, Radix, Toastify), URL changes, API errors, redirect patterns, form submission state, content changes. Handles navigation tests, search/filter, CRUD, smoke tests differently. |
| **Verification (LLM vision)** | Editor LLM receives screenshot + DOM state, judges pass/fail | **NOT BUILT** | The MCP server returns the report text but doesn't return individual screenshots or DOM payloads for the editor LLM to judge. This is the key architectural gap — the "browser is dumb, editor is brain" philosophy isn't implemented. |

### ELEMENT-LEVEL TESTING

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Element scanning** | Query all interactive elements: buttons, links, inputs, selects, tabs, checkboxes, role attributes, data-testid, onclick | **DONE** | Discovers buttons, links, inputs, selects, checkboxes, tabs. Uses `data-testid`, `aria-label`, `id`, `name`, `placeholder`, text content for selectors. |
| **Button testing** | Click, capture before/after DOM, note URL change / modal / text change | **DONE** | Detects: dialog opened, toast shown, navigated, content updated, no change, error. Navigates back after following links. |
| **Input testing** | Fill with appropriate test value per type | **DONE** | Smart value generation: email, password, phone, URL, date, time, number, search, name, tags. |
| **Link testing** | Check href against route map, flag broken links | **DONE** | Clicks internal links, navigates back. Skips auth-related links. Reports external links. |
| **Select testing** | Select second option | **NOT BUILT** | Selects/comboboxes are discovered but not interacted with in the explorer. |
| **Before/after screenshots per element** | Take screenshots before and after each interaction | **NOT BUILT** | Only a final page screenshot per exploration. No per-element before/after. |
| **Editor LLM judgment per element** | Editor receives before/after screenshots, judges behavior | **NOT BUILT** | Same gap as scenario verification — no per-element payload for LLM judgment. |

### API TESTING

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Direct HTTP API testing** | Send real HTTP requests to API routes: happy path, unauthorized, missing fields, invalid types | **NOT BUILT** | We have **API monitoring** (intercept requests during browser exploration), but no direct HTTP testing of API endpoints. |
| **Schema-inferred payloads** | Use Zod/Yup schemas for valid/invalid payloads | **NOT BUILT** | No schema parsing for API payloads. |
| **API results in report** | Table: endpoint, test type, expected status, actual status, response time | **PARTIAL** | We show API calls observed during exploration with method, path, call count, error count, avg response time. But these are intercepted browser calls, not structured API tests. |

### COVERAGE AUDIT & DEPENDENCY GRAPH

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Code unit map** | Classify every functionality: page_flow, api_endpoint, component_behaviour, auth_flow, data_mutation | **NOT BUILT** | We have `PageFeature` types (crud_create, crud_read, etc.) but no formal code unit classification. |
| **Coverage quality rating** | none / smoke_only / partial / full per code unit | **NOT BUILT** | We have binary tested/not-tested per route. No quality gradation. |
| **Dependency graph** | Directed graph: login → edit profile, create post → delete post | **NOT BUILT** | No dependency inference. No topological sort. No blocker detection. |
| **Blocker gap list** | Gaps that block other tests, resolved in dependency order | **NOT BUILT** | Gap analysis is flat — no chain awareness. |

### TEST FILE GENERATION

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Generate Playwright .spec.ts files** | Write to `tests/generated/`, include beforeEach auth, seed data, cleanup | **NOT BUILT** | We generate `CoverageGapSuggestion` with suggested test steps (plain text), but never write actual test files. |
| **User confirmation before writing** | Present plan, user reviews, then write | **NOT BUILT** | No interactive confirmation flow. |
| **Still-missing report** | After generated tests run, report what couldn't be resolved | **NOT BUILT** | Coverage gaps section serves a similar purpose but isn't tied to generated test execution. |

### MEMORY LAYER

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Known bugs** | Track open/closed bugs with auto-healing | **DONE** | Bugs auto-close when scenario passes on subsequent run. |
| **Flaky flows** | Track fail rate, warn above 30% | **DONE** | Fail rate tracked per flow. |
| **Verified flows** | De-prioritize after 3 consecutive passes | **DONE** | Consecutive pass tracking, used in gap scoring. |
| **20-run max** | Prune old data | **DONE** | Configurable max, defaults to 20. |
| **Credential persistence** | N/A (not in original doc) | **DONE — IMPROVEMENT** | Saves email/password from successful login, reuses on future runs to skip registration. Not in original doc — we invented this. |
| **ProjectIntel** | N/A (not in original doc) | **DONE — IMPROVEMENT** | Route-level intelligence, working/failed selectors, auth state, run history with trend tracking. Not in original doc — significant enhancement. |

### MCP SERVER

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Granular tools** | `scan_codebase`, `scan_page_elements`, `execute_scenario`, `run_api_tests`, `generate_html_report`, `login` | **NOT BUILT** | We have one monolithic tool: `run_vibe_tests`. It runs the entire pipeline. The editor can't call individual stages, can't test one route, can't explore one page. This is the **single biggest gap** from the original vision. |
| **Editor LLM as brain** | Tool returns raw data (screenshots, DOM state), editor LLM reasons about it | **NOT BUILT** | Tool returns a finished report. Editor LLM has no opportunity to reason about individual screenshots or DOM payloads. |
| **Autonomous trigger** | Editor calls tests automatically after code changes | **POSSIBLE** | The MCP server exists and can be triggered, but it only does full sweeps. No targeted "test the route I just changed" capability. |

### CLI

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **`run` command** | Run full test pipeline | **DONE** | Works. |
| **`init` command** | Create starter config + VIBE.md | **PARTIAL** | Creates `vibe.config.json` but not `VIBE.md`. |
| **`report` command** | Open last report | **DONE** | Opens HTML report in browser. |
| **`--output json`** | Structured JSON events to stdout | **NOT BUILT** | No JSON output mode. |

### HTML REPORT

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **Self-contained HTML** | Embedded screenshots, no external dependencies | **DONE** | Base64 screenshots embedded. Dark theme. Fully self-contained. |
| **Summary bar** | Total, passed, failed, errors, pass rate | **DONE** | Also shows elements explored and API calls. |
| **Scenario cards** | Collapsible, steps, selectors, verdict, screenshot | **DONE, IMPROVED** | Step-level screenshots with click-to-enlarge. Redirect notes. Step table with timing. |
| **Element coverage section** | Per-page element inventory with test results | **DONE** | Shows element type, name, action, result, details. |
| **Coverage gaps section** | Untested routes with priority | **DONE, IMPROVED** | Shows severity (critical/important/nice_to_have), suggested test steps, route. Separated by severity. |
| **API results table** | Endpoint, test type, expected/actual status | **PARTIAL** | Shows observed API calls, not structured tests. |

### PERMISSION MODES

| Feature | Doc Spec | Our Status | Notes |
|---------|----------|------------|-------|
| **safe mode** | Never interact with destructive elements | **PARTIAL** | Explorer skips destructive patterns, but no formal permission mode. |
| **full mode** | Test everything including mutations | **DEFAULT** | Current behavior — tests everything. |
| **ci mode** | Headless, no prompts, exit code 1, JSON only | **NOT BUILT** | Can run headless via `--no-headed`, exits 1 on failure, but no JSON output and no formal CI mode. |

---

## What We Built That the Doc Didn't Specify (Improvements)

| Feature | Value |
|---------|-------|
| **Credential persistence** | Saves login from first run, skips registration on subsequent runs. Huge time saver. |
| **ProjectIntel / working selector memory** | Remembers which selectors work per route. Gets smarter each run. Goes beyond the doc's simple memory. |
| **Step-level screenshots** | Screenshot at every state-changing step, not just end of scenario. Much better debugging. |
| **Two-browser architecture** | Fresh browser for auth phase, prevents resource exhaustion from exploration. More stable than the doc's single-context approach. |
| **Intelligent selector cascade** | label → placeholder → id → name → type → text → role → CSS. 8-strategy cascade with visibility checks. More resilient than anything in the doc. |
| **Dialog exploration** | Auto-discovers dialog content (title, inputs, buttons), attempts close. Not specified in doc. |
| **Toast detection** | Comprehensive toast framework detection (Sonner, Radix, Toastify, generic). Better verification than the doc's simple error/success check. |
| **Run trend tracking** | Compares pass rates across runs, reports improvements and regressions. |
| **Coverage gap suggestions with concrete steps** | Not just "this route is untested" but "here are the 5 steps to test it." |

---

## Architecture Comparison

### Doc's Architecture:
```
CLI / MCP Server (many granular tools)
    ↓
Context Engine (6 stages → Product Model)
    ↓
Browser Executor (scenarios + element scanning)
    ↓                    ↓
Editor LLM judges    Heuristic fallback
    ↓
Reporter (HTML + JSON)
    ↓
Memory (persists)
```

### Our Architecture:
```
CLI / MCP Server (1 monolithic tool)
    ↓
Context Engine (6 stages → Product Model)    ✅ Same
    ↓
Browser Runner (scenarios) + Explorer (elements)    ✅ Same, explorer is bonus
    ↓
Heuristic Verifier (no LLM)    ⚠️ Missing LLM path
    ↓
Reporter (HTML only, no JSON)    ⚠️ Missing JSON
    ↓
Memory (enhanced beyond doc)    ✅ Better than spec
```

**The core pipeline is the same.** The deviation is at the edges: the MCP interface is too coarse, verification doesn't delegate to the editor LLM, and several features (blocklist, VIBE.md, API testing, test generation, dependency graph) aren't built yet.

---

## Priority-Ordered Gap List

### P0 — Critical (breaks the core "editor as brain" philosophy)

1. **Granular MCP tools** — The editor can't call individual stages. This is the #1 gap.
2. **Verification payload to editor** — Screenshots and DOM state should be returned to the editor LLM for judgment, not just a finished report.

### P1 — High (significant missing functionality)

3. **VIBE.md support** — Project-specific guidance file.
4. **Action blocklist** — `never_interact` safety layer.
5. **URL-only mode** — Test any URL without codebase, discover routes by crawling.
6. **Direct API testing** — HTTP tests against API endpoints, not just monitoring.

### P2 — Medium (valuable but not blocking)

7. **Test file generation** — Write actual `.spec.ts` files for coverage gaps.
8. **Dependency graph** — Understand which gaps block other tests.
9. **Coverage quality rating** — none/smoke/partial/full instead of binary.
10. **Zod/Yup schema parsing** — Better validation and API payload inference.
11. **JSON output mode** — Structured events for CI integration.
12. **Permission modes** — safe/full/ci formalized.

### P3 — Nice to have

13. **Select element testing** — Interact with dropdowns in explorer.
14. **Per-element before/after screenshots** — More granular exploration evidence.
15. **CI mode** — Formal headless + JSON + exit code mode.

---

## Why Two `src/` Directories Exist

The root `/vibe-testing/src/` was the **first version** of the codebase. When we started making major changes (removing Anthropic SDK, adding HTML reports, building the explorer), the changes were made inside `/vibe-testing/vibe-test/src/` instead of in-place. This created a fork:

- **Root `src/`**: Still has `@anthropic-ai/sdk` in its `package.json`, only generates markdown reports, has no explorer, no credential persistence, no step screenshots, no coverage gaps. It's the v1 that was never cleaned up.
- **`vibe-test/src/`**: The active codebase with all improvements. This is what runs when you do `node vibe-test/dist/cli.js`.

**Resolution**: Delete root `src/`, root `package.json`, root `tsconfig.json`. Move `vibe-test/` contents to root. One codebase, one source of truth.

---

## Conclusion

The product is solid. The context engine, browser execution, memory, explorer, and reporting are all working and in several cases exceed the original specification. The gaps are primarily in the **integration layer** (MCP tools, LLM delegation) and **safety/guidance features** (VIBE.md, blocklist). The architecture doesn't need to change — it needs to be opened up so the editor LLM can call its pieces individually rather than only triggering the whole pipeline.
