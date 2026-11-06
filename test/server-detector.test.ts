import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  detectLiveServer,
  discoverActiveLoopbackPorts,
} from '../src/engine/context/server-detector.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(dispose => dispose()))
})

async function makeProject(packageJson: object = {}): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-server-detector-'))
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(packageJson))
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

async function serve(contentType = 'text/html', body = '<!doctype html><title>App</title>'): Promise<string> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': contentType })
    response.end(body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

/** Serve fixed responses per path, e.g. a `/` that redirects to `/login`. */
async function serveRoutes(
  routes: Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
): Promise<string> {
  const server = http.createServer((request, response) => {
    const route = routes[new URL(request.url ?? '/', 'http://x').pathname]
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
      return
    }
    response.writeHead(route.status, route.headers ?? {})
    response.end(route.body ?? '')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

const HTML = { 'content-type': 'text/html; charset=utf-8' }

function portOf(url: string): number {
  return Number(new URL(url).port)
}

describe('detectLiveServer', () => {
  it('prefers a valid explicit URL over a configured URL', async () => {
    const codebasePath = await makeProject()
    const explicitUrl = await serve()
    const configuredUrl = await serve()

    const result = await detectLiveServer(
      { codebasePath, explicitUrl, configuredUrl },
      { listActiveLoopbackPorts: async () => [], commonPorts: [] },
    )

    expect(result.url).toBe(explicitUrl)
    expect(result.evidence).toContainEqual(expect.objectContaining({ source: 'explicit-url' }))
    expect(result.attemptedCandidates).toHaveLength(1)
  })

  it('does not fall back from an unusable explicit URL to the configured URL', async () => {
    const codebasePath = await makeProject()
    const configuredUrl = await serve()

    const result = await detectLiveServer(
      { codebasePath, explicitUrl: 'https://example.com', configuredUrl },
      {
        fetch: (async input => {
          if (String(input).startsWith('https://example.com')) throw new Error('remote unavailable')
          return fetch(input)
        }) as typeof fetch,
        listActiveLoopbackPorts: async () => [],
        commonPorts: [],
      },
    )

    expect(result.url).toBeUndefined()
    expect(result.attemptedCandidates).toEqual([
      expect.objectContaining({ source: 'explicit-url', outcome: 'unreachable' }),
    ])
    expect(result.failure).toMatch(/URL supplied for this run \(https:\/\/example\.com\).*remote unavailable/)
  })

  it('never substitutes another running app for an unusable explicit URL', async () => {
    // Regression: testing NodeGoat on :4000 silently tested Juice Shop on :3000.
    const codebasePath = await makeProject()
    const otherApp = await serve()
    const unusableUrl = await serve('application/json', '{"ok":true}')

    const result = await detectLiveServer(
      { codebasePath, explicitUrl: unusableUrl },
      {
        listActiveLoopbackPorts: async () => [portOf(otherApp)],
        commonPorts: [portOf(otherApp)],
      },
    )

    expect(result.url).toBeUndefined()
    expect(result.attemptedCandidates).toHaveLength(1)
    expect(result.failure).toContain('does not substitute another local server')
  })

  it('selects an explicit URL whose root redirects to a same-origin login page', async () => {
    const codebasePath = await makeProject()
    const appUrl = await serveRoutes({
      '/': { status: 302, headers: { location: '/login' } },
      '/login': { status: 200, headers: HTML, body: '<!doctype html><form></form>' },
    })

    const result = await detectLiveServer(
      { codebasePath, explicitUrl: appUrl },
      { listActiveLoopbackPorts: async () => [], commonPorts: [] },
    )

    expect(result.url).toBe(appUrl)
    expect(result.attemptedCandidates).toEqual([
      expect.objectContaining({ outcome: 'selected', detail: 'followed same-origin redirect to /login' }),
    ])
  })

  it('follows a chain of same-origin redirects but stops a redirect loop', async () => {
    const codebasePath = await makeProject()
    const chained = await serveRoutes({
      '/': { status: 301, headers: { location: '/a' } },
      '/a': { status: 307, headers: { location: '/b?next=%2F' } },
      '/b': { status: 200, headers: HTML, body: '<!doctype html>' },
    })
    const looping = await serveRoutes({
      '/': { status: 302, headers: { location: '/' } },
    })

    const chainedResult = await detectLiveServer(
      { codebasePath, explicitUrl: chained },
      { listActiveLoopbackPorts: async () => [], commonPorts: [] },
    )
    const loopResult = await detectLiveServer(
      { codebasePath, explicitUrl: looping },
      { listActiveLoopbackPorts: async () => [], commonPorts: [] },
    )

    expect(chainedResult.url).toBe(chained)
    expect(loopResult.url).toBeUndefined()
    expect(loopResult.attemptedCandidates[0]).toMatchObject({ outcome: 'rejected', detail: 'more than 5 redirects' })
  })

  it('treats the configured URL as authoritative over discovered ports', async () => {
    const codebasePath = await makeProject()
    const activeApp = await serve()

    const result = await detectLiveServer(
      { codebasePath, configuredUrl: 'http://127.0.0.1:1' },
      {
        listActiveLoopbackPorts: async () => [portOf(activeApp)],
        commonPorts: [],
        timeoutMs: 50,
      },
    )

    expect(result.url).toBeUndefined()
    expect(result.attemptedCandidates).toEqual([
      expect.objectContaining({ source: 'configured-url', outcome: 'unreachable' }),
    ])
    expect(result.failure).toContain('The URL in vibe.config.json')
  })

  it('treats an inferred URL as a hint and keeps discovering when it is down', async () => {
    const codebasePath = await makeProject()
    const activeApp = await serve()

    const result = await detectLiveServer(
      { codebasePath, inferredUrl: 'http://localhost:1' },
      {
        listActiveLoopbackPorts: async () => [portOf(activeApp)],
        commonPorts: [],
        timeoutMs: 50,
      },
    )

    expect(result.url).toBe(`http://localhost:${portOf(activeApp)}`)
    expect(result.attemptedCandidates[0]).toMatchObject({ source: 'inferred-url', outcome: 'unreachable' })
    expect(result.failure).toBeUndefined()
  })

  it('selects a reachable remote HTTPS URL only after an injected HTML probe', async () => {
    const codebasePath = await makeProject()
    const calls: string[] = []
    const result = await detectLiveServer(
      { codebasePath, explicitUrl: 'https://staging.example.test/app?token=secret#fragment' },
      {
        fetch: (async (input, init) => {
          calls.push(String(input))
          expect(init?.redirect).toBe('manual')
          expect(init?.signal).toBeDefined()
          return new Response('<!doctype html><title>Staging</title>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        }) as typeof fetch,
        listActiveLoopbackPorts: async () => [],
        commonPorts: [],
      },
    )

    expect(calls).toEqual(['https://staging.example.test/app'])
    expect(result.url).toBe('https://staging.example.test')
    expect(result.attemptedCandidates).toEqual([
      expect.objectContaining({ outcome: 'selected', source: 'explicit-url' }),
    ])
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('does not select an unreachable remote URL', async () => {
    const codebasePath = await makeProject()
    const result = await detectLiveServer(
      { codebasePath, explicitUrl: 'https://offline.example.test' },
      {
        fetch: (async () => { throw new Error('connect timeout') }) as typeof fetch,
        listActiveLoopbackPorts: async () => [],
        commonPorts: [],
        timeoutMs: 25,
      },
    )

    expect(result.url).toBeUndefined()
    expect(result.attemptedCandidates).toEqual([
      expect.objectContaining({ url: 'https://offline.example.test', outcome: 'unreachable' }),
    ])
  })

  it('does not select a remote URL that returns non-HTML content', async () => {
    const codebasePath = await makeProject()
    const result = await detectLiveServer(
      { codebasePath, configuredUrl: 'https://api.example.test' },
      {
        fetch: (async () => new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
        listActiveLoopbackPorts: async () => [],
        commonPorts: [],
      },
    )

    expect(result.url).toBeUndefined()
    expect(result.attemptedCandidates).toEqual([
      expect.objectContaining({ url: 'https://api.example.test', source: 'configured-url', outcome: 'non-html' }),
    ])
  })

  it('detects a Vite --port script before active and common ports', async () => {
    const scriptUrl = await serve()
    const activeUrl = await serve()
    const commonUrl = await serve()
    const codebasePath = await makeProject({
      scripts: { dev: `vite --host 127.0.0.1 --port ${portOf(scriptUrl)}` },
    })

    const result = await detectLiveServer(
      { codebasePath },
      {
        listActiveLoopbackPorts: async () => [portOf(activeUrl)],
        commonPorts: [portOf(commonUrl)],
      },
    )

    expect(result.url).toBe(`http://localhost:${portOf(scriptUrl)}`)
    expect(result.evidence).toContainEqual(expect.objectContaining({ source: 'script' }))
  })

  it('prefers an active loopback port over bounded common ports', async () => {
    const activeUrl = await serve()
    const commonUrl = await serve()
    const codebasePath = await makeProject()

    const result = await detectLiveServer(
      { codebasePath },
      {
        listActiveLoopbackPorts: async () => [portOf(activeUrl)],
        commonPorts: [portOf(commonUrl)],
      },
    )

    expect(result.url).toBe(`http://localhost:${portOf(activeUrl)}`)
    expect(result.evidence).toContainEqual(expect.objectContaining({ source: 'active-port' }))
  })

  it('rejects non-HTML and unreachable candidates within the injected bound', async () => {
    const nonHtmlUrl = await serve('application/json', '{"ok":true}')
    const codebasePath = await makeProject()
    const unreachablePort = 1

    const result = await detectLiveServer(
      { codebasePath, inferredUrl: nonHtmlUrl },
      {
        listActiveLoopbackPorts: async () => [],
        commonPorts: [unreachablePort],
        timeoutMs: 50,
      },
    )

    expect(result.url).toBeUndefined()
    expect(result.attemptedCandidates).toEqual([
      expect.objectContaining({ url: nonHtmlUrl, outcome: 'non-html' }),
      expect.objectContaining({ url: `http://localhost:${unreachablePort}`, outcome: 'unreachable' }),
    ])
  })

  it('never follows redirects away from a loopback candidate', async () => {
    const codebasePath = await makeProject()
    let redirectMode: RequestRedirect | undefined
    const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
      redirectMode = init?.redirect
      return new Response('', {
        status: 302,
        headers: { location: 'https://example.com' },
      })
    }) as typeof fetch

    const result = await detectLiveServer(
      { codebasePath, explicitUrl: 'http://localhost:4567' },
      {
        fetch: fetchStub,
        listActiveLoopbackPorts: async () => [],
        commonPorts: [],
      },
    )

    expect(redirectMode).toBe('manual')
    expect(result.url).toBeUndefined()
    expect(result.attemptedCandidates).toContainEqual(expect.objectContaining({
      outcome: 'rejected',
      detail: 'HTTP 302 redirects to a different origin (https://example.com)',
    }))
  })

  it('strips credentials, query parameters, and fragments from selected server data', async () => {
    const codebasePath = await makeProject()
    const fixtureUrl = new URL(await serve())
    const explicitUrl = `http://user:password@${fixtureUrl.host}/app?state=oauth-secret&token=magic-secret#fragment-secret`

    const result = await detectLiveServer(
      { codebasePath, explicitUrl },
      { listActiveLoopbackPorts: async () => [], commonPorts: [] },
    )

    expect(result.url).toBe(fixtureUrl.origin)
    expect(result.evidence).toContainEqual(expect.objectContaining({
      source: 'explicit-url',
      value: `${fixtureUrl.origin}/app`,
    }))
    expect(result.attemptedCandidates).toContainEqual(expect.objectContaining({
      url: `${fixtureUrl.origin}/app`,
      outcome: 'selected',
    }))
    expect(JSON.stringify(result)).not.toMatch(/user|password|state|oauth-secret|token|magic-secret|fragment-secret/)
  })

  it('sanitizes rejected candidates before returning attempts', async () => {
    const codebasePath = await makeProject()
    const configuredUrl = await serve()
    const result = await detectLiveServer(
      {
        codebasePath,
        explicitUrl: 'https://user:password@example.com/auth?state=state-secret#token-secret',
        configuredUrl,
      },
      {
        fetch: (async input => {
          if (String(input).startsWith('https://example.com')) throw new Error('remote unavailable')
          return fetch(input)
        }) as typeof fetch,
        listActiveLoopbackPorts: async () => [],
        commonPorts: [],
      },
    )

    expect(result.attemptedCandidates[0]).toEqual(expect.objectContaining({
      url: 'https://example.com/auth',
      outcome: 'unreachable',
    }))
    expect(JSON.stringify(result)).not.toMatch(/user|password|state-secret|token-secret/)
  })
})

describe('discoverActiveLoopbackPorts', () => {
  it('uses lsof on macOS and parses only loopback-accessible listeners', async () => {
    const commands: string[] = []
    const result = await discoverActiveLoopbackPorts({
      platform: 'darwin',
      runCommand: async command => {
        commands.push(command)
        return 'n127.0.0.1:3000\nn[::1]:5173\nn*:8080\nn192.168.1.50:9000\n'
      },
    })

    expect(commands).toEqual(['lsof'])
    expect(result).toMatchObject({ available: true, ports: [3000, 5173, 8080] })
  })

  it('uses ss on Linux and parses bounded listener output', async () => {
    const result = await discoverActiveLoopbackPorts({
      platform: 'linux',
      runCommand: async command => {
        expect(command).toBe('ss')
        return [
          'LISTEN 0 511 127.0.0.1:3001 0.0.0.0:*',
          'LISTEN 0 511 [::1]:4321 [::]:*',
          'LISTEN 0 511 10.0.0.4:9999 0.0.0.0:*',
        ].join('\n')
      },
    })

    expect(result).toMatchObject({ available: true, ports: [3001, 4321] })
  })

  it('falls back to Unix netstat when ss is unavailable', async () => {
    const commands: string[] = []
    const result = await discoverActiveLoopbackPorts({
      platform: 'linux',
      runCommand: async command => {
        commands.push(command)
        if (command === 'ss') throw new Error('missing')
        return [
          'tcp 0 0 127.0.0.1:4173 0.0.0.0:* LISTEN',
          'tcp6 0 0 :::5174 :::* LISTEN',
        ].join('\n')
      },
    })

    expect(commands).toEqual(['ss', 'netstat'])
    expect(result).toMatchObject({ available: true, ports: [4173, 5174] })
  })

  it('uses Windows netstat and parses LISTENING endpoints', async () => {
    const result = await discoverActiveLoopbackPorts({
      platform: 'win32',
      runCommand: async command => {
        expect(command).toBe('netstat')
        return [
          'TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    100',
          'TCP    [::1]:8080        [::]:0       LISTENING    101',
          'TCP    192.168.1.5:9000  0.0.0.0:0    LISTENING    102',
        ].join('\n')
      },
    })

    expect(result).toMatchObject({ available: true, ports: [3000, 8080] })
  })

  it('records unavailable discovery before bounded common-port fallback', async () => {
    const codebasePath = await makeProject()
    const commonUrl = await serve()
    const calls: string[] = []

    const result = await detectLiveServer(
      { codebasePath },
      {
        platform: 'linux',
        runListenerCommand: async command => {
          calls.push(command)
          throw new Error('not installed')
        },
        commonPorts: [portOf(commonUrl)],
      },
    )

    expect(calls).toEqual(['ss', 'netstat'])
    expect(result.url).toBe(`http://localhost:${portOf(commonUrl)}`)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      stage: 'active-port-discovery',
      status: 'unavailable',
    }))
    expect(result.evidence).toContainEqual(expect.objectContaining({ source: 'common-port' }))
  })
})
