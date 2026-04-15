import { Route, CoverageMap, Gap, Memory } from '../../types/index.js'

export function analyzeGaps(
  routes: Route[],
  coverage: CoverageMap,
  memory: Memory
): Gap[] {
  const pageRoutes = routes.filter(r => r.type === 'page')

  const gaps: Gap[] = pageRoutes.map(route => {
    const covered = coverage[route.path]
    const memFlaky = memory.flaky_flows.find(f => f.flow === route.path)
    const memVerified = memory.verified_flows.find(v => v.flow === route.path)

    let score = 0
    let reason: Gap['reason'] = 'no_tests'
    const untested_aspects: string[] = []

    if (!covered?.tested) {
      score += 50
      reason = 'no_tests'
    } else {
      score += 10
      reason = 'partial_coverage'

      const descriptions = covered.scenarios.join(' ').toLowerCase()
      if (!descriptions.includes('error') && !descriptions.includes('invalid') && !descriptions.includes('fail')) {
        untested_aspects.push('error states / invalid inputs')
        score += 15
      }
      if (!descriptions.includes('empty') && !descriptions.includes('blank')) {
        untested_aspects.push('empty/blank field submission')
        score += 5
      }
    }

    if (route.requires_auth)              score += 25
    if (route.path.includes('checkout') || route.path.includes('payment')) score += 30
    if (route.path.includes('login')   || route.path.includes('signup'))   score += 20
    if (route.path.includes('password') || route.path.includes('reset'))   score += 20
    if (route.path.includes('delete')  || route.path.includes('remove'))   score += 15

    if (memFlaky) {
      score += Math.round(memFlaky.fail_rate * 35)
      reason = 'flaky_history'
    }

    if (memVerified && memVerified.consecutive_passes >= 3) {
      score = Math.max(0, score - 20)
    }

    return {
      route: route.path,
      reason,
      priority_score: Math.min(100, score),
      priority: score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low',
      untested_aspects,
    }
  })

  return gaps
    .filter(g => g.priority_score > 0)
    .sort((a, b) => b.priority_score - a.priority_score)
}
