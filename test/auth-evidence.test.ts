import { describe, expect, it } from 'vitest'
import { authEvidence } from '../src/engine/memory/index.js'
import type { TestResult } from '../src/types/index.js'

function result(route: string, opts: { name?: string; status?: TestResult['status']; requiresAuth?: boolean; landed?: string }): TestResult {
  return {
    scenario: {
      id: 'x', name: opts.name ?? `${route} page loads`, route, priority: 'medium', steps: [],
      expected_outcome: '', is_gap: true, generated_by: 'heuristic', requires_auth: opts.requiresAuth,
    },
    status: opts.status ?? 'pass',
    duration_ms: 10,
    step_logs: [],
    current_url: opts.landed ? `http://app.test${opts.landed}` : undefined,
  }
}

describe('memory learns "needs sign-in" only from evidence', () => {
  it('a signed-out visit that bounced to sign-in is evidence', () => {
    expect(authEvidence(result('/dashboard', { status: 'fail', landed: '/login' }))).toBe(true)
  })

  it('a passing redirect check is evidence; a failing one proves nothing', () => {
    expect(authEvidence(result('/admin', { name: '/admin redirects to login when unauthenticated', status: 'pass', landed: '/login' }))).toBe(true)
    expect(authEvidence(result('/cookie', { name: '/cookie redirects to login when unauthenticated', status: 'fail', landed: '/cookie' }))).toBeUndefined()
  })

  it('running signed in is not evidence', () => {
    expect(authEvidence(result('/cookie', { requiresAuth: true, landed: '/cookie' }))).toBeUndefined()
  })

  it('a signed-out visit that stayed on the page clears a wrong guess', () => {
    expect(authEvidence(result('/cookie', { landed: '/cookie' }))).toBe(false)
  })

  it('says nothing about the login page itself', () => {
    expect(authEvidence(result('/login', { landed: '/login' }))).toBeUndefined()
  })
})
