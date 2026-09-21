import path from 'node:path'
import type { AuthDetection, AuthProvider, AuthVisibleControl } from '../../types/index.js'
import { glob, readFile } from '../../utils/file.js'

export interface AuthDetectorInput {
  codebasePath: string
  routePaths?: readonly string[]
}

export interface AuthDetectorDependencies {
  inspectVisibleControls?: () => Promise<readonly AuthVisibleControl[]>
  readSourceFiles?: (codebasePath: string) => Promise<readonly SourceFile[]>
}

export interface SourceFile {
  path: string
  content: string
}

const AUTH_ROUTE = /(?:^|\/)(?:auth|login|log-in|signin|sign-in)(?:\/|$)/i

export async function detectAuthentication(
  input: AuthDetectorInput,
  dependencies: AuthDetectorDependencies = {},
): Promise<AuthDetection> {
  const [controls, sourceFiles] = await Promise.all([
    dependencies.inspectVisibleControls?.() ?? Promise.resolve([]),
    (dependencies.readSourceFiles ?? readAuthSourceFiles)(input.codebasePath),
  ])
  const evidence: string[] = []
  const loginPath = input.routePaths?.find(route => AUTH_ROUTE.test(route))

  if (loginPath) evidence.push(`Authentication route found at ${loginPath}`)

  const sourceMatches = sourceFiles.filter(file => hasAuthSourceHint(file.path, file.content))
  const visibleOAuthControl = controls
    .map(control => ({ control, provider: classifyOAuth(controlClassificationText(control)) }))
    .find(match => match.provider !== undefined)
  const sourceOAuthFile = sourceMatches
    .map(file => ({ file, provider: classifyOAuth(file.content) }))
    .find(match => match.provider !== undefined)
  const provider = visibleOAuthControl?.provider ?? sourceOAuthFile?.provider

  if (provider) {
    if (visibleOAuthControl) {
      const location = sanitizeControlHref(visibleOAuthControl.control.href)
      const providerName = provider === 'other' ? '' : `${providerDisplayName(provider)} `
      evidence.push(`Visible ${providerName}OAuth control${location ? ` at ${location}` : ''}`)
    }
    if (sourceOAuthFile) evidence.push(`OAuth source hint in ${sourceOAuthFile.file.path}`)

    const location = loginPath ? ` at ${loginPath}` : ''
    return {
      method: 'oauth',
      provider: provider ?? 'other',
      loginPath,
      evidence: unique(evidence),
      action: `Open the sign-in flow${location} interactively or provide stored browser session state before testing authenticated routes.`,
    }
  }

  const hasPassword = controls.some(control => control.kind === 'input' && control.type?.toLowerCase() === 'password')
  const hasIdentity = controls.some(control => {
    const value = `${control.type ?? ''} ${control.name ?? ''} ${control.placeholder ?? ''}`
    return control.kind === 'input' && /email|user(?:name)?/i.test(value)
  })
  const sourceHasPassword = sourceMatches.some(file => /type\s*=\s*[{'"`]password|type\s*:\s*['"]password|name\s*=\s*[{'"`]password/i.test(file.content))

  if ((hasPassword && hasIdentity) || sourceHasPassword) {
    if (hasPassword) evidence.push('Visible password field')
    if (hasIdentity) evidence.push('Visible email or username field')
    for (const file of sourceMatches.filter(file => /password/i.test(file.content))) {
      evidence.push(`Password source hint in ${file.path}`)
    }
    return { method: 'password', loginPath, evidence: unique(evidence) }
  }

  const hasVisibleSignIn = controls.some(control =>
    /sign[ -]?in|log[ -]?in|auth/i.test(controlClassificationText(control))
  )
  const hasUnclassifiedAuth = Boolean(loginPath) || sourceMatches.length > 0 || hasVisibleSignIn
  if (hasUnclassifiedAuth) {
    if (hasVisibleSignIn) evidence.push('Visible sign-in control')
    for (const file of sourceMatches) evidence.push(`Authentication source hint in ${file.path}`)
    return { method: 'unknown', loginPath, evidence: unique(evidence) }
  }

  return { method: 'none', evidence: [] }
}

async function readAuthSourceFiles(codebasePath: string): Promise<SourceFile[]> {
  const patterns = [
    'src/**/*.{ts,tsx,js,jsx,vue,svelte,html}',
    'app/**/*.{ts,tsx,js,jsx}',
    'pages/**/*.{ts,tsx,js,jsx}',
  ]
  const relativePaths = unique((await Promise.all(patterns.map(pattern => glob(pattern, codebasePath)))).flat())
    .slice(0, 200)

  return Promise.all(relativePaths.map(async relativePath => ({
    path: relativePath,
    content: await readFile(path.join(codebasePath, relativePath)),
  })))
}

function hasAuthSourceHint(filePath: string, content: string): boolean {
  if (classifyOAuth(content) !== undefined) return true
  return AUTH_ROUTE.test(`/${filePath}`) ||
    /\boauth\b|\bopenid\b|\bsso\b|sign\s*in\s*\(|type\s*=\s*[{'"`]password|type\s*:\s*['"]password/i.test(content)
}

function detectProvider(value: string): AuthProvider | undefined {
  if (/\bgoogle\b/i.test(value)) return 'google'
  if (/\bgithub\b/i.test(value)) return 'github'
  if (/\bmicrosoft\b|\bazure\b|\bentra\b|windows live/i.test(value)) return 'microsoft'
  return undefined
}

function hasOAuthSignal(value: string): boolean {
  return /\boauth\b|\bopenid\b|\bsso\b|sign\s*in\s*\(|\/auth(?:\/|[?#]|$)|\/authorize(?:[/?#]|$)/i.test(value)
}

function hasAuthenticationIntent(value: string): boolean {
  return /\bsign[ -]?in\b|\blog[ -]?in\b|\bcontinue with\b|\bauthenticate\b|\bauthentication\b/i.test(value)
}

function classifyOAuth(value: string): AuthProvider | undefined {
  const provider = detectProvider(value)
  if (hasOAuthSignal(value)) return provider ?? 'other'
  if (provider && hasAuthenticationIntent(value)) return provider
  return undefined
}

function providerDisplayName(provider: Exclude<AuthProvider, 'other'>): string {
  if (provider === 'github') return 'GitHub'
  return `${provider[0].toUpperCase()}${provider.slice(1)}`
}

function controlClassificationText(control: AuthVisibleControl): string {
  return [
    control.text,
    control.type,
    control.name,
    control.placeholder,
    control.href,
  ]
    .filter(Boolean)
    .join(' ')
}

function sanitizeControlHref(value: string | undefined): string | undefined {
  if (!value) return undefined

  try {
    const hasAuthority = /^(?:https?:)?\/\//i.test(value)
    const url = new URL(value, 'http://local.invalid')
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return hasAuthority ? `${url.origin}${url.pathname}` : url.pathname
  } catch {
    return undefined
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}
