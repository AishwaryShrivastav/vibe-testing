import { describe, expect, it } from 'vitest'
import { collectFailedScenarios } from '../src/engine/findings.js'
import { formatRunFindings, runHasFailures } from '../src/run-findings-text.js'
import type { TestResult } from '../src/types/index.js'

function result(name: string, route: string, status: TestResult['status'], extra: Partial<TestResult> = {}): TestResult {
  return {
    scenario: { id: name, name, route, priority: 'high', steps: [], expected_outcome: '', is_gap: false, generated_by: 'heuristic' },
    status, duration_ms: 10, step_logs: [], ...extra,
  }
}

describe('failed scenarios in run summaries', () => {
  const results = [
    result('Home loads', '/', 'pass'),
    result('Checkout crashed', '/pos', 'error', { failure_reason: 'Runner crash: boom' }),
    result('Logout ends the session', '/products', 'fail', {
      ai_verdict: 'Logout does not end the session: after "Logout" (landed on /products), /products still opened without signing in',
      retry: { attempts: 2, passed_on_retry: false, first_failure: 'same' },
    }),
  ]

  it('lists failed and errored scenarios, failures first, with a one-line reason', () => {
    expect(collectFailedScenarios(results)).toEqual([
      {
        name: 'Logout ends the session', route: '/products', status: 'fail',
        reason: 'Logout does not end the session: after "Logout" (landed on /products), /products still opened without signing in (failed on all 2 attempts)',
      },
      { name: 'Checkout crashed', route: '/pos', status: 'error', reason: 'Runner crash: boom' },
    ])
  })

  it('trims long reasons to one line', () => {
    const [failed] = collectFailedScenarios([result('X', '/x', 'fail', { ai_verdict: `line one\n${'y'.repeat(400)}` })])
    expect(failed.reason).not.toContain('\n')
    expect(failed.reason.length).toBeLessThanOrEqual(200)
  })

  it('puts failed scenarios first, then problems, needs attention, warnings, changes', () => {
    const text = formatRunFindings({
      failed_scenarios: collectFailedScenarios(results),
      explorer_failures: ['/pos: Total mismatch on /pos'],
      retry_findings: ['Configured login: login with valid credentials only succeeded on attempt 2'],
      explorer_warnings: ['Placeholder value on /products: "Category: Unknown"'],
      app_changes: ['/memos: create-then-verify: POST /memos (200)'],
    })
    const order = ['Failed scenarios: 2', 'Problems found while exploring', 'Needs attention', 'Warnings', 'Changes made to the app']
      .map(heading => text.indexOf(heading))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(text).toContain('  - Logout ends the session (/products): Logout does not end the session')
    expect(text).toContain('  - [error] Checkout crashed (/pos): Runner crash: boom')
  })

  it('caps long lists with a count of the rest', () => {
    const many = Array.from({ length: 20 }, (_, i) => result(`S${i}`, `/s${i}`, 'fail', { ai_verdict: 'bad' }))
    const text = formatRunFindings({ failed_scenarios: collectFailedScenarios(many) })
    expect(text).toContain('Failed scenarios: 20')
    expect(text).toContain('…and 5 more (see report)')
  })

  it('is empty when nothing was found', () => {
    expect(formatRunFindings({})).toBe('')
  })
})

describe('isError rule', () => {
  it('fails on a failed scenario or a real explorer problem', () => {
    expect(runHasFailures({ failed_scenarios: [{ name: 'x', route: '/', status: 'fail', reason: 'r' }] })).toBe(true)
    expect(runHasFailures({ explorer_failures: ['/: Server error 500'] })).toBe(true)
  })

  it('does not fail on retries, warnings or app changes alone', () => {
    expect(runHasFailures({ retry_findings: ['login retry'], explorer_warnings: ['w'], app_changes: ['c'] })).toBe(false)
  })
})

describe('failed scenario lines', () => {
  it('does not repeat a route the scenario name already contains', async () => {
    const { formatRunFindings } = await import('../src/run-findings-text.js')
    const text = formatRunFindings({
      failed_scenarios: [
        { name: 'Live page health: /reservation/1?a=b', route: '/reservation/1?a=b', status: 'fail', reason: 'Server error 500' },
        { name: 'Logout ends the session', route: '/products', status: 'fail', reason: 'still signed in' },
      ],
    } as never)
    expect(text).toContain('Live page health: /reservation/1?a=b: Server error 500')
    expect(text).not.toContain('(/reservation/1?a=b)')
    expect(text).toContain('Logout ends the session (/products): still signed in')
  })
})
