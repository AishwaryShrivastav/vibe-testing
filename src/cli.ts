#!/usr/bin/env node
import { Command } from 'commander'
import { VibeTester } from './engine/index.js'
import { readJSON, fileExists } from './utils/file.js'
import type { VibeConfig } from './types/config.js'
import { logger } from './utils/logger.js'
import path from 'path'
import fs from 'fs/promises'

// ─── Embedded content for init command ──────────────────────────────────────

const CURSOR_RULE_CONTENT = `---
description: How to use the vibe-test MCP server for browser testing
globs: 
alwaysApply: true
---

# Vibe Testing — MCP Server for Browser Testing

You have access to the \`vibe-test\` MCP server which provides code-aware browser testing tools. Use these tools to test web applications by understanding their codebase, exploring pages, and executing test scenarios.

## Quick Start Workflow

1. **Scan the codebase** → understand routes, forms, coverage gaps
2. **Login** (if app requires auth) → establish an authenticated browser session
3. **Explore pages** → discover elements, click everything, observe what works/breaks
4. **Execute scenarios** → run specific test flows (generated or custom)
5. **Generate report** → HTML report with screenshots and coverage analysis
6. **Cleanup** → close browsers when done

## Available MCP Tools

### \`scan_codebase\`
**Call first.** Analyzes the project source code to build a ProductModel:
- Detects framework (Next.js, React SPA, etc.)
- Parses all routes (pages + API endpoints)
- Extracts forms, buttons, dialogs, features per route
- Reads existing test files for coverage mapping
- Identifies gaps and generates test scenarios

\`\`\`json
{ "codebase_path": "/path/to/project", "url": "https://staging.myapp.com" }
\`\`\`

### \`login\`
Establish an authenticated browser session. Uses saved credentials from previous runs or accepts new ones.

\`\`\`json
{ "email": "user@example.com", "password": "pass123", "login_url": "/login" }
\`\`\`

Returns: post-login screenshot, token state, API calls observed.

### \`scan_page_elements\`
Navigate to a page and discover all interactive elements without interacting with them. Returns element types, selectors, text, and a page screenshot.

\`\`\`json
{ "route": "/dashboard", "authenticated": true }
\`\`\`

### \`explore_page\`
Full "senior tester" exploration — clicks every button, fills every input, tests every tab, observes API calls. Returns detailed interaction outcomes.

\`\`\`json
{ "route": "/dashboard", "authenticated": true }
\`\`\`

### \`execute_scenario\`
Run a specific test scenario (sequence of steps). You can use scenarios from \`scan_codebase\` output or construct custom ones.

\`\`\`json
{
  "scenario": {
    "id": "test-login",
    "name": "Login with valid credentials",
    "route": "/login",
    "steps": [
      { "action": "navigate", "url": "/login", "description": "Go to login page" },
      { "action": "fill", "selector": "[type='email']", "value": "user@test.com", "description": "Fill email" },
      { "action": "fill", "selector": "[type='password']", "value": "pass123", "description": "Fill password" },
      { "action": "click", "selector": "button[type='submit']", "description": "Click submit" }
    ],
    "expected_outcome": "Redirect to dashboard"
  }
}
\`\`\`

### \`take_screenshot\`
Quick visual check — navigate to a URL and return a screenshot.

\`\`\`json
{ "url": "/settings", "authenticated": true }
\`\`\`

### \`get_coverage\`
Returns coverage map, gaps, and suggested scenarios from the last \`scan_codebase\` call.

### \`suggest_tests\`
Analyze codebase features vs test coverage and previous run history. Returns **prioritized, executable scenario objects** you can pass directly to \`execute_scenario\`. Identifies:
- Untested CRUD operations (critical)
- Missing form validation tests (high)
- Broken elements found during exploration (high)
- Previously failing routes that need retests (high)
- API errors observed during exploration (critical/high)
- Untested navigation flows (low)

\`\`\`json
{ "route": "/dashboard" }
\`\`\`

Use this after \`scan_codebase\` and \`explore_page\` to understand what tests should be written. Each suggestion includes a ready-to-run scenario with steps.

### \`generate_report\`
Generate an HTML report from all collected test results and explorations.

### \`run_full_test\`
All-in-one: scan → generate → execute → explore → report. Use for complete test runs.

\`\`\`json
{ "url": "https://staging.myapp.com", "codebase_path": "/path/to/project" }
\`\`\`

### \`cleanup\`
Close all browsers and reset session state.

## Best Practices

- Always call \`scan_codebase\` first — it initializes the session
- Use \`scan_page_elements\` to understand a page before writing custom scenarios
- Use \`explore_page\` for broad "does everything work?" testing
- Use \`suggest_tests\` to find gaps and get ready-to-run scenarios
- Use \`execute_scenario\` for targeted, specific test flows
- Screenshots are returned as images — use them to visually verify results
- After making code changes, re-run relevant scenarios to verify fixes
- Call \`cleanup\` when done to free browser resources
- Vibe Test learns from every run — selectors, timings, and failure patterns are persisted

## VIBE.md Project Guidance

Projects can include a \`VIBE.md\` file in their root to guide testing:
- Login URLs, test accounts
- Elements to never interact with (delete buttons, billing, etc.)
- Known flaky flows to skip
- Special environment setup notes
`

const VIBE_MD_TEMPLATE = `# VIBE.md — Project Testing Guidance

> Edit this file with your project's details. Vibe Test reads it automatically.

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
`

const AGENTS_MD_CONTENT = `# AGENTS.md — Vibe Test Integration

This project uses **Vibe Test**, a code-aware browser testing agent available as an MCP server.

## Testing

To test this application, use the \`vibe-test\` MCP tools:

1. \`scan_codebase\` — Analyze the project (call first, always)
2. \`login\` — Authenticate if the app requires login
3. \`explore_page\` — Interactively test a page (clicks every element)
4. \`suggest_tests\` — Find test coverage gaps and get executable scenarios
5. \`execute_scenario\` — Run a specific test flow
6. \`generate_report\` — HTML report with screenshots (auto-opens)
7. \`cleanup\` — Close browsers when done

### Quick test command
\`\`\`
Scan this codebase with vibe-test and test it against <URL>. Log in, explore pages, and generate a report.
\`\`\`

### Setup
If vibe-test MCP is not configured, run:
\`\`\`bash
npx vibe-test@latest init
\`\`\`

See \`VIBE.md\` for project-specific test credentials and guidance.
`

const MCP_SERVER_ENTRY = {
  command: 'npx',
  args: ['-y', 'vibe-test@latest', '--mcp'],
}

// ─── Editor detection and configuration ─────────────────────────────────────

interface EditorTarget {
  name: string
  /** Project-level config paths (relative to cwd) */
  projectConfigs: { path: string; rootKey: string; format: 'mcpServers' | 'servers' | 'context_servers' }[]
  /** Global config paths (absolute, resolved at runtime) */
  globalConfigs: { path: () => string; rootKey: string; format: 'mcpServers' | 'servers' | 'context_servers' }[]
  /** Project-level rules/instructions files */
  rulesFiles: { path: string; content: string }[]
  /** How to detect if this editor is installed */
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
    rulesFiles: [{ path: '.cursor/rules/vibe-testing.mdc', content: CURSOR_RULE_CONTENT }],
    detect: async () => {
      const dirs = [path.join(homeDir(), '.cursor'), path.join(process.cwd(), '.cursor')]
      for (const d of dirs) { try { await fs.access(d); return true } catch {} }
      return false
    },
  },
  {
    name: 'Claude Code',
    projectConfigs: [{ path: '.mcp.json', rootKey: 'mcpServers', format: 'mcpServers' }],
    globalConfigs: [{ path: () => path.join(homeDir(), '.claude.json'), rootKey: 'mcpServers', format: 'mcpServers' }],
    rulesFiles: [{ path: 'CLAUDE.md', content: AGENTS_MD_CONTENT }],
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
    rulesFiles: [],
    detect: async () => {
      try { await fs.access(path.join(homeDir(), '.codeium', 'windsurf')); return true } catch { return false }
    },
  },
  {
    name: 'VS Code (Copilot)',
    projectConfigs: [{ path: '.vscode/mcp.json', rootKey: 'servers', format: 'servers' }],
    globalConfigs: [],
    rulesFiles: [],
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
  .version('0.2.0')

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
  .command('init')
  .description('Set up Vibe Test — auto-detects editors (Cursor, Claude Code, Windsurf, VS Code, Roo Code) and configures all of them')
  .option('--global', 'Also register MCP server in global/user-level editor configs')
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
      // No editors detected — set up for all common ones
      logger.dim('  No specific editors detected — configuring for Cursor + Claude Code + VS Code')
      detected.push(EDITORS[0], EDITORS[1], EDITORS[3])
    }

    const editorNames = detected.map(e => e.name).join(', ')
    logger.info(`  Detected editors: ${editorNames}`)
    console.log('')

    // Configure each editor
    for (const editor of detected) {
      logger.info(`  ${editor.name}:`)

      // Project-level MCP configs
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

      // Global configs (only if --global)
      if (opts.global) {
        for (const gc of editor.globalConfigs) {
          try {
            const fullPath = gc.path()
            const result = await upsertMcpConfig(fullPath, gc.rootKey)
            const shortPath = fullPath.replace(homeDir(), '~')
            if (result === 'skipped') {
              logger.dim(`    ${shortPath} — vibe-test already registered`)
              skipped++
            } else {
              logger.success(`    ${result === 'created' ? 'Created' : 'Updated'} ${shortPath}`)
              created++
            }
          } catch (e) {
            logger.warn(`    Could not update global config: ${e}`)
          }
        }
      }

      // Rules/instruction files
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

    // AGENTS.md — universal agent instruction file (Codex, Devin, Copilot, Zed, etc.)
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

    // vibe.config.json
    const configPath = path.join(cwd, 'vibe.config.json')
    if (await fileExists(configPath)) {
      logger.dim('    vibe.config.json already exists')
      skipped++
    } else {
      const defaultConfig = {
        url: 'http://localhost:3000',
        mode: 'deep',
        auth: { strategy: 'skip' },
        never_interact: ['delete account', 'cancel subscription'],
        scope: { include: ['/**'], exclude: [], max_routes: 30 },
        browser: { headed: true, slowMo: 40 },
      }
      await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8')
      logger.success('    Created vibe.config.json')
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
    logger.dim('  2. Edit vibe.config.json to set your app URL')
    logger.dim('  3. Open your editor and ask:')
    console.log('')
    console.log('     "Scan this codebase and test it against <your-url>."')
    console.log('')
    logger.dim('  Your editor will discover vibe-test tools automatically.')
    if (!opts.global) {
      logger.dim('  Tip: run with --global to also register in your user-level editor configs.')
    }
    console.log('')
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
