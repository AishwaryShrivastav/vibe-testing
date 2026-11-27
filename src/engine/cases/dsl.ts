import type { TestStep } from '../../types/index.js'

/**
 * The step language of a ```vibe block in a markdown test case. One command
 * per line; quote arguments that contain spaces. Lines starting with @ set
 * options for the case (see CaseOptions). # starts a comment.
 *
 *   @viewports 1440x900 390x844
 *   @motion full reduce
 *   open v1.html?state=error&clean=1
 *   fill "label=Work email" aish@example.com
 *   press Enter
 *   see "[role=alert]" "do not match"
 *   in-viewport "role=button[name=\"Continue with Google\"]"
 *   still 5000
 *   a11y serious
 *   request POST /api/funnel/classify {"title": "Partner", "company": "Lionheart Ventures"}
 *   status 200
 *   json lead_type = channel
 */

export interface CaseOptions {
  /** Viewports as [width, height]. */
  viewports?: Array<[number, number]>
  /** full = no preference, reduce = prefers-reduced-motion: reduce. */
  motion?: Array<'full' | 'reduce'>
  /** Sign in first: true for the default session, or an account name from auth.accounts; false = signed out (overrides a file default). */
  auth?: true | string | false
  route?: string
  base?: string
  skip?: string
  /** Default step timeout (ms) for this case. */
  timeout?: number
  /** Extra tags such as live or manual (cases with them are left out unless asked for). */
  tags?: string[]
}

export interface ParsedSteps {
  steps: TestStep[]
  options: CaseOptions
}

export class DslError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`)
  }
}

/** Splits a line into words: "double" and 'single' quotes group, \" escapes inside double quotes. */
export function tokenize(line: string): string[] {
  const words: string[] = []
  let i = 0
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++
    if (i >= line.length) break
    let word = ''
    while (i < line.length && !/\s/.test(line[i])) {
      const ch = line[i]
      if (ch === '"' || ch === "'") {
        i++
        while (i < line.length && line[i] !== ch) {
          if (ch === '"' && line[i] === '\\' && i + 1 < line.length) { word += line[i + 1]; i += 2; continue }
          word += line[i++]
        }
        if (i >= line.length) throw new Error(`unclosed ${ch}`)
        i++
      } else word += line[i++]
    }
    words.push(word)
  }
  return words
}

/** The text after the first `count` words, untouched (for JSON bodies and JavaScript). */
function restAfter(line: string, count: number): string {
  let i = 0
  for (let n = 0; n < count; n++) {
    while (i < line.length && /\s/.test(line[i])) i++
    let quote: string | undefined
    while (i < line.length && (quote || !/\s/.test(line[i]))) {
      const ch = line[i]
      if (quote) { if (ch === '\\' && quote === '"') i++; else if (ch === quote) quote = undefined }
      else if (ch === '"' || ch === "'") quote = ch
      i++
    }
  }
  return line.slice(i).trim()
}

const unquote = (s: string): string => {
  const t = s.trim()
  return (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) ? tokenize(t)[0] ?? '' : t
}

const JSON_OPS: Record<string, NonNullable<TestStep['op']>> = {
  '=': 'equals', '==': 'equals', 'equals': 'equals', 'is': 'equals',
  '!=': 'not_equals', 'not': 'not_equals',
  '~': 'contains', 'contains': 'contains', 'has': 'contains',
  'exists': 'exists', 'absent': 'absent', 'missing': 'absent',
  'length': 'length', 'len': 'length', 'count': 'length',
  'matches': 'matches', '=~': 'matches',
  '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte',
}

export function parseViewport(word: string): [number, number] {
  const named: Record<string, [number, number]> = { desktop: [1440, 900], laptop: [1280, 800], tablet: [834, 1194], phone: [390, 844], mobile: [390, 844] }
  if (named[word.toLowerCase()]) return named[word.toLowerCase()]
  const m = word.match(/^(\d{2,5})x(\d{2,5})$/i)
  if (!m) throw new Error(`viewport must look like 1440x900 or phone (got ${word})`)
  return [Number(m[1]), Number(m[2])]
}

export function parseMotion(word: string): 'full' | 'reduce' {
  const w = word.toLowerCase()
  if (w === 'full' || w === 'no-preference' || w === 'on') return 'full'
  if (w === 'reduce' || w === 'reduced' || w === 'off') return 'reduce'
  throw new Error(`motion must be full or reduce (got ${word})`)
}

function option(words: string[], options: CaseOptions): void {
  const [name, ...args] = words
  switch (name.toLowerCase()) {
    case '@viewport': case '@viewports': options.viewports = args.map(parseViewport); break
    case '@motion': options.motion = args.map(parseMotion); break
    case '@auth': options.auth = args[0] ? args[0] : true; break
    case '@public': options.auth = false; break
    case '@route': options.route = args[0]; break
    case '@base': options.base = args[0]; break
    case '@skip': options.skip = args.join(' ') || 'skipped'; break
    case '@timeout': options.timeout = Number(args[0]); if (!(options.timeout > 0)) throw new Error('@timeout needs a number of ms'); break
    case '@tag': case '@tags': options.tags = [...(options.tags ?? []), ...args.map(a => a.toLowerCase())]; break
    default: throw new Error(`unknown option ${name}`)
  }
}

/** Parses a vibe block: DSL lines, or JSON (an array of steps or {steps, ...options}). */
export function parseSteps(source: string, firstLine = 1): ParsedSteps {
  const trimmed = source.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJsonSteps(trimmed, firstLine)
  const steps: TestStep[] = []
  const options: CaseOptions = {}
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim()
    const lineNo = firstLine + index
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue
    try {
      // JavaScript and JSON bodies are taken raw, so their quotes need not pair up as words.
      const rawTail = /^(eval|expect|js|request|fetch|call)\s/i.test(raw)
      let words: string[]
      try { words = tokenize(raw) } catch (err) { if (!rawTail) throw err; words = raw.split(/\s+/) }
      if (words[0].startsWith('@')) { option(words, options); continue }
      steps.push(command(raw, words))
    } catch (err) {
      throw new DslError(err instanceof Error ? err.message : String(err), lineNo)
    }
  }
  return { steps, options }
}

function need(words: string[], count: number, usage: string): void {
  if (words.length - 1 < count) throw new Error(`usage: ${usage}`)
}

function command(raw: string, words: string[]): TestStep {
  const [name, ...args] = words
  const cmd = name.toLowerCase()
  switch (cmd) {
    case 'open': case 'goto': case 'navigate': case 'visit':
      need(words, 1, 'open <url>')
      return { action: 'navigate', url: args[0], description: `Open ${args[0]}` }
    case 'fill': case 'type':
      need(words, 2, 'fill <selector> <value>')
      return { action: 'fill', selector: args[0], value: args.slice(1).join(' '), description: `Fill ${args[0]}` }
    case 'click': case 'tap':
      need(words, 1, 'click <selector>')
      return { action: 'click', selector: args[0], description: `Click ${args[0]}` }
    case 'press':
      need(words, 1, 'press <key> [selector]')
      return { action: 'press', value: args[0], selector: args[1], description: `Press ${args[0]}${args[1] ? ` on ${args[1]}` : ''}` }
    case 'select':
      need(words, 2, 'select <selector> <option>')
      return { action: 'select', selector: args[0], value: args[1], description: `Select ${args[1]} in ${args[0]}` }
    case 'upload':
      need(words, 2, 'upload <selector> <file>')
      return { action: 'upload', selector: args[0], value: args[1], description: `Upload ${args[1]}` }
    case 'wait': case 'sleep':
      return { action: 'wait', value: String(Number(args[0] ?? 1000) || 1000), description: `Wait ${args[0] ?? 1000}ms` }
    case 'see': case 'expect-text': case 'text':
      need(words, 1, 'see [selector] <text>')
      return args.length >= 2
        ? { action: 'assert', selector: args[0], value: args.slice(1).join(' '), description: `${args[0]} shows "${args.slice(1).join(' ')}"` }
        : { action: 'assert', value: args[0], description: `Page shows "${args[0]}"` }
    case 'visible': case 'expect-visible':
      need(words, 1, 'visible <selector>')
      return { action: 'assert', selector: args[0], description: `${args[0]} is visible` }
    case 'url': case 'expect-url':
      need(words, 1, 'url <url>')
      return { action: 'assert', url: args[0], description: `URL is ${args[0]}` }
    case 'in-viewport': case 'above-fold': case 'in_viewport':
      need(words, 1, 'in-viewport <selector>')
      return { action: 'in_viewport', selector: args[0], description: `${args[0]} is in the viewport without scrolling` }
    case 'no-horizontal-scroll': case 'no_horizontal_scroll': case 'no-hscroll':
      return { action: 'no_horizontal_scroll', description: 'No horizontal scroll' }
    case 'still': case 'no-motion': case 'settled': {
      const ms = args[0] !== undefined && /^\d+$/.test(args[0]) ? Number(args[0]) : undefined
      const ignore = ms === undefined ? args[0] : args[1]
      return { action: 'still', ...(ms ? { timeout: ms } : {}), ...(ignore ? { ignore } : {}), description: `Nothing is moving${ms ? ` within ${ms}ms` : ''}` }
    }
    case 'eval': case 'expect': case 'js': {
      const expr = restAfter(raw, 1)
      if (!expr) throw new Error('usage: eval <javascript expression>')
      return { action: 'eval', value: expr, description: `True: ${expr.slice(0, 80)}` }
    }
    case 'a11y': case 'axe': {
      const impact = args[0] && ['minor', 'moderate', 'serious', 'critical'].includes(args[0].toLowerCase()) ? args[0].toLowerCase() : undefined
      const rest = impact ? args.slice(1) : args
      const ignore = rest.find(a => a.startsWith('ignore='))?.slice(7)
      const scope = rest.find(a => !a.startsWith('ignore='))
      return { action: 'a11y', value: impact ?? 'serious', ...(scope ? { selector: scope } : {}), ...(ignore ? { ignore } : {}), description: `No ${impact ?? 'serious'} or worse accessibility violations${scope ? ` in ${scope}` : ''}` }
    }
    case 'header':
      need(words, 2, 'header <name> <value>')
      return { action: 'header', selector: args[0], value: args.slice(1).join(' '), description: `Send header ${args[0]}` }
    case 'request': case 'fetch': case 'call': {
      need(words, 2, 'request <METHOD> <url> [json body] (add --no-follow before the method to keep redirects)')
      let i = 0
      const noFollow = args[0] === '--no-follow'
      if (noFollow) i++
      const method = args[i].toUpperCase()
      const url = args[i + 1]
      if (!url) throw new Error('usage: request <METHOD> <url> [json body]')
      const body = restAfter(raw, i + 3)
      return {
        action: 'request', method, url,
        ...(body ? { body } : {}),
        ...(noFollow ? { max_redirects: 0 } : {}),
        description: `${method} ${url}`,
      }
    }
    case 'status': case 'expect-status':
      need(words, 1, 'status <200 | 2xx | 400|403>')
      return { action: 'expect_status', value: args[0], description: `Status ${args[0]}` }
    case 'json': case 'expect-json': {
      need(words, 1, 'json <path> [op] [value]')
      const path = args[0]
      if (args.length === 1) return { action: 'expect_json', path, op: 'exists', description: `${path} exists` }
      const op = JSON_OPS[args[1].toLowerCase()]
      if (!op) {
        // `json path value` means equals.
        const value = unquote(restAfter(raw, 2))
        return { action: 'expect_json', path, op: 'equals', value, description: `${path} = ${value}` }
      }
      const value = op === 'exists' || op === 'absent' ? undefined : unquote(restAfter(raw, 3))
      if (value === '' && op !== 'contains') throw new Error(`json ${path} ${args[1]} needs a value`)
      return { action: 'expect_json', path, op, ...(value !== undefined ? { value } : {}), description: `${path} ${args[1]}${value !== undefined ? ` ${value}` : ''}` }
    }
    default:
      throw new Error(`unknown command ${name}`)
  }
}

const ACTIONS = new Set(['navigate', 'fill', 'click', 'wait', 'assert', 'select', 'upload', 'press', 'request', 'header', 'expect_status', 'expect_json', 'eval', 'in_viewport', 'no_horizontal_scroll', 'still', 'a11y'])

function parseJsonSteps(text: string, firstLine: number): ParsedSteps {
  let data: unknown
  try { data = JSON.parse(text) } catch (err) {
    throw new DslError(`invalid JSON: ${err instanceof Error ? err.message : String(err)}`, firstLine)
  }
  const obj = Array.isArray(data) ? { steps: data } : data as Record<string, unknown>
  if (!Array.isArray(obj.steps)) throw new DslError('JSON block needs "steps": [...]', firstLine)
  const steps = obj.steps.map((s, i) => {
    const step = s as TestStep
    if (!step || typeof step !== 'object' || !ACTIONS.has(step.action)) throw new DslError(`step ${i + 1} has an unknown action ${JSON.stringify((s as { action?: unknown })?.action)}`, firstLine)
    return { ...step, description: step.description ?? `${step.action} ${step.selector ?? step.url ?? step.value ?? ''}`.trim() }
  })
  const options: CaseOptions = {}
  const o = obj as Record<string, unknown>
  if (Array.isArray(o.viewports)) options.viewports = o.viewports.map(v => Array.isArray(v) ? [Number(v[0]), Number(v[1])] as [number, number] : parseViewport(String(v)))
  if (Array.isArray(o.motion)) options.motion = o.motion.map(m => parseMotion(String(m)))
  if (o.auth === true || o.auth === false || typeof o.auth === 'string') options.auth = o.auth as true | string | false
  if (typeof o.route === 'string') options.route = o.route
  if (typeof o.base === 'string') options.base = o.base
  if (typeof o.skip === 'string') options.skip = o.skip
  if (typeof o.timeout === 'number') options.timeout = o.timeout
  return { steps, options }
}
