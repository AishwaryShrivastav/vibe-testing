import { describe, it, expect } from 'vitest'
import { generateScenarios } from '../src/engine/context/enricher.js'
import type { Gap, RouteBehaviour, CoverageMap } from '../src/types/index.js'

describe('generateScenarios', () => {
  it('generates scenarios for gaps', async () => {
    const gaps: Gap[] = [{
      route: '/dashboard',
      reason: 'no_tests',
      priority_score: 8,
      priority: 'high',
    }]
    const behaviours: RouteBehaviour[] = [{
      route: { path: '/dashboard', type: 'page', requires_auth: false, dynamic_segments: [] },
      forms: [],
      api_calls: [],
    }]
    const coverage: CoverageMap = {}

    const scenarios = await generateScenarios(gaps, behaviours, coverage, 'deep')
    expect(scenarios.length).toBeGreaterThan(0)
    expect(scenarios[0].route).toBe('/dashboard')
  })

  it('does not generate filter scenarios with hardcoded Active text', async () => {
    const gaps: Gap[] = [{
      route: '/users',
      reason: 'no_tests',
      priority_score: 5,
      priority: 'medium',
    }]
    const behaviours: RouteBehaviour[] = [{
      route: { path: '/users', type: 'page', requires_auth: false, dynamic_segments: [] },
      forms: [],
      api_calls: [],
    }]
    const coverage: CoverageMap = {}

    const scenarios = await generateScenarios(gaps, behaviours, coverage, 'deep')
    // Should NOT contain text=Active clicks from hardcoded fallback
    for (const scenario of scenarios) {
      for (const step of scenario.steps) {
        if (step.selector) {
          expect(step.selector).not.toBe('text=Active')
        }
      }
    }
  })

  it('skips param-dependent routes like reset-password', async () => {
    const gaps: Gap[] = [{
      route: '/reset-password',
      reason: 'no_tests',
      priority_score: 3,
      priority: 'low',
    }]
    const behaviours: RouteBehaviour[] = []
    const coverage: CoverageMap = {}

    const scenarios = await generateScenarios(gaps, behaviours, coverage, 'deep')
    // Should have no functional scenarios for reset-password (needs token param)
    const functional = scenarios.filter(s => s.route === '/reset-password' && !s.name.includes('redirects'))
    expect(functional.length).toBe(0)
  })

  it('treats /signin as a login route (modern Next.js / NextAuth convention)', async () => {
    const gaps: Gap[] = [
      { route: '/signin', reason: 'no_tests', priority_score: 9, priority: 'high' },
    ]
    const behaviours: RouteBehaviour[] = [
      {
        route: { path: '/signin', type: 'page', requires_auth: false, dynamic_segments: [] },
        forms: [[
          { name: 'email', type: 'email', required: true, validations: [], placeholder: 'Email', label: 'Email' },
          { name: 'password', type: 'password', required: true, validations: [], placeholder: 'Password', label: 'Password' },
        ]],
        api_calls: [],
      },
    ]
    const coverage: CoverageMap = {}

    const scenarios = await generateScenarios(gaps, behaviours, coverage, 'deep')
    const loginScenario = scenarios.find(s => s.route === '/signin' && s.name.toLowerCase().includes('login'))
    expect(loginScenario).toBeDefined()
  })

  it('uses config.auth.credentials supplied via recommendations.saved_credentials', async () => {
    const gaps: Gap[] = [{ route: '/signin', reason: 'no_tests', priority_score: 9, priority: 'high' }]
    const behaviours: RouteBehaviour[] = [{
      route: { path: '/signin', type: 'page', requires_auth: false, dynamic_segments: [] },
      forms: [[
        { name: 'email', type: 'email', required: true, validations: [], placeholder: 'Email', label: 'Email' },
        { name: 'password', type: 'password', required: true, validations: [], placeholder: 'Password', label: 'Password' },
      ]],
      api_calls: [],
    }]
    const coverage: CoverageMap = {}
    const recommendations = {
      skip_routes: new Set<string>(),
      auth_routes: new Set<string>(),
      timeout_hints: {},
      selector_hints: {},
      first_run: true,
      auth_intel: null,
      saved_credentials: {
        email: 'teacher.dev@example.com',
        password: 'RealPasswordFromConfig!',
        registered_at: new Date().toISOString(),
      },
    }

    const scenarios = await generateScenarios(gaps, behaviours, coverage, 'deep', recommendations)
    const loginScenario = scenarios.find(s => s.route === '/signin' && s.name.toLowerCase().includes('login'))
    expect(loginScenario).toBeDefined()
    const emailStep = loginScenario!.steps.find(s => s.action === 'fill' && s.description.toLowerCase().includes('email'))
    const passwordStep = loginScenario!.steps.find(s => s.action === 'fill' && s.description.toLowerCase().includes('password'))
    expect(emailStep?.value).toBe('teacher.dev@example.com')
    expect(passwordStep?.value).toBe('RealPasswordFromConfig!')
  })

  it('honors explicit auth.login_url for non-standard login routes', async () => {
    const gaps: Gap[] = [{ route: '/access', reason: 'no_tests', priority_score: 9, priority: 'high' }]
    const behaviours: RouteBehaviour[] = [{
      route: { path: '/access', type: 'page', requires_auth: false, dynamic_segments: [] },
      forms: [[
        { name: 'email', type: 'email', required: true, validations: [], placeholder: 'Email', label: 'Email' },
        { name: 'password', type: 'password', required: true, validations: [], placeholder: 'Password', label: 'Password' },
      ]],
      api_calls: [],
    }]
    const coverage: CoverageMap = {}

    const withoutConfig = await generateScenarios(gaps, behaviours, coverage, 'deep')
    const noLogin = withoutConfig.find(s => s.route === '/access' && s.name.toLowerCase().includes('login'))
    expect(noLogin).toBeUndefined()

    const withConfig = await generateScenarios(gaps, behaviours, coverage, 'deep', undefined, '/access')
    const hasLogin = withConfig.find(s => s.route === '/access' && s.name.toLowerCase().includes('login'))
    expect(hasLogin).toBeDefined()
  })
})
