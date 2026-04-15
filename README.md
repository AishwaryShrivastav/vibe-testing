# Vibe Test

[![npm version](https://img.shields.io/npm/v/vibe-test.svg)](https://www.npmjs.com/package/vibe-test)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Code-aware browser testing agent for vibe coding.** Reads your codebase, understands every route and form, explores every element in a real Playwright browser, and reports what works and what breaks — with screenshots.

Works as an **MCP server** for [Cursor](https://cursor.sh) / [Claude Code](https://docs.anthropic.com/en/docs/claude-code) / [Windsurf](https://codeium.com/windsurf) (the editor LLM becomes the brain), or as a **standalone CLI**.

**One command to add testing superpowers to your AI editor:**

```bash
# Add to your editor's MCP config — that's it
npx vibe-test@latest --mcp
```

> **Built for vibe coding** — stop writing test cases manually. Let your AI editor scan the code, explore the app, find bugs, and generate coverage reports autonomously.

---

## How It Works

```
Your Codebase ──→ Context Engine ──→ Browser Engine ──→ Report
                       │                    │
                   Reads:               Executes:
                   • Routes             • Login flows
                   • Forms              • Page exploration
                   • Components         • Click every element
                   • Test files         • Fill every form
                   • Coverage gaps      • Monitor API calls
                                        • Capture screenshots
```

1. **Scans your code** — detects framework (Next.js, React, Vue, etc.), parses all routes, extracts forms/buttons/dialogs, reads existing Playwright/Jest/Cypress tests
2. **Maps coverage** — which routes have tests, which don't, what features are untested
3. **Generates scenarios** — creates test flows for uncovered functionality (CRUD, auth, navigation, validation)
4. **Executes in a real browser** — Playwright-powered, headed by default so you can watch
5. **Explores every element** — clicks buttons, fills inputs, tests tabs, monitors API responses
6. **Self-improves** — learns working selectors, route timings, and failure patterns across runs
7. **Reports with screenshots** — interactive HTML report with step-level screenshots, API monitoring, and coverage gap analysis

---

## Quick Start (One Command)

```bash
cd /path/to/your/project
npx vibe-test@latest init
```

**That's it.** This single command auto-detects your editors and configures all of them:

| Editor | What gets created |
|--------|-------------------|
| **Cursor** | `.cursor/mcp.json` + `.cursor/rules/vibe-testing.mdc` (tool instructions) |
| **Claude Code** | `.mcp.json` + `CLAUDE.md` (agent instructions) |
| **VS Code (Copilot)** | `.vscode/mcp.json` (uses `servers` key) |
| **Windsurf** | Global config at `~/.codeium/windsurf/mcp_config.json` (with `--global`) |
| **Roo Code** | `.roo/mcp.json` |
| **Codex / Devin / Zed** | `AGENTS.md` (universal agent convention) |
| **All** | `VIBE.md` (test guidance) + `vibe.config.json` |

Now open your editor and ask:

> "Scan this codebase and test it against https://staging.myapp.com — log in with test@example.com / pass123, explore the dashboard, and tell me what's broken"

### Options

```bash
npx vibe-test init                       # auto-detect and configure project-level
npx vibe-test init --global              # also register in global/user-level configs
npx vibe-test init --editor cursor       # only configure Cursor
npx vibe-test init --editor vscode windsurf  # only VS Code + Windsurf
```

### Standalone CLI

```bash
npx vibe-test@latest init                          # set up config
npx vibe-test run https://staging.myapp.com        # run against a URL
npx vibe-test run http://localhost:3000 --mode deep # run against localhost
npx vibe-test report                               # open last report
```

### From Source

```bash
git clone https://github.com/AishwaryShrivastav/vibe-testing.git
cd vibe-testing
npm install && npx playwright install chromium && npm run build

node dist/cli.js run https://staging.myapp.com --codebase /path/to/project
```

---

## MCP Tools Reference

When used as an MCP server, the editor LLM gets these 11 tools:

| Tool | Purpose | Returns |
|------|---------|---------|
| `scan_codebase` | Analyze project structure, routes, forms, tests, coverage gaps | JSON summary + generated scenarios |
| `login` | Authenticate in a real browser — fills form, captures tokens | Screenshot + token state + API calls |
| `scan_page_elements` | Discover all interactive elements on a page | Element list + screenshot |
| `explore_page` | Click every button, fill every input, test every link | Interaction results + API calls + screenshot |
| `execute_scenario` | Run a specific multi-step test scenario | Step-by-step logs + screenshots |
| `get_coverage` | View test coverage map and gap analysis | Coverage data + suggested scenarios |
| `suggest_tests` | AI-powered gap analysis → executable test scenarios | Prioritized scenarios with steps |
| `take_screenshot` | Quick visual verification of any page | Screenshot |
| `generate_report` | Build HTML report (auto-opens in browser) | Report path + summary |
| `run_full_test` | All-in-one: scan → execute → explore → report | Full results |
| `cleanup` | Close browsers and reset session | — |

### Typical Workflow

```
scan_codebase  →  login  →  explore_page  →  suggest_tests  →  execute_scenario  →  generate_report  →  cleanup
     │               │            │                │                    │                    │
  Understand     Authenticate  Test every      Find gaps          Run targeted        HTML report
  the project    the session   element         & regressions      test flows          with screenshots
```

Each tool returns **structured JSON + screenshots as images**. The editor LLM sees the screenshots and reasons about them visually.

---

## VIBE.md — Project Guidance

Create a `VIBE.md` file in your project root to give Vibe Test project-specific context:

```markdown
## Login URL
/login

## Test Credentials
- Email: test@example.com
- Password: TestPass123!

## Never Automate
- delete account
- cancel subscription
- [data-testid="danger-zone"]

## Known Flaky
- /notifications (WebSocket dependent)

## Notes
- Profile page requires clicking "Edit Profile" before fields are visible
- Dashboard data loads via WebSocket — wait for [data-loaded="true"]
```

See [`VIBE.example.md`](./VIBE.example.md) for a full template.

---

## Configuration

### vibe.config.json

```json
{
  "url": "https://staging.myapp.com",
  "mode": "deep",
  "auth": {
    "strategy": "credentials",
    "login_url": "/login",
    "credentials": {
      "email": "test@example.com",
      "password": "TestPass123!"
    }
  },
  "never_interact": [
    "delete account",
    "cancel subscription",
    ".danger-zone"
  ],
  "scope": {
    "include": ["/**"],
    "exclude": ["/admin/**"],
    "max_routes": 30
  },
  "browser": {
    "headed": true,
    "slowMo": 40,
    "timeout": 30000
  }
}
```

| Option | Description |
|--------|-------------|
| `url` | App URL — localhost or staging/production. If staging URL is provided, Vibe Test uses it directly. |
| `mode` | `fast` (quick scan) or `deep` (full feature extraction + exploration) |
| `auth.credentials` | Login credentials. Persisted across runs — once logged in, sessions are reused. |
| `never_interact` | Selectors or text patterns to skip during exploration (prevents destructive actions). |
| `scope.exclude` | Route patterns to exclude from testing. |

---

## Self-Improvement

Vibe Test learns from every run and gets smarter:

- **Selectors** — remembers which CSS/text selectors resolved correctly per route
- **Route timings** — adjusts timeouts based on measured load times
- **Auth state** — persists login credentials and token patterns
- **Failure patterns** — tracks flaky routes and suggests retests
- **Skip routes** — automatically skips routes that consistently error (e.g., need URL params)

Intelligence is stored in `.vibe/intel.json` and loaded on subsequent runs.

---

## Architecture

```
src/
├── cli.ts                  # CLI entry point (Commander.js)
├── mcp-server.ts           # MCP server (11 tools, JSON-RPC over stdio)
├── engine/
│   ├── index.ts            # VibeTester orchestrator
│   ├── context/            # Static code analysis
│   │   ├── index.ts        # Framework detection, route parsing
│   │   ├── extractor.ts    # Form/button/dialog extraction from source
│   │   └── enricher.ts     # Scenario generation from code analysis
│   ├── browser/            # Playwright-powered browser engine
│   │   ├── runner.ts       # Scenario execution, auth flows
│   │   ├── explorer.ts     # Runtime page exploration
│   │   └── verifier.ts     # Heuristic test verification
│   ├── reporter/
│   │   └── html.ts         # Interactive HTML report generation
│   └── memory/
│       └── index.ts        # Persistent intelligence (selectors, timings, creds)
├── types/
│   ├── index.ts            # Core type definitions
│   └── config.ts           # Configuration schema (Zod)
└── utils/
    ├── vibe-md.ts           # VIBE.md parser
    └── blocklist.ts         # Action blocklist (never_interact)
```

---

## What The Editor Sees

When Cursor calls `scan_page_elements`, it gets:

```json
{
  "route": "/dashboard",
  "total_elements": 19,
  "elements_by_type": { "button": 2, "link": 17 },
  "elements": [
    { "type": "button", "text": "Tag Client", "selector": "text=Tag Client" },
    { "type": "link", "text": "Settings", "href": "/profile" }
  ]
}
```

Plus a **screenshot** the LLM can see and reason about visually.

When it calls `suggest_tests`, it gets prioritized, executable scenarios:

```json
{
  "total_suggestions": 5,
  "by_priority": { "critical": 1, "high": 2, "medium": 1, "low": 1 },
  "suggestions": [
    {
      "priority": "critical",
      "category": "Missing CRUD: Create",
      "reason": "No test for creating Client on /clients",
      "scenario": {
        "name": "Create Client on /clients",
        "steps": [
          { "action": "navigate", "url": "/clients" },
          { "action": "click", "selector": "text=Add Client" },
          { "action": "fill", "selector": "#name", "value": "Test Client" },
          { "action": "click", "selector": "text=Submit" }
        ]
      }
    }
  ]
}
```

---

## Why Vibe Test?

| Problem | Vibe Test Solution |
|---------|--------------------|
| Writing test cases is tedious | Auto-generates scenarios from your source code |
| Tests break when UI changes | Learns working selectors and adapts across runs |
| Hard to know what's untested | Maps code features → test coverage, shows gaps |
| AI editors can't test the browser | MCP server gives your editor 11 browser testing tools |
| Manual QA is slow | Explores every element automatically, like a senior tester |
| No visibility into test results | Interactive HTML report with step-level screenshots |

## FAQ

**Q: Does Vibe Test use its own AI/LLM?**
No. Vibe Test uses heuristic verification. When used as an MCP server, your editor's LLM (Cursor, Claude Code, etc.) acts as the brain — it sees screenshots and decides what to do next.

**Q: What frameworks does it support?**
React, Next.js, Vue, Nuxt, Angular, Svelte, SvelteKit, Remix, Gatsby, and any SPA or SSR framework with file-based or code-defined routes.

**Q: Can I use it with Cursor?**
Yes — add one JSON block to `.cursor/mcp.json` and Cursor gets 11 testing tools. See [Quick Start](#cursor-recommended).

**Q: Can I use it with Claude Code?**
Yes — add the same JSON block to `~/.claude/mcp.json`. See [Quick Start](#claude-code).

**Q: Can I use it without an AI editor?**
Yes — run `vibe-test run https://your-app.com` as a standalone CLI. It scans, tests, and generates a report.

**Q: Does it handle login/authentication?**
Yes — the `login` tool fills credentials in a real browser, captures tokens, and creates an authenticated session for subsequent tests. Credentials are persisted across runs.

**Q: Will it click "Delete Account" or other destructive buttons?**
No — configure `never_interact` patterns in `vibe.config.json` or `VIBE.md` to blocklist destructive actions.

---

## Related

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io) — the protocol Vibe Test uses for editor integration
- [Playwright](https://playwright.dev) — the browser automation engine under the hood
- [Cursor](https://cursor.sh) — AI code editor with MCP support
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Anthropic's coding agent with MCP support

---

## Requirements

- **Node.js** >= 18
- **Playwright** — installed automatically via `npx playwright install chromium`

## License

MIT
