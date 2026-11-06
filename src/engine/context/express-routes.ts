import path from 'path'
import type { Route } from '../../types/index.js'
import { glob, readFile } from '../../utils/file.js'

/**
 * Static route discovery for Express-style servers (Express, Fastify, Koa/Hono
 * routers share the `receiver.method('/path', ...handlers)` shape).
 *
 * Routes are found in any server source file, not just conventional
 * `routes/` or `app.js` locations — apps often register them from something
 * like `app/routes/index.js` with the app passed in. To avoid false routes:
 *   - comments are stripped before matching,
 *   - tests, vendored and client-side asset folders are skipped,
 *   - the receiver must look like a server app or router (declared from
 *     express()/Router()/fastify(), or conventionally named app/router/…),
 *     never an HTTP client such as axios or $,
 *   - the first argument must be a path starting with "/" and a handler must follow.
 *
 * `app.use('/prefix', router)` mounts are resolved across files, so a router
 * module's routes get their mount prefix. Each route is typed as a page when its
 * handler renders HTML (res.render/sendFile) and as an API when it only returns
 * data (res.json) or is not a GET; auth is inferred from middleware such as
 * isLoggedIn/requireAuth, router-level `router.use(auth)`, or a handler that
 * sends signed-out users to the login page.
 */

const SOURCE_GLOB = '**/*.{ts,js,mts,mjs,cts,cjs}'
const EXCLUDED_FILE = new RegExp([
  String.raw`(^|/)(test|tests|__tests__|__mocks__|spec|e2e|cypress|playwright|fixtures?)/`,
  String.raw`\.(test|spec|cy|e2e)\.[cm]?[jt]s$`,
  String.raw`\.d\.[cm]?ts$`,
  String.raw`\.min\.js$`,
  // Browser code: static asset folders and vendored libraries.
  String.raw`(^|/)(public|static|assets|vendor|bower_components|client|frontend|www)/`,
].join('|'))

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'all'] as const
type Method = typeof METHODS[number]

/** Names conventionally used for an Express app or router. */
const CONVENTIONAL_RECEIVER = /^(app|server|router|routes|fastify|[a-z]\w*Router|[a-z]\w*Routes)$/
/** HTTP clients and test helpers that share the `.get('/path', …)` shape. */
const CLIENT_RECEIVER = /^(axios|\$|jQuery|request|http|https|fetch|client|api|cy|superagent|got|ky|agent|this)$/
const APP_RECEIVER = /^(app|server|fastify)$/

const AUTH_MIDDLEWARE = /\b(is_?)?(logged_?in|signed_?in|authenticated|admin|authori[sz]ed)\b|\b\w*(require|ensure|check|verify|protect|must|need)s?_?\w*(auth|login|logged|signed|user|admin|role|token|session|permission)\w*|(?<!passport\s*\.\s*)\bauth(enticate|orize|Required|Guard|Middleware)?\b|\b(jwt|bearer)\w*|passport\.authenticate\(\s*['"`](?!local)/i
const LOGIN_REDIRECT = /\bredirect\s*\(\s*(?:\d{3}\s*,\s*)?['"`]\/?(login|signin|sign-in|auth|session\/new)\b/i
const AUTH_PATH = /\/(login|logout|signin|signout|sign-in|sign-out|signup|sign-up|register|auth)\b/i

interface FileRoute {
  method: Method
  path: string
  receiver: string
  middleware: string[]
  handler: string
  index: number
}

interface Mount {
  receiver: string
  prefix: string
  index: number
  /** File and (when mounted from the same file) receiver the prefix applies to. */
  target: { file: string; receiver?: string }
  middleware: string[]
}

interface ParsedFile {
  file: string
  content: string
  routes: FileRoute[]
  mounts: Mount[]
  /** Path-less `receiver.use(mw)` calls, for router- and app-level auth. */
  uses: Array<{ receiver: string; middleware: string[]; index: number }>
  imports: Map<string, string>
  appReceivers: Set<string>
}

export async function parseExpressRoutes(codebasePath: string): Promise<Route[]> {
  const files = (await glob(SOURCE_GLOB, codebasePath)).filter(f => !EXCLUDED_FILE.test(f)).sort()
  const parsed = new Map<string, ParsedFile>()
  for (const file of files) {
    let content: string
    try { content = stripComments(await readFile(path.join(codebasePath, file))) } catch { continue }
    if (!/\.\s*(get|post|put|delete|patch|all|route|use)\s*\(/.test(content)) continue
    parsed.set(file, await parseFile(file, content, codebasePath))
  }

  const routes = new Map<string, Route>()
  for (const info of parsed.values()) {
    for (const route of info.routes) {
      for (const mount of prefixesFor(info, route.receiver, parsed)) {
        const fullPath = joinPath(mount.prefix, route.path)
        const method = route.method === 'all' ? 'GET' : route.method.toUpperCase() as Route['method']
        const key = `${method} ${fullPath}`
        if (routes.has(key)) continue
        const handler = await handlerSource(route.handler, info, parsed, codebasePath)
        const body = handler?.body
        routes.set(key, {
          path: fullPath,
          method,
          type: routeType(method!, fullPath, body),
          requires_auth: mount.auth || requiresAuth(route, info, fullPath, body),
          dynamic_segments: dynamicSegments(fullPath),
          file_path: path.join(codebasePath, info.file),
          ...(handler?.file && handler.file !== info.file ? { handler_file: path.join(codebasePath, handler.file) } : {}),
        })
      }
    }
  }
  return [...routes.values()]
}

// ─── Per-file parsing ────────────────────────────────────────────────────────

async function parseFile(file: string, content: string, codebasePath: string): Promise<ParsedFile> {
  const imports = await localImports(file, content, codebasePath)
  const declared = new Map<string, 'app' | 'router'>()
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>]+\s*)?=\s*(?:new\s+)?(express\s*\.\s*Router|express|Router|fastify|Fastify|Koa|Hono|KoaRouter)\s*\(/g
  for (const m of content.matchAll(declaration)) {
    declared.set(m[1], /^(express|fastify|Fastify|Koa|Hono)$/.test(m[2]) ? 'app' : 'router')
  }
  const isReceiver = (name: string) =>
    !CLIENT_RECEIVER.test(name) && (declared.has(name) || CONVENTIONAL_RECEIVER.test(name))
  const appReceivers = new Set([...declared].filter(([, kind]) => kind === 'app').map(([name]) => name))

  const routes: FileRoute[] = []
  const mounts: Mount[] = []
  const uses: ParsedFile['uses'] = []

  // receiver.method('/path', ...handlers)  and  receiver.use(...)
  const call = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|delete|patch|all|use)\s*\(/g
  for (const m of content.matchAll(call)) {
    const [, receiver, method] = m
    if (!isReceiver(receiver)) continue
    const args = splitArgs(readBalanced(content, m.index! + m[0].length - 1, '(', ')') ?? '')
    if (args.length === 0) continue
    const routePath = stringLiteral(args[0])

    if (method === 'use') {
      if (routePath === undefined) {
        uses.push({ receiver, middleware: args, index: m.index! })
        continue
      }
      if (!routePath.startsWith('/')) continue
      const middleware = args.slice(1, -1)
      const target = resolveMountTarget(args[args.length - 1], file, imports, declared)
      if (target) mounts.push({ receiver, prefix: routePath, index: m.index!, target, middleware })
      continue
    }

    if (routePath === undefined || !routePath.startsWith('/') || args.length < 2) continue
    routes.push({ method: method as Method, path: routePath, receiver, middleware: args.slice(1, -1), handler: args[args.length - 1], index: m.index! })
  }

  // receiver.route('/path').get(handler).post(handler)
  const chain = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(/g
  for (const m of content.matchAll(chain)) {
    if (!isReceiver(m[1])) continue
    const open = m.index! + m[0].length - 1
    const inner = readBalanced(content, open, '(', ')')
    const routePath = inner === undefined ? undefined : stringLiteral(inner.trim())
    if (routePath === undefined || !routePath.startsWith('/')) continue
    let cursor = open + inner!.length + 2
    for (;;) {
      const next = /^\s*\.\s*(get|post|put|delete|patch|all)\s*\(/.exec(content.slice(cursor))
      if (!next) break
      const argsOpen = cursor + next[0].length - 1
      const argText = readBalanced(content, argsOpen, '(', ')')
      if (argText === undefined) break
      const args = splitArgs(argText)
      if (args.length > 0) {
        routes.push({ method: next[1] as Method, path: routePath, receiver: m[1], middleware: args.slice(0, -1), handler: args[args.length - 1], index: m.index! })
      }
      cursor = argsOpen + argText.length + 2
    }
  }

  return { file, content, routes, mounts, uses, imports, appReceivers }
}

function resolveMountTarget(
  arg: string,
  file: string,
  imports: Map<string, string>,
  declared: Map<string, 'app' | 'router'>,
): Mount['target'] | undefined {
  const inline = /^require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(arg.trim())
  if (inline) {
    const resolved = imports.get(`require:${inline[1]}`)
    return resolved ? { file: resolved } : undefined
  }
  const name = /^([A-Za-z_$][\w$]*)(?:\s*\(|$)/.exec(arg.trim())?.[1]
  if (!name) return undefined
  if (declared.get(name) === 'router') return { file, receiver: name }
  const imported = imports.get(name)
  return imported ? { file: imported } : undefined
}

/** Local modules a file imports, by binding name (and `require:<spec>` for inline requires). */
async function localImports(file: string, content: string, codebasePath: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const add = async (name: string, spec: string) => {
    if (!spec.startsWith('.')) return
    const resolved = await resolveModule(path.posix.join(path.posix.dirname(file), spec), codebasePath)
    if (resolved) result.set(name, resolved)
  }
  for (const m of content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) await add(m[1], m[2])
  for (const m of content.matchAll(/\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) {
    for (const name of bindingNames(m[1])) await add(name, m[2])
  }
  for (const m of content.matchAll(/\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"`]([^'"`]+)['"`]/g)) {
    await add(m[1], m[3])
    for (const name of bindingNames(m[2] ?? '')) await add(name, m[3])
  }
  for (const m of content.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"`]([^'"`]+)['"`]/g)) {
    for (const name of bindingNames(m[1])) await add(name, m[2])
  }
  for (const m of content.matchAll(/\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g)) await add(`require:${m[1]}`, m[1])
  return result
}

function bindingNames(list: string): string[] {
  return list.split(',').map(part => part.trim().split(/\s+as\s+|\s*:\s*/).pop()!.trim()).filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
}

async function resolveModule(base: string, codebasePath: string): Promise<string | undefined> {
  const stripped = base.replace(/\.[cm]?js$/, '')
  const candidates = [base, ...['.ts', '.js', '.mts', '.mjs', '.cts', '.cjs'].flatMap(ext => [stripped + ext, `${stripped}/index${ext}`])]
  for (const candidate of candidates) {
    try {
      await readFile(path.join(codebasePath, candidate))
      return path.posix.normalize(candidate)
    } catch { /* try next */ }
  }
  return undefined
}

// ─── Mount prefixes ──────────────────────────────────────────────────────────

/**
 * Every prefix a receiver's routes are served under. A router module mounted
 * with `app.use('/admin', requireAuth, adminRouter)` serves under /admin and
 * inherits the mount's auth; nested mounts compose. Unmounted routers keep
 * their paths as written.
 */
function prefixesFor(
  info: ParsedFile,
  receiver: string,
  parsed: Map<string, ParsedFile>,
  depth = 0,
): Array<{ prefix: string; auth: boolean }> {
  if (depth > 5) return [{ prefix: '', auth: false }]
  const isApp = info.appReceivers.has(receiver) || APP_RECEIVER.test(receiver)
  const found: Array<{ prefix: string; auth: boolean }> = []
  for (const parent of parsed.values()) {
    for (const mount of parent.mounts) {
      if (mount.target.file !== info.file) continue
      if (mount.target.receiver ? mount.target.receiver !== receiver : isApp) continue
      const mountAuth = mount.middleware.some(mw => AUTH_MIDDLEWARE.test(mw)) || authUseBefore(parent, mount.receiver, mount.index)
      for (const outer of prefixesFor(parent, mount.receiver, parsed, depth + 1)) {
        found.push({ prefix: joinPath(outer.prefix, mount.prefix), auth: outer.auth || mountAuth })
      }
    }
  }
  return found.length > 0 ? found : [{ prefix: '', auth: false }]
}

// ─── Typing and auth ─────────────────────────────────────────────────────────

function routeType(method: string, routePath: string, body: string | undefined): Route['type'] {
  if (method !== 'GET') return 'api'
  if (/^\/(api|graphql|rest|v\d+)(\/|$)/i.test(routePath) || /\.(json|xml|csv)$/i.test(routePath)) return 'api'
  if (!body) return 'page'
  const rendersHtml = /\b(res|reply|ctx)\s*\.\s*(render|sendFile|view)\s*\(|\.type\s*\(\s*['"`](text\/)?html|\bres\s*\.\s*send\s*\(\s*['"`]\s*</.test(body)
  const returnsData = /\b(res|reply|ctx)\s*(\.\s*status\s*\([^)]*\))?\s*\.\s*(json|jsonp|sendStatus)\s*\(|\bres\s*\.\s*send\s*\(\s*[{[]/.test(body)
  return returnsData && !rendersHtml ? 'api' : 'page'
}

function requiresAuth(route: FileRoute, info: ParsedFile, fullPath: string, body: string | undefined): boolean {
  if (route.middleware.some(mw => AUTH_MIDDLEWARE.test(mw))) return true
  if (authUseBefore(info, route.receiver, route.index)) return true
  // A handler that sends signed-out users to the login page (not the auth pages themselves).
  return !!body && !AUTH_PATH.test(fullPath) && LOGIN_REDIRECT.test(body) && /\b(session|user|auth|token|login)/i.test(body)
}

/** True when `receiver.use(authMiddleware)` runs before `index` in the file. */
function authUseBefore(info: ParsedFile, receiver: string, index: number): boolean {
  return info.uses.some(use => use.receiver === receiver && use.index < index && use.middleware.some(mw => AUTH_MIDDLEWARE.test(mw)))
}

/**
 * The handler's source: inline functions as written; `handler.method` or a bare
 * name resolved to its definition in this file or a module it imports.
 */
async function handlerSource(
  handler: string,
  info: ParsedFile,
  parsed: Map<string, ParsedFile>,
  codebasePath: string,
): Promise<{ body: string; file: string } | undefined> {
  const text = handler.trim()
  if (/=>|^(async\s+)?function\b/.test(text)) return { body: text, file: info.file }
  const name = /([A-Za-z_$][\w$]*)\s*$/.exec(text.replace(/\.bind\s*\([^)]*\)$/, ''))?.[1]
  if (!name) return undefined

  const searchIn: Array<{ file: string; content: string }> = [{ file: info.file, content: info.content }]
  for (const file of new Set(info.imports.values())) {
    const imported = parsed.get(file)?.content
      ?? await readFile(path.join(codebasePath, file)).then(stripComments).catch(() => undefined)
    if (imported) searchIn.push({ file, content: imported })
  }
  const definition = new RegExp(String.raw`(?:\b${escape(name)}\s*[:=]\s*(?:async\s*)?(?:function\b[^{]*|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)|(?:async\s+)?function\s+${escape(name)}\s*\([^)]*\)|^\s*(?:async\s+)?${escape(name)}\s*\([^)]*\)\s*)\s*\{`, 'm')
  for (const { file, content } of searchIn) {
    const m = definition.exec(content)
    if (!m) continue
    const body = readBalanced(content, m.index + m[0].length - 1, '{', '}')
    if (body !== undefined) return { body: body.slice(0, 8000), file }
  }
  return undefined
}

// ─── Text helpers ────────────────────────────────────────────────────────────

function joinPath(prefix: string, routePath: string): string {
  const joined = `${prefix.replace(/\/+$/, '')}/${routePath.replace(/^\/+/, '')}`.replace(/\/{2,}/g, '/')
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/'
}

function dynamicSegments(routePath: string): string[] {
  return [...routePath.matchAll(/:([A-Za-z_$][\w$]*)/g)].map(m => m[1])
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The value of a string literal argument. Template placeholders become route
 * params: `/${page}` → "/:page" (routes registered in a loop).
 */
function stringLiteral(arg: string): string | undefined {
  const m = /^(['"`])((?:\\.|(?!\1)[\s\S])*)\1$/.exec(arg.trim())
  if (!m) return undefined
  if (m[1] !== '`') return m[2]
  return m[2].replace(/\$\{([^}]*)\}/g, (_all, expr: string) => `:${/([A-Za-z_$][\w$]*)\s*$/.exec(expr)?.[1] ?? 'param'}`)
}

/** Top-level comma-separated arguments of a call. */
function splitArgs(text: string): string[] {
  const args: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    else if (ch === ',' && depth === 0) {
      args.push(text.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = text.slice(start).trim()
  if (last) args.push(last)
  return args
}

/** Text between the opening bracket at `openIdx` and its match, or undefined if unbalanced. */
function readBalanced(text: string, openIdx: number, open: string, close: string): string | undefined {
  let depth = 0
  let quote: string | null = null
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return text.slice(openIdx + 1, i)
  }
  return undefined
}

/** Remove // and /* *\/ comments, keeping strings (and "http://" inside them) intact. */
export function stripComments(source: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const comment = source.slice(i, end === -1 ? source.length : end + 2)
      out += comment.replace(/[^\n]/g, ' ')
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    out += ch
  }
  return out
}
