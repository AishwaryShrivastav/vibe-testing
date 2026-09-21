import type { ProductModel, TestResult } from '../../types/index.js'

export interface ReportMetrics {
  staticRoutesDiscovered: number
  livePagesObserved: number
  scenariosExecuted: number
  scenariosPassed: number
  scenariosFailed: number
  scenariosSkipped: number
  scenarioErrors: number
}

export function deriveReportMetrics(productModel: ProductModel, results: TestResult[]): ReportMetrics {
  const scenarioErrors = results.filter(result => result.status === 'error').length

  return {
    staticRoutesDiscovered: productModel.routes.filter(route => route.origin !== 'live-crawl').length,
    livePagesObserved: productModel.routes.filter(route => route.origin === 'live-crawl').length,
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
