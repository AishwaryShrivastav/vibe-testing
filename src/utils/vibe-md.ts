import { VibeGuidance } from '../types/config.js'
import fs from 'fs/promises'
import path from 'path'

export async function readVibeGuidance(codebasePath: string): Promise<VibeGuidance | null> {
  const candidates = ['VIBE.md', 'vibe.md', '.vibe/VIBE.md']
  let raw = ''

  for (const candidate of candidates) {
    try {
      raw = await fs.readFile(path.join(codebasePath, candidate), 'utf-8')
      break
    } catch { /* try next */ }
  }

  if (!raw.trim()) return null

  return parseVibeGuidance(raw)
}

function parseVibeGuidance(raw: string): VibeGuidance {
  const guidance: VibeGuidance = { raw }
  const lower = raw.toLowerCase()

  const extractList = (heading: string): string[] => {
    const regex = new RegExp(`#+\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n#+\\s|$)`, 'i')
    const match = raw.match(regex)
    if (!match) return []
    return match[1]
      .split('\n')
      .map(l => l.replace(/^[\s-*]+/, '').trim())
      .filter(l => l.length > 0 && !l.startsWith('#'))
  }

  const extractValue = (heading: string): string | undefined => {
    const items = extractList(heading)
    return items.length > 0 ? items[0] : undefined
  }

  guidance.test_framework = extractValue('test framework') ?? extractValue('testing framework')
  guidance.auth_strategy = extractValue('auth') ?? extractValue('authentication')
  guidance.login_url = extractValue('login url') ?? extractValue('login page')
  guidance.known_flaky = extractList('flaky') ?? extractList('known flaky')
  guidance.never_automate = extractList('never automate') ?? extractList('never interact') ?? extractList('blocklist')
  guidance.env_vars = extractList('environment') ?? extractList('env var')
  guidance.notes = extractList('notes') ?? extractList('important')

  if (!guidance.login_url) {
    const loginMatch = raw.match(/login[_ ]?(?:url|page|route)[:\s]+[`"]?([^\s`"]+)/i)
    if (loginMatch) guidance.login_url = loginMatch[1]
  }

  return guidance
}
