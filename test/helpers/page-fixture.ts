import fs from 'fs/promises'
import type { BrowserContext, Page } from 'playwright'

// Playwright boundary double for sandboxed runs. Browser integration tests use
// real pages; these tests control failures that must propagate through runners.
export const fixture = {
  body: 'Welcome to the application. This page contains enough content for the smoke verifier.',
  elements: new Map<string, { text: string; visible: boolean }>(),
  uploaded: [] as string[],
  closed: 0,
}
export function makeContext(): BrowserContext {
  return {
    setDefaultTimeout() {},
    close: async () => {},
    newPage: async () => {
      let url = 'about:blank'
      function locator(selector: string): any {
        const entries = () => selector === 'body'
          ? [{ text: fixture.body, visible: true }]
          : selector.includes('[role="alert"]')
            ? [...fixture.elements.entries()].filter(([key]) => key.startsWith('alert')).map(([, el]) => el).filter(el => !selector.includes(':visible') || el.visible)
            : fixture.elements.has(selector) ? [fixture.elements.get(selector)!] : []
        return {
          first: () => locator(selector),
          nth: (i: number) => {
            const el = entries()[i]
            return { isVisible: async () => el?.visible ?? false, innerText: async () => el?.text ?? '', textContent: async () => el?.text ?? '' }
          },
          count: async () => entries().length,
          isVisible: async () => entries()[0]?.visible ?? false,
          waitFor: async () => { if (!entries()[0]?.visible) throw new Error(`Timeout waiting for ${selector} to be visible`) },
          innerText: async () => entries()[0]?.text ?? '',
          textContent: async () => entries()[0]?.text ?? '',
          setInputFiles: async (file: string) => {
            if (!entries().length) throw new Error(`Missing file input: ${selector}`)
            if (selector === '#not-file') throw new Error('Node is not an HTMLInputElement')
            await fs.access(file)
            fixture.uploaded.push(file)
          },
        }
      }
      return {
        url: () => url,
        goto: async (next: string) => { url = next },
        locator,
        getByLabel: (label: string) => locator(`label=${label}`),
        getByText: (text: string) => locator(`text=${text}`),
        getByPlaceholder: (text: string) => locator(`placeholder=${text}`),
        screenshot: async () => Buffer.from(''),
        waitForTimeout: async () => {},
        waitForURL: async (expected: string | ((url: URL) => boolean)) => {
          if (typeof expected === 'string' ? url !== expected : !expected(new URL(url))) throw new Error(`URL mismatch: ${url}`)
        },
        close: async () => { fixture.closed++ },
      } as unknown as Page
    },
  } as unknown as BrowserContext
}
