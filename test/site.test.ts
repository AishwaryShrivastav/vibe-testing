import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getNpmDownloads, refreshNpmDownloads } from '../site/download-count.js'

const root = resolve(import.meta.dirname, '..')
const html = readFileSync(resolve(root, 'site/index.html'), 'utf8')
const css = readFileSync(resolve(root, 'site/styles.css'), 'utf8')
const script = readFileSync(resolve(root, 'site/app.js'), 'utf8')
const cname = readFileSync(resolve(root, 'site/CNAME'), 'utf8').trim()
const robots = readFileSync(resolve(root, 'site/robots.txt'), 'utf8')
const sitemap = readFileSync(resolve(root, 'site/sitemap.xml'), 'utf8')

const tools = [
  'scan_codebase',
  'get_context',
  'login',
  'scan_page_elements',
  'explore_page',
  'execute_scenario',
  'get_coverage',
  'suggest_tests',
  'take_screenshot',
  'generate_report',
  'run_full_test',
  'run_converge',
  'cleanup',
  'configure',
]

describe('launch site', () => {
  it('offers verified install and source paths', () => {
    expect(html).toContain('npx vibe-testing@latest init')
    expect(html).toContain('https://www.npmjs.com/package/vibe-testing')
    expect(html).toContain('https://github.com/AishwaryShrivastav/vibe-testing')
    expect(html).toContain('https://registry.modelcontextprotocol.io/')
  })

  it('uses the canonical domain in site discovery metadata', () => {
    const canonical = 'https://vibetesting.tfgstudio.com/'
    expect(cname).toBe('vibetesting.tfgstudio.com')
    expect(html).toContain(`<link rel="canonical" href="${canonical}">`)
    expect(html).toContain(`<meta property="og:url" content="${canonical}">`)
    expect(html).toContain('application/ld+json')
    expect(html).toContain('"@type": "SoftwareApplication"')
    expect(html).toContain('<link rel="sitemap"')
    expect(robots).toContain(`Sitemap: ${canonical}sitemap.xml`)
    expect(sitemap).toContain(`<loc>${canonical}</loc>`)
  })

  it('shows actual report and regression vocabulary', () => {
    expect(html).toContain('snapshot_diff')
    expect(html).toContain('Outcome verified')
    expect(html).toContain('Coverage gap')
    expect(html).toContain('EXAMPLE REPORT')
    expect(html).toContain('zero internal LLM calls')
  })

  it('lists every public MCP tool exactly once in the tool ledger', () => {
    for (const tool of tools) {
      const matches = html.match(new RegExp(`<code>${tool}</code>`, 'g')) ?? []
      expect(matches, tool).toHaveLength(1)
    }
  })

  it('provides accessible interaction and analytics hooks', () => {
    expect(html).toContain('class="skip-link"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('data-event="founding_qa_request"')
    expect(script).toContain("new CustomEvent('vibe:analytics'")
    expect(script).toContain('navigator.sendBeacon')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('shows a dated npm count until a verified refresh replaces it', () => {
    expect(html).toContain('data-npm-downloads>5,381</dt>')
    expect(html).toContain('data-npm-date>through 12 Oct 2026</span>')
    expect(html).toContain('src="download-count.js"')
  })
})

describe('npm download count', () => {
  const response = (data: unknown) => ({ ok: true, json: async () => data }) as Response

  it('uses the last reported day and counts from the first published version', async () => {
    const urls: string[] = []
    const fetcher = async (url: string) => {
      urls.push(url)
      return response(url.includes('last-week')
        ? { package: 'vibe-testing', end: '2026-10-12' }
        : { package: 'vibe-testing', start: '2026-04-16', end: '2026-10-12', downloads: 5381 })
    }

    expect(await getNpmDownloads(fetcher as typeof fetch)).toEqual({ count: 5381, through: '2026-10-12' })
    expect(urls).toEqual([
      'https://api.npmjs.org/downloads/point/last-week/vibe-testing',
      'https://api.npmjs.org/downloads/point/2026-04-16:2026-10-12/vibe-testing'
    ])
  })

  it('keeps the dated fallback if npm returns an invalid total', async () => {
    const count = { textContent: '5,381' }
    const date = { textContent: 'through 12 Oct 2026' }
    const root = { querySelector: (selector: string) => selector === '[data-npm-downloads]' ? count : date }
    const fetcher = async (url: string) => response(url.includes('last-week')
      ? { package: 'vibe-testing', end: '2026-10-12' }
      : { package: 'vibe-testing', start: '2026-04-16', end: '2026-10-12', downloads: '8K+' })

    await refreshNpmDownloads(root as unknown as Document, fetcher as typeof fetch)
    expect(count.textContent).toBe('5,381')
    expect(date.textContent).toBe('through 12 Oct 2026')
  })

  it('updates the count and its reporting date together', async () => {
    const count = { textContent: '5,381' }
    const date = { textContent: 'through 12 Oct 2026' }
    const root = { querySelector: (selector: string) => selector === '[data-npm-downloads]' ? count : date }
    const fetcher = async (url: string) => response(url.includes('last-week')
      ? { package: 'vibe-testing', end: '2026-10-14' }
      : { package: 'vibe-testing', start: '2026-04-16', end: '2026-10-14', downloads: 5400 })

    await refreshNpmDownloads(root as unknown as Document, fetcher as typeof fetch)
    expect(count.textContent).toBe('5,400')
    expect(date.textContent).toBe('through 14 Oct 2026')
  })
})
