# vibe-test

[![npm version](https://img.shields.io/npm/v/vibe-test.svg)](https://www.npmjs.com/package/vibe-test)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/AishwaryShrivastav/vibe-testing/actions/workflows/ci.yml/badge.svg)](https://github.com/AishwaryShrivastav/vibe-testing/actions)

**Code-aware browser testing agent for AI-powered editors.**

Reads your codebase, understands every route and form, opens a real Playwright browser, explores every element, and reports what works and what breaks — with screenshots.

Works as an **MCP server** that gives your AI editor (Claude Code, Cursor, Windsurf, VS Code Copilot) 13 browser testing tools — or as a **standalone CLI**.

---

## Install in Any Project (One Command)

```bash
cd /path/to/your/project
npx vibe-test@latest init
```

This command:
- Detects which AI editors you have installed
- Registers vibe-test in **global** editor configs (`~/.claude/settings.json`, `~/.cursor/mcp.json`, etc.) so the tools are available in **every project, every session**
- Creates project-level MCP configs and AI instruction files
- Auto-detects your app's URL (reads `.env`, `vite.config`, framework defaults)
- Creates `VIBE.md` (edit with your test credentials) and `vibe.config.json`

Then open your editor and say:

> "Scan this codebase and test it against http://localhost:3000"

Your AI will pick up the tools automatically and start testing.

---

## Contents

- [How It Works](#how-it-works)
- [MCP Setup (per editor)](#mcp-setup)
- [MCP Tools Reference](#mcp-tools-reference)
- [Recommended Workflow](#recommended-workflow)
- [init Command](#init-command)
- [CLI Commands](#cli-commands)
- [VIBE.md — Project Guidance](#vibemd--project-guidance)
- [Configuration (vibe.config.json)](#configuration)
- [Supported Frameworks](#supported-frameworks)
- [FAQ](#faq)

---

## How It Works

```
npx vibe-test init
       ↓
Registers 13 MCP tools in your editor
       ↓
You ask: "Test the checkout flow"
       ↓
AI calls: scan_codebase → get_context("checkout") → login → explore_page → execute_scenario → generate_report
       ↓
HTML report opens in browser with screenshots of every step
```

**No test cases to write.** The AI reads your source code to understand real field names and routes, opens a browser, tests everything, and shows you what's broken.

---

## MCP Setup

### Option 1 — Automatic (recommended)

```bash
npx vibe-test@latest init
```

Detects and configures all installed editors. Done.

---

### Option 2 — Manual per editor

#### Claude Code

Add to `~/.claude/settings.json` (global — works in every project):

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

Or add to `.mcp.json` in your project root (project-level only):

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

#### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

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

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json`:

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

#### VS Code (GitHub Copilot)

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-test@latest", "--mcp"]
    }
  }
}
```

#### Roo Code / Cline

Add to `.roo/mcp.json`:

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

#### From local build (development)

```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "node",
      "args": ["/path/to/vibe-testing/dist/mcp-server.js"]
    }
  }
}
```

---

## MCP Tools Reference

13 tools available to your AI editor after setup:

| Tool | When to call | Returns |
|------|-------------|---------|
| `scan_codebase` | **Always first.** Reads source code, finds routes/forms/tests/gaps | Routes, forms, coverage map, generated scenarios |
| `get_context` | **Before writing test steps.** Returns source files for a feature | Actual source code with real field names and selectors |
| `login` | When app requires authentication | Post-login screenshot, token state, API calls observed |
| `scan_page_elements` | To see all interactive elements on a page | Element list with selectors + page screenshot |
| `explore_page` | Broad "does everything work?" testing | Interaction results, API calls, errors, screenshot |
| `execute_scenario` | Run specific test steps | Step-by-step logs + screenshots |
| `get_coverage` | View coverage map and untested routes | Coverage entries, gaps, available scenarios |
| `suggest_tests` | Find coverage gaps after exploration | Prioritized, ready-to-run scenarios with steps |
| `take_screenshot` | Quick visual verification | Screenshot of any URL |
| `generate_report` | Build HTML report (auto-opens) | Report path + summary |
| `run_full_test` | One-shot: scan → execute → explore → report | Full results |
| `run_converge` | Iterative testing until thresholds | Summary across all rounds |
| `cleanup` | Close browsers, free resources | — |

### Tool Inputs

**`scan_codebase`**
```json
{
  "codebase_path": "/path/to/project",
  "url": "http://localhost:3000",
  "mode": "deep"
}
```

**`get_context`**
```json
{ "feature": "login" }
{ "feature": "/checkout" }
{ "feature": "user profile form" }
```

**`login`**
```json
{
  "email": "test@example.com",
  "password": "TestPass123!",
  "login_url": "/login"
}
```

**`scan_page_elements`** / **`explore_page`**
```json
{
  "route": "/dashboard",
  "authenticated": true
}
```

**`execute_scenario`**
```json
{
  "scenario": {
    "id": "create-item",
    "name": "Create a new item",
    "route": "/items",
    "steps": [
      { "action": "navigate", "url": "/items", "description": "Open items page" },
      { "action": "click", "selector": "text=Add Item", "description": "Open create form" },
      { "action": "fill", "selector": "[name='title']", "value": "Test Item", "description": "Fill title" },
      { "action": "fill", "selector": "[name='description']", "value": "Test description", "description": "Fill description" },
      { "action": "click", "selector": "button[type='submit']", "description": "Submit form" }
    ],
    "expected_outcome": "New item appears in the list",
    "requires_auth": true
  }
}
```

Step actions: `navigate`, `fill`, `click`, `select`, `wait`, `assert`, `upload`

**`take_screenshot`**
```json
{ "url": "/settings", "authenticated": true, "full_page": false }
```

**`run_full_test`**
```json
{ "url": "http://localhost:3000", "codebase_path": "/path/to/project", "mode": "deep" }
```

**`run_converge`**
```json
{
  "url": "http://localhost:3000",
  "max_followup_rounds": 4,
  "target_pass_rate": 0.92,
  "max_high_severity_gaps": 2
}
```

---

## Recommended Workflow

### Full test session

Tell your AI editor:

```
Scan this codebase and test it against http://localhost:3000.
Log in with test@example.com / pass123. Explore the dashboard and
settings pages, run the suggested tests, and generate a report.
```

The AI will:
1. `scan_codebase` — understand routes, forms, existing tests
2. `get_context("login")` — read actual login form source code
3. `login` — authenticate in a real browser
4. `explore_page("/dashboard")` — click everything, observe what breaks
5. `explore_page("/settings")` — same
6. `suggest_tests` — find coverage gaps
7. `execute_scenario` × N — run targeted test flows
8. `generate_report` — HTML report opens automatically
9. `cleanup` — close browsers

### Test a specific feature

```
Test the checkout flow using vibe-test. Get context for checkout,
then run the full purchase flow with card number 4242424242424242.
```

The AI will:
1. `scan_codebase` (if not already done)
2. `get_context("checkout")` — read `CheckoutForm.tsx`, `api/orders/route.ts` etc.
3. `login` — authenticate
4. `execute_scenario` — fill the real form fields from source code
5. `generate_report`

### Verify a bug fix

```
I fixed the login redirect bug. Use vibe-test to confirm it's working.
```

The AI will:
1. `login` — test the login flow
2. `take_screenshot` — visual confirmation of the post-login state
3. Report back what it sees

### Find what's broken

```
Explore every page and tell me what's broken.
```

The AI will run `explore_page` on every route, collecting API errors, broken elements, and failed interactions, then `suggest_tests` with the broken items marked as high priority.

---

## init Command

```bash
npx vibe-test@latest init [options]
```

**What it creates:**

| File | Where | Purpose |
|------|-------|---------|
| `.mcp.json` | Project root | Claude Code MCP config (project-level) |
| `~/.claude/settings.json` | Global | Claude Code MCP config (all projects) |
| `.cursor/mcp.json` | Project root | Cursor MCP config |
| `~/.cursor/mcp.json` | Global | Cursor MCP config (all projects) |
| `.cursor/rules/vibe-test.mdc` | Project | Cursor rules — `alwaysApply: true` |
| `.windsurfrules` | Project | Windsurf instructions |
| `~/.codeium/windsurf/mcp_config.json` | Global | Windsurf MCP config (all projects) |
| `.vscode/mcp.json` | Project | VS Code Copilot MCP config |
| `.github/copilot-instructions.md` | Project | GitHub Copilot instructions |
| `.roo/mcp.json` | Project | Roo Code MCP config |
| `CLAUDE.md` | Project | Claude Code session instructions |
| `AGENTS.md` | Project | Universal agent instructions (Codex, Devin, Zed) |
| `VIBE.md` | Project | Test guidance — edit with your credentials |
| `vibe.config.json` | Project | Config — URL auto-detected from your project |

**Options:**

```bash
npx vibe-test init                     # auto-detect editors, register globally + project
npx vibe-test init --no-global         # project-level only, skip global registration
npx vibe-test init --editor cursor     # only configure Cursor
npx vibe-test init --editor claude-code windsurf
```

**After init**, edit `VIBE.md` with your login URL and test credentials.

---

## CLI Commands

```bash
# Set up in current project
npx vibe-test init

# Run tests against a URL
npx vibe-test run http://localhost:3000
npx vibe-test run https://staging.myapp.com --mode deep
npx vibe-test run http://localhost:3000 --codebase /path/to/project --scope /login /dashboard

# Iterative testing until coverage thresholds
npx vibe-test converge http://localhost:3000
npx vibe-test converge http://localhost:3000 --max-rounds 6 --target-pass-rate 0.95

# Open last report in browser
npx vibe-test report

# Reset memory and screenshots for a clean run
npx vibe-test reset
```

### `run` options

| Option | Default | Description |
|--------|---------|-------------|
| `--mode fast\|deep` | `deep` | `fast`: quick scan. `deep`: full feature extraction + exploration |
| `--no-headed` | — | Run browser headless (default: visible) |
| `--codebase <path>` | cwd | Path to project root |
| `--scope <routes...>` | all | Test only specific routes |
| `-c <path>` | `vibe.config.json` | Config file path |

### `converge` options

| Option | Default | Description |
|--------|---------|-------------|
| `--max-rounds <n>` | `4` | Max follow-up rounds after baseline |
| `--target-pass-rate <r>` | `0.92` | Stop when pass rate ≥ this (0–1) |
| `--max-gaps <n>` | `2` | Stop when critical+important gaps ≤ this |

---

## VIBE.md — Project Guidance

Create `VIBE.md` in your project root. Vibe Test reads it automatically on every run.

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
- .billing-section

## Known Flaky
- /notifications (WebSocket dependent — skip or expect retry)
- /live-feed

## Notes
- Admin panel at /admin — use admin@example.com / adminpass
- Dashboard data loads async — wait for [data-loaded="true"]
- Profile page: click "Edit Profile" before form fields appear
```

See [`VIBE.example.md`](./VIBE.example.md) for the full template.

---

## Configuration

### vibe.config.json

Created automatically by `init` with auto-detected URL. Edit as needed:

```json
{
  "url": "http://localhost:3000",
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
    "[data-testid='danger-zone']"
  ],
  "scope": {
    "include": ["/**"],
    "exclude": ["/admin/**", "/api/**"],
    "max_routes": 30
  },
  "browser": {
    "headed": true,
    "slowMo": 40,
    "timeout": 30000
  }
}
```

| Key | Description |
|-----|-------------|
| `url` | App URL — localhost or staging. Auto-detected by `init`. |
| `mode` | `fast` (heuristic scan) or `deep` (full extraction + exploration) |
| `auth.credentials` | Login credentials — persisted across runs once used |
| `never_interact` | Text patterns or CSS selectors to skip during exploration |
| `scope.exclude` | Route patterns to exclude from testing |
| `scope.max_routes` | Cap how many routes are tested per run |
| `browser.headed` | `true` = visible browser (default). `false` = headless |
| `browser.slowMo` | Milliseconds between actions (useful for debugging) |

---

## Supported Frameworks

| Framework | Routes | API endpoints | Forms |
|-----------|--------|---------------|-------|
| Next.js App Router | ✅ | ✅ | ✅ |
| Next.js Pages Router | ✅ | ✅ | ✅ |
| Next.js (src/ variant) | ✅ | ✅ | ✅ |
| React SPA (react-router) | ✅ | — | ✅ |
| Vue + Vite | ✅ | — | ✅ |
| Nuxt | ✅ | — | ✅ |
| SvelteKit | ✅ | — | ✅ |
| Express / Fastify | — | ✅ | ✅ |
| Monorepos (Turborepo, pnpm, Lerna) | ✅ | ✅ | ✅ |

Existing test files are also read to build a coverage map:

| Test runner | Supported |
|-------------|-----------|
| Jest / Vitest | ✅ |
| Playwright | ✅ |
| Cypress | ✅ |

---

## Self-Improvement

Vibe Test learns across runs and stores intelligence in `.vibe/`:

- **Working selectors** — remembers `[name='email']` worked on `/login`, uses it next run
- **Route timings** — adjusts timeouts based on measured load times
- **Auth credentials** — saved after first login, reused automatically
- **Flaky routes** — tracks high fail-rate routes, marks them for retry
- **Skip routes** — routes that consistently error (need URL params) are auto-skipped

Reset with `npx vibe-test reset` to start fresh.

---

## How the AI Uses These Tools

When you ask your editor to "test the login flow", here is exactly what it does:

```
User: "Test the login flow"

AI calls:
  scan_codebase({ codebase_path: ".", url: "http://localhost:3000" })
    → Finds /login route, LoginForm component, POST /api/auth/login endpoint
    → Returns 8 generated test scenarios

  get_context({ feature: "login" })
    → Returns src/app/login/page.tsx (has email, password fields, name="email", name="password")
    → Returns src/app/api/auth/login/route.ts (POST handler, returns { token })
    → AI now knows the REAL selectors: [name='email'], [name='password']

  login({ email: "test@example.com", password: "pass123" })
    → Opens Chromium, navigates to /login
    → Fills email and password fields
    → Clicks submit
    → Returns: { success: true, final_url: "/dashboard", tokens_found: 2 }
    → Returns screenshot of post-login dashboard

  execute_scenario({
    scenario: {
      name: "Login with invalid password",
      steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", selector: "[name='email']", value: "test@example.com" },
        { action: "fill", selector: "[name='password']", value: "wrongpassword" },
        { action: "click", selector: "button[type='submit']" }
      ],
      expected_outcome: "Error message shown"
    }
  })
    → Returns screenshot showing error state

  generate_report()
    → Writes .vibe/report.html
    → Opens in browser automatically

AI reports: "Login works. Invalid password shows an error. All 3 login scenarios passed."
```

---

## FAQ

**Does vibe-test use an AI/LLM internally?**
No. It uses heuristic verification (URL changes, toast detection, API errors). Your editor's AI (Claude, GPT-4, etc.) is the brain — it sees screenshots and decides what to test next.

**What's the difference between `explore_page` and `execute_scenario`?**
`explore_page` is broad — it clicks every button and input it finds and reports the results. `execute_scenario` is precise — you give it specific steps and it follows them exactly. Use `explore_page` to find what's on a page, then `execute_scenario` to test specific flows.

**What's `get_context` for?**
It returns the actual source code for a feature — so the AI knows `[name='email']` instead of guessing `#email-input`. Always call it before writing test steps for a specific feature.

**Does it handle SPAs with client-side routing?**
Yes. Playwright navigates the real browser, so client-side routing (React Router, Vue Router, etc.) works naturally.

**Does it handle login / authentication?**
Yes. The `login` tool fills credentials in a real browser, captures auth tokens from localStorage/cookies, and keeps that session alive for authenticated tests. Credentials are persisted in `.vibe/memory/` and reused automatically.

**Will it click "Delete Account" or other destructive buttons?**
No. Set `never_interact` in `vibe.config.json` or `VIBE.md` to blocklist dangerous actions. Any button whose text or selector matches is skipped during exploration.

**Can I use it without an AI editor?**
Yes — `vibe-test run https://your-app.com` runs standalone. It scans, generates scenarios, executes them, and produces an HTML report without needing an editor.

**How do I test a staging environment?**
Set `url` in `vibe.config.json` to your staging URL, or pass it as a CLI argument: `npx vibe-test run https://staging.myapp.com`.

**Does it work with monorepos?**
Yes. `init` detects Turborepo/pnpm/yarn workspaces and finds the frontend app automatically.

---

## Requirements

- **Node.js** ≥ 18
- **Playwright Chromium** — install once with:
  ```bash
  npx playwright install chromium
  ```
  (vibe-test will prompt you if it's missing)

---

## Contributing

```bash
git clone https://github.com/AishwaryShrivastav/vibe-testing.git
cd vibe-testing
npm install
npx playwright install chromium
npm run build   # tsc → dist/
npm run dev     # run CLI without building
npm run mcp     # run MCP server without building
```

See [CHANGELOG.md](./CHANGELOG.md) for version history.

---

## License

MIT — [Aishwary Shrivastav](https://github.com/AishwaryShrivastav)

---

## Links

- **npm:** https://www.npmjs.com/package/vibe-test
- **GitHub:** https://github.com/AishwaryShrivastav/vibe-testing
- **Issues:** https://github.com/AishwaryShrivastav/vibe-testing/issues
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Playwright](https://playwright.dev)
