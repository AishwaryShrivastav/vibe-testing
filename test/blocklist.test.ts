import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { ActionBlocklist, loadProjectBlocklist } from '../src/utils/blocklist.js'
import { readVibeGuidance } from '../src/utils/vibe-md.js'

describe('ActionBlocklist.isBlocked', () => {
  it('blocks nothing when there are no patterns', () => {
    const bl = new ActionBlocklist()
    expect(bl.count).toBe(0)
    expect(bl.isBlocked('#delete', 'Delete everything')).toBe(false)
  })

  it('matches plain text case-insensitively against element text', () => {
    const bl = new ActionBlocklist(['Place order'])
    expect(bl.isBlocked(undefined, 'PLACE ORDER NOW')).toBe(true)
    expect(bl.isBlocked(undefined, 'Order history')).toBe(false)
  })

  it('matches CSS selector patterns against the element selector', () => {
    const bl = new ActionBlocklist(['[data-testid="pay-button"]', '#wipe-db', '.danger-zone'])
    expect(bl.isBlocked('button[data-testid="pay-button"]', 'Pay')).toBe(true)
    expect(bl.isBlocked('#wipe-db', 'Reset')).toBe(true)
    expect(bl.isBlocked('.danger-zone > button', 'Go')).toBe(true)
  })

  it('does not treat CSS selector patterns as regexes (no over-blocking)', () => {
    // As a regex, "[data-testid=delete]" is a character class matching any
    // text containing d, a, t, e, … — which used to block every element.
    const bl = new ActionBlocklist(['[data-testid=delete]', '.danger'])
    expect(bl.isBlocked('button.save', 'Save draft')).toBe(false)
    expect(bl.isBlocked('a.nav', 'Products')).toBe(false)
    expect(bl.isBlocked('button[data-testid=delete]', 'X')).toBe(true)
  })

  it('supports regex patterns for text', () => {
    const bl = new ActionBlocklist(['^pay\\b', 'transfer|wire'])
    expect(bl.isBlocked(undefined, 'Pay now')).toBe(true)
    expect(bl.isBlocked(undefined, 'Wire funds')).toBe(true)
    expect(bl.isBlocked(undefined, 'Repay schedule')).toBe(false)
  })

  it('falls back to substring matching for invalid regex patterns without throwing', () => {
    const bl = new ActionBlocklist(['delete (all'])
    expect(() => bl.isBlocked(undefined, 'Save')).not.toThrow()
    expect(bl.isBlocked(undefined, 'Delete (all items)')).toBe(true)
    expect(bl.isBlocked(undefined, 'Save')).toBe(false)
  })

  it('merges VIBE.md "never automate" rules with config patterns', () => {
    const bl = new ActionBlocklist(['Refund'], { raw: '', never_automate: ['Send invoice'] })
    expect(bl.count).toBe(2)
    expect(bl.isBlocked(undefined, 'Refund order')).toBe(true)
    expect(bl.isBlocked(undefined, 'Send invoice')).toBe(true)
  })

  it('handles missing selector and text', () => {
    const bl = new ActionBlocklist(['delete'])
    expect(bl.isBlocked(undefined, undefined)).toBe(false)
  })
})

describe('loadProjectBlocklist (used by the MCP server)', () => {
  async function project(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-blocklist-'))
    for (const [f, c] of Object.entries(files)) await fs.writeFile(path.join(dir, f), c)
    return dir
  }

  it('loads never_interact from vibe.config.json AND never-automate rules from VIBE.md', async () => {
    const dir = await project({
      'vibe.config.json': JSON.stringify({ url: 'http://localhost:3000', never_interact: ['Delete workspace'] }),
      'VIBE.md': '## Never Automate\n- Send payment\n',
    })
    try {
      const bl = await loadProjectBlocklist(dir, await readVibeGuidance(dir))
      expect(bl.isBlocked(undefined, 'Delete workspace')).toBe(true)
      expect(bl.isBlocked(undefined, 'Send payment')).toBe(true)
      expect(bl.isBlocked(undefined, 'Save')).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('works without a vibe.config.json', async () => {
    const dir = await project({})
    try {
      const bl = await loadProjectBlocklist(dir, null)
      expect(bl.count).toBe(0)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores malformed never_interact entries', async () => {
    const dir = await project({
      'vibe.config.json': JSON.stringify({ never_interact: ['Refund', 42, '', null] }),
    })
    try {
      const bl = await loadProjectBlocklist(dir, null)
      expect(bl.count).toBe(1)
      expect(bl.isBlocked(undefined, 'Refund')).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
