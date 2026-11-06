import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VibeTester } from '../src/engine/index.js'
import type { TestScenario } from '../src/types/index.js'

const { execute, crawl } = vi.hoisted(() => ({ execute: vi.fn(), crawl: vi.fn() }))
vi.mock('../src/engine/browser/index.js', () => ({ executeScenarios: execute }))
vi.mock('../src/engine/browser/live-routes.js', () => ({ crawlLiveRoutes: crawl }))
vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof import('child_process')>(), exec: vi.fn() }))

const dirs: string[] = []
afterEach(async () => {
  execute.mockReset()
  crawl.mockReset()
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

const smoke = (route: string): TestScenario => ({
  id: route, name: `Live page health: ${route}`, route, route_origin: 'live-crawl', priority: 'medium', expected_outcome: '', is_gap: true, generated_by: 'heuristic',
  steps: [{ action: 'navigate', url: route, description: '' }, { action: 'assert', description: '' }],
})

beforeEach(() => {
  execute.mockImplementation(async (scenarios: TestScenario[]) => ({
    results: scenarios.map(scenario => ({ scenario, status: 'pass', duration_ms: 1, step_logs: [] })),
    explorations: [],
    retry_findings: [],
  }))
})

async function emptyProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-plan-'))
  dirs.push(dir)
  return dir
}

describe('run(): plan and scope', () => {
  it('scope include/exclude applies to crawled pages, and the plan is in the summary', async () => {
    const dir = await emptyProject()
    crawl.mockResolvedValue({
      status: 'completed',
      routes: ['/', '/admin/users', '/products'].map(p => ({ path: p, type: 'page', requires_auth: false, dynamic_segments: [], origin: 'live-crawl' })),
      scenarios: ['/', '/admin/users', '/products'].map(smoke),
      attemptedPaths: ['/'],
    })
    const result = await new VibeTester({ url: 'http://x.test', codebase_path: dir, mode: 'fast', browser: { headed: false }, scope: { exclude: ['/admin/**'] } }).run()
    const ran = (execute.mock.calls[0][0] as TestScenario[]).map(s => s.route)
    expect(ran).toEqual(['/', '/products'])
    expect(result.summary.plan).toMatchObject({ mode: 'fast', basis: 'every page' })
    expect(result.summary.plan?.notes.join(' ')).toMatch(/fast mode/)
    await expect(fs.readFile(path.join(dir, '.vibe', 'baseline.json'), 'utf8')).resolves.toContain('"mode": "fast"')
  })

  it('mode changed with nothing changed runs nothing and says so', async () => {
    const dir = await emptyProject()
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15' } }))
    await fs.mkdir(path.join(dir, 'app', 'about'), { recursive: true })
    await fs.writeFile(path.join(dir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <h1>About our application</h1> }')
    execFileSync('git', ['-C', dir, 'init', '-q'])
    execFileSync('git', ['-C', dir, 'add', '-A'])
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
    const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    crawl.mockResolvedValue({ status: 'unavailable', routes: [], scenarios: [], attemptedPaths: ['/'] })

    const result = await new VibeTester({ url: 'http://x.test', codebase_path: dir, mode: 'changed', browser: { headed: false }, scope: { since: head } }).run()
    expect(execute).not.toHaveBeenCalled()
    expect(result.summary.total).toBe(0)
    expect(result.summary.plan).toMatchObject({ mode: 'changed', basis: 'code changes', counts: { skipped: 1 } })
    expect(result.summary.plan?.pages).toEqual([{ route: '/about', depth: 'skipped', reason: 'unchanged (mode changed)' }])
    expect(result.summary.plan?.notes.join(' ')).toMatch(/nothing to test/)
  })
})
