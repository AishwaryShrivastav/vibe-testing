import { describe, expect, it } from 'vitest'
import { generateHtmlReport } from '../src/engine/reporter/html.js'
import { deriveReportMetrics } from '../src/engine/reporter/metrics.js'
import type { PageExploration } from '../src/engine/browser/explorer.js'
import { generateMarkdownReport } from '../src/engine/reporter/markdown.js'
import type { CoverageMap, ProductModel, Route, TestResult, TestScenario } from '../src/types/index.js'
import { VibeConfigSchema } from '../src/types/config.js'

function route(path: string, origin: Route['origin']): Route {
  return {
    path,
    type: 'page',
    requires_auth: false,
    dynamic_segments: [],
    origin,
  }
}

function result(index: number, status: TestResult['status']): TestResult {
  const scenario: TestScenario = {
    id: `scenario-${index}`,
    name: `Scenario ${index}`,
    route: `/route-${index}`,
    priority: 'medium',
    steps: [{ action: 'navigate', url: `/route-${index}`, description: 'Open the page' }],
    expected_outcome: 'The page loads',
    is_gap: false,
    generated_by: 'heuristic',
  }

  return {
    scenario,
    status,
    duration_ms: 10,
    step_logs: [],
  }
}

describe('report metrics', () => {
  it('keeps static routes, live pages, and executed scenario outcomes separate', async () => {
    const routes = [
      ...Array.from({ length: 19 }, (_, index) => route(`/static-${index}`, 'static')),
      ...Array.from({ length: 11 }, (_, index) => route(`/live-${index}`, 'live-crawl')),
    ]
    const dependencyNoise = Object.fromEntries(
      Array.from({ length: 700 }, (_, index) => [
        `/node_modules/generated-${index}.test.ts`,
        { tested: true, scenarios: [`generated ${index}`], frameworks: ['vitest'] },
      ]),
    ) as CoverageMap
    const results = [
      ...Array.from({ length: 8 }, (_, index) => result(index, 'pass')),
      ...Array.from({ length: 3 }, (_, index) => result(index + 8, 'fail')),
      result(11, 'error'),
      result(12, 'skip'),
      result(13, 'skip'),
    ]
    const productModel: ProductModel = {
      project_name: 'truthful-metrics',
      url: 'http://localhost:3000',
      framework: 'tanstack-router',
      codebase_path: '/tmp/truthful-metrics',
      scanned_at: '2026-09-21T00:00:00.000Z',
      routes,
      behaviours: [],
      coverage: dependencyNoise,
      gaps: [],
      scenarios: results.map(item => item.scenario),
    }
    const config = VibeConfigSchema.parse({ url: productModel.url })

    const html = await generateHtmlReport(results, productModel, config, [], [])
    const markdown = generateMarkdownReport(results, productModel, config)

    for (const report of [html, markdown]) {
      expect(report).toContain('19 static routes discovered')
      expect(report).toContain('11 live pages observed')
      expect(report).toContain('14 scenarios executed')
      expect(report).toContain('8 passed')
      expect(report).toContain('4 failed')
      expect(report).toContain('2 skipped')
      expect(report).not.toMatch(/700 routes tested/i)
      expect(report).not.toMatch(/routes scanned/i)
    }
  })
})

describe('live pages observed', () => {
  function crawlResult(path: string): TestResult {
    const base = result(0, 'pass')
    return { ...base, scenario: { ...base.scenario, id: `live${path}`, route: path, route_origin: 'live-crawl' } }
  }
  const model = (routes: Route[]): ProductModel => ({
    project_name: 'p', url: 'http://localhost:3000', framework: 'nextjs', codebase_path: '/tmp/p',
    scanned_at: '2026-01-01T00:00:00.000Z', routes, behaviours: [], coverage: {}, gaps: [], scenarios: [],
  })

  it('counts crawl pages even when the model deduped them into static routes', () => {
    const metrics = deriveReportMetrics(
      model([route('/rooms', 'static'), route('/privacy', 'static')]),
      [crawlResult('/rooms'), crawlResult('/privacy?x=1'), crawlResult('/rooms/')],
    )
    expect(metrics.livePagesObserved).toBe(2)
    expect(metrics.staticRoutesDiscovered).toBe(2)
  })

  it('adds explored pages without double counting', () => {
    const exploration = { route: '/rooms', url: 'http://localhost:3000/rooms' } as PageExploration
    const other = { route: '/admin', url: 'http://localhost:3000/admin' } as PageExploration
    const metrics = deriveReportMetrics(model([route('/rooms', 'live-crawl')]), [], [exploration, other])
    expect(metrics.livePagesObserved).toBe(2)
  })
})

describe('markdown report findings', () => {
  it('includes failed scenarios, explorer problems, warnings, retries and app changes', () => {
    const failed: TestResult = { ...result(1, 'fail'), failure_reason: 'Order total wrong' }
    const retried: TestResult = { ...result(2, 'pass'), retry: { attempts: 2, passed_on_retry: true, first_failure: 'timeout' } }
    const exploration = {
      route: '/products', url: 'http://localhost:3000/products', elements_discovered: 1, elements_by_type: {},
      interactions: [], api_calls: [], duration_ms: 1,
      errors: ['Broken value on /products: "Price: NaN"', 'Navigation failed: net::ERR_ABORTED'],
      warnings: ['Placeholder value on /products: "Category: Unknown"'],
      changes: [{ action: 'click "Add"', method: 'POST', path: '/api/items', status: 201 }],
    } as PageExploration
    const model: ProductModel = {
      project_name: 'p', url: 'http://localhost:3000', framework: 'nextjs', codebase_path: '/tmp/p',
      scanned_at: '2026-01-01T00:00:00.000Z', routes: [], behaviours: [], coverage: {}, gaps: [], scenarios: [],
    }
    const md = generateMarkdownReport([failed, retried], model, VibeConfigSchema.parse({ url: model.url }), [exploration])
    expect(md).toContain('### Failed scenarios (1)')
    expect(md).toContain('Order total wrong')
    expect(md).toContain('### Problems found while exploring (1)')
    expect(md).toContain('Price: NaN')
    expect(md).not.toContain('Navigation failed')
    expect(md).toContain('Needs attention')
    expect(md).toContain('Warnings')
    expect(md).toContain('Category: Unknown')
    expect(md).toContain('Changes made to the app')
    expect(md).toContain('POST /api/items')
  })
})
