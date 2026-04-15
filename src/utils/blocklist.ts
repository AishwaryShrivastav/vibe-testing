import type { VibeGuidance } from '../types/config.js'

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
        if (lower.startsWith('[') || lower.startsWith('.') || lower.startsWith('#')) {
          if (target.includes(lower)) return true
        }
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
