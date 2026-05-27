import { Route, TestResult, Framework } from '../../types/index.js'
import { readJSON, writeJSON, ensureDir } from '../../utils/file.js'
import path from 'path'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RouteManifest {
  captured_at: string
  framework: Framework
  routes: Array<{
    path: string
    type: 'page' | 'api'
    method?: string
    requires_auth: boolean
  }>
}

export interface RouteManifestDiff {
  new_routes: string[]
  removed_routes: string[]
  total_new: number
  total_removed: number
}

export interface RunSnapshot {
  run_id: string
  timestamp: string
  routes: Record<string, 'pass' | 'fail' | 'error' | 'skip'>
  total: number
  passed: number
  failed: number
  errors: number
}

export interface SnapshotDiff {
  previous_run_id: string
  current_run_id: string
  newly_passing: string[]   // fail→pass
  newly_failing: string[]   // pass→fail
  still_failing: string[]   // fail→fail
  new_routes: string[]      // not in previous
  removed_routes: string[]  // not in current
}

// ─── Route Manifest ──────────────────────────────────────────────────────────

const MANIFEST_FILE = 'route-manifest.json'
const SNAPSHOT_FILE = 'run-snapshot.json'

export async function saveRouteManifest(
  vibeDir: string,
  routes: Route[],
  framework: Framework
): Promise<RouteManifestDiff | null> {
  const manifestPath = path.join(vibeDir, MANIFEST_FILE)
  const previous = await readJSON<RouteManifest>(manifestPath)

  const current: RouteManifest = {
    captured_at: new Date().toISOString(),
    framework,
    routes: routes.map(r => ({
      path: r.path,
      type: r.type,
      method: r.method,
      requires_auth: r.requires_auth,
    })),
  }

  await ensureDir(vibeDir)
  await writeJSON(manifestPath, current)

  if (!previous) return null

  // Diff
  const prevPaths = new Set(previous.routes.map(r => r.path))
  const currPaths = new Set(current.routes.map(r => r.path))

  const new_routes = [...currPaths].filter(p => !prevPaths.has(p))
  const removed_routes = [...prevPaths].filter(p => !currPaths.has(p))

  if (new_routes.length === 0 && removed_routes.length === 0) return null

  return {
    new_routes,
    removed_routes,
    total_new: new_routes.length,
    total_removed: removed_routes.length,
  }
}

// ─── Run Snapshot ────────────────────────────────────────────────────────────

export async function saveRunSnapshot(
  vibeDir: string,
  results: TestResult[]
): Promise<SnapshotDiff | null> {
  const snapshotPath = path.join(vibeDir, SNAPSHOT_FILE)
  const previous = await readJSON<RunSnapshot>(snapshotPath)

  const routeStatuses: Record<string, 'pass' | 'fail' | 'error' | 'skip'> = {}
  for (const r of results) {
    const route = r.scenario.route
    // Keep the worst status per route (error > fail > pass)
    const existing = routeStatuses[route]
    if (!existing || severity(r.status) > severity(existing)) {
      routeStatuses[route] = r.status === 'skip' ? 'skip' : r.status
    }
  }

  const current: RunSnapshot = {
    run_id: `run-${Date.now()}`,
    timestamp: new Date().toISOString(),
    routes: routeStatuses,
    total: results.length,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
    errors: results.filter(r => r.status === 'error').length,
  }

  await ensureDir(vibeDir)
  await writeJSON(snapshotPath, current)

  if (!previous) return null

  // Diff
  const prevRoutes = previous.routes
  const currRoutes = current.routes

  const allRoutes = new Set([...Object.keys(prevRoutes), ...Object.keys(currRoutes)])
  const newly_passing: string[] = []
  const newly_failing: string[] = []
  const still_failing: string[] = []
  const new_routes: string[] = []
  const removed_routes: string[] = []

  for (const route of allRoutes) {
    const prev = prevRoutes[route]
    const curr = currRoutes[route]

    if (!prev && curr) {
      new_routes.push(route)
    } else if (prev && !curr) {
      removed_routes.push(route)
    } else if (prev && curr) {
      if (isPassing(prev) && !isPassing(curr)) newly_failing.push(route)
      else if (!isPassing(prev) && isPassing(curr)) newly_passing.push(route)
      else if (!isPassing(prev) && !isPassing(curr)) still_failing.push(route)
    }
  }

  if (newly_passing.length === 0 && newly_failing.length === 0 &&
      new_routes.length === 0 && removed_routes.length === 0) return null

  return {
    previous_run_id: previous.run_id,
    current_run_id: current.run_id,
    newly_passing,
    newly_failing,
    still_failing,
    new_routes,
    removed_routes,
  }
}

function severity(status: string): number {
  if (status === 'error') return 3
  if (status === 'fail') return 2
  if (status === 'pass') return 1
  return 0
}

function isPassing(status: string): boolean {
  return status === 'pass'
}
