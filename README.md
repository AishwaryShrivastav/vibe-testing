# vibe-testing

[![npm version](https://img.shields.io/npm/v/vibe-testing.svg)](https://www.npmjs.com/package/vibe-testing)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue.svg)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/AishwaryShrivastav/vibe-testing/actions/workflows/ci.yml/badge.svg)](https://github.com/AishwaryShrivastav/vibe-testing/actions)

**Code-aware browser testing for AI coding agents.**

[Product site](https://vibetesting.tfgstudio.com/) · [npm](https://www.npmjs.com/package/vibe-testing) · [MCP Registry](https://registry.modelcontextprotocol.io/?q=io.github.AishwaryShrivastav%2Fvibe-testing) · [Launch status](https://github.com/AishwaryShrivastav/vibe-testing/blob/main/docs/distribution/launch-status.md)

vibe-testing reads your codebase so tests use your real routes and field names, runs them in a real Playwright browser, remembers what broke, and tells you what your last change fixed or regressed. It works as an MCP server that gives your editor (Claude Code, Cursor, Windsurf, VS Code Copilot, Roo Code) 14 testing tools, or as a standalone CLI.

The repository is also an [Agent Plugin](https://agent-plugins.org/) with a `release-qa` skill. Compatible agents get both the testing tools and a senior-QA workflow for coverage, evidence, regression checks, and a clear release verdict.

```bash
cd /path/to/your/project
npx vibe-testing@latest init
```

Then open your editor and say:

> "Scan this codebase and test it against http://localhost:3000"

---

## What code-aware testing adds

Playwright MCP gives your agent hands. vibe-testing gives it a testing workflow: code-derived scenarios, memory across runs, and a report. Two things a stateless browser tool cannot do:

**1. Run it twice and it tells you what you broke.** Every run writes `.vibe/run-snapshot.json` and diffs it against the previous run. Every scan writes `.vibe/route-manifest.json` and diffs your routes. The second run prints regressions and fixes instead of a wall of results:

```
Changes since last run
  Fixed:      /login
  Regression: /checkout
  New:        /admin/users
```

The same diff reaches your editor as `snapshot_diff` on `run_full_test` and `run_converge`, and as `route_changes` on `scan_codebase`, so the agent can flag "checkout broke after that commit" without anyone scrolling a report. Flaky routes, working selectors, and measured timeouts are also remembered between runs.

**2. Zero LLM calls inside the tool.** Pass/fail verification is heuristic: URL changes, toast detection, API errors. Your editor's model decides what to test; vibe-testing does the browsing and checking. No API key, no per-run cost beyond the editor subscription you already pay for.

---

## Contents

- [How it works](#how-it-works)
- [MCP setup (per editor)](#mcp-setup)
- [MCP tools reference](#mcp-tools-reference)
- [Recommended workflow](#recommended-workflow)
- [init command](#init-command)
- [CLI commands](#cli-commands)
- [VIBE.md, project guidance](#vibemd-project-guidance)
- [Configuration (vibe.config.json)](#configuration)
- [Supported frameworks](#supported-frameworks)
- [Memory and regression detection](#memory-and-regression-detection)
- [FAQ](#faq)

---

## How it works

```
npx vibe-testing@latest init
        |
Registers 14 MCP tools in your editor
        |
You ask: "Test the checkout flow"
        |
AI calls: scan_codebase -> get_context("checkout") -> login -> explore_page -> execute_scenario -> generate_report
        |
HTML report opens in browser with screenshots of every step
```

No test cases to write. The AI reads your source code to understand real field names and routes, opens a browser, tests everything, and shows you what's broken.

`init` also:

- Detects which AI editors you have installed
- Registers vibe-test in global editor configs (`~/.claude/settings.json`, `~/.cursor/mcp.json`, and so on) so the tools are available in every project, every session
- Creates project-level MCP configs and AI instruction files
- Auto-detects your app's URL (reads `.env`, `vite.config`, framework defaults)
- Creates `VIBE.md` (edit with your test credentials) and `vibe.config.json`
- Installs the matching Playwright Chromium build

---

## MCP setup

### Agent Plugin

Install this repository as a plugin when your agent supports the Agent Plugins standard. It includes the portable `release-qa` skill and starts the published npm MCP server with no API key.

- Cursor: submit or install `https://github.com/AishwaryShrivastav/vibe-testing` as an Agent Plugin.
- Claude Code:

  ```bash
  claude plugin marketplace add AishwaryShrivastav/vibe-testing
  claude plugin install vibe-testing@vibe-testing
  ```
- Other compatible agents: load the repository root containing `plugin.json`, `skills/`, and `mcp.json`.

The direct MCP and CLI setup below remains available for editors without plugin support.

### MCPB bundle

Claude Desktop and other MCPB hosts can install one local bundle. Build and validate it from this repository:

```bash
npm ci
npm run build:mcpb
```

The artifact is written to `artifacts/vibe-testing-<version>.mcpb`. See the [MCPB distribution guide](docs/distribution/mcpb.md) for the bundle contents, validation steps, Smithery handoff, and the one-time Playwright Chromium prerequisite.

### Option 1: automatic (recommended)

```bash
npx vibe-testing@latest init
```

Detects and configures all installed editors. Done.

### Option 2: manual per editor

#### Claude Code

Add to `~/.claude/settings.json` (global, works in every project):

```json
{
  "mcpServers": {
    "vibe-test": {
      "command": "npx",
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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
      "args": ["-y", "vibe-testing@latest", "--mcp"]
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

## MCP tools reference

14 tools available to your AI editor after setup:

| Tool | When to call | Returns |
|------|-------------|---------|
| `configure` | Start here on a new project. Detects framework, server, and authentication | Structured setup result and idempotent project files |
| `scan_codebase` | Always first. Reads source code, finds routes/forms/tests/gaps | Routes, forms, coverage map, generated scenarios, `route_changes` since last scan |
| `get_context` | Before writing test steps. Returns source files for a feature | Actual source code with real field names and selectors |
| `login` | When app requires authentication | Post-login screenshot, token state, API calls observed |
| `scan_page_elements` | To see all interactive elements on a page | Element list with selectors plus page screenshot |
| `explore_page` | Broad "does everything work?" testing | Interaction results, API calls, errors, screenshot |
| `execute_scenario` | Run specific test steps | Step-by-step logs plus screenshots |
| `get_coverage` | View coverage map and untested routes | Coverage entries, gaps, available scenarios |
| `suggest_tests` | Find coverage gaps after exploration | Prioritized, ready-to-run scenarios with steps |
| `take_screenshot` | Quick visual verification | Screenshot of any URL |
| `generate_report` | Build HTML report (auto-opens) | Report path plus summary |
| `run_full_test` | One-shot: scan, execute, explore, report | Full results plus `snapshot_diff` vs last run |
| `run_converge` | Iterative testing until thresholds | Summary across all rounds plus `snapshot_diff` vs last run |
| `cleanup` | Close browsers, free resources | - |

### Tool inputs

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

CLI and MCP use the same scenario runner. An `assert` step evaluates every
supplied condition:

- `selector`: the target must be visible. CSS, `text=`, `label=`, and
  `placeholder=` are supported; the named locators match exactly.
- `value`: visible text must contain this string, on the selected element or on
  the page body when no selector is supplied.
- `url`: the current URL must exactly match this absolute URL or path resolved
  against the configured base URL, including query and fragment.

For example:

```json
{ "action": "assert", "selector": "#confirmation", "value": "Saved", "url": "/settings", "timeout": 5000, "description": "Check saved settings" }
```

These checks wait up to the step timeout (default 15000 ms per check). A failed
assertion stops the scenario, records a failed step and reason, and returns
`status: "fail"`; MCP also sets `isError: true`. Explicit conditions are used as
the verdict after the existing authentication and form API checks. The
`description` and `expected_outcome` prose are not executable assertions.
Without `selector`, `value`, or `url`, `assert` only checks page health: at least
10 characters of visible body text and no nonempty visible error indicators.
This compatibility check does not prove a described business outcome.

`upload` requires a file-input `selector` and a nonempty file path in `value`.
Relative paths resolve against the codebase root. Hidden file inputs are
supported. A missing file, directory, missing target, or target that is not a
file input returns `status: "error"`. The action selects one file using
Playwright; add an assertion of the resulting UI to verify application-side
processing. It does not automate native file-picker dialogs.

Scenarios must contain at least one step. Unknown actions are errors.


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

## Recommended workflow

### Full test session

Tell your AI editor:

```
Scan this codebase and test it against http://localhost:3000.
Log in with test@example.com / pass123. Explore the dashboard and
settings pages, run the suggested tests, and generate a report.
```

The AI will:
1. `scan_codebase`, to understand routes, forms, existing tests
2. `get_context("login")`, to read the actual login form source code
3. `login`, to authenticate in a real browser
4. `explore_page("/dashboard")`, clicking everything and observing what breaks
5. `explore_page("/settings")`, same
6. `suggest_tests`, to find coverage gaps
7. `execute_scenario` x N, running targeted test flows
8. `generate_report`, HTML report opens automatically
9. `cleanup`, closing browsers

### Test a specific feature

```
Test the checkout flow using vibe-test. Get context for checkout,
then run the full purchase flow with card number 4242424242424242.
```

The AI will:
1. `scan_codebase` (if not already done)
2. `get_context("checkout")`, reading `CheckoutForm.tsx`, `api/orders/route.ts` and so on
3. `login`
4. `execute_scenario`, filling the real form fields from source code
5. `generate_report`

### Verify a bug fix

```
I fixed the login redirect bug. Use vibe-test to confirm it's working.
```

The AI will:
1. `login`, testing the login flow
2. `take_screenshot`, visual confirmation of the post-login state
3. Report back what it sees

### Find what's broken

```
Explore every page and tell me what's broken.
```

The AI will run `explore_page` on every route, collecting API errors, broken elements, and failed interactions, then `suggest_tests` with the broken items marked as high priority.

---

## init command

```bash
npx vibe-testing@latest init [options]
```

What it creates:

| File | Where | Purpose |
|------|-------|---------|
| `.mcp.json` | Project root | Claude Code MCP config (project-level) |
| `~/.claude/settings.json` | Global | Claude Code MCP config (all projects) |
| `.cursor/mcp.json` | Project root | Cursor MCP config |
| `~/.cursor/mcp.json` | Global | Cursor MCP config (all projects) |
| `.cursor/rules/vibe-test.mdc` | Project | Cursor rules, `alwaysApply: true` |
| `.windsurfrules` | Project | Windsurf instructions |
| `~/.codeium/windsurf/mcp_config.json` | Global | Windsurf MCP config (all projects) |
| `.vscode/mcp.json` | Project | VS Code Copilot MCP config |
| `.github/copilot-instructions.md` | Project | GitHub Copilot instructions |
| `.roo/mcp.json` | Project | Roo Code MCP config |
| `CLAUDE.md` | Project | Claude Code session instructions |
| `AGENTS.md` | Project | Universal agent instructions (Codex, Devin, Zed) |
| `VIBE.md` | Project | Test guidance, edit with your credentials |
| `vibe.config.json` | Project | Config, URL auto-detected from your project |

Options:

```bash
npx vibe-testing@latest init                     # auto-detect editors, register globally + project
npx vibe-testing@latest init --no-global         # project-level only, skip global registration
npx vibe-testing@latest init --skip-browser-install
npx vibe-testing@latest init --editor cursor     # only configure Cursor
npx vibe-testing@latest init --editor claude-code windsurf
```

After init, edit `VIBE.md` with your login URL and test credentials.

---

## CLI commands

```bash
# Set up in current project
npx vibe-testing@latest init

# Install or repair the matching browser build
npx vibe-testing@latest install-browser

# Run tests against a URL
npx vibe-testing@latest run http://localhost:3000
npx vibe-testing@latest run https://staging.myapp.com --mode deep
npx vibe-testing@latest run http://localhost:3000 --codebase /path/to/project --scope /login /dashboard

# Iterative testing until coverage thresholds
npx vibe-testing@latest converge http://localhost:3000
npx vibe-testing@latest converge http://localhost:3000 --max-rounds 6 --target-pass-rate 0.95

# Open last report in browser
npx vibe-testing@latest report

# Reset memory and screenshots for a clean run
npx vibe-testing@latest reset
```

### `run` options

| Option | Default | Description |
|--------|---------|-------------|
| `--mode fast\|deep` | `deep` | `fast`: quick scan. `deep`: full feature extraction plus exploration |
| `--no-headed` | - | Run browser headless (default: visible) |
| `--codebase <path>` | cwd | Path to project root |
| `--scope <routes...>` | all | Test only specific routes |
| `-c <path>` | `vibe.config.json` | Config file path |

`run` and `converge` fail with a nonzero exit when no scenarios are discovered
or an execution batch is empty. MCP `run_full_test` and `run_converge` return
`isError: true` for these cases. Empty runs do not write a successful run
snapshot or replace the prior report.

### `converge` options

| Option | Default | Description |
|--------|---------|-------------|
| `--max-rounds <n>` | `4` | Max follow-up rounds after baseline |
| `--target-pass-rate <r>` | `0.92` | Stop when pass rate reaches this (0-1) |
| `--max-gaps <n>` | `2` | Stop when critical plus important gaps fall to this |

---

## VIBE.md, project guidance

Create `VIBE.md` in your project root. vibe-testing reads it automatically on every run.

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
- /notifications (WebSocket dependent, skip or expect retry)
- /live-feed

## Notes
- Admin panel at /admin, use admin@example.com / adminpass
- Dashboard data loads async, wait for [data-loaded="true"]
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
    "max_routes": 30,
    "seed_routes": ["/live/dev-mode-a-now"]
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
| `url` | App URL, localhost or staging. Auto-detected by `init`. |
| `mode` | `fast` (heuristic scan) or `deep` (full extraction plus exploration) |
| `auth.strategy` | `credentials` (form login), `basic` (HTTP Basic Auth), or `skip` |
| `auth.login_url` | Explicit login route for non-standard paths keyword matching would miss |
| `auth.credentials` | Login credentials, used for login and for generated scenarios, persisted across runs |
| `never_interact` | Text patterns or CSS selectors to skip during exploration |
| `scope.include` | Route patterns to include; default `/**` includes `/` and all nested routes. `*` stays within one segment; a trailing `/**` includes the subtree root and its descendants. Other characters are literal. |
| `scope.exclude` | Route patterns to exclude from testing |
| `scope.max_routes` | Cap how many routes are tested per run |
| `scope.seed_routes` | Concrete URLs for dynamic-segment routes the parser can't enumerate (e.g. `/live/[slug]` becomes `/live/dev-mode-a-now`). Each seeded route inherits `requires_auth` and the source file from its dynamic parent. |
| `browser.headed` | `true` = visible browser. CLI default `true`, MCP server default `false` (headless) so editor sessions aren't disrupted by pop-up windows. |
| `browser.slowMo` | Milliseconds between actions (useful for debugging) |
| `routes` | `auto` (default) discovers routes from the codebase. `config` uses only routes explicitly listed in config. |

---

## Supported frameworks

| Framework | Routes | API endpoints | Forms |
|-----------|--------|---------------|-------|
| Next.js App Router | yes | yes | yes |
| Next.js Pages Router | yes | yes | yes |
| Next.js (src/ variant) | yes | yes | yes |
| React SPA (react-router) | yes | - | yes |
| Vue + Vite (vue-router) | yes | - | yes |
| Nuxt | yes | yes | yes |
| SvelteKit | yes | yes | yes |
| Express / Fastify | - | yes | yes |
| Monorepos (Turborepo, pnpm, Lerna) | yes | yes | yes |

Existing test files are also read to build a coverage map: Jest, Vitest, Playwright, and Cypress suites are all parsed.

---

## Memory and regression detection

vibe-testing learns across runs and stores state in `.vibe/`:

- **Working selectors**: remembers `[name='email']` worked on `/login`, uses it next run
- **Route timings**: adjusts timeouts based on measured load times
- **Auth credentials**: saved after first login, reused automatically
- **Flaky routes**: tracks high fail-rate routes, marks them for retry
- **Skip routes**: routes that consistently error (need URL params) are auto-skipped
- **Route manifest** (`.vibe/route-manifest.json`): every scan diffs against the previous one; new and removed routes surface as `route_changes` on `scan_codebase` results so the AI can cover them immediately
- **Run snapshot** (`.vibe/run-snapshot.json`): every run captures per-route pass/fail and diffs against the prior run; `snapshot_diff` flags `newly_passing` (fixes), `newly_failing` (regressions), `still_failing`, plus added and removed routes

```json
{
  "snapshot_diff": {
    "newly_passing": ["/login"],
    "newly_failing": ["/checkout"],
    "still_failing": [],
    "new_routes": ["/admin/users"],
    "removed_routes": []
  }
}
```

`run_converge` returns the same shape, so iterative runs in your editor highlight what you just broke.

Reset with `npx vibe-testing@latest reset` to start fresh.

---

## What a session looks like

When you ask your editor to "test the login flow", here is what it does:

```
User: "Test the login flow"

AI calls:
  scan_codebase({ codebase_path: ".", url: "http://localhost:3000" })
    -> Finds /login route, LoginForm component, POST /api/auth/login endpoint
    -> Returns 8 generated test scenarios

  get_context({ feature: "login" })
    -> Returns src/app/login/page.tsx (has name="email", name="password" fields)
    -> Returns src/app/api/auth/login/route.ts (POST handler, returns { token })
    -> AI now knows the real selectors: [name='email'], [name='password']

  login({ email: "test@example.com", password: "pass123" })
    -> Opens Chromium, fills the form, clicks submit
    -> Returns: { success: true, final_url: "/dashboard", tokens_found: 2 }
    -> Returns screenshot of post-login dashboard

  execute_scenario({ scenario: { name: "Login with invalid password", ... } })
    -> Returns screenshot showing error state

  generate_report()
    -> Writes .vibe/report.html, opens in browser

AI reports: "Login works. Invalid password shows an error. All 3 login scenarios passed."
```

---

## FAQ

**Does vibe-testing use an LLM internally?**
No. It uses heuristic verification (URL changes, toast detection, API errors). Your editor's model is the brain: it sees screenshots and decides what to test next. Runs have no API cost.

**What's the difference between `explore_page` and `execute_scenario`?**
`explore_page` is broad: it clicks every button and input it finds and reports the results. `execute_scenario` is precise: you give it specific steps and it follows them exactly. Use `explore_page` to find what's on a page, then `execute_scenario` to test specific flows.

**What's `get_context` for?**
It returns the actual source code for a feature, so the AI knows `[name='email']` instead of guessing `#email-input`. Always call it before writing test steps for a specific feature.

**Does it handle SPAs with client-side routing?**
Yes. Playwright navigates the real browser, so client-side routing (React Router, Vue Router, and the rest) works naturally.

**Does it handle login / authentication?**
Yes. The `login` tool fills credentials in a real browser, captures auth tokens from localStorage/cookies, and keeps that session alive for authenticated tests. Credentials are persisted in `.vibe/memory/` and reused automatically.

**Will it click "Delete Account" or other destructive buttons?**
No. Set `never_interact` in `vibe.config.json` or `VIBE.md` to blocklist dangerous actions. Any button whose text or selector matches is skipped during exploration.

**Can I use it without an AI editor?**
Yes. `vibe-test run https://your-app.com` runs standalone. It scans, generates scenarios, executes them, and produces an HTML report without needing an editor.

**How do I test a staging environment?**
Set `url` in `vibe.config.json` to your staging URL, or pass it as a CLI argument: `npx vibe-testing@latest run https://staging.myapp.com`.

**Does it work with monorepos?**
Yes. `init` detects Turborepo/pnpm/yarn workspaces and finds the frontend app automatically.

---

## Requirements

- Node.js >= 20 (the test suite uses vitest 4.x which requires Node 20+)
- Playwright Chromium. `init` installs the matching build. To install or repair it directly:
  ```bash
  npx vibe-testing@latest install-browser
  ```

`run` and `converge` check for the browser before scanning your project and print the same recovery command when it is missing.

### Docker

A Node 20 + Chromium image is included for environments that prefer container-based MCP servers:

```bash
docker build -t vibe-test .
# wire into your editor's MCP config:
# { "command": "docker", "args": ["run", "--rm", "-i", "vibe-test"] }
```

---

## Contributing

```bash
git clone https://github.com/AishwaryShrivastav/vibe-testing.git
cd vibe-testing
npm install
npx playwright install chromium
npm run build   # tsc -> dist/
npm run dev     # run CLI without building
npm run mcp     # run MCP server without building
npm test        # unit and isolated integration tests
VIBE_REAL_BROWSER=1 npm test  # also run real Chromium CLI/MCP regressions
```

See [CHANGELOG.md](./CHANGELOG.md) for version history. Bug reports and feature requests: [GitHub issues](https://github.com/AishwaryShrivastav/vibe-testing/issues).

---

## License

MIT, [Aishwary Shrivastav](https://github.com/AishwaryShrivastav)

---

## Links

- npm: https://www.npmjs.com/package/vibe-testing
- GitHub: https://github.com/AishwaryShrivastav/vibe-testing
- Issues: https://github.com/AishwaryShrivastav/vibe-testing/issues
- Official MCP registry: listed as `io.github.AishwaryShrivastav/vibe-testing` at https://registry.modelcontextprotocol.io
- [![mcpindex](https://mcpindex.ai/api/v1/badge/io-github-aishwaryshrivastav-vibe-testing)](https://mcpindex.ai/server/io-github-aishwaryshrivastav-vibe-testing)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [Playwright](https://playwright.dev)
