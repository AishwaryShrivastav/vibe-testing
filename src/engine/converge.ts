import type { VibeConfig } from '../types/config.js'
import type { CoverageGapSuggestion, TestResult, TestScenario, TestStep } from '../types/index.js'
import { buildProductModel } from './context/index.js'
import { executeScenarios, type PageExploration } from './browser/index.js'
import { MemoryManager } from './memory/index.js'
import { generateCoverageGaps } from './coverage-gaps.js'
import { readVibeGuidance } from '../utils/vibe-md.js'
import { logger } from '../utils/logger.js'

export interface ConvergeOptions {
  /** Maximum follow-up rounds after the initial full run (default 4 → 5 runs total) */
  max_followup_rounds?: number
  /** Stop when critical + important gaps are at or below this (default 2) */
  max_high_severity_gaps?: number
  /** Stop when pass rate reaches this (0–1) on the last executed batch (default 0.92) */
  target_pass_rate?: number
  /** Max gap-derived scenarios per follow-up round (default 12) */
  scenarios_per_round?: number
}

const DEFAULTS: Required<ConvergeOptions> = {
  max_followup_rounds: 4,
  max_high_severity_gaps: 2,
  target_pass_rate: 0.92,
  scenarios_per_round: 12,
}

let scenarioSeq = 0

/** Heuristic: natural-language gap steps → executable TestStep (generic, not app-specific). */
export function gapStepsToTestSteps(steps: string[], route: string, _baseUrl: string): TestStep[] {
  const out: TestStep[] = []
  for (const raw of steps) {
    const line = raw.trim()
    if (!line) continue

    const nav = line.match(/^navigate to\s+(\S+)/i)
    if (nav) {
      let p = nav[1]
      if (!p.startsWith('/')) p = `/${p}`
      out.push({ action: 'navigate', url: p, description: line })
      continue
    }

    const clickQuoted = line.match(/^click\s+"([^"]+)"/i)
    if (clickQuoted) {
      out.push({ action: 'click', selector: `text=${clickQuoted[1]}`, description: line })
      continue
    }

    const clickBare = line.match(/^click\s+([^\s"].+)$/i)
    if (clickBare && !line.toLowerCase().includes('verify')) {
      out.push({ action: 'click', selector: `text=${clickBare[1].trim()}`, description: line })
      continue
    }

    const fillQ = line.match(/^fill\s+"([^"]+)"\s+with\s+(.+)$/i)
    if (fillQ) {
      const label = fillQ[1]
      let val = fillQ[2].trim()
      if (/test data/i.test(val)) val = `Test ${label.slice(0, 20)}`
      out.push({
        action: 'fill',
        selector: `label=${label}`,
        value: val.replace(/^["']|["']$/g, ''),
        description: line,
      })
      continue
    }

    if (/^fill\s+"/i.test(line)) {
      const m = line.match(/^fill\s+"([^"]+)"/i)
      if (m) {
        out.push({
          action: 'fill',
          selector: `label=${m[1]}`,
          value: `test-${Date.now().toString(36)}`,
          description: line,
        })
      }
      continue
    }

    if (/submit|save changes|confirm/i.test(line) && /click/i.test(line)) {
      out.push({ action: 'click', selector: 'button[type="submit"]', description: line })
      continue
    }

    if (/^save changes$/i.test(line)) {
      out.push({ action: 'click', selector: 'button[type="submit"]', description: line })
      continue
    }

    if (/^verify|^ensure|^check/i.test(line)) {
      out.push({ action: 'wait', value: '1200', description: line })
      continue
    }

    if (/^trigger|^locate|^test interaction/i.test(line)) {
      out.push({ action: 'wait', value: '800', description: line })
      continue
    }
  }

  if (out.length === 0) {
    out.push({ action: 'navigate', url: route, description: `Open ${route}` })
    out.push({ action: 'wait', value: '1500', description: 'Observe page' })
  }

  return out
}

export function scenarioFromGap(gap: CoverageGapSuggestion, baseUrl: string): TestScenario | null {
  const steps = gapStepsToTestSteps(gap.suggested_test.steps, gap.route, baseUrl)
  if (steps.length === 0) return null

  const needsAuth = !/\/(login|register|forgot-password|reset-password|privacy)\b/i.test(gap.route)

  scenarioSeq += 1
  return {
    id: `VTC-${scenarioSeq}`,
    name: `[converge] ${gap.suggested_test.name}`,
    route: gap.route,
    priority: gap.severity === 'critical' ? 'high' : gap.severity === 'important' ? 'medium' : 'low',
    steps,
    expected_outcome: gap.missing.slice(0, 200),
    is_gap: true,
    generated_by: 'heuristic',
    requires_auth: needsAuth,
  }
}

function minimalLoginScenario(config: VibeConfig): TestScenario | null {
  if (config.auth?.strategy !== 'credentials' || !config.auth.credentials) return null
  const loginPath = config.auth.login_url ?? '/login'
  return {
    id: 'vibe-converge-session-login',
    name: 'Converge — establish session (login)',
    route: loginPath,
    priority: 'high',
    requires_auth: false,
    steps: [
      { action: 'navigate', url: loginPath, description: 'Open login page' },
      {
        action: 'fill',
        selector: '[type="email"], [name="email"]',
        value: config.auth.credentials.email,
        description: 'Fill email',
      },
      {
        action: 'fill',
        selector: '[type="password"], [name="password"]',
        value: config.auth.credentials.password,
        description: 'Fill password',
      },
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit login' },
      { action: 'wait', value: '2500', description: 'Wait for redirect' },
    ],
    expected_outcome: 'Authenticated session',
    is_gap: false,
    generated_by: 'heuristic',
  }
}

function severityOrder(g: CoverageGapSuggestion): number {
  if (g.severity === 'critical') return 0
  if (g.severity === 'important') return 1
  return 2
}

function buildFollowUpBatch(
  gaps: CoverageGapSuggestion[],
  failed: TestResult[],
  config: VibeConfig,
  limit: number
): TestScenario[] {
  const sorted = [...gaps].sort((a, b) => severityOrder(a) - severityOrder(b))
  const fromGaps: TestScenario[] = []
  const seen = new Set<string>()
  for (const g of sorted) {
    if (fromGaps.length >= limit) break
    const sc = scenarioFromGap(g, config.url)
    if (!sc) continue
    const key = `${sc.route}:${sc.name}`
    if (seen.has(key)) continue
    seen.add(key)
    fromGaps.push(sc)
  }

  const retests: TestScenario[] = []
  for (const r of failed) {
    if (retests.length + fromGaps.length >= limit + 8) break
    if (r.status === 'pass') continue
    const s = r.scenario
    if (s.id.startsWith('VTC-') && s.name.includes('[converge]')) continue
    retests.push({
      ...s,
      id: `${s.id}-retest`,
      name: `${s.name} (retest)`,
    })
  }

  const batch = [...fromGaps, ...retests]
  const anyAuth = batch.some(s => s.requires_auth)
  const hasLogin = batch.some(s => /login|sign in/i.test(s.name) && s.steps.some(t => t.action === 'fill'))
  const login = minimalLoginScenario(config)
  if (anyAuth && login && !hasLogin) {
    return [login, ...batch]
  }
  return batch
}

function mergeExplorations(a: PageExploration[], b: PageExploration[]): PageExploration[] {
  const byRoute = new Map<string, PageExploration>()
  for (const e of [...a, ...b]) {
    const prev = byRoute.get(e.route)
    if (!prev || e.interactions.length >= prev.interactions.length) byRoute.set(e.route, e)
  }
  return [...byRoute.values()]
}

function passRate(results: TestResult[]): number {
  if (results.length === 0) return 1
  return results.filter(r => r.status === 'pass').length / results.length
}

function highSeverityCount(gaps: CoverageGapSuggestion[]): number {
  return gaps.filter(g => g.severity === 'critical' || g.severity === 'important').length
}

/**
 * Full pipeline: initial run-equivalent (build model → execute all scenarios → explore),
 * then repeated follow-up rounds executing gap-derived + failed-retest scenarios until
 * thresholds are met or no progress.
 */
export async function runConverge(
  config: VibeConfig,
  opts?: ConvergeOptions
): Promise<{
  rounds: number
  final_gaps: CoverageGapSuggestion[]
  last_pass_rate: number
  total_results: TestResult[]
  explorations: PageExploration[]
}> {
  const o = { ...DEFAULTS, ...opts }
  const projectRoot = config.codebase_path ?? process.cwd()
  const memory = new MemoryManager(projectRoot)
  await memory.load()
  const recs = memory.getRecommendations()
  const guidance = await readVibeGuidance(projectRoot)

  logger.section('Converge — iterative coverage expansion')
  logger.info(`Follow-up rounds: up to ${o.max_followup_rounds}, target pass rate: ${(o.target_pass_rate * 100).toFixed(0)}%`)

  const productModel = await buildProductModel(config, memory.getMemory(), recs)
  if (productModel.scenarios.length === 0) {
    logger.warn('No scenarios generated — aborting converge')
    return { rounds: 0, final_gaps: [], last_pass_rate: 0, total_results: [], explorations: [] }
  }

  let explorations: PageExploration[] = []
  let allResults: TestResult[] = []
  let lastGaps: CoverageGapSuggestion[] = []

  // Round 1: baseline (full scenario list)
  logger.section('Round 1 — baseline scenarios')
  const first = await executeScenarios(productModel.scenarios, config, projectRoot, guidance)
  explorations = first.explorations
  allResults.push(...first.results)
  await memory.updateFromResults(first.results)
  lastGaps = generateCoverageGaps(productModel.behaviours, explorations)

  let high = highSeverityCount(lastGaps)
  const baselinePr = passRate(first.results)
  logger.info(`  Gaps: ${lastGaps.length} total (${high} critical/important), pass rate: ${(baselinePr * 100).toFixed(0)}%`)

  let followUps = 0
  if (high <= o.max_high_severity_gaps && baselinePr >= o.target_pass_rate) {
    logger.success('Coverage threshold already met after baseline')
  } else {
    while (followUps < o.max_followup_rounds) {
      const followUp = buildFollowUpBatch(lastGaps, allResults.filter(r => r.status !== 'pass'), config, o.scenarios_per_round)
      if (followUp.length === 0) {
        logger.info('No follow-up scenarios produced — stopping')
        break
      }

      followUps++
      logger.section(`Round ${followUps + 1} — ${followUp.length} gap / retest scenario(s)`)

      const ex = await executeScenarios(followUp, config, projectRoot, guidance)
      explorations = mergeExplorations(explorations, ex.explorations)
      allResults.push(...ex.results)
      await memory.updateFromResults(ex.results)

      lastGaps = generateCoverageGaps(productModel.behaviours, explorations)
      high = highSeverityCount(lastGaps)
      const pr = passRate(ex.results)
      logger.info(`  Batch pass rate: ${(pr * 100).toFixed(0)}%, gaps: ${lastGaps.length} (${high} critical/important)`)

      if (high <= o.max_high_severity_gaps && pr >= o.target_pass_rate) {
        logger.success('Thresholds met — stopping converge')
        break
      }
    }
  }

  logger.section('Converge complete')
  logger.dim(`  Total scenario executions logged: ${allResults.length}`)
  logger.dim(`  Remaining gaps: ${lastGaps.length}`)

  return {
    rounds: 1 + followUps,
    final_gaps: lastGaps,
    last_pass_rate: passRate(allResults),
    total_results: allResults,
    explorations,
  }
}
