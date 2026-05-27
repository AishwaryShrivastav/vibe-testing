import { describe, it, expect } from 'vitest'
import { parseRoutes } from '../src/engine/context/router.js'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'

async function withTempProject(files: Record<string, string>): Promise<string> {
  const dir = path.join(os.tmpdir(), `vibe-test-router-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
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

// ─── Next.js App Router ──────────────────────────────────────────────────────

describe('parseRoutes - nextjs-app', () => {
  it('finds pages in app/ directory', async () => {
    const dir = await withTempProject({
      'app/page.tsx': 'export default function Home() {}',
      'app/about/page.tsx': 'export default function About() {}',
      'app/blog/[slug]/page.tsx': 'export default function Post() {}',
    })
    const routes = await parseRoutes('nextjs-app', dir)
    const paths = routes.map(r => r.path).sort()
    expect(paths).toContain('/')
    expect(paths).toContain('/about')
    expect(paths).toContain('/blog/[slug]')
    await cleanup(dir)
  })

  it('finds pages in src/app/ directory', async () => {
    const dir = await withTempProject({
      'src/app/page.tsx': 'export default function Home() {}',
      'src/app/dashboard/page.tsx': 'export default function Dashboard() {}',
    })
    const routes = await parseRoutes('nextjs-app', dir)
    const paths = routes.map(r => r.path).sort()
    expect(paths).toContain('/')
    expect(paths).toContain('/dashboard')
    await cleanup(dir)
  })

  it('finds API routes', async () => {
    const dir = await withTempProject({
      'app/page.tsx': 'export default function Home() {}',
      'app/api/users/route.ts': 'export async function GET() {} export async function POST() {}',
    })
    const routes = await parseRoutes('nextjs-app', dir)
    const apis = routes.filter(r => r.type === 'api')
    expect(apis.length).toBeGreaterThanOrEqual(1)
    expect(apis.some(r => r.path === '/api/users')).toBe(true)
    await cleanup(dir)
  })

  it('strips route groups like (auth)', async () => {
    const dir = await withTempProject({
      'app/(auth)/login/page.tsx': 'export default function Login() {}',
      'app/(dashboard)/settings/page.tsx': 'export default function Settings() {}',
    })
    const routes = await parseRoutes('nextjs-app', dir)
    const paths = routes.map(r => r.path)
    expect(paths).toContain('/login')
    expect(paths).toContain('/settings')
    await cleanup(dir)
  })
})

// ─── SvelteKit ───────────────────────────────────────────────────────────────

describe('parseRoutes - sveltekit', () => {
  it('finds +page.svelte routes', async () => {
    const dir = await withTempProject({
      'src/routes/+page.svelte': '<h1>Home</h1>',
      'src/routes/about/+page.svelte': '<h1>About</h1>',
      'src/routes/blog/[slug]/+page.svelte': '<h1>Post</h1>',
    })
    const routes = await parseRoutes('sveltekit', dir)
    const paths = routes.map(r => r.path).sort()
    expect(paths).toContain('/')
    expect(paths).toContain('/about')
    expect(paths).toContain('/blog/[slug]')
    await cleanup(dir)
  })

  it('finds +server.ts API routes', async () => {
    const dir = await withTempProject({
      'src/routes/api/data/+server.ts': 'export async function GET() {} export async function POST() {}',
    })
    const routes = await parseRoutes('sveltekit', dir)
    const apis = routes.filter(r => r.type === 'api')
    expect(apis.length).toBeGreaterThanOrEqual(1)
    expect(apis.some(r => r.path === '/api/data')).toBe(true)
    await cleanup(dir)
  })
})

// ─── Nuxt ────────────────────────────────────────────────────────────────────

describe('parseRoutes - nuxt', () => {
  it('finds pages/*.vue routes', async () => {
    const dir = await withTempProject({
      'pages/index.vue': '<template><h1>Home</h1></template>',
      'pages/about.vue': '<template><h1>About</h1></template>',
      'pages/users/[id].vue': '<template><h1>User</h1></template>',
    })
    const routes = await parseRoutes('nuxt', dir)
    const paths = routes.map(r => r.path).sort()
    expect(paths).toContain('/')
    expect(paths).toContain('/about')
    expect(paths).toContain('/users/[id]')
    await cleanup(dir)
  })

  it('finds server/api routes', async () => {
    const dir = await withTempProject({
      'server/api/hello.ts': 'export default defineEventHandler(() => "hello")',
    })
    const routes = await parseRoutes('nuxt', dir)
    const apis = routes.filter(r => r.type === 'api')
    expect(apis.some(r => r.path === '/api/hello')).toBe(true)
    await cleanup(dir)
  })
})

// ─── Vue SPA ─────────────────────────────────────────────────────────────────

describe('parseRoutes - vue-spa', () => {
  it('finds routes from src/router/index.ts', async () => {
    const dir = await withTempProject({
      'src/router/index.ts': `
        import { createRouter } from 'vue-router'
        const routes = [
          { path: '/', component: Home },
          { path: '/about', component: About },
          { path: '/users/:id', component: UserProfile },
        ]
      `,
    })
    const routes = await parseRoutes('vue-spa', dir)
    const paths = routes.map(r => r.path)
    expect(paths).toContain('/')
    expect(paths).toContain('/about')
    expect(paths).toContain('/users/:id')
    await cleanup(dir)
  })
})

// ─── React SPA ───────────────────────────────────────────────────────────────

describe('parseRoutes - react-spa', () => {
  it('finds routes from src/App.tsx', async () => {
    const dir = await withTempProject({
      'src/App.tsx': `
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
      `,
    })
    const routes = await parseRoutes('react-spa', dir)
    const paths = routes.map(r => r.path)
    expect(paths).toContain('/login')
    expect(paths).toContain('/dashboard')
    expect(paths).toContain('/settings')
    await cleanup(dir)
  })
})

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('parseRoutes - edge cases', () => {
  it('returns empty array for unknown framework', async () => {
    const routes = await parseRoutes('unknown', '/tmp')
    expect(routes).toEqual([])
  })

  it('returns empty array for empty directory', async () => {
    const dir = await withTempProject({})
    const routes = await parseRoutes('nextjs-app', dir)
    expect(routes).toEqual([])
    await cleanup(dir)
  })
})
