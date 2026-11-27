import { chromium, type Browser, type BrowserContext } from 'playwright'
import path from 'path'
import type { VibeConfig } from '../../types/config.js'
import type { TestResult, TestScenario, TestStep } from '../../types/index.js'
import { runScenarioWithRetry } from '../browser/runner.js'
import { performLoginDetailed } from '../browser/auth.js'
import { addConfiguredCookies, hasStoredSession, storageStatePath } from '../browser/session-state.js'
import { logger } from '../../utils/logger.js'
import { ensureDir } from '../../utils/file.js'
import { resolveBase, type CaseFile, type TestCase } from './parse.js'

export type CaseStatus = 'pass' | 'fail' | 'error' | 'skip' | 'needs_steps'

export interface VariantResult {
  /** e.g. "1440x900 full". */
  name: string
  viewport: [number, number]
  motion: 'full' | 'reduce'
  status: 'pass' | 'fail' | 'error' | 'skip'
  result?: TestResult
  reason?: string
}

export interface CaseResult {
  id: string
  title: string
  priority?: string
  file: string
  line: number
  hint?: string
  status: CaseStatus
  /** Why it was skipped or could not run. */
  reason?: string
  base_url?: string
  variants: VariantResult[]
  duration_ms: number
}

export interface CaseRunOptions {
  /** Explicit base URL (wins over @base and the config URL). */
  baseUrl?: string
  /** Defaults when neither the case nor its file says. */
  viewports?: Array<[number, number]>
  motion?: Array<'full' | 'reduce'>
  /** Only these ids (exact or prefix ending in *). */
  only?: string[]
  /** Only these priorities, e.g. ["P0", "P1"]. */
  priorities?: string[]
  /** Run cases tagged live or manual too. */
  includeTags?: string[]
  /** Where screenshots go. */
  outDir: string
  projectRoot: string
}

export interface CaseRunResult {
  cases: CaseResult[]
  started_at: string
  duration_ms: number
  summary: Record<CaseStatus, number> & { total: number }
}

const motionName = (m: 'full' | 'reduce') => m

function selected(tc: TestCase, opts: CaseRunOptions): boolean {
  if (opts.only?.length && !opts.only.some(id => id.endsWith('*') ? tc.id.startsWith(id.slice(0, -1)) : tc.id === id)) return false
  if (opts.priorities?.length && !(tc.priority && opts.priorities.map(p => p.toUpperCase()).includes(tc.priority.toUpperCase()))) return false
  return true
}

/** ${NAME} in a step's text fields comes from the environment (secrets stay out of case files). */
export function interpolateStep(step: TestStep): TestStep {
  const sub = (s: string) => s.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name: string) => {
    const value = process.env[name]
    if (value === undefined) throw new Error(`Missing env var: ${name}`)
    return value
  })
  const out: TestStep = { ...step }
  for (const key of ['selector', 'value', 'url', 'path'] as const) if (typeof out[key] === 'string') out[key] = sub(out[key] as string)
  if (typeof out.body === 'string') out.body = sub(out.body)
  if (out.headers) out.headers = Object.fromEntries(Object.entries(out.headers).map(([k, v]) => [k, sub(v)]))
  return out
}

export async function runCases(files: CaseFile[], config: VibeConfig, opts: CaseRunOptions): Promise<CaseRunResult> {
  const startedAt = new Date()
  const screenshotsDir = path.join(opts.outDir, 'screenshots')
  await ensureDir(screenshotsDir)
  const results: CaseResult[] = []
  let browser: Browser | undefined
  const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>> | null>()

  const getBrowser = async () => {
    browser ??= await chromium.launch({ headless: !(config.browser?.headed ?? false), slowMo: config.browser?.slowMo ?? 0 })
    return browser
  }

  /** Signed-in storage state for an account (true = the default session), made once per run. */
  const sessionFor = async (account: true | string, baseUrl: string) => {
    const key = `${account === true ? '' : account}@${baseUrl}`
    if (sessions.has(key)) return sessions.get(key) ?? undefined
    const b = await getBrowser()
    let state: Awaited<ReturnType<BrowserContext['storageState']>> | null = null
    const ctx = await b.newContext({
      ...(/^https?:/i.test(baseUrl) ? { baseURL: baseUrl } : {}),
      ...(account === true && hasStoredSession(config.auth) ? { storageState: await storageStatePath(config.auth, opts.projectRoot) } : {}),
    })
    try {
      if (account === true && hasStoredSession(config.auth)) {
        await addConfiguredCookies(ctx, config.auth, baseUrl)
        state = await ctx.storageState()
      } else {
        const named = account === true ? undefined : config.auth?.accounts?.find(a => a.name === account)
        if (account !== true && !named) throw new Error(`no account named "${account}" in auth.accounts`)
        const credentials = named?.credentials ?? config.auth?.credentials
        if (!credentials) throw new Error('signed-in case, but the config has no auth.credentials, auth.storage_state or auth.cookies')
        const outcome = await performLoginDetailed(ctx, baseUrl, { ...config.auth!, strategy: config.auth?.strategy === 'basic' ? 'basic' : 'credentials', credentials }, config.retries)
        if (!outcome.ok) throw new Error(`login as ${account === true ? credentials.email : account} failed: ${outcome.firstFailure ?? 'still on the login page'}`)
        state = await ctx.storageState()
      }
    } finally {
      await ctx.close().catch(() => {})
    }
    sessions.set(key, state)
    return state ?? undefined
  }

  try {
    for (const file of files) {
      for (const err of file.errors) logger.warn(err)
      const chosen = file.cases.filter(tc => selected(tc, opts))
      if (chosen.length === 0) continue
      logger.section(`${path.basename(file.file)}: ${chosen.length} case(s)`)
      for (const tc of chosen) {
        const started = Date.now()
        const base: CaseResult = { id: tc.id, title: tc.title, priority: tc.priority, file: tc.file, line: tc.line, hint: tc.hint, status: 'skip', variants: [], duration_ms: 0 }
        const blockedTag = tc.tags.find(t => !(opts.includeTags ?? []).includes(t))
        if (tc.parse_error) {
          results.push({ ...base, status: 'error', reason: `could not read the vibe block: ${tc.parse_error}` })
          logger.warn(`${tc.id}: could not read its vibe block (${tc.parse_error})`)
          continue
        }
        if (tc.steps.length === 0 && tc.options.skip) {
          results.push({ ...base, status: 'skip', reason: tc.options.skip })
          logger.dim(`${tc.id}: skipped (${tc.options.skip})`)
          continue
        }
        if (tc.steps.length === 0) {
          results.push({ ...base, status: tc.manual ? 'skip' : 'needs_steps', reason: tc.manual ? 'manual case' : 'no ```vibe steps yet; the hint alone cannot be run' })
          logger.dim(`${tc.id}: ${tc.manual ? 'manual, not run' : 'needs steps (no vibe block)'}`)
          continue
        }
        if (tc.options.skip || tc.manual || blockedTag) {
          const reason = tc.options.skip ?? (tc.manual ? 'manual case' : `tagged ${blockedTag}; pass --include ${blockedTag} to run it`)
          results.push({ ...base, status: 'skip', reason })
          logger.dim(`${tc.id}: skipped (${reason})`)
          continue
        }
        const baseUrl = resolveBase(tc, file.defaults, opts.baseUrl, config.url)
        if (!baseUrl) {
          results.push({ ...base, status: 'error', reason: 'no base URL: pass one, set url in vibe.config.json, or add @base to the file' })
          continue
        }
        const viewports = tc.options.viewports ?? file.defaults.viewports ?? opts.viewports ?? [[1280, 800]]
        const motions = tc.options.motion ?? file.defaults.motion ?? opts.motion ?? ['full']
        const auth = tc.options.auth ?? file.defaults.auth
        const caseTimeout = tc.options.timeout ?? file.defaults.timeout

        logger.info(`${tc.id} ${tc.title}`)
        let state: Awaited<ReturnType<BrowserContext['storageState']>> | undefined
        if (auth) {
          try {
            state = await sessionFor(auth, baseUrl)
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            results.push({ ...base, base_url: baseUrl, status: 'error', reason, duration_ms: Date.now() - started })
            logger.warn(`  ${reason}`)
            continue
          }
        }

        let steps: TestStep[]
        try {
          steps = tc.steps.map(interpolateStep).map(s => (caseTimeout && s.timeout === undefined && s.action !== 'still' ? { ...s, timeout: caseTimeout } : s))
        } catch (err) {
          results.push({ ...base, base_url: baseUrl, status: 'error', reason: err instanceof Error ? err.message : String(err) })
          continue
        }

        const variants: VariantResult[] = []
        for (const viewport of viewports) {
          for (const motion of motions) {
            const name = `${viewport[0]}x${viewport[1]} ${motionName(motion)}`
            const multi = viewports.length * motions.length > 1
            const scenario: TestScenario = {
              id: `${tc.id}${multi ? `@${viewport[0]}x${viewport[1]}${motion === 'reduce' ? '-reduce' : ''}` : ''}`.replace(/[^\w@.-]/g, '_'),
              name: `${tc.id} ${tc.title}${multi ? ` [${name}]` : ''}`,
              route: tc.options.route ?? file.defaults.route ?? firstUrl(steps) ?? '/',
              priority: tc.priority === 'P0' ? 'high' : tc.priority === 'P2' || tc.priority === 'P3' ? 'low' : 'medium',
              steps,
              expected_outcome: tc.hint ?? tc.title,
              is_gap: false,
              generated_by: 'ai',
              requires_auth: !!auth,
            }
            const b = await getBrowser()
            const ctx = await b.newContext({
              ...(/^https?:/i.test(baseUrl) ? { baseURL: baseUrl } : {}),
              viewport: { width: viewport[0], height: viewport[1] },
              reducedMotion: motion === 'reduce' ? 'reduce' : 'no-preference',
              ...(state ? { storageState: state } : {}),
            })
            ctx.setDefaultTimeout(config.browser?.timeout ?? 30000)
            try {
              const result = await runScenarioWithRetry(scenario, ctx, { ...config, url: baseUrl }, screenshotsDir, opts.projectRoot)
              variants.push({ name, viewport, motion, status: result.status, result, reason: result.status === 'pass' ? undefined : result.failure_reason ?? result.ai_verdict })
              const label = multi ? name : result.status
              const line = result.status === 'pass' ? `${label}${result.retry?.passed_on_retry ? ' (passed on retry)' : ''}` : `${label}: ${(result.failure_reason ?? result.ai_verdict ?? '').split('\n')[0].slice(0, 220)}`
              if (result.status === 'pass') logger.success(line); else if (result.status === 'skip') logger.dim(line); else logger.error(line)
            } catch (err) {
              const reason = `runner crash: ${err instanceof Error ? err.message : String(err)}`
              variants.push({ name, viewport, motion, status: 'error', reason })
              logger.warn(`  ${reason}`)
            } finally {
              await ctx.close().catch(() => {})
            }
          }
        }
        const status: CaseStatus = variants.some(v => v.status === 'fail') ? 'fail'
          : variants.some(v => v.status === 'error') ? 'error'
          : variants.every(v => v.status === 'skip') ? 'skip' : 'pass'
        const firstBad = variants.find(v => v.status !== 'pass')
        results.push({ ...base, base_url: baseUrl, status, reason: status === 'pass' ? undefined : firstBad && `${firstBad.name}: ${firstBad.reason ?? firstBad.status}`, variants, duration_ms: Date.now() - started })
      }
    }
  } finally {
    await browser?.close().catch(() => {})
  }

  const summary = { total: results.length, pass: 0, fail: 0, error: 0, skip: 0, needs_steps: 0 }
  for (const r of results) summary[r.status]++
  return { cases: results, started_at: startedAt.toISOString(), duration_ms: Date.now() - startedAt.getTime(), summary }
}

function firstUrl(steps: TestStep[]): string | undefined {
  const url = steps.find(s => s.action === 'navigate' || s.action === 'request')?.url
  if (!url) return undefined
  try { return new URL(url, 'http://x').pathname } catch { return url }
}
