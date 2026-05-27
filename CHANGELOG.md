# Changelog

All notable changes to **vibe-test** are documented here.

---

## [0.3.1] — 2026-05-27

### Fixed

- **SvelteKit and Nuxt route detection** — added proper `'sveltekit'` and `'nuxt'` framework types with dedicated route parsers (`+page.svelte`, `pages/*.vue`, `+server.ts`, `server/api/**`). Previously returned `'react-spa'` and `'nextjs-pages'` respectively, producing 0 routes.
- **HTTP Basic Auth support** — added `'basic'` as a valid auth strategy. Sets credentials on the browser context via `context.setHTTPCredentials()` for preview-gated staging sites. Previously crashed with a raw Zod stack trace.
- **Auth login on forms without name/id attributes** — login now tries cascading selectors: `[name]`, `[type]`, `#id`, `[placeholder*="email"]`, `[aria-label*="email"]`, `input[type="text"]:first-of-type`. Previously timed out on React controlled components with no identifying attributes.
- **Phantom "text=Active" click scenarios** — removed hardcoded `['All', 'Active']` fallback in enricher's `findFilterOptions`. When no real filter tabs are found, no filter scenario is generated instead of producing guaranteed failures.
- **Package name consistency** — replaced all `@aishwaryshrivastava/vibe-test` references with `vibe-testing@latest` across README, MCP-SETUP.md, CLAUDE.md, AGENTS.md template, and CLI init output.

### Changed

- Updated `llms.txt` and `llms-full.txt` to document all 13 MCP tools (was 11, missing `get_context` and `run_converge`).

---

## [0.3.0] — 2026-05-22

### Added

- **`get_context` MCP tool** — returns the most relevant source files for a given feature or route with relevance scoring. Gives the LLM real field names, selectors, and API endpoints before it writes test steps, eliminating selector guesswork. Ported from testpilot pattern.
- **Monorepo detection** — `init` and `scan_codebase` now detect Turborepo, pnpm workspaces, yarn workspaces, and Lerna. Automatically finds the frontend app in `apps/` or `packages/` by scoring dependencies.
- **Port auto-detection** — `init` reads `.env.local` → `.env.development` → `.env` for `PORT=`, then `vite.config.{ts,js}` for `port:`, then falls back to framework defaults (Next.js: 3000, Vite/React: 5173). Writes the correct URL into `vibe.config.json` automatically.
- **More frameworks in detector** — Nuxt, SvelteKit, Fastify, Vue, and `src/app` / `src/pages` Next.js variants.
- **Global registration by default** — `init` now registers vibe-test in global editor configs (`~/.claude/settings.json`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`) by default, not just project-level. Every future session in any project has the tools available. Use `--no-global` to opt out.
- **Correct Claude Code global path** — fixed from `~/.claude.json` to `~/.claude/settings.json`.
- **Windsurf gets `.windsurfrules`** — project-level instructions file created on init.
- **VS Code Copilot gets `.github/copilot-instructions.md`** — picked up automatically by GitHub Copilot.
- **`CLAUDE.md` shipped with package** — included in npm `files` so it's available immediately after install.
- **GitHub Actions CI** — builds and type-checks on Node 18, 20, 22. Dry-run publish on non-tagged commits, real publish on git tags.
- **`.npmignore`** — keeps the npm package clean (excludes `src/`, `test/`, `.github/`, etc.).
- **`MCP-SETUP.md`** — quick reference for manually adding vibe-test to any editor.

### Changed

- Package name corrected to `vibe-test` (was accidentally set to `vibe-testing` in a previous commit).
- `init --global` flag flipped to `init --no-global` — global is now the default.
- Init output now shows `(global)` next to globally registered configs.
- Stronger mandatory language in all AI assistant templates: `MUST use`, `ALWAYS call`, `NEVER write manual Playwright tests`.
- `CLAUDE.md` template (written to user projects) now includes `get_context` step in the required workflow.
- Cursor rule (`alwaysApply: true`) ensures the rule is injected into every Cursor conversation.

### Fixed

- Claude Code global config path was `~/.claude.json` — corrected to `~/.claude/settings.json`.

---

## [0.2.0] — 2026-04-28

### Added

- **`converge` command and `run_converge` MCP tool** — iterative testing: baseline run, then automatic follow-up rounds from coverage gaps and failures until pass-rate / gap thresholds or max rounds.
- **Multi-editor `init`** — auto-detects Cursor, Claude Code, Windsurf, VS Code, Roo Code and configures all of them in one command.
- **`AGENTS.md`** — universal agent instructions file created on init (works with Codex, Devin, Zed).
- **`run_converge` MCP tool** — exposes converge behavior to editor LLMs.

### Changed

- `init` now creates `vibe.config.json` with sensible defaults.
- Cursor rules use `alwaysApply: true` to inject into every conversation.

---

## [0.1.0] — 2026-04-10

### Added

- Initial release.
- MCP server with 11 tools: `scan_codebase`, `login`, `scan_page_elements`, `explore_page`, `execute_scenario`, `get_coverage`, `suggest_tests`, `take_screenshot`, `generate_report`, `run_full_test`, `cleanup`.
- CLI: `vibe-test run`, `vibe-test reset`, `vibe-test report`.
- Framework detection: Next.js App Router, Next.js Pages Router, React SPA, Express.
- Static code analysis: routes, forms, buttons, dialogs, feature extraction.
- Playwright browser engine: scenario runner, page explorer, heuristic verifier.
- Memory system: persists selectors, credentials, flaky flows, run history.
- HTML report: self-contained, dark theme, embedded screenshots.
- `VIBE.md` support: project-specific login URL, credentials, blocklist, flaky routes.
- Action blocklist: prevents destructive interactions during exploration.
