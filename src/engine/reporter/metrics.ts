import type { ProductModel, TestResult } from '../../types/index.js'
import type { PageExploration } from '../browser/explorer.js'

export interface ReportMetrics {
  staticRoutesDiscovered: number
  livePagesObserved: number
  scenariosExecuted: number
  scenariosPassed: number
  scenariosFailed: number
  scenariosSkipped: number
  scenarioErrors: number
}

function pagePath(value: string): string {
  let path = value
  try { path = new URL(value, 'http://x').pathname } catch { path = value.split(/[?#]/)[0] }
  path = path.replace(/\/{2,}/g, '/').replace(/\/$/, '')
  return path || '/'
}

/** Distinct live pages: crawl routes, crawl scenarios (the crawl can reach pages the model dedupes away), and explored pages. */
function observedLivePages(productModel: ProductModel, results: TestResult[], explorations: PageExploration[]): number {
  const pages = new Set<string>()
  for (const route of productModel.routes) if (route.origin === 'live-crawl') pages.add(pagePath(route.path))
  for (const item of results) if (item.scenario.route_origin === 'live-crawl') pages.add(pagePath(item.scenario.route))
  for (const scenario of productModel.scenarios) if (scenario.route_origin === 'live-crawl') pages.add(pagePath(scenario.route))
  for (const exploration of explorations) pages.add(pagePath(exploration.route || exploration.url))
  return pages.size
}

export function deriveReportMetrics(productModel: ProductModel, results: TestResult[], explorations: PageExploration[] = []): ReportMetrics {
  const scenarioErrors = results.filter(result => result.status === 'error').length

  return {
    staticRoutesDiscovered: productModel.routes.filter(route => route.origin !== 'live-crawl').length,
    livePagesObserved: observedLivePages(productModel, results, explorations),
    scenariosExecuted: results.length,
    scenariosPassed: results.filter(result => result.status === 'pass').length,
    scenariosFailed: results.filter(result => result.status === 'fail').length + scenarioErrors,
    scenariosSkipped: results.filter(result => result.status === 'skip').length,
    scenarioErrors,
  }
}

export function formatReportMetrics(metrics: ReportMetrics): string {
  return [
    `${metrics.staticRoutesDiscovered} static ${plural(metrics.staticRoutesDiscovered, 'route')} discovered`,
    `${metrics.livePagesObserved} live ${plural(metrics.livePagesObserved, 'page')} observed`,
    `${metrics.scenariosExecuted} ${plural(metrics.scenariosExecuted, 'scenario')} executed`,
    `${metrics.scenariosPassed} passed`,
    `${metrics.scenariosFailed} failed`,
    `${metrics.scenariosSkipped} skipped`,
  ].join(' · ')
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}
