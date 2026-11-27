import path from 'path'
import { pathToFileURL } from 'url'
import type { CaseResult, CaseRunResult } from './run.js'

/** Machine-readable outputs of a case run: JSON, JUnit XML, evidence-ledger lines and an HTML page. */

export interface RunMeta {
  tool_version: string
  base_url?: string
  /** Commit the run was taken on. */
  sha?: string
  files: string[]
}

export function toJson(run: CaseRunResult, meta: RunMeta, outDir: string): unknown {
  const rel = (p?: string) => p ? path.relative(outDir, p) : undefined
  return {
    tool: 'vibe-testing',
    version: meta.tool_version,
    started_at: run.started_at,
    duration_ms: run.duration_ms,
    sha: meta.sha,
    base_url: meta.base_url,
    files: meta.files,
    summary: run.summary,
    cases: run.cases.map(c => ({
      id: c.id, title: c.title, priority: c.priority, file: c.file, line: c.line, status: c.status,
      ...(c.reason ? { reason: c.reason } : {}), ...(c.hint ? { hint: c.hint } : {}), base_url: c.base_url, duration_ms: c.duration_ms,
      variants: c.variants.map(v => ({
        name: v.name, viewport: v.viewport, motion: v.motion, status: v.status,
        ...(v.reason ? { reason: v.reason } : {}),
        verification: v.result?.verification_status,
        screenshot: rel(v.result?.screenshot_path),
        duration_ms: v.result?.duration_ms,
        ...(v.result?.retry ? { retry: v.result.retry } : {}),
        steps: (v.result?.step_logs ?? []).map(s => ({ action: s.step.action, description: s.step.description, status: s.status, ...(s.error ? { error: s.error.split('\n')[0] } : {}), ...(s.screenshot_path ? { screenshot: rel(s.screenshot_path) } : {}) })),
      })),
    })),
  }
}

const xml = (s: string) => s.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]!))
  // Characters XML 1.0 does not allow (terminal colour codes in Playwright errors).
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/** JUnit XML: one testsuite per case file, one testcase per case and viewport/motion variant. */
export function toJUnit(run: CaseRunResult): string {
  const byFile = new Map<string, CaseResult[]>()
  for (const c of run.cases) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c])
  const suites: string[] = []
  for (const [file, cases] of byFile) {
    const tests: string[] = []
    let failures = 0, errors = 0, skipped = 0, time = 0
    for (const c of cases) {
      const rows = c.variants.length ? c.variants.map(v => ({ name: c.variants.length > 1 ? `${c.id} ${c.title} [${v.name}]` : `${c.id} ${c.title}`, status: v.status as string, reason: v.reason, ms: v.result?.duration_ms ?? 0 }))
        : [{ name: `${c.id} ${c.title}`, status: c.status === 'needs_steps' ? 'skip' : c.status as string, reason: c.reason, ms: 0 }]
      for (const r of rows) {
        time += r.ms
        const head = `    <testcase classname="${xml(path.basename(file))}" name="${xml(r.name)}" time="${(r.ms / 1000).toFixed(3)}"`
        if (r.status === 'pass') tests.push(`${head}/>`)
        else if (r.status === 'fail') { failures++; tests.push(`${head}>\n      <failure message="${xml((r.reason ?? 'failed').slice(0, 500))}"/>\n    </testcase>`) }
        else if (r.status === 'error') { errors++; tests.push(`${head}>\n      <error message="${xml((r.reason ?? 'error').slice(0, 500))}"/>\n    </testcase>`) }
        else { skipped++; tests.push(`${head}>\n      <skipped message="${xml(r.reason ?? 'skipped')}"/>\n    </testcase>`) }
      }
    }
    suites.push(`  <testsuite name="${xml(path.basename(file))}" tests="${tests.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${(time / 1000).toFixed(3)}">\n${tests.join('\n')}\n  </testsuite>`)
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="vibe-testing">\n${suites.join('\n')}\n</testsuites>\n`
}

export interface LedgerOptions {
  task: string
  stage: string
  by: string
  sha?: string
  /** Path or URL of the report, as the ledger should show it. */
  path?: string
  now?: Date
}

/** ISO 8601 with the local UTC offset, e.g. 2026-11-27T18:30:00+05:30. */
export function isoWithOffset(date: Date): string {
  const off = -date.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const local = new Date(date.getTime() + off * 60000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`
}

/**
 * Evidence-ledger lines (JSON Lines), one per case: kind vibe-run, ref = case id,
 * result pass / fail, or warn for a case that did not run (needs steps, skipped, error).
 */
export function toLedger(run: CaseRunResult, opts: LedgerOptions): string {
  const ts = isoWithOffset(opts.now ?? new Date())
  return run.cases.map(c => {
    const variants = c.variants.length > 1 ? ` on ${c.variants.length} variants (${c.variants.map(v => v.name).join(', ')})` : c.variants[0] ? ` at ${c.variants[0].name}` : ''
    const result = c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : 'warn'
    const summary = c.status === 'pass' ? `${c.title}: passed${variants}`
      : c.status === 'fail' ? `${c.title}: failed, ${oneLine(c.reason)}`
      : c.status === 'needs_steps' ? `${c.title}: not run, no vibe steps yet`
      : c.status === 'skip' ? `${c.title}: not run, ${oneLine(c.reason)}`
      : `${c.title}: could not run, ${oneLine(c.reason)}`
    return JSON.stringify({
      ts, task: opts.task, stage: opts.stage, kind: 'vibe-run', ref: c.id, result, summary,
      ...(opts.path ? { path: opts.path } : {}), ...(opts.sha ? { sha: opts.sha } : {}), by: opts.by,
    })
  }).join('\n') + (run.cases.length ? '\n' : '')
}

function oneLine(s: string | undefined): string {
  return (s ?? 'no reason given').replace(/\s+/g, ' ').replace(/\u001b\[[0-9;]*m/g, '').slice(0, 220)
}

const esc = (s: string) => s.replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]!))

/** A plain HTML page: one row per case, variants with screenshots. */
export function toHtml(run: CaseRunResult, meta: RunMeta, outDir: string): string {
  const s = run.summary
  const href = (p?: string) => p ? esc(path.relative(outDir, p).split(path.sep).join('/')) : ''
  const rows = run.cases.map(c => {
    const variants = c.variants.map(v => {
      const shot = v.result?.screenshot_path
      const failed = v.result?.step_logs.find(l => l.status === 'failed')
      return `<div class="v ${v.status}"><b>${esc(v.name)}</b> ${v.status}${v.result?.retry?.passed_on_retry ? ' (passed on retry)' : ''}${v.reason && v.status !== 'pass' ? `<div class="why">${esc(oneLine(v.reason))}</div>` : ''}${failed ? `<div class="why">Step: ${esc(failed.step.description)}</div>` : ''}${shot ? `<a href="${href(shot)}"><img loading="lazy" src="${href(shot)}" alt="${esc(c.id)} ${esc(v.name)}"></a>` : ''}</div>`
    }).join('')
    const src = c.line ? `${esc(path.basename(c.file))}:${c.line}` : esc(path.basename(c.file))
    return `<tr class="${c.status}"><td><b>${esc(c.id)}</b><div class="src">${src}</div></td><td>${esc(c.priority ?? '')}</td><td>${esc(c.title)}${c.hint ? `<div class="hint">${esc(c.hint)}</div>` : ''}${c.reason && !c.variants.length ? `<div class="why">${esc(c.reason)}</div>` : ''}</td><td class="st">${c.status.replace('_', ' ')}</td><td>${variants}</td></tr>`
  }).join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>vibe-testing cases</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;margin:24px;color:#1a1a1a;background:#fafaf7}
h1{font-size:20px;margin:0 0 4px}.meta{color:#555;margin-bottom:16px}
.sum span{display:inline-block;margin-right:14px;font-weight:600}
table{border-collapse:collapse;width:100%;background:#fff}td,th{border-top:1px solid #e4e2dc;padding:8px;vertical-align:top;text-align:left}
tr.pass .st{color:#137333}tr.fail .st,tr.error .st{color:#b3261e;font-weight:700}tr.skip .st,tr.needs_steps .st{color:#8a6d00}
.src,.hint{color:#666;font-size:13px}.why{color:#b3261e;font-size:13px;margin-top:2px}
.v{display:inline-block;width:220px;margin:0 8px 8px 0;font-size:13px}.v img{width:100%;border:1px solid #ddd;margin-top:4px}
</style></head><body>
<h1>vibe-testing: test cases</h1>
<div class="meta">${esc(run.started_at)} · ${(run.duration_ms / 1000).toFixed(1)}s · vibe-testing ${esc(meta.tool_version)}${meta.sha ? ` · ${esc(meta.sha.slice(0, 12))}` : ''}${meta.base_url ? ` · ${esc(meta.base_url)}` : ''}</div>
<div class="sum"><span>${s.total} cases</span><span style="color:#137333">${s.pass} passed</span><span style="color:#b3261e">${s.fail} failed</span><span style="color:#b3261e">${s.error} errors</span><span style="color:#8a6d00">${s.needs_steps} need steps</span><span style="color:#8a6d00">${s.skip} skipped</span></div>
<p class="meta">Files: ${meta.files.map(f => `<a href="${esc(pathToFileURL(f).href)}">${esc(path.basename(f))}</a>`).join(', ')}</p>
<table><thead><tr><th>Case</th><th>Pri</th><th>What</th><th>Result</th><th>Variants</th></tr></thead><tbody>
${rows}
</tbody></table></body></html>
`
}
