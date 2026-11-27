import type { BrowserContext } from 'playwright'
import path from 'path'
import fs from 'fs/promises'
import type { AuthConfig } from '../../types/config.js'
import { interpolateEnv } from '../../utils/env.js'

/** True when the config supplies a ready session (storage state file or cookies) instead of a login form. */
export function hasStoredSession(auth: AuthConfig | undefined): boolean {
  return !!(auth?.storage_state || auth?.cookies?.length)
}

/** Absolute path of auth.storage_state, resolved from the project root; throws when the file is missing. */
export async function storageStatePath(auth: AuthConfig | undefined, projectRoot: string): Promise<string | undefined> {
  if (!auth?.storage_state) return undefined
  const file = path.resolve(projectRoot, interpolateEnv(auth.storage_state))
  try {
    await fs.access(file)
  } catch {
    throw new Error(`auth.storage_state file not found: ${file}`)
  }
  return file
}

/** Adds auth.cookies to a context (for the run's URL unless a cookie names its own domain or url). */
export async function addConfiguredCookies(context: BrowserContext, auth: AuthConfig | undefined, baseUrl: string): Promise<number> {
  const cookies = auth?.cookies ?? []
  if (cookies.length === 0) return 0
  const origin = /^https?:/i.test(baseUrl) ? new URL(baseUrl).origin : undefined
  await context.addCookies(cookies.map(cookie => {
    const value = interpolateEnv(cookie.value)
    const base = { name: cookie.name, value, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite }
    if (cookie.domain) return { ...base, domain: cookie.domain, path: cookie.path ?? '/' }
    const url = cookie.url ?? origin
    if (!url) throw new Error(`cookie ${cookie.name} needs a domain or url when the run's URL is not http(s)`)
    return { ...base, url }
  }))
  return cookies.length
}
