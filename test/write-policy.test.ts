import fs from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { explorePage, type PageExploration } from '../src/engine/browser/explorer.js'
import { editsExistingData, isExistingValue } from '../src/engine/browser/write-policy.js'
import { collectAppChanges } from '../src/engine/findings.js'
import { generateHtmlReport } from '../src/engine/reporter/html.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { ProductModel } from '../src/types/index.js'

/**
 * A small app with server-side state: a settings form prefilled with existing
 * values (overwriting them is the damage to avoid), and an "add item" form
 * that creates new records (the functional check to keep).
 */
interface State { name: string; logo: string; items: string[]; sessionPosts: number; first: string; last: string; start: string }
let state: State
const reset = () => { state = { name: 'Shady Meadows', logo: 'https://cdn.example.test/logo.png', items: [], sessionPosts: 0, first: '', last: 'Doe', start: '2024-01-01' } }

const html = (body: string) => `<!doctype html><html><head><title>App</title></head><body>${body}
  <script>fetch('/api/ping', { method: 'POST' })</script></body></html>`

let server: Server
let baseUrl: string
let browser: Browser
let shots: string

beforeAll(async () => {
  reset()
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      if (req.method === 'POST' && url.pathname === '/api/ping') { state.sessionPosts++; res.writeHead(204); res.end(); return }
      if (req.method === 'POST' && url.pathname === '/settings') {
        state.name = form.get('name') ?? state.name
        state.logo = form.get('logo') ?? state.logo
        res.writeHead(303, { location: '/settings' }); res.end(); return
      }
      if (req.method === 'POST' && url.pathname === '/schedule') {
        state.start = form.get('start') ?? state.start
        res.writeHead(303, { location: '/schedule' }); res.end(); return
      }
      if (req.method === 'POST' && url.pathname === '/profile') {
        state.first = form.get('first') ?? state.first
        state.last = form.get('last') ?? state.last
        res.writeHead(303, { location: '/profile' }); res.end(); return
      }
      if (req.method === 'POST' && url.pathname === '/items') {
        const item = form.get('item')
        if (item) state.items.push(item)
        res.writeHead(303, { location: '/items' }); res.end(); return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      if (url.pathname === '/settings') {
        res.end(html(`<h1>Site settings</h1>
          <form method="post" action="/settings">
            <label>Name <input name="name" value="${state.name}"></label>
            <label>Logo URL <input name="logo" type="url" value="${state.logo}"></label>
            <input type="hidden" name="_csrf" value="t0k3n">
            <button type="submit">Save</button>
          </form>`))
        return
      }
      if (url.pathname === '/schedule') {
        res.end(html(`<h1>Schedule</h1>
          <form method="post" action="/schedule">
            <input name="start" type="date" value="${state.start}">
            <input name="note" placeholder="Note">
            <button type="submit">Save</button>
          </form>`))
        return
      }
      if (url.pathname === '/profile') {
        res.end(html(`<h1>Profile</h1>
          <form method="post" action="/profile">
            <input name="first" placeholder="First name" value="${state.first}">
            <input name="last" placeholder="Last name" value="${state.last}">
            <button type="submit">Submit</button>
          </form>`))
        return
      }
      if (url.pathname === '/items') {
        res.end(html(`<h1>Items</h1>
          <ul>${state.items.map(item => `<li>${item}</li>`).join('')}</ul>
          <form method="post" action="/items">
            <input name="item" placeholder="Item name">
            <button type="submit">Add item</button>
          </form>`))
        return
      }
      res.end(html('<h1>Home</h1>'))
    })
  })
  baseUrl = await new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '')
  }))
  browser = await chromium.launch()
  shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-writes-'))
})

afterAll(async () => {
  await browser?.close()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.rm(shots, { recursive: true, force: true })
})

beforeEach(() => reset())

async function explore(route: string, writes?: 'safe' | 'all' | 'none'): Promise<PageExploration> {
  const context = await browser.newContext()
  try {
    return await explorePage(context, route, baseUrl, shots, undefined, { journey: false, ...(writes ? { writes } : {}) })
  } finally {
    await context.close()
  }
}

describe('write policy: never overwrite existing data by default', () => {
  it('safe (default): leaves a prefilled settings form as it was', async () => {
    const exploration = await explore('/settings')
    expect(state.name).toBe('Shady Meadows')
    expect(state.logo).toBe('https://cdn.example.test/logo.png')
    expect(exploration.interactions.filter(i => i.details.startsWith('Kept existing value'))).toHaveLength(2)
    const probe = exploration.interactions.find(i => i.action === 'boundary probe')
    expect(probe?.result).toBe('skipped')
    expect(probe?.details).toMatch(/form edits existing data \(2 fields already hold existing values\)/)
  }, 90000)

  it('safe: leaves the blank fields of a partly filled profile form alone too', async () => {
    const exploration = await explore('/profile')
    expect(state).toMatchObject({ first: '', last: 'Doe' })
    expect(exploration.interactions.find(i => i.element === 'First name')?.details).toMatch(/^Left unchanged — its form edits existing data/)
  }, 90000)

  it('safe: keeps a stored date even in a form that is otherwise blank', async () => {
    await explore('/schedule')
    expect(state.start).toBe('2024-01-01')
  }, 90000)

  it('does not report sign-in requests as changes', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { watchWrites } = await import('../src/engine/browser/write-policy.js')
    const log = watchWrites(page, baseUrl)
    await page.goto(baseUrl)
    log.startTracking()
    await page.evaluate(() => Promise.all([
      fetch('/login', { method: 'POST' }), fetch('/api/auth/validate', { method: 'POST' }), fetch('/signup', { method: 'POST' }),
    ]))
    await page.waitForTimeout(300)
    expect(log.changes.map(c => c.path)).toEqual(['/signup'])
    await context.close()
  }, 60000)

  it('masks a password repeated under another field name', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const { watchWrites } = await import('../src/engine/browser/write-policy.js')
    const log = watchWrites(page, baseUrl)
    await page.goto(baseUrl)
    log.startTracking()
    await page.evaluate(() => fetch('/signup', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'userName=bob&password=S3cret!&verify=S3cret!',
    }))
    await page.waitForTimeout(300)
    expect(log.changes[0]?.values).toBe('userName=bob, password=***, verify=***')
    await context.close()
  }, 60000)

  it('all: overwrites and probes the settings form (and discloses it)', async () => {
    const exploration = await explore('/settings', 'all')
    expect(state.name).not.toBe('Shady Meadows')
    expect(exploration.interactions.some(i => i.action.startsWith('boundary:'))).toBe(true)
    const changes = exploration.changes ?? []
    expect(changes.some(c => c.method === 'POST' && c.path === '/settings')).toBe(true)
  }, 120000)

  it('safe: still runs create-then-verify on a create form and discloses the new record', async () => {
    const exploration = await explore('/items')
    const create = exploration.interactions.find(i => i.action === 'create-then-verify')
    expect(create?.result).toBe('success')
    expect(state.items.some(item => item.startsWith('vibe-'))).toBe(true)
    const created = (exploration.changes ?? []).find(c => c.action === 'create-then-verify')
    expect(created).toMatchObject({ method: 'POST', path: '/items', status: 303 })
    expect(created?.values).toMatch(/^item=vibe-/)
  }, 90000)

  it('none: submits nothing', async () => {
    const exploration = await explore('/items', 'none')
    expect(state.items).toEqual([])
    expect(exploration.changes ?? []).toEqual([])
    expect(exploration.interactions.find(i => i.element === 'Add item')?.details).toMatch(/explore.writes: none/)
  }, 90000)

  it('does not report writes the page makes on its own while loading', async () => {
    const exploration = await explore('/items')
    expect(state.sessionPosts).toBeGreaterThan(0)
    expect((exploration.changes ?? []).some(c => c.path === '/api/ping')).toBe(false)
  }, 90000)

  it('drops CSRF tokens from disclosed values and lists changes in the summary and report', async () => {
    const exploration = await explore('/settings', 'all')
    const settingsChange = (exploration.changes ?? []).find(c => c.path === '/settings' && c.values)
    expect(settingsChange?.values).not.toMatch(/csrf|t0k3n/)
    const lines = collectAppChanges([exploration])
    expect(lines.some(line => line.startsWith('/settings: ') && line.includes('POST /settings'))).toBe(true)

    const productModel: ProductModel = {
      project_name: 'demo', url: baseUrl, framework: 'react-spa', codebase_path: '/tmp/x',
      scanned_at: '2026-01-01T00:00:00.000Z', routes: [], behaviours: [], coverage: {}, gaps: [], scenarios: [],
    }
    const report = await generateHtmlReport([], productModel, VibeConfigSchema.parse({ url: baseUrl }), [exploration], [], undefined)
    expect(report).toContain('<h2>Changes Made to the App</h2>')
    expect(report).toContain('<code>POST /settings</code>')
  }, 120000)
})

describe('edit-existing detection', () => {
  it('treats numbers and dates as defaults, names and URLs as existing data', () => {
    expect(isExistingValue('0')).toBe(false)
    expect(isExistingValue('06/11/2026')).toBe(false)
    expect(isExistingValue('')).toBe(false)
    expect(isExistingValue('Shady Meadows')).toBe(true)
    expect(isExistingValue('https://cdn.example.test/logo.png')).toBe(true)
  })

  it('needs two existing values, or one plus settings/profile wording', () => {
    expect(editsExistingData([{ value: 'Ann' }, { value: 'Lee' }], 'Contact')).toBeTruthy()
    expect(editsExistingData([{ value: 'Ann' }, { value: '' }], 'Contact us')).toBeUndefined()
    expect(editsExistingData([{ value: 'Ann' }, { value: '' }], 'Edit profile')).toMatch(/profile/)
    expect(editsExistingData([{ value: '0' }, { value: '0' }, { value: '0' }], 'Contributions')).toBeUndefined()
  })
})
