import path from 'path'
import type { VibeConfig, VibeGuidance } from '../types/config.js'
import { readJSON } from './file.js'

/**
 * Build the blocklist for a project from BOTH sources the docs promise:
 * `never_interact` in vibe.config.json and the "Never Automate" rules in VIBE.md.
 */
export async function loadProjectBlocklist(
  projectRoot: string,
  guidance?: VibeGuidance | null
): Promise<ActionBlocklist> {
  const fileConfig = await readJSON<Partial<VibeConfig>>(path.join(projectRoot, 'vibe.config.json'))
  const patterns = Array.isArray(fileConfig?.never_interact)
    ? fileConfig!.never_interact.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : []
  return new ActionBlocklist(patterns, guidance)
}

export class ActionBlocklist {
  private patterns: string[]

  constructor(configPatterns: string[] = [], guidance?: VibeGuidance | null) {
    this.patterns = [...configPatterns]
    if (guidance?.never_automate) {
      this.patterns.push(...guidance.never_automate)
    }
  }

  isBlocked(selector: string | undefined, text: string | undefined): boolean {
    if (this.patterns.length === 0) return false
    const targets = [selector ?? '', text ?? ''].map(t => t.toLowerCase())

    for (const pattern of this.patterns) {
      const lower = pattern.toLowerCase()
      for (const target of targets) {
        if (!target) continue
        if (target.includes(lower)) return true
        // CSS selector patterns ([attr], .class, #id) match by substring only —
        // as a regex "[data-testid=delete]" would be a character class that
        // matches almost any text and block every element.
        if (lower.startsWith('[') || lower.startsWith('.') || lower.startsWith('#')) continue
        try {
          if (new RegExp(lower, 'i').test(target)) return true
        } catch { /* not a valid regex, just do string match */ }
      }
    }
    return false
  }

  get count(): number {
    return this.patterns.length
  }
}
