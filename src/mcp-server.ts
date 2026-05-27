import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { chromium, BrowserContext, Page } from 'playwright'
import { VibeTester, buildProductModel, MemoryManager } from './engine/index.js'
import { explorePage, exploreAllPages } from './engine/browser/explorer.js'
import type { PageExploration } from './engine/browser/explorer.js'
import { generateHtmlReport } from './engine/reporter/html.js'
import { readVibeGuidance } from './utils/vibe-md.js'
import { ActionBlocklist } from './utils/blocklist.js'
import { VibeConfigSchema, type VibeConfig, type VibeGuidance } from './types/config.js'
import type { ProductModel, TestScenario, TestResult } from './types/index.js'
import { ensureDir, fileExists } from './utils/file.js'
import { exec } from 'child_process'
import fs from 'fs/promises'
import path from 'path'

function openInBrowser(filePath: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  exec(`${cmd} "${filePath}"`, () => {})
}

// ─── Shared session state ─────────────────────────────────────────────────────
// The MCP server maintains state between tool calls so the editor LLM
// can call scan_codebase → login → explore_page → execute_scenario → generate_report
// as a multi-turn workflow.

interface Session {
  config: VibeConfig | null
  productModel: ProductModel | null
  memory: MemoryManager | null
  guidance: VibeGuidance | null
  blocklist: ActionBlocklist
  browser: Awaited<ReturnType<typeof chromium.launch>> | null
  authContext: BrowserContext | null
  unauthContext: BrowserContext | null
  results: TestResult[]
  explorations: PageExploration[]
  projectRoot: string
  screenshotsDir: string
}

const session: Session = {
  config: null,
  productModel: null,
  memory: null,
  guidance: null,
  blocklist: new ActionBlocklist(),
  browser: null,
  authContext: null,
  unauthContext: null,
  results: [],
  explorations: [],
  projectRoot: process.cwd(),
  screenshotsDir: '',
}

async function screenshotToBase64(filepath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(filepath)
    return `data:image/png;base64,${buf.toString('base64')}`
  } catch { return null }
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'vibe-test', version: '0.3.9' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_codebase',
      description: `Analyze a project's codebase to understand its structure, routes, forms, components, existing tests, and coverage gaps. Returns a ProductModel with routes, behaviours, coverage map, gaps, and generated test scenarios. Call this first before any testing.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          codebase_path: {
            type: 'string',
            description: 'Absolute path to the project root directory.',
          },
          url: {
            type: 'string',
            description: 'The base URL of the running application (e.g. http://localhost:3000 or https://staging.myapp.com). If the app is running on a staging/dev URL, provide that instead of localhost.',
          },
          mode: {
            type: 'string',
            enum: ['fast', 'deep'],
            description: 'fast = quick heuristic scan. deep = full extraction with dialogs/features (default).',
            default: 'deep',
          },
        },
        required: ['codebase_path', 'url'],
      },
    },
    {
      name: 'login',
      description: `Establish an authenticated browser session by executing a login scenario. Returns the post-login URL, token state, and a screenshot. Uses saved credentials from previous runs if available, or accepts provided credentials.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          email: { type: 'string', description: 'Email/username to log in with. If omitted, uses saved credentials.' },
          password: { type: 'string', description: 'Password. If omitted, uses saved credentials.' },
          login_url: { type: 'string', description: 'Login page URL path (e.g. /login). Defaults to /login.' },
        },
        required: [],
      },
    },
    {
      name: 'scan_page_elements',
      description: `Navigate to a specific page and discover all interactive elements (buttons, links, inputs, selectors, checkboxes, tabs). Returns a structured list of elements with their types, text, selectors, and disabled state. Also returns a screenshot of the page. Use this to understand what's on a page before deciding what to test.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          route: {
            type: 'string',
            description: 'The route path to scan (e.g. /dashboard, /settings). Will be appended to the base URL.',
          },
          authenticated: {
            type: 'boolean',
            description: 'Whether to use the authenticated browser context. Default false.',
            default: false,
          },
        },
        required: ['route'],
      },
    },
    {
      name: 'explore_page',
      description: `Perform a full interactive exploration of a page: discover all elements, click buttons, fill inputs, test tabs, observe API calls, and report what happened. Returns detailed interaction outcomes, API observations, and screenshots. This is the "senior tester" mode — it tries every element and reports what works and what breaks.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          route: {
            type: 'string',
            description: 'The route path to explore (e.g. /dashboard).',
          },
          authenticated: {
            type: 'boolean',
            description: 'Whether to use the authenticated context. Default false.',
            default: false,
          },
        },
        required: ['route'],
      },
    },
    {
      name: 'execute_scenario',
      description: `Execute a single test scenario (a sequence of navigate/fill/click/assert steps) and return detailed results with step-by-step logs, screenshots after each state-changing step, API errors observed, and the final page state. The editor LLM can construct scenarios based on scan_codebase output or create custom ones.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          scenario: {
            type: 'object',
            description: 'A test scenario object with id, name, route, steps[], and expected_outcome.',
            properties: {
              id: { type: 'string', description: 'Unique scenario identifier (e.g. "login-test-01").' },
              name: { type: 'string', description: 'Human-readable scenario name (e.g. "Login with valid credentials").' },
              route: { type: 'string', description: 'The primary route this scenario tests (e.g. "/login").' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Scenario priority level.' },
              steps: {
                type: 'array',
                description: 'Ordered list of test steps to execute sequentially.',
                items: {
                  type: 'object',
                  properties: {
                    action: { type: 'string', enum: ['navigate', 'fill', 'click', 'wait', 'assert', 'select', 'upload'], description: 'Step action: navigate (go to URL), fill (type into input), click (click element), wait (pause ms), assert (verify page state), select (dropdown), upload (file input).' },
                    selector: { type: 'string', description: 'CSS selector, text=, placeholder=, or label= locator for the target element.' },
                    value: { type: 'string', description: 'Value to fill/select, milliseconds for wait, or file path for upload.' },
                    url: { type: 'string', description: 'URL or route path for navigate action.' },
                    timeout: { type: 'number', description: 'Step timeout in milliseconds. Default 15000.' },
                    description: { type: 'string', description: 'Human-readable description of what this step does.' },
                  },
                  required: ['action', 'description'],
                },
              },
              expected_outcome: { type: 'string', description: 'What should happen after all steps complete (e.g. "Redirect to dashboard").' },
              requires_auth: { type: 'boolean', description: 'Whether this scenario needs an authenticated browser session.' },
            },
            required: ['id', 'name', 'route', 'steps', 'expected_outcome'],
          },
          authenticated: {
            type: 'boolean',
            description: 'Whether to use authenticated context. Default: inferred from scenario.requires_auth.',
          },
        },
        required: ['scenario'],
      },
    },
    {
      name: 'get_coverage',
      description: `Return the current test coverage map, identified gaps, and suggested tests. Prerequisite: scan_codebase must have been called first. Returns JSON with: coverage entries per route (tested/untested, test frameworks used), gap analysis with priority scores (high/medium/low), and concrete test suggestions for missing coverage. Use this to understand what has been tested and what still needs testing.`,
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    {
      name: 'generate_report',
      description: `Generate a self-contained HTML test report with embedded screenshots from all collected results, explorations, and coverage data. Returns the report file path and a text summary. The report includes: pass/fail results per scenario, step-by-step screenshots, element exploration findings, API error monitoring, and coverage gap suggestions. Call this after executing scenarios and explorations. The report auto-opens in the browser.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Optional custom title for the report.' },
        },
        required: [],
      },
    },
    {
      name: 'take_screenshot',
      description: `Navigate to a URL and take a screenshot. Returns the screenshot as a base64 data URI that the editor LLM can see and reason about. Use this for quick visual verification.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Full URL or route path to screenshot.' },
          authenticated: { type: 'boolean', description: 'Use authenticated context. Default false.', default: false },
          full_page: { type: 'boolean', description: 'Capture full page or just viewport. Default false.', default: false },
        },
        required: ['url'],
      },
    },
    {
      name: 'suggest_tests',
      description: `Analyze codebase features, existing test coverage, and results from previous runs to suggest concrete test scenarios that should be written or executed. Returns prioritized, executable scenario objects with steps. Use this after scan_codebase to understand what testing is missing and get ready-to-run scenarios.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          route: { type: 'string', description: 'Optional: focus suggestions on a specific route (e.g. /dashboard). If omitted, analyzes all routes.' },
        },
        required: [],
      },
    },
    {
      name: 'run_full_test',
      description: `Run a complete end-to-end test suite: scan codebase → generate scenarios → execute all → explore pages → generate report. This is the all-in-one command. For more granular control, use the individual tools (scan_codebase, login, explore_page, execute_scenario, generate_report).`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Base URL of the running application (e.g. http://localhost:3000 or https://staging.myapp.com).' },
          codebase_path: { type: 'string', description: 'Absolute path to the project root directory. Defaults to the current working directory.' },
          mode: { type: 'string', enum: ['fast', 'deep'], default: 'deep', description: 'fast = quick heuristic scan. deep = full feature extraction with dialogs and CRUD detection.' },
          headed: { type: 'boolean', default: true, description: 'Show the browser window during testing. Set false for headless CI runs.' },
        },
        required: ['url'],
      },
    },
    {
      name: 'run_converge',
      description: `Iterative coverage: runs the full baseline suite, then automatically runs follow-up rounds targeting coverage gaps and failed scenarios until pass rate and gap thresholds are met (or max rounds reached). Use for "keep testing until coverage is good". Returns results across all rounds and opens the final HTML report.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Base URL of the running application (e.g. http://localhost:3000).' },
          codebase_path: { type: 'string', description: 'Absolute path to the project root directory. Defaults to the current working directory.' },
          mode: { type: 'string', enum: ['fast', 'deep'], default: 'deep', description: 'fast = quick heuristic scan. deep = full feature extraction with dialogs and CRUD detection.' },
          headed: { type: 'boolean', default: true, description: 'Show the browser window during testing. Set false for headless CI runs.' },
          max_followup_rounds: { type: 'number', description: 'Max extra rounds after baseline (default 4).', default: 4 },
          target_pass_rate: { type: 'number', description: 'Stop when last batch pass rate reaches this 0–1 (default 0.92).', default: 0.92 },
          max_high_severity_gaps: { type: 'number', description: 'Stop when critical+important gaps <= this (default 2).', default: 2 },
        },
        required: ['url'],
      },
    },
    {
      name: 'get_context',
      description: `Retrieve the most relevant source files for a given feature or route. Returns actual source code (budget-capped) so you understand real field names, API endpoints, and component structure before writing test steps. Call this after scan_codebase when you want to write precise test scenarios for a specific feature — it eliminates guesswork about selectors and form fields.`,
      inputSchema: {
        type: 'object' as const,
        properties: {
          feature: {
            type: 'string',
            description: 'Feature name or route path to retrieve context for (e.g. "login", "checkout", "/dashboard").',
          },
          max_files: {
            type: 'number',
            description: 'Max source files to return (default 5, max 8).',
            default: 5,
          },
        },
        required: ['feature'],
      },
    },
    {
      name: 'cleanup',
      description: `Close all open browsers and reset the session state. Call when done testing.`,
      inputSchema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
  ],
}))

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params
  const args = (request.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (name) {
      case 'scan_codebase': return await handleScanCodebase(args)
      case 'login': return await handleLogin(args)
      case 'scan_page_elements': return await handleScanPageElements(args)
      case 'explore_page': return await handleExplorePage(args)
      case 'execute_scenario': return await handleExecuteScenario(args)
      case 'get_coverage': return await handleGetCoverage()
      case 'suggest_tests': return await handleSuggestTests(args)
      case 'generate_report': return await handleGenerateReport(args)
      case 'take_screenshot': return await handleTakeScreenshot(args)
      case 'run_full_test': return await handleRunFullTest(args)
      case 'run_converge': return await handleRunConverge(args)
      case 'get_context': return await handleGetContext(args)
      case 'cleanup': return await handleCleanup()
      default: throw new Error(`Unknown tool: ${name}`)
    }
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `Error in ${name}: ${err instanceof Error ? err.message : String(err)}`,
      }],
      isError: true,
    }
  }
})

// ─── scan_codebase ────────────────────────────────────────────────────────────

async function handleScanCodebase(args: Record<string, unknown>) {
  const codebasePath = (args.codebase_path as string) ?? process.cwd()
  const url = args.url as string
  const mode = (args.mode as 'fast' | 'deep') ?? 'deep'

  session.projectRoot = codebasePath
  session.screenshotsDir = path.join(codebasePath, '.vibe', 'screenshots')
  await ensureDir(session.screenshotsDir)

  session.guidance = await readVibeGuidance(codebasePath)
  session.blocklist = new ActionBlocklist([], session.guidance)

  session.config = VibeConfigSchema.parse({ url, codebase_path: codebasePath, mode })

  session.memory = new MemoryManager(codebasePath)
  await session.memory.load()
  const recs = session.memory.getRecommendations()

  session.productModel = await buildProductModel(
    session.config,
    session.memory.getMemory(),
    recs
  )

  const model = session.productModel

  const summary = {
    project_name: model.project_name,
    framework: model.framework,
    url: model.url,
    routes_found: model.routes.length,
    routes: model.routes.map(r => ({
      path: r.path,
      type: r.type,
      requires_auth: r.requires_auth,
      dynamic: r.dynamic_segments.length > 0,
    })),
    features_found: model.behaviours.reduce((s, b) => s + (b.functionality?.features.length ?? 0), 0),
    dialogs_found: model.behaviours.reduce((s, b) => s + (b.functionality?.dialogs.length ?? 0), 0),
    coverage: {
      tested_routes: Object.values(model.coverage).filter(c => c.tested).length,
      total_routes: model.routes.length,
      gaps: model.gaps.length,
      high_priority_gaps: model.gaps.filter(g => g.priority === 'high').length,
    },
    scenarios_generated: model.scenarios.length,
    scenarios: model.scenarios.map(s => ({
      id: s.id,
      name: s.name,
      route: s.route,
      priority: s.priority,
      requires_auth: s.requires_auth ?? false,
      steps_count: s.steps.length,
    })),
    guidance: session.guidance ? {
      has_vibe_md: true,
      login_url: session.guidance.login_url,
      blocklist_rules: session.guidance.never_automate?.length ?? 0,
      notes: session.guidance.notes,
    } : { has_vibe_md: false },
    saved_credentials: recs.saved_credentials ? {
      email: recs.saved_credentials.email,
      registered_at: recs.saved_credentials.registered_at,
    } : null,
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
  }
}

// ─── login ────────────────────────────────────────────────────────────────────

async function handleLogin(args: Record<string, unknown>) {
  if (!session.config) throw new Error('Call scan_codebase first to initialize the session.')

  const baseUrl = session.config.url
  const loginPath = (args.login_url as string) ?? '/login'
  const loginUrl = new URL(loginPath, baseUrl).href

  const recs = session.memory?.getRecommendations()
  const email = (args.email as string) ?? recs?.saved_credentials?.email
  const password = (args.password as string) ?? recs?.saved_credentials?.password
  if (!email || !password) throw new Error('No credentials provided and no saved credentials found. Provide email and password.')

  await ensureBrowser()

  // Close stale auth context if it exists from a previous login
  if (session.authContext) {
    await session.authContext.close().catch(() => {})
    session.authContext = null
  }

  // Create the auth context directly — login inside it, keep it alive
  const ctx = await session.browser!.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 800 },
  })
  ctx.setDefaultTimeout(15000)

  const page = await ctx.newPage()
  const apiCalls: Array<{ url: string; status: number; method: string }> = []

  page.on('response', resp => {
    const u = resp.url()
    if (u.match(/\.(js|css|png|jpg|svg|woff|woff2|ico|map|ttf|eot)(\?|$)/)) return
    if (u.includes('fonts.googleapis.com') || u.includes('fonts.gstatic.com')) return
    apiCalls.push({ url: u, status: resp.status(), method: resp.request().method() })
  })

  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

  const emailLoc = page.locator('[type="email"], [name="email"], #email, [placeholder*="email" i]').first()
  const passLoc = page.locator('[type="password"], [name="password"], #password').first()

  await emailLoc.fill(email, { timeout: 3000 })
  await passLoc.fill(password, { timeout: 3000 })

  const submitLoc = page.locator('button[type="submit"], input[type="submit"]').first()
  await submitLoc.click({ timeout: 3000 })

  await page.waitForURL(url => !url.href.includes('login') && !url.href.includes('signin'), { timeout: 10000 }).catch(() => {})

  const tokenData = await page.evaluate(`(() => {
    var storage = {};
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key) storage[key] = localStorage.getItem(key) || '';
    }
    return { localStorage: storage, cookies: document.cookie };
  })()`) as { localStorage: Record<string, string>; cookies: string }

  const screenshotPath = path.join(session.screenshotsDir, 'login-result.png')
  await page.screenshot({ path: screenshotPath, fullPage: false })
  const screenshotBase64 = await screenshotToBase64(screenshotPath)

  const finalUrl = page.url()
  const tokenCount = Object.keys(tokenData.localStorage).length
  const onLogin = finalUrl.includes('login') || finalUrl.includes('signin')
  const loginSuccess = !onLogin || tokenCount > 0

  // Close the login page — the context stays alive with cookies/storage intact
  await page.close()

  if (loginSuccess) {
    // Keep this context as our auth context — no need to create a new one
    session.authContext = ctx
  } else {
    await ctx.close()
  }

  const result = {
    success: loginSuccess,
    final_url: finalUrl,
    final_path: (() => { try { return new URL(finalUrl).pathname } catch { return finalUrl } })(),
    tokens_found: tokenCount,
    token_keys: Object.keys(tokenData.localStorage),
    has_cookies: tokenData.cookies.length > 0,
    api_calls: apiCalls.slice(0, 20),
  }

  const content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }> = [
    { type: 'text', text: JSON.stringify(result, null, 2) },
  ]
  if (screenshotBase64) {
    content.push({
      type: 'image',
      data: screenshotBase64.replace('data:image/png;base64,', ''),
      mimeType: 'image/png',
    })
  }

  return { content }
}

// ─── scan_page_elements ───────────────────────────────────────────────────────

async function handleScanPageElements(args: Record<string, unknown>) {
  if (!session.config) throw new Error('Call scan_codebase first.')

  const route = args.route as string
  const useAuth = (args.authenticated as boolean) ?? false

  await ensureBrowser()
  const ctx = useAuth ? session.authContext : await getOrCreateUnauthContext()
  if (!ctx) throw new Error(useAuth ? 'No authenticated context. Call login first.' : 'Failed to create browser context.')

  const page = await ctx.newPage()
  const fullUrl = new URL(route, session.config.url).href

  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

  // Discover elements
  const elements = await page.evaluate(`(() => {
    var results = [];
    var seen = {};
    function getVisibleText(el) {
      var clone = el.cloneNode(true);
      var removable = clone.querySelectorAll('svg, img, .sr-only');
      for (var i = 0; i < removable.length; i++) removable[i].remove();
      return (clone.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
    }
    function buildSelector(el) {
      var testId = el.getAttribute('data-testid');
      if (testId) return '[data-testid="' + testId + '"]';
      var ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return '[aria-label="' + ariaLabel + '"]';
      var id = el.id;
      if (id && id[0] !== ':') return '#' + id;
      var name = el.name;
      if (name) return '[name="' + name + '"]';
      var placeholder = el.placeholder;
      if (placeholder) return '[placeholder="' + placeholder + '"]';
      var text = getVisibleText(el);
      if (text && text.length < 50 && text.length > 0) return 'text=' + text;
      return '';
    }
    function addElement(el, type) {
      var rect = el.getBoundingClientRect();
      if (rect.height === 0 || rect.width === 0) return;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      var text = getVisibleText(el);
      var selector = buildSelector(el);
      var key = type + ':' + (selector || text);
      if (seen[key] || (!text && !selector)) return;
      seen[key] = true;
      results.push({
        tag: el.tagName.toLowerCase(), type: type, text: text.slice(0, 80),
        selector: selector, disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        role: el.getAttribute('role') || undefined, href: el.href || undefined,
        inputType: el.type || undefined, placeholder: el.placeholder || undefined
      });
    }
    document.querySelectorAll('button, [role="button"], input[type="submit"]').forEach(function(el) { addElement(el, 'button'); });
    document.querySelectorAll('a[href]:not([href="#"])').forEach(function(el) { addElement(el, 'link'); });
    document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), textarea').forEach(function(el) { addElement(el, 'input'); });
    document.querySelectorAll('select, [role="combobox"], [role="listbox"]').forEach(function(el) { addElement(el, 'select'); });
    document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [role="switch"]').forEach(function(el) { addElement(el, 'checkbox'); });
    document.querySelectorAll('[role="tab"]').forEach(function(el) { addElement(el, 'tab'); });
    return results;
  })()`) as Array<Record<string, unknown>>

  const screenshotPath = path.join(session.screenshotsDir, `scan-${route.replace(/\//g, '_').replace(/^_/, '')}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const screenshotBase64 = await screenshotToBase64(screenshotPath)

  const pageTitle = await page.title()
  const currentUrl = page.url()
  await page.close()

  const elementsByType: Record<string, number> = {}
  for (const el of elements) {
    const t = el.type as string
    elementsByType[t] = (elementsByType[t] ?? 0) + 1
  }

  const result = {
    route,
    current_url: currentUrl,
    page_title: pageTitle,
    total_elements: elements.length,
    elements_by_type: elementsByType,
    elements,
    screenshot: screenshotBase64 ? '(attached as image below)' : null,
  }

  const content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }> = [
    { type: 'text', text: JSON.stringify({ ...result, screenshot: undefined }, null, 2) },
  ]
  if (screenshotBase64) {
    content.push({
      type: 'image',
      data: screenshotBase64.replace('data:image/png;base64,', ''),
      mimeType: 'image/png',
    })
  }

  return { content }
}

// ─── explore_page ─────────────────────────────────────────────────────────────

async function handleExplorePage(args: Record<string, unknown>) {
  if (!session.config) throw new Error('Call scan_codebase first.')

  const route = args.route as string
  const useAuth = (args.authenticated as boolean) ?? false

  await ensureBrowser()
  const ctx = useAuth ? session.authContext : await getOrCreateUnauthContext()
  if (!ctx) throw new Error(useAuth ? 'No authenticated context. Call login first.' : 'Failed to create browser context.')

  const exploration = await explorePage(ctx, route, session.config.url, session.screenshotsDir, session.blocklist)
  session.explorations.push(exploration)

  const screenshotBase64 = exploration.screenshot_path ? await screenshotToBase64(exploration.screenshot_path) : null

  const result = {
    route: exploration.route,
    url: exploration.url,
    elements_discovered: exploration.elements_discovered,
    elements_by_type: exploration.elements_by_type,
    duration_ms: exploration.duration_ms,
    interactions: exploration.interactions.map(i => ({
      element: i.element,
      type: i.elementType,
      action: i.action,
      result: i.result,
      details: i.details,
      duration_ms: i.duration_ms,
    })),
    api_calls: exploration.api_calls.map(a => ({
      method: a.method,
      path: a.path,
      status: a.status,
      response_time_ms: a.responseTime_ms,
      is_error: a.isError,
    })),
    errors: exploration.errors,
    summary: {
      tested: exploration.interactions.filter(i => i.result !== 'skipped').length,
      working: exploration.interactions.filter(i => ['success', 'content_updated', 'dialog_opened', 'navigated', 'toast_shown'].includes(i.result)).length,
      broken: exploration.interactions.filter(i => i.result === 'error').length,
      skipped: exploration.interactions.filter(i => i.result === 'skipped').length,
      api_calls_total: exploration.api_calls.length,
      api_errors: exploration.api_calls.filter(a => a.isError).length,
    },
    screenshot: screenshotBase64 ? '(attached as image below)' : null,
  }

  const content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }> = [
    { type: 'text', text: JSON.stringify({ ...result, screenshot: undefined }, null, 2) },
  ]
  if (screenshotBase64) {
    content.push({
      type: 'image',
      data: screenshotBase64.replace('data:image/png;base64,', ''),
      mimeType: 'image/png',
    })
  }

  return { content }
}

// ─── execute_scenario ─────────────────────────────────────────────────────────

async function handleExecuteScenario(args: Record<string, unknown>) {
  if (!session.config) throw new Error('Call scan_codebase first.')

  const scenarioInput = args.scenario as Record<string, unknown>
  const scenario: TestScenario = {
    id: (scenarioInput.id as string) ?? `custom-${Date.now()}`,
    name: (scenarioInput.name as string) ?? 'Custom scenario',
    route: (scenarioInput.route as string) ?? '/',
    priority: (scenarioInput.priority as 'high' | 'medium' | 'low') ?? 'medium',
    steps: (scenarioInput.steps as TestScenario['steps']) ?? [],
    expected_outcome: (scenarioInput.expected_outcome as string) ?? '',
    is_gap: false,
    generated_by: 'heuristic',
    requires_auth: (scenarioInput.requires_auth as boolean) ?? false,
  }

  const useAuth = (args.authenticated as boolean) ?? scenario.requires_auth
  await ensureBrowser()
  const ctx = useAuth ? session.authContext : await getOrCreateUnauthContext()
  if (!ctx) throw new Error(useAuth ? 'No authenticated context. Call login first.' : 'Failed to create browser context.')

  const result = await runScenarioInContext(scenario, ctx, session.config, session.screenshotsDir)
  session.results.push(result)

  // Collect screenshots from step logs
  const stepScreenshots: Array<{ step_index: number; base64: string }> = []
  for (let i = 0; i < result.step_logs.length; i++) {
    const log = result.step_logs[i]
    if (log.screenshot_path) {
      const b64 = await screenshotToBase64(log.screenshot_path)
      if (b64) stepScreenshots.push({ step_index: i, base64: b64 })
    }
  }

  const finalScreenshot = result.screenshot_path ? await screenshotToBase64(result.screenshot_path) : null

  const output = {
    scenario_name: scenario.name,
    status: result.status,
    duration_ms: result.duration_ms,
    current_url: result.current_url,
    verdict: result.ai_verdict,
    failure_reason: result.failure_reason,
    step_logs: result.step_logs.map((log, i) => ({
      step: `${log.step.action}: ${log.step.description}`,
      status: log.status,
      selector_used: log.selector_used,
      url_before: (() => { try { return new URL(log.url_before).pathname } catch { return log.url_before } })(),
      url_after: (() => { try { return new URL(log.url_after).pathname } catch { return log.url_after } })(),
      duration_ms: log.duration_ms,
      error: log.error,
      has_screenshot: !!log.screenshot_path,
    })),
    api_errors: result.api_errors ?? [],
    screenshots_count: stepScreenshots.length + (finalScreenshot ? 1 : 0),
  }

  const content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }> = [
    { type: 'text', text: JSON.stringify(output, null, 2) },
  ]

  // Attach key screenshots — limit to final + first failure to keep payload reasonable
  const failScreenshot = stepScreenshots.find((_, i) => result.step_logs[i]?.status === 'failed')
  if (failScreenshot) {
    content.push({
      type: 'image',
      data: failScreenshot.base64.replace('data:image/png;base64,', ''),
      mimeType: 'image/png',
    })
  }
  if (finalScreenshot) {
    content.push({
      type: 'image',
      data: finalScreenshot.replace('data:image/png;base64,', ''),
      mimeType: 'image/png',
    })
  }

  return { content }
}

// ─── get_coverage ─────────────────────────────────────────────────────────────

async function handleGetCoverage() {
  if (!session.productModel) throw new Error('Call scan_codebase first.')

  const model = session.productModel

  // Summarize coverage — only include route-level entries that match actual app routes
  const appRoutes = new Set(model.routes.map(r => r.path))
  const coverage = Object.entries(model.coverage)
    .filter(([route]) => !route.startsWith('__file:') && appRoutes.has(route.replace(/\$\{.*\}/, '')))
    .map(([route, entry]) => ({
      route,
      tested: entry.tested,
      scenarios: entry.scenarios.length,
      user_flows: entry.intelligence?.user_flows.length ?? 0,
    }))

  // Only show untested or partially covered routes
  const untested = model.routes
    .filter(r => {
      const entry = model.coverage[r.path]
      return !entry || !entry.tested
    })
    .map(r => r.path)

  const gaps = model.gaps.map(g => ({
    route: g.route,
    reason: g.reason,
    priority: g.priority,
  }))

  // Compact scenario list — just what the editor needs to decide what to run
  const scenarios = model.scenarios.map(s => ({
    id: s.id,
    name: s.name,
    route: s.route,
    priority: s.priority,
    requires_auth: s.requires_auth ?? false,
    steps_count: s.steps.length,
  }))

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        summary: {
          total_routes: model.routes.length,
          tested_routes: coverage.filter(c => c.tested).length,
          untested_routes: untested,
          gaps: gaps.length,
        },
        coverage,
        gaps,
        available_scenarios: scenarios,
      }, null, 2),
    }],
  }
}

// ─── generate_report ──────────────────────────────────────────────────────────

async function handleGenerateReport(args: Record<string, unknown>) {
  if (!session.config || !session.productModel) throw new Error('Call scan_codebase first.')

  const recs = session.memory?.getRecommendations()

  const { generateCoverageGaps } = await import('./engine/coverage-gaps.js')
  const coverageGaps = generateCoverageGaps(session.productModel.behaviours, session.explorations)

  const report = await generateHtmlReport(
    session.results,
    session.productModel,
    session.config,
    session.explorations,
    coverageGaps,
    recs
  )

  const reportPath = path.join(session.projectRoot, '.vibe', 'report.html')
  await ensureDir(path.dirname(reportPath))
  await fs.writeFile(reportPath, report, 'utf-8')

  // Self-improvement: persist intelligence for next run
  await saveRunIntelligence()

  openInBrowser(reportPath)

  const passed = session.results.filter(r => r.status === 'pass').length
  const failed = session.results.filter(r => r.status === 'fail').length
  const errors = session.results.filter(r => r.status === 'error').length

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        report_path: reportPath,
        report_opened_in_browser: true,
        summary: {
          total_scenarios: session.results.length,
          passed,
          failed,
          errors,
          pages_explored: session.explorations.length,
          coverage_gaps_found: coverageGaps.length,
        },
      }, null, 2),
    }],
  }
}

// ─── suggest_tests ────────────────────────────────────────────────────────────

async function handleSuggestTests(args: Record<string, unknown>) {
  if (!session.productModel) throw new Error('Call scan_codebase first.')

  const focusRoute = args.route as string | undefined
  const model = session.productModel
  const recs = session.memory?.getRecommendations()

  const suggestions: Array<{
    priority: 'critical' | 'high' | 'medium' | 'low'
    category: string
    reason: string
    scenario: TestScenario
  }> = []

  const behaviours = focusRoute
    ? model.behaviours.filter(b => b.route.path === focusRoute)
    : model.behaviours

  for (const behaviour of behaviours) {
    const route = behaviour.route.path
    const func = behaviour.functionality
    const routeIntel = recs && !recs.first_run ? Object.entries((session.memory as any)?.intel?.routes ?? {}).find(([k]) => k === route)?.[1] as any : null

    // 1. Untested CRUD operations
    if (func) {
      for (const feature of func.features) {
        if (feature.type === 'crud_create') {
          const dialog = func.dialogs[0]
          const steps: TestScenario['steps'] = [
            { action: 'navigate', url: route, description: `Go to ${route}` },
          ]
          if (dialog) {
            steps.push({ action: 'click', selector: `text=${dialog.trigger}`, description: `Click "${dialog.trigger}" to open form` })
            for (const field of dialog.fields) {
              const val = field.type === 'email' ? 'test@example.com' : field.type === 'number' ? '42' : `Test ${field.name}`
              steps.push({ action: 'fill', selector: field.id ? `#${field.id}` : `[name="${field.name}"]`, value: val, description: `Fill ${field.label || field.name}` })
            }
            steps.push({ action: 'click', selector: `text=${dialog.submit_text || 'Submit'}`, description: `Submit the form` })
          }
          suggestions.push({
            priority: 'critical',
            category: 'Missing CRUD: Create',
            reason: `No test for creating ${feature.name} on ${route}`,
            scenario: { id: `suggest-create-${route}`, name: `Create ${feature.name} on ${route}`, route, priority: 'high', steps, expected_outcome: 'New item appears or success toast', is_gap: true, generated_by: 'heuristic', requires_auth: behaviour.route.requires_auth },
          })
        }

        if (feature.type === 'crud_delete') {
          suggestions.push({
            priority: 'high',
            category: 'Missing CRUD: Delete',
            reason: `No delete test on ${route} — could have data integrity issues`,
            scenario: { id: `suggest-delete-${route}`, name: `Delete item on ${route}`, route, priority: 'high', steps: [
              { action: 'navigate', url: route, description: `Go to ${route}` },
              { action: 'click', selector: 'text=Delete', description: 'Click delete on an item' },
              { action: 'click', selector: 'text=Confirm', description: 'Confirm deletion' },
            ], expected_outcome: 'Item removed from list', is_gap: true, generated_by: 'heuristic', requires_auth: true },
          })
        }

        if (feature.type === 'search') {
          suggestions.push({
            priority: 'medium',
            category: 'Missing: Search',
            reason: `Search feature on ${route} has no test coverage`,
            scenario: { id: `suggest-search-${route}`, name: `Search on ${route}`, route, priority: 'medium', steps: [
              { action: 'navigate', url: route, description: `Go to ${route}` },
              { action: 'fill', selector: '[type="search"], [placeholder*="search" i], input[name*="search" i]', value: 'test query', description: 'Type search query' },
              { action: 'wait', value: '1000', description: 'Wait for results' },
            ], expected_outcome: 'Results filtered or updated', is_gap: true, generated_by: 'heuristic', requires_auth: behaviour.route.requires_auth },
          })
        }

        if (feature.type === 'filter') {
          suggestions.push({
            priority: 'medium',
            category: 'Missing: Filter',
            reason: `Filter feature on ${route} is untested`,
            scenario: { id: `suggest-filter-${route}`, name: `Filter on ${route}`, route, priority: 'medium', steps: [
              { action: 'navigate', url: route, description: `Go to ${route}` },
              { action: 'click', selector: 'text=Filter', description: 'Open filter' },
              { action: 'wait', value: '500', description: 'Wait for filter options' },
            ], expected_outcome: 'Content filtered', is_gap: true, generated_by: 'heuristic', requires_auth: behaviour.route.requires_auth },
          })
        }
      }

      // 2. Form validation tests
      for (const formFields of behaviour.forms) {
        if (formFields.length > 0) {
          const requiredFields = formFields.filter(f => f.required)
          if (requiredFields.length > 0) {
            suggestions.push({
              priority: 'high',
              category: 'Missing: Form Validation',
              reason: `No test for submitting empty required fields on ${route}`,
              scenario: { id: `suggest-validation-${route}`, name: `Empty form validation on ${route}`, route, priority: 'high', steps: [
                { action: 'navigate', url: route, description: `Go to ${route}` },
                { action: 'click', selector: 'button[type="submit"]', description: 'Submit empty form' },
              ], expected_outcome: 'Validation errors shown for required fields', is_gap: true, generated_by: 'heuristic', requires_auth: behaviour.route.requires_auth },
            })
          }
        }
      }
    }

    // 3. Navigation flow tests from code analysis
    if (func?.navigation_flows) {
      for (const flow of func.navigation_flows.slice(0, 3)) {
        suggestions.push({
          priority: 'low',
          category: 'Navigation Flow',
          reason: `Navigation from ${route} to ${flow.destination} via "${flow.trigger}" untested`,
          scenario: { id: `suggest-nav-${route}-${flow.destination}`, name: `Navigate ${route} → ${flow.destination}`, route, priority: 'low', steps: [
            { action: 'navigate', url: route, description: `Go to ${route}` },
            { action: 'click', selector: `text=${flow.trigger}`, description: `Click "${flow.trigger}"` },
            { action: 'wait', value: '1000', description: 'Wait for navigation' },
          ], expected_outcome: `Page navigates to ${flow.destination}`, is_gap: true, generated_by: 'heuristic', requires_auth: behaviour.route.requires_auth },
        })
      }
    }

    // 4. Self-improvement: suggest retests for previously failing routes
    if (routeIntel && routeIntel.last_status === 'fail' && routeIntel.fail_reasons.length > 0) {
      suggestions.push({
        priority: 'high',
        category: 'Regression: Previously Failing',
        reason: `Route ${route} failed last run: ${routeIntel.fail_reasons[0]}`,
        scenario: { id: `suggest-retest-${route}`, name: `Retest ${route} (previously failed)`, route, priority: 'high', steps: [
          { action: 'navigate', url: route, description: `Navigate to ${route}` },
          { action: 'wait', value: '2000', description: 'Wait for page to load' },
        ], expected_outcome: `Page loads without previous error: ${routeIntel.fail_reasons[0].slice(0, 50)}`, is_gap: true, generated_by: 'heuristic', requires_auth: routeIntel.needs_auth },
      })
    }
  }

  // 5. From exploration results — broken elements need dedicated tests
  for (const exploration of session.explorations) {
    if (focusRoute && exploration.route !== focusRoute) continue
    const broken = exploration.interactions.filter(i => i.result === 'error')
    for (const b of broken.slice(0, 3)) {
      suggestions.push({
        priority: 'high',
        category: 'Broken Element',
        reason: `"${b.element}" on ${exploration.route} failed: ${b.details.slice(0, 80)}`,
        scenario: { id: `suggest-fix-${exploration.route}-${b.element.slice(0, 20)}`, name: `Fix "${b.element}" on ${exploration.route}`, route: exploration.route, priority: 'high', steps: [
          { action: 'navigate', url: exploration.route, description: `Go to ${exploration.route}` },
          { action: 'click', selector: `text=${b.element}`, description: `Click "${b.element}"` },
        ], expected_outcome: 'Element responds correctly', is_gap: true, generated_by: 'heuristic', requires_auth: true },
      })
    }

    // API errors found during exploration
    const apiErrors = exploration.api_calls.filter(a => a.isError)
    for (const err of apiErrors.slice(0, 3)) {
      suggestions.push({
        priority: err.status >= 500 ? 'critical' : 'high',
        category: 'API Error',
        reason: `${err.method} ${err.path} returned ${err.status} during exploration of ${exploration.route}`,
        scenario: { id: `suggest-api-${err.path}`, name: `Fix API ${err.method} ${err.path}`, route: exploration.route, priority: 'high', steps: [
          { action: 'navigate', url: exploration.route, description: `Go to ${exploration.route}` },
          { action: 'wait', value: '2000', description: 'Wait and observe API calls' },
        ], expected_outcome: `${err.method} ${err.path} returns 2xx`, is_gap: true, generated_by: 'heuristic', requires_auth: true },
      })
    }
  }

  // Sort: critical → high → medium → low
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 }
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])

  // Deduplicate
  const seen = new Set<string>()
  const deduped = suggestions.filter(s => {
    const key = `${s.category}:${s.scenario.route}:${s.scenario.name.slice(0, 40)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const output = {
    total_suggestions: deduped.length,
    by_priority: {
      critical: deduped.filter(s => s.priority === 'critical').length,
      high: deduped.filter(s => s.priority === 'high').length,
      medium: deduped.filter(s => s.priority === 'medium').length,
      low: deduped.filter(s => s.priority === 'low').length,
    },
    suggestions: deduped.map(s => ({
      priority: s.priority,
      category: s.category,
      reason: s.reason,
      scenario: {
        id: s.scenario.id,
        name: s.scenario.name,
        route: s.scenario.route,
        requires_auth: s.scenario.requires_auth,
        steps: s.scenario.steps.map(st => ({ action: st.action, selector: st.selector, value: st.value, url: st.url, description: st.description })),
        expected_outcome: s.scenario.expected_outcome,
      },
    })),
    self_improvement: recs && !recs.first_run ? {
      run_count: session.memory?.getMemory().run_count ?? 0,
      selectors_learned: Object.keys(recs.selector_hints).length,
      routes_with_history: Object.keys(recs.timeout_hints).length,
      skip_routes: [...recs.skip_routes],
      has_saved_credentials: !!recs.saved_credentials,
    } : { first_run: true },
  }

  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] }
}

// ─── Self-improvement: save exploration intelligence ──────────────────────────

async function saveRunIntelligence(): Promise<void> {
  if (!session.memory || session.results.length === 0) return

  try {
    await session.memory.updateFromResults(session.results)
  } catch { /* non-critical */ }
}

// ─── take_screenshot ──────────────────────────────────────────────────────────

async function handleTakeScreenshot(args: Record<string, unknown>) {
  if (!session.config) throw new Error('Call scan_codebase first.')

  const urlArg = args.url as string
  const useAuth = (args.authenticated as boolean) ?? false
  const fullPage = (args.full_page as boolean) ?? false

  const fullUrl = urlArg.startsWith('http') ? urlArg : new URL(urlArg, session.config.url).href

  await ensureBrowser()
  const ctx = useAuth ? session.authContext : await getOrCreateUnauthContext()
  if (!ctx) throw new Error(useAuth ? 'No authenticated context. Call login first.' : 'Failed to create browser context.')

  const page = await ctx.newPage()
  await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

  const screenshotPath = path.join(session.screenshotsDir, `screenshot-${Date.now()}.png`)
  await page.screenshot({ path: screenshotPath, fullPage })

  const base64 = await screenshotToBase64(screenshotPath)
  const pageTitle = await page.title()
  const currentUrl = page.url()
  await page.close()

  const content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }> = [
    { type: 'text', text: JSON.stringify({ url: currentUrl, title: pageTitle, screenshot_path: screenshotPath }, null, 2) },
  ]
  if (base64) {
    content.push({
      type: 'image',
      data: base64.replace('data:image/png;base64,', ''),
      mimeType: 'image/png',
    })
  }

  return { content }
}

// ─── run_full_test ────────────────────────────────────────────────────────────

async function handleRunFullTest(args: Record<string, unknown>) {
  const tester = new VibeTester({
    url: args.url as string,
    codebase_path: args.codebase_path as string | undefined,
    mode: (args.mode as 'fast' | 'deep') ?? 'deep',
    browser: { headed: (args.headed as boolean) ?? true },
  })

  const result = await tester.run()

  openInBrowser(result.report_path)

  const summary = `**Vibe Test Run Complete**
- Total: ${result.summary.total} scenarios
- Passed: ${result.summary.passed}
- Failed: ${result.summary.failed}
- Errors: ${result.summary.errors}
- Elements explored: ${result.summary.elements_explored}
- API calls observed: ${result.summary.api_calls_observed}
- Duration: ${(result.summary.duration_ms / 1000).toFixed(1)}s
- Report: ${result.report_path} (opened in browser)`

  return { content: [{ type: 'text', text: summary }] }
}

// ─── run_converge ─────────────────────────────────────────────────────────────

async function handleRunConverge(args: Record<string, unknown>) {
  const tester = new VibeTester({
    url: args.url as string,
    codebase_path: args.codebase_path as string | undefined,
    mode: (args.mode as 'fast' | 'deep') ?? 'deep',
    browser: { headed: (args.headed as boolean) ?? true },
  })

  const result = await tester.converge({
    max_followup_rounds: (args.max_followup_rounds as number) ?? 4,
    target_pass_rate: (args.target_pass_rate as number) ?? 0.92,
    max_high_severity_gaps: (args.max_high_severity_gaps as number) ?? 2,
  })

  openInBrowser(result.report_path)

  const rounds = result.summary.converge_rounds ?? 1
  const roundsLine = `**Vibe Converge Complete**
- Rounds (baseline + follow-ups): ${rounds}
- Total scenario executions: ${result.summary.total}
- Passed: ${result.summary.passed}
- Failed: ${result.summary.failed}
- Errors: ${result.summary.errors}
- Elements explored: ${result.summary.elements_explored}
- Remaining gaps (items): ${result.coverage_gaps.length}
- Duration: ${(result.summary.duration_ms / 1000).toFixed(1)}s
- Report: ${result.report_path} (opened in browser)`

  return { content: [{ type: 'text', text: roundsLine }] }
}

// ─── get_context ─────────────────────────────────────────────────────────────

async function handleGetContext(args: Record<string, unknown>) {
  if (!args.feature || typeof args.feature !== 'string') {
    throw new Error('feature parameter is required and must be a string')
  }
  const feature = args.feature.toLowerCase()
  const maxFiles = Math.min((args.max_files as number) ?? 5, 8)
  const root = session.projectRoot || process.cwd()

  // Score a file path by how relevant it is to the requested feature
  function score(filePath: string): number {
    const rel = filePath.replace(root, '').toLowerCase()
    const tokens = feature.replace(/[/-]/g, ' ').split(/\s+/).filter(Boolean)
    let s = 0
    for (const token of tokens) {
      if (rel.includes(token)) s += 3
    }
    // Prefer component/page/route files
    if (rel.includes('page') || rel.includes('route') || rel.includes('component')) s += 1
    if (rel.includes('form') || rel.includes('modal') || rel.includes('dialog')) s += 2
    if (rel.includes('auth') || rel.includes('login') || rel.includes('api')) s += 2
    // Avoid noise
    if (rel.includes('node_modules') || rel.includes('.vibe') || rel.includes('dist')) return -1
    if (rel.includes('.test.') || rel.includes('.spec.') || rel.includes('__test')) return -1
    return s
  }

  // Budget-aware file reader: keeps HEAD + TAIL, marks omitted middle
  async function readFileBudgeted(filePath: string, headLines = 120, tailLines = 60): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const lines = content.split('\n')
      if (lines.length <= headLines + tailLines) return content
      const omitted = lines.length - headLines - tailLines
      return [
        ...lines.slice(0, headLines),
        `\n// ... (${omitted} lines omitted) ...\n`,
        ...lines.slice(lines.length - tailLines),
      ].join('\n')
    } catch { return '' }
  }

  // Walk src directory for relevant source files
  const srcDir = path.join(root, 'src')
  const rootFiles: string[] = []

  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 6) return
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch { return }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue
      const full = path.join(dir, entry)
      const stat = await fs.stat(full).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) {
        await walk(full, depth + 1)
      } else if (/\.(tsx?|jsx?|vue|svelte)$/.test(entry)) {
        rootFiles.push(full)
      }
    }
  }

  // Walk src/ first, then root if no src
  const hasSrc = await fileExists(srcDir)
  await walk(hasSrc ? srcDir : root)

  // Also check common locations if using Next.js app/pages conventions
  for (const extra of ['app', 'pages', 'components', 'lib', 'utils', 'hooks']) {
    const extraDir = path.join(root, extra)
    if (await fileExists(extraDir)) await walk(extraDir)
  }

  // Score and deduplicate
  const uniqueFiles = [...new Set(rootFiles)]
  const scored = uniqueFiles
    .map(f => ({ file: f, score: score(f) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)

  if (scored.length === 0) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          feature,
          message: 'No relevant source files found. Make sure scan_codebase has been called, or check the feature name.',
          tip: 'Try a broader term (e.g. "auth" instead of "two-factor-authentication")',
        }, null, 2),
      }],
    }
  }

  const files = await Promise.all(
    scored.map(async ({ file, score: s }) => ({
      path: file.replace(root, '').replace(/^\//, ''),
      relevance_score: s,
      content: await readFileBudgeted(file),
    }))
  )

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        feature,
        files_found: files.length,
        note: 'Use field names, selectors, and API paths from these files to write precise test steps.',
        files,
      }, null, 2),
    }],
  }
}

// ─── cleanup ──────────────────────────────────────────────────────────────────

async function handleCleanup() {
  // Save intelligence before closing
  await saveRunIntelligence()

  if (session.authContext) await session.authContext.close().catch(() => {})
  if (session.unauthContext) await session.unauthContext.close().catch(() => {})
  if (session.browser) await session.browser.close().catch(() => {})

  session.browser = null
  session.authContext = null
  session.unauthContext = null
  session.results = []
  session.explorations = []
  session.productModel = null
  session.config = null

  return { content: [{ type: 'text', text: 'Session cleaned up. All browsers closed.' }] }
}

// ─── Scenario Runner (reuses session browser) ────────────────────────────────

async function runScenarioInContext(
  scenario: TestScenario,
  context: BrowserContext,
  config: VibeConfig,
  screenshotsDir: string
): Promise<TestResult> {
  const startTime = Date.now()
  const screenshotPath = path.join(screenshotsDir, `${scenario.id}.png`)
  const page = await context.newPage()
  const stepLogs: Array<{ step: TestScenario['steps'][0]; status: 'ok' | 'failed' | 'skipped'; url_before: string; url_after: string; duration_ms: number; error?: string; selector_used?: string; screenshot_path?: string }> = []
  const apiErrors: Array<{ url: string; status: number; body: string }> = []

  try {
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]
      const urlBefore = page.url()
      const stepStart = Date.now()
      let selectorUsed: string | undefined
      let stepScreenshotPath: string | undefined

      try {
        selectorUsed = await executeStepOnPage(page, step, config.url, apiErrors)

        if (['fill', 'click', 'navigate', 'select'].includes(step.action)) {
          stepScreenshotPath = path.join(screenshotsDir, `${scenario.id}_step${i}.png`)
          try { await page.screenshot({ path: stepScreenshotPath, fullPage: false }) } catch { stepScreenshotPath = undefined }
        }

        stepLogs.push({ step, status: 'ok', url_before: urlBefore, url_after: page.url(), duration_ms: Date.now() - stepStart, selector_used: selectorUsed, screenshot_path: stepScreenshotPath })
      } catch (stepErr: unknown) {
        stepScreenshotPath = path.join(screenshotsDir, `${scenario.id}_step${i}_error.png`)
        try { await page.screenshot({ path: stepScreenshotPath, fullPage: false }) } catch { stepScreenshotPath = undefined }

        stepLogs.push({ step, status: 'failed', url_before: urlBefore, url_after: page.url(), duration_ms: Date.now() - stepStart, error: stepErr instanceof Error ? stepErr.message : String(stepErr), selector_used: selectorUsed, screenshot_path: stepScreenshotPath })
        throw stepErr
      }
    }

    if (scenario.steps.some(s => s.action === 'fill')) {
      await page.waitForTimeout(1500)
    }

    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})

    const currentPath = (() => { try { return new URL(page.url()).pathname } catch { return '' } })()
    const startedOnForm = scenario.steps.some(s => s.action === 'fill')
    const leftLoginPage = startedOnForm && !currentPath.includes('login') && !currentPath.includes('signin')
    const hasApiErrors = apiErrors.length > 0

    let verdict = 'Completed all steps'
    let passed = true
    if (hasApiErrors) {
      verdict = `API error: ${apiErrors[0].status} ${apiErrors[0].url.slice(0, 80)}`
      passed = false
    } else if (leftLoginPage) {
      verdict = `Navigated away from login to ${currentPath} — form action succeeded`
    }

    return {
      scenario, status: passed ? 'pass' : 'fail', duration_ms: Date.now() - startTime,
      screenshot_path: screenshotPath, current_url: page.url(), ai_verdict: verdict,
      step_logs: stepLogs as TestResult['step_logs'], api_errors: apiErrors.length > 0 ? apiErrors : undefined,
    }
  } catch (err: unknown) {
    try { await page.screenshot({ path: screenshotPath, fullPage: false }) } catch {}
    return {
      scenario, status: 'error', duration_ms: Date.now() - startTime,
      screenshot_path: screenshotPath, current_url: page.url(),
      failure_reason: err instanceof Error ? err.message : String(err),
      step_logs: stepLogs as TestResult['step_logs'], api_errors: apiErrors.length > 0 ? apiErrors : undefined,
    }
  } finally {
    await page.close()
  }
}

async function executeStepOnPage(page: Page, step: TestScenario['steps'][0], baseUrl: string, apiErrors: Array<{ url: string; status: number; body: string }>): Promise<string | undefined> {
  const timeout = step.timeout ?? 15000

  switch (step.action) {
    case 'navigate': {
      const url = step.url?.startsWith('http') ? step.url : new URL(step.url ?? '/', baseUrl).href
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(timeout, 30000) })
      return undefined
    }
    case 'fill': {
      if (!step.value) return undefined
      const locator = await resolveLocatorForStep(page, step, timeout)
      await locator.locator.fill(step.value, { timeout })
      return locator.name
    }
    case 'click': {
      const locator = await resolveLocatorForStep(page, step, timeout)
      const isSubmit = step.selector?.includes('submit') || step.description.toLowerCase().includes('submit')

      if (isSubmit) {
        const urlBefore = page.url()
        const responsePromise = page.waitForResponse(
          resp => (resp.url().includes('/api') || resp.url().includes('/auth')) && resp.status() > 0,
          { timeout: 8000 }
        ).catch(() => null)

        await locator.locator.click({ timeout })

        await Promise.race([
          page.waitForURL(url => url.href !== urlBefore, { timeout: 15000 }).catch(() => {}),
          page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
        ])
        await page.waitForTimeout(500)

        const apiResp = await responsePromise
        if (apiResp && apiResp.status() >= 400) {
          const body = await apiResp.text().catch(() => '')
          apiErrors.push({ url: apiResp.url(), status: apiResp.status(), body: body.slice(0, 200) })
        }
      } else {
        await locator.locator.click({ timeout })
      }
      return locator.name
    }
    case 'select': {
      if (!step.value) return undefined
      const locator = await resolveLocatorForStep(page, step, timeout)
      await locator.locator.selectOption(step.value, { timeout })
      return locator.name
    }
    case 'wait': {
      await page.waitForTimeout(parseInt(step.value ?? '1000'))
      return undefined
    }
    case 'assert':
      return undefined
  }
  return undefined
}

function mcpFillableByLabel(page: Page, text: string, exact: boolean) {
  const base = exact ? page.getByLabel(text, { exact: true }) : page.getByLabel(text, { exact: false })
  return base.locator('input, textarea, select, [contenteditable="true"]').first()
}

async function resolveLocatorForStep(page: Page, step: TestScenario['steps'][0], _timeout: number) {
  const selector = step.selector ?? ''
  const strategies: Array<{ locator: ReturnType<Page['locator']>; name: string }> = []

  if (step.action === 'click' && (selector.includes('submit') || step.description.toLowerCase().includes('submit'))) {
    strategies.push({ locator: page.locator('button[type="submit"], input[type="submit"]'), name: 'button[type="submit"]' })
  }

  if (step.action === 'fill') {
    const labelFromSel = selector.match(/^label=(.+)$/)?.[1]?.trim()
    if (labelFromSel) {
      strategies.push({ locator: mcpFillableByLabel(page, labelFromSel, true), name: `getByLabel("${labelFromSel}")→input` })
      strategies.push({ locator: mcpFillableByLabel(page, labelFromSel, false), name: `getByLabel("${labelFromSel}", fuzzy)→input` })
    }
    const phFromSel = selector.match(/^placeholder=(.+)$/)?.[1]?.trim()
    if (phFromSel) {
      strategies.push({ locator: page.getByPlaceholder(phFromSel, { exact: false }), name: `getByPlaceholder("${phFromSel}")` })
    }
    const labelHint = step.description.match(/Fill\s+(\w+)/i)?.[1]
    if (labelHint) strategies.push({ locator: mcpFillableByLabel(page, labelHint, false), name: `getByLabel("${labelHint}")→input` })
    const desc = step.description.toLowerCase()
    if (desc.includes('email')) strategies.push({ locator: page.getByPlaceholder('email', { exact: false }), name: 'getByPlaceholder("email")' })
    if (desc.includes('password')) strategies.push({ locator: page.getByPlaceholder('password', { exact: false }), name: 'getByPlaceholder("password")' })
  }

  if (selector && !selector.startsWith('text=') && !selector.startsWith('label=') && !selector.startsWith('placeholder=')) {
    strategies.push({ locator: page.locator(selector), name: selector })
  }

  if (selector.startsWith('text=')) {
    strategies.push({ locator: page.getByText(selector.slice(5), { exact: false }), name: `getByText("${selector.slice(5)}")` })
  }

  for (const s of strategies) {
    try {
      const count = await s.locator.count()
      if (count > 0 && await s.locator.first().isVisible().catch(() => false)) {
        return { locator: s.locator.first(), name: s.name }
      }
    } catch { continue }
  }

  if (selector.startsWith('label=')) {
    const lt = selector.slice(6).trim()
    return { locator: mcpFillableByLabel(page, lt, false), name: `fallback: getByLabel("${lt}")→input` }
  }
  if (selector.startsWith('placeholder=')) {
    const ph = selector.slice(12)
    return { locator: page.getByPlaceholder(ph, { exact: false }), name: `fallback: getByPlaceholder("${ph}")` }
  }
  if (selector) return { locator: page.locator(selector).first(), name: `fallback: ${selector}` }
  throw new Error(`No valid selector for step: ${step.description}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function ensureBrowser(): Promise<void> {
  if (!session.browser || !session.browser.isConnected()) {
    session.browser = await chromium.launch({
      headless: !(session.config?.browser?.headed ?? true),
      slowMo: session.config?.browser?.slowMo ?? 100,
    })
  }
}

async function getOrCreateUnauthContext(): Promise<BrowserContext> {
  if (session.unauthContext) return session.unauthContext

  await ensureBrowser()
  session.unauthContext = await session.browser!.newContext({
    baseURL: session.config?.url,
    viewport: { width: 1280, height: 800 },
  })
  session.unauthContext.setDefaultTimeout(30000)
  return session.unauthContext
}

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
