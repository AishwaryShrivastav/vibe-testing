import { createServer, type Server } from 'node:http'
import { chromium, type Browser } from 'playwright'

/**
 * Real-browser fixture: serves a map of path → HTML on 127.0.0.1 and records
 * every request (so tests can prove a button was or was NOT clicked when its
 * click handler calls fetch('/hit/<name>')).
 */
export interface BrowserFixture {
  baseUrl: string
  browser: Browser
  hits: string[]
  close: () => Promise<void>
}

export async function startBrowserFixture(pages: Record<string, string>): Promise<BrowserFixture> {
  const hits: string[] = []
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '/'
    hits.push(url)
    const pathOnly = url.split('?')[0]
    const html = pages[pathOnly]
    if (html === undefined) {
      res.writeHead(url.startsWith('/hit/') ? 204 : 404, { 'content-type': 'text/html' })
      res.end(url.startsWith('/hit/') ? '' : '<!doctype html><title>404</title><h1>404 Not Found</h1>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
  })
  const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('Fixture server did not bind')
    resolve(addr.port)
  }))
  const browser = await chromium.launch()
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    browser,
    hits,
    close: async () => {
      await browser.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

export function page(body: string, title = 'Fixture'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}
