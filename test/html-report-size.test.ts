import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateHtmlReport } from '../src/engine/reporter/html.js'
import { fullImageHref } from '../src/engine/reporter/images.js'
import type { PageExploration } from '../src/engine/browser/explorer.js'
import type { ProductModel, TestResult, TestScenario } from '../src/types/index.js'
import { VibeConfigSchema } from '../src/types/config.js'

const config = VibeConfigSchema.parse({ url: 'http://localhost:3000' })
const productModel: ProductModel = {
  project_name: 'demo', url: 'http://localhost:3000', framework: 'react-spa', codebase_path: '/tmp/vibe-demo',
  scanned_at: '2026-01-01T00:00:00.000Z', routes: [], behaviours: [], coverage: {}, gaps: [], scenarios: [],
}
const scenario = (id: string, name = `Scenario ${id}`): TestScenario => ({
  id, name, route: `/${id}`, priority: 'high', steps: [{ action: 'navigate', url: `/${id}`, description: 'Open' }],
  expected_outcome: 'Loads', is_gap: false, generated_by: 'heuristic',
})
const exploration = (route: string, shot?: string): PageExploration => ({
  route, url: `http://localhost:3000${route}`, elements_discovered: 1, elements_by_type: { button: 1 },
  interactions: [], api_calls: [], errors: [], warnings: [], duration_ms: 10, screenshot_path: shot,
})

describe('HTML report: small thumbnails, linked full-size screenshots', () => {
  let dir: string
  const pageShots: string[] = []
  const stepShots: string[] = []

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-report-size-'))
    await fs.mkdir(path.join(dir, 'screenshots'))
    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    // A tall, busy page: full-page PNGs of pages like this made reports tens of MB.
    await page.setContent(`<body style="margin:0">${Array.from({ length: 60 }, (_, i) =>
      `<div style="height:60px;background:hsl(${i * 37},70%,${30 + (i % 5) * 10}%);color:#fff;font:20px sans-serif">Row ${i} ${'lorem ipsum '.repeat(12)}</div>`).join('')}</body>`)
    for (let i = 0; i < 8; i++) {
      const pageShot = path.join(dir, 'screenshots', `page-${i}.png`)
      await page.screenshot({ path: pageShot, fullPage: true })
      pageShots.push(pageShot)
      const stepShot = path.join(dir, 'screenshots', `step-${i}.png`)
      await page.screenshot({ path: stepShot })
      stepShots.push(stepShot)
    }
    await browser.close()
  }, 120000)

  afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('embeds JPEG thumbnails, links full-size files relative to the report, and stays small', async () => {
    const results: TestResult[] = pageShots.map((shot, i) => ({
      scenario: scenario(`s${i}`), status: 'pass', duration_ms: 100, screenshot_path: shot,
      step_logs: [{ step: { action: 'navigate', description: 'Open' }, status: 'ok', duration_ms: 50, url_after: 'http://localhost:3000/', screenshot_path: stepShots[i] }],
    }) as TestResult)
    const explorations = pageShots.map((shot, i) => exploration(`/p${i}`, shot))

    const originals = (await Promise.all([...pageShots, ...stepShots].map(f => fs.stat(f)))).reduce((sum, s) => sum + s.size, 0)
    const report = await generateHtmlReport(results, productModel, config, explorations, [], undefined, { reportDir: dir })
    const size = Buffer.byteLength(report)

    expect(report).toContain('src="data:image/jpeg;base64,')
    expect(report).not.toContain('data:image/png;base64,')
    expect(report).toContain('data-full="screenshots/page-0.png"')
    expect(report).toContain('href="screenshots/page-0.png"')
    expect(report).toContain('data-full="screenshots/step-0.png"')
    // 24 screenshots: the old embedded-PNG report was the sum of the originals × 4/3.
    expect(size).toBeLessThan(originals / 4)
    // This fixture is deliberately noisy (every row a different colour); real
    // app screenshots come out around 13 KB per page thumbnail and 3 KB per step.
    expect(size).toBeLessThan(1_500_000)
  }, 120000)

  it('links screenshots outside the report folder with a file:// URL', () => {
    expect(fullImageHref('/somewhere/else/shot.png', '/project/.vibe')).toBe('file:///somewhere/else/shot.png')
    expect(fullImageHref('/project/.vibe/screenshots/a b.png', '/project/.vibe')).toBe('screenshots/a%20b.png')
  })

  it('falls back to a link when a screenshot is not a readable image', async () => {
    const bad = path.join(dir, 'screenshots', 'broken.png')
    await fs.writeFile(bad, 'not an image')
    const report = await generateHtmlReport([], productModel, config, [exploration('/x', bad)], [], undefined, { reportDir: dir })
    expect(report).toContain('src="screenshots/broken.png"')
  }, 60000)
})

describe('HTML report: duration and bugs found', () => {
  const failed: TestResult = {
    scenario: scenario('logout', 'Logout ends the session <script>x</script>'), status: 'fail', duration_ms: 1500, step_logs: [],
    ai_verdict: 'Logout does not end the session:\n/products still opened without signing in <b>',
  }
  const errored: TestResult = {
    scenario: scenario('search', 'Search on /memos'), status: 'error', duration_ms: 500, step_logs: [],
    failure_reason: 'locator.fill: Timeout 15000ms exceeded.',
  }

  it('shows the whole run duration with the scenario share', async () => {
    const report = await generateHtmlReport([failed, errored], productModel, config, [], [], undefined, { durationMs: 125_000 })
    expect(report).toContain('<div class="label">Duration</div><div class="value">2m 5s</div><div class="sub">scenarios 2.0s</div>')
  })

  it('labels scenario-only time when the run duration is unknown', async () => {
    const report = await generateHtmlReport([failed, errored], productModel, config, [], [], undefined)
    expect(report).toContain('<div class="label">Scenario time</div><div class="value">2.0s</div><div class="sub">excludes exploration</div>')
  })

  it('lists failed and errored scenarios and explorer problems first, escaped, on one line each', async () => {
    const report = await generateHtmlReport([failed, errored], productModel, config,
      [{ ...exploration('/contributions'), errors: ['Server error 500 on POST /contributions: ReferenceError: abc is not defined'], changes: [{ action: 'x', method: 'POST', path: '/memos' }] as PageExploration['changes'] }],
      [], undefined, { retryFindings: ['Configured login: only succeeded on attempt 2'] })
    const top = report.slice(report.indexOf('id="bugs-found"'), report.indexOf('class="summary-groups"'))
    expect(top).toContain('Bugs Found (3)')
    expect(top).toContain('<span class="badge fail">Scenario failed</span>')
    expect(top).toContain('<span class="badge error">Scenario error</span>')
    expect(top).toContain('<strong>Logout ends the session &lt;script&gt;x&lt;/script&gt;</strong><br>Logout does not end the session: /products still opened without signing in &lt;b&gt;')
    expect(top).toContain('<span class="badge fail">Server error</span>')
    expect(top).toContain('<code>/contributions</code>')
    expect(top).toContain('Also: 1 passed only on retry &middot; 1 change made to the app (see below).')
    expect(report.indexOf('id="bugs-found"')).toBeLessThan(report.indexOf('class="summary-groups"'))
    expect(top).not.toContain('<script>x')
  })
})
