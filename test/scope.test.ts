import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { buildProductModel, MemoryManager } from '../src/engine/index.js'
import { VibeConfigSchema } from '../src/types/config.js'

const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }) })

async function routesInScope(include?: string[], exclude: string[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-scope-'))
  dirs.push(dir)
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }))
  for (const route of ['', 'about', 'docs', 'docs/a', 'docs/a/b', 'docs-old', 'v1.0', 'v1x0', '[slug]']) {
    const folder = path.join(dir, 'app', route)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, 'page.tsx'), 'export default function Page() { return <h1>Welcome to the example application</h1> }')
  }
  const config = VibeConfigSchema.parse({ url: 'http://example.test', codebase_path: dir, mode: 'fast', ...(include ? { scope: { include, exclude } } : {}) })
  const model = await buildProductModel(config, new MemoryManager(dir).getMemory())
  return model.routes.map(r => r.path).sort()
}

describe('route scope through discovery', () => {
  it('default /** includes root and deeply nested routes', async () => {
    expect(await routesInScope()).toEqual(['/', '/[slug]', '/about', '/docs', '/docs-old', '/docs/a', '/docs/a/b', '/v1.0', '/v1x0'].sort())
  })
  it('single star stops at a slash', async () => {
    expect(await routesInScope(['/docs/*'])).toEqual(['/docs/a'])
  })
  it('globstar subtree includes its base and excludes unrelated prefixes', async () => {
    expect(await routesInScope(['/docs/**'])).toEqual(['/docs', '/docs/a', '/docs/a/b'])
  })
  it('exclusions take precedence and include whole subtrees', async () => {
    expect(await routesInScope(['/**'], ['/docs/**'])).toEqual(['/', '/[slug]', '/about', '/docs-old', '/v1.0', '/v1x0'].sort())
  })
  it('treats regex metacharacters literally', async () => {
    expect(await routesInScope(['/v1.0', '/[slug]'])).toEqual(['/[slug]', '/v1.0'])
  })
})
