import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { VibeTester } from '../src/engine/index.js'
import { runConverge } from '../src/engine/converge.js'
import { VibeConfigSchema } from '../src/types/config.js'
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
beforeEach(() => {
  crawl.mockResolvedValue({ status: 'unavailable', routes: [], scenarios: [], attemptedPaths: ['/'], reason: 'fixture unavailable' })
})
async function project(withRoute = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-empty-'))
  dirs.push(dir)
  if (withRoute) {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { next: '15' } }))
    await fs.mkdir(path.join(dir, 'app', 'about'), { recursive: true })
    await fs.writeFile(path.join(dir, 'app', 'about', 'page.tsx'), 'export default function Page() { return <h1>About our application</h1> }')
  }
  return VibeConfigSchema.parse({ url: 'http://example.test', codebase_path: dir, browser: { headed: false }, mode: 'fast' })
}

describe('empty runs cannot succeed', () => {
  it('run returns a structured diagnostic report for empty discovery', async () => {
    const config = await project()
    const result = await new VibeTester(config).run()
    expect(result.diagnostic).toMatchObject({
      outcome: 'no-safe-scenarios',
      framework: 'unknown',
      static_route_count: 0,
      crawl: { status: 'unavailable' },
    })
    expect(result.diagnostic?.next_action).toMatch(/start|url|route/i)
    await expect(fs.readFile(result.report_path, 'utf8')).resolves.toContain('no-safe-scenarios')
    expect(execute).not.toHaveBeenCalled()
  })
  it('converge still rejects empty discovery', async () => {
    const config = await project()
    await expect(new VibeTester(config).converge()).rejects.toThrow(/no.*scenarios/i)
    expect(execute).not.toHaveBeenCalled()
  })
  it.each(['run', 'converge'] as const)('%s rejects an empty executed batch before saving history', async method => {
    const config = await project(true)
    execute.mockResolvedValue({ results: [], explorations: [] })
    await expect(new VibeTester(config)[method]()).rejects.toThrow(/no.*executed|empty.*execution/i)
    await expect(fs.access(path.join(config.codebase_path!, '.vibe', 'run-snapshot.json'))).rejects.toThrow()
  })
  it('converge rejects an empty follow-up instead of treating it as a 100% pass', async () => {
    const config = await project(true)
    execute.mockImplementationOnce(async (scenarios: TestScenario[]) => ({
      results: [{ scenario: scenarios[0], status: 'fail', duration_ms: 0, step_logs: [], failure_reason: 'fixture failure' }], explorations: [],
    })).mockResolvedValue({ results: [], explorations: [] })
    await expect(runConverge(config)).rejects.toThrow(/no.*executed|empty.*execution/i)
  })
  it('CLI run exits nonzero with a diagnostic and no stack trace on empty discovery', async () => {
    const config = await project()
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, 'run', config.url, '--codebase', config.codebase_path!, '--no-headed'], { cwd: config.codebase_path, encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/no safe scenarios|next action/i)
    expect(result.stdout + result.stderr).not.toContain(' at ')
  })
})
