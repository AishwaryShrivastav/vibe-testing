import type { FailedScenario } from './engine/findings.js'
import type { PlanSummary } from './types/index.js'

/** Everything a run found, as returned in VibeRunResult.summary (all optional). */
export interface RunFindings {
  failed_scenarios?: FailedScenario[]
  explorer_failures?: string[]
  explorer_warnings?: string[]
  retry_findings?: string[]
  app_changes?: string[]
}

/**
 * The isError rule shared by every MCP tool that reports a run: a failed or
 * errored scenario, or a real problem found while exploring (server error,
 * console error, broken value, functional failure). Retry findings, warnings
 * and app changes never fail a run on their own; the text calls retries out
 * under "Needs attention" instead.
 */
export function runHasFailures(findings: RunFindings): boolean {
  return (findings.failed_scenarios?.length ?? 0) > 0 || (findings.explorer_failures?.length ?? 0) > 0
}

const MAX_FAILED = 15
const MAX_LINES = 10

/**
 * Findings sections for a run summary, most actionable first: failed
 * scenarios, problems found while exploring, needs attention (retries),
 * warnings, then changes made to the app. Each starts with "\n- ".
 */
export function formatRunFindings(findings: RunFindings): string {
  return [
    formatFailedScenarios(findings.failed_scenarios),
    section('Problems found while exploring (server errors, console errors, broken values, functional failures)', findings.explorer_failures, 220),
    section('Needs attention: only succeeded on retry (inconsistent behaviour; not counted as a failure)', findings.retry_findings, 260),
    section('Warnings (possible missing data, not counted as failures)', findings.explorer_warnings, 220),
    section('Changes made to the app while exploring (data-changing requests; clean up if needed)', findings.app_changes, 260),
  ].join('')
}

/**
 * The test plan in a few lines: mode, what it was based on, counts per depth,
 * then every page that wasn't simply "light: unchanged" with its reason.
 * Starts with "\n- "; empty without a plan.
 */
export function formatPlan(plan: PlanSummary | undefined): string {
  if (!plan) return ''
  const counts = (['thorough', 'standard', 'light', 'skipped'] as const)
    .filter(depth => plan.counts[depth] > 0)
    .map(depth => `${plan.counts[depth]} ${depth}`)
    .join(', ') || 'no pages'
  const since = plan.since ? ` since ${/^[0-9a-f]{40}$/.test(plan.since) ? plan.since.slice(0, 8) : plan.since}` : ''
  const order: Record<string, number> = { thorough: 0, standard: 1, light: 2, skipped: 3 }
  const notable = plan.pages
    // The default reasons ("every page thoroughly", "unchanged", "fast mode…") add nothing per page.
    .filter(page => page.depth !== 'skipped' && !/^(every page thoroughly|unchanged|fast mode)/.test(page.reason))
    .sort((a, b) => order[a.depth] - order[b.depth])
  const shown = notable.slice(0, MAX_LINES).map(page => `  - ${page.depth} ${page.route}: ${page.reason.slice(0, 160)}`)
  if (notable.length > MAX_LINES) shown.push(`  - …and ${notable.length - MAX_LINES} more (see report)`)
  const changed = plan.changed_files?.length
    ? [`  - changed files (${plan.changed_files.length}): ${plan.changed_files.slice(0, 6).join(', ')}${plan.changed_files.length > 6 ? ', …' : ''}`]
    : []
  const skippedRoutes = plan.pages.filter(page => page.depth === 'skipped').map(page => page.route)
  const skipped = skippedRoutes.length
    ? [`  - skipped (${skippedRoutes.length}): ${skippedRoutes.slice(0, 8).join(', ')}${skippedRoutes.length > 8 ? ', …' : ''}`]
    : []
  const notes = plan.notes.slice(0, 4).map(note => `  - note: ${note.slice(0, 200)}`)
  const lines = [...changed, ...shown, ...skipped, ...notes]
  return `\n- Test plan: mode ${plan.mode} (${plan.basis}${since}): ${counts}${lines.length ? `\n${lines.join('\n')}` : ''}`
}

function formatFailedScenarios(failed: FailedScenario[] | undefined): string {
  if (!failed?.length) return ''
  const shown = failed.slice(0, MAX_FAILED)
    .map(f => `  - ${f.status === 'error' ? '[error] ' : ''}${f.name} (${f.route}): ${f.reason}`)
    .join('\n')
  const more = failed.length > MAX_FAILED ? `\n  - …and ${failed.length - MAX_FAILED} more (see report)` : ''
  return `\n- Failed scenarios: ${failed.length}\n${shown}${more}`
}

function section(title: string, lines: string[] | undefined, width: number): string {
  if (!lines?.length) return ''
  const shown = lines.slice(0, MAX_LINES).map(line => `  - ${line.slice(0, width)}`).join('\n')
  const more = lines.length > MAX_LINES ? `\n  - …and ${lines.length - MAX_LINES} more (see report)` : ''
  return `\n- ${title}: ${lines.length}\n${shown}${more}`
}
