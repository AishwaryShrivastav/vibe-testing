import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { detectAuthentication } from '../src/engine/context/auth-detector.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    fs.rm(directory, { recursive: true, force: true })
  ))
})

async function makeProject(files: Record<string, string> = {}): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-auth-detector-'))
  directories.push(directory)
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(directory, relativePath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content)
  }
  return directory
}

describe('detectAuthentication', () => {
  it('combines a login route with a visible Google OAuth control', async () => {
    const codebasePath = await makeProject()

    const result = await detectAuthentication(
      { codebasePath, routePaths: ['/auth', '/dashboard'] },
      {
        inspectVisibleControls: async () => [
          { kind: 'button', text: 'Continue with Google' },
        ],
      },
    )

    expect(result).toMatchObject({
      method: 'oauth',
      provider: 'google',
      loginPath: '/auth',
    })
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.stringContaining('/auth'),
      expect.stringContaining('Google'),
    ]))
    expect(result.action).toMatch(/interactive.*stored browser session/i)
    expect(JSON.stringify(result)).not.toMatch(/password|secret|credential/i)
  })

  it.each([
    ['Google sign-in', 'Sign in with Google', 'google', undefined],
    ['GitHub login', 'Log in with GitHub', 'github', undefined],
    ['Microsoft continuation', 'Continue with Microsoft', 'microsoft', undefined],
    ['concrete OAuth endpoint', 'Sign in with Acme ID', 'other', 'https://id.example.com/oauth/authorize'],
  ] as const)('identifies OAuth from %s', async (_caseName, text, provider, href) => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath },
      { inspectVisibleControls: async () => [{ kind: 'link', text, href }] },
    )

    expect(result.method).toBe('oauth')
    expect(result.provider).toBe(provider)
  })

  it.each([
    'Open Google Maps',
    'View our GitHub repository',
  ])('does not classify an ordinary provider reference as OAuth: %s', async text => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath },
      { inspectVisibleControls: async () => [{ kind: 'link', text }] },
    )

    expect(result).toEqual({ method: 'none', evidence: [] })
  })

  it('does not treat generic continue-with copy as OAuth', async () => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath },
      { inspectVisibleControls: async () => [{ kind: 'button', text: 'Continue with setup' }] },
    )

    expect(result).toEqual({ method: 'none', evidence: [] })
  })

  it.each([
    {
      caseName: 'URL userinfo',
      text: 'Continue with Google',
      href: 'https://user:password@accounts.example.com/oauth/google',
      safeHref: 'https://accounts.example.com/oauth/google',
      forbidden: ['user', 'password', '@'],
    },
    {
      caseName: 'OAuth state query',
      text: 'Continue securely',
      href: 'https://accounts.example.com/oauth?provider=google&state=oauth-state-secret',
      safeHref: 'https://accounts.example.com/oauth',
      forbidden: ['?', 'state', 'oauth-state-secret'],
    },
    {
      caseName: 'magic-link token query',
      text: 'Continue with Google',
      href: 'https://accounts.example.com/magic-link?token=magic-link-secret',
      safeHref: 'https://accounts.example.com/magic-link',
      forbidden: ['?', 'token', 'magic-link-secret'],
    },
    {
      caseName: 'URL fragment',
      text: 'Continue with Google',
      href: 'https://accounts.example.com/oauth/google#access_token=fragment-secret',
      safeHref: 'https://accounts.example.com/oauth/google',
      forbidden: ['#', 'access_token', 'fragment-secret'],
    },
  ])('sanitizes $caseName in returned evidence', async ({ text, href, safeHref, forbidden }) => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath },
      {
        inspectVisibleControls: async () => [
          { kind: 'link', text, href },
        ],
      },
    )

    expect(result).toMatchObject({ method: 'oauth', provider: 'google' })
    const evidence = result.evidence.join('\n')
    expect(evidence).toContain(safeHref)
    for (const value of forbidden) expect(evidence).not.toContain(value)
  })

  it('returns semantic OAuth evidence without arbitrary control values', async () => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath },
      {
        inspectVisibleControls: async () => [{
          kind: 'link',
          text: 'Continue with Google token=visible-secret',
          name: 'credential-name-secret',
          placeholder: 'credential-placeholder-secret',
          href: 'https://accounts.example.com/oauth/google?state=href-secret',
        }],
      },
    )

    expect(result.evidence).toEqual([
      'Visible Google OAuth control at https://accounts.example.com/oauth/google',
    ])
    expect(result.evidence.join('\n')).not.toMatch(/visible-secret|credential-name-secret|credential-placeholder-secret|href-secret/)
  })

  it('classifies visible email and password controls as password auth', async () => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath, routePaths: ['/login'] },
      {
        inspectVisibleControls: async () => [
          { kind: 'input', type: 'email', name: 'email' },
          { kind: 'input', type: 'password', name: 'password' },
          { kind: 'button', text: 'Log in' },
        ],
      },
    )

    expect(result).toMatchObject({ method: 'password', loginPath: '/login' })
    expect(result.provider).toBeUndefined()
  })

  it('returns semantic password evidence without input names or placeholders', async () => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath },
      {
        inspectVisibleControls: async () => [
          { kind: 'input', type: 'email', name: 'email-token-secret', placeholder: 'identity-secret' },
          { kind: 'input', type: 'password', name: 'password-token-secret', placeholder: 'password-secret' },
        ],
      },
    )

    expect(result.evidence).toEqual([
      'Visible password field',
      'Visible email or username field',
    ])
    expect(result.evidence.join('\n')).not.toContain('secret')
  })

  it('uses source evidence to classify OAuth when controls are unavailable', async () => {
    const codebasePath = await makeProject({
      'src/routes/sign-in.tsx': "export const login = () => signIn('google')",
    })
    const result = await detectAuthentication(
      { codebasePath, routePaths: ['/sign-in'] },
      { inspectVisibleControls: async () => [] },
    )

    expect(result).toMatchObject({ method: 'oauth', provider: 'google', loginPath: '/sign-in' })
    expect(result.evidence).toContainEqual(expect.stringContaining('src/routes/sign-in.tsx'))
  })

  it('returns unknown when an auth route exists without method evidence', async () => {
    const codebasePath = await makeProject()
    const result = await detectAuthentication(
      { codebasePath, routePaths: ['/login'] },
      { inspectVisibleControls: async () => [] },
    )

    expect(result).toMatchObject({ method: 'unknown', loginPath: '/login' })
  })

  it('returns none when no authentication evidence is visible or present in source', async () => {
    const codebasePath = await makeProject({
      'src/App.tsx': 'export function App() { return <h1>Welcome</h1> }',
    })
    const result = await detectAuthentication(
      { codebasePath, routePaths: ['/', '/about'] },
      { inspectVisibleControls: async () => [] },
    )

    expect(result).toEqual({ method: 'none', evidence: [] })
  })
})
