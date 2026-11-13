import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  ServerCandidateAttempt,
  ServerCandidateSource,
  ServerDetection,
  ServerDiscoveryDiagnostic,
  ServerEvidence,
} from '../../types/index.js'
import { readJSON } from '../../utils/file.js'

export const COMMON_DEV_PORTS = [3000, 3001, 4173, 4321, 5173, 5174, 8080] as const
const MAX_ACTIVE_PORTS = 32
/** Same-origin redirects followed while probing, e.g. `/` → `/login` on apps that require sign-in. */
const MAX_SAME_ORIGIN_REDIRECTS = 5

type PackageManifest = {
  scripts?: Record<string, string>
}

type Candidate = {
  rawUrl: string
  evidence: ServerEvidence
}

type NormalizedCandidate = {
  baseUrl: string
  displayUrl: string
  probeUrl: string
}

export interface ServerDetectorInput {
  codebasePath: string
  /** URL the user supplied for this run. Authoritative: never replaced by another server. */
  explicitUrl?: string
  /** URL from the project's vibe.config.json. Authoritative when no explicit URL is given. */
  configuredUrl?: string
  /** Best guess from project files or framework defaults. Only a discovery hint. */
  inferredUrl?: string
}

export type ListenerCommandRunner = (command: string, args: readonly string[]) => Promise<string>

export interface ActivePortDiscovery {
  ports: number[]
  available: boolean
  detail: string
}

export interface ActivePortDiscoveryDependencies {
  platform?: NodeJS.Platform
  runCommand?: ListenerCommandRunner
}

export interface ServerDetectorDependencies {
  fetch?: typeof globalThis.fetch
  listActiveLoopbackPorts?: () => Promise<number[]>
  platform?: NodeJS.Platform
  runListenerCommand?: ListenerCommandRunner
  commonPorts?: readonly number[]
  timeoutMs?: number
}

export async function detectProjectPortHints(codebasePath: string): Promise<ServerEvidence[]> {
  const evidence: ServerEvidence[] = []

  for (const envFile of ['.env.local', '.env.development', '.env']) {
    const contents = await readText(path.join(codebasePath, envFile))
    const port = contents?.match(/^PORT\s*=\s*(\d+)/m)?.[1]
    if (port) {
      evidence.push({
        source: 'config',
        value: port,
        description: `${envFile} sets PORT=${port}`,
      })
    }
  }

  for (const configFile of [
    'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs',
    'next.config.ts', 'next.config.js', 'nuxt.config.ts', 'nuxt.config.js',
  ]) {
    const contents = await readText(path.join(codebasePath, configFile))
    const port = contents?.match(/\bport\s*:\s*(\d+)/)?.[1]
    if (port) {
      evidence.push({
        source: 'config',
        value: port,
        description: `${configFile} configures port ${port}`,
      })
    }
  }

  const manifest = await readJSON<PackageManifest>(path.join(codebasePath, 'package.json'))
  for (const [name, script] of Object.entries(manifest?.scripts ?? {})) {
    const port = script.match(/(?:--port(?:=|\s+)|(?:^|\s)-p\s+)(\d+)/)?.[1]
    if (port) {
      evidence.push({
        source: 'script',
        value: port,
        description: `package script "${name}" specifies port ${port}`,
      })
    }
  }

  return dedupeEvidence(evidence)
}

export async function detectLiveServer(
  input: ServerDetectorInput,
  dependencies: ServerDetectorDependencies = {},
): Promise<ServerDetection> {
  const fetchPage = dependencies.fetch ?? globalThis.fetch
  const commonPorts = dependencies.commonPorts ?? COMMON_DEV_PORTS
  const timeoutMs = dependencies.timeoutMs ?? 750
  const attemptedCandidates: ServerCandidateAttempt[] = []
  const diagnostics: ServerDiscoveryDiagnostic[] = []
  const candidates: Candidate[] = []

  // A URL the user chose is the app under test. If it is unusable, report why
  // instead of silently testing whatever else happens to be listening locally.
  const userCandidate = input.explicitUrl
    ? urlCandidate(input.explicitUrl, 'explicit-url', 'URL supplied for this run')
    : input.configuredUrl
      ? urlCandidate(input.configuredUrl, 'configured-url', 'URL found in project configuration')
      : undefined
  if (userCandidate) {
    const probe = await probeCandidate(userCandidate, fetchPage, timeoutMs)
    attemptedCandidates.push(probe.attempt)
    if (probe.baseUrl) {
      return { url: probe.baseUrl, evidence: [userCandidate.evidence], attemptedCandidates, diagnostics }
    }
    const origin = userCandidate.evidence.source === 'explicit-url'
      ? 'The URL supplied for this run'
      : 'The URL in vibe.config.json'
    return {
      evidence: [],
      attemptedCandidates,
      diagnostics,
      failure: `${origin} (${probe.attempt.url}) could not be used: ${probe.attempt.detail ?? probe.attempt.outcome}. ` +
        'vibe-test does not substitute another local server; start the app at that URL or supply the correct one.',
    }
  }

  if (input.inferredUrl) {
    candidates.push(urlCandidate(input.inferredUrl, 'inferred-url', 'URL inferred from project files or framework defaults'))
  }

  for (const hint of await detectProjectPortHints(input.codebasePath)) {
    candidates.push(portCandidate(Number(hint.value), hint))
  }

  const activeDiscovery = dependencies.listActiveLoopbackPorts
    ? {
        ports: await dependencies.listActiveLoopbackPorts(),
        available: true,
        detail: 'Active loopback ports supplied by caller',
      }
    : await discoverActiveLoopbackPorts({
        platform: dependencies.platform,
        runCommand: dependencies.runListenerCommand,
      })
  diagnostics.push({
    stage: 'active-port-discovery',
    status: activeDiscovery.available ? 'available' : 'unavailable',
    detail: activeDiscovery.detail,
  })

  for (const port of uniqueValidPorts(activeDiscovery.ports).slice(0, MAX_ACTIVE_PORTS)) {
    candidates.push(portCandidate(port, {
      source: 'active-port',
      value: String(port),
      description: `local process is listening on port ${port}`,
    }))
  }

  for (const port of uniqueValidPorts(commonPorts)) {
    candidates.push(portCandidate(port, {
      source: 'common-port',
      value: String(port),
      description: `port ${port} is a bounded common development port`,
    }))
  }

  for (const candidate of dedupeCandidates(candidates)) {
    const probe = await probeCandidate(candidate, fetchPage, timeoutMs)
    attemptedCandidates.push(probe.attempt)
    if (probe.baseUrl) {
      return {
        url: probe.baseUrl,
        evidence: [candidate.evidence],
        attemptedCandidates,
        diagnostics,
      }
    }
  }

  return { evidence: [], attemptedCandidates, diagnostics }
}

function isUserSupplied(source: ServerCandidateSource): boolean {
  return source === 'explicit-url' || source === 'configured-url'
}

/**
 * Probe one candidate for an HTML page. Same-origin redirects are followed
 * (bounded) so apps that send `/` to a sign-in page still count as running;
 * redirects to another origin are never followed.
 */
async function probeCandidate(
  candidate: Candidate,
  fetchPage: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<{ attempt: ServerCandidateAttempt; baseUrl?: string }> {
  const source = candidate.evidence.source
  const userSupplied = isUserSupplied(source)
  const normalized = normalizeHttpUrl(candidate.rawUrl, userSupplied)
  if (!normalized) {
    return {
      attempt: {
        url: safeDisplayUrl(candidate.rawUrl),
        source,
        outcome: 'rejected',
        detail: userSupplied
          ? 'Explicit and configured URLs must use HTTP or HTTPS'
          : 'Discovered server candidates must use loopback HTTP',
      },
    }
  }

  const attempt = (outcome: ServerCandidateAttempt['outcome'], detail?: string): ServerCandidateAttempt =>
    detail === undefined
      ? { url: normalized.displayUrl, source, outcome }
      : { url: normalized.displayUrl, source, outcome, detail }

  let probeUrl = normalized.probeUrl
  try {
    for (let redirects = 0; ; redirects++) {
      const response = await fetchPage(probeUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return { attempt: attempt('non-html', `HTTP ${response.status} without a Location header`) }
        const target = new URL(location, probeUrl)
        if (target.origin !== normalized.baseUrl) {
          return { attempt: attempt('rejected', `HTTP ${response.status} redirects to a different origin (${target.origin})`) }
        }
        if (redirects >= MAX_SAME_ORIGIN_REDIRECTS) {
          return { attempt: attempt('rejected', `more than ${MAX_SAME_ORIGIN_REDIRECTS} redirects`) }
        }
        target.username = ''
        target.password = ''
        target.search = ''
        target.hash = ''
        probeUrl = target.href
        continue
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!response.ok || (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml'))) {
        return {
          attempt: attempt('non-html', response.ok ? `content-type was ${contentType || 'missing'}` : `HTTP ${response.status}`),
        }
      }

      const redirectedTo = redirects > 0 ? new URL(probeUrl).pathname : undefined
      return {
        attempt: attempt('selected', redirectedTo ? `followed same-origin redirect to ${redirectedTo}` : undefined),
        baseUrl: normalized.baseUrl,
      }
    }
  } catch (error) {
    return { attempt: attempt('unreachable', error instanceof Error ? error.message : String(error)) }
  }
}

export async function discoverActiveLoopbackPorts(
  dependencies: ActivePortDiscoveryDependencies = {},
): Promise<ActivePortDiscovery> {
  const platform = dependencies.platform ?? process.platform
  const runCommand = dependencies.runCommand ?? runListenerCommand
  const commands = listenerCommandsFor(platform)

  for (const command of commands) {
    try {
      const output = await runCommand(command.name, command.args)
      return {
        ports: uniqueValidPorts(command.parse(output)).slice(0, MAX_ACTIVE_PORTS),
        available: true,
        detail: `Active listener discovery used ${command.name}`,
      }
    } catch {
      // Try the next fixed platform command.
    }
  }

  return {
    ports: [],
    available: false,
    detail: `Active listener discovery unavailable; tried ${commands.map(command => command.name).join(', ')}`,
  }
}

type ListenerCommand = {
  name: string
  args: readonly string[]
  parse: (output: string) => number[]
}

function listenerCommandsFor(platform: NodeJS.Platform): ListenerCommand[] {
  if (platform === 'darwin') {
    return [
      { name: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fn'], parse: parseLsofListeners },
      { name: 'netstat', args: ['-an', '-p', 'tcp'], parse: parseNetstatListeners },
    ]
  }
  if (platform === 'linux') {
    return [
      { name: 'ss', args: ['-ltnH'], parse: parseSsListeners },
      { name: 'netstat', args: ['-ltn'], parse: parseNetstatListeners },
    ]
  }
  if (platform === 'win32') {
    return [
      { name: 'netstat', args: ['-ano', '-p', 'tcp'], parse: parseWindowsNetstatListeners },
    ]
  }
  return [
    { name: 'netstat', args: ['-an'], parse: parseNetstatListeners },
  ]
}

async function runListenerCommand(command: string, args: readonly string[]): Promise<string> {
  const { execFile } = await import('node:child_process')
  const execFileAsync = promisify(execFile)
  const { stdout } = await execFileAsync(command, [...args], { timeout: 1000, maxBuffer: 1024 * 1024 })
  return stdout
}

function parseLsofListeners(output: string): number[] {
  return parseEndpoints(output
    .split('\n')
    .filter(line => line.startsWith('n'))
    .map(line => line.slice(1)))
}

function parseSsListeners(output: string): number[] {
  return parseEndpoints(output
    .split('\n')
    .filter(line => /\bLISTEN\b/i.test(line))
    .map(line => line.trim().split(/\s+/)[3])
    .filter((endpoint): endpoint is string => Boolean(endpoint)))
}

function parseNetstatListeners(output: string): number[] {
  return parseEndpoints(output
    .split('\n')
    .filter(line => /\bLISTEN\b/i.test(line))
    .map(line => line.trim().split(/\s+/)[3])
    .filter((endpoint): endpoint is string => Boolean(endpoint)))
}

function parseWindowsNetstatListeners(output: string): number[] {
  return parseEndpoints(output
    .split('\n')
    .filter(line => /\bLISTENING\b/i.test(line))
    .map(line => line.trim().split(/\s+/)[1])
    .filter((endpoint): endpoint is string => Boolean(endpoint)))
}

function parseEndpoints(endpoints: readonly string[]): number[] {
  const ports: number[] = []
  for (const endpoint of endpoints) {
    const parsed = parseEndpoint(endpoint)
    if (parsed && isLoopbackBinding(parsed.host)) ports.push(parsed.port)
  }
  return uniqueValidPorts(ports)
}

function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  const value = endpoint.trim()
  const bracketed = value.match(/^\[([^\]]+)](?::|\.)(\d+)$/)
  const separated = bracketed ?? value.match(/^(.*)(?::|\.)(\d+)$/)
  if (!separated) return null
  return { host: separated[1], port: Number(separated[2]) }
}

function isLoopbackBinding(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === '*' || normalized === 'localhost' || normalized === '0.0.0.0' ||
    normalized === '::' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function urlCandidate(url: string, source: ServerCandidateSource, description: string): Candidate {
  return {
    rawUrl: url,
    evidence: { source, value: safeDisplayUrl(url), description },
  }
}

function portCandidate(port: number, evidence: ServerEvidence): Candidate {
  return { rawUrl: `http://localhost:${port}`, evidence }
}

function normalizeHttpUrl(value: string, allowRemote: boolean): NormalizedCandidate | null {
  try {
    const url = new URL(value)
    const isLoopback = isLoopbackHostname(url.hostname)
    if (allowRemote) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    } else if (url.protocol !== 'http:' || !isLoopback) {
      return null
    }
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    const displayUrl = url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`
    return { baseUrl: url.origin, displayUrl, probeUrl: displayUrl }
  } catch {
    return null
  }
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.pathname === '/' ? url.origin : `${url.origin}${url.pathname}`
  } catch {
    return '[invalid URL]'
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function uniqueValidPorts(ports: readonly number[]): number[] {
  return [...new Set(ports.filter(port => Number.isInteger(port) && port > 0 && port <= 65535))]
}

function dedupeEvidence(evidence: ServerEvidence[]): ServerEvidence[] {
  const seen = new Set<string>()
  return evidence.filter(item => {
    const key = `${item.source}:${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>()
  return candidates.filter(candidate => {
    const normalized = normalizeHttpUrl(candidate.rawUrl, isUserSupplied(candidate.evidence.source))
    const key = normalized?.displayUrl ?? safeDisplayUrl(candidate.rawUrl)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}
