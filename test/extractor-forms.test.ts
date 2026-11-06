import { describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { extractBehaviours, parseInputTag, resolveFieldType } from '../src/engine/context/extractor.js'
import type { FormField } from '../src/types/index.js'

async function formsOf(source: string): Promise<FormField[][]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-extract-'))
  const file = path.join(dir, 'Page.jsx')
  await fs.writeFile(file, source)
  try {
    const [b] = await extractBehaviours([{ path: '/x', type: 'page', requires_auth: false, dynamic_segments: [], file_path: file }], 'deep')
    return b.forms
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

describe('extractBehaviours → forms', () => {
  it('extracts a JSX login form with arrow-function handlers (real-world LoginPage.jsx)', async () => {
    const forms = await formsOf(`
      <form onSubmit={handleSubmit}>
        <label htmlFor="username">Username</label>
        <input id="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="admin" />
        <label htmlFor="password">Password</label>
        <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="1234" />
        <button type="submit">Log In</button>
      </form>`)
    const fields = forms.flat()
    const user = fields.find(f => f.id === 'username')
    const pass = fields.find(f => f.id === 'password')
    expect(user).toMatchObject({ name: 'username', type: 'text', placeholder: 'admin' })
    expect(pass).toMatchObject({ name: 'password', type: 'password', placeholder: '1234' })
  })

  it('associates a preceding <Label> with the next input', async () => {
    const forms = await formsOf(`
      <Label>Work email</Label>
      <Input name="workEmail" />`)
    expect(forms.flat().find(f => f.name === 'workEmail')).toMatchObject({ label: 'Work email', type: 'email' })
  })

  it('returns no forms for a page without inputs', async () => {
    expect(await formsOf('<div><h1>About</h1><p>No form here</p></div>')).toEqual([])
  })

  it('skips routes that have no source file', async () => {
    const behaviours = await extractBehaviours([{ path: '/x', type: 'page', requires_auth: false, dynamic_segments: [] }], 'deep')
    expect(behaviours).toEqual([])
  })
})

describe('parseInputTag', () => {
  it('does not mistake data-testid for id or data-name for name (regression)', () => {
    const f = parseInputTag('<input data-testid="email-input" data-name="x" id="email" name="userEmail" />')
    expect(f).toMatchObject({ id: 'email', name: 'userEmail', type: 'email' })
  })

  it('does not treat aria-required="false" as required', () => {
    expect(parseInputTag('<input name="nickname" aria-required="false" />')?.required).toBe(false)
    expect(parseInputTag('<input name="nickname" required />')?.required).toBe(true)
  })

  it('reads length limits and pattern validations', () => {
    const f = parseInputTag('<input name="zip" minLength={5} maxLength="10" pattern="[0-9]+" />')
    expect(f?.validations).toEqual(expect.arrayContaining([
      { type: 'minLength', value: 5 },
      { type: 'maxLength', value: 10 },
      { type: 'pattern', value: '[0-9]+' },
    ]))
  })

  it('resolves a JSX expression type such as a show/hide password toggle', () => {
    const f = parseInputTag(`<input name="secret" type={show ? 'text' : 'password'} />`)
    expect(f?.type).toBe('password')
  })

  it('keeps placeholder-only inputs and names them from the placeholder', () => {
    expect(parseInputTag('<input placeholder="Search products" />')).toMatchObject({
      name: 'search_products', placeholder: 'Search products',
    })
  })

  it('reads aria-label as the field label', () => {
    expect(parseInputTag('<input name="q" aria-label="Search" />')?.label).toBe('Search')
  })

  it('ignores inputs with nothing to identify them', () => {
    expect(parseInputTag('<input value={x} onChange={setX} />')).toBeNull()
  })
})

describe('resolveFieldType', () => {
  it.each([
    [['number', undefined, 'x', undefined], 'number'],          // explicit type wins
    [[undefined, "type={a ? 'text' : 'email'}", 'x', undefined], 'email'],
    [[undefined, undefined, 'newPassword', undefined], 'password'],
    [[undefined, undefined, 'passwd', undefined], 'password'],
    [[undefined, undefined, 'contactEmail', undefined], 'email'],
    [[undefined, undefined, 'phoneNumber', undefined], 'tel'],
    [[undefined, undefined, 'websiteUrl', undefined], 'url'],
    [[undefined, undefined, 'contact', 'you@example.com'], 'email'],
    [[undefined, undefined, 'username', 'admin'], 'text'],
  ] as const)('%j → %s', (args, expected) => {
    expect(resolveFieldType(...(args as unknown as [string?, string?, string?, string?]))).toBe(expected)
  })
})
