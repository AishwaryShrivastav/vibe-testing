import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { explorePage, isAuthNavigation, isDestructiveAction } from '../src/engine/browser/explorer.js'
import { ActionBlocklist } from '../src/utils/blocklist.js'
import { page, startBrowserFixture, type BrowserFixture } from './helpers/browser-server.js'

describe('isDestructiveAction (explorer must never click these)', () => {
  it.each([
    'Delete', 'Delete account', 'Remove item', 'Destroy project', 'Logout', 'Log out', 'log-out',
    'Sign out', 'Signout', 'sign_out', 'Cancel account', 'Deactivate', 'Revoke key',
    'Terminate instance', 'Unsubscribe', 'DELETE ALL',
  ])('blocks "%s"', text => {
    expect(isDestructiveAction(text)).toBe(true)
  })

  it.each([
    'Save', 'Add to cart', 'Refresh', 'Removal policy', 'Deleted items', 'Login', 'Sign in',
    'Catalog', 'Signal settings', '', undefined,
  ])('allows "%s"', text => {
    expect(isDestructiveAction(text)).toBe(false)
  })
})

describe('isAuthNavigation (explorer skips auth links)', () => {
  it.each([
    ['Login', undefined], ['Log in', undefined], ['Sign in', undefined], ['Sign up', undefined],
    ['Register', undefined], ['Log out', undefined], ['Account', '/logout'], ['Go', '/auth/sign-in'],
    ['Join', '/signup'],
  ])('skips text=%s href=%s', (text, href) => {
    expect(isAuthNavigation(text, href)).toBe(true)
  })

  it.each([
    ['Products', '/products'], ['Blog', '/blog/index'], ['Catalog', '/catalog'], ['Design', '/design'],
  ])('follows text=%s href=%s', (text, href) => {
    expect(isAuthNavigation(text, href)).toBe(false)
  })
})

describe('explorePage safety on a real page', () => {
  let fx: BrowserFixture
  let shots: string

  beforeAll(async () => {
    const button = (label: string, hit: string) =>
      `<button type="button" onclick="fetch('/hit/${hit}'); document.getElementById('out').textContent='${hit}'">${label}</button>`
    fx = await startBrowserFixture({
      '/settings': page(`
        <h1>Settings</h1>
        <p id="out">Nothing clicked yet. This page has enough text to be explored.</p>
        ${button('Refresh data', 'refresh')}
        ${button('Delete account', 'delete')}
        ${button('Log out', 'logout')}
        ${button('Archive project', 'archive')}
      `),
    })
    shots = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-explorer-'))
  })

  afterAll(async () => {
    await fx?.close()
    await fs.rm(shots, { recursive: true, force: true })
  })

  it('clicks safe buttons but never destructive or blocklisted ones', async () => {
    const context = await fx.browser.newContext()
    try {
      const exploration = await explorePage(context, '/settings', fx.baseUrl, shots, new ActionBlocklist(['Archive']))

      // Proof the explorer really interacted with the page…
      expect(fx.hits).toContain('/hit/refresh')
      // …but never fired a destructive or never_interact action.
      expect(fx.hits).not.toContain('/hit/delete')
      expect(fx.hits).not.toContain('/hit/logout')
      expect(fx.hits).not.toContain('/hit/archive')

      const byText = (t: string) => exploration.interactions.find(i => i.element.includes(t))
      expect(byText('Delete account')?.result).toBe('skipped')
      expect(byText('Log out')?.result).toBe('skipped')
      expect(byText('Archive project')).toBeUndefined() // filtered out before any interaction
    } finally {
      await context.close()
    }
  }, 60_000)
})
