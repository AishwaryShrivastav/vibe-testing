import { createServer, type Server, type ServerResponse } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { matchCrashText } from '../src/engine/browser/error-signals.js'
import { collectExplorerFailures } from '../src/engine/index.js'
import { explorePage } from '../src/engine/browser/explorer.js'
import { runOneScenario } from '../src/engine/browser/runner.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestScenario } from '../src/types/index.js'

const page = (body: string) => `<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`
const CRASH = 'Internal Error\nOops..\nReferenceError: abc is not defined\n    at eval (eval at update (/app/routes/contributions.js:32:23))'

let server: Server
let baseUrl: string
let browser: Browser
let screenshotsDir: string
const hung: ServerResponse[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html' })
      res.end(body)
    }
    const readForm = (handle: (form: URLSearchParams) => void) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => handle(new URLSearchParams(body)))
    }

    if (req.method === 'POST' && url.pathname === '/calc') {
      return readForm(form => /^\d+$/.test(form.get('amount') ?? '')
        ? send(200, page('<p>Saved</p>'))
        : send(500, page(`<pre>${CRASH}</pre>`)))
    }
    if (req.method === 'POST' && url.pathname === '/routing') {
      return readForm(form => {
        if ((form.get('bankRouting') ?? '').length >= 20) { hung.push(res); return } // never answers
        send(200, page('<p>Saved</p>'))
      })
    }
    if (req.method === 'POST') return readForm(() => send(200, page('<p>Thanks, saved</p>')))

    switch (url.pathname) {
      case '/calc':
        return send(200, page(`<form method="post" action="/calc"><h2>Contributions</h2>
          <input name="amount" value="0"><textarea name="notes"></textarea><button type="submit">Save</button></form>`))
      case '/routing':
        return send(200, page(`<form method="post" action="/routing">
          <input name="bankRouting" placeholder="Routing number"><button type="submit">Save</button></form>`))
      case '/signin':
        return send(200, page(`<form method="post" action="/signin">
          <input name="userName"><input type="password" name="password"><button type="submit">Sign in</button></form>`))
      case '/comment':
        return send(200, page(`<form method="post" action="/comment">
          <input name="title"><textarea name="body"></textarea><button type="submit">Post</button></form>`))
      case '/validated':
        return send(200, page(`<form method="post" action="/validated">
          <input name="qty" value="1" required pattern="[0-9]+"><button type="submit">Update</button></form>`))
      case '/docs':
        return send(200, page(`<h1>Errors guide</h1><pre>ReferenceError: x is not defined
    at Object.&lt;anonymous&gt; (/app/index.js:1:1)</pre><button type="button">Copy</button>`))
      case '/boom':
        return send(500, page(`<pre>${CRASH}</pre>`))
      default:
        return send(404, page('<h1>404</h1>'))
    }
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    resolve(address.port)
  }))
  baseUrl = `http://127.0.0.1:${port}`
  browser = await chromium.launch()
  screenshotsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-v8-g9-'))
})

afterAll(async () => {
  for (const res of hung) res.destroy()
  await browser?.close()
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.rm(screenshotsDir, { recursive: true, force: true })
})

describe('collectExplorerFailures (run summary)', () => {
  it('keeps real failures and drops explorer diagnostics', () => {
    const base = { url: '', elements_discovered: 0, elements_by_type: {}, interactions: [], api_calls: [], duration_ms: 0 }
    expect(collectExplorerFailures([
      { ...base, route: '/contributions', errors: [
        'Server error 500 on POST /contributions: ReferenceError: abc is not defined',
        'Server error 500 on POST /contributions: ReferenceError: abc is not defined',
        'form /routing (boundary: long-input): No response within 10s after submitting long-input input in bankRouting',
        'Uncaught exception: Cannot read properties of null',
      ] },
      { ...base, route: '/x', errors: ['Navigation failed: timeout', 'Redirected to /login — authentication may have failed'] },
    ])).toEqual([
      '/contributions: Server error 500 on POST /contributions: ReferenceError: abc is not defined',
      '/contributions: form /routing (boundary: long-input): No response within 10s after submitting long-input input in bankRouting',
      '/contributions: Uncaught exception: Cannot read properties of null',
    ])
  })
})

describe('matchCrashText', () => {
  it.each([
    ['ReferenceError: abc is not defined', 'ReferenceError: abc is not defined'],
    ['TypeError: Cannot read properties of undefined (reading \'id\')', 'TypeError'],
    ['    at Object.<anonymous> (/srv/app/index.js:12:7)', 'at Object.<anonymous>'],
    ['Traceback (most recent call last):\n  File "app.py"', 'Traceback'],
    ['500 Internal Server Error', 'Internal Server Error'],
    ['Application error: a client-side exception has occurred', 'Application error'],
  ])('detects %j', (text, expected) => {
    expect(matchCrashText(text)).toContain(expected)
  })

  it.each(['Your order was saved', 'Invalid contribution percentages', 'Error: password too short', '404 Not Found'])(
    'ignores ordinary messages: %j', text => {
      expect(matchCrashText(text)).toBeUndefined()
    })
})

describe('runner fails scenarios on server crashes (V8)', () => {
  const config = () => VibeConfigSchema.parse({ url: baseUrl, browser: { headed: false, slowMo: 0 } })

  async function run(scenario: TestScenario) {
    const ctx = await browser.newContext({ baseURL: baseUrl })
    try {
      return await runOneScenario(scenario, ctx, config(), screenshotsDir, screenshotsDir)
    } finally {
      await ctx.close()
    }
  }

  const scenario = (id: string, steps: TestScenario['steps'], route = '/calc'): TestScenario => ({
    id, name: id, route, priority: 'high', steps, expected_outcome: 'Saved', is_gap: true, generated_by: 'heuristic',
  })

  it('fails a form scenario whose submit returns a 500, with the crash text as evidence', async () => {
    const result = await run(scenario('crash', [
      { action: 'navigate', url: '/calc', description: 'Open' },
      { action: 'fill', selector: '[name=amount]', value: 'abc', description: 'Non-numeric amount' },
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit' },
    ]))
    expect(result.status).toBe('fail')
    expect(result.server_errors?.[0]).toMatchObject({ status: 500, method: 'POST' })
    expect(result.failure_reason).toMatch(/^Server error 500 on POST \/calc: ReferenceError: abc is not defined/)
  }, 60_000)

  it('keeps the crash evidence even when an explicit assertion also fails', async () => {
    const result = await run(scenario('crash-assert', [
      { action: 'navigate', url: '/calc', description: 'Open' },
      { action: 'fill', selector: '[name=amount]', value: 'abc', description: 'Non-numeric amount' },
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit' },
      { action: 'assert', value: 'Invalid amount', timeout: 1000, description: 'Validation message' },
    ]))
    expect(result.status).toBe('fail')
    expect(result.failure_reason).toMatch(/^Server error 500 on POST \/calc: ReferenceError/)
  }, 60_000)

  it('fails when a page load itself returns 500', async () => {
    const result = await run(scenario('boom', [
      { action: 'navigate', url: '/boom', description: 'Open' },
      { action: 'assert', value: 'Oops', description: 'Page has text' },
    ], '/boom'))
    expect(result.status).toBe('fail')
    expect(result.server_errors?.[0]).toMatchObject({ status: 500 })
  }, 60_000)

  it('passes a valid submission and a docs page that merely shows error text', async () => {
    const ok = await run(scenario('valid', [
      { action: 'navigate', url: '/calc', description: 'Open' },
      { action: 'fill', selector: '[name=amount]', value: '12', description: 'Amount' },
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit' },
      { action: 'assert', value: 'Saved', description: 'Saved message' },
    ]))
    expect(ok).toMatchObject({ status: 'pass' })
    expect(ok.server_errors).toBeUndefined()

    const docs = await run(scenario('docs', [
      { action: 'navigate', url: '/docs', description: 'Open' },
      { action: 'click', selector: 'text=Copy', description: 'Copy example' },
      { action: 'assert', value: 'Errors guide', description: 'Heading' },
    ], '/docs'))
    expect(docs).toMatchObject({ status: 'pass' })
  }, 60_000)
})

describe('explorer boundary probes (G9) and crash detection (V8)', () => {
  async function explore(route: string) {
    const ctx = await browser.newContext({ baseURL: baseUrl })
    try {
      return await explorePage(ctx, route, baseUrl, screenshotsDir)
    } finally {
      await ctx.close()
    }
  }
  const probes = (exploration: Awaited<ReturnType<typeof explore>>) =>
    exploration.interactions.filter(i => i.elementType === 'form' && i.action.startsWith('boundary'))

  it('finds the 500 caused by non-numeric input in a numeric-looking field', async () => {
    const exploration = await explore('/calc')
    const nonNumeric = probes(exploration).find(p => p.action === 'boundary: non-numeric')
    expect(nonNumeric).toMatchObject({ result: 'error' })
    expect(nonNumeric?.details).toMatch(/Server error 500 on POST \/calc: ReferenceError: abc is not defined/)
    expect(exploration.errors.some(e => /Server error 500 on POST \/calc/.test(e))).toBe(true)
    expect(exploration.api_calls.some(a => a.status === 500 && a.method === 'POST')).toBe(true)
  }, 90_000)

  it('reports a hang when a long number never gets a response', async () => {
    const exploration = await explore('/routing')
    const long = probes(exploration).find(p => p.action === 'boundary: long-input')
    expect(long).toMatchObject({ result: 'error' })
    expect(long?.details).toMatch(/^No response within 10s .*bankRouting/)
    expect(probes(exploration).some(p => p.action === 'boundary: special-chars')).toBe(false) // stops after a hang
  }, 90_000)

  it('never probes sign-in forms', async () => {
    const exploration = await explore('/signin')
    expect(probes(exploration)).toEqual([
      expect.objectContaining({ result: 'skipped', details: expect.stringContaining('password field') }),
    ])
  }, 60_000)

  it('reports handled and client-blocked probes without errors', async () => {
    const comment = await explore('/comment')
    expect(probes(comment).map(p => p.result)).toEqual(['success', 'success'])
    expect(comment.errors).toEqual([])

    const validated = await explore('/validated')
    expect(probes(validated).find(p => p.action === 'boundary: non-numeric')).toMatchObject({ result: 'no_change' })
  }, 90_000)

  it('does not flag documentation that merely contains error text', async () => {
    const exploration = await explore('/docs')
    expect(exploration.errors).toEqual([])
    expect(exploration.interactions.filter(i => i.result === 'error')).toEqual([])
  }, 60_000)

  it('reports a page that returns 500 on load', async () => {
    const exploration = await explore('/boom')
    expect(exploration.errors[0]).toMatch(/^Server error 500 on GET \/boom: ReferenceError/)
  }, 60_000)
})
