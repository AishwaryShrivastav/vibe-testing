import { Framework } from '../../types/index.js'
import { readJSON, fileExists, glob } from '../../utils/file.js'
import fs from 'fs/promises'
import path from 'path'

// ─── Monorepo detection ───────────────────────────────────────────────────────

export async function detectMonorepo(codebasePath: string): Promise<boolean> {
  const indicators = [
    path.join(codebasePath, 'pnpm-workspace.yaml'),
    path.join(codebasePath, 'lerna.json'),
    path.join(codebasePath, 'turbo.json'),
  ]
  for (const f of indicators) {
    if (await fileExists(f)) return true
  }
  const pkg = await readJSON<{ workspaces?: unknown }>(path.join(codebasePath, 'package.json'))
  return !!pkg?.workspaces
}

/**
 * Given a monorepo root, find the frontend app directory.
 * Scores packages by frontend-indicating dependencies (react > next > vue > vite),
 * penalises backend-only packages (express, fastify).
 */
export async function findFrontendApp(codebasePath: string): Promise<string | null> {
  for (const searchDir of ['apps', 'packages']) {
    const dir = path.join(codebasePath, searchDir)
    let entries: string[]
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true }))
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch { continue }

    const candidates: Array<{ dir: string; score: number }> = []
    for (const entry of entries) {
      const pkgDir = path.join(dir, entry)
      const pkg = await readJSON<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
        path.join(pkgDir, 'package.json')
      )
      if (!pkg) continue
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      let score = 0
      if (deps['next']) score += 5
      if (deps['react']) score += 3
      if (deps['vue']) score += 3
      if (deps['vite'] || deps['@vitejs/plugin-react']) score += 2
      if (deps['react-router-dom'] || deps['react-router']) score += 2
      if (deps['@sveltejs/kit']) score += 4
      if (deps['nuxt']) score += 4
      if (deps['express'] || deps['fastify']) score -= 5
      if (score > 0) candidates.push({ dir: pkgDir, score })
    }

    candidates.sort((a, b) => b.score - a.score)
    if (candidates.length > 0) return candidates[0].dir
  }
  return null
}

// ─── Port auto-detection ──────────────────────────────────────────────────────

/**
 * Detect the base URL for the dev server by checking (in order):
 *   1. .env.local / .env.development / .env — PORT= variable
 *   2. vite.config.{ts,js,mts} — port: <number>
 *   3. Framework defaults (Next.js: 3000, SvelteKit: 5173, Nuxt: 3000, Vite: 5173)
 */
export async function detectBaseUrl(codebasePath: string, framework: Framework): Promise<string> {
  // 1. .env files
  for (const envFile of ['.env.local', '.env.development', '.env']) {
    const envPath = path.join(codebasePath, envFile)
    try {
      const content = await fs.readFile(envPath, 'utf-8')
      const match = content.match(/^PORT\s*=\s*(\d+)/m)
      if (match) return `http://localhost:${match[1]}`
    } catch { /* file doesn't exist */ }
  }

  // 2. Vite config
  for (const viteFile of ['vite.config.ts', 'vite.config.js', 'vite.config.mts']) {
    const vitePath = path.join(codebasePath, viteFile)
    try {
      const content = await fs.readFile(vitePath, 'utf-8')
      const match = content.match(/port\s*:\s*(\d+)/)
      if (match) return `http://localhost:${match[1]}`
    } catch { /* file doesn't exist */ }
  }

  // 3. Framework defaults
  const portMap: Partial<Record<Framework, number>> = {
    'nextjs-app': 3000,
    'nextjs-pages': 3000,
    'sveltekit': 5173,
    'nuxt': 3000,
    'vue-spa': 5173,
    'react-spa': 5173,
    'express': 3000,
  }
  return `http://localhost:${portMap[framework] ?? 3000}`
}

// ─── Framework detection ──────────────────────────────────────────────────────

export async function detectFramework(codebasePath: string): Promise<Framework> {
  const pkg = await readJSON<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    path.join(codebasePath, 'package.json')
  )

  if (!pkg) return 'unknown'

  const deps = { ...pkg.dependencies, ...pkg.devDependencies }

  if (deps['next']) {
    // Check src/app and src/pages variants used in many Next.js setups
    const appPages = await glob('app/**/page.{tsx,jsx,ts,js}', codebasePath)
    const srcAppPages = await glob('src/app/**/page.{tsx,jsx,ts,js}', codebasePath)
    if (appPages.length > 0 || srcAppPages.length > 0) return 'nextjs-app'

    const pagesDir = (await fileExists(path.join(codebasePath, 'pages'))) ||
                     (await fileExists(path.join(codebasePath, 'src', 'pages')))
    if (pagesDir) return 'nextjs-pages'

    return 'nextjs-app'
  }

  if (deps['@sveltejs/kit']) return 'sveltekit'

  if (deps['nuxt'] || deps['nuxt3'] || deps['@nuxt/core']) return 'nuxt'

  if (deps['vue'] && (deps['vue-router'] || deps['@vue/router'])) return 'vue-spa'

  if (deps['react'] && (deps['react-router-dom'] || deps['react-router'])) {
    return 'react-spa'
  }

  if (deps['react']) return 'react-spa'

  if (deps['fastify']) return 'express' // treat fastify like express for route extraction
  if (deps['express']) return 'express'

  return 'unknown'
}
