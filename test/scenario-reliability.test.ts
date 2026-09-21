import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { executeScenarios } from '../src/engine/browser/runner.js'
import { VibeConfigSchema } from '../src/types/config.js'
import type { TestScenario, TestStep } from '../src/types/index.js'
import { fixture } from './helpers/page-fixture.js'

const wire = vi.hoisted(() => ({ client: null as any }))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const [server, client] = InMemoryTransport.createLinkedPair()
  wire.client = client
  return { StdioServerTransport: class { constructor() { return server } } }
})
vi.mock('playwright', async () => {
  const { makeContext } = await import('./helpers/page-fixture.js')
  return { chromium: { launch: async () => ({ newContext: async () => makeContext(), close: async () => {}, isConnected: () => true }) } }
})
vi.mock('../src/engine/browser/explorer.js', () => ({ exploreAllPages: async () => [], explorePage: vi.fn() }))
vi.mock('../src/engine/browser/live-routes.js', () => ({
  crawlLiveRoutes: async () => ({ status: 'unavailable', routes: [], scenarios: [], attemptedPaths: ['/'], reason: 'fixture unavailable' }),
}))
vi.mock('child_process', () => ({ exec: vi.fn() }))
let dir: string
let client: Client
beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html><title>Fixture</title>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })))
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-scenario-'))
  await fs.writeFile(path.join(dir, 'upload.txt'), 'file content')
  await import('../src/mcp-server.js')
  client = new Client({ name: 'regression-tests', version: '1' })
  await client.connect(wire.client as InMemoryTransport)
  await client.callTool({ name: 'scan_codebase', arguments: { url: 'http://example.test', codebase_path: dir } })
})
afterAll(async () => {
  await client?.callTool({ name: 'cleanup', arguments: {} })
  await client?.close()
  await fs.rm(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})
beforeEach(() => {
  fixture.body = 'Welcome to the application. This page contains enough content for the smoke verifier.'
  fixture.elements.clear()
  fixture.uploaded = []
  fixture.closed = 0
})

async function run(via: 'CLI' | 'MCP', steps: TestStep[]) {
  const scenario: TestScenario = { id: 'regression', name: 'Reliability regression', route: '/', priority: 'high', steps, expected_outcome: 'Checks succeed', is_gap: false, generated_by: 'heuristic' }
  if (via === 'CLI') {
    return (await executeScenarios([scenario], VibeConfigSchema.parse({ url: 'http://example.test', browser: { headed: false } }), dir)).results[0]
  }
  const response = await client.callTool({ name: 'execute_scenario', arguments: { scenario } })
  const result = JSON.parse((response.content as any[])[0].text)
  expect(response.isError ?? false).toBe(result.status !== 'pass')
  return result
}
const nav: TestStep = { action: 'navigate', url: '/', description: 'Open fixture' }
const check = (extra: Partial<TestStep> = {}): TestStep => ({ action: 'assert', description: 'Check page', timeout: 20, ...extra })

describe.each(['CLI', 'MCP'] as const)('%s scenario reliability', via => {
  it('fails a blank page assertion and stops before subsequent steps', async () => {
    fixture.body = ''
    const result = await run(via, [nav, check(), { action: 'wait', value: '1', description: 'Must not run' }])
    expect(result.status).toBe('fail')
    expect(result.step_logs).toHaveLength(2)
    expect(result.step_logs[1].status).toBe('failed')
    expect(result.failure_reason).toMatch(/assertion.*blank/i)
    expect(fixture.closed).toBe(1)
  })
  it('checks visible errors beyond a hidden first alert', async () => {
    fixture.elements.set('alert-hidden', { text: 'old error', visible: false })
    fixture.elements.set('alert-visible', { text: 'Request failed', visible: true })
    const result = await run(via, [nav, check()])
    expect(result.status).toBe('fail')
    expect(result.failure_reason).toContain('Request failed')
  })
  it('ignores hidden error indicators when the page is healthy', async () => {
    fixture.elements.set('alert-hidden', { text: 'Old error', visible: false })
    expect((await run(via, [nav, check()])).status).toBe('pass')
  })
  it('does not accept unrelated healthy content for a missing selector', async () => {
    const result = await run(via, [nav, check({ selector: '#missing' })])
    expect(result.status).toBe('fail')
    expect(result.step_logs[1].error).toMatch(/#missing/)
  })
  it('fails a hidden selector', async () => {
    fixture.elements.set('#hidden', { text: 'Expected', visible: false })
    expect((await run(via, [nav, check({ selector: '#hidden' })])).status).toBe('fail')
  })
  it('fails wrong expected text', async () => {
    fixture.elements.set('#result', { text: 'Pending', visible: true })
    expect((await run(via, [nav, check({ selector: '#result', value: 'Saved' })])).status).toBe('fail')
  })
  it('checks body text when only value is supplied', async () => {
    expect((await run(via, [nav, check({ value: 'Missing confirmation' })])).status).toBe('fail')
  })
  it('fails the wrong URL even when its prefix matches', async () => {
    expect((await run(via, [{ ...nav, url: '/dashboard-old' }, check({ url: '/dashboard' })])).status).toBe('fail')
  })
  it('passes matching explicit selector, text, and URL', async () => {
    fixture.elements.set('#result', { text: 'Saved successfully', visible: true })
    const result = await run(via, [nav, check({ selector: '#result', value: 'Saved', url: '/' })])
    expect(result.status).toBe('pass')
    expect(result.step_logs[1].status).toBe('ok')
  })
  it('allows an explicit assertion of expected error UI', async () => {
    fixture.elements.set('alert-visible', { text: 'Invalid email', visible: true })
    fixture.elements.set('#validation', { text: 'Invalid email', visible: true })
    expect((await run(via, [nav, check({ selector: '#validation', value: 'Invalid email' })])).status).toBe('pass')
  })
  it('passes an explicit assertion on a short page', async () => {
    fixture.body = 'OK'
    expect((await run(via, [nav, check({ value: 'OK' })])).status).toBe('pass')
  })
  it('passes a healthy page-health assertion', async () => {
    expect((await run(via, [nav, check()])).status).toBe('pass')
  })
  it('uploads a real file through a hidden file input', async () => {
    fixture.elements.set('#file', { text: '', visible: false })
    const file = path.join(dir, 'upload.txt')
    const result = await run(via, [nav, { action: 'upload', selector: '#file', value: file, description: 'Upload fixture' }])
    expect(result.status).toBe('pass')
    expect(fixture.uploaded).toEqual([file])
    expect(result.step_logs[1].selector_used).toContain('#file')
  })
  it.each([
    { selector: '#file' },
    { selector: '#file', value: '' },
    { value: '/does-not-exist' },
    { selector: '#file', value: '/does-not-exist' },
    { selector: '#missing', value: 'upload.txt' },
    { selector: '#not-file', value: 'upload.txt' },
  ])('rejects invalid uploads: %j', async extra => {
    fixture.elements.set('#file', { text: '', visible: false })
    fixture.elements.set('#not-file', { text: '', visible: true })
    const result = await run(via, [nav, { action: 'upload', description: 'Upload fixture', timeout: 20, ...extra }])
    expect(result.status).toBe('error')
    expect(result.step_logs[1].status).toBe('failed')
  })
  it('rejects empty scenarios', async () => {
    expect((await run(via, [])).status).toBe('error')
  })
  it('rejects unknown actions instead of logging them as successful', async () => {
    const result = await run(via, [nav, { action: 'imaginary' as any, description: 'Unsupported action' }])
    expect(result.status).toBe('error')
    expect(result.step_logs[1].status).toBe('failed')
  })
})

it('MCP run_full_test returns a structured diagnostic for empty discovery', async () => {
  const result = await client.callTool({ name: 'run_full_test', arguments: { url: 'http://example.test', codebase_path: dir } })
  expect(result.isError).toBe(true)
  const diagnostic = JSON.parse((result.content as any[])[0].text)
  expect(diagnostic).toMatchObject({ outcome: 'no-safe-scenarios', framework: 'unknown', static_route_count: 0 })
  expect(diagnostic.next_action).toBeTruthy()
  expect((result.content as any[])[0].text).not.toContain(' at ')
})

it('rejects an empty batch at the execution entry point', async () => {
  await expect(executeScenarios([], VibeConfigSchema.parse({ url: 'http://example.test' }), dir)).rejects.toThrow(/no.*scenarios/i)
})

it.each(['run_full_test', 'run_converge'])('MCP %s flags failed runs like the CLI', async name => {
  const root = path.join(dir, name)
  await fs.mkdir(path.join(root, 'app', 'about'), { recursive: true })
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15' } }))
  await fs.writeFile(path.join(root, 'app', 'about', 'page.tsx'), 'export default function Page() { return <h1>About this application</h1> }')
  fixture.body = ''
  const result = await client.callTool({ name, arguments: { url: 'http://example.test', codebase_path: root, max_followup_rounds: 0 } })
  expect(result.isError).toBe(true)
  expect((result.content as any[])[0].text).toContain('Failed: 1')
})
