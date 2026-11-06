import path from 'node:path'
import type { VibeConfig, VibeConfigInput } from '../types/config.js'
import { readJSON } from './file.js'

export interface RunConfigOverrides {
  /** Directory holding vibe.config.json (unless configPath is given); default codebase root. */
  projectRoot: string
  configPath?: string
  /** Explicit codebase root for this run; wins over the file's codebase_path. */
  codebasePath?: string
  /** URL for this run. Falls back to the file's url. */
  url?: string
  mode?: 'fast' | 'deep'
  /** Show the browser. When omitted: the file's browser.headed (unless ignored), then defaultHeaded. */
  headed?: boolean
  defaultHeaded?: boolean
  /** MCP runs stay headless unless the caller asks, whatever the file says. */
  ignoreFileHeaded?: boolean
  scopeInclude?: string[]
}

/**
 * Build a run config from vibe.config.json plus per-run overrides, so the CLI
 * and the MCP tools honour the same settings (auth credentials,
 * never_interact, scope, browser timing). Per-run values win over the file.
 */
export async function loadRunConfig(overrides: RunConfigOverrides): Promise<Omit<VibeConfigInput, 'url'> & { url: string | undefined }> {
  const configPath = overrides.configPath ?? path.join(overrides.projectRoot, 'vibe.config.json')
  const fileConfig = await readJSON<Partial<VibeConfig>>(configPath) ?? {}

  const fileHeaded = overrides.ignoreFileHeaded ? undefined : fileConfig.browser?.headed
  const headed = overrides.headed ?? fileHeaded ?? overrides.defaultHeaded ?? true

  return {
    ...fileConfig,
    url: overrides.url ?? fileConfig.url,
    mode: overrides.mode ?? fileConfig.mode ?? 'deep',
    codebase_path: overrides.codebasePath ?? fileConfig.codebase_path ?? overrides.projectRoot,
    browser: { ...fileConfig.browser, headed },
    ...(overrides.scopeInclude?.length ? { scope: { ...fileConfig.scope, include: overrides.scopeInclude } } : {}),
  }
}
