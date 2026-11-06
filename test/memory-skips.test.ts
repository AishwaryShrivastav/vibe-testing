import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryManager, migrateIntel, type ProjectIntel } from '../src/engine/memory/index.js'
import type { TestResult } from '../src/types/index.js'

const errored = (route: string): TestResult => ({
  scenario: { id: route, name: `${route} page loads`, route, priority: 'medium', steps: [], expected_outcome: '', is_gap: true, generated_by: 'heuristic' },
  status: 'error', duration_ms: 10, step_logs: [], failure_reason: 'boom',
})

describe('memory never skips a route because it errored before', () => {
  it('keeps retesting a route that errored on every run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-mem-'))
    try {
      for (let run = 0; run < 4; run++) {
        const memory = new MemoryManager(root)
        await memory.load()
        await memory.updateFromResults([errored('/dashboard')])
      }
      const memory = new MemoryManager(root)
      await memory.load()
      expect([...memory.getRecommendations().skip_routes]).not.toContain('/dashboard')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('discards pre-v2 guesses: error-based skips and guessed sign-in flags', () => {
    const route = (needs_auth: boolean, needs_url_params = false) => ({ needs_auth, needs_url_params } as ProjectIntel['routes'][string])
    const old = {
      version: 1, auth: null, credentials: null, avg_scenario_ms: 0, run_history: [], global_selectors: {},
      routes: { '/dashboard': route(true), '/tutorial': route(true), '/users/:id': route(false, true) },
      known_skip_routes: ['/dashboard', '/users/:id'],
    } as unknown as ProjectIntel
    const migrated = migrateIntel(old)
    expect(migrated.version).toBe(2)
    expect(migrated.known_skip_routes).toEqual(['/users/:id'])
    expect(Object.values(migrated.routes).every(r => !r.needs_auth)).toBe(true)
    expect(migrateIntel(migrated)).toBe(migrated)
  })
})
