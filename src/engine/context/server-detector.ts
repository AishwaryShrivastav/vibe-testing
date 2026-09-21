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
  explicitUrl?: string
  configuredUrl?: string
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

  if (input.explicitUrl) {
    candidates.push(urlCandidate(input.explicitUrl, 'explicit-url', 'URL supplied for this run'))
  }
  if (input.configuredUrl) {
    candidates.push(urlCandidate(input.configuredUrl, 'configured-url', 'URL found in project configuration'))
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
    const userSupplied = candidate.evidence.source === 'explicit-url' || candidate.evidence.source === 'configured-url'
    const normalized = normalizeHttpUrl(candidate.rawUrl, userSupplied)
    if (!normalized) {
      attemptedCandidates.push({
        url: safeDisplayUrl(candidate.rawUrl),
        source: candidate.evidence.source,
        outcome: 'rejected',
        detail: userSupplied
          ? 'Explicit and configured URLs must use HTTP or HTTPS'
          : 'Discovered server candidates must use loopback HTTP',
      })
      continue
    }

    try {
      const response = await fetchPage(normalized.probeUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!response.ok || (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml'))) {
        attemptedCandidates.push({
          url: normalized.displayUrl,
          source: candidate.evidence.source,
          outcome: 'non-html',
          detail: response.ok ? `content-type was ${contentType || 'missing'}` : `HTTP ${response.status}`,
        })
        continue
      }

      attemptedCandidates.push({
        url: normalized.displayUrl,
        source: candidate.evidence.source,
        outcome: 'selected',
      })
      return {
        url: normalized.baseUrl,
        evidence: [candidate.evidence],
        attemptedCandidates,
        diagnostics,
      }
    } catch (error) {
      attemptedCandidates.push({
        url: normalized.displayUrl,
        source: candidate.evidence.source,
        outcome: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { evidence: [], attemptedCandidates, diagnostics }
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
    const allowRemote = candidate.evidence.source === 'explicit-url' || candidate.evidence.source === 'configured-url'
    const normalized = normalizeHttpUrl(candidate.rawUrl, allowRemote)
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
