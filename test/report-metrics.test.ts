import { describe, expect, it } from 'vitest'
import { generateHtmlReport } from '../src/engine/reporter/html.js'
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
