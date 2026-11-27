import { describe, expect, it } from 'vitest'
import path from 'path'
import { pathToFileURL } from 'url'
import { DslError, parseSteps, tokenize } from '../src/engine/cases/dsl.js'
import { mergeCaseFiles, parseCaseMarkdown, resolveBase } from '../src/engine/cases/parse.js'

describe('case step language', () => {
  it('splits words with quotes and escapes', () => {
    expect(tokenize(`see "[role=alert]" "do not match"`)).toEqual(['see', '[role=alert]', 'do not match'])
    expect(tokenize(`in-viewport "role=button[name=\\"Sign in\\"]"`)).toEqual(['in-viewport', 'role=button[name="Sign in"]'])
    expect(tokenize(`fill '#email' a@b.co`)).toEqual(['fill', '#email', 'a@b.co'])
    expect(() => tokenize('see "open')).toThrow(/unclosed/)
  })

  it('turns each command into a step', () => {
    const { steps, options } = parseSteps([
      '@viewports 1440x900 phone',
      '@motion full reduce',
      '@auth operator',
      'open /login?state=error',
      'fill "label=Work email" aish@example.com',
      'press Enter',
      'press Tab #email',
      'click #submit',
      'see Today',
      'see "#alert" "do not match"',
      'visible #dash',
      'url /dashboard',
      'in-viewport #gbtn',
      'no-horizontal-scroll',
      'still 5000 .loader',
      "eval document.title.includes('Today')",
      'a11y critical main ignore=color-contrast,region',
      'header Authorization "Bearer ${TOKEN}"',
      'request POST /api/x {"title": "Partner", "company": "Lionheart Ventures"}',
      'request --no-follow GET /api/profile',
      'status 4xx',
      'json lead_type = channel',
      'json items[*].id exists',
      'json name "Acme Labs"',
      'json items length >=2',
      'json tools contains brain_read',
    ].join('\n'))
    expect(options).toEqual({ viewports: [[1440, 900], [390, 844]], motion: ['full', 'reduce'], auth: 'operator' })
    expect(steps.map(s => s.action)).toEqual([
      'navigate', 'fill', 'press', 'press', 'click', 'assert', 'assert', 'assert', 'assert', 'in_viewport', 'no_horizontal_scroll',
      'still', 'eval', 'a11y', 'header', 'request', 'request', 'expect_status', 'expect_json', 'expect_json', 'expect_json', 'expect_json', 'expect_json',
    ])
    expect(steps[1]).toMatchObject({ selector: 'label=Work email', value: 'aish@example.com' })
    expect(steps[3]).toMatchObject({ value: 'Tab', selector: '#email' })
    expect(steps[5]).toMatchObject({ value: 'Today' })
    expect(steps[5].selector).toBeUndefined()
    expect(steps[6]).toMatchObject({ selector: '#alert', value: 'do not match' })
    expect(steps[11]).toMatchObject({ timeout: 5000, ignore: '.loader' })
    expect(steps[12].value).toBe("document.title.includes('Today')")
    expect(steps[13]).toMatchObject({ value: 'critical', selector: 'main', ignore: 'color-contrast,region' })
    expect(steps[14]).toMatchObject({ selector: 'Authorization', value: 'Bearer ${TOKEN}' })
    expect(steps[15]).toMatchObject({ method: 'POST', url: '/api/x', body: '{"title": "Partner", "company": "Lionheart Ventures"}' })
    expect(steps[16]).toMatchObject({ method: 'GET', url: '/api/profile', max_redirects: 0 })
    expect(steps[18]).toMatchObject({ path: 'lead_type', op: 'equals', value: 'channel' })
    expect(steps[19]).toMatchObject({ path: 'items[*].id', op: 'exists' })
    expect(steps[20]).toMatchObject({ path: 'name', op: 'equals', value: 'Acme Labs' })
    expect(steps[21]).toMatchObject({ op: 'length', value: '>=2' })
    expect(steps[22]).toMatchObject({ op: 'contains', value: 'brain_read' })
  })

  it('takes JavaScript and JSON bodies raw even when their quotes do not pair up', () => {
    const { steps } = parseSteps(`eval document.title === "Today's plan"\nrequest POST /x {"q": "it's"}`)
    expect(steps[0].value).toBe(`document.title === "Today's plan"`)
    expect(steps[1].body).toBe(`{"q": "it's"}`)
  })

  it('reports the line of a bad command', () => {
    try {
      parseSteps('open /\nfly away', 10)
      throw new Error('expected a DslError')
    } catch (err) {
      expect(err).toBeInstanceOf(DslError)
      expect((err as DslError).line).toBe(11)
      expect((err as Error).message).toMatch(/unknown command fly/)
    }
  })

  it('accepts a JSON block of steps and options', () => {
    const { steps, options } = parseSteps(JSON.stringify({ viewports: ['390x844'], motion: ['reduce'], auth: true, steps: [{ action: 'navigate', url: '/' }, { action: 'still' }] }))
    expect(options).toEqual({ viewports: [[390, 844]], motion: ['reduce'], auth: true })
    expect(steps[0]).toMatchObject({ action: 'navigate', url: '/', description: 'navigate /' })
    expect(() => parseSteps('[{"action": "teleport"}]')).toThrow(/unknown action/)
  })
})

const DESIGN = `# Login round 2: test cases

\`\`\`vibe
@base .
@viewports 1440x900 390x844
\`\`\`

| ID | Flow | Priority |
|---|---|---|
| TC-r2-02 | Insight | P1 |

## A. Layout

### TC-r2-01 Sign-in reachable without scrolling (P0)
- Steps: open each variant.
- vibe: "Open the login page on a phone-sized screen and check the Google button is visible."

\`\`\`vibe
@motion full reduce
open v1.html?clean=1
in-viewport #gbtn
\`\`\`

### TC-r2-02 Insight top
- vibe: "Check today's insight sits above the form."

## B. Form

### TC-r2-03 Manual review (P2)
automatable by vibe-testing: no
`

const OUTREACH = `# TC-OUT-07: forged unsubscribe link refused

priority: P1     automatable: yes

## Steps
1. Open the link.

## vibe-testing hint
"Open /u/1.deadbeef and check the page says This link is not valid."

---

# TC-OUT-08 (P0) Interested reply
- Vibe-testing hint: "Post a reply."
`

describe('markdown test cases', () => {
  it('reads cases, priorities, hints and steps from the design format', () => {
    const file = parseCaseMarkdown(DESIGN, '/repo/design/login/r2/test-cases.md')
    expect(file.errors).toEqual([])
    expect(file.defaults).toEqual({ base: '.', viewports: [[1440, 900], [390, 844]] })
    expect(file.cases.map(c => [c.id, c.title, c.priority, c.steps.length, c.manual])).toEqual([
      ['TC-r2-01', 'Sign-in reachable without scrolling', 'P0', 2, false],
      ['TC-r2-02', 'Insight top', 'P1', 0, false],
      ['TC-r2-03', 'Manual review', 'P2', 0, true],
    ])
    expect(file.cases[0].hint).toBe('Open the login page on a phone-sized screen and check the Google button is visible.')
    expect(file.cases[0].options.motion).toEqual(['full', 'reduce'])
    expect(file.cases[0].line).toBe(14)
  })

  it('reads level-1 headings with sections and a hint section', () => {
    const file = parseCaseMarkdown(OUTREACH, '/repo/docs/outreach.md')
    expect(file.cases.map(c => [c.id, c.title, c.priority])).toEqual([
      ['TC-OUT-07', 'forged unsubscribe link refused', 'P1'],
      ['TC-OUT-08', 'Interested reply', 'P0'],
    ])
    expect(file.cases[0].hint).toBe('Open /u/1.deadbeef and check the page says This link is not valid.')
    expect(file.cases[1].hint).toBe('Post a reply.')
  })

  it('tags live and manual cases from the heading', () => {
    const file = parseCaseMarkdown('### TC-FF-01 Seed (live)\n### TC-FF-18 Reveal (manual, spends one credit)\n', '/x.md')
    expect(file.cases.map(c => [c.tags, c.manual])).toEqual([[['live'], false], [['manual'], true]])
  })

  it('keeps a bad vibe block as a parse error on its case', () => {
    const file = parseCaseMarkdown('### TC-1 Broken\n```vibe\nopen /\nfly\n```\n', '/x.md')
    expect(file.cases[0].parse_error).toMatch(/line 4: unknown command fly/)
  })

  it('merges a steps overlay into the source cases by id', () => {
    const source = parseCaseMarkdown(DESIGN, '/repo/design/login/r2/test-cases.md')
    const overlay = parseCaseMarkdown('```vibe\n@base ../../design/login/r2\n```\n### TC-r2-02 x\n```vibe\nopen v1.html\nsee Insight\n```\n### TC-r2-99 Extra\n```vibe\nopen v2.html\n```\n', '/repo/harness/steps/login.steps.md')
    const merged = mergeCaseFiles([source, overlay])
    expect(merged.map(f => f.cases.map(c => c.id))).toEqual([['TC-r2-01', 'TC-r2-02', 'TC-r2-03'], ['TC-r2-99']])
    const tc = merged[0].cases[1]
    expect(tc.title).toBe('Insight top')
    expect(tc.priority).toBe('P1')
    expect(tc.steps.map(s => s.action)).toEqual(['navigate', 'assert'])
    expect(tc.options.base).toBe(pathToFileURL(path.resolve('/repo/design/login/r2')).href)
    expect(tc.options.viewports).toEqual([[1440, 900], [390, 844]])
  })

  it('keeps @skip from an overlay that has no steps for the case', () => {
    const source = parseCaseMarkdown(DESIGN, '/repo/design/login/r2/test-cases.md')
    const overlay = parseCaseMarkdown('### TC-r2-02 x\n```vibe\n@skip needs a real mailbox\n```\n', '/repo/harness/steps/login.steps.md')
    const merged = mergeCaseFiles([source, overlay])
    const tc = merged[0].cases.find(c => c.id === 'TC-r2-02')!
    expect(tc.options.skip).toBe('needs a real mailbox')
    expect(merged).toHaveLength(1)
  })

  it('resolves the base URL: explicit, then @base next to the file, then the config URL', () => {
    const tc = { file: '/repo/design/login/r2/test-cases.md', options: {} }
    expect(resolveBase(tc, { base: '.' })).toBe(pathToFileURL('/repo/design/login/r2').href + '/')
    expect(resolveBase(tc, { base: '.' }, 'http://localhost:8601')).toBe('http://localhost:8601')
    expect(resolveBase(tc, {}, undefined, 'http://localhost:3000')).toBe('http://localhost:3000')
    expect(resolveBase(tc, {})).toBeUndefined()
  })
})
