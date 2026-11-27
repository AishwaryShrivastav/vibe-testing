import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { runCaseFiles } from '../src/engine/cases/index.js'

vi.mock('child_process', async importOriginal => ({ ...await importOriginal<typeof import('child_process')>(), exec: vi.fn() }))

/**
 * Real Chromium against a small app: a login form that sets a session cookie,
 * JSON routes that need it, and pages for layout, motion and accessibility checks.
 */
const LOGIN = `<!doctype html><html lang="en"><head><title>Login</title></head><body><main>
<form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email">
<label for="pw">Password</label><input id="pw" name="password" type="password"><button type="submit">Sign in</button></form></main></body></html>`
const HOME = `<!doctype html><html lang="en"><head><title>Today</title></head><body><main><h1>Today</h1><p id="who">Signed in</p></main></body></html>`
const LAYOUT = `<!doctype html><html lang="en"><head><title>Layout</title><style>body{margin:0}.wide{width:300px;height:10px;background:#000}.low{margin-top:1200px}</style></head>
<body><main><h1>Layout</h1><button id="top">Top</button><div class="wide"></div><button id="low" class="low">Low</button></main></body></html>`
const MOTION = `<!doctype html><html lang="en"><head><title>Motion</title><style>
@keyframes spin{to{transform:rotate(360deg)}}
.once{animation:spin 300ms 1}.forever{animation:spin 1s infinite}
@media (prefers-reduced-motion: reduce){.once,.forever{animation:none}}
</style></head><body><main><h1>Motion</h1><div class="once">a</div><div class="forever">b</div>
<p id="m"></p><script>document.getElementById('m').textContent = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'full'</script></main></body></html>`
const BAD_A11Y = `<!doctype html><html lang="en"><head><title>Bad</title></head><body><main><h1>Bad</h1><input type="text"><img src="x.png"></main></body></html>`
const KEYS = `<!doctype html><html lang="en"><head><title>Keys</title></head><body><main><h1>Keys</h1>
<form id="f"><label for="q">Search</label><input id="q"><output id="out"></output></form>
<script>document.getElementById('f').onsubmit = e => { e.preventDefault(); document.getElementById('out').textContent = 'Searched ' + document.getElementById('q').value }</script></main></body></html>`

let server: Server
let base: string
let dir: string

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-cases-'))
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const signedIn = /(?:^|;\s*)sid=ok/.test(req.headers.cookie ?? '')
    const send = (status: number, body: string, type = 'text/html', headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(body) }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      if (url.pathname === '/login' && req.method === 'POST') {
        const form = new URLSearchParams(body)
        if (form.get('email') === 'owner@example.test' && form.get('password') === 'pw-1') return send(303, '', 'text/html', { location: '/', 'set-cookie': 'sid=ok; Path=/; HttpOnly' })
        return send(303, '', 'text/html', { location: '/login?error=1' })
      }
      if (url.pathname === '/login') return send(200, LOGIN)
      if (url.pathname === '/layout') return send(200, LAYOUT)
      if (url.pathname === '/motion') return send(200, MOTION)
      if (url.pathname === '/bad') return send(200, BAD_A11Y)
      if (url.pathname === '/keys') return send(200, KEYS)
      if (url.pathname.startsWith('/api/')) {
        if (!signedIn) return send(303, '', 'text/html', { location: '/login' })
        if (url.pathname === '/api/classify' && req.method === 'POST') {
          const input = JSON.parse(body || '{}') as { title?: string }
          if (!input.title) return send(400, JSON.stringify({ detail: 'title is required' }), 'application/json')
          return send(200, JSON.stringify({ lead_type: /partner/i.test(input.title) ? 'channel' : 'client', why: 'title' }), 'application/json')
        }
        if (url.pathname === '/api/items') return send(200, JSON.stringify({ items: [{ id: 1, origin: 'website' }, { id: 2, origin: 'user' }] }), 'application/json')
        if (url.pathname === '/api/stream') return send(200, 'event: message\ndata: {"result":{"tools":[{"name":"brain_read"}]}}\n\n', 'text/event-stream')
      }
      if (url.pathname === '/') return signedIn ? send(200, HOME) : send(303, '', 'text/html', { location: '/login' })
      send(404, '<!doctype html><title>404</title><h1>Not found</h1>')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

const CASES = `# Cases

| ID | What | Priority |
|---|---|---|
| TC-9 | No steps | P2 |

### TC-1 Sign in through the form (P0)
\`\`\`vibe
open /login
fill "label=Email" owner@example.test
fill "label=Password" \${VIBE_TEST_PW}
press Enter
url /
see h1 Today
\`\`\`

### TC-2 API needs a session (P0)
\`\`\`vibe
@auth
request POST /api/classify {"title": "Partner"}
status 200
json lead_type = channel
request POST /api/classify {}
status 400
json detail contains required
request GET /api/items
json items[*].origin exists
json items length 2
request GET /api/stream
json result.tools contains brain_read
\`\`\`

### TC-3 Signed out gets a redirect (P1)
\`\`\`vibe
request --no-follow GET /api/items
status 303
\`\`\`

### TC-4 Layout at two widths (P1)
\`\`\`vibe
@viewports 1280x800 390x844
open /layout
in-viewport #top
no-horizontal-scroll
\`\`\`

### TC-5 Below the fold fails (P1)
\`\`\`vibe
open /layout
in-viewport #low
\`\`\`

### TC-5b Sideways scroll fails (P1)
\`\`\`vibe
@viewports 200x600
open /layout
no-horizontal-scroll
\`\`\`

### TC-6 Motion settles only with reduced motion (P1)
\`\`\`vibe
@motion full reduce
open /motion
still 800
\`\`\`

### TC-7 Accessibility (P1)
\`\`\`vibe
open /bad
a11y serious
\`\`\`

### TC-8 Keys and eval (P2)
\`\`\`vibe
open /keys
fill #q shoes
press Enter #q
see #out "Searched shoes"
eval document.activeElement.id === 'q'
\`\`\`

### TC-9 No steps
- vibe: "Do something a person describes."

### TC-10 Live only (live)
\`\`\`vibe
open /
\`\`\`
`

describe.runIf(process.env.VIBE_REAL_BROWSER === '1')('markdown test cases in real Chromium', () => {
  it('runs every kind of step, the viewport x motion matrix, auth, and writes all reports', async () => {
    process.env.VIBE_TEST_PW = 'pw-1'
    const file = path.join(dir, 'cases.md')
    await fs.writeFile(file, CASES)
    const out = await runCaseFiles({
      files: [file], projectRoot: dir, toolVersion: 'test', baseUrl: base,
      config: { retries: 0, browser: { headed: false, slowMo: 0, timeout: 10000 }, auth: { strategy: 'credentials', login_url: '/login', credentials: { email: 'owner@example.test', password: '${VIBE_TEST_PW}' } } },
      junit: path.join(dir, 'junit.xml'),
      ledger: { file: path.join(dir, 'evidence.jsonl'), task: 'E-test', by: 'agent:test' },
      sha: 'abc1234',
    })
    const byId = Object.fromEntries(out.run.cases.map(c => [c.id, c]))
    expect(byId['TC-1'].status).toBe('pass')
    expect(byId['TC-1'].variants[0].result?.verification_status).toBe('outcome_verified')
    expect(byId['TC-2'].status).toBe('pass')
    expect(byId['TC-3'].status).toBe('pass')
    expect(byId['TC-4'].status).toBe('pass')
    expect(byId['TC-4'].variants.map(v => v.name)).toEqual(['1280x800 full', '390x844 full'])
    expect(byId['TC-5'].status).toBe('fail')
    expect(byId['TC-5'].reason).toMatch(/#low is not fully in the 1280x800 viewport on \/layout/)
    expect(byId['TC-5b'].status).toBe('fail')
    expect(byId['TC-5b'].reason).toMatch(/page scrolls sideways on \/layout: content 300px wide in a 200px viewport/)
    // The infinite animation keeps running with full motion; reduced motion turns it off.
    expect(byId['TC-6'].status).toBe('fail')
    const [full, reduce] = byId['TC-6'].variants
    expect(full.status).toBe('fail')
    expect(full.reason).toMatch(/1 animation\(s\) still running after 800ms on \/motion: div.forever/)
    expect(reduce.status).toBe('pass')
    expect(byId['TC-7'].status).toBe('fail')
    expect(byId['TC-7'].reason).toMatch(/label|image-alt/)
    expect(byId['TC-8'].status).toBe('pass')
    expect(byId['TC-9']).toMatchObject({ status: 'needs_steps', priority: 'P2', hint: 'Do something a person describes.' })
    expect(byId['TC-10']).toMatchObject({ status: 'skip' })
    expect(out.run.summary).toMatchObject({ total: 11, pass: 5, fail: 4, needs_steps: 1, skip: 1 })

    const junit = await fs.readFile(out.junit_path!, 'utf8')
    expect(junit).toContain('name="TC-4 Layout at two widths [390x844 full]"')
    const ledger = (await fs.readFile(out.ledger_path!, 'utf8')).trim().split('\n').map(l => JSON.parse(l))
    expect(ledger).toHaveLength(11)
    expect(ledger[0]).toMatchObject({ task: 'E-test', stage: 'E4_vibe_test', kind: 'vibe-run', ref: 'TC-1', result: 'pass', sha: 'abc1234' })
    const json = JSON.parse(await fs.readFile(out.json_path, 'utf8'))
    expect(json.cases[0].variants[0].steps.length).toBeGreaterThan(3)
    expect(await fs.readFile(out.report_path, 'utf8')).toContain('TC-5')
  }, 120000)

  it('signs in from configured cookies instead of a login form', async () => {
    const file = path.join(dir, 'cookie.md')
    await fs.writeFile(file, '### TC-C1 Cookie session\n```vibe\n@auth\nrequest GET /api/items\nstatus 200\nopen /\nsee h1 Today\n```\n')
    const out = await runCaseFiles({
      files: [file], projectRoot: dir, toolVersion: 'test', baseUrl: base, outDir: path.join(dir, 'cookie-out'),
      config: { retries: 0, browser: { headed: false, slowMo: 0, timeout: 10000 }, auth: { strategy: 'skip', cookies: [{ name: 'sid', value: 'ok' }] } },
    })
    expect(out.run.cases[0].status).toBe('pass')
  }, 60000)

  it('runs static files from @base next to the markdown', async () => {
    const site = path.join(dir, 'design')
    await fs.mkdir(site, { recursive: true })
    await fs.writeFile(path.join(site, 'v1.html'), '<!doctype html><html lang="en"><head><title>V1</title></head><body><main><h1 id="t">Variant one</h1></main><script>if (location.search.includes("state=error")) document.getElementById("t").textContent = "Error state"</script></body></html>')
    await fs.writeFile(path.join(site, 'cases.md'), '```vibe\n@base .\n```\n### TC-S1 Static (P0)\n```vibe\nopen v1.html?state=error\nsee #t "Error state"\n```\n')
    const out = await runCaseFiles({ files: [path.join(site, 'cases.md')], projectRoot: dir, toolVersion: 'test', outDir: path.join(dir, 'static-out'), config: { retries: 0, browser: { headed: false, slowMo: 0 } } })
    expect(out.run.cases[0].status).toBe('pass')
    expect(out.run.cases[0].base_url).toMatch(/^file:\/\/.*\/design\/$/)
  }, 60000)
})
