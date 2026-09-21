import fs from 'node:fs/promises'
import path from 'node:path'
import { detectAuthentication } from './engine/context/auth-detector.js'
import { detectBaseUrl, detectFramework, detectMonorepo, findFrontendApp } from './engine/context/detector.js'
import { parseRoutes } from './engine/context/router.js'
import { detectLiveServer } from './engine/context/server-detector.js'
import type { AuthDetection, Framework, ServerDetection } from './types/index.js'
import { fileExists, readJSON } from './utils/file.js'

export const DEFAULT_VIBE_GUIDANCE = `# VIBE.md — Project Testing Guidance

> Edit this file with your project's details. Vibe Test reads it automatically on every run.

## Authentication
Unknown until detected. If authentication is required, describe the test-safe sign-in method here.

## Never Automate
- delete account
- cancel subscription
- [data-testid="danger-zone"]

## Known Flaky
- /notifications (if WebSocket dependent)

## Notes
- Add any project-specific testing notes here
- Add authentication details only after confirming the app's actual sign-in flow
`

export interface ConfigureResult {
  codebase_path: string
  scan_path: string
  framework: Framework
  static_route_count: number
  server: ServerDetection & { configuredUrl: string }
  auth: AuthDetection
  config: {
    path: string
    status: 'created' | 'preserved'
  }
  files: {
    vibe_md: 'created' | 'preserved'
    gitignore: 'updated' | 'preserved'
  }
}

export async function configureProject(input: {
  codebasePath: string
  url?: string
}): Promise<ConfigureResult> {
  const codebasePath = path.resolve(input.codebasePath)
  const scanPath = await resolveScanPath(codebasePath)
  const framework = await detectFramework(scanPath)
  const routes = await parseRoutes(framework, scanPath)
  const auth = await detectAuthentication({
    codebasePath: scanPath,
    routePaths: routes.filter(route => route.type === 'page').map(route => route.path),
  })

  const configPath = path.join(codebasePath, 'vibe.config.json')
  const existingConfig = await readJSON<Record<string, unknown>>(configPath)
  const configuredUrl = typeof existingConfig?.url === 'string' ? existingConfig.url : undefined
  const inferredUrl = await detectBaseUrl(scanPath, framework)
  const requestedUrl = input.url?.trim() || undefined
  const server = await detectLiveServer({
    codebasePath: scanPath,
    explicitUrl: requestedUrl,
    configuredUrl: configuredUrl ?? inferredUrl,
  })
  const effectiveUrl = server.url ?? requestedUrl ?? configuredUrl ?? inferredUrl

  const vibeMdPath = path.join(codebasePath, 'VIBE.md')
  const vibeStatus = await writeIfMissing(vibeMdPath, DEFAULT_VIBE_GUIDANCE) ? 'created' : 'preserved'
  const gitignoreStatus = await ensureGitignoreEntry(path.join(codebasePath, '.gitignore'), '.vibe/')
    ? 'updated'
    : 'preserved'

  let configStatus: 'created' | 'preserved' = 'preserved'
  if (!await fileExists(configPath)) {
    const defaultConfig = {
      url: effectiveUrl,
      mode: 'deep',
      auth: { strategy: 'skip' },
      never_interact: ['delete account', 'cancel subscription'],
      scope: { include: ['/**'], exclude: [], max_routes: 30 },
      browser: { headed: true, slowMo: 40 },
    }
    await fs.writeFile(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf8')
    configStatus = 'created'
  }

  return {
    codebase_path: codebasePath,
    scan_path: scanPath,
    framework,
    static_route_count: routes.length,
    server: { ...server, configuredUrl: effectiveUrl },
    auth,
    config: { path: configPath, status: configStatus },
    files: { vibe_md: vibeStatus, gitignore: gitignoreStatus },
  }
}

async function resolveScanPath(codebasePath: string): Promise<string> {
  if (!await detectMonorepo(codebasePath)) return codebasePath
  return await findFrontendApp(codebasePath) ?? codebasePath
}

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf8')
  return true
}

async function ensureGitignoreEntry(filePath: string, entry: string): Promise<boolean> {
  let content = ''
  try {
    content = await fs.readFile(filePath, 'utf8')
  } catch { /* created below */ }
  if (content.split(/\r?\n/).includes(entry)) return false
  const separator = content && !content.endsWith('\n') ? '\n' : ''
  await fs.writeFile(filePath, `${content}${separator}${entry}\n`, 'utf8')
  return true
}
