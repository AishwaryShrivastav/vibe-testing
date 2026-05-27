import { describe, it, expect, beforeEach } from 'vitest'
import { saveRouteManifest, saveRunSnapshot } from '../src/engine/memory/manifest.js'
import type { Route, TestResult, TestScenario } from '../src/types/index.js'
import path from 'path'
import os from 'os'
import fs from 'fs/promises'

async function tmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `vibe-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true })
}

const mockRoutes: Route[] = [
  { path: '/', type: 'page', requires_auth: false, dynamic_segments: [] },
  { path: '/login', type: 'page', requires_auth: false, dynamic_segments: [] },
  { path: '/dashboard', type: 'page', requires_auth: true, dynamic_segments: [] },
]

function mockResult(route: string, status: 'pass' | 'fail' | 'error'): TestResult {
  const scenario: TestScenario = {
    id: `test-${route}`,
    name: `Test ${route}`,
    route,
    priority: 'high',
    steps: [],
    expected_outcome: 'success',
    is_gap: false,
    generated_by: 'heuristic',
  }
  return {
    scenario,
    status,
    duration_ms: 100,
    step_logs: [],
  }
}

// ─── Route Manifest Tests ────────────────────────────────────────────────────

describe('saveRouteManifest', () => {
  it('returns null on first run (no previous manifest)', async () => {
    const dir = await tmpDir()
    const diff = await saveRouteManifest(dir, mockRoutes, 'nextjs-app')
    expect(diff).toBeNull()
    // But manifest file should be created
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'route-manifest.json'), 'utf-8'))
    expect(manifest.routes.length).toBe(3)
    expect(manifest.framework).toBe('nextjs-app')
    await cleanup(dir)
  })

  it('detects new routes on second run', async () => {
    const dir = await tmpDir()
    await saveRouteManifest(dir, mockRoutes, 'nextjs-app')

    const newRoutes = [...mockRoutes, { path: '/settings', type: 'page' as const, requires_auth: true, dynamic_segments: [] }]
    const diff = await saveRouteManifest(dir, newRoutes, 'nextjs-app')

    expect(diff).not.toBeNull()
    expect(diff!.total_new).toBe(1)
    expect(diff!.new_routes).toContain('/settings')
    expect(diff!.total_removed).toBe(0)
    await cleanup(dir)
  })

  it('detects removed routes', async () => {
    const dir = await tmpDir()
    await saveRouteManifest(dir, mockRoutes, 'nextjs-app')

    const fewerRoutes = mockRoutes.filter(r => r.path !== '/dashboard')
    const diff = await saveRouteManifest(dir, fewerRoutes, 'nextjs-app')

    expect(diff).not.toBeNull()
    expect(diff!.total_removed).toBe(1)
    expect(diff!.removed_routes).toContain('/dashboard')
    await cleanup(dir)
  })

  it('returns null when routes are unchanged', async () => {
    const dir = await tmpDir()
    await saveRouteManifest(dir, mockRoutes, 'nextjs-app')
    const diff = await saveRouteManifest(dir, mockRoutes, 'nextjs-app')
    expect(diff).toBeNull()
    await cleanup(dir)
  })
})

// ─── Run Snapshot Tests ──────────────────────────────────────────────────────

describe('saveRunSnapshot', () => {
  it('returns null on first run (no previous snapshot)', async () => {
    const dir = await tmpDir()
    const results = [mockResult('/', 'pass'), mockResult('/login', 'pass')]
    const diff = await saveRunSnapshot(dir, results)
    expect(diff).toBeNull()

    const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'run-snapshot.json'), 'utf-8'))
    expect(snapshot.passed).toBe(2)
    expect(snapshot.routes['/']).toBe('pass')
    await cleanup(dir)
  })

  it('detects regression (pass to fail)', async () => {
    const dir = await tmpDir()
    await saveRunSnapshot(dir, [mockResult('/', 'pass'), mockResult('/login', 'pass')])

    const diff = await saveRunSnapshot(dir, [mockResult('/', 'pass'), mockResult('/login', 'fail')])

    expect(diff).not.toBeNull()
    expect(diff!.newly_failing).toContain('/login')
    expect(diff!.newly_passing).toHaveLength(0)
    await cleanup(dir)
  })

  it('detects fix (fail to pass)', async () => {
    const dir = await tmpDir()
    await saveRunSnapshot(dir, [mockResult('/', 'fail'), mockResult('/login', 'pass')])

    const diff = await saveRunSnapshot(dir, [mockResult('/', 'pass'), mockResult('/login', 'pass')])

    expect(diff).not.toBeNull()
    expect(diff!.newly_passing).toContain('/')
    expect(diff!.newly_failing).toHaveLength(0)
    await cleanup(dir)
  })

  it('detects new routes in results', async () => {
    const dir = await tmpDir()
    await saveRunSnapshot(dir, [mockResult('/', 'pass')])

    const diff = await saveRunSnapshot(dir, [mockResult('/', 'pass'), mockResult('/new-page', 'pass')])

    expect(diff).not.toBeNull()
    expect(diff!.new_routes).toContain('/new-page')
    await cleanup(dir)
  })

  it('returns null when results are unchanged', async () => {
    const dir = await tmpDir()
    const results = [mockResult('/', 'pass'), mockResult('/login', 'fail')]
    await saveRunSnapshot(dir, results)
    const diff = await saveRunSnapshot(dir, results)
    // still_failing exists but no changes in pass/fail direction or routes
    expect(diff).toBeNull()
    await cleanup(dir)
  })

  it('keeps worst status per route when multiple scenarios', async () => {
    const dir = await tmpDir()
    const results = [
      mockResult('/dashboard', 'pass'),
      mockResult('/dashboard', 'fail'),
      mockResult('/dashboard', 'pass'),
    ]
    await saveRunSnapshot(dir, results)

    const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'run-snapshot.json'), 'utf-8'))
    expect(snapshot.routes['/dashboard']).toBe('fail')
    await cleanup(dir)
  })
})
