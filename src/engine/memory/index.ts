import { Memory, TestResult, Bug } from '../../types/index.js'
import { readJSON, writeJSON, ensureDir } from '../../utils/file.js'
import { logger } from '../../utils/logger.js'
import path from 'path'

export interface RouteIntel {
  path: string
  needs_auth: boolean
  has_form: boolean
  needs_url_params: boolean
  avg_load_ms: number
  load_samples: number
  last_status: 'pass' | 'fail' | 'error' | 'unknown'
  fail_reasons: string[]
  working_selectors: Record<string, string>
  failed_selectors: string[]
}

export interface AuthIntel {
  login_route: string
  register_route?: string
  post_login_redirect: string
  token_storage: 'localStorage' | 'cookie' | 'unknown'
  token_keys: string[]
  session_established: boolean
}

export interface RunSummary {
  run_id: string
  timestamp: string
  total: number
  passed: number
  failed: number
  errors: number
  pass_rate: number
  improvements: string[]
  regressions: string[]
}

export interface ProjectIntel {
  version: 1
  routes: Record<string, RouteIntel>
  auth: AuthIntel | null
  credentials: SavedCredentials | null
  avg_scenario_ms: number
  run_history: RunSummary[]
  known_skip_routes: string[]
  global_selectors: Record<string, string>
}

export interface SavedCredentials {
  email: string
  password: string
  registered_at: string
  last_login_success?: string
}

export interface MemoryRecommendations {
  skip_routes: Set<string>
  auth_routes: Set<string>
  timeout_hints: Record<string, number>
  selector_hints: Record<string, string>
  first_run: boolean
  auth_intel: AuthIntel | null
  saved_credentials: SavedCredentials | null
}

export class MemoryManager {
  private memoryPath: string
  private intelPath: string
  private memory: Memory
  private intel: ProjectIntel
  private bugCounter: number = 1

  constructor(projectRoot: string) {
    this.memoryPath = path.join(projectRoot, '.vibe', 'memory.json')
    this.intelPath = path.join(projectRoot, '.vibe', 'memory', 'project-intel.json')
    this.memory = this.defaultMemory(path.basename(projectRoot))
    this.intel = this.defaultIntel()
  }

  async load(): Promise<Memory> {
    const stored = await readJSON<Memory>(this.memoryPath)
    if (stored) {
      this.memory = stored
      this.bugCounter = this.memory.known_bugs.length + 1
    }

    const storedIntel = await readJSON<ProjectIntel>(this.intelPath)
    if (storedIntel) {
      this.intel = storedIntel
      const runCount = this.intel.run_history.length
      if (runCount > 0) {
        const lastRun = this.intel.run_history[runCount - 1]
        logger.info(`Loaded intelligence from ${runCount} previous run(s) (last: ${lastRun.passed}/${lastRun.total} passed)`)
        if (this.intel.known_skip_routes.length > 0) {
          logger.dim(`  Skipping ${this.intel.known_skip_routes.length} known-broken route(s)`)
        }
      }
    }

    return this.memory
  }

  async updateFromResults(results: TestResult[]): Promise<void> {
    this.memory.last_run = new Date().toISOString()
    this.memory.run_count++

    for (const result of results) {
      if (result.status === 'pass') {
        this.handlePass(result)
      } else if (result.status === 'fail' || result.status === 'error') {
        this.handleFail(result)
      }
    }

    if (this.memory.flaky_flows.length > 100) {
      this.memory.flaky_flows = this.memory.flaky_flows
        .sort((a, b) => b.fail_rate - a.fail_rate)
        .slice(0, 100)
    }

    await writeJSON(this.memoryPath, this.memory)

    // Update project intelligence
    this.learnFromResults(results)
    await ensureDir(path.dirname(this.intelPath))
    await writeJSON(this.intelPath, this.intel)

    this.logLearnings(results)
  }

  getMemory(): Memory { return this.memory }

  getRecommendations(): MemoryRecommendations {
    if (this.intel.run_history.length === 0) {
      return {
        skip_routes: new Set(),
        auth_routes: new Set(),
        timeout_hints: {},
        selector_hints: {},
        first_run: true,
        auth_intel: null,
        saved_credentials: this.intel.credentials ?? null,
      }
    }

    const skip = new Set(this.intel.known_skip_routes)
    const auth = new Set<string>()
    const timeouts: Record<string, number> = {}
    const selectors: Record<string, string> = { ...this.intel.global_selectors }

    for (const [routePath, ri] of Object.entries(this.intel.routes)) {
      if (ri.needs_auth) auth.add(routePath)
      if (ri.avg_load_ms > 8000) {
        timeouts[routePath] = Math.round(ri.avg_load_ms * 1.5)
      }
      Object.assign(selectors, ri.working_selectors)
    }

    return {
      skip_routes: skip,
      auth_routes: auth,
      timeout_hints: timeouts,
      selector_hints: selectors,
      first_run: false,
      auth_intel: this.intel.auth,
      saved_credentials: this.intel.credentials ?? null,
    }
  }

  // ── Learning logic ──────────────────────────────────────────────────

  private learnFromResults(results: TestResult[]): void {
    for (const result of results) {
      this.learnRoute(result)
      this.learnSelectors(result)
    }
    this.learnAuth(results)
    this.updateSkipRoutes()

    const totalMs = results.reduce((s, r) => s + r.duration_ms, 0)
    this.intel.avg_scenario_ms = results.length > 0 ? Math.round(totalMs / results.length) : 0

    // Build run summary
    const passed = results.filter(r => r.status === 'pass')
    const failed = results.filter(r => r.status === 'fail')
    const errored = results.filter(r => r.status === 'error')
    const passRate = results.length > 0 ? passed.length / results.length : 0

    const prevRun = this.intel.run_history[this.intel.run_history.length - 1]
    const improvements: string[] = []
    const regressions: string[] = []

    if (prevRun) {
      if (passRate > prevRun.pass_rate) {
        improvements.push(`Pass rate: ${(prevRun.pass_rate * 100).toFixed(0)}% → ${(passRate * 100).toFixed(0)}%`)
      } else if (passRate < prevRun.pass_rate) {
        regressions.push(`Pass rate: ${(prevRun.pass_rate * 100).toFixed(0)}% → ${(passRate * 100).toFixed(0)}%`)
      }
      if (passed.length > prevRun.passed) improvements.push(`+${passed.length - prevRun.passed} more tests passing`)
      if (errored.length < prevRun.errors) improvements.push(`-${prevRun.errors - errored.length} errors`)
    }

    this.intel.run_history.push({
      run_id: `run-${this.intel.run_history.length + 1}`,
      timestamp: new Date().toISOString(),
      total: results.length,
      passed: passed.length,
      failed: failed.length,
      errors: errored.length,
      pass_rate: passRate,
      improvements,
      regressions,
    })

    if (this.intel.run_history.length > 20) {
      this.intel.run_history = this.intel.run_history.slice(-20)
    }
  }

  private learnRoute(result: TestResult): void {
    const route = result.scenario.route
    const ri: RouteIntel = this.intel.routes[route] ?? {
      path: route,
      needs_auth: false,
      has_form: false,
      needs_url_params: false,
      avg_load_ms: 0,
      load_samples: 0,
      last_status: 'unknown',
      fail_reasons: [],
      working_selectors: {},
      failed_selectors: [],
    }

    ri.last_status = result.status === 'pass' ? 'pass' : result.status === 'fail' ? 'fail' : 'error'

    if (result.duration_ms > 0) {
      const total = ri.avg_load_ms * ri.load_samples + result.duration_ms
      ri.load_samples += 1
      ri.avg_load_ms = Math.round(total / ri.load_samples)
    }

    const reason = result.failure_reason ?? result.ai_verdict ?? ''
    if (reason.includes('authentication') || (reason.includes('redirect') && reason.includes('login'))) {
      ri.needs_auth = true
    }
    if (result.scenario.requires_auth) ri.needs_auth = true
    if (result.scenario.steps.some(s => s.action === 'fill')) ri.has_form = true
    if (reason.includes('Invalid reset') || reason.includes('token') || ri.path.includes('reset-password')) {
      ri.needs_url_params = true
    }

    if (result.status !== 'pass' && reason) {
      const short = reason.slice(0, 100)
      if (!ri.fail_reasons.includes(short)) {
        ri.fail_reasons.push(short)
        if (ri.fail_reasons.length > 5) ri.fail_reasons.shift()
      }
    }

    // Clear fail reasons on pass
    if (result.status === 'pass') {
      ri.fail_reasons = []
    }

    this.intel.routes[route] = ri
  }

  private learnAuth(results: TestResult[]): void {
    const loginResult = results.find(r =>
      r.scenario.name.toLowerCase().includes('login') && r.scenario.steps.some(s => s.action === 'fill')
    )
    const registerResult = results.find(r =>
      r.scenario.name.toLowerCase().includes('register') && r.scenario.steps.some(s => s.action === 'fill')
    )

    if (!loginResult) return

    const currentUrl = loginResult.current_url ?? ''
    let postLoginPath = ''
    try { postLoginPath = new URL(currentUrl).pathname } catch {}

    this.intel.auth = {
      login_route: loginResult.scenario.route,
      register_route: registerResult?.scenario.route,
      post_login_redirect: postLoginPath !== loginResult.scenario.route ? postLoginPath : '',
      token_storage: 'unknown',
      token_keys: [],
      session_established: false,
      ...(this.intel.auth ?? {}),
    }

    // Detect if post-login redirect worked (URL changed away from login)
    if (loginResult.status === 'pass' && postLoginPath && !postLoginPath.includes('login')) {
      this.intel.auth.session_established = true
      this.intel.auth.post_login_redirect = postLoginPath
    }

    // Save credentials only when login was actually verified (auth session works)
    // Use register scenario as the source if login also passed, since register has the newest email
    const credSource = registerResult?.status === 'pass' ? registerResult : (loginResult.status === 'pass' ? loginResult : null)
    if (credSource && this.intel.auth?.session_established) {
      const fillSteps = credSource.scenario.steps.filter(s => s.action === 'fill')
      const emailStep = fillSteps.find(s => {
        const desc = s.description.toLowerCase()
        return desc.includes('email') || s.selector?.includes('email')
      })
      const passwordStep = fillSteps.find(s => {
        const desc = s.description.toLowerCase()
        return desc.includes('password') || s.selector?.includes('password')
      })

      if (emailStep?.value && passwordStep?.value) {
        const isNewCreds = !this.intel.credentials || this.intel.credentials.email !== emailStep.value
        this.intel.credentials = {
          email: emailStep.value,
          password: passwordStep.value,
          registered_at: this.intel.credentials?.registered_at ?? new Date().toISOString(),
          last_login_success: new Date().toISOString(),
        }
        if (isNewCreds) {
          logger.success(`  Credentials saved — will reuse on future runs (${emailStep.value})`)
        } else {
          logger.dim(`  Credentials reused successfully (${emailStep.value})`)
        }
      }
    } else if (credSource) {
      // Auth not verified — still save creds from successful register/login for next attempt
      const fillSteps = credSource.scenario.steps.filter(s => s.action === 'fill')
      const emailStep = fillSteps.find(s => {
        const desc = s.description.toLowerCase()
        return desc.includes('email') || s.selector?.includes('email')
      })
      const passwordStep = fillSteps.find(s => {
        const desc = s.description.toLowerCase()
        return desc.includes('password') || s.selector?.includes('password')
      })

      if (emailStep?.value && passwordStep?.value && !this.intel.credentials) {
        this.intel.credentials = {
          email: emailStep.value,
          password: passwordStep.value,
          registered_at: new Date().toISOString(),
        }
        logger.dim(`  Credentials saved (pending auth verification) — ${emailStep.value}`)
      }
    }
  }

  private learnSelectors(result: TestResult): void {
    for (const log of result.step_logs) {
      if (log.selector_used && log.status === 'ok' && log.step.selector) {
        this.intel.global_selectors[log.step.selector] = log.selector_used
        const ri = this.intel.routes[result.scenario.route]
        if (ri) ri.working_selectors[log.step.selector] = log.selector_used
      }
      if (log.status === 'failed' && log.step.selector) {
        const ri = this.intel.routes[result.scenario.route]
        if (ri && !ri.failed_selectors.includes(log.step.selector)) {
          ri.failed_selectors.push(log.step.selector)
        }
      }
    }
  }

  private updateSkipRoutes(): void {
    this.intel.known_skip_routes = []
    for (const [routePath, ri] of Object.entries(this.intel.routes)) {
      if (ri.needs_url_params) this.intel.known_skip_routes.push(routePath)
      if (ri.load_samples >= 3 && ri.last_status === 'error') {
        this.intel.known_skip_routes.push(routePath)
      }
    }
    this.intel.known_skip_routes = [...new Set(this.intel.known_skip_routes)]
  }

  private logLearnings(results: TestResult[]): void {
    const lastRun = this.intel.run_history[this.intel.run_history.length - 1]
    if (!lastRun) return

    logger.section('Learning from this run')
    logger.info(`Run #${this.intel.run_history.length}: ${lastRun.passed}/${lastRun.total} passed (${(lastRun.pass_rate * 100).toFixed(0)}%)`)

    if (lastRun.improvements.length > 0) {
      for (const imp of lastRun.improvements) logger.success(`  ↑ ${imp}`)
    }
    if (lastRun.regressions.length > 0) {
      for (const reg of lastRun.regressions) logger.warn(`  ↓ ${reg}`)
    }

    const routesLearned = Object.values(this.intel.routes).length
    const selectorsLearned = Object.keys(this.intel.global_selectors).length
    const authStatus = this.intel.auth?.session_established ? 'working' : 'not established'
    const credsStatus = this.intel.credentials ? `saved (${this.intel.credentials.email})` : 'none'
    logger.dim(`  Routes tracked: ${routesLearned}, Selectors learned: ${selectorsLearned}, Auth: ${authStatus}, Credentials: ${credsStatus}`)

    if (this.intel.known_skip_routes.length > 0) {
      logger.dim(`  Will skip on next run: ${this.intel.known_skip_routes.join(', ')}`)
    }
  }

  // ── Existing handlers ───────────────────────────────────────────────

  private handlePass(result: TestResult): void {
    const flow = result.scenario.route
    const existing = this.memory.verified_flows.find(v => v.flow === flow)
    if (existing) {
      existing.consecutive_passes++
      existing.last_verified = new Date().toISOString()
    } else {
      this.memory.verified_flows.push({ flow, consecutive_passes: 1, last_verified: new Date().toISOString() })
    }
    this.updateFlaky(flow, true)

    const openBug = this.memory.known_bugs.find(b => b.scenario_name === result.scenario.name && b.status === 'open')
    if (openBug) {
      openBug.status = 'closed'
      openBug.closed_at = new Date().toISOString()
    }
  }

  private handleFail(result: TestResult): void {
    const flow = result.scenario.route
    const verified = this.memory.verified_flows.find(v => v.flow === flow)
    if (verified) verified.consecutive_passes = 0
    this.updateFlaky(flow, false)

    const existingOpen = this.memory.known_bugs.find(b => b.scenario_name === result.scenario.name && b.status === 'open')
    if (!existingOpen) {
      this.memory.known_bugs.push({
        id: `VT-${String(this.bugCounter++).padStart(3, '0')}`,
        scenario_name: result.scenario.name,
        route: flow,
        status: 'open',
        found_at: new Date().toISOString(),
        screenshot_path: result.screenshot_path,
        steps_to_reproduce: result.scenario.steps.map(s => s.description),
      })
    }
  }

  private updateFlaky(flow: string, passed: boolean): void {
    const existing = this.memory.flaky_flows.find(f => f.flow === flow)
    if (existing) {
      existing.run_count++
      if (!passed) existing.fail_count++
      existing.fail_rate = existing.fail_count / existing.run_count
      existing.last_seen = new Date().toISOString()
    } else {
      this.memory.flaky_flows.push({
        flow, fail_count: passed ? 0 : 1, run_count: 1,
        fail_rate: passed ? 0 : 1, last_seen: new Date().toISOString(),
      })
    }
  }

  private defaultMemory(project: string): Memory {
    return { project, last_run: '', run_count: 0, known_bugs: [], flaky_flows: [], verified_flows: [] }
  }

  private defaultIntel(): ProjectIntel {
    return {
      version: 1, routes: {}, auth: null, credentials: null, avg_scenario_ms: 0,
      run_history: [], known_skip_routes: [], global_selectors: {},
    }
  }
}
