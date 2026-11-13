import type { TestResult } from '../types/index.js'
import type { PageExploration } from './browser/explorer.js'
import { describeScenarioRetry } from './browser/runner.js'
import { describeChange } from './browser/write-policy.js'

/** Explorer findings that are real failures, as opposed to its own diagnostics. */
const EXPLORER_FAILURE = /Server error \d{3}|Crash text|No response within|^Uncaught exception|^Console error|^Broken value|^Broken resource|Empty-state action|Submitted value not shown|^Total mismatch/

/** True when an explorer error is a real failure in the app (not a navigation or discovery diagnostic). */
export function isExplorerFailure(error: string): boolean {
  return EXPLORER_FAILURE.test(error)
}

const FINDING_KINDS: Array<[RegExp, string]> = [
  [/Server error \d{3}/, 'Server error'],
  [/Crash text/, 'Crash text'],
  [/No response within/, 'No response'],
  [/^Uncaught exception/, 'Uncaught exception'],
  [/^Console error/, 'Console error'],
  [/^Broken value/, 'Broken value'],
  [/^Broken resource/, 'Broken resource'],
  [/Empty-state action/, 'Empty-state action'],
  [/Submitted value not shown/, 'Submitted value not shown'],
  [/^Total mismatch/, 'Total mismatch'],
  [/^Placeholder value/, 'Placeholder value'],
  [/^Resource unavailable/, 'Resource unavailable'],
]

/** Short label for an explorer finding, e.g. "Console error" or "Server error". */
export function findingKind(finding: string): string {
  return FINDING_KINDS.find(([pattern]) => pattern.test(finding))?.[1] ?? 'Other'
}

export interface GroupedFinding {
  /** The finding as the explorer wrote it. */
  finding: string
  /** Every explored page it was seen on, in exploration order. */
  routes: string[]
}

/**
 * Real explorer failures grouped by finding: the same failure seen on several
 * pages (a broken shared script, a console error in the layout) is one entry.
 */
export function groupExplorerFailures(explorations: PageExploration[]): GroupedFinding[] {
  const routesByFailure = new Map<string, string[]>()
  for (const exploration of explorations) {
    for (const error of exploration.errors) {
      if (!isExplorerFailure(error)) continue
      const routes = routesByFailure.get(error) ?? []
      if (!routes.includes(exploration.route)) routes.push(exploration.route)
      routesByFailure.set(error, routes)
    }
  }
  return [...routesByFailure].map(([finding, routes]) => ({ finding, routes }))
}

/**
 * Real failures the explorer found (server errors, crash text, hangs, uncaught
 * exceptions) — not its own diagnostics such as navigation or discovery problems.
 */
export function collectExplorerFailures(explorations: PageExploration[]): string[] {
  return groupExplorerFailures(explorations).map(({ finding, routes }) =>
    `${routes[0]}${routes.length > 1 ? ` (+${routes.length - 1} more page${routes.length > 2 ? 's' : ''})` : ''}: ${finding}`)
}

/** Lower-confidence explorer findings (e.g. "Category: Unknown"), reported without failing the run. */
export function collectExplorerWarnings(explorations: PageExploration[]): string[] {
  // The same value seen from several explored pages (e.g. via in-app
  // navigation) is one finding: key by the page it is on and the value.
  const byKey = new Set<string>()
  for (const exploration of explorations) {
    for (const warning of exploration.warnings ?? []) {
      byKey.add(warning.replace(/ \(via in-app navigation\)/, ''))
    }
  }
  return [...byKey]
}

/**
 * Everything that only succeeded on a retry: logins (session or crawl) and
 * scenarios that passed on a later attempt. These are inconsistent behaviour
 * worth a look, reported separately from failures.
 */
export function collectRetryFindings(results: TestResult[], operationFindings: string[] = []): string[] {
  const scenarioFindings = results.map(describeScenarioRetry).filter((finding): finding is string => !!finding)
  return [...new Set([...operationFindings, ...scenarioFindings])]
}

/** A scenario that failed or errored, with a one-line reason. */
export interface FailedScenario {
  name: string
  route: string
  status: 'fail' | 'error'
  reason: string
}

/** Failed and errored scenarios, failures first, each with a one-line reason (verdict, else failure reason). */
export function collectFailedScenarios(results: TestResult[]): FailedScenario[] {
  return results
    .filter((r): r is TestResult & { status: 'fail' | 'error' } => r.status === 'fail' || r.status === 'error')
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'fail' ? -1 : 1))
    .map(r => {
      const base = (r.ai_verdict ?? r.failure_reason ?? 'no reason recorded').replace(/\s+/g, ' ').trim()
      const retry = r.retry && r.retry.attempts > 1 && !r.retry.passed_on_retry ? ` (failed on all ${r.retry.attempts} attempts)` : ''
      const reason = base.length > 200 ? `${base.slice(0, 199)}…` : base
      return { name: r.scenario.name, route: r.scenario.route, status: r.status, reason: `${reason}${retry}` }
    })
}

/**
 * Data-changing requests exploration made, one line each: "<page>: <action>:
 * POST /path (201) — values". Repeats of the same request from the same
 * action on a page are counted, not repeated.
 */
export function collectAppChanges(explorations: PageExploration[]): string[] {
  const counts = new Map<string, number>()
  const lines = new Map<string, string>()
  for (const exploration of explorations) {
    for (const change of exploration.changes ?? []) {
      const key = `${exploration.route} ${change.action} ${change.method} ${change.path}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
      if (!lines.has(key)) lines.set(key, `${exploration.route}: ${describeChange(change)}`)
    }
  }
  return [...lines].map(([key, line]) => {
    const count = counts.get(key) ?? 1
    return count > 1 ? `${line} (×${count})` : line
  })
}
