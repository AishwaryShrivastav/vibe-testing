import { TestResult, ProductModel, CoverageGapSuggestion, VerificationStatus } from '../../types/index.js'
import { VibeConfig } from '../../types/config.js'
import type { MemoryRecommendations } from '../memory/index.js'
import type { PageExploration, InteractionOutcome, ApiObservation } from '../browser/explorer.js'
import packageJson from '../../../package.json' with { type: 'json' }
import fs from 'fs/promises'
import { deriveReportMetrics, formatReportMetrics } from './metrics.js'
import { collectExplorerWarnings, collectRetryFindings, findingKind, groupExplorerFailures, isExplorerFailure, type GroupedFinding } from '../findings.js'
import { PAGE_THUMB, STEP_THUMB, prepareReportImages, type ReportImage } from './images.js'
import path from 'path'

export interface ReportFindings {
  /**
   * Logins and scenarios that only succeeded on a retry. Defaults to the
   * scenario retries in `results`; pass it to include login/crawl retries.
   */
  retryFindings?: string[]
  /**
   * Wall-clock duration of the whole run (scan, scenarios, exploration and
   * checks). Without it the header shows the time spent in scenarios only,
   * labelled as such.
   */
  durationMs?: number
  /**
   * Folder the report is written to. Full-size screenshots under it are linked
   * relative to the report; defaults to <codebase>/.vibe.
   */
  reportDir?: string
}

type ImageMap = Map<string, ReportImage>

export async function generateHtmlReport(
  results: TestResult[],
  productModel: ProductModel,
  config: VibeConfig,
  explorations: PageExploration[],
  coverageGaps: CoverageGapSuggestion[],
  recommendations?: MemoryRecommendations,
  findings: ReportFindings = {},
): Promise<string> {
  const metrics = deriveReportMetrics(productModel, results, explorations)
  const explorerFailures = groupExplorerFailures(explorations)
  const explorerWarnings = collectExplorerWarnings(explorations)
  const retryFindings = findings.retryFindings ?? collectRetryFindings(results)
  const passed  = results.filter(r => r.status === 'pass')
  const failed  = results.filter(r => r.status === 'fail')
  const errored = results.filter(r => r.status === 'error')
  const totalMs = results.reduce((sum, r) => sum + r.duration_ms, 0)
  const outcomeVerified = results.filter(r => r.verification_status === 'outcome_verified')
  const smokeChecks = results.filter(r => r.verification_status === 'smoke_check_passed')
  const notVerified = results.filter(r => !r.verification_status || r.verification_status === 'not_verified')

  const totalElements = explorations.reduce((s, e) => s + e.elements_discovered, 0)
  const totalApis = explorations.reduce((s, e) => s + e.api_calls.length, 0)
  const apiErrors = explorations.reduce((s, e) => s + e.api_calls.filter(a => a.isError).length, 0)
  const brokenElements = explorations.reduce((s, e) => s + e.interactions.filter(i => i.result === 'error').length, 0)

  // Screenshots: small embedded JPEG thumbnails, full-size files linked.
  const reportDir = findings.reportDir ?? (config.codebase_path ? path.join(config.codebase_path, '.vibe') : undefined)
  const images = await prepareReportImages([
    ...results.flatMap(r => [
      ...(r.screenshot_path ? [{ path: r.screenshot_path, size: PAGE_THUMB }] : []),
      ...(r.step_logs ?? []).flatMap(log => log.screenshot_path ? [{ path: log.screenshot_path, size: STEP_THUMB }] : []),
    ]),
    ...explorations.flatMap(e => e.screenshot_path ? [{ path: e.screenshot_path, size: PAGE_THUMB }] : []),
  ], reportDir)

  const changesCount = explorations.reduce((sum, e) => sum + (e.changes?.length ?? 0), 0)
  const durationTile = findings.durationMs !== undefined
    ? `<div class="meta-item"><div class="label">Duration</div><div class="value">${formatDuration(findings.durationMs)}</div><div class="sub">scenarios ${formatDuration(totalMs)}</div></div>`
    : `<div class="meta-item"><div class="label">Scenario time</div><div class="value">${formatDuration(totalMs)}</div><div class="sub">excludes exploration</div></div>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Vibe Test Report — ${productModel.project_name}</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="container">

<header>
  <h1>Vibe Test Report</h1>
  <p>${productModel.project_name} &middot; ${config.url} &middot; ${new Date().toLocaleString()}</p>
  <div class="meta-grid">
    <div class="meta-item"><div class="label">Framework</div><div class="value">${productModel.framework}</div></div>
    <div class="meta-item"><div class="label">Static routes discovered</div><div class="value">${metrics.staticRoutesDiscovered}</div></div>
    <div class="meta-item"><div class="label">Live pages observed</div><div class="value">${metrics.livePagesObserved}</div></div>
    <div class="meta-item"><div class="label">Scenarios executed</div><div class="value">${metrics.scenariosExecuted}</div></div>
    <div class="meta-item"><div class="label">Elements</div><div class="value">${totalElements}</div></div>
    <div class="meta-item"><div class="label">API Calls</div><div class="value">${totalApis}${apiErrors > 0 ? ` <span style="color:var(--fail)">(${apiErrors} errors)</span>` : ''}</div></div>
    ${durationTile}
  </div>
  <p class="metric-summary">${formatReportMetrics(metrics)}</p>
</header>

${renderBugsFound([...failed, ...errored], explorerFailures, { warnings: explorerWarnings.length, retries: retryFindings.length, changes: changesCount })}

<div class="summary-groups">
  <div class="summary-group">
    <div class="group-label">Scenarios</div>
    <div class="summary-bar">
      <div class="summary-stat pass"><div class="num">${metrics.scenariosPassed}</div><div class="lbl">Passed</div></div>
      <div class="summary-stat fail"><div class="num">${metrics.scenariosFailed}</div><div class="lbl">Failed</div></div>
      <div class="summary-stat error"><div class="num">${errored.length}</div><div class="lbl">Errors</div></div>
      <div class="summary-stat skip"><div class="num">${metrics.scenariosSkipped}</div><div class="lbl">Skipped</div></div>
    </div>
  </div>
  <div class="summary-group">
    <div class="group-label">How passes were verified</div>
    <div class="summary-bar">
      <div class="summary-stat outcome"><div class="num">${outcomeVerified.length}</div><div class="lbl">Outcome verified</div></div>
      <div class="summary-stat smoke"><div class="num">${smokeChecks.length}</div><div class="lbl">Smoke check passed</div></div>
      <div class="summary-stat not"><div class="num">${notVerified.length}</div><div class="lbl">Not verified</div></div>
    </div>
  </div>
  <div class="summary-group">
    <div class="group-label">Exploration</div>
    <div class="summary-bar">
      <div class="summary-stat ${explorerFailures.length > 0 ? 'fail' : 'skip'}"><div class="num">${explorerFailures.length}</div><div class="lbl">Problems found</div></div>
      <div class="summary-stat ${explorerWarnings.length + retryFindings.length > 0 ? 'error' : 'skip'}"><div class="num">${explorerWarnings.length + retryFindings.length}</div><div class="lbl">Warnings</div></div>
      <div class="summary-stat ${changesCount > 0 ? 'smoke' : 'skip'}"><div class="num">${changesCount}</div><div class="lbl">Changes made</div></div>
    </div>
  </div>
</div>

${renderWarningsSection(retryFindings, explorerWarnings)}

${renderAppChangesSection(explorations)}

${failed.length + errored.length > 0 ? `<h2>Failures & Errors</h2>\n${[...failed, ...errored].map(r => renderScenarioCard(r, images)).join('\n')}` : ''}

${passed.length > 0 ? `<h2>Passed Scenarios</h2>\n${passed.map(r => renderScenarioCard(r, images)).join('\n')}` : ''}

${explorations.length > 0 ? renderExplorationSection(explorations, images) : ''}

${coverageGaps.length > 0 ? renderCoverageGapsSection(coverageGaps) : ''}

${renderApiSection(explorations)}

${renderCoverageTable(productModel)}

${renderIntelligenceSection(recommendations)}

<footer>Generated by <strong>vibe-test</strong> v${packageJson.version} — No external LLM used</footer>
</div>

<div class="screenshot-modal" id="screenshotModal">
  <img id="modalImg" src="" alt="enlarged">
</div>

<script>
document.querySelectorAll('.card-header').forEach(h => {
  h.addEventListener('click', () => h.closest('.card').classList.toggle('open'))
})
// Enlarge a screenshot on click: load the full-size file (falls back to the thumbnail)
document.querySelectorAll('.zoomable').forEach(img => {
  img.addEventListener('click', e => {
    e.preventDefault()
    e.stopPropagation()
    const modal = document.getElementById('screenshotModal')
    const modalImg = document.getElementById('modalImg')
    modalImg.onerror = () => { modalImg.onerror = null; modalImg.src = img.src }
    modalImg.src = img.dataset.full || img.src
    modal.classList.add('active')
  })
})
document.getElementById('screenshotModal').addEventListener('click', () => {
  document.getElementById('screenshotModal').classList.remove('active')
})
</script>
</body>
</html>`
}

// ─── Bugs Found (top of the report) ───────────────────────────────────────────

/** The kind badge already names it: "Console error: X" reads as "X", "Checkout (click): Empty-state action: X" as "Checkout (click): X". */
function withoutKind(finding: string, kind: string): string {
  return finding.replace(new RegExp(`(^|: )${kind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `), '$1')
}

/** A verdict as one trimmed line for the summary. */
function oneLine(text: string, max = 220): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Everything that is a bug, in one place, first: failed and errored scenarios
 * (name, route, one-line reason) and explorer problems grouped by kind with the
 * pages they were seen on. Details stay in the sections below.
 */
function renderBugsFound(
  failedScenarios: TestResult[],
  failures: GroupedFinding[],
  counts: { warnings: number; retries: number; changes: number },
): string {
  const total = failedScenarios.length + failures.length
  const pointers = [
    counts.retries > 0 ? `${counts.retries} passed only on retry` : '',
    counts.warnings > 0 ? `${counts.warnings} warning${counts.warnings > 1 ? 's' : ''}` : '',
    counts.changes > 0 ? `${counts.changes} change${counts.changes > 1 ? 's' : ''} made to the app` : '',
  ].filter(Boolean)
  const pointerLine = pointers.length > 0
    ? `<p class="section-note bugs-also">Also: ${pointers.map(p => esc(p)).join(' &middot; ')} (see below).</p>`
    : ''

  if (total === 0) {
    return `<h2 id="bugs-found">Bugs Found</h2>
  <div class="bugs-none">No failing scenarios and no problems found while exploring.</div>
  ${pointerLine}`
  }

  const scenarioRows = failedScenarios.map(r => `<tr>
      <td><span class="badge ${r.status === 'error' ? 'error' : 'fail'}">${r.status === 'error' ? 'Scenario error' : 'Scenario failed'}</span></td>
      <td class="finding-text"><strong>${esc(r.scenario.name)}</strong><br>${esc(oneLine(r.ai_verdict ?? r.failure_reason ?? ''))}</td>
      <td><code>${esc(r.scenario.route)}</code></td>
    </tr>`)

  const byKind = new Map<string, GroupedFinding[]>()
  for (const failure of failures) {
    const kind = findingKind(failure.finding)
    byKind.set(kind, [...(byKind.get(kind) ?? []), failure])
  }
  const problemRows = [...byKind].flatMap(([kind, group]) => group.map(({ finding, routes }) => `<tr>
      <td><span class="badge fail">${esc(kind)}</span></td>
      <td class="finding-text">${esc(withoutKind(finding, kind))}</td>
      <td>${routes.map(r => `<code>${esc(r)}</code>`).join(' ')}</td>
    </tr>`))

  const parts = [
    failedScenarios.length > 0 ? `${failedScenarios.length} failing scenario${failedScenarios.length > 1 ? 's' : ''}` : '',
    failures.length > 0 ? `${failures.length} problem${failures.length > 1 ? 's' : ''} found while exploring` : '',
  ].filter(Boolean).join(' and ')

  return `<h2 id="bugs-found">Bugs Found (${total})</h2>
  <p class="section-note">${esc(parts)}. Explorer problems come from built-in checks (server errors, console errors, broken values and resources, empty-state actions, created values that never appear, totals that don't add up) outside the scripted scenarios.</p>
  <div class="section-table findings-table bugs-table"><table>
    <thead><tr><th>Kind</th><th>Finding</th><th>Pages</th></tr></thead>
    <tbody>${[...scenarioRows, ...problemRows].join('\n')}</tbody>
  </table></div>
  ${pointerLine}`
}

// ─── Warnings ────────────────────────────────────────────────────────────────

/** Operations that only passed on a retry, and lower-confidence findings. They don't fail the run. */
function renderWarningsSection(retryFindings: string[], warnings: string[]): string {
  const rows = [
    ...retryFindings.map(finding => ({ kind: 'Passed on retry', finding })),
    ...warnings.map(finding => ({ kind: findingKind(finding), finding })),
  ]
  if (rows.length === 0) return ''
  return `<h2 class="warn-heading">Warnings (${rows.length})</h2>
  <p class="section-note">Inconsistent behaviour and lower-confidence findings. They do not fail the run but are worth a look.</p>
  <div class="section-table findings-table"><table>
    <thead><tr><th>Kind</th><th>Finding</th></tr></thead>
    <tbody>${rows.map(({ kind, finding }) => `<tr>
      <td><span class="badge medium">${esc(kind)}</span></td>
      <td class="finding-text">${esc(withoutKind(finding, kind))}</td>
    </tr>`).join('\n')}</tbody>
  </table></div>`
}

/** A thumbnail linked to the full-size screenshot; clicking enlarges it. */
function screenshotFigure(image: ReportImage | undefined, label: string, alt: string): string {
  if (!image) return ''
  return `
    <div class="screenshot-container">
      <div class="screenshot-label">${esc(label)} &middot; <a href="${esc(image.full)}" target="_blank" rel="noopener">full size</a></div>
      <img src="${esc(image.thumb ?? image.full)}" data-full="${esc(image.full)}" alt="${esc(alt)}" class="zoomable screenshot-thumb" loading="lazy">
    </div>`
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`
}

// ─── Changes Made to the App ──────────────────────────────────────────────────

/**
 * Every data-changing request exploration made (records created, forms saved),
 * so the user knows what to clean up. Repeats of the same request by the same
 * action on a page are one row with a count.
 */
function renderAppChangesSection(explorations: PageExploration[]): string {
  const rows = new Map<string, { route: string; action: string; request: string; status?: number; values?: string; count: number }>()
  for (const exp of explorations) {
    for (const change of exp.changes ?? []) {
      const key = `${exp.route} ${change.action} ${change.method} ${change.path}`
      const row = rows.get(key)
      if (row) { row.count++; continue }
      rows.set(key, { route: exp.route, action: change.action, request: `${change.method} ${change.path}`, status: change.status, values: change.values, count: 1 })
    }
  }
  if (rows.size === 0) return ''
  const body = [...rows.values()].map(row => `<tr>
      <td><code>${esc(row.route)}</code></td>
      <td>${esc(row.action)}${row.count > 1 ? ` <span class="badge session">×${row.count}</span>` : ''}</td>
      <td><code>${esc(row.request)}</code>${row.status ? ` <span class="badge ${row.status >= 400 ? 'fail' : 'pass'}">${row.status}</span>` : ''}</td>
      <td class="finding-text">${esc(row.values ?? '')}</td>
    </tr>`).join('\n')
  return `<h2>Changes Made to the App</h2>
  <p class="section-note">Data-changing requests the explorer sent while testing (${rows.size}). Records it created and forms it saved stay in the app, so clean them up on a shared environment. Set <code>explore.writes</code> to <code>"none"</code> to avoid them, or <code>"all"</code> to also test forms that edit existing data.</p>
  <div class="section-table findings-table"><table>
    <thead><tr><th>Page</th><th>Action</th><th>Request</th><th>Values sent</th></tr></thead>
    <tbody>${body}</tbody>
  </table></div>`
}

// ─── Exploration Section ──────────────────────────────────────────────────────

function renderExplorationSection(explorations: PageExploration[], images: ImageMap): string {
  const bothSessions = explorations.some(e => e.signed_in) && explorations.some(e => !e.signed_in)
  const cards = explorations.map(exp => {
    const working = exp.interactions.filter(i => ['success', 'content_updated', 'dialog_opened', 'navigated', 'toast_shown'].includes(i.result)).length
    const broken = exp.interactions.filter(i => i.result === 'error').length
    const skipped = exp.interactions.filter(i => i.result === 'skipped').length
    const noChange = exp.interactions.filter(i => i.result === 'no_change').length
    const problems = exp.errors.filter(isExplorerFailure)
    const diagnostics = exp.errors.filter(e => !isExplorerFailure(e))
    const warnings = exp.warnings ?? []

    // Logged out, a bounce to sign-in is the page being protected — expected, not broken.
    const signInWall = !!exp.redirected_to && !exp.signed_in
    const statusClass = broken > 0 || problems.length > 0 ? 'fail'
      : warnings.length > 0 || (exp.redirected_to && exp.signed_in) ? 'error'
      : signInWall ? 'skip' : 'pass'
    const sessionTag = bothSessions ? `<span class="badge session">${exp.signed_in ? 'signed in' : 'logged out'}</span>` : ''
    const findingList = (items: string[], cls: string) => items.length === 0 ? '' :
      `<ul class="page-findings ${cls}">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`
    const findingsHtml = findingList(problems, 'fail') + findingList(warnings, 'warn') + findingList(diagnostics, 'dim')

    const interactionRows = exp.interactions.map(i => {
      const icon = i.result === 'success' || i.result === 'content_updated' ? '✅' :
                   i.result === 'dialog_opened' ? '🔲' :
                   i.result === 'navigated' ? '🔗' :
                   i.result === 'toast_shown' ? '💬' :
                   i.result === 'error' ? '❌' :
                   i.result === 'skipped' ? '⏭️' : '⚪'
      return `<tr>
        <td>${icon}</td>
        <td><strong>${esc(i.elementType)}</strong></td>
        <td>${esc(i.element)}</td>
        <td>${esc(i.action)}</td>
        <td><span class="badge ${i.result === 'error' ? 'fail' : i.result === 'skipped' ? 'medium' : 'pass'}">${i.result}</span></td>
        <td style="font-size:12px;color:${i.result === 'error' ? 'var(--fail)' : 'var(--text-dim)'}">${esc(i.result === 'error' ? i.details.slice(0, 240) : i.details.slice(0, 80))}</td>
      </tr>`
    }).join('\n')

    const screenshotHtml = screenshotFigure(exp.screenshot_path ? images.get(exp.screenshot_path) : undefined, 'Page screenshot', exp.route)

    return `<div class="card${broken > 0 || problems.length > 0 ? ' open' : ''}">
    <div class="card-header">
      <div class="status-dot ${statusClass}"></div>
      <div class="title">${esc(exp.route)}</div>
      <div class="meta-tags">
        ${sessionTag}
        ${signInWall ? `<span class="badge session">sign-in required</span>` : `<span class="badge pass">${working} working</span>`}
        ${broken > 0 ? `<span class="badge fail">${broken} broken</span>` : ''}
        ${problems.length > 0 ? `<span class="badge fail">${problems.length} problem${problems.length > 1 ? 's' : ''}</span>` : ''}
        ${warnings.length > 0 ? `<span class="badge medium">${warnings.length} warning${warnings.length > 1 ? 's' : ''}</span>` : ''}
        <span style="font-size:12px;color:var(--text-dim)">${exp.elements_discovered} elements, ${exp.duration_ms}ms</span>
      </div>
      <span class="chevron">▶</span>
    </div>
    <div class="card-body">
      <div class="info-grid">
        <div class="info-item"><span class="info-label">Elements</span><span>${Object.entries(exp.elements_by_type).map(([k, v]) => `${v} ${k}s`).join(', ')}</span></div>
        <div class="info-item"><span class="info-label">API Calls</span><span>${exp.api_calls.length}${exp.api_calls.filter(a => a.isError).length > 0 ? ` (${exp.api_calls.filter(a => a.isError).length} errors)` : ''}</span></div>
      </div>
      ${findingsHtml}
      ${interactionRows ? `<table class="step-table">
        <thead><tr><th></th><th>Type</th><th>Element</th><th>Action</th><th>Result</th><th>Details</th></tr></thead>
        <tbody>${interactionRows}</tbody>
      </table>` : ''}
      ${screenshotHtml}
    </div>
  </div>`
  }).join('\n')

  return `<h2>Element Exploration</h2>\n${cards}`
}

// ─── Coverage Gaps Section ────────────────────────────────────────────────────

function renderCoverageGapsSection(gaps: CoverageGapSuggestion[]): string {
  const critical = gaps.filter(g => g.severity === 'critical')
  const important = gaps.filter(g => g.severity === 'important')
  const niceToHave = gaps.filter(g => g.severity === 'nice_to_have')

  const renderGap = (gap: CoverageGapSuggestion) => {
    const severityClass = gap.severity === 'critical' ? 'fail' : gap.severity === 'important' ? 'medium' : 'pass'
    const steps = gap.suggested_test.steps.map((s, i) => `<li>${esc(s)}</li>`).join('\n')
    return `<div class="card">
    <div class="card-header">
      <div class="status-dot ${severityClass === 'fail' ? 'fail' : severityClass === 'medium' ? 'error' : 'pass'}"></div>
      <div class="title">${esc(gap.missing)}</div>
      <div class="meta-tags">
        <span class="badge ${severityClass}">${gap.severity.replace('_', ' ')}</span>
        <code>${esc(gap.route)}</code>
      </div>
      <span class="chevron">▶</span>
    </div>
    <div class="card-body">
      <div style="margin-bottom:12px;font-weight:600">Suggested test: ${esc(gap.suggested_test.name)}</div>
      <ol style="padding-left:20px;font-size:13px;line-height:2">${steps}</ol>
    </div>
  </div>`
  }

  return `<h2>Coverage Gaps & Suggested Tests</h2>
  <p style="color:var(--text-dim);font-size:14px;margin-bottom:16px">${gaps.length} areas missing test coverage. These are inferred from code analysis and runtime exploration.</p>
  ${critical.length > 0 ? `<h3 style="color:var(--fail);font-size:14px;margin:12px 0 8px">Critical (${critical.length})</h3>\n${critical.map(renderGap).join('\n')}` : ''}
  ${important.length > 0 ? `<h3 style="color:var(--warn);font-size:14px;margin:12px 0 8px">Important (${important.length})</h3>\n${important.map(renderGap).join('\n')}` : ''}
  ${niceToHave.length > 0 ? `<h3 style="color:var(--pass);font-size:14px;margin:12px 0 8px">Nice to Have (${niceToHave.length})</h3>\n${niceToHave.map(renderGap).join('\n')}` : ''}`
}

// ─── API Monitoring Section ───────────────────────────────────────────────────

function renderApiSection(explorations: PageExploration[]): string {
  const allApis = explorations.flatMap(e => e.api_calls.map(a => ({ ...a, route: e.route })))
  if (allApis.length === 0) return ''

  const errors = allApis.filter(a => a.isError)
  const byEndpoint = new Map<string, { method: string; path: string; count: number; errors: number; avgTime: number }>()

  for (const api of allApis) {
    const key = `${api.method} ${api.path}`
    const existing = byEndpoint.get(key)
    if (existing) {
      existing.count++
      if (api.isError) existing.errors++
      existing.avgTime = Math.round((existing.avgTime * (existing.count - 1) + api.responseTime_ms) / existing.count)
    } else {
      byEndpoint.set(key, { method: api.method, path: api.path, count: 1, errors: api.isError ? 1 : 0, avgTime: api.responseTime_ms })
    }
  }

  const rows = [...byEndpoint.values()].map(api => {
    const statusClass = api.errors > 0 ? 'color:var(--fail)' : 'color:var(--pass)'
    return `<tr>
      <td><code>${esc(api.method)}</code></td>
      <td><code>${esc(api.path)}</code></td>
      <td>${api.count}</td>
      <td style="${statusClass}">${api.errors > 0 ? `${api.errors} errors` : 'OK'}</td>
      <td>${api.avgTime}ms</td>
    </tr>`
  }).join('\n')

  return `<h2>API Monitoring</h2>
  <p style="color:var(--text-dim);font-size:14px;margin-bottom:12px">${allApis.length} API calls observed${errors.length > 0 ? `, <span style="color:var(--fail)">${errors.length} errors</span>` : ''}</p>
  <div class="section-table">
    <table>
      <thead><tr><th>Method</th><th>Endpoint</th><th>Calls</th><th>Status</th><th>Avg Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`
}

// ─── Coverage Table ───────────────────────────────────────────────────────────

function renderCoverageTable(productModel: ProductModel): string {
  const routeRows = productModel.routes.map(r => {
    const covered = productModel.coverage[r.path]
    return `<tr>
      <td><code>${r.path}</code></td>
      <td>${r.type}</td>
      <td>${r.requires_auth ? 'Yes' : 'No'}</td>
      <td>${covered?.tested ? '<span class="badge pass">Referenced</span>' : '<span class="badge fail">No source test</span>'}</td>
    </tr>`
  }).join('\n')

  return `<h2>Route Coverage</h2>
  <div class="section-table">
    <table>
      <thead><tr><th>Route</th><th>Type</th><th>Auth</th><th>Source test reference</th></tr></thead>
      <tbody>${routeRows}</tbody>
    </table>
  </div>`
}

// ─── Scenario Card ────────────────────────────────────────────────────────────

function renderScenarioCard(result: TestResult, images: ImageMap): string {
  const s = result.scenario
  const status = result.status
  const verdictClass = status === 'pass' ? 'pass-verdict' : status === 'fail' ? 'fail-verdict' : 'error-verdict'
  const explanation = result.ai_verdict ?? result.failure_reason ?? ''
  const verification = result.verification_status ?? 'not_verified'
  const verificationLabel = getVerificationLabel(verification)

  const navPath = result.navigated_url ? extractPath(result.navigated_url) : s.route
  const finalPath = result.current_url ? extractPath(result.current_url) : ''
  const wasRedirected = navPath !== finalPath && finalPath

  const stepRows = (result.step_logs ?? []).map(log => {
    const icon = log.status === 'ok' ? '✅' : log.status === 'failed' ? '❌' : '⏭️'
    const sel = log.selector_used ? `<code>${esc(log.selector_used)}</code>` : '—'
    const urlPath = extractPath(log.url_after)
    const err = log.error ? `<br><span style="color:var(--fail);font-size:11px">${esc(log.error.slice(0, 80))}</span>` : ''
    const stepImage = log.screenshot_path ? images.get(log.screenshot_path) : undefined
    const screenshotCell = stepImage
      ? `<td class="step-screenshot-cell"><img src="${esc(stepImage.thumb ?? stepImage.full)}" data-full="${esc(stepImage.full)}" alt="step" class="step-thumb zoomable" loading="lazy"></td>`
      : `<td></td>`
    return `<tr>
      <td>${icon}</td>
      <td><strong>${log.step.action}</strong></td>
      <td>${esc(log.step.description)}${err}</td>
      <td>${sel}</td>
      <td><code>${esc(urlPath)}</code></td>
      <td>${log.duration_ms}ms</td>
      ${screenshotCell}
    </tr>`
  }).join('\n')

  const screenshotHtml = screenshotFigure(result.screenshot_path ? images.get(result.screenshot_path) : undefined, 'Screenshot at end of test', s.name)

  const redirectNote = wasRedirected ? `
    <div class="redirect-note">
      Redirect: <code>${esc(navPath)}</code> → <code>${esc(finalPath)}</code>
      ${finalPath.includes('login') ? ' — requires authentication' : ''}
    </div>` : ''

  const serverErrors = result.server_errors ?? []
  const serverErrorHtml = serverErrors.length === 0 ? '' : `
    <ul class="page-findings fail">${serverErrors.map(e => {
      const where = `${e.method ?? 'GET'} ${extractPath(e.url)}`
      return `<li>${e.status ? `Server error ${e.status} on ${esc(where)}` : `Crash text on ${esc(extractPath(e.url))}`}${e.evidence ? `: ${esc(e.evidence)}` : ''}</li>`
    }).join('')}</ul>`
  const retryHtml = !result.retry || result.retry.attempts <= 1 ? '' : `
    <div class="redirect-note">${result.retry.passed_on_retry
      ? `Only passed on attempt ${result.retry.attempts}`
      : `Failed on all ${result.retry.attempts} attempts`}${result.retry.first_failure ? ` (first attempt: ${esc(result.retry.first_failure)})` : ''}</div>`

  return `<div class="card${status !== 'pass' || result.retry?.passed_on_retry ? ' open' : ''}">
  <div class="card-header">
      <div class="status-dot ${status}"></div>
      <div class="title">${esc(s.name)}</div>
      <div class="meta-tags">
        <span class="badge ${s.priority}">${s.priority}</span>
        <span class="badge ${status}">${status}</span>
        ${result.retry?.passed_on_retry ? '<span class="badge medium">passed on retry</span>' : ''}
        <span class="badge ${verification}">${verificationLabel}</span>
        <span style="font-size:12px;color:var(--text-dim)">${result.duration_ms}ms</span>
      </div>
    <span class="chevron">▶</span>
  </div>
  <div class="card-body">
    <div class="verdict ${verdictClass}">${esc(explanation)}</div>
    ${retryHtml}
    ${serverErrorHtml}
    ${redirectNote}
    <div class="info-grid">
      <div class="info-item"><span class="info-label">Route</span><code>${esc(s.route)}</code></div>
      <div class="info-item"><span class="info-label">Expected</span><span>${esc(s.expected_outcome)}</span></div>
    </div>
    ${stepRows ? `<table class="step-table">
      <thead><tr><th></th><th>Action</th><th>Description</th><th>Selector</th><th>URL</th><th>Time</th><th>Screenshot</th></tr></thead>
      <tbody>${stepRows}</tbody>
    </table>` : ''}
    ${screenshotHtml}
  </div>
</div>`
}

function getVerificationLabel(status: VerificationStatus): string {
  if (status === 'outcome_verified') return 'Outcome verified'
  if (status === 'smoke_check_passed') return 'Smoke check passed'
  return 'Not verified'
}

// ─── Intelligence Section ─────────────────────────────────────────────────────

function renderIntelligenceSection(recs?: MemoryRecommendations): string {
  if (!recs || recs.first_run) {
    return `<h2>Intelligence</h2>
    <div class="card open"><div class="card-body">
      <p style="color:var(--text-dim)">First run complete. Future runs will use learned patterns for faster, smarter testing.</p>
    </div></div>`
  }

  const authStatus = recs.auth_intel?.session_established
    ? `<span style="color:var(--pass)">Working</span> (login: <code>${esc(recs.auth_intel.login_route)}</code>)`
    : `<span style="color:var(--warn)">Not established</span>`

  return `<h2>Intelligence</h2>
  <div class="card open"><div class="card-body">
    <div class="info-grid">
      <div class="info-item"><span class="info-label">Auth</span><span>${authStatus}</span></div>
      <div class="info-item"><span class="info-label">Selectors</span><span>${Object.keys(recs.selector_hints).length} learned</span></div>
      <div class="info-item"><span class="info-label">Auth Routes</span><span>${[...recs.auth_routes].map(r => `<code>${esc(r)}</code>`).join(', ') || 'None'}</span></div>
    </div>
  </div></div>`
}

function extractPath(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}

function esc(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

const CSS = `
:root {
  --bg: #0f1117; --surface: #1a1d27; --surface2: #232733; --border: #2e3345;
  --text: #e1e4ed; --text-dim: #8b92a8;
  --pass: #22c55e; --pass-bg: rgba(34,197,94,0.08);
  --fail: #ef4444; --fail-bg: rgba(239,68,68,0.08);
  --warn: #f59e0b; --warn-bg: rgba(245,158,11,0.08);
  --accent: #6366f1; --accent-bg: rgba(99,102,241,0.08);
  --radius: 10px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
.container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
header { padding: 40px 0 32px; border-bottom: 1px solid var(--border); margin-bottom: 32px; }
header h1 { font-size: 28px; font-weight: 700; color: #fff; }
header p { color: var(--text-dim); font-size: 14px; }
.metric-summary { margin-top: 14px; }
.meta-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-top: 20px; }
.meta-item { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
.meta-item .label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.meta-item .value { font-size: 18px; font-weight: 600; margin-top: 4px; }
.summary-bar { display: flex; gap: 16px; margin: 28px 0; flex-wrap: wrap; }
.summary-stat { flex: 1; min-width: 140px; padding: 20px; border-radius: var(--radius); text-align: center; border: 1px solid var(--border); }
.summary-stat.pass { background: var(--pass-bg); border-color: rgba(34,197,94,0.2); }
.summary-stat.fail { background: var(--fail-bg); border-color: rgba(239,68,68,0.2); }
.summary-stat.error { background: var(--warn-bg); border-color: rgba(245,158,11,0.2); }
.summary-stat.skip { background: var(--surface); }
.summary-stat.outcome { background: rgba(34,197,94,0.08); border-color: rgba(34,197,94,0.2); }
.summary-stat.smoke { background: var(--accent-bg); border-color: rgba(99,102,241,0.2); }
.summary-stat.not { background: var(--warn-bg); border-color: rgba(245,158,11,0.2); }
.summary-stat .num { font-size: 36px; font-weight: 700; }
.summary-stat.pass .num { color: var(--pass); }
.summary-stat.fail .num { color: var(--fail); }
.summary-stat.error .num { color: var(--warn); }
.summary-stat.skip .num { color: var(--text-dim); }
.summary-stat.outcome .num { color: var(--pass); }
.summary-stat.smoke .num { color: var(--accent); }
.summary-stat.not .num { color: var(--warn); }
.summary-stat .lbl { font-size: 12px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
h2 { font-size: 20px; font-weight: 600; margin: 36px 0 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
h3 { font-size: 14px; font-weight: 600; margin: 16px 0 8px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 12px; overflow: hidden; }
.card-header { padding: 14px 20px; display: flex; align-items: center; gap: 12px; cursor: pointer; user-select: none; }
.card-header:hover { background: var(--surface2); }
.card-header .status-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.card-header .status-dot.pass { background: var(--pass); }
.card-header .status-dot.fail { background: var(--fail); }
.card-header .status-dot.error { background: var(--warn); }
.card-header .status-dot.skip { background: var(--text-dim); }
.card-header .title { font-weight: 600; flex: 1; font-size: 14px; }
.card-header .meta-tags { display: flex; gap: 8px; align-items: center; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
.badge.pass { background: var(--pass-bg); color: var(--pass); border: 1px solid rgba(34,197,94,0.2); }
.badge.fail { background: var(--fail-bg); color: var(--fail); border: 1px solid rgba(239,68,68,0.2); }
.badge.error, .badge.medium { background: var(--warn-bg); color: var(--warn); border: 1px solid rgba(245,158,11,0.2); }
.badge.outcome_verified { background: var(--pass-bg); color: var(--pass); border: 1px solid rgba(34,197,94,0.2); }
.badge.smoke_check_passed { background: var(--accent-bg); color: var(--accent); border: 1px solid rgba(99,102,241,0.2); }
.badge.not_verified { background: var(--warn-bg); color: var(--warn); border: 1px solid rgba(245,158,11,0.2); }
.badge.high { background: var(--fail-bg); color: var(--fail); border: 1px solid rgba(239,68,68,0.2); }
.badge.low { background: var(--pass-bg); color: var(--pass); border: 1px solid rgba(34,197,94,0.2); }
.badge.session { background: var(--surface2); color: var(--text-dim); border: 1px solid var(--border); }
.card-body { display: none; padding: 0 20px 20px; }
.card.open .card-body { display: block; }
.card.open .chevron { transform: rotate(90deg); }
.chevron { color: var(--text-dim); transition: transform 0.2s; font-size: 12px; }
.verdict { padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
.verdict.fail-verdict { background: var(--fail-bg); border-left: 3px solid var(--fail); }
.verdict.pass-verdict { background: var(--pass-bg); border-left: 3px solid var(--pass); }
.verdict.error-verdict { background: var(--warn-bg); border-left: 3px solid var(--warn); }
.info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; font-size: 13px; }
.info-grid .info-item { display: flex; gap: 8px; }
.info-grid .info-label { color: var(--text-dim); min-width: 100px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0; }
th { text-align: left; padding: 8px 12px; background: var(--surface2); color: var(--text-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); }
td { padding: 8px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
tr:last-child td { border-bottom: none; }
.screenshot-container { margin-top: 16px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.screenshot-container img { width: 100%; display: block; }
.screenshot-label { font-size: 11px; color: var(--text-dim); padding: 8px 12px; background: var(--surface2); text-transform: uppercase; letter-spacing: 0.5px; }
.step-table td:first-child { width: 30px; text-align: center; }
.step-screenshot-cell { width: 80px; }
.step-thumb { width: 70px; height: 45px; object-fit: cover; border-radius: 4px; border: 1px solid var(--border); cursor: pointer; transition: transform 0.15s; }
.step-thumb:hover { transform: scale(2.5); z-index: 100; position: relative; box-shadow: 0 8px 24px rgba(0,0,0,0.6); }
.screenshot-modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 1000; align-items: center; justify-content: center; cursor: zoom-out; }
.screenshot-modal.active { display: flex; }
.screenshot-modal img { max-width: 90vw; max-height: 90vh; border-radius: 8px; }
code { background: var(--surface2); padding: 2px 6px; border-radius: 4px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; }
.section-table { margin-bottom: 8px; }
.section-table table { background: var(--surface); border-radius: var(--radius); overflow: hidden; border: 1px solid var(--border); }
.redirect-note { background: var(--warn-bg); border-left: 3px solid var(--warn); padding: 10px 14px; border-radius: 0 6px 6px 0; margin-bottom: 16px; font-size: 13px; color: var(--warn); }
.section-note { color: var(--text-dim); font-size: 14px; margin-bottom: 12px; }
.meta-item .sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
#bugs-found { margin-top: 8px; }
.bugs-table table { border-color: rgba(239,68,68,0.35); }
.bugs-none { background: var(--pass-bg); border: 1px solid rgba(34,197,94,0.25); border-left: 3px solid var(--pass); border-radius: 8px; padding: 12px 16px; font-size: 14px; margin-bottom: 12px; }
.bugs-also { margin-top: 8px; }
.summary-groups { display: flex; gap: 16px; flex-wrap: wrap; margin: 24px 0; }
.summary-group { flex: 1 1 260px; }
.summary-group .group-label { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
.summary-group .summary-bar { margin: 0; gap: 8px; }
.summary-group .summary-stat { min-width: 0; padding: 12px 8px; }
.summary-group .summary-stat .num { font-size: 26px; }
.screenshot-label a { color: var(--accent); text-decoration: none; text-transform: none; letter-spacing: 0; }
.screenshot-thumb { cursor: zoom-in; max-width: 480px; }
.screenshot-container:has(.screenshot-thumb) { display: inline-block; max-width: 100%; }
.warn-heading { color: var(--warn); margin-top: 20px; }
.findings-table td:first-child { white-space: nowrap; width: 1%; }
.findings-table .finding-text { word-break: break-word; }
.findings-table td:last-child code { display: inline-block; margin: 0 4px 4px 0; }
.page-findings { list-style: none; margin: 0 0 12px; font-size: 13px; }
.page-findings li { padding: 6px 12px; border-left: 3px solid; margin-bottom: 4px; border-radius: 0 6px 6px 0; word-break: break-word; }
.page-findings.fail li { background: var(--fail-bg); border-color: var(--fail); }
.page-findings.warn li { background: var(--warn-bg); border-color: var(--warn); }
.page-findings.dim li { background: var(--surface2); border-color: var(--border); color: var(--text-dim); }
footer { margin-top: 48px; padding: 20px 0; border-top: 1px solid var(--border); text-align: center; font-size: 12px; color: var(--text-dim); }
ol { color: var(--text); }
`
