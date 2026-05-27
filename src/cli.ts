#!/usr/bin/env node
import { Command } from 'commander'
import { VibeTester } from './engine/index.js'
import { readJSON, fileExists } from './utils/file.js'
import { detectBaseUrl, detectMonorepo, findFrontendApp, detectFramework } from './engine/context/detector.js'
import type { VibeConfig } from './types/config.js'
import { logger } from './utils/logger.js'
import path from 'path'
import fs from 'fs/promises'

// ─── Embedded content for init command ──────────────────────────────────────

const CURSOR_RULE_CONTENT = `---
description: Browser testing with vibe-test MCP — use these tools whenever testing, verifying, or debugging a web app
globs:
alwaysApply: true
---

# Vibe Test — Browser Testing MCP Server

This project has **vibe-test** configured as an MCP server. You MUST use these tools whenever the user asks to test, verify, check, debug, or QA any part of this web application. Do not write Playwright/Cypress test scripts manually when these tools are available.

## Mandatory Usage Pattern

ALWAYS follow this order:

1. \`scan_codebase\` — Read the code first. Initializes the session and returns all routes, forms, coverage gaps, and ready-to-run scenarios.
2. \`get_context\` — Read the actual source files for the feature being tested (real field names, selectors, API paths). Call before writing any test steps.
3. \`login\` — If the app needs auth, authenticate once and the session persists.
4. \`scan_page_elements\` or \`explore_page\` — Visually confirm what's on the page.
5. \`execute_scenario\` — Run precise test flows using real selectors from step 2.
6. \`suggest_tests\` — Find coverage gaps.
7. \`generate_report\` — Always generate a report at the end.
8. \`cleanup\` — Close browsers.

## Tools Quick Reference

### \`scan_codebase\` (CALL FIRST — always)
\`\`\`json
{ "codebase_path": "/path/to/project", "url": "http://localhost:3000" }
\`\`\`

### \`get_context\` (CALL BEFORE WRITING TEST STEPS)
Returns actual source code for a feature — real field names, API endpoints. Eliminates selector guessing.
\`\`\`json
{ "feature": "login" }
{ "feature": "/checkout" }
\`\`\`

### \`login\`
\`\`\`json
{ "email": "test@example.com", "password": "pass123" }
\`\`\`

### \`scan_page_elements\`
\`\`\`json
{ "route": "/dashboard", "authenticated": true }
\`\`\`

### \`explore_page\`
Clicks every button, fills every input, records API calls and what breaks.
\`\`\`json
{ "route": "/dashboard", "authenticated": true }
\`\`\`

### \`execute_scenario\`
Build steps using real selectors from \`get_context\`:
\`\`\`json
{
  "scenario": {
    "id": "login-test",
    "name": "Login with valid credentials",
    "route": "/login",
    "steps": [
      { "action": "navigate", "url": "/login", "description": "Open login page" },
      { "action": "fill", "selector": "[name='email']", "value": "user@test.com", "description": "Fill email" },
      { "action": "fill", "selector": "[type='password']", "value": "pass123", "description": "Fill password" },
      { "action": "click", "selector": "button[type='submit']", "description": "Submit" }
    ],
    "expected_outcome": "Redirect to dashboard"
  }
}
\`\`\`

### \`take_screenshot\`
\`\`\`json
{ "url": "/settings", "authenticated": true }
\`\`\`

### \`get_coverage\` / \`suggest_tests\` / \`generate_report\` / \`run_full_test\` / \`run_converge\` / \`cleanup\`
Self-explanatory. Use \`run_full_test\` for a complete one-shot run. Use \`run_converge\` for iterative testing until thresholds.

## Key Rules

- NEVER write manual Playwright/Cypress/Jest browser tests when vibe-test is available
- ALWAYS call \`scan_codebase\` first, then \`get_context\` before test steps
- Screenshots returned by tools are images — look at them to confirm browser state
- VIBE.md contains test credentials, blocklist patterns, and project-specific notes
- After code changes, re-run the relevant \`execute_scenario\` to verify the fix
`

const CLAUDE_MD_CONTENT = `# Vibe Test — AI Testing Agent

This project uses **vibe-test** as an MCP server for browser testing. Use these tools automatically whenever testing or verifying any part of this application.

## When to Use (automatic triggers)

Use vibe-test tools whenever:
- User asks to test, check, verify, or QA anything
- User reports a bug and wants you to reproduce it
- User adds a new feature and wants it tested
- User asks if something is working
- After any code change that affects the UI or API

## Required Workflow

Always follow this sequence — do not skip steps:

\`\`\`
1. scan_codebase   → initialize session, understand routes & forms
2. get_context     → read actual source code for the feature (CRITICAL: use real selectors)
3. login           → authenticate if app requires it
4. explore_page    → discover elements and interactions visually
5. execute_scenario → run targeted test steps with real selectors
6. generate_report → produce HTML report with screenshots
7. cleanup         → close browsers
\`\`\`

## Tool Invocations

**scan_codebase** — call first, always
\`\`\`json
{ "codebase_path": ".", "url": "http://localhost:3000" }
\`\`\`

**get_context** — call before every set of test steps
\`\`\`json
{ "feature": "login" }
\`\`\`
This returns the actual source files so you know the real \`name\`, \`id\`, placeholder, and API endpoint — write test steps using these, not guesses.

**login**
\`\`\`json
{ "email": "test@example.com", "password": "yourpassword" }
\`\`\`

**explore_page** — broad visual exploration
\`\`\`json
{ "route": "/dashboard", "authenticated": true }
\`\`\`

**execute_scenario** — targeted test with real selectors
\`\`\`json
{
  "scenario": {
    "id": "my-test",
    "name": "Create new item",
    "route": "/items",
    "steps": [
      { "action": "navigate", "url": "/items", "description": "Open items page" },
      { "action": "click", "selector": "text=Add Item", "description": "Click add button" },
      { "action": "fill", "selector": "[name='title']", "value": "Test Item", "description": "Fill title" },
      { "action": "click", "selector": "button[type='submit']", "description": "Submit form" }
    ],
    "expected_outcome": "New item appears in list"
  }
}
\`\`\`

**suggest_tests** — find untested flows
\`\`\`json
{ "route": "/dashboard" }
\`\`\`

**generate_report** — HTML report, opens in browser automatically

**run_full_test** — one-shot complete run
\`\`\`json
{ "url": "http://localhost:3000", "codebase_path": "." }
\`\`\`

## Project-Specific Testing Notes

See \`VIBE.md\` for:
- Login URL and test credentials
- Elements to never interact with (delete, billing, etc.)
- Known flaky routes to skip
`

const VIBE_MD_TEMPLATE = `# VIBE.md — Project Testing Guidance

> Edit this file with your project's details. Vibe Test reads it automatically on every run.

## Login URL
/login

## Test Credentials
- Email: your-test-user@example.com
- Password: your-test-password

## Never Automate
- delete account
- cancel subscription
- [data-testid="danger-zone"]

## Known Flaky
- /notifications (if WebSocket dependent)

## Notes
- Add any project-specific testing notes here
- e.g. "Admin panel lives at /admin, use admin@example.com / adminpass"
`

const AGENTS_MD_CONTENT = `# AGENTS.md — Vibe Test Integration

This project uses **vibe-test**, a code-aware browser testing agent available as an MCP server. All AI coding assistants (Claude Code, Cursor, Copilot, Devin, Codex, Zed) should use these tools automatically for testing.

## When to Use (automatic)

Use vibe-test tools whenever the user asks to:
- Test, verify, check, or QA any feature
- Reproduce a bug
- Confirm a fix works
- Check if a new feature is working

## Testing Workflow

\`\`\`
1. scan_codebase({ codebase_path: ".", url: "http://localhost:3000" })
2. get_context({ feature: "<feature name or route>" })
3. login({ email: "...", password: "..." })          # if app needs auth
4. explore_page({ route: "/target", authenticated: true })
5. execute_scenario({ scenario: { ... } })           # use real selectors from get_context
6. generate_report()
7. cleanup()
\`\`\`

## Available MCP Tools

| Tool | When to call |
|------|-------------|
| \`scan_codebase\` | Always first — initializes session, discovers routes/forms/gaps |
| \`get_context\` | Before writing test steps — returns real source code with field names |
| \`login\` | When app requires authentication |
| \`scan_page_elements\` | To see all interactive elements on a page |
| \`explore_page\` | Broad exploration — clicks everything, reports what breaks |
| \`execute_scenario\` | Run specific test flows with precise steps |
| \`take_screenshot\` | Quick visual verification |
| \`get_coverage\` | View coverage map and gaps |
| \`suggest_tests\` | Get prioritized, ready-to-run scenarios |
| \`generate_report\` | HTML report with screenshots (auto-opens) |
| \`run_full_test\` | All-in-one: scan → execute → explore → report |
| \`run_converge\` | Iterative: keep testing until coverage thresholds met |
| \`cleanup\` | Close browsers when done |

## Quick Commands

\`\`\`
"Test the login flow"
→ scan_codebase → get_context("login") → login → execute_scenario → generate_report

"Explore the dashboard and find broken things"
→ scan_codebase → login → explore_page("/dashboard") → suggest_tests → generate_report

"Run a full test of this app"
→ run_full_test({ url: "http://localhost:3000", codebase_path: "." })
\`\`\`

## Project-Specific Notes

See \`VIBE.md\` for test credentials, blocklist patterns, and project notes.
Setup: run \`npx vibe-testing@latest init\` to configure for any editor.
`

const MCP_SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'vibe-testing@latest', '--mcp'],
}

// ─── Editor detection and configuration ─────────────────────────────────────

interface EditorTarget {
  name: string
  projectConfigs: { path: string; rootKey: string; format: 'mcpServers' | 'servers' | 'context_servers' }[]
  globalConfigs: { path: () => string; rootKey: string; format: 'mcpServers' | 'servers' | 'context_servers' }[]
  rulesFiles: { path: string; content: string }[]
  detect: () => Promise<boolean>
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? ''
}

const EDITORS: EditorTarget[] = [
  {
    name: 'Cursor',
    projectConfigs: [{ path: '.cursor/mcp.json', rootKey: 'mcpServers', format: 'mcpServers' }],
    globalConfigs: [{ path: () => path.join(homeDir(), '.cursor', 'mcp.json'), rootKey: 'mcpServers', format: 'mcpServers' }],
    rulesFiles: [{ path: '.cursor/rules/vibe-test.mdc', content: CURSOR_RULE_CONTENT }],
    detect: async () => {
      const dirs = [path.join(homeDir(), '.cursor'), path.join(process.cwd(), '.cursor')]
      for (const d of dirs) { try { await fs.access(d); return true } catch {} }
      return false
    },
  },
  {
    name: 'Claude Code',
    projectConfigs: [{ path: '.mcp.json', rootKey: 'mcpServers', format: 'mcpServers' }],
    globalConfigs: [{ path: () => path.join(homeDir(), '.claude', 'settings.json'), rootKey: 'mcpServers', format: 'mcpServers' }],
    rulesFiles: [{ path: 'CLAUDE.md', content: CLAUDE_MD_CONTENT }],
    detect: async () => {
      const paths = [path.join(homeDir(), '.claude'), path.join(homeDir(), '.claude.json')]
      for (const p of paths) { try { await fs.access(p); return true } catch {} }
      return false
    },
  },
  {
    name: 'Windsurf',
    projectConfigs: [],
    globalConfigs: [{ path: () => path.join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json'), rootKey: 'mcpServers', format: 'mcpServers' }],
    rulesFiles: [{ path: '.windsurfrules', content: CURSOR_RULE_CONTENT.replace(/^---[\s\S]*?---\n\n/, '') }],
    detect: async () => {
      try { await fs.access(path.join(homeDir(), '.codeium', 'windsurf')); return true } catch { return false }
    },
  },
  {
    name: 'VS Code (Copilot)',
    projectConfigs: [{ path: '.vscode/mcp.json', rootKey: 'servers', format: 'servers' }],
    globalConfigs: [],
    rulesFiles: [{ path: '.github/copilot-instructions.md', content: AGENTS_MD_CONTENT }],
    detect: async () => {
      try { await fs.access(path.join(process.cwd(), '.vscode')); return true } catch { return false }
    },
  },
  {
    name: 'Roo Code',
    projectConfigs: [{ path: '.roo/mcp.json', rootKey: 'mcpServers', format: 'mcpServers' }],
    globalConfigs: [],
    rulesFiles: [],
    detect: async () => {
      try { await fs.access(path.join(process.cwd(), '.roo')); return true } catch { return false }
    },
  },
]

async function upsertMcpConfig(filePath: string, rootKey: string): Promise<'created' | 'updated' | 'skipped'> {
  let config: any = {}
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    config = JSON.parse(raw)
  } catch { /* file doesn't exist */ }

  if (!config[rootKey]) config[rootKey] = {}
  if (config[rootKey]['vibe-test']) return 'skipped'

  config[rootKey]['vibe-test'] = { ...MCP_SERVER_ENTRY }
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  return Object.keys(config[rootKey]).length === 1 ? 'created' : 'updated'
}

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
  return true
}

// ─── Entry point ────────────────────────────────────────────────────────────

// If invoked with --mcp flag, start the MCP server directly
if (process.argv.includes('--mcp')) {
  await import('./mcp-server.js')
  // mcp-server.ts connects to stdio and stays alive — execution won't reach here
} else {

const program = new Command()

program
  .name('vibe-test')
  .description('AI-powered browser testing agent — reads your code, tests your product')
  .version('0.3.1')

program
  .command('run [url]')
  .description('Run vibe tests against a URL')
  .option('-m, --mode <mode>', 'fast or deep (default: deep)', 'deep')
  .option('--no-headed', 'run browser headless')
  .option('-c, --config <path>', 'path to vibe.config.json')
  .option('--codebase <path>', 'path to codebase root (default: cwd)')
  .option('--scope <routes...>', 'limit to specific routes e.g. /login /checkout')
  .action(async (urlArg: string | undefined, opts: {
    mode: string
    headed: boolean
    config?: string
    codebase?: string
    scope?: string[]
  }) => {
    const configPath = opts.config ?? path.join(process.cwd(), 'vibe.config.json')
    const fileConfig = await readJSON<Partial<VibeConfig>>(configPath) ?? {}

    const url = urlArg ?? fileConfig.url
    if (!url) {
      logger.error('URL required — pass as argument or set in vibe.config.json')
      process.exit(1)
    }

    const config = {
      ...fileConfig,
      url,
      mode: opts.mode as 'fast' | 'deep',
      codebase_path: opts.codebase ?? fileConfig.codebase_path,
      browser: {
        ...fileConfig.browser,
        headed: opts.headed !== false,
      },
      ...(opts.scope?.length ? { scope: { ...fileConfig.scope, include: opts.scope } } : {}),
    }

    const tester = new VibeTester(config)
    const result = await tester.run()

    if (result.summary.failed > 0 || result.summary.errors > 0) {
      process.exit(1)
    }
  })

program
  .command('converge [url]')
  .description('Iterative coverage: baseline run, then follow-up rounds from gaps + failures until thresholds (or max rounds)')
  .option('-m, --mode <mode>', 'fast or deep (default: deep)', 'deep')
  .option('--no-headed', 'run browser headless')
  .option('-c, --config <path>', 'path to vibe.config.json')
  .option('--codebase <path>', 'path to codebase root (default: cwd)')
  .option('--max-rounds <n>', 'max follow-up rounds after baseline', '4')
  .option('--target-pass-rate <r>', 'stop when last batch pass rate reaches this (0-1)', '0.92')
  .option('--max-gaps <n>', 'stop when critical+important gaps <= this', '2')
  .action(async (urlArg: string | undefined, opts: {
    mode: string
    headed: boolean
    config?: string
    codebase?: string
    maxRounds: string
    targetPassRate: string
    maxGaps: string
  }) => {
    const configPath = opts.config ?? path.join(process.cwd(), 'vibe.config.json')
    const fileConfig = await readJSON<Partial<VibeConfig>>(configPath) ?? {}

    const url = urlArg ?? fileConfig.url
    if (!url) {
      logger.error('URL required — pass as argument or set in vibe.config.json')
      process.exit(1)
    }

    const config = {
      ...fileConfig,
      url,
      mode: opts.mode as 'fast' | 'deep',
      codebase_path: opts.codebase ?? fileConfig.codebase_path,
      browser: {
        ...fileConfig.browser,
        headed: opts.headed !== false,
      },
    }

    const tester = new VibeTester(config)
    const result = await tester.converge({
      max_followup_rounds: parseInt(opts.maxRounds, 10) || 4,
      target_pass_rate: parseFloat(opts.targetPassRate) || 0.92,
      max_high_severity_gaps: parseInt(opts.maxGaps, 10) || 2,
    })

    logger.info(`Converge finished: ${result.summary.converge_rounds ?? 1} round(s), ${result.coverage_gaps.length} gaps remaining`)

    if (result.summary.failed > 0 || result.summary.errors > 0) {
      process.exit(1)
    }
  })

program
  .command('init')
  .description('Set up Vibe Test — auto-detects editors (Cursor, Claude Code, Windsurf, VS Code, Roo Code) and configures all of them globally + per-project')
  .option('--no-global', 'Skip global editor config registration (project-level only)')
  .option('--editor <names...>', 'Only configure specific editors (cursor, claude-code, windsurf, vscode, roo)')
  .action(async (opts: { global?: boolean; editor?: string[] }) => {
    const cwd = process.cwd()
    const projectName = path.basename(cwd)
    let created = 0
    let skipped = 0

    logger.section(`Setting up Vibe Test in ${projectName}`)

    // Detect which editors are installed
    const detected: EditorTarget[] = []
    const filterNames = opts.editor?.map(e => e.toLowerCase())

    for (const editor of EDITORS) {
      const aliases: Record<string, string[]> = {
        'Cursor': ['cursor'],
        'Claude Code': ['claude-code', 'claude', 'claudecode'],
        'Windsurf': ['windsurf', 'cascade'],
        'VS Code (Copilot)': ['vscode', 'vs-code', 'copilot', 'github-copilot'],
        'Roo Code': ['roo', 'roo-code', 'roocode', 'roo-cline'],
      }
      if (filterNames && !filterNames.some(f =>
        editor.name.toLowerCase().includes(f) ||
        (aliases[editor.name] ?? []).includes(f)
      )) continue

      const found = await editor.detect()
      if (found || filterNames) {
        detected.push(editor)
      }
    }

    if (detected.length === 0) {
      logger.dim('  No specific editors detected — configuring for Cursor + Claude Code + VS Code')
      detected.push(EDITORS[0], EDITORS[1], EDITORS[3])
    }

    const editorNames = detected.map(e => e.name).join(', ')
    logger.info(`  Detected editors: ${editorNames}`)
    console.log('')

    for (const editor of detected) {
      logger.info(`  ${editor.name}:`)

      for (const pc of editor.projectConfigs) {
        const fullPath = path.join(cwd, pc.path)
        const result = await upsertMcpConfig(fullPath, pc.rootKey)
        if (result === 'skipped') {
          logger.dim(`    ${pc.path} — vibe-test already registered`)
          skipped++
        } else {
          logger.success(`    ${result === 'created' ? 'Created' : 'Updated'} ${pc.path}`)
          created++
        }
      }

      // Global configs — always register unless --no-global passed
      if (opts.global !== false) {
        for (const gc of editor.globalConfigs) {
          try {
            const fullPath = gc.path()
            const result = await upsertMcpConfig(fullPath, gc.rootKey)
            const shortPath = fullPath.replace(homeDir(), '~')
            if (result === 'skipped') {
              logger.dim(`    ${shortPath} — already registered globally`)
              skipped++
            } else {
              logger.success(`    ${result === 'created' ? 'Created' : 'Updated'} ${shortPath} (global)`)
              created++
            }
          } catch (e) {
            logger.warn(`    Could not update global config: ${e}`)
          }
        }
      }

      for (const rf of editor.rulesFiles) {
        const fullPath = path.join(cwd, rf.path)
        const wrote = await writeIfMissing(fullPath, rf.content)
        if (wrote) {
          logger.success(`    Created ${rf.path}`)
          created++
        } else {
          logger.dim(`    ${rf.path} already exists`)
          skipped++
        }
      }
    }

    // AGENTS.md — universal agent instruction file
    console.log('')
    logger.info('  Universal:')
    const agentsMdPath = path.join(cwd, 'AGENTS.md')
    if (await writeIfMissing(agentsMdPath, AGENTS_MD_CONTENT)) {
      logger.success('    Created AGENTS.md (Codex, Devin, Copilot, Zed, Windsurf)')
      created++
    } else {
      logger.dim('    AGENTS.md already exists')
      skipped++
    }

    // VIBE.md
    const vibeMdPath = path.join(cwd, 'VIBE.md')
    if (await writeIfMissing(vibeMdPath, VIBE_MD_TEMPLATE)) {
      logger.success('    Created VIBE.md (edit with your test credentials)')
      created++
    } else {
      logger.dim('    VIBE.md already exists')
      skipped++
    }

    // vibe.config.json — auto-detect port from .env / vite.config / framework defaults
    const configPath = path.join(cwd, 'vibe.config.json')
    if (await fileExists(configPath)) {
      logger.dim('    vibe.config.json already exists')
      skipped++
    } else {
      // Auto-detect monorepo and base URL
      let scanPath = cwd
      const isMonorepo = await detectMonorepo(cwd)
      if (isMonorepo) {
        const frontendApp = await findFrontendApp(cwd)
        if (frontendApp) {
          scanPath = frontendApp
          logger.dim(`    Monorepo detected — scanning frontend app at ${path.relative(cwd, frontendApp)}`)
        }
      }

      const framework = await detectFramework(scanPath)
      const detectedUrl = await detectBaseUrl(scanPath, framework)
      const defaultConfig = {
        url: detectedUrl,
        mode: 'deep',
        auth: { strategy: 'skip' },
        never_interact: ['delete account', 'cancel subscription'],
        scope: { include: ['/**'], exclude: [], max_routes: 30 },
        browser: { headed: true, slowMo: 40 },
      }
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8')
      logger.success(`    Created vibe.config.json (detected URL: ${detectedUrl})`)
      created++
    }

    // Summary
    console.log('')
    if (created > 0) {
      logger.success(`Done! ${created} file(s) created${skipped > 0 ? `, ${skipped} skipped` : ''}.`)
    } else {
      logger.info('Everything is already set up.')
    }

    console.log('')
    logger.info('Next steps:')
    logger.dim('  1. Edit VIBE.md with your login URL and test credentials')
    logger.dim('  2. Confirm the URL in vibe.config.json matches your running app')
    logger.dim('  3. Open your editor and ask:')
    console.log('')
    console.log('     "Scan this codebase and test it against <your-url>."')
    console.log('')
    logger.dim('  Your editor will pick up vibe-test tools automatically in every project.')
    console.log('')
  })

program
  .command('reset')
  .description('Delete .vibe in the current project (memory, intel, screenshots) for a fresh test run')
  .action(async () => {
    const dir = path.join(process.cwd(), '.vibe')
    try {
      await fs.rm(dir, { recursive: true, force: true })
      logger.success(`Removed ${dir} — next run starts clean`)
    } catch (e) {
      logger.warn(`Could not remove .vibe: ${e}`)
    }
  })

program
  .command('report')
  .description('Open the last test report in your browser')
  .action(async () => {
    const reportPath = path.join(process.cwd(), '.vibe', 'report.html')
    try {
      await fs.access(reportPath)
      const { exec } = await import('child_process')
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
      exec(`${openCmd} "${reportPath}"`)
      logger.success(`Opened report: ${reportPath}`)
    } catch {
      logger.error('No report found. Run vibe-test run first.')
    }
  })

program.parse()

} // end if not --mcp
