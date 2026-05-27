# Vibe Test — Code-Aware Browser Testing Agent

This is the **vibe-test** source repository. It's an MCP server + CLI for AI-powered browser testing.

## What This Project Does

vibe-test gives AI coding assistants (Claude Code, Cursor, Windsurf, etc.) 13 browser testing tools via MCP. When a user asks "test the login flow", the AI uses these tools to:
1. Read the source code (understand real field names, routes, selectors)
2. Open a real Playwright browser
3. Execute test steps, take screenshots
4. Report what works and what breaks — including regressions vs the previous run

## Architecture

```
src/
├── cli.ts              # CLI entry: vibe-test run/converge/init/reset/report + --mcp flag
├── mcp-server.ts       # MCP server (13 tools via JSON-RPC stdio)
└── engine/
    ├── index.ts        # VibeTester orchestrator (run + converge, emits snapshot_diff)
    ├── converge.ts     # Iterative coverage loop (baseline + follow-up rounds)
    ├── context/        # Static code analysis (no browser)
    │   ├── index.ts    # Builds ProductModel; writes route manifest + diffs scans
    │   ├── detector.ts # Framework detection + monorepo detection + port auto-detect
    │   ├── router.ts   # Route parsing per framework
    │   ├── extractor.ts # Extract forms, buttons, dialogs, features
    │   ├── test-reader.ts # Parse existing Jest/Cypress/Playwright tests
    │   ├── gap-analyzer.ts # Score untested routes by priority
    │   └── enricher.ts # Generate TestScenarios from gaps
    ├── browser/        # Playwright execution
    │   ├── runner.ts   # Execute scenarios step-by-step
    │   ├── explorer.ts # Click everything, monitor APIs
    │   └── verifier.ts # Heuristic pass/fail (no LLM)
    ├── memory/         # Persist learning across runs
    │   ├── index.ts    # MemoryManager — selectors, timings, credentials, flaky routes
    │   └── manifest.ts # Route manifest + run snapshot diffing (regression detection)
    ├── reporter/       # Generate HTML reports
    └── coverage-gaps.ts # Post-execution gap analysis
```

## MCP Tools (13)

| Tool | Purpose |
|------|---------|
| `scan_codebase` | Analyze project → routes, forms, coverage gaps, route_changes since last scan |
| `get_context` | Return relevant source files for a feature (real selectors) |
| `login` | Auth in real browser, capture tokens |
| `scan_page_elements` | Discover interactive elements on a page |
| `explore_page` | Click everything, monitor APIs, report breakage |
| `execute_scenario` | Run multi-step test flows |
| `get_coverage` | View coverage map and gaps |
| `suggest_tests` | Get prioritized, executable scenarios |
| `take_screenshot` | Visual verification |
| `generate_report` | HTML report with screenshots |
| `run_full_test` | One-shot: scan → execute → explore → report (+ snapshot_diff) |
| `run_converge` | Iterative testing until thresholds (+ snapshot_diff) |
| `cleanup` | Close browsers |

## Development

```bash
npm run build      # tsc compile → dist/
npm run dev        # Run CLI via tsx (no compile)
npm run mcp        # Run MCP server via tsx
npm test           # vitest — 56 tests (config, framework, manifest, ...)
```

Node 20+ required (vitest 4.x).

## Key Design Decisions

- **No LLM for verification** — heuristic pass/fail (URL changes, toasts, API errors). The editor's LLM is the brain.
- **`get_context` is the key tool** — returns actual source code so the LLM knows real selectors instead of guessing
- **Session state** — MCP server maintains a session between tool calls (browser, auth context, results)
- **Self-improving** — `.vibe/memory.json` persists working selectors, flaky flows, credentials across runs
- **Regression detection** — `.vibe/route-manifest.json` and `.vibe/run-snapshot.json` are diffed every scan/run; `route_changes` and `snapshot_diff` are surfaced on the returned results so the editor can flag newly-failing routes without scrolling the report
- **Headless by default in MCP mode** — when launched via `--mcp`, the browser runs headless so editor sessions aren't disrupted; CLI stays headed
- **`init` command** — one command configures ALL detected editors (Cursor, Claude Code, Windsurf, VS Code, Roo)

## Publishing

```bash
npm run build
npm version patch    # or minor/major
npm publish          # publishes to npm as 'vibe-testing'
```

Tagged releases trigger a GitHub Actions workflow that also publishes to the official MCP Registry (OIDC trusted publishing).

A `Dockerfile` (Node 20 + Chromium) is included for Glama.ai quality scoring and container-based MCP deployments.

Users run: `npx vibe-testing@latest init` in their project.
