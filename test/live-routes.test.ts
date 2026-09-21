import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { crawlLiveRoutes } from '../src/engine/browser/live-routes.js'

let server: Server
let externalServer: Server
let baseUrl: string
let externalUrl: string
const hits: string[] = []
const externalHits: string[] = []

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
    resolve(address.port)
  }))
}

beforeAll(async () => {
  externalServer = createServer((request, response) => {
    externalHits.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<h1>External</h1>')
  })
  externalUrl = `http://127.0.0.1:${await listen(externalServer)}`

  server = createServer((request, response) => {
    const requestUrl = request.url ?? '/'
    hits.push(requestUrl)
    response.writeHead(200, { 'content-type': 'text/html' })
    if (requestUrl === '/') {
      response.end(`<!doctype html><title>Home</title>
        <a href="/about">About</a>
        <a href="/about#team">Duplicate fragment</a>
        <a href="#local">Fragment</a>
        <a href="${externalUrl}/outside">External</a>
        <a href="/logout">Log out</a>
        <a href="/account/delete">Delete account</a>
        <a href="/billing">Billing</a>
        <a href="/search?q=dynamic">Dynamic query</a>`)
      return
    }
    if (requestUrl === '/about') {
      response.end('<!doctype html><title>About</title><a href="/team">Team</a>')
      return
    }
    response.end(`<!doctype html><title>Page</title><h1>${requestUrl}</h1>`)
  })
  baseUrl = `http://127.0.0.1:${await listen(server)}`
})

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => externalServer.close(error => error ? reject(error) : resolve())),
  ])
})

describe('live route recovery', () => {
  it('crawls a bounded set of unique safe same-origin paths and builds page-health smoke scenarios', async () => {
    const result = await crawlLiveRoutes({
      baseUrl,
      maxPages: 5,
      maxDepth: 2,
      blockedPatterns: ['billing'],
    })

    expect(result.status).toBe('completed')
    expect(result.routes.map(route => route.path)).toEqual(['/', '/about', '/team'])
    expect(result.routes.every(route => route.origin === 'live-crawl')).toBe(true)
    expect(externalHits).not.toContain('/outside')
    expect(hits).not.toContain('/logout')
    expect(hits).not.toContain('/account/delete')
    expect(hits).not.toContain('/billing')
    expect(hits).not.toContain('/search?q=dynamic')

    expect(result.scenarios).toHaveLength(3)
    for (const scenario of result.scenarios) {
      expect(scenario.route_origin).toBe('live-crawl')
      expect(scenario.steps.map(step => step.action)).toEqual(['navigate', 'assert'])
      expect(scenario.steps[1]).toMatchObject({ description: expect.stringMatching(/page health/i) })
      expect(scenario.steps[1].selector).toBeUndefined()
      expect(scenario.steps[1].value).toBeUndefined()
    }
  })

  it('honors the page budget', async () => {
    const result = await crawlLiveRoutes({ baseUrl, maxPages: 2, maxDepth: 4 })
    expect(result.routes).toHaveLength(2)
    expect(result.attemptedPaths.length).toBeLessThanOrEqual(2)
  })
})
