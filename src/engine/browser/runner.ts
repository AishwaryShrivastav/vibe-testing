import { chromium, BrowserContext, Page, Locator, type Response } from 'playwright'
import { TestScenario, TestResult, TestStep, StepLog, ApiError } from '../../types/index.js'
import { VibeConfig, VibeGuidance } from '../../types/config.js'
import { describeLoginRetry, performLoginDetailed, waitForLoginOutcome, type LoginOutcome } from './auth.js'
import { readLoginError } from './login-form.js'
import { checkLogoutRoundTrip } from './session-checks.js'
import { checkCrossUserAccess } from './access-checks.js'
import { verifyResult } from './verifier.js'
import { exploreAllPages, PageExploration, type ExploreAllOptions } from './explorer.js'
import { basicPlan, type TestPlan } from '../test-plan.js'
import { ActionBlocklist } from '../../utils/blocklist.js'
import { logger } from '../../utils/logger.js'
import { ensureDir } from '../../utils/file.js'
import path from 'path'
import fs from 'fs/promises'
import { assertPage, AssertionFailure, stepLocator } from './assertions.js'
import { describeSignal, detectCrashText, settleSignals, uniqueSignals, watchServerErrors, type ServerErrorSignal } from './error-signals.js'

export interface ExecutionResult {
  results: TestResult[]
  explorations: PageExploration[]
  /** Operations that only succeeded on a retry (e.g. a login accepted on the second submission). */
  retry_findings: string[]
  /** Pages the plan left out (mode "changed"). */
  skipped_routes?: string[]
  /** Why the logout round-trip / cross-user checks didn't run, when they didn't. */
  session_checks_note?: string
}

export async function executeScenarios(
  scenarios: TestScenario[],
  config: VibeConfig,
  projectRoot: string,
  guidance?: VibeGuidance | null,
  /** Depth per page (see test-plan.ts). Default: from config.mode, fast → light, else thorough. */
  plan: TestPlan = basicPlan(config.mode === 'fast' ? 'fast' : 'deep'),
): Promise<ExecutionResult> {
  if (scenarios.length === 0) throw new Error('No scenarios to execute: empty scenario batch')
  const screenshotsDir = path.join(projectRoot, '.vibe', 'screenshots')
  await ensureDir(screenshotsDir)

  const blocklist = new ActionBlocklist(config.never_interact, guidance)
  if (blocklist.count > 0) {
    logger.info(`Action blocklist: ${blocklist.count} patterns loaded`)
  }

  const results: TestResult[] = []
  const explorations: PageExploration[] = []
  const retryFindings = new Set<string>()
  const noteLogin = (outcome: LoginOutcome) => {
    const finding = describeLoginRetry(outcome, 'Configured login')
    if (finding) retryFindings.add(finding)
  }
  const skippedRoutes = new Set<string>()
  let sessionChecksNote: string | undefined
  const done = (): ExecutionResult => ({
    results, explorations, retry_findings: [...retryFindings],
    ...(skippedRoutes.size > 0 ? { skipped_routes: [...skippedRoutes] } : {}),
    ...(sessionChecksNote ? { session_checks_note: sessionChecksNote } : {}),
  })
  // Pages are explored at the plan's depth; a page whose scenario failed is
  // explored thoroughly whatever was planned.
  const exploreOptions = (): ExploreAllOptions => ({
    writes: config.explore?.writes,
    decide: plan.decide,
    templateOf: plan.templateOf,
    recheck: plan.recheck,
    failedRoutes: new Set(results.filter(result => result.status !== 'pass').map(result => result.scenario.route)),
    onSkip: route => skippedRoutes.add(route),
  })

  const unauthScenarios = scenarios.filter(s => !s.requires_auth)
  const authScenarios = scenarios.filter(s => s.requires_auth)

  // ── Phase 1: Unauthenticated scenarios (own browser) ────────────────
  if (unauthScenarios.length > 0) {
    const browser1 = await chromium.launch({
      headless: !(config.browser?.headed ?? true),
      slowMo: config.browser?.slowMo ?? 100,
    })

    const newUnauthContext = async () => {
      const ctx = await browser1.newContext({
        baseURL: config.url,
        viewport: { width: 1280, height: 800 },
      })
      ctx.setDefaultTimeout(config.browser?.timeout ?? 30000)
      return ctx
    }
    let unauthCtx = await newUnauthContext()

    // This phase stays logged out: its scenarios check public pages, login
    // forms and "redirects to login" behaviour, which a session would mask.
    logger.section(`Executing ${unauthScenarios.length} scenarios (unauthenticated)`)
    for (const scenario of unauthScenarios) {
      logger.info(`Running: ${scenario.name}`)
      try {
        const result = await runScenarioWithRetry(scenario, unauthCtx, config, screenshotsDir, projectRoot)
        results.push(result)
        logResult(result)
      } catch (err) {
        logger.warn(`  Crashed: ${err instanceof Error ? err.message : err}`)
        results.push({
          scenario, status: 'error', duration_ms: 0,
          failure_reason: `Runner crash: ${err instanceof Error ? err.message : String(err)}`,
          step_logs: [],
        })
      }
      // A login scenario that succeeded leaves a session behind; later
      // scenarios and the public-page exploration must start logged out.
      if (fillsPassword(scenario)) {
        await unauthCtx.close().catch(() => {})
        unauthCtx = await newUnauthContext()
      }
    }

    // Explore public pages
    const publicRoutes = [...new Set(unauthScenarios.map(s => s.route).filter(r => !r.includes('redirect')))]
    if (publicRoutes.length > 0) {
      logger.section(`Exploring ${publicRoutes.length} public pages (element-by-element)`)
      const publicExplorations = await exploreAllPages(unauthCtx, publicRoutes, config.url, screenshotsDir, blocklist, exploreOptions())
      explorations.push(...publicExplorations)
    }

    await unauthCtx.close().catch(() => {})
    await browser1.close().catch(() => {})
  }

  // ── Phase 2: Authenticated scenarios (fresh browser, no leftover state) ──
  if (authScenarios.length > 0) {
    const browser2 = await chromium.launch({
      headless: !(config.browser?.headed ?? true),
      slowMo: config.browser?.slowMo ?? 100,
    })

    const isLoginScenario = (s: TestScenario) => {
      const name = s.name.toLowerCase()
      const hasFormSteps = s.steps.some(st => st.action === 'fill')
      return hasFormSteps && (name.includes('login') || name.includes('sign in'))
    }
    const loginResult = results.find(
      r => r.status === 'pass' && isLoginScenario(r.scenario)
    )
    const loginScenario = loginResult?.scenario ??
      unauthScenarios.find(s => isLoginScenario(s))

    let authEstablished = false
    let authCtx: BrowserContext | null = null

    // Configured credentials (vibe.config.json) come first: they work even when
    // no login scenario was generated, e.g. for routes found by the live crawl.
    if (config.auth?.strategy === 'credentials' && config.auth.credentials) {
      logger.info('Establishing authenticated session from configured credentials...')
      const ctx = await browser2.newContext({
        baseURL: config.url,
        viewport: { width: 1280, height: 800 },
      })
      ctx.setDefaultTimeout(config.browser?.timeout ?? 30000)
      const outcome = await performLoginDetailed(ctx, config.url, config.auth, config.retries)
      noteLogin(outcome)
      if (outcome.ok) {
        authCtx = ctx
        authEstablished = true
        logger.success('  Auth established with configured credentials')
      } else {
        await ctx.close().catch(() => {})
        logger.warn('  Configured credentials did not log in; trying a generated login scenario')
      }
    }

    if (!authEstablished && loginScenario) {
      logger.info('Establishing authenticated session (fresh browser)...')

      let tempCtx: BrowserContext
      let loginPage: Page
      try {
        tempCtx = await browser2.newContext({
          baseURL: config.url,
          viewport: { width: 1280, height: 800 },
        })
        loginPage = await tempCtx.newPage()
      } catch (err) {
        logger.warn(`  Cannot create auth context: ${err instanceof Error ? err.message : err}`)
        for (const scenario of authScenarios) {
          results.push({
            scenario, status: 'error', duration_ms: 0,
            failure_reason: 'Browser crashed before auth could be established',
            step_logs: [],
          })
        }
        await browser2.close().catch(() => {})
        return done()
      }
      try {
        const stepsToRun = loginScenario.steps.filter(s => s.action !== 'assert')
        const authApiErrors: ApiError[] = []

        // Monitor all network during auth to debug failures
        const authResponses: Array<{ url: string; status: number }> = []
        loginPage.on('response', (resp) => {
          const url = resp.url()
          if (!url.match(/\.(js|css|png|jpg|svg|woff|ico|map)(\?|$)/)) {
            authResponses.push({ url, status: resp.status() })
          }
        })

        for (const step of stepsToRun) {
          logger.dim(`      [auth] Step: ${step.action} "${step.description}" selector=${step.selector ?? 'none'}`)
          const resolved = await executeStep(loginPage, step, config.url, authApiErrors)
          const currentPath = (() => { try { return new URL(loginPage.url()).pathname } catch { return 'unknown' } })()
          logger.dim(`      [auth]   → resolved=${resolved ?? 'none'}, url=${currentPath}`)
        }

        // Extra wait for SPA post-login — some apps use client-side redirect with delay
        await loginPage.waitForTimeout(3000)

        // Log API responses seen during auth
        if (authResponses.length > 0) {
          for (const r of authResponses) {
            logger.dim(`      [auth] API: ${r.status} ${r.url.slice(0, 100)}`)
          }
        }

        if (authApiErrors.length > 0) {
          const err = authApiErrors[0]
          logger.warn(`  Login API failed: ${err.status} ${err.body.slice(0, 100)}`)
          logger.warn('  Skipping authenticated tests.')
          await loginPage.close().catch(() => {})
          await tempCtx.close().catch(() => {})
        } else {
          const getPath = () => { try { return new URL(loginPage.url()).pathname } catch { return '' } }
          const loginKeywords = ['login', 'signin']
          const isOnLogin = () => loginKeywords.some(k => getPath().includes(k))

          let waited = 0
          while (isOnLogin() && waited < 10000) {
            await loginPage.waitForTimeout(500)
            waited += 500
          }
          logger.dim(`  Post-login URL: ${getPath()} (waited ${waited}ms)`)

          const tokenData = await loginPage.evaluate(`(() => {
            var storage = {};
            for (var i = 0; i < localStorage.length; i++) {
              var key = localStorage.key(i);
              if (key) storage[key] = localStorage.getItem(key) || '';
            }
            return { localStorage: storage, cookies: document.cookie };
          })()`) as { localStorage: Record<string, string>; cookies: string }

          const tokenCount = Object.keys(tokenData.localStorage).length
          const hasTokens = tokenCount > 0
          logger.dim(`  Tokens: ${tokenCount} localStorage, cookies: "${tokenData.cookies.slice(0, 60)}"`)

          const storageState = await tempCtx.storageState()
          await loginPage.close().catch(() => {})
          await tempCtx.close().catch(() => {})

          if (hasTokens || !isOnLogin()) {
            authCtx = await browser2.newContext({
              baseURL: config.url,
              viewport: { width: 1280, height: 800 },
              storageState,
            })
            authCtx.setDefaultTimeout(config.browser?.timeout ?? 30000)

            if (tokenCount > 0) {
              const injectPage = await authCtx.newPage()
              await injectPage.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
              const entries = JSON.stringify(tokenData.localStorage)
              await injectPage.evaluate(`(() => {
                var entries = ${entries};
                for (var k in entries) localStorage.setItem(k, entries[k]);
              })()`)
              await injectPage.close()
              logger.dim(`  Injected ${tokenCount} tokens into auth context`)
            }

            const verifyPage = await authCtx.newPage()
            const protectedRoute = authScenarios[0]?.route ?? '/dashboard'
            await verifyPage.goto(new URL(protectedRoute, config.url).href, { waitUntil: 'domcontentloaded', timeout: 30000 })
            await verifyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
            await verifyPage.waitForTimeout(2000)
            const finalPath = new URL(verifyPage.url()).pathname
            await verifyPage.close()

            if (finalPath.includes('login') || finalPath.includes('signin')) {
              logger.warn(`  Auth NOT working — redirected to ${finalPath}`)
              logger.warn('  Skipping authenticated tests.')
            } else {
              authEstablished = true
              logger.success(`  Auth verified (${finalPath} loaded)`)
            }
          } else {
            logger.warn('  No tokens captured. Login may have failed.')
          }
        }
      } catch (err) {
        logger.warn(`  Auth failed: ${err instanceof Error ? err.message : err}`)
        try { await loginPage.close() } catch {}
        try { await tempCtx.close() } catch {}
      }
    }

    if (authEstablished && authCtx) {
      logger.section(`Executing ${authScenarios.length} scenarios (authenticated)`)
      for (const scenario of authScenarios) {
        logger.info(`Running: ${scenario.name}`)
        try {
          const result = await runScenarioWithRetry(scenario, authCtx, config, screenshotsDir, projectRoot)
          results.push(result)
          logResult(result)
        } catch (err) {
          logger.warn(`  Crashed: ${err instanceof Error ? err.message : err}`)
          results.push({
            scenario, status: 'error', duration_ms: 0,
            failure_reason: `Runner crash: ${err instanceof Error ? err.message : String(err)}`,
            step_logs: [],
          })
        }
      }

      // ── Phase 3: Runtime Exploration ──
      const protectedRoutes = [...new Set(authScenarios.map(s => s.route))]
      if (protectedRoutes.length > 0) {
        logger.section(`Exploring ${protectedRoutes.length} pages (element-by-element)`)
        const authExplorations = await exploreAllPages(authCtx, protectedRoutes, config.url, screenshotsDir, blocklist, exploreOptions())
        // Signed in, a bounce to sign-in means the session was lost, not that the page is protected.
        explorations.push(...authExplorations.map(exploration => ({
          ...exploration,
          signed_in: true,
          errors: exploration.redirected_to
            ? [`Redirected to ${exploration.redirected_to} while signed in — the session expired or login did not stick`]
            : exploration.errors,
        })))
      }

      // Session checks belong to thorough testing: skipped when no page was
      // tested thoroughly (mode fast, or auto with only light pages).
      if (plan.sessionChecks(explorations)) {
        // ── Phase 4a: Cross-user access (only with two configured accounts; own sessions) ──
        const crossUser = await checkCrossUserAccess(browser2, config, protectedRoutes, screenshotsDir, blocklist)
        if (crossUser) {
          results.push(crossUser)
          logResult(crossUser)
        }

        // ── Phase 4b: Logout round-trip (own session, so the others stay signed in) ──
        // The check confirms which of these really asks a signed-out visitor to sign in.
        const protectedPages = protectedRoutes.filter(route => !/[:[*]/.test(route))
        if (protectedPages.length > 0) {
          const logout = await checkLogoutRoundTrip(browser2, config, protectedPages, screenshotsDir, blocklist)
          if (logout) {
            results.push(logout)
            logResult(logout)
          }
        }
      } else {
        // fast mode says so in its own plan note.
        if (plan.mode !== 'fast') sessionChecksNote = `logout round-trip and cross-user checks skipped: no page was tested thoroughly (mode ${plan.mode})`
        logger.dim('  Session checks (logout round-trip, cross-user) skipped for this mode')
      }

      await authCtx.close().catch(() => {})
    } else {
      if (authCtx) await authCtx.close()
      for (const scenario of authScenarios) {
        results.push({
          scenario,
          status: 'fail',
          duration_ms: 0,
          failure_reason: 'Skipped — authenticated session could not be established',
          step_logs: [],
        })
      }
    }

    await browser2.close().catch(() => {})
  }

  return done()
}

function logResult(result: TestResult): void {
  const finalUrl = result.current_url ? ` [${extractUrlPath(result.current_url)}]` : ''
  if (result.status === 'pass') {
    logger.success(`  Passed (${result.duration_ms}ms)${finalUrl}`)
  } else if (result.status === 'fail') {
    logger.error(`  Failed${finalUrl}: ${result.ai_verdict ?? result.failure_reason}`)
  } else {
    logger.warn(`  Error: ${result.failure_reason}`)
  }
}

function extractUrlPath(url: string): string {
  try { return new URL(url).pathname } catch { return url }
}

/**
 * Run a scenario, and run it again (up to config.retries times) when it fails
 * or errors. A pass on a retry is kept as a pass but carries `retry` with the
 * first failure, so it is reported as "only passed on retry" instead of being
 * hidden. When every attempt fails, the first attempt's result (the original
 * evidence) is returned with the attempt count.
 */
export async function runScenarioWithRetry(
  scenario: TestScenario,
  context: BrowserContext,
  config: VibeConfig,
  screenshotsDir: string,
  projectRoot = config.codebase_path ?? process.cwd(),
): Promise<TestResult> {
  const first = await runOneScenario(scenario, context, config, screenshotsDir, projectRoot)
  if (first.status === 'pass' || (config.retries ?? 0) < 1) return first

  const firstFailure = (first.failure_reason ?? first.ai_verdict ?? first.status).slice(0, 200)
  let attempts = 1
  while (attempts <= (config.retries ?? 0)) {
    attempts++
    logger.dim(`  Retrying (attempt ${attempts}): ${scenario.name}`)
    const again = await runOneScenario(scenario, context, config, screenshotsDir, projectRoot)
    if (again.status === 'pass') {
      return { ...again, retry: { attempts, passed_on_retry: true, first_failure: firstFailure } }
    }
  }
  return { ...first, retry: { attempts, passed_on_retry: false, first_failure: firstFailure } }
}

/** Finding text for a scenario that only passed on a retry, or undefined. */
export function describeScenarioRetry(result: TestResult): string | undefined {
  if (!result.retry?.passed_on_retry) return undefined
  return `${result.scenario.name} (${result.scenario.route}): only passed on attempt ${result.retry.attempts} (first attempt: ${result.retry.first_failure})`
}

export async function runOneScenario(
  scenario: TestScenario,
  context: BrowserContext,
  config: VibeConfig,
  screenshotsDir: string,
  projectRoot = config.codebase_path ?? process.cwd()
): Promise<TestResult> {
  const startTime = Date.now()
  const screenshotPath = path.join(screenshotsDir, `${scenario.id}.png`)
  const page = await context.newPage()
  const stepLogs: StepLog[] = []
  const apiErrors: ApiError[] = []
  let navigatedUrl: string | undefined
  // Server crashes (5xx page loads, form posts, fetch/XHR) fail the scenario
  // without needing an assertion; crash text counts when an action caused it.
  const serverWatch = watchServerErrors(page)
  const crashSignals: ServerErrorSignal[] = []
  const serverErrors = () => uniqueSignals([...serverWatch.signals, ...crashSignals])
  const withServerErrors = async (result: TestResult): Promise<TestResult> => {
    await settleSignals(serverWatch.signals)
    const errors = serverErrors()
    if (errors.length === 0) return result
    const evidence = describeSignal(errors[0])
    return {
      ...result,
      status: result.status === 'error' ? 'error' : 'fail',
      server_errors: errors,
      failure_reason: result.failure_reason ? `${evidence}. ${result.failure_reason}` : evidence,
      ai_verdict: result.ai_verdict === undefined
        ? undefined
        : result.status === 'pass'
          ? `${evidence} (page checks passed, but the server failed)`
          : `${evidence}. ${result.ai_verdict}`,
      verification_status: 'not_verified',
    }
  }

  // Decide which steps deserve a screenshot: state-changing steps (fill, click, navigate, select, upload)
  const isScreenshotWorthy = (action: string) => ['fill', 'click', 'navigate', 'select', 'upload'].includes(action)

  try {
    if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) {
      throw new Error('No steps to execute: scenario must contain at least one step')
    }
    // A login submit that leaves the login form showing is resubmitted on the
    // same page (like the configured login): some apps only accept a later
    // submit, and page state is lost on a fresh page.
    let fillsSinceNavigate: TestStep[] = []
    let passwordFilled = false
    let loginRetry: NonNullable<TestResult['retry']> | undefined
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      const urlBefore = page.url()
      const stepStart = Date.now()
      let selectorUsed: string | undefined
      let stepScreenshotPath: string | undefined

      try {
        const crashBefore = step.action === 'click' ? await detectCrashText(page) : undefined
        selectorUsed = await executeStep(page, step, config.url, apiErrors, projectRoot)
        if (step.action === 'navigate') { fillsSinceNavigate = []; passwordFilled = false }
        if (step.action === 'fill' && step.value) {
          fillsSinceNavigate.push(step)
          if (await hasPasswordValue(page, step.value)) passwordFilled = true
        }
        if (step.action === 'click' && passwordFilled && isSubmitStep(step) && !loginRetry) {
          loginRetry = await resubmitRejectedLogin(page, step, fillsSinceNavigate, urlBefore, config, apiErrors, projectRoot)
        }
        if (step.action === 'click') {
          const crashAfter = await detectCrashText(page)
          if (crashAfter && crashAfter !== crashBefore) {
            crashSignals.push({ url: page.url(), evidence: crashAfter })
          }
        }

        if (step.action === 'navigate' && !navigatedUrl) {
          navigatedUrl = step.url?.startsWith('http')
            ? step.url
            : new URL(step.url ?? '/', config.url).href
        }

        // Capture screenshot after state-changing steps
        if (isScreenshotWorthy(step.action)) {
          stepScreenshotPath = path.join(screenshotsDir, `${scenario.id}_step${i}.png`)
          try {
            await page.screenshot({ path: stepScreenshotPath, fullPage: false })
          } catch { stepScreenshotPath = undefined }
        }

        stepLogs.push({
          step,
          status: 'ok',
          url_before: urlBefore,
          url_after: page.url(),
          duration_ms: Date.now() - stepStart,
          selector_used: selectorUsed,
          screenshot_path: stepScreenshotPath,
        })
      } catch (stepErr: unknown) {
        // Always capture screenshot on step failure
        stepScreenshotPath = path.join(screenshotsDir, `${scenario.id}_step${i}_error.png`)
        try {
          await page.screenshot({ path: stepScreenshotPath, fullPage: false })
        } catch { stepScreenshotPath = undefined }

        stepLogs.push({
          step,
          status: 'failed',
          url_before: urlBefore,
          url_after: page.url(),
          duration_ms: Date.now() - stepStart,
          error: stepErr instanceof Error ? stepErr.message : String(stepErr),
          selector_used: selectorUsed,
          screenshot_path: stepScreenshotPath,
        })
        throw stepErr
      }
    }

    // Wait briefly for toasts/redirects to settle before verification
    const hasFormSubmit = scenario.steps.some(s => s.action === 'fill')
    if (hasFormSubmit) {
      await page.waitForTimeout(1500)
    }

    await page.screenshot({ path: screenshotPath, fullPage: true })

    const verdict = await verifyResult(page, scenario, screenshotPath, navigatedUrl, apiErrors)

    return await withServerErrors({
      scenario,
      retry: verdict.passed ? loginRetry : undefined,
      status: verdict.passed ? 'pass' : 'fail',
      duration_ms: Date.now() - startTime,
      screenshot_path: screenshotPath,
      current_url: page.url(),
      navigated_url: navigatedUrl,
      ai_verdict: verdict.explanation,
      verification_status: verdict.verification,
      step_logs: stepLogs,
      api_errors: apiErrors.length > 0 ? apiErrors : undefined,
    })
  } catch (err: unknown) {
    try { await page.screenshot({ path: screenshotPath, fullPage: false }) } catch { /* ignore */ }

    return await withServerErrors({
      scenario,
      status: err instanceof AssertionFailure ? 'fail' : 'error',
      duration_ms: Date.now() - startTime,
      screenshot_path: screenshotPath,
      current_url: page.url(),
      navigated_url: navigatedUrl,
      failure_reason: err instanceof Error ? err.message : String(err),
      verification_status: 'not_verified',
      step_logs: stepLogs,
      api_errors: apiErrors.length > 0 ? apiErrors : undefined,
    })
  } finally {
    serverWatch.stop()
    await page.close()
  }
}

/** True when a scenario types into a password field (a login or sign-up flow). */
function fillsPassword(scenario: TestScenario): boolean {
  return scenario.steps.some(step => step.action === 'fill' && /password/i.test(`${step.selector ?? ''} ${step.description}`))
}

/** A click step that executeStep treats as a form submit. */
function isSubmitStep(step: TestStep): boolean {
  return !!(step.selector?.includes('submit') || step.description.toLowerCase().includes('submit'))
}

/** True when a visible password field holds `value` (the step just filled a password). */
async function hasPasswordValue(page: Page, value: string): Promise<boolean> {
  return page.evaluate(
    expected => Array.from(document.querySelectorAll('input[type="password"]')).some(el => (el as HTMLInputElement).value === expected),
    value,
  ).catch(() => false)
}

/**
 * After a submit that filled a password: while the page is still the login
 * form, refill and resubmit it, up to config.retries more times. Returns retry
 * info when a later submit got past the login form (the scenario passes, but
 * the inconsistent login is reported); undefined when the first submit worked
 * or none did.
 */
async function resubmitRejectedLogin(
  page: Page,
  submit: TestStep,
  fills: TestStep[],
  loginUrl: string,
  config: VibeConfig,
  apiErrors: ApiError[] | undefined,
  projectRoot: string,
): Promise<NonNullable<TestResult['retry']> | undefined> {
  const retries = config.retries ?? 0
  if (retries < 1 || !await waitForLoginOutcome(page, loginUrl)) return undefined
  const firstFailure = await readLoginError(page) ?? 'stayed on the login page'
  let attempts = 1
  while (attempts <= retries) {
    attempts++
    logger.dim(`  Login still shown; resubmitting (attempt ${attempts})`)
    for (const fill of fills) await executeStep(page, fill, config.url, apiErrors, projectRoot)
    await executeStep(page, submit, config.url, apiErrors, projectRoot)
    if (!await waitForLoginOutcome(page, loginUrl)) {
      // The rejected submits' responses are the retry finding, not extra failures.
      apiErrors?.splice(0, apiErrors.length)
      return { attempts, passed_on_retry: true, first_failure: firstFailure }
    }
  }
  return undefined
}

async function executeStep(page: Page, step: TestStep, baseUrl: string, apiErrors?: ApiError[], projectRoot = process.cwd()): Promise<string | undefined> {
  const timeout = step.timeout ?? 15000
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Step timeout must be a positive finite number')

  switch (step.action) {
    case 'navigate': {
      const url = step.url?.startsWith('http')
        ? step.url
        : new URL(step.url ?? '/', baseUrl).href
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 30000) })
      return undefined
    }
    case 'fill': {
      if (!step.value) break
      const { locator, resolved } = await resolveLocator(page, step, timeout)
      await locator.fill(step.value, { timeout })
      return resolved
    }
    case 'click': {
      const { locator, resolved } = await resolveLocator(page, step, timeout)
      const isSubmit = step.selector?.includes('submit') ||
        step.description.toLowerCase().includes('submit')

      if (isSubmit) {
        const urlBefore = page.url()
        // Collect API responses while the submit settles. (Waiting separately
        // for one with an 8s timeout stalled every submit whose form posts
        // somewhere other than /api or /auth, e.g. a server-rendered app.)
        const apiResponses: Response[] = []
        const onResponse = (resp: Response) => {
          if ((resp.url().includes('/api') || resp.url().includes('/auth')) && resp.status() > 0) apiResponses.push(resp)
        }
        page.on('response', onResponse)
        try {
          await locator.click({ timeout })
          // Wait for the page to settle (URL change, network idle, or toast)
          await waitForSubmitSettled(page, urlBefore, timeout)
        } finally {
          page.off('response', onResponse)
        }

        // Check the first API response the submit produced
        const apiResp = apiResponses[0]
        if (apiResp && apiResp.status() >= 400 && apiErrors) {
          const body = await apiResp.text().catch(() => '')
          apiErrors.push({ url: apiResp.url(), status: apiResp.status(), body: body.slice(0, 200) })
        }
      } else {
        await locator.click({ timeout })
      }
      return resolved
    }
    case 'select': {
      if (!step.value) break
      const { locator, resolved } = await resolveLocator(page, step, timeout)
      await locator.selectOption(step.value, { timeout })
      return resolved
    }
    case 'wait': {
      const ms = parseInt(step.value ?? '1000')
      await page.waitForTimeout(ms)
      return undefined
    }
    case 'upload': {
      if (typeof step.value !== 'string' || !step.value.trim()) throw new Error('upload requires a nonempty file path in value')
      if (typeof step.selector !== 'string' || !step.selector.trim()) throw new Error('upload requires a nonempty file input selector')
      const filePath = path.resolve(projectRoot, step.value)
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) throw new Error(`Upload path is not a file: ${filePath}`)
      await stepLocator(page, step.selector).setInputFiles(filePath, { timeout })
      return step.selector
    }
    case 'assert':
      return assertPage(page, step, baseUrl)
    default:
      throw new Error(`Unsupported step action: ${String(step.action)}`)
  }
  return undefined
}

/**
 * Resolves the best locator for a step using a cascade of strategies.
 * For submit buttons: uses the exact CSS selector first (button[type="submit"]).
 * For form fields: tries label, placeholder, then CSS.
 */
export async function resolveLocator(
  page: Page,
  step: TestStep,
  timeout: number
): Promise<{ locator: Locator; resolved: string }> {
  const selector = step.selector ?? ''
  const isSubmit = step.action === 'click' && (
    selector.includes('[type="submit"]') ||
    step.description.toLowerCase().includes('submit')
  )
  const strategies: Array<{ locator: Locator; name: string }> = []

  if (isSubmit) {
    // For submit buttons: CSS selector FIRST to avoid hitting eye toggle / other buttons
    strategies.push({
      locator: page.locator('button[type="submit"], input[type="submit"]'),
      name: 'button[type="submit"]',
    })
    // Then try role with the actual button text
    strategies.push({
      locator: page.getByRole('button', { name: /submit|sign|create|register|log\s*in|save|send/i }),
      name: 'getByRole("button", pattern)',
    })
  } else if (step.action === 'fill') {
    // For form fields: label > placeholder > CSS id > CSS name > type
    const labelHint = extractLabelHint(step)
    if (labelHint) {
      strategies.push({
        locator: fillableByLabel(page, labelHint),
        name: `getByLabel("${labelHint}")→input`,
      })
    }

    const placeholderHint = extractPlaceholderHint(step)
    if (placeholderHint) {
      strategies.push({
        locator: page.getByPlaceholder(placeholderHint, { exact: false }),
        name: `getByPlaceholder("${placeholderHint}")`,
      })
    }

    const idMatch = selector.match(/#([\w-]+)/)
    if (idMatch) {
      strategies.push({
        locator: page.locator(`#${idMatch[1]}`),
        name: `#${idMatch[1]}`,
      })
    }

    const nameMatch = selector.match(/\[name="([^"]+)"\]/)
    if (nameMatch) {
      strategies.push({
        locator: page.locator(`[name="${nameMatch[1]}"]`),
        name: `[name="${nameMatch[1]}"]`,
      })
    }

    const typeMatch = selector.match(/\[type="([^"]+)"\]/)
    if (typeMatch) {
      strategies.push({
        locator: page.locator(`[type="${typeMatch[1]}"]`),
        name: `[type="${typeMatch[1]}"]`,
      })
    }
  } else {
    // For non-submit clicks and other actions: standard cascade
    const roleHint = extractRoleHint(step)
    if (roleHint?.name) {
      strategies.push({
        locator: page.getByRole(roleHint.role as 'button' | 'link' | 'textbox', { name: roleHint.name }),
        name: `getByRole("${roleHint.role}", { name: "${roleHint.name}" })`,
      })
    }
  }

  // Handle pseudo-selectors from enricher: text=, placeholder=, role=
  const textMatch = selector.match(/^text=(.+)$/)
  if (textMatch) {
    const text = textMatch[1]
    strategies.push({
      locator: page.getByText(text, { exact: false }),
      name: `getByText("${text}")`,
    })
    strategies.push({
      locator: page.getByRole('button', { name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }),
      name: `getByRole("button", pattern="${text}")`,
    })
  }

  const placeholderSel = selector.match(/^placeholder=(.+)$/)
  if (placeholderSel) {
    strategies.push({
      locator: page.getByPlaceholder(placeholderSel[1], { exact: false }),
      name: `getByPlaceholder("${placeholderSel[1]}")`,
    })
  }

  const labelSel = selector.match(/^label=(.+)$/)
  if (labelSel) {
    const lt = labelSel[1].trim()
    strategies.push({
      locator: fillableByLabel(page, lt, true),
      name: `getByLabel("${lt}")→input`,
    })
    strategies.push({
      locator: fillableByLabel(page, lt, false),
      name: `getByLabel("${lt}", fuzzy)→input`,
    })
  }

  const roleMatch = selector.match(/^role=(\w+)\[name="([^"]+)"\]$/)
  if (roleMatch) {
    strategies.push({
      locator: page.getByRole(roleMatch[1] as 'button' | 'link', { name: new RegExp(roleMatch[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }),
      name: `getByRole("${roleMatch[1]}", name="${roleMatch[2]}")`,
    })
  }

  // Raw CSS selector segments as fallback (skip pseudo-selectors)
  if (selector && !selector.startsWith('text=') && !selector.startsWith('placeholder=') && !selector.startsWith('role=') && !selector.startsWith('label=')) {
    if (!selector.includes(',')) {
      strategies.push({ locator: page.locator(selector), name: selector })
    } else {
      for (const seg of selector.split(',').map(s => s.trim())) {
        strategies.push({ locator: page.locator(seg), name: seg })
      }
    }
  }

  // Try each strategy — first one with a visible match wins. Check every match
  // (up to a cap), not just the first: a hidden duplicate (mobile menu copy,
  // collapsed panel) often comes before the visible element in the DOM.
  for (const { locator, name } of strategies) {
    try {
      const count = Math.min(await locator.count(), 10)
      for (let i = 0; i < count; i++) {
        const candidate = locator.nth(i)
        if (await candidate.isVisible().catch(() => false)) {
          return { locator: candidate, resolved: name }
        }
      }
    } catch {
      continue
    }
  }

  // Final fallback — never pass label=/placeholder= to page.locator (invalid CSS)
  if (selector) {
    const firstSeg = selector.split(',')[0].trim()
    const lbl = firstSeg.match(/^label=(.+)$/)
    if (lbl) {
      return { locator: fillableByLabel(page, lbl[1].trim(), false), resolved: `fallback: getByLabel("${lbl[1]}")→input` }
    }
    const ph = firstSeg.match(/^placeholder=(.+)$/)
    if (ph) {
      return { locator: page.getByPlaceholder(ph[1], { exact: false }).first(), resolved: `fallback: getByPlaceholder("${ph[1]}")` }
    }
    // .first() so several matches don't raise a strict-mode violation later
    return { locator: page.locator(firstSeg).first(), resolved: `fallback: ${firstSeg}` }
  }

  throw new Error(`No valid selector for step: ${step.description}`)
}

/**
 * Prefer real controls — getByLabel can match dialogs / sections titled like the field.
 * The labelled element is usually the control itself (<label for> + <input>), so
 * match it directly, or else a control inside a labelled container.
 */
function fillableByLabel(page: Page, text: string, exact?: boolean): Locator {
  const base = exact ? page.getByLabel(text, { exact: true }) : page.getByLabel(text, { exact: false })
  const fillable = 'input, textarea, select, [contenteditable="true"]'
  return base.and(page.locator(fillable)).or(base.locator(fillable)).first()
}

/**
 * Extracts a label hint from the step description for getByLabel().
 * Uses the field name from the description generically — capitalizes the
 * first word after "Fill" to guess label text (e.g. "Fill email..." → "Email").
 */
function extractLabelHint(step: TestStep): string | null {
  if (step.action !== 'fill') return null

  // Extract the field name from the description: "Fill email with..." → "email"
  const fillMatch = step.description.match(/Fill\s+(\w+)/i)
  if (fillMatch) {
    const fieldName = fillMatch[1]
    // Capitalize for label matching: "email" → "Email", "fullName" → "FullName"
    return fieldName.charAt(0).toUpperCase() + fieldName.slice(1)
  }

  return null
}

/**
 * Extracts role-based locator hints generically.
 * For buttons: just uses role="button" without assuming button text.
 * For fill actions: uses role="textbox".
 */
function extractRoleHint(step: TestStep): { role: string; name?: string } | null {
  if (step.action === 'click') {
    const isSubmit = step.selector?.includes('[type="submit"]') ||
      step.description.toLowerCase().includes('submit')
    if (isSubmit) return { role: 'button' }

    if (step.description.toLowerCase().includes('link')) return { role: 'link' }
  }

  if (step.action === 'fill') {
    return { role: 'textbox' }
  }

  return null
}

/**
 * Extracts placeholder hints from step description generically.
 * Looks for common field type keywords and returns a partial placeholder to match.
 */
function extractPlaceholderHint(step: TestStep): string | null {
  if (step.action !== 'fill') return null

  const desc = step.description.toLowerCase()

  if (desc.includes('email'))    return 'email'
  if (desc.includes('search'))   return 'search'
  if (desc.includes('phone') || desc.includes('tel')) return 'phone'
  if (desc.includes('url'))      return 'http'

  return null
}

/**
 * After clicking a submit button, wait for the page to "settle" by racing
 * multiple signals: URL change, network idle, or a toast/status element appearing.
 * This handles both redirect-after-submit and success-on-same-page patterns.
 */
async function waitForSubmitSettled(page: Page, urlBefore: string, timeout: number): Promise<void> {
  const settleTimeout = Math.max(timeout, 15000)

  const urlChanged = (): Promise<string> =>
    page.waitForURL((url) => url.href !== urlBefore, { timeout: settleTimeout })
      .then(() => 'url-changed')
      .catch(() => 'timeout')

  const networkIdle = (): Promise<string> =>
    page.waitForLoadState('networkidle', { timeout: settleTimeout })
      .then(() => 'network-idle')
      .catch(() => 'timeout')

  const toastAppeared = (): Promise<string> =>
    page.locator([
      '[data-sonner-toast]',
      '[data-state="open"][role="status"]',
      '[role="status"]:not(:empty)',
      '[data-radix-toast-viewport] > *',
      '.Toastify__toast',
      '.toast:not(:empty)',
      '[class*="toast"][class*="success"]',
      '[class*="toast"][class*="error"]',
    ].join(', ')).first().waitFor({ state: 'visible', timeout: settleTimeout })
      .then(() => 'toast-appeared')
      .catch(() => 'timeout')

  await Promise.race([urlChanged(), networkIdle(), toastAppeared()])

  // Brief pause to let any follow-up navigation (e.g. toast → redirect) settle
  await page.waitForTimeout(500)
}
