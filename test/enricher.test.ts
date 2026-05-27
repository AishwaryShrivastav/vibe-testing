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
})
