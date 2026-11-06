import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { excerpt } from '../src/engine/browser/assertions.js'
import { runOneScenario } from '../src/engine/browser/runner.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestScenario } from '../src/types/index.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

const NAV = Array.from({ length: 30 }, (_, i) => `<a href="/n${i}">Navigation item number ${i}</a>`).join('<br>')

describe('excerpt (failure evidence)', () => {
  it('returns short text unchanged', () => {
    expect(excerpt('Invalid username', 'Invalid username and/or password')).toBe('Invalid username')
  })

  it('keeps lines related to the expected text when the page is long', () => {
    const text = `${'Menu entry\n'.repeat(60)}Invalid username\nFooter`
    const out = excerpt(text, 'Invalid username and/or password')
    expect(out.length).toBeLessThanOrEqual(300)
    expect(out).toContain('Invalid username')
  })
})

describe('V7: failed text assertions report what the page showed', () => {
  let fx: BrowserFixture
  let shots: string

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/login': page(`${NAV}<p class="alert">Invalid username</p>`),
      '/form': page('<form method="post" action="/form"><input name="q"><button type="submit">Save</button></form><p>Form page</p>'),
    })
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-v7-'))
  })

  afterAll(async () => {
    await fx?.close()
    await fs.rm(shots, { recursive: true, force: true })
  })

  async function run(scenario: TestScenario) {
    const ctx = await fx.browser.newContext()
    try {
      const config = VibeConfigSchema.parse({ url: fx.baseUrl, browser: { headed: false, slowMo: 0 } })
      return await runOneScenario(scenario, ctx, config, shots, shots)
    } finally {
      await ctx.close()
    }
  }

  const scenario = (id: string, steps: TestScenario['steps'], route: string): TestScenario => ({
    id, name: id, route, priority: 'high', steps, expected_outcome: 'x', is_gap: true, generated_by: 'heuristic',
  })

  it('always includes the received text, even with tiny timeouts (was intermittently "Timeout 1ms exceeded")', async () => {
    for (const timeout of [1, 5, 20, 50, 100, 1, 5, 20, 50, 100]) {
      const result = await run(scenario(`v7-${timeout}`, [
        { action: 'navigate', url: '/login', description: 'Open' },
        { action: 'assert', value: 'Invalid username and/or password', timeout, description: 'Generic error' },
      ], '/login'))
      expect(result.status).toBe('fail')
      expect(result.failure_reason).toMatch(/Expected body to contain "Invalid username and\/or password"; received ".*Invalid username/s)
      expect(result.failure_reason).not.toMatch(/Timeout \d+ms exceeded/)
    }
  }, 120_000)

  it('does not stall on a same-page form submit that calls no /api endpoint', async () => {
    const result = await run(scenario('v7-submit', [
      { action: 'navigate', url: '/form', description: 'Open' },
      { action: 'fill', selector: '[name=q]', value: 'x', description: 'Fill' },
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit' },
      { action: 'assert', value: 'Form page', description: 'Still on the form page' },
    ], '/form'))
    expect(result.status).toBe('pass')
    const submit = result.step_logs.find(log => log.step.action === 'click')!
    expect(submit.duration_ms).toBeLessThan(4000) // was ~8s waiting for an /api response
  }, 60_000)
})
