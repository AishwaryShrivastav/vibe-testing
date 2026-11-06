import path from 'node:path'
import { readJSON, writeJSON, ensureDir } from '../../utils/file.js'
import type { PageExploration } from '../browser/explorer.js'
import type { PageFingerprint } from '../browser/fingerprint.js'

/**
 * What mode "auto"/"changed" compares against: the commit the last run tested
 * (code-aware) and each page's structure fingerprint (black-box). Written at
 * the end of every run, whatever the mode.
 */
export interface RunBaseline {
  /** HEAD when the last run finished; absent outside a repository. */
  commit?: string
  at: string
  mode: string
}

export type FingerprintStore = Record<string, PageFingerprint & { at: string }>

const BASELINE_FILE = 'baseline.json'
const FINGERPRINT_FILE = 'page-fingerprints.json'

export async function readBaseline(vibeDir: string): Promise<RunBaseline | undefined> {
  return await readJSON<RunBaseline>(path.join(vibeDir, BASELINE_FILE)) ?? undefined
}

export async function writeBaseline(vibeDir: string, baseline: RunBaseline): Promise<void> {
  await ensureDir(vibeDir)
  await writeJSON(path.join(vibeDir, BASELINE_FILE), baseline)
}

export async function readFingerprints(vibeDir: string): Promise<FingerprintStore | undefined> {
  return await readJSON<FingerprintStore>(path.join(vibeDir, FINGERPRINT_FILE)) ?? undefined
}

/** Merge this run's fingerprints into the store (pages not visited keep theirs). */
export async function saveFingerprints(vibeDir: string, explorations: PageExploration[]): Promise<void> {
  const store = await readFingerprints(vibeDir) ?? {}
  const at = new Date().toISOString()
  // Later explorations win: the signed-in pass follows the logged-out one.
  for (const exploration of explorations) {
    if (!exploration.fingerprint || exploration.redirected_to) continue
    store[exploration.route] = { ...exploration.fingerprint, at }
  }
  await ensureDir(vibeDir)
  await writeJSON(path.join(vibeDir, FINGERPRINT_FILE), store)
}
