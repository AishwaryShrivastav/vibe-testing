import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { explorePage, exploreAllPages, type PageExploration } from '../src/engine/browser/explorer.js'
import { describeFingerprintChange, normalisePath, type PageFingerprint } from '../src/engine/browser/fingerprint.js'
import { changedFilesSince, impactOfChanges } from '../src/engine/context/change-impact.js'
import { basicPlan, fingerprintChange, planRun, scenariosForPlan, summarisePlan } from '../src/engine/test-plan.js'
import { matchesScope } from '../src/engine/context/index.js'
import { formatPlan } from '../src/run-findings-text.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { ProductModel, Route, TestScenario } from '../src/types/index.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

vi.setConfig({ testTimeout: 60_000 })

const dirs: string[] = []
afterAll(async () => { for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true }) })

function vcs(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()
}

/** A small React-style app in a fresh repository: 4 pages, a component, a shared context, a style sheet. */
async function repoFixture(): Promise<{ root: string; routes: Route[]; base: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-impact-'))
  dirs.push(root)
  const files: Record<string, string> = {
    'src/context/AppContext.jsx': 'export const AppContext = {}\n',
    'src/components/PriceTag.jsx': "export default function PriceTag() { return null }\n",
    'src/styles/pos.css': '.pos { color: red }\n',
    'src/pages/LoginPage.jsx': "import { AppContext } from '../context/AppContext'\nexport default function LoginPage() {}\n",
    'src/pages/ProductsPage.jsx': "import { AppContext } from '../context/AppContext'\nexport default function ProductsPage() {}\n",
    'src/pages/CategoriesPage.jsx': "import { AppContext } from '../context/AppContext.jsx'\nexport default function CategoriesPage() {}\n",
    'src/pages/POSPage.jsx': "import { AppContext } from '../context/AppContext'\nimport PriceTag from '../components/PriceTag'\nimport '../styles/pos.css'\nexport default function POSPage() {}\n",
    'README.md': '# app\n',
  }
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), content)
  }
  vcs(root, 'init', '-q')
  vcs(root, 'add', '-A')
  vcs(root, 'commit', '-q', '-m', 'base')
  const page = (p: string, file: string): Route => ({ path: p, type: 'page', requires_auth: false, dynamic_segments: [], file_path: path.join(root, file), origin: 'static' })
  return {
    root,
    base: vcs(root, 'rev-parse', 'HEAD'),
    routes: [
      page('/login', 'src/pages/LoginPage.jsx'),
      page('/products', 'src/pages/ProductsPage.jsx'),
      page('/categories', 'src/pages/CategoriesPage.jsx'),
      page('/pos', 'src/pages/POSPage.jsx'),
    ],
  }
}

async function touch(root: string, file: string) {
  await fs.appendFile(path.join(root, file), '// edited\n')
}

describe('change detection: changed files → pages', () => {
  it('a page\'s own file makes that page thorough and leaves the others alone', async () => {
    const { root, routes, base } = await repoFixture()
    await touch(root, 'src/pages/POSPage.jsx')
    const changes = await changedFilesSince(root, base)
    expect(changes.ok).toBe(true)
    expect(changes.files.map(f => path.relative(root, f))).toEqual(['src/pages/POSPage.jsx'])
    const impact = await impactOfChanges(routes, changes.files, root)
    expect(impact.pages.get('/pos')).toEqual({ depth: 'thorough', reason: 'changed src/pages/POSPage.jsx' })
    expect(impact.pages.size).toBe(1)
  })

  it('a component makes the pages that import it thorough', async () => {
    const { root, routes, base } = await repoFixture()
    await touch(root, 'src/components/PriceTag.jsx')
    const impact = await impactOfChanges(routes, (await changedFilesSince(root, base)).files, root)
    expect(impact.pages.get('/pos')).toEqual({ depth: 'thorough', reason: 'uses changed src/components/PriceTag.jsx' })
    expect(impact.pages.size).toBe(1)
  })

  it('a file most pages use makes every page standard', async () => {
    const { root, routes, base } = await repoFixture()
    await touch(root, 'src/context/AppContext.jsx')
    const impact = await impactOfChanges(routes, (await changedFilesSince(root, base)).files, root)
    expect(impact.shared).toBe('src/context/AppContext.jsx')
    expect([...impact.pages.values()].map(d => d.depth)).toEqual(['standard', 'standard', 'standard', 'standard'])
    expect(impact.pages.get('/login')?.reason).toBe('shared file changed src/context/AppContext.jsx')
  })

  it('a style sheet only asks for a light check, and unused files are listed', async () => {
    const { root, routes, base } = await repoFixture()
    await touch(root, 'src/styles/pos.css')
    await touch(root, 'README.md')
    await fs.writeFile(path.join(root, 'notes.txt'), 'untracked')
    const changes = await changedFilesSince(root, base)
    expect(changes.files.map(f => path.relative(root, f)).sort()).toEqual(['README.md', 'notes.txt', 'src/styles/pos.css'])
    const impact = await impactOfChanges(routes, changes.files, root)
    expect(impact.pages.get('/pos')).toEqual({ depth: 'light', reason: 'style change src/styles/pos.css' })
    expect(impact.unused.sort()).toEqual(['README.md', 'notes.txt'])
  })

  it('outside a repository, or without a baseline, detection reports why', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-norepo-'))
    dirs.push(plain)
    expect(await changedFilesSince(plain, 'HEAD')).toMatchObject({ ok: false, note: expect.stringMatching(/no git repository/) })
    const { root } = await repoFixture()
    expect(await changedFilesSince(root, undefined)).toMatchObject({ ok: false, note: 'no baseline yet (first run)' })
    expect(await changedFilesSince(root, 'no-such-branch')).toMatchObject({ ok: false, note: 'unknown ref "no-such-branch"' })
  })
})

function model(routes: Route[], scenarios: TestScenario[] = []): ProductModel {
  return {
    project_name: 'x', url: 'http://x.test', framework: 'react-spa', codebase_path: '/x', scanned_at: '',
    routes, behaviours: [], coverage: {}, gaps: [], scenarios,
  }
}

const smoke = (route: string): TestScenario => ({
  id: `s${route}`, name: `${route} page loads`, route, priority: 'medium', expected_outcome: '', is_gap: true, generated_by: 'heuristic',
  steps: [{ action: 'navigate', url: route, description: '' }, { action: 'assert', description: '' }],
})
const interactive = (route: string, name = `Interact with ${route}`): TestScenario => ({
  ...smoke(route), id: `i${route}${name}`, name, steps: [{ action: 'navigate', url: route, description: '' }, { action: 'fill', selector: '#q', value: 'x', description: '' }],
})

describe('mode → depth plan', () => {
  it('deep tests every page thoroughly; fast lightly and without session checks', () => {
    const deep = basicPlan('deep')
    expect(deep.decide('/anything')).toEqual({ depth: 'thorough', reason: 'every page thoroughly' })
    expect(deep.sessionChecks([])).toBe(true)
    const fast = basicPlan('fast')
    expect(fast.decide('/anything')).toMatchObject({ depth: 'light' })
    expect(fast.sessionChecks([])).toBe(false)
  })

  it('auto: changed page thorough, others light; changed: others skipped', async () => {
    const { root, routes, base } = await repoFixture()
    await touch(root, 'src/pages/POSPage.jsx')
    const config = (mode: 'auto' | 'changed') => VibeConfigSchema.parse({ url: 'http://x.test', codebase_path: root, mode, scope: { since: base } })
    const auto = await planRun(config('auto'), model(routes), root)
    expect(auto.basis).toBe('code changes')
    expect(auto.decide('/pos')).toEqual({ depth: 'thorough', reason: 'changed src/pages/POSPage.jsx' })
    expect(auto.decide('/products')).toEqual({ depth: 'light', reason: 'unchanged' })
    const changed = await planRun(config('changed'), model(routes), root)
    expect(changed.decide('/pos')).toMatchObject({ depth: 'thorough' })
    expect(changed.decide('/products')).toBe('skip')
  })

  it('auto without a baseline behaves like deep, and says so', async () => {
    const { root, routes } = await repoFixture()
    const plan = await planRun(VibeConfigSchema.parse({ url: 'http://x.test', codebase_path: root, mode: 'auto' }), model(routes), root)
    expect(plan.decide('/products')).toMatchObject({ depth: 'thorough' })
    expect(plan.notes.join(' ')).toMatch(/first run/)
  })

  it('light pages keep smoke scenarios only; login scenarios always stay', () => {
    const plan = { ...basicPlan('fast') }
    const login = { ...interactive('/login', 'Login with saved credentials') }
    const { kept, dropped } = scenariosForPlan([smoke('/a'), interactive('/a'), login], plan)
    expect(kept.map(s => s.name)).toEqual(['/a page loads', 'Login with saved credentials'])
    expect(dropped).toBe(1)
  })
})

const fp = (overrides: Partial<PageFingerprint> = {}): PageFingerprint => ({
  hash: 'h1', controls: ['button::add to pos'], links: ['/pos'], forms: [], headings: ['products'], apis: ['GET /api/items'], ...overrides,
})

describe('page fingerprints (black-box change detection)', () => {
  it('reports what changed, and nothing for an unchanged page', () => {
    expect(describeFingerprintChange(fp(), fp())).toBeUndefined()
    expect(describeFingerprintChange(fp(), fp({ hash: 'h2', controls: ['button::add to pos', 'button::remove'] }))).toBe('controls +1')
  })

  it('upgrades new and changed pages, not unchanged ones', () => {
    const exploration = (route: string, fingerprint: PageFingerprint) => ({ route, fingerprint } as PageExploration)
    const store = { '/products': { ...fp(), at: '' } }
    expect(fingerprintChange(store, exploration('/products', fp()))).toBeUndefined()
    expect(fingerprintChange(store, exploration('/products', fp({ hash: 'h3', apis: [] })))).toBe('changed since the last run: API calls -1')
    expect(fingerprintChange(store, exploration('/pos', fp()))).toBe('new page since the last run')
  })

  it('normalises ids so new records do not look like a change', () => {
    expect(normalisePath('/rooms/42/edit')).toBe('/rooms/:id/edit')
    expect(normalisePath('/users/5f8d0d55b54764421b7156c3')).toBe('/users/:id')
  })
})

describe('explorer depths on a live page', () => {
  let server: Server
  let baseUrl: string
  const hits: string[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '')
      const html = (body: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><body>${body}</body></html>`) }
      if (req.url === '/boom') { res.writeHead(500, { 'content-type': 'text/html' }); res.end('<h1>Internal Server Error</h1><pre>TypeError: cannot read x of undefined</pre>'); return }
      if (req.url === '/ok') return html('<h1>OK</h1>')
      if (req.url?.startsWith('/items/')) return html('<h1>Item</h1><button>Add to cart</button><a href="/ok">Back</a>')
      if (req.url === '/noisy') return html('<h1>Noisy</h1><script>console.error("TypeError: total is undefined")</script>')
      return html('<h1>Home</h1><input placeholder="Name"><button id="tick">Show more</button><a href="/ok">OK</a><a href="/boom">Broken</a>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  })
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

  let fx: BrowserFixture
  beforeAll(async () => { fx = await startBrowserFixture({ '/': page('<p>unused</p>') }) })
  afterAll(async () => { await fx?.close() })

  it('checks links by request: a 500 behind a link is a server error, and the page is loaded once', async () => {
    const context = await fx.browser.newContext()
    hits.length = 0
    try {
      const exploration = await explorePage(context, '/', baseUrl, os.tmpdir(), undefined, { depth: 'standard', depthReason: 'test' })
      expect(exploration.depth).toBe('standard')
      const broken = exploration.interactions.find(i => i.element === 'Broken')
      expect(broken).toMatchObject({ result: 'error', details: 'HTTP 500 at /boom' })
      expect(exploration.errors.some(e => /^Server error 500 on GET \/boom: TypeError: cannot read x of undefined/.test(e))).toBe(true)
      expect(hits.filter(h => h === '/').length).toBe(1)
      expect(exploration.timings).toMatchObject({ load: expect.any(Number), links: expect.any(Number) })
    } finally {
      await context.close()
    }
  })

  it('light: no clicks or fills, still a fingerprint', async () => {
    const context = await fx.browser.newContext()
    try {
      const exploration = await explorePage(context, '/', baseUrl, os.tmpdir(), undefined, { depth: 'light', depthReason: 'test' })
      expect(exploration.interactions).toEqual([])
      expect(exploration.fingerprint?.controls).toEqual(['button:submit:show more', 'input:text:name'])
    } finally {
      await context.close()
    }
  })

  it('same-template pages after the first get light checks, with the reason', async () => {
    const context = await fx.browser.newContext()
    try {
      const explorations = await exploreAllPages(context, ['/items/1', '/items/2', '/items/3'], baseUrl, os.tmpdir(), undefined, {
        templateOf: route => route.startsWith('/items/') ? '/items/:id' : undefined,
        boundaryProbes: false, createChecks: false,
      })
      expect(explorations.map(e => [e.depth, e.depth_reason])).toEqual([
        ['thorough', 'every page thoroughly'],
        ['light', 'same template as /items/1 (/items/:id)'],
        ['light', 'same template as /items/1 (/items/:id)'],
      ])
    } finally {
      await context.close()
    }
  })

  it('safety net: a problem at light depth gets the page re-tested thoroughly', async () => {
    const context = await fx.browser.newContext()
    try {
      const [exploration] = await exploreAllPages(context, ['/noisy'], baseUrl, os.tmpdir(), undefined, {
        decide: () => ({ depth: 'light', reason: 'unchanged' }),
        boundaryProbes: false, createChecks: false,
      })
      expect(exploration.depth).toBe('thorough')
      expect(exploration.depth_reason).toBe('upgraded after a problem at light depth')
      expect(exploration.errors).toContain('Console error: TypeError: total is undefined')
    } finally {
      await context.close()
    }
  })

  it('a page whose scenario failed is explored thoroughly; skipped pages are reported', async () => {
    const context = await fx.browser.newContext()
    const skipped: string[] = []
    try {
      const explorations = await exploreAllPages(context, ['/ok', '/items/1'], baseUrl, os.tmpdir(), undefined, {
        decide: route => route === '/ok' ? { depth: 'light', reason: 'unchanged' } : 'skip',
        failedRoutes: new Set(['/ok']),
        onSkip: route => skipped.push(route),
        boundaryProbes: false, createChecks: false,
      })
      expect(explorations.map(e => [e.route, e.depth])).toEqual([['/ok', 'thorough']])
      expect(explorations[0].depth_reason).toMatch(/^upgraded after a failing scenario/)
      expect(skipped).toEqual(['/items/1'])
    } finally {
      await context.close()
    }
  })
})

/** A single-page shop: /shop adds items, /cart starts empty and keeps a stale total after checkout. */
const SHOP_SPA = page(`
  <nav><a href="/shop">Shop</a> <a href="/cart">Cart</a></nav>
  <main id="main"></main>
  <script>
    const items = []
    let total = 0
    function go(path) { history.pushState({}, '', path); render() }
    document.querySelectorAll('nav a').forEach(a => a.onclick = e => { e.preventDefault(); go(a.getAttribute('href')) })
    function render() {
      const main = document.getElementById('main')
      if (location.pathname === '/shop') {
        main.innerHTML = '<h1>Shop</h1><p>Laptop - $1000.00</p><button id="add">Add to cart</button>'
        document.getElementById('add').onclick = () => items.push(1000)
        return
      }
      total = items.reduce((a, b) => a + b, 0)   // computed when the cart opens, never again
      main.innerHTML = '<h1>Cart</h1>' + (items.length ? items.map(p => '<p>Laptop - $' + p.toFixed(2) + '</p>').join('') : '<p>No items in the cart.</p>') +
        '<p>Total: $' + total.toFixed(2) + '</p><button id="checkout">Checkout</button>'
      document.getElementById('checkout').onclick = () => {
        items.length = 0
        main.querySelectorAll('p').forEach(p => { if (p.textContent.startsWith('Laptop')) p.remove() })
        main.insertAdjacentHTML('afterbegin', '<p>No items in the cart.</p>')
      }
    }
    render()
  </script>`)

describe('journey: an empty page is exercised with an item added elsewhere', () => {
  let shop: BrowserFixture
  beforeAll(async () => { shop = await startBrowserFixture({ '/shop': SHOP_SPA, '/cart': SHOP_SPA }) })
  afterAll(async () => { await shop?.close() })

  it('adds on a linked page, returns in-app and catches the stale total', async () => {
    const context = await shop.browser.newContext()
    try {
      const exploration = await explorePage(context, '/cart', shop.baseUrl, os.tmpdir(), undefined, { boundaryProbes: false, createChecks: false })
      expect(exploration.interactions.some(i => i.action === 'journey: add elsewhere, return' && /Add to cart/.test(i.details))).toBe(true)
      expect(exploration.errors.some(e => /^Total mismatch on \/cart after adding an item on \/shop/.test(e))).toBe(true)
    } finally {
      await context.close()
    }
  })
})

describe('plan reporting and scope', () => {
  it('summarises each page\'s depth and reason, and formats it compactly', () => {
    const plan = basicPlan('deep')
    const exploration = (route: string, depth: 'thorough' | 'light', reason: string) => ({
      route, url: '', elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: [], errors: [], duration_ms: 0, depth, depth_reason: reason,
    } as PageExploration)
    const summary = summarisePlan(plan, [
      exploration('/tutorial/a1', 'thorough', 'every page thoroughly'),
      exploration('/tutorial/a2', 'light', 'same template as /tutorial/a1 (/tutorial/:page)'),
    ], ['/admin'])
    expect(summary.counts).toEqual({ thorough: 1, standard: 0, light: 1, skipped: 1 })
    const text = formatPlan(summary)
    expect(text).toContain('- Test plan: mode deep (every page): 1 thorough, 1 light, 1 skipped')
    expect(text).toContain('  - light /tutorial/a2: same template as /tutorial/a1 (/tutorial/:page)')
    expect(text).not.toContain('/tutorial/a1: every page thoroughly')
  })

  it('scope include/exclude decides which crawled pages are kept', () => {
    expect(matchesScope('/admin/rooms', ['/**'], ['/admin/**'])).toBe(false)
    expect(matchesScope('/admin', ['/**'], ['/admin/**'])).toBe(false)
    expect(matchesScope('/products', ['/products', '/pos'], [])).toBe(true)
    expect(matchesScope('/categories', ['/products', '/pos'], [])).toBe(false)
  })
})
