import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const wire = vi.hoisted(() => ({ client: null as any }))
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
  const [server, client] = InMemoryTransport.createLinkedPair()
  wire.client = client
  return { StdioServerTransport: class { constructor() { return server } } }
})

const expectedExistingTools = [
  'scan_codebase',
  'login',
  'scan_page_elements',
  'explore_page',
  'execute_scenario',
  'get_coverage',
  'generate_report',
  'take_screenshot',
  'suggest_tests',
  'run_full_test',
  'run_converge',
  'get_context',
  'cleanup',
]

let client: Client
let projectRoot: string
let serverUrl: string
let closeServer: () => Promise<void>

beforeAll(async () => {
  projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-mcp-configure-'))
  await fs.mkdir(path.join(projectRoot, 'src', 'routes'), { recursive: true })
  await fs.writeFile(path.join(projectRoot, 'package.json'), JSON.stringify({
    dependencies: {
      react: '^19.0.0',
      '@tanstack/react-router': '^1.0.0',
    },
  }))
  await fs.writeFile(path.join(projectRoot, 'src', 'routes', '__root.tsx'), 'export const Route = createRootRoute()')
  await fs.writeFile(path.join(projectRoot, 'src', 'routes', 'index.tsx'), `export default function Home() { return <button>Sign in with Google</button> }`)
  await fs.writeFile(path.join(projectRoot, '.gitignore'), 'node_modules/\n')

  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Fixture</title><h1>Fixture</h1>')
  })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const address = httpServer.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  serverUrl = `http://127.0.0.1:${address.port}`
  closeServer = () => new Promise((resolve, reject) => httpServer.close(error => error ? reject(error) : resolve()))

  await import('../src/mcp-server.js')
  client = new Client({ name: 'mcp-configure-test', version: '1' })
  await client.connect(wire.client as InMemoryTransport)
})

afterAll(async () => {
  await client?.close()
  await closeServer?.()
  await fs.rm(projectRoot, { recursive: true, force: true })
})

describe('MCP configuration contract', () => {
  it('preserves all 13 tool schemas, adds configure, and makes run_full_test URL optional', async () => {
    const listed = await client.listTools()
    const names = listed.tools.map(tool => tool.name)

    expect(names).toEqual([...expectedExistingTools, 'configure'])
    expect(new Set(names).size).toBe(14)
    const fullTest = listed.tools.find(tool => tool.name === 'run_full_test')!
    expect(fullTest.inputSchema.required ?? []).not.toContain('url')
  })

  it('publishes concise initialize instructions for the self-healing workflow', () => {
    expect(client.getInstructions()).toContain('configure')
    expect(client.getInstructions()).toContain('run_full_test')
    expect(client.getInstructions()).toContain('generate_report')
  })

  it('configures a TanStack project idempotently without inventing credentials', async () => {
    const first = await client.callTool({
      name: 'configure',
      arguments: { codebase_path: projectRoot, url: serverUrl },
    })
    const firstResult = JSON.parse((first.content as any[])[0].text)
    expect(first.isError ?? false).toBe(false)
    expect(firstResult.framework).toBe('tanstack-router')
    expect(firstResult.server.url).toBe(serverUrl)
    expect(firstResult.auth).toMatchObject({ method: 'oauth', provider: 'google' })

    const configPath = path.join(projectRoot, 'vibe.config.json')
    const configBefore = await fs.readFile(configPath)
    const vibePath = path.join(projectRoot, 'VIBE.md')
    await fs.writeFile(vibePath, '# Authored guidance\n\nUse an existing browser session.\n')

    const second = await client.callTool({
      name: 'configure',
      arguments: { codebase_path: projectRoot, url: serverUrl },
    })
    expect(second.isError ?? false).toBe(false)
    expect((await fs.readFile(configPath)).equals(configBefore)).toBe(true)
    expect(await fs.readFile(vibePath, 'utf8')).toBe('# Authored guidance\n\nUse an existing browser session.\n')

    const config = JSON.parse(configBefore.toString('utf8'))
    expect(config).toMatchObject({ url: serverUrl, mode: 'deep', auth: { strategy: 'skip' } })
    expect(JSON.stringify(config)).not.toMatch(/password|placeholder/i)
    const gitignore = await fs.readFile(path.join(projectRoot, '.gitignore'), 'utf8')
    expect(gitignore.match(/^\.vibe\/$/gm)).toHaveLength(1)
  })

  it('returns a structured server-unavailable diagnostic for an unreachable remote run URL', async () => {
    const remoteProject = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-mcp-remote-'))
    await fs.writeFile(path.join(remoteProject, 'package.json'), '{}')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('remote timeout') }))
    try {
      const response = await client.callTool({
        name: 'run_full_test',
        arguments: { codebase_path: remoteProject, url: 'https://offline.example.test' },
      })
      const diagnostic = JSON.parse((response.content as any[])[0].text)
      expect(response.isError).toBe(true)
      expect(diagnostic).toMatchObject({
        outcome: 'server-unavailable',
        framework: 'unknown',
        crawl: { status: 'not-started', pages_observed: 0 },
      })
      expect(diagnostic.crawl.attempted_paths).toContain('https://offline.example.test')
      expect(diagnostic.report_path).toMatch(/diagnostic\.json$/)
    } finally {
      vi.unstubAllGlobals()
      await fs.rm(remoteProject, { recursive: true, force: true })
    }
  })
})
