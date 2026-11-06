import { describe, expect, it } from 'vitest'
import { generateHtmlReport } from '../src/engine/reporter/html.js'
import type { PageExploration } from '../src/engine/browser/explorer.js'
import type { ProductModel, TestScenario, TestResult } from '../src/types/index.js'
import { VibeConfigSchema } from '../src/types/config.js'

const config = VibeConfigSchema.parse({ url: 'http://localhost:3000' })

const scenario: TestScenario = {
  id: 'login',
  name: 'Login works',
  route: '/login',
  priority: 'high',
  steps: [{ action: 'navigate', url: '/login', description: 'Open login' }],
  expected_outcome: 'Signed in',
  is_gap: false,
  generated_by: 'heuristic',
}

const productModel: ProductModel = {
  project_name: 'demo',
  url: 'http://localhost:3000',
  framework: 'react-spa',
  codebase_path: '/tmp/vibe-demo',
  scanned_at: '2026-01-01T00:00:00.000Z',
  routes: [{ path: '/login', type: 'page', requires_auth: false, dynamic_segments: [] }],
  behaviours: [],
  coverage: {},
  gaps: [],
  scenarios: [scenario],
}

function exploration(route: string, errors: string[], warnings: string[] = []): PageExploration {
  return {
    route,
    url: `http://localhost:3000${route}`,
    elements_discovered: 3,
    elements_by_type: { button: 3 },
    interactions: [],
    api_calls: [],
    errors,
    warnings,
    duration_ms: 100,
  }
}

const sharedConsoleError = 'Console error: Warning: Encountered two children with the same key, `1`.'

describe('HTML report: explorer findings', () => {
  const explorations = [
    exploration('/products', [sharedConsoleError, 'Broken value on /products: "Price: NaN"'], ['Placeholder value on /products: "Category: Unknown"']),
    exploration('/pos', [sharedConsoleError, 'Checkout (click): Empty-state action: clicking "Checkout" while the page showed "No items" reported "Checkout successful!"']),
    exploration('/about', ['Navigation failed: net::ERR_ABORTED']),
  ]
  const results: TestResult[] = [{
    scenario,
    status: 'fail',
    duration_ms: 10,
    step_logs: [],
    failure_reason: 'Order total wrong',
    server_errors: [{ url: 'http://localhost:3000/api/orders', method: 'POST', status: 500, evidence: 'TypeError: x is undefined' }],
    retry: { attempts: 2, passed_on_retry: false, first_failure: 'Timeout' },
  }]

  it('lists explorer problems grouped by finding, with every page they were seen on', async () => {
    const report = await generateHtmlReport(results, productModel, config, explorations, [], undefined)

    // 1 failed scenario + 3 explorer problems, listed together at the top.
    expect(report).toContain('<h2 id="bugs-found">Bugs Found (4)</h2>')
    expect(report).toMatch(/<div class="summary-stat fail"><div class="num">3<\/div><div class="lbl">Problems found<\/div>/)
    expect(report).toContain('<span class="badge fail">Console error</span>')
    expect(report).toContain('<span class="badge fail">Broken value</span>')
    expect(report).toContain('<span class="badge fail">Empty-state action</span>')
    // The shared console error is one row that names both pages.
    const row = report.match(/<tr>\s*<td><span class="badge fail">Console error<\/span><\/td>[\s\S]*?<\/tr>/)?.[0] ?? ''
    expect(row).toContain('<code>/products</code> <code>/pos</code>')
    expect(report.match(/Encountered two children with the same key/g)?.length).toBeGreaterThanOrEqual(1)
  })

  it('keeps explorer diagnostics out of the problems list', async () => {
    const report = await generateHtmlReport(results, productModel, config, explorations, [], undefined)
    const section = report.slice(report.indexOf('id="bugs-found"'), report.indexOf('<h2>Failures'))
    expect(section).not.toContain('Navigation failed')
    // …but the page card still shows it, dimmed.
    expect(report).toContain('<ul class="page-findings dim"><li>Navigation failed: net::ERR_ABORTED</li></ul>')
  })

  it('shows warnings and retry findings separately from problems', async () => {
    const report = await generateHtmlReport(results, productModel, config, explorations, [], undefined, {
      retryFindings: ['Login (/login): only succeeded on attempt 2 (first attempt: "Invalid credentials")'],
    })
    expect(report).toContain('Warnings (2)')
    expect(report).toContain('<span class="badge medium">Placeholder value</span>')
    expect(report).toContain('<span class="badge medium">Passed on retry</span>')
    expect(report).toContain('only succeeded on attempt 2 (first attempt: &quot;Invalid credentials&quot;)')
  })

  it('marks page cards with problems and warnings', async () => {
    const report = await generateHtmlReport(results, productModel, config, explorations, [], undefined)
    expect(report).toContain('<span class="badge fail">2 problems</span>')
    expect(report).toContain('<span class="badge medium">1 warning</span>')
    expect(report).toContain('<li>Placeholder value on /products: &quot;Category: Unknown&quot;</li>')
  })

  it('shows server errors and retries on scenario cards', async () => {
    const report = await generateHtmlReport(results, productModel, config, explorations, [], undefined)
    expect(report).toContain('Server error 500 on POST /api/orders: TypeError: x is undefined')
    expect(report).toContain('Failed on all 2 attempts (first attempt: Timeout)')
  })

  it('escapes finding text', async () => {
    const report = await generateHtmlReport([], productModel, config, [exploration('/x', ['Broken value on /x: "<img src=x onerror=alert(1)>"'])], [], undefined)
    expect(report).not.toContain('<img src=x onerror')
    expect(report).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('labels logged-out sign-in redirects as expected and tags each pass', async () => {
    const report = await generateHtmlReport([], productModel, config, [
      { ...exploration('/products', ['Redirected to /login — sign-in required']), redirected_to: '/login' },
      { ...exploration('/products', []), signed_in: true },
    ], [], undefined)
    expect(report).toContain('<span class="badge session">logged out</span>')
    expect(report).toContain('<span class="badge session">signed in</span>')
    expect(report).toContain('<span class="badge session">sign-in required</span>')
    expect(report).toContain('<div class="status-dot skip"></div>')
    expect(report).toContain('<div class="bugs-none">')
  })

  it('keeps each pass its own screenshot', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-report-'))
    await fs.writeFile(path.join(dir, 'a.png'), 'first-pass')
    await fs.writeFile(path.join(dir, 'b.png'), 'second-pass')
    const report = await generateHtmlReport([], productModel, config, [
      { ...exploration('/products', []), screenshot_path: path.join(dir, 'a.png') },
      { ...exploration('/products', []), screenshot_path: path.join(dir, 'b.png'), signed_in: true },
    ], [], undefined, { reportDir: dir })
    // Not real images, so no thumbnails: each card still links its own full-size file.
    expect(report).toContain('data-full="a.png"')
    expect(report).toContain('data-full="b.png"')
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('says so at the top when nothing was found', async () => {
    const report = await generateHtmlReport([], productModel, config, [exploration('/ok', [])], [], undefined)
    expect(report).toContain('<div class="bugs-none">No failing scenarios and no problems found while exploring.</div>')
    expect(report).toMatch(/<div class="summary-stat skip"><div class="num">0<\/div><div class="lbl">Problems found<\/div>/)
  })
})
