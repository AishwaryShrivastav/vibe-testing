#!/usr/bin/env node
import { Command } from 'commander'
import { VibeTester } from './engine/index.js'
import { readJSON, fileExists } from './utils/file.js'
import type { VibeConfig } from './types/config.js'
import { logger } from './utils/logger.js'
import path from 'path'
import fs from 'fs/promises'

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
  .description('Create a vibe.config.json in the current directory')
  .action(async () => {
    const configPath = path.join(process.cwd(), 'vibe.config.json')

    if (await fileExists(configPath)) {
      logger.warn('vibe.config.json already exists')
      return
    }

    const defaultConfig = {
      url: 'http://localhost:3000',
      mode: 'deep',
      auth: {
        strategy: 'skip',
      },
      scope: {
        include: ['/**'],
        exclude: [],
        max_routes: 30,
      },
      browser: {
        headed: true,
        slowMo: 40,
      },
      memory: {
        verify_after_n_passes: 3,
      },
    }

    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
    logger.success('Created vibe.config.json')
    logger.dim('Edit it to set your URL, auth credentials, and scope.')
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
