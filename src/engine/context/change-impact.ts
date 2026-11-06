import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Route } from '../../types/index.js'
import { deeperOf, type DepthDecision } from '../browser/depth.js'



/**
 * Which pages a code change touches, for mode "auto" / "changed".
 *
 * Changed files come from version control: everything that differs from the
 * baseline commit (committed since, staged, unstaged) plus untracked files.
 * Each changed file is followed backwards through the import graph to the
 * page files that use it:
 *   - a page's own file, or a component it imports  → thorough
 *   - a file most pages use (layout, context, API client, shared routes file)
 *     → every page at least standard
 *   - a style sheet                                  → light for the pages using it
 *   - a server handler / endpoint                    → the pages that call it
 */

export interface ChangedFiles {
  ok: boolean
  /** The ref compared against. */
  since?: string
  /** Absolute paths of changed files. */
  files: string[]
  /** Repository root. */
  root?: string
  /** Why detection could not run (not a repository, unknown ref…). */
  note?: string
}

async function vcs(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024 })
  return stdout
}

/** The repository's current commit, or undefined outside a repository. */
export async function headCommit(cwd: string): Promise<string | undefined> {
  try { return (await vcs(cwd, ['rev-parse', 'HEAD'])).trim() || undefined } catch { return undefined }
}

export async function changedFilesSince(cwd: string, since: string | undefined): Promise<ChangedFiles> {
  let root: string
  try {
    root = (await vcs(cwd, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    return { ok: false, files: [], note: 'not a version-controlled project (no git repository)' }
  }
  if (!since) return { ok: false, files: [], root, note: 'no baseline yet (first run)' }
  try {
    await vcs(root, ['rev-parse', '--verify', `${since}^{commit}`])
  } catch {
    return { ok: false, files: [], root, since, note: `unknown ref "${since}"` }
  }
  const diff = await vcs(root, ['diff', '--name-only', since, '--']).catch(() => '')
  const untracked = await vcs(root, ['ls-files', '--others', '--exclude-standard']).catch(() => '')
  const files = [...new Set([...diff.split('\n'), ...untracked.split('\n')].map(line => line.trim()).filter(Boolean))]
    // vibe-test's own state (.vibe/ and copies of it) is not a code change.
    .filter(file => !/(^|\/)\.vibe[^/]*\//.test(file) && !/(^|\/)node_modules\//.test(file))
    .map(file => path.join(root, file))
  return { ok: true, files, root, since }
}

// ─── Import graph ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', '.vibe', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'target', '.turbo', '.cache', 'vendor'])
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/
const STYLE_FILE = /\.(?:css|scss|sass|less|styl|pcss)$/
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.css', '.scss']
const IMPORT = /(?:\bimport\s+(?:[^'"`;]*?\s+from\s+)?|\bexport\s+[^'"`;]*?\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g
const MAX_FILES = 6000

async function listCodeFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    if (out.length >= MAX_FILES) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full)
      } else if (CODE_FILE.test(entry.name) && !/\.d\.[mc]?ts$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out
}

async function resolveImport(spec: string, fromFile: string, root: string, exists: (file: string) => Promise<boolean>): Promise<string | undefined> {
  let bases: string[]
  if (spec.startsWith('.')) bases = [path.resolve(path.dirname(fromFile), spec)]
  else if (/^[@~#]\//.test(spec)) bases = [path.join(root, 'src', spec.slice(2)), path.join(root, spec.slice(2))]
  else if (spec.startsWith('/')) bases = [path.join(root, spec)]
  else return undefined   // a package
  for (const base of bases) {
    for (const ext of RESOLVE_EXTENSIONS) {
      if (await exists(base + ext)) return base + ext
    }
    for (const ext of RESOLVE_EXTENSIONS.slice(1)) {
      if (await exists(path.join(base, `index${ext}`))) return path.join(base, `index${ext}`)
    }
  }
  return undefined
}

/** file → the files that import it. */
export async function buildReverseImports(root: string): Promise<Map<string, Set<string>>> {
  const files = await listCodeFiles(root)
  const known = new Set(files)
  const cache = new Map<string, boolean>()
  const exists = async (file: string) => {
    if (known.has(file)) return true
    if (cache.has(file)) return cache.get(file)!
    const found = await fs.stat(file).then(stat => stat.isFile()).catch(() => false)
    cache.set(file, found)
    return found
  }
  const importers = new Map<string, Set<string>>()
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8').catch(() => '')
    for (const match of content.matchAll(IMPORT)) {
      const target = await resolveImport(match[1], file, root, exists)
      if (!target) continue
      const set = importers.get(target) ?? new Set<string>()
      set.add(file)
      importers.set(target, set)
    }
  }
  return importers
}

/** The changed file plus every file that imports it, directly or through others (bounded). */
function dependents(file: string, importers: Map<string, Set<string>>, maxDepth = 8): Set<string> {
  const seen = new Set([file])
  let frontier = [file]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const current of frontier) {
      for (const importer of importers.get(current) ?? []) {
        if (!seen.has(importer)) { seen.add(importer); next.push(importer) }
      }
    }
    frontier = next
  }
  return seen
}

// ─── Changes → pages ─────────────────────────────────────────────────────────

/** Named app-wide files: layouts, app shells, routers, stores. */
const GLOBAL_FILE = /(?:^|\/)(?:_app|_document|layout|App|app|main|root|router|routes|store)\.(?:[cm]?[jt]sx?|vue|svelte)$/

export interface ChangeImpact {
  /** Depth per page route path (only pages the change touches). */
  pages: Map<string, DepthDecision>
  /** Changed files (relative to the root) that no page uses. */
  unused: string[]
  /** A shared file changed: every page should be at least standard. */
  shared?: string
}

export function routePatternRegex(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map(segment => {
      if (/^\[\[?\.\.\.[^\]]+\]\]?$/.test(segment) || segment === '*') return '.*'
      if (/^\[[^\]]+\]$/.test(segment) || /^:[A-Za-z_$][\w$]*\??$/.test(segment)) return '[^/]+'
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return new RegExp(`^${source}$`)
}

export async function impactOfChanges(
  routes: Route[],
  changedFiles: string[],
  root: string,
  /** Per page route, the API endpoints it called last run ("POST /api/room/:id"). */
  pageApis: Record<string, string[]> = {},
  importers?: Map<string, Set<string>>,
): Promise<ChangeImpact> {
  const graph = importers ?? await buildReverseImports(root)
  const pages = routes.filter(route => route.type === 'page' && route.file_path)
  const apis = routes.filter(route => route.type === 'api')
  const result = new Map<string, DepthDecision>()
  const unused: string[] = []
  let shared: string | undefined
  const give = (route: string, decision: DepthDecision) => result.set(route, deeperOf(result.get(route) ?? decision, decision))

  for (const file of changedFiles) {
    const relative = path.relative(root, file)
    const reached = dependents(file, graph)
    const usesFile = (route: Route) =>
      (route.file_path && reached.has(path.resolve(route.file_path))) ||
      (route.handler_file && reached.has(path.resolve(route.handler_file)))
    let hit = pages.filter(usesFile)

    // Templates and other non-code files (views/contributions.html): match by name.
    if (hit.length === 0 && !CODE_FILE.test(file) && !STYLE_FILE.test(file)) {
      const stem = path.basename(file).replace(/\.[^.]+$/, '').toLowerCase()
      if (stem.length >= 3) hit = pages.filter(route => route.path.toLowerCase().split('/').includes(stem))
    }

    // Server endpoints the change touches → the pages that call them.
    const endpoints = apis.filter(usesFile)
    const callers = new Set<string>()
    for (const endpoint of endpoints) {
      const pattern = routePatternRegex(endpoint.path)
      for (const [page, calls] of Object.entries(pageApis)) {
        if (calls.some(call => {
          const [method, callPath] = call.split(' ')
          return (!endpoint.method || endpoint.method === method) && (pattern.test(callPath) || pattern.test(callPath.replace(/:id/g, '1')))
        })) callers.add(page)
      }
    }

    if (hit.length === 0 && callers.size === 0) {
      unused.push(relative)
      continue
    }

    if (STYLE_FILE.test(file)) {
      for (const route of hit) give(route.path, { depth: 'light', reason: `style change ${relative}` })
      continue
    }

    const isShared = GLOBAL_FILE.test(file) || (pages.length >= 3 && hit.length >= Math.max(3, Math.ceil(pages.length / 2)))
    if (isShared) {
      shared = shared ?? relative
      for (const route of pages) give(route.path, { depth: 'standard', reason: `shared file changed ${relative}` })
    } else {
      for (const route of hit) {
        const own = (route.file_path && path.resolve(route.file_path) === path.resolve(file)) ||
          (route.handler_file && path.resolve(route.handler_file) === path.resolve(file))
        give(route.path, { depth: 'thorough', reason: own ? `changed ${relative}` : `uses changed ${relative}` })
      }
    }
    for (const page of callers) give(page, { depth: 'thorough', reason: `calls changed endpoint (${relative})` })
  }

  return { pages: result, unused, ...(shared ? { shared } : {}) }
}
