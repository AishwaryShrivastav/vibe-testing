import { describe, it, expect, vi } from 'vitest'
import { detectFramework, detectBaseUrl, detectMonorepo } from '../src/engine/context/detector.js'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'

// Helper: create a temp directory with a package.json
async function withTempProject(deps: Record<string, string>, files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(os.tmpdir(), `vibe-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'test-project',
    dependencies: deps,
  }))
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(dir, filePath)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  return dir
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true })
}

// ─── Framework Detection ─────────────────────────────────────────────────────

describe('detectFramework', () => {
  it('detects Next.js App Router with app/ directory', async () => {
    const dir = await withTempProject({ next: '^14.0.0' }, {
      'app/page.tsx': 'export default function Home() {}',
    })
    expect(await detectFramework(dir)).toBe('nextjs-app')
    await cleanup(dir)
  })

  it('detects Next.js App Router with src/app/ directory', async () => {
    const dir = await withTempProject({ next: '^14.0.0' }, {
      'src/app/page.tsx': 'export default function Home() {}',
    })
    expect(await detectFramework(dir)).toBe('nextjs-app')
    await cleanup(dir)
  })

  it('detects Next.js Pages Router', async () => {
    const dir = await withTempProject({ next: '^14.0.0' }, {
      'pages/index.tsx': 'export default function Home() {}',
    })
    // Need to create the pages directory for fileExists check
    expect(await detectFramework(dir)).toBe('nextjs-pages')
    await cleanup(dir)
  })

  it('detects SvelteKit', async () => {
    const dir = await withTempProject({ '@sveltejs/kit': '^2.0.0' })
    expect(await detectFramework(dir)).toBe('sveltekit')
    await cleanup(dir)
  })

  it('detects Nuxt', async () => {
    const dir = await withTempProject({ nuxt: '^3.0.0' })
    expect(await detectFramework(dir)).toBe('nuxt')
    await cleanup(dir)
  })

  it('detects Vue + Vite with vue-router', async () => {
    const dir = await withTempProject({ vue: '^3.0.0', 'vue-router': '^4.0.0' })
    expect(await detectFramework(dir)).toBe('vue-spa')
    await cleanup(dir)
  })

  it('detects React SPA with react-router', async () => {
    const dir = await withTempProject({ react: '^18.0.0', 'react-router-dom': '^6.0.0' })
    expect(await detectFramework(dir)).toBe('react-spa')
    await cleanup(dir)
  })

  it('detects Express', async () => {
    const dir = await withTempProject({ express: '^4.0.0' })
    expect(await detectFramework(dir)).toBe('express')
    await cleanup(dir)
  })

  it('detects Fastify as express', async () => {
    const dir = await withTempProject({ fastify: '^4.0.0' })
    expect(await detectFramework(dir)).toBe('express')
    await cleanup(dir)
  })

  it('returns unknown for empty project', async () => {
    const dir = await withTempProject({})
    expect(await detectFramework(dir)).toBe('unknown')
    await cleanup(dir)
  })

  it('returns unknown when no package.json exists', async () => {
    const dir = path.join(os.tmpdir(), `vibe-test-empty-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    expect(await detectFramework(dir)).toBe('unknown')
    await cleanup(dir)
  })

  // Priority: Nuxt over standalone Vue
  it('prefers Nuxt over Vue when both present', async () => {
    const dir = await withTempProject({ vue: '^3.0.0', nuxt: '^3.0.0', 'vue-router': '^4.0.0' })
    expect(await detectFramework(dir)).toBe('nuxt')
    await cleanup(dir)
  })
})

// ─── Base URL Detection ──────────────────────────────────────────────────────

describe('detectBaseUrl', () => {
  it('returns framework default port when no config found', async () => {
    const dir = await withTempProject({})
    expect(await detectBaseUrl(dir, 'nextjs-app')).toBe('http://localhost:3000')
    expect(await detectBaseUrl(dir, 'react-spa')).toBe('http://localhost:5173')
    expect(await detectBaseUrl(dir, 'sveltekit')).toBe('http://localhost:5173')
    expect(await detectBaseUrl(dir, 'nuxt')).toBe('http://localhost:3000')
    expect(await detectBaseUrl(dir, 'vue-spa')).toBe('http://localhost:5173')
    await cleanup(dir)
  })

  it('reads PORT from .env file', async () => {
    const dir = await withTempProject({}, {
      '.env': 'PORT=4000',
    })
    expect(await detectBaseUrl(dir, 'nextjs-app')).toBe('http://localhost:4000')
    await cleanup(dir)
  })

  it('reads port from vite.config.ts', async () => {
    const dir = await withTempProject({}, {
      'vite.config.ts': 'export default { server: { port: 8080 } }',
    })
    expect(await detectBaseUrl(dir, 'react-spa')).toBe('http://localhost:8080')
    await cleanup(dir)
  })
})

// ─── Monorepo Detection ──────────────────────────────────────────────────────

describe('detectMonorepo', () => {
  it('detects pnpm workspaces', async () => {
    const dir = await withTempProject({}, {
      'pnpm-workspace.yaml': 'packages:\n  - apps/*',
    })
    expect(await detectMonorepo(dir)).toBe(true)
    await cleanup(dir)
  })

  it('detects turbo.json', async () => {
    const dir = await withTempProject({}, {
      'turbo.json': '{}',
    })
    expect(await detectMonorepo(dir)).toBe(true)
    await cleanup(dir)
  })

  it('detects yarn workspaces in package.json', async () => {
    const dir = path.join(os.tmpdir(), `vibe-test-mono-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      name: 'monorepo',
      workspaces: ['apps/*'],
    }))
    expect(await detectMonorepo(dir)).toBe(true)
    await cleanup(dir)
  })

  it('returns false for regular project', async () => {
    const dir = await withTempProject({ react: '^18.0.0' })
    expect(await detectMonorepo(dir)).toBe(false)
    await cleanup(dir)
  })
})
