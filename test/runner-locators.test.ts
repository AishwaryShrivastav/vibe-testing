import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import { resolveLocator } from '../src/engine/browser/runner.js'
import type { TestStep } from '../src/types/index.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

describe('resolveLocator picks the right element on a real page', () => {
  let fx: BrowserFixture
  let p: Page

  beforeAll(async () => {
    fx = await startBrowserFixture({
      '/form': page(`
        <h2>Email</h2>
        <form>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" placeholder="you@example.com">
          <label for="pw">Password</label>
          <input id="pw" name="password" type="password">
          <button type="button" id="toggle">Show password</button>
          <button type="submit" id="go">Create account</button>
        </form>
        <input id="hidden-search" style="display:none" placeholder="Search">
        <input id="search" placeholder="Search products">
        <button id="add">Add to cart</button>
        <a href="#" id="help">Help center</a>
      `),
    })
    p = await fx.browser.newPage()
    await p.goto(`${fx.baseUrl}/form`)
  })

  afterAll(async () => { await fx?.close() })

  async function idOf(step: TestStep): Promise<string | null> {
    const { locator } = await resolveLocator(p, step, 2000)
    return locator.getAttribute('id')
  }

  it('submit clicks hit the real submit button, not an earlier "Show password" toggle', async () => {
    expect(await idOf({ action: 'click', selector: 'button[type="submit"]', description: 'Submit form' })).toBe('go')
    expect(await idOf({ action: 'click', description: 'Submit the registration' })).toBe('go')
  })

  it('label= fills the input, not a heading with the same text', async () => {
    expect(await idOf({ action: 'fill', selector: 'label=Email', value: 'a@b.c', description: 'Fill "Email"' })).toBe('email')
  })

  it('uses the field name in the description as a label hint', async () => {
    expect(await idOf({ action: 'fill', value: 'x', description: 'Fill password with "x"' })).toBe('pw')
  })

  it('placeholder= matches partially and skips hidden elements', async () => {
    expect(await idOf({ action: 'fill', selector: 'placeholder=Search', value: 'mug', description: 'Fill search box' })).toBe('search')
  })

  it('text= clicks the element with that text', async () => {
    expect(await idOf({ action: 'click', selector: 'text=Add to cart', description: 'Click add' })).toBe('add')
  })

  it('role= selectors match by accessible name', async () => {
    expect(await idOf({ action: 'click', selector: 'role=link[name="Help center"]', description: 'Open help' })).toBe('help')
  })

  it('comma-separated CSS lists fall through to the first visible match', async () => {
    expect(await idOf({ action: 'fill', selector: '#does-not-exist, #hidden-search, #search', value: 'x', description: 'Fill query' })).toBe('search')
  })

  it('throws when a step has no selector and nothing to infer from', async () => {
    await expect(resolveLocator(p, { action: 'click', description: 'Do the thing' }, 500)).rejects.toThrow(/No valid selector/)
  })
})
