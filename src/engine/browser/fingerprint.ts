import { createHash } from 'node:crypto'
import type { Page } from 'playwright'

/**
 * A page's structure, stable across data changes: its controls (non-link
 * elements), the same-origin pages it links to, its forms' fields, its
 * headings and the API endpoints it calls. Numbers and ids are normalised
 * ("Messages 3" → "Messages #", /rooms/42 → /rooms/:id) and body text is left
 * out, so new records or counts don't look like a code change.
 */
export interface PageFingerprint {
  hash: string
  controls: string[]
  links: string[]
  forms: string[]
  headings: string[]
  apis: string[]
}

interface ElementLike {
  type: string
  text: string
  inputType?: string
  placeholder?: string
  href?: string
}

interface ApiLike {
  method: string
  url: string
}

export function normaliseLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\d+/g, '#').slice(0, 60)
}

/** /rooms/42 → /rooms/:id, /reservation/7?checkin=… → /reservation/:id (ids and long hex/uuid segments). */
export function normalisePath(pathname: string): string {
  return pathname
    .split('/')
    .map(segment => /^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{32,36}$/i.test(segment) ? ':id' : segment)
    .join('/') || '/'
}

/** The page's controls (no links): what a user can do there, as a sorted list. */
export function controlList(elements: ElementLike[]): string[] {
  const items = elements
    .filter(element => element.type !== 'link')
    .map(element => `${element.type}:${element.inputType ?? ''}:${normaliseLabel(element.placeholder || element.text)}`)
  return [...new Set(items)].sort()
}

/** Same controls (and at least one): the pages are built from one template. */
export function controlSignature(elements: ElementLike[]): string {
  return controlList(elements).join('|')
}

export async function pageFingerprint(page: Page, elements: ElementLike[], apiCalls: ApiLike[], origin: string): Promise<PageFingerprint> {
  const links = [...new Set(elements
    .filter(element => element.type === 'link' && element.href)
    .map(element => {
      try {
        const url = new URL(element.href!)
        return url.origin === origin ? normalisePath(url.pathname) : undefined
      } catch { return undefined }
    })
    .filter((link): link is string => !!link))].sort()

  const structure = await page.evaluate(`(() => ({
    forms: Array.from(document.querySelectorAll('form')).map(form =>
      Array.from(form.querySelectorAll('input, select, textarea'))
        .filter(field => field.type !== 'hidden')
        .map(field => (field.name || field.id || field.type || field.tagName).toLowerCase())
        .sort().join(',')),
    headings: Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(heading => heading.textContent || '')
      .filter(text => text.trim()).slice(0, 12),
  }))()`).catch(() => ({ forms: [], headings: [] })) as { forms: string[]; headings: string[] }

  const apis = [...new Set(apiCalls.map(call => {
    try {
      const url = new URL(call.url)
      return url.origin === origin ? `${call.method} ${normalisePath(url.pathname)}` : undefined
    } catch { return undefined }
  }).filter((api): api is string => !!api))].sort()

  const fingerprint = {
    controls: controlList(elements),
    links,
    forms: [...structure.forms].sort(),
    headings: [...new Set(structure.headings.map(normaliseLabel))].sort(),
    apis,
  }
  return { hash: hashOf(fingerprint), ...fingerprint }
}

export function hashOf(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

/** What changed between two fingerprints of the same page, or undefined when nothing did. */
export function describeFingerprintChange(previous: PageFingerprint, current: PageFingerprint): string | undefined {
  if (previous.hash === current.hash) return undefined
  const parts: string[] = []
  for (const key of ['controls', 'links', 'forms', 'headings', 'apis'] as const) {
    const before = new Set(previous[key] ?? [])
    const after = new Set(current[key] ?? [])
    const added = [...after].filter(item => !before.has(item)).length
    const removed = [...before].filter(item => !after.has(item)).length
    if (added || removed) parts.push(`${key === 'apis' ? 'API calls' : key} ${added ? `+${added}` : ''}${added && removed ? '/' : ''}${removed ? `-${removed}` : ''}`)
  }
  return parts.length > 0 ? parts.join(', ') : 'structure changed'
}
