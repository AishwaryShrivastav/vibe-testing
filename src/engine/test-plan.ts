import path from 'node:path'
import type { PlanPage, PlanSummary, ProductModel, TestScenario } from '../types/index.js'

export type { PlanPage, PlanSummary }
import type { RunMode, VibeConfig } from '../types/config.js'
import type { PageExploration } from './browser/explorer.js'
import { DEPTH_RANK, type Depth, type DepthDecision } from './browser/depth.js'
import { describeFingerprintChange } from './browser/fingerprint.js'
import { changedFilesSince, impactOfChanges, routePatternRegex } from './context/change-impact.js'
import { readBaseline, readFingerprints, type FingerprintStore } from './memory/baseline.js'

/**
 * Turns `mode` into a depth per page.
 *   deep    → every page thorough
 *   fast    → every page light
 *   auto    → changed pages thorough, affected pages standard, the rest light
 *   changed → changed and affected pages thorough, the rest skipped
 * "Changed" comes from the code (version control + import graph) when routes
 * come from source files, else from page fingerprints saved by the last run.
 * Without a baseline (first run) auto/changed behave like deep.
 */
export interface TestPlan {
  mode: RunMode
  /** What the depths are based on. */
  basis: 'every page' | 'code changes' | 'page fingerprints'
  since?: string
  /** Changed files, relative to the repository root. */
  changedFiles?: string[]
  notes: string[]
  /** Depth for a route, or "skip". */
  decide: (route: string) => DepthDecision | 'skip'
  /** Route pattern a concrete route belongs to (for same-template grouping). */
  templateOf: (route: string) => string | undefined
  /** After a light/standard pass: a reason to test the page thoroughly now. */
  recheck?: (exploration: PageExploration) => string | undefined
  /** Run the session checks (logout round-trip, cross-user access) after exploring? */
  sessionChecks: (explorations: PageExploration[]) => boolean
}

const routeKey = (route: string) => route.split('?')[0].replace(/\/+$/, '') || '/'

function templateFinder(model: ProductModel): (route: string) => string | undefined {
  const patterns = model.routes
    .filter(route => route.type === 'page' && /\[[^\]]+\]|(?:^|\/):[A-Za-z_$]|\*/.test(route.path))
    .map(route => ({ path: route.path, regex: routePatternRegex(route.path) }))
  return (route: string) => patterns.find(pattern => pattern.regex.test(routeKey(route)))?.path
}

/** A plan with one depth for every page (deep, fast, and auto/changed without a baseline). */
function uniformPlan(mode: RunMode, model: ProductModel | undefined, depth: Depth, reason: string, notes: string[] = []): TestPlan {
  return {
    mode,
    basis: 'every page',
    notes,
    decide: () => ({ depth, reason }),
    templateOf: model ? templateFinder(model) : () => undefined,
    sessionChecks: () => depth === 'thorough',
  }
}

/** The plan without change detection: deep → thorough, fast → light (used by converge and as a default). */
export function basicPlan(mode: RunMode, model?: ProductModel): TestPlan {
  if (mode === 'fast') return uniformPlan(mode, model, 'light', 'fast mode: light checks only', ['fast mode: no clicks, submissions or session checks'])
  return uniformPlan(mode, model, 'thorough', 'every page thoroughly')
}

export async function planRun(config: VibeConfig, model: ProductModel, projectRoot: string): Promise<TestPlan> {
  const mode = config.mode ?? 'deep'
  if (mode === 'deep' || mode === 'fast') return basicPlan(mode, model)

  const vibeDir = path.join(projectRoot, '.vibe')
  const baseline = await readBaseline(vibeDir)
  const fingerprints = await readFingerprints(vibeDir)
  const templateOf = templateFinder(model)
  const codePages = model.routes.filter(route => route.type === 'page' && route.origin !== 'live-crawl' && route.file_path)

  // ── Code-aware: what changed in the source ──
  if (codePages.length > 0) {
    const since = config.scope?.since ?? baseline?.commit
    const changes = await changedFilesSince(config.codebase_path ?? projectRoot, since)
    if (!changes.ok) {
      return uniformPlan(mode, model, 'thorough', `every page thoroughly (${changes.note})`, [`${mode} mode: ${changes.note}; testing every page thoroughly`])
    }
    const pageApis = Object.fromEntries(Object.entries(fingerprints ?? {}).map(([route, fp]) => [route, fp.apis ?? []]))
    const impact = await impactOfChanges(model.routes, changes.files, changes.root!, pageApis)
    const relative = changes.files.map(file => path.relative(changes.root!, file))
    const notes: string[] = []
    if (relative.length === 0) notes.push(`no changes since ${shortRef(changes.since!)}`)
    if (impact.unused.length > 0) notes.push(`${impact.unused.length} changed file(s) not used by any page: ${impact.unused.slice(0, 5).join(', ')}${impact.unused.length > 5 ? ', …' : ''}`)
    if (impact.shared) notes.push(`shared file changed (${impact.shared}): every page at least standard`)

    const decide = (route: string): DepthDecision | 'skip' => {
      const key = routeKey(route)
      const own = impact.pages.get(route) ?? impact.pages.get(key) ?? (() => {
        const pattern = templateOf(route)
        return pattern ? impact.pages.get(pattern) : undefined
      })()
      if (own) {
        if (mode === 'changed') return { depth: 'thorough', reason: own.reason }
        return own
      }
      return mode === 'changed' ? 'skip' : { depth: 'light', reason: 'unchanged' }
    }
    return {
      mode,
      basis: 'code changes',
      since: changes.since,
      changedFiles: relative,
      notes,
      decide,
      templateOf,
      sessionChecks: explorations => explorations.some(e => e.depth === 'thorough'),
    }
  }

  // ── Black-box: what changed on the pages ──
  if (!fingerprints || Object.keys(fingerprints).length === 0) {
    return uniformPlan(mode, model, 'thorough', 'every page thoroughly (no saved page fingerprints yet: first run)', [`${mode} mode: no saved page fingerprints yet (first run); testing every page thoroughly`])
  }
  const notes = [`${mode} mode without source code: every page gets a light visit; pages whose structure changed since the last run are tested thoroughly`]
  if (mode === 'changed') notes.push('black-box "changed" behaves like "auto": spotting a changed page needs a light visit')
  return {
    mode,
    basis: 'page fingerprints',
    since: baseline?.at,
    notes,
    decide: () => ({ depth: 'light', reason: 'unchanged since the last run' }),
    templateOf,
    recheck: exploration => fingerprintChange(fingerprints, exploration),
    sessionChecks: explorations => explorations.some(e => e.depth === 'thorough'),
  }
}

export function fingerprintChange(store: FingerprintStore, exploration: PageExploration): string | undefined {
  if (!exploration.fingerprint) return undefined
  const previous = store[exploration.route]
  if (!previous) return 'new page since the last run'
  const change = describeFingerprintChange(previous, exploration.fingerprint)
  return change ? `changed since the last run: ${change}` : undefined
}

function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 8) : ref
}

/** Interactive steps (fill/click/…) aren't run on light pages. */
function isSmoke(scenario: TestScenario): boolean {
  return scenario.steps.every(step => step.action === 'navigate' || step.action === 'wait' || step.action === 'assert')
}

/** Login scenarios stay: the runner may need them to sign in. */
function isLogin(scenario: TestScenario): boolean {
  const name = scenario.name.toLowerCase()
  return scenario.steps.some(step => step.action === 'fill') && (name.includes('login') || name.includes('sign in'))
}

/**
 * Scenarios the plan keeps: everything for standard/thorough pages, smoke
 * checks only for light pages, nothing for skipped pages (login scenarios
 * always stay).
 */
export function scenariosForPlan(scenarios: TestScenario[], plan: TestPlan): { kept: TestScenario[]; dropped: number } {
  const kept = scenarios.filter(scenario => {
    if (isLogin(scenario)) return true
    const decision = plan.decide(scenario.route)
    if (decision === 'skip') return false
    return decision.depth !== 'light' || isSmoke(scenario)
  })
  return { kept, dropped: scenarios.length - kept.length }
}

/** What each page got and why: from the explorations, plus pages the plan skipped. */
export function summarisePlan(plan: TestPlan, explorations: PageExploration[], skipped: string[]): PlanSummary {
  const byRoute = new Map<string, PlanPage>()
  for (const exploration of explorations) {
    if (exploration.redirected_to && byRoute.has(exploration.route)) continue
    const depth = exploration.depth ?? 'thorough'
    const existing = byRoute.get(exploration.route)
    if (existing && existing.depth !== 'skipped' && DEPTH_RANK[existing.depth] > DEPTH_RANK[depth] && !exploration.signed_in) continue
    byRoute.set(exploration.route, { route: exploration.route, depth, reason: exploration.redirected_to ? `${exploration.depth_reason ?? ''} (sign-in required)`.trim() : exploration.depth_reason ?? '' })
  }
  for (const route of skipped) {
    if (!byRoute.has(route)) byRoute.set(route, { route, depth: 'skipped', reason: plan.mode === 'changed' ? 'unchanged (mode changed)' : 'not planned' })
  }
  const pages = [...byRoute.values()]
  const counts = { thorough: 0, standard: 0, light: 0, skipped: 0 }
  for (const page of pages) counts[page.depth]++
  return {
    mode: plan.mode,
    basis: plan.basis,
    ...(plan.since ? { since: plan.since } : {}),
    ...(plan.changedFiles ? { changed_files: plan.changedFiles } : {}),
    notes: plan.notes,
    counts,
    pages,
  }
}
