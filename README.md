# Vibe Test

**Code-aware browser testing agent.** Reads your codebase, understands every route and form, explores every element in a real browser, and reports what works and what breaks — with screenshots.

Works as an **MCP server** for [Cursor](https://cursor.sh) / [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (the editor LLM becomes the brain), or as a **standalone CLI**.

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

## Quick Start

### Cursor (Recommended)

**1.** Add to your MCP settings — open Cursor Settings → MCP → Add Server, or edit `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-test@latest", "--mcp"]
    }
  }
}
```

**2.** Copy `.cursor/rules/vibe-testing.mdc` from this repo into your project's `.cursor/rules/` so Cursor knows how to use the tools.

**3.** Ask Cursor:

> "Scan the codebase and test it against https://staging.myapp.com — log in with test@example.com / pass123, explore the dashboard, and tell me what's broken"

That's it. Cursor now has 11 testing tools and will use them autonomously.

### Claude Code

Add to your MCP config (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-test@latest", "--mcp"]
    }
  }
}
```

### Standalone CLI

```bash
npm install -g vibe-test
npx playwright install chromium

cd /path/to/your/project
vibe-test init                                    # create vibe.config.json
vibe-test run https://staging.myapp.com           # run against a URL
vibe-test run http://localhost:3000 --mode deep   # run against localhost
vibe-test report                                  # open last report
```

### From Source

```bash
git clone https://github.com/AishwaryShrivastav/vibe-testing.git
cd vibe-testing
npm install
npx playwright install chromium
npm run build

# CLI
node dist/cli.js run https://staging.myapp.com --codebase /path/to/project

# MCP server (for editor integration)
node dist/mcp-server.js
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

## Requirements

- **Node.js** >= 18
- **Playwright** — installed automatically via `npx playwright install chromium`

## License

MIT
