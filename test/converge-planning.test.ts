import { describe, expect, it } from 'vitest'
import {
  buildFollowUpBatch, gapStepsToTestSteps, minimalLoginScenario, scenarioFromGap,
} from '../src/engine/converge.js'
import type { CoverageGapSuggestion, TestResult, TestScenario } from '../src/types/index.js'
import type { VibeConfig } from '../src/types/config.js'

const BASE = 'http://localhost:5173'

function gap(route: string, severity: CoverageGapSuggestion['severity'], name = `Test ${route}`, steps = [`Navigate to ${route}`]): CoverageGapSuggestion {
  return { route, missing: `missing on ${route}`, severity, suggested_test: { name, steps } }
}

function failed(id: string, name: string, extra: Partial<TestScenario> = {}): TestResult {
  return {
    scenario: { id, name, route: '/x', priority: 'medium', steps: [{ action: 'navigate', url: '/x', description: 'Open' }], expected_outcome: 'ok', is_gap: false, generated_by: 'heuristic', ...extra },
    status: 'fail', duration_ms: 1, step_logs: [],
  }
}

const credsConfig = {
  url: BASE,
  auth: { strategy: 'credentials', login_url: '/login', fields: { email: 'username', password: 'password' }, credentials: { email: 'admin', password: '1234' } },
} as VibeConfig

describe('gapStepsToTestSteps', () => {
  it('turns natural-language steps into executable steps', () => {
    const steps = gapStepsToTestSteps([
      'Navigate to /orders',
      'Click "New order" to open dialog',
      'Fill "Customer" with test data',
      'Fill "Email" with "qa@example.com"',
      'Then click submit',
      'Verify new item appears in list',
    ], '/orders', BASE)
    expect(steps).toEqual([
      { action: 'navigate', url: '/orders', description: 'Navigate to /orders' },
      { action: 'click', selector: 'text=New order', description: 'Click "New order" to open dialog' },
      { action: 'fill', selector: 'label=Customer', value: 'Test Customer', description: 'Fill "Customer" with test data' },
      { action: 'fill', selector: 'label=Email', value: 'qa@example.com', description: 'Fill "Email" with "qa@example.com"' },
      { action: 'click', selector: 'button[type="submit"]', description: 'Then click submit' },
      { action: 'wait', value: '1200', description: 'Verify new item appears in list' },
    ])
  })

  it('adds a leading slash to relative navigation targets', () => {
    expect(gapStepsToTestSteps(['Navigate to settings'], '/settings', BASE)[0]).toMatchObject({ url: '/settings' })
  })

  it('falls back to open-and-observe when nothing is understood', () => {
    expect(gapStepsToTestSteps(['Ponder the meaning of the page', '   '], '/about', BASE)).toEqual([
      { action: 'navigate', url: '/about', description: 'Open /about' },
      { action: 'wait', value: '1500', description: 'Observe page' },
    ])
  })
})

describe('scenarioFromGap', () => {
  it('maps severity to priority and marks the scenario as a converge gap', () => {
    const s = scenarioFromGap(gap('/orders', 'critical', 'Create order'), BASE)!
    expect(s).toMatchObject({ name: '[converge] Create order', route: '/orders', priority: 'high', is_gap: true, requires_auth: true })
    expect(scenarioFromGap(gap('/a', 'important'), BASE)!.priority).toBe('medium')
    expect(scenarioFromGap(gap('/a', 'nice_to_have'), BASE)!.priority).toBe('low')
  })

  it.each(['/login', '/log-in', '/signin', '/sign-in', '/signup', '/sign-up', '/register', '/forgot-password', '/reset-password', '/privacy', '/terms'])(
    'treats public page %s as not requiring auth', route => {
      expect(scenarioFromGap(gap(route, 'important'), BASE)!.requires_auth).toBe(false)
    })

  it('treats app pages as requiring auth', () => {
    expect(scenarioFromGap(gap('/dashboard', 'important'), BASE)!.requires_auth).toBe(true)
  })
})

describe('minimalLoginScenario', () => {
  it('returns null unless the config has credential auth', () => {
    expect(minimalLoginScenario({ url: BASE } as VibeConfig)).toBeNull()
    expect(minimalLoginScenario({ url: BASE, auth: { strategy: 'skip' } } as VibeConfig)).toBeNull()
    expect(minimalLoginScenario({ url: BASE, auth: { strategy: 'credentials' } } as VibeConfig)).toBeNull()
  })

  it('fills the configured field names with the configured credentials', () => {
    const s = minimalLoginScenario(credsConfig)!
    const fills = s.steps.filter(st => st.action === 'fill')
    expect(s.route).toBe('/login')
    expect(fills[0].value).toBe('admin')
    expect(fills[0].selector).toContain('[name="username"]')
    expect(fills[0].selector).toContain('#username')
    expect(fills[1].value).toBe('1234')
    expect(fills[1].selector).toContain('#password')
  })

  it('falls back to email/password selectors when no field names are configured', () => {
    const s = minimalLoginScenario({ url: BASE, auth: { strategy: 'credentials', credentials: { email: 'a@b.c', password: 'p' } } } as VibeConfig)!
    expect(s.steps.find(st => st.action === 'fill')!.selector).toBe('[name="email"], #email, [type="email"]')
  })
})

describe('buildFollowUpBatch', () => {
  it('orders gap scenarios by severity and respects the limit', () => {
    const batch = buildFollowUpBatch(
      [gap('/c', 'nice_to_have', 'C'), gap('/a', 'critical', 'A'), gap('/b', 'important', 'B')],
      [], { url: BASE } as VibeConfig, 2,
    )
    expect(batch.map(s => s.name)).toEqual(['[converge] A', '[converge] B'])
  })

  it('retests each failing scenario only once, even across rounds (regression: "X (retest) (retest)")', () => {
    const results = [
      failed('S1', 'Login works'),
      failed('S1-retest', 'Login works (retest)'),
      failed('S1-retest-retest', 'Login works (retest) (retest)'),
      failed('S2', 'Profile saves'),
    ]
    const batch = buildFollowUpBatch([], results, { url: BASE } as VibeConfig, 12)
    expect(batch.map(s => `${s.id}|${s.name}`)).toEqual([
      'S1-retest|Login works (retest)',
      'S2-retest|Profile saves (retest)',
    ])
  })

  it('does not retest passing scenarios or converge-generated ones', () => {
    const pass = { ...failed('P', 'Passing'), status: 'pass' as const }
    const conv = failed('VTC-3', '[converge] Something')
    expect(buildFollowUpBatch([], [pass, conv], { url: BASE } as VibeConfig, 12)).toEqual([])
  })

  it('prepends a session login when a scenario needs auth and the batch has no login', () => {
    const batch = buildFollowUpBatch([gap('/dashboard', 'critical')], [], credsConfig, 12)
    expect(batch[0].id).toBe('vibe-converge-session-login')
    expect(batch).toHaveLength(2)
  })

  it('does not add a second login when the batch already logs in', () => {
    const loginRetest = failed('L', 'Login with saved credentials', {
      steps: [{ action: 'fill', selector: '#username', value: 'admin', description: 'Fill username' }],
    })
    const batch = buildFollowUpBatch([gap('/dashboard', 'critical')], [loginRetest], credsConfig, 12)
    expect(batch.filter(s => s.id === 'vibe-converge-session-login')).toHaveLength(0)
  })
})
