import { chromium, BrowserContext, Page, Locator } from 'playwright'
import { TestScenario, TestResult, TestStep, StepLog, ApiError } from '../../types/index.js'
import { VibeConfig, VibeGuidance } from '../../types/config.js'
import { performLogin } from './auth.js'
import { verifyResult } from './verifier.js'
import { exploreAllPages, PageExploration } from './explorer.js'
import { ActionBlocklist } from '../../utils/blocklist.js'
import { logger } from '../../utils/logger.js'
import { ensureDir } from '../../utils/file.js'
import path from 'path'

export interface ExecutionResult {
  results: TestResult[]
  explorations: PageExploration[]
}

export async function executeScenarios(
  scenarios: TestScenario[],
  config: VibeConfig,
  projectRoot: string,
  guidance?: VibeGuidance | null
): Promise<ExecutionResult> {
  const screenshotsDir = path.join(projectRoot, '.vibe', 'screenshots')
  await ensureDir(screenshotsDir)

  const blocklist = new ActionBlocklist(config.never_interact, guidance)
  if (blocklist.count > 0) {
    logger.info(`Action blocklist: ${blocklist.count} patterns loaded`)
  }

  const results: TestResult[] = []
  const explorations: PageExploration[] = []

  const unauthScenarios = scenarios.filter(s => !s.requires_auth)
  const authScenarios = scenarios.filter(s => s.requires_auth)

  // ── Phase 1: Unauthenticated scenarios (own browser) ────────────────
  if (unauthScenarios.length > 0) {
    const browser1 = await chromium.launch({
      headless: !(config.browser?.headed ?? true),
      slowMo: config.browser?.slowMo ?? 100,
    })

    const unauthCtx = await browser1.newContext({
      baseURL: config.url,
      viewport: { width: 1280, height: 800 },
    })
    unauthCtx.setDefaultTimeout(config.browser?.timeout ?? 30000)

    if (config.auth?.strategy === 'credentials') {
      await performLogin(unauthCtx, config.url, config.auth)
    }

    logger.section(`Executing ${unauthScenarios.length} scenarios (unauthenticated)`)
    for (const scenario of unauthScenarios) {
      logger.info(`Running: ${scenario.name}`)
      try {
        const result = await runOneScenario(scenario, unauthCtx, config, screenshotsDir)
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

    // Explore public pages
    const publicRoutes = [...new Set(unauthScenarios.map(s => s.route).filter(r => !r.includes('redirect')))]
    if (publicRoutes.length > 0) {
      logger.section(`Exploring ${publicRoutes.length} public pages (element-by-element)`)
      const publicExplorations = await exploreAllPages(unauthCtx, publicRoutes, config.url, screenshotsDir, blocklist)
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

    if (loginScenario) {
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
        return { results, explorations }
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
          const result = await runOneScenario(scenario, authCtx, config, screenshotsDir)
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
        const authExplorations = await exploreAllPages(authCtx, protectedRoutes, config.url, screenshotsDir, blocklist)
        explorations.push(...authExplorations)
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

  return { results, explorations }
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

async function runOneScenario(
  scenario: TestScenario,
  context: BrowserContext,
  config: VibeConfig,
  screenshotsDir: string
): Promise<TestResult> {
  const startTime = Date.now()
  const screenshotPath = path.join(screenshotsDir, `${scenario.id}.png`)
  const page = await context.newPage()
  const stepLogs: StepLog[] = []
  const apiErrors: ApiError[] = []
  let navigatedUrl: string | undefined

  // Decide which steps deserve a screenshot: state-changing steps (fill, click, navigate, select)
  const isScreenshotWorthy = (action: string) => ['fill', 'click', 'navigate', 'select'].includes(action)

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      const urlBefore = page.url()
      const stepStart = Date.now()
      let selectorUsed: string | undefined
      let stepScreenshotPath: string | undefined

      try {
        selectorUsed = await executeStep(page, step, config.url, apiErrors)

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

    return {
      scenario,
      status: verdict.passed ? 'pass' : 'fail',
      duration_ms: Date.now() - startTime,
      screenshot_path: screenshotPath,
      current_url: page.url(),
      navigated_url: navigatedUrl,
      ai_verdict: verdict.explanation,
      step_logs: stepLogs,
      api_errors: apiErrors.length > 0 ? apiErrors : undefined,
    }
  } catch (err: unknown) {
    try { await page.screenshot({ path: screenshotPath, fullPage: false }) } catch { /* ignore */ }

    return {
      scenario,
      status: 'error',
      duration_ms: Date.now() - startTime,
      screenshot_path: screenshotPath,
      current_url: page.url(),
      navigated_url: navigatedUrl,
      failure_reason: err instanceof Error ? err.message : String(err),
      step_logs: stepLogs,
      api_errors: apiErrors.length > 0 ? apiErrors : undefined,
    }
  } finally {
    await page.close()
  }
}

async function executeStep(page: Page, step: TestStep, baseUrl: string, apiErrors?: ApiError[]): Promise<string | undefined> {
  const timeout = step.timeout ?? 15000

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
        // Click and capture API response in parallel (3s grace for API to respond)
        const responsePromise = page.waitForResponse(
          resp => (resp.url().includes('/api') || resp.url().includes('/auth')) && resp.status() > 0,
          { timeout: 8000 }
        ).catch(() => null)

        await locator.click({ timeout })

        // Wait for the page to settle (URL change, network idle, or toast)
        await waitForSubmitSettled(page, urlBefore, timeout)

        // Check if we got an API response
        const apiResp = await responsePromise
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
      if (!step.value) break
      const { locator, resolved } = await resolveLocator(page, step, timeout)
      await locator.setInputFiles(step.value, { timeout })
      return resolved
    }
    case 'assert': {
      // Check for hard error indicators on the page
      const errorEl = page.locator('[role="alert"], [data-error], .error-message, .toast-error').first()
      const hasError = await errorEl.isVisible({ timeout: 500 }).catch(() => false)
      if (hasError) {
        const errorText = await errorEl.textContent().catch(() => 'Unknown error')
        throw new Error(`Assertion failed — error visible on page: ${errorText?.slice(0, 200)}`)
      }
      // Check for blank/crashed page
      const bodyText = await page.locator('body').textContent().catch(() => '') ?? ''
      if (bodyText.trim().length < 10) {
        throw new Error('Assertion failed — page appears blank or crashed')
      }
      return undefined
    }
  }
  return undefined
}

/**
 * Resolves the best locator for a step using a cascade of strategies.
 * For submit buttons: uses the exact CSS selector first (button[type="submit"]).
 * For form fields: tries label, placeholder, then CSS.
 */
async function resolveLocator(
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

  // Try each strategy — first one with a visible match wins
  for (const { locator, name } of strategies) {
    try {
      const count = await locator.count()
      if (count > 0) {
        const first = locator.first()
        const visible = await first.isVisible().catch(() => false)
        if (visible) {
          return { locator: first, resolved: name }
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
      return { locator: page.getByPlaceholder(ph[1], { exact: false }), resolved: `fallback: getByPlaceholder("${ph[1]}")` }
    }
    return { locator: page.locator(firstSeg), resolved: `fallback: ${firstSeg}` }
  }

  throw new Error(`No valid selector for step: ${step.description}`)
}

/** Prefer real controls — getByLabel can match dialogs / sections titled like the field. */
function fillableByLabel(page: Page, text: string, exact?: boolean): Locator {
  const base = exact ? page.getByLabel(text, { exact: true }) : page.getByLabel(text, { exact: false })
  return base.locator('input, textarea, select, [contenteditable="true"]').first()
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
