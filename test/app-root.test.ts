import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveAppRoot } from '../src/engine/context/detector.js'
import { buildProductModel } from '../src/engine/context/index.js'
import { VibeConfigSchema } from '../src/types/config.js'

const dirs: string[] = []

async function project(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-approot-'))
  dirs.push(dir)
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(dir, file)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, content)
  }
  return dir
}

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: 'x', dependencies: deps, ...extra })

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('resolveAppRoot: find the web app in a subfolder', () => {
  it('finds a Next.js app inside a Maven project', async () => {
    const root = await project({
      'pom.xml': '<project/>',
      'auth/pom.xml': '<project/>',
      'assets/package.json': pkg({ next: '15.0.0', react: '19.0.0' }),
      'assets/src/app/page.tsx': 'export default function Home() { return null }',
      'assets/src/app/admin/page.tsx': 'export default function Admin() { return null }',
      'assets/src/app/api/room/route.ts': 'export async function GET() {}',
      // Tooling and tests must not win over the app.
      'end-to-end-tests/package.json': pkg({ playwright: '1.0.0' }),
      '.utilities/monitor/package.json': pkg({ express: '4.0.0' }),
    })
    expect(await resolveAppRoot(root)).toBe(path.join(root, 'assets'))
  })

  it('keeps the root when the root is the app', async () => {
    const root = await project({
      'package.json': pkg({ react: '18.0.0' }),
      'client/package.json': pkg({ next: '15.0.0', react: '19.0.0' }),
    })
    expect(await resolveAppRoot(root)).toBe(root)
  })

  it('prefers the frontend over a server package and ignores node_modules', async () => {
    const root = await project({
      'README.md': '# mixed repo',
      'server/package.json': pkg({ express: '4.0.0' }),
      'web/package.json': pkg({ react: '18.0.0', vite: '5.0.0' }),
      'node_modules/fake/package.json': pkg({ next: '15.0.0', react: '19.0.0' }),
    })
    expect(await resolveAppRoot(root)).toBe(path.join(root, 'web'))
  })

  it('falls back to a server-only subfolder, then to the root', async () => {
    const withServer = await project({ 'go.mod': 'module x', 'api/package.json': pkg({ express: '4.0.0' }) })
    expect(await resolveAppRoot(withServer)).toBe(path.join(withServer, 'api'))
    const nothing = await project({ 'go.mod': 'module x', 'cmd/main.go': 'package main' })
    expect(await resolveAppRoot(nothing)).toBe(nothing)
  })

  it('uses workspace apps/ in a monorepo', async () => {
    const root = await project({
      'package.json': pkg({}, { workspaces: ['apps/*'] }),
      'apps/web/package.json': pkg({ next: '15.0.0', react: '19.0.0' }),
      'apps/api/package.json': pkg({ express: '4.0.0' }),
    })
    expect(await resolveAppRoot(root)).toBe(path.join(root, 'apps/web'))
  })

  it('builds the product model from the nested app', async () => {
    const root = await project({
      'pom.xml': '<project/>',
      'assets/package.json': pkg({ next: '15.0.0', react: '19.0.0' }),
      'assets/src/app/page.tsx': 'export default function Home() { return null }',
      'assets/src/app/admin/rooms/page.tsx': 'export default function Rooms() { return null }',
    })
    const config = VibeConfigSchema.parse({ url: 'http://localhost:3000', codebase_path: root, mode: 'fast' })
    const model = await buildProductModel(config, { project: 'x', last_run: '', run_count: 0, known_bugs: [], flaky_flows: [], verified_flows: [] })
    expect(model.framework).toBe('nextjs-app')
    expect(model.routes.filter(r => r.type === 'page').map(r => r.path).sort()).toEqual(['/', '/admin/rooms'])
    // Run state stays at the project root.
    expect(await fs.stat(path.join(root, '.vibe')).then(() => true, () => false)).toBe(true)
  })
})
