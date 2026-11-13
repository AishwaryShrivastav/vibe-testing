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

  it('fills a username (non-email) login field with the configured identity', async () => {
    const gaps: Gap[] = [{ route: '/login', reason: 'no_tests', priority_score: 9, priority: 'high' }]
    const behaviours: RouteBehaviour[] = [{
      route: { path: '/login', type: 'page', requires_auth: false, dynamic_segments: [] },
      forms: [[
        { name: 'username', type: 'text', required: false, validations: [], placeholder: 'admin', label: 'Username' },
        { name: 'password', type: 'password', required: false, validations: [], placeholder: '1234', label: 'Password' },
      ]],
      api_calls: [],
    }]
    const recommendations = {
      skip_routes: new Set<string>(),
      auth_routes: new Set<string>(),
      timeout_hints: {},
      selector_hints: {},
      first_run: true,
      auth_intel: null,
      saved_credentials: { email: 'admin', password: '1234', registered_at: new Date().toISOString() },
    }

    const scenarios = await generateScenarios(gaps, behaviours, {}, 'deep', recommendations)
    const loginScenario = scenarios.find(s => s.route === '/login' && s.name.toLowerCase().includes('login'))
    const fills = loginScenario!.steps.filter(s => s.action === 'fill').map(s => s.value)
    expect(fills).toEqual(['admin', '1234'])
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

  it('asserts a sign-in redirect only for routes known to be protected', async () => {
    const page = (path: string, requires_auth: boolean): RouteBehaviour =>
      ({ route: { path, type: 'page', requires_auth, dynamic_segments: [] }, forms: [], api_calls: [] })
    const gaps: Gap[] = ['/login', '/cookie', '/admin/rooms'].map(route => ({ route, reason: 'no_tests', priority_score: 5, priority: 'medium' }))
    const scenarios = await generateScenarios(gaps, [page('/login', false), page('/cookie', false), page('/admin/rooms', true)], {}, 'deep')
    const redirects = scenarios.filter(s => s.name.includes('redirects to login')).map(s => s.route)
    // /cookie is only guessed as protected; asserting a redirect there would be a false failure.
    expect(redirects).toEqual(['/admin/rooms'])
  })

  it('falls back to a username-or-email selector when the login form was not read from code', async () => {
    const gaps: Gap[] = [{ route: '/admin', reason: 'no_tests', priority_score: 9, priority: 'high' }]
    const scenarios = await generateScenarios(gaps, [], {}, 'deep', undefined, '/admin')
    const login = scenarios.find(s => s.route === '/admin' && s.name.toLowerCase().includes('login'))
    const identity = login!.steps.find(s => s.action === 'fill' && !/password/i.test(s.description))
    expect(identity?.selector).toContain('[id*="user" i]')
    expect(identity?.selector).toContain('[type="email"]')
  })
})
