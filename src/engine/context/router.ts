import { Framework, Route } from '../../types/index.js'
import { glob, readFile } from '../../utils/file.js'
import path from 'path'

export async function parseRoutes(framework: Framework, codebasePath: string): Promise<Route[]> {
  switch (framework) {
    case 'nextjs-app':    return parseNextjsAppRoutes(codebasePath)
    case 'nextjs-pages':  return parseNextjsPagesRoutes(codebasePath)
    case 'sveltekit':     return parseSvelteKitRoutes(codebasePath)
    case 'nuxt':          return parseNuxtRoutes(codebasePath)
    case 'vue-spa':       return parseVueSpaRoutes(codebasePath)
    case 'react-spa':     return parseReactSpaRoutes(codebasePath)
    case 'tanstack-router': return parseTanStackRoutes(codebasePath)
    case 'express':       return parseExpressRoutes(codebasePath)
    case 'unknown':       return []
    default:              return []
  }
}

function normalizeTanStackRoute(filePath: string): string | null {
  const routeFile = filePath
    .replace(/^src\/routes\//, '')
    .replace(/\.(tsx|jsx|ts|js)$/, '')

  if (routeFile === '__root') return null

  const escapedValues: string[] = []
  const protectedRouteFile = routeFile.replace(/\[([^\]]+)\]/g, (_match, value: string) => {
    const token = `\uE000${escapedValues.length}\uE001`
    escapedValues.push(value)
    return token
  })
  const restoreEscapes = (segment: string): string => segment.replace(
    /\uE000(\d+)\uE001/g,
    (_match, index: string) => escapedValues[Number(index)] ?? ''
  )

  let routeId = protectedRouteFile
  if (routeId.endsWith('.lazy')) routeId = routeId.slice(0, -'.lazy'.length)

  let isIndexRoute = false
  const terminalToken = routeId.match(/(?:^|[/.])(index|route)$/)?.[1]
  if (terminalToken) {
    isIndexRoute = terminalToken === 'index'
    routeId = routeId.slice(0, -terminalToken.length).replace(/[/.]$/, '')
  }

  const rawSegments = routeId.split(/[/.]/)
  if (rawSegments.some(segment => segment.startsWith('-'))) return null

  const segments = rawSegments
    .filter(segment => !segment.startsWith('_') && !/^\([^)]+\)$/.test(segment))
    .map(segment => segment.replace(/_$/, ''))
    .filter(Boolean)
    .map(segment => segment === '$' ? '*' : segment.replace(/^\$(.+)$/, ':$1'))
    .map(restoreEscapes)

  if (segments.length === 0) return isIndexRoute ? '/' : null
  return `/${segments.join('/')}`
}

async function parseTanStackRoutes(codebasePath: string): Promise<Route[]> {
  const routeFiles = await glob('src/routes/**/*.{tsx,jsx,ts,js}', codebasePath)
  const routes = new Map<string, Route>()

  for (const filePath of routeFiles.sort()) {
    const routePath = normalizeTanStackRoute(filePath)
    if (!routePath) continue

    const existing = routes.get(routePath)
    const isLazyFile = /\.lazy\.(tsx|jsx|ts|js)$/.test(filePath)
    if (existing && (isLazyFile || !existing.file_path?.match(/\.lazy\.(tsx|jsx|ts|js)$/))) {
      continue
    }

    routes.set(routePath, {
      path: routePath,
      type: 'page',
      requires_auth: await inferAuthRequirement(filePath, codebasePath),
      dynamic_segments: extractDynamicSegments(routePath),
      file_path: path.join(codebasePath, filePath),
    })
  }

  return [...routes.values()]
}

function filePathToRoute(filePath: string, _type: 'nextjs-app' | 'nextjs-pages'): string {
  let route = filePath
    .replace(/^src\/app\//, '/')
    .replace(/^app\//, '/')
    .replace(/^src\/pages\//, '/')
    .replace(/^pages\//, '/')
    .replace(/\/page\.(tsx|jsx|ts|js)$/, '')
    .replace(/\.(tsx|jsx|ts|js)$/, '')
    .replace(/\/index$/, '')
    .replace(/\([^)]+\)\//g, '')

  if (route === '') route = '/'
  return route
}

async function parseNextjsAppRoutes(codebasePath: string): Promise<Route[]> {
  const pageFilesApp = await glob('app/**/page.{tsx,jsx,ts,js}', codebasePath)
  const pageFilesSrc = await glob('src/app/**/page.{tsx,jsx,ts,js}', codebasePath)
  const pageFiles = [...pageFilesApp, ...pageFilesSrc]

  const apiFilesApp = await glob('app/**/route.{ts,js}', codebasePath)
  const apiFilesSrc = await glob('src/app/**/route.{ts,js}', codebasePath)
  const apiFiles = [...apiFilesApp, ...apiFilesSrc]

  const pages: Route[] = await Promise.all(pageFiles.map(async (f) => {
    const routePath = filePathToRoute(f, 'nextjs-app')
    const dynamic = extractDynamicSegments(routePath)
    const requiresAuth = await inferAuthRequirement(f, codebasePath)

    return {
      path: routePath,
      type: 'page' as const,
      requires_auth: requiresAuth,
      dynamic_segments: dynamic,
      file_path: path.join(codebasePath, f),
    }
  }))

  const apis: Route[] = await Promise.all(apiFiles.map(async (f) => {
    const routePath = filePathToRoute(f, 'nextjs-app').replace(/\/route$/, '')
    const methods = await extractApiMethods(path.join(codebasePath, f))

    return methods.map(method => ({
      path: routePath,
      method,
      type: 'api' as const,
      requires_auth: false,
      dynamic_segments: extractDynamicSegments(routePath),
      file_path: path.join(codebasePath, f),
    }))
  })).then(r => r.flat())

  return [...pages, ...apis]
}

async function parseNextjsPagesRoutes(codebasePath: string): Promise<Route[]> {
  const pageFiles = await glob('pages/**/!(*.test|*.spec).{tsx,jsx,ts,js}', codebasePath)
  const apiFiles  = await glob('pages/api/**/*.{ts,js}', codebasePath)

  const pages: Route[] = pageFiles
    .filter(f => !f.startsWith('pages/api/') && !f.startsWith('pages/_'))
    .map(f => ({
      path: filePathToRoute(f, 'nextjs-pages'),
      type: 'page' as const,
      requires_auth: false,
      dynamic_segments: extractDynamicSegments(filePathToRoute(f, 'nextjs-pages')),
      file_path: path.join(codebasePath, f),
    }))

  const apis: Route[] = apiFiles.map(f => ({
    path: '/api' + filePathToRoute(f.replace('pages/api', 'pages'), 'nextjs-pages'),
    type: 'api' as const,
    requires_auth: false,
    dynamic_segments: [],
    file_path: path.join(codebasePath, f),
  }))

  return [...pages, ...apis]
}

async function parseSvelteKitRoutes(codebasePath: string): Promise<Route[]> {
  const pageFiles = await glob('src/routes/**/+page.svelte', codebasePath)

  const pages: Route[] = await Promise.all(pageFiles.map(async (f) => {
    let route = f
      .replace(/^src\/routes/, '')
      .replace(/\/\+page\.svelte$/, '')
      .replace(/\(([^)]+)\)\//g, '') // remove layout groups like (app)/
    if (route === '') route = '/'

    return {
      path: route,
      type: 'page' as const,
      requires_auth: await inferAuthRequirement(f, codebasePath),
      dynamic_segments: extractDynamicSegments(route),
      file_path: path.join(codebasePath, f),
    }
  }))

  // SvelteKit server routes (+server.ts/js)
  const serverFiles = await glob('src/routes/**/+server.{ts,js}', codebasePath)
  const apis: Route[] = await Promise.all(serverFiles.map(async (f) => {
    let route = f
      .replace(/^src\/routes/, '')
      .replace(/\/\+server\.(ts|js)$/, '')
      .replace(/\(([^)]+)\)\//g, '')
    if (route === '') route = '/'

    const methods = await extractApiMethods(path.join(codebasePath, f))
    return methods.map(method => ({
      path: route,
      method,
      type: 'api' as const,
      requires_auth: false,
      dynamic_segments: extractDynamicSegments(route),
      file_path: path.join(codebasePath, f),
    }))
  })).then(r => r.flat())

  return [...pages, ...apis]
}

async function parseNuxtRoutes(codebasePath: string): Promise<Route[]> {
  const pageFiles = await glob('pages/**/*.vue', codebasePath)

  const pages: Route[] = await Promise.all(pageFiles.map(async (f) => {
    let route = f
      .replace(/^pages\//, '/')
      .replace(/\.vue$/, '')
      .replace(/\/index$/, '')
    if (route === '') route = '/'

    // Nuxt uses [param] for dynamic segments
    return {
      path: route,
      type: 'page' as const,
      requires_auth: await inferAuthRequirement(f, codebasePath),
      dynamic_segments: extractDynamicSegments(route),
      file_path: path.join(codebasePath, f),
    }
  }))

  // Nuxt server routes (server/api/**)
  const apiFiles = await glob('server/api/**/*.{ts,js}', codebasePath)
  const apis: Route[] = apiFiles.map(f => {
    let route = '/api' + f
      .replace(/^server\/api/, '')
      .replace(/\.(ts|js)$/, '')
      .replace(/\/index$/, '')

    return {
      path: route,
      type: 'api' as const,
      requires_auth: false,
      dynamic_segments: extractDynamicSegments(route),
      file_path: path.join(codebasePath, f),
    }
  })

  return [...pages, ...apis]
}

async function parseVueSpaRoutes(codebasePath: string): Promise<Route[]> {
  const candidates = [
    'src/router/index.ts', 'src/router/index.js',
    'src/router.ts', 'src/router.js',
    'src/routes/index.ts', 'src/routes/index.js',
    'src/routes.ts', 'src/routes.js',
  ]

  for (const candidate of candidates) {
    const filePath = path.join(codebasePath, candidate)
    try {
      const content = await readFile(filePath)
      const routes = extractVueRoutes(content)
      if (routes.length > 0) return routes
    } catch { continue }
  }

  return []
}

function extractVueRoutes(content: string): Route[] {
  const routes: Route[] = []

  // Match Vue Router path definitions: { path: '/about', ... }
  const pathMatches = content.matchAll(/path\s*:\s*['"]([^'"]+)['"]/g)
  for (const match of pathMatches) {
    const routePath = match[1]
    if (routePath !== '*' && routePath !== '/:pathMatch(.*)*') {
      routes.push({
        path: routePath,
        type: 'page',
        requires_auth: false,
        dynamic_segments: extractDynamicSegments(routePath),
      })
    }
  }

  return routes
}

async function parseReactSpaRoutes(codebasePath: string): Promise<Route[]> {
  const candidates = [
    'src/router.tsx', 'src/router.ts', 'src/router.jsx', 'src/router.js',
    'src/routes.tsx', 'src/routes.ts', 'src/routes.jsx', 'src/routes.js',
    'src/App.tsx', 'src/App.ts', 'src/App.jsx', 'src/App.js',
    'src/app.tsx', 'src/app.ts', 'src/app.jsx', 'src/app.js',
  ]

  for (const candidate of candidates) {
    const filePath = path.join(codebasePath, candidate)
    try {
      const content = await readFile(filePath)
      const routes = extractRoutesFromContent(content)
      if (routes.length > 0) {
        const routerDir = path.dirname(path.join(codebasePath, candidate))
        await resolveReactComponentPaths(routes, content, codebasePath, routerDir)
        return routes
      }
    } catch { continue }
  }

  return []
}

async function resolveReactComponentPaths(
  routes: Route[],
  routerContent: string,
  codebasePath: string,
  routerDir: string
): Promise<void> {
  // Extract import map: import Login from './pages/Login' → Login → ./pages/Login
  const importMap: Record<string, string> = {}
  const importPattern = /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g
  for (const match of routerContent.matchAll(importPattern)) {
    importMap[match[1]] = match[2]
  }

  // Also handle lazy imports: const Login = lazy(() => import('./pages/Login'))
  const lazyPattern = /const\s+(\w+)\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const match of routerContent.matchAll(lazyPattern)) {
    importMap[match[1]] = match[2]
  }

  // Named imports from local modules: import { Login, Signup } from './pages'
  const namedImportPattern = /import\s+(?:(\w+)\s*,\s*)?\{([^}]+)\}\s*from\s+['"]([^'"]+)['"]/g
  for (const match of routerContent.matchAll(namedImportPattern)) {
    const source = match[3]
    if (!isLocalImport(source)) continue
    if (match[1]) importMap[match[1]] = source
    for (const spec of match[2].split(',')) {
      const local = spec.trim().split(/\s+as\s+/).pop()?.trim()
      if (local && /^\w+$/.test(local)) importMap[local] = source
    }
  }

  // Match route path to the page component it renders, e.g.
  //   <Route path="/login" element={<Login />} />
  //   <Route path="/pos" element={<PrivateRoute><POSPage /></PrivateRoute>} />
  //   <Route path="/login" element={authed ? <Navigate to="/" /> : <LoginPage />} />
  const pathToComponent = mapRoutesToComponents(routerContent, importMap)

  // Resolve file paths
  const extensions = ['.tsx', '.ts', '.jsx', '.js']

  for (const route of routes) {
    const componentName = pathToComponent[route.path]
    if (!componentName) continue

    const importPath = importMap[componentName]
    if (!importPath) continue

    // Resolve relative to the router file's directory for ./ and ../ imports
    const baseDir = importPath.startsWith('.') ? routerDir : codebasePath

    for (const ext of extensions) {
      const resolved = path.resolve(baseDir, importPath + ext)
      try {
        await readFile(resolved)
        route.file_path = resolved
        break
      } catch { continue }
    }

    if (!route.file_path) {
      for (const ext of extensions) {
        const resolved = path.resolve(baseDir, importPath, 'index' + ext)
        try {
          await readFile(resolved)
          route.file_path = resolved
          break
        } catch { continue }
      }
    }
  }
}

function isLocalImport(source: string): boolean {
  return source.startsWith('.') || source.startsWith('/') || source.startsWith('@/') ||
    source.startsWith('~/') || source.startsWith('src/')
}

/**
 * Walk every <Route ...> opening tag and map its path to the page component
 * rendered by its element/component prop. The element expression may wrap the
 * page (auth guards, layouts, Suspense) or branch (ternaries), so we take the
 * last JSX component in it that is imported from a local module — guards are
 * usually outermost, library components (Navigate, Suspense) aren't local.
 */
export function mapRoutesToComponents(
  content: string,
  importMap: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const start of content.matchAll(/<Route(?=[\s/>])/g)) {
    const tag = readOpeningTag(content, start.index! + start[0].length)
    if (!tag) continue

    const pathMatch = tag.match(/\bpath\s*=\s*(?:['"]([^'"]+)['"]|\{\s*['"`]([^'"`]+)['"`]\s*\})/)
    const routePath = pathMatch?.[1] ?? pathMatch?.[2]
    if (!routePath) continue

    // v5 style: component={Login}
    const componentProp = tag.match(/\b(?:component|Component)\s*=\s*\{\s*(\w+)\s*\}/)
    if (componentProp && importMap[componentProp[1]]) {
      result[routePath] = componentProp[1]
      continue
    }

    const elementStart = tag.search(/\belement\s*=\s*\{/)
    if (elementStart === -1) continue
    const braceIdx = tag.indexOf('{', elementStart)
    const expr = readBalanced(tag, braceIdx)
    if (!expr) continue

    const candidates = [...expr.matchAll(/<([A-Z][\w]*)/g)]
      .map(m => m[1])
      .filter(name => importMap[name] && isLocalImport(importMap[name]))
    if (candidates.length > 0) result[routePath] = candidates[candidates.length - 1]
  }

  return result
}

/** Return the attribute text of a JSX opening tag starting at `from`, up to its closing '>'. */
function readOpeningTag(content: string, from: number): string | null {
  let depth = 0
  let quote: string | null = null
  for (let i = from; i < content.length; i++) {
    const ch = content[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '>' && depth === 0) return content.slice(from, i)
  }
  return null
}

/** Return the text between the brace at `openIdx` and its matching closing brace. */
function readBalanced(text: string, openIdx: number): string | null {
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
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return text.slice(openIdx + 1, i)
  }
  return null
}

async function parseExpressRoutes(codebasePath: string): Promise<Route[]> {
  // Cover both TS layouts (src/routes, src/index.ts) and the common plain-JS
  // layout (routes/, app.js, server.js at the root), incl. ESM/CJS extensions.
  const exts = '{ts,js,mts,mjs,cts,cjs}'
  const routeFiles = await glob(`{src/,}routes/**/*.${exts}`, codebasePath)
  const mainFiles  = await glob(`{src/,}{index,app,server}.${exts}`, codebasePath)

  const routes: Route[] = []

  for (const f of new Set([...routeFiles, ...mainFiles])) {
    const content = await readFile(path.join(codebasePath, f))
    const extracted = extractExpressRoutes(content)
    routes.push(...extracted)
  }

  return routes
}

function extractDynamicSegments(routePath: string): string[] {
  const matches = routePath.match(/\[([^\]]+)\]|:([a-zA-Z]+)/g) || []
  return matches.map(m => m.replace(/[\[\]:]/g, ''))
}

async function inferAuthRequirement(filePath: string, codebasePath: string): Promise<boolean> {
  try {
    const content = await readFile(path.join(codebasePath, filePath))
    const authPatterns = [
      /useAuth\(/,
      /withAuth\(/,
      /requireAuth/,
      /getServerSession/,
      /getSessionUser/,
      /getCurrentUser\(/,
      /currentUser\(\)/,
      /clerkAuth/,
      /useUser\(/,
      /auth\(\)/,
      /redirect\(['"`]\/login/,
      /redirect\(['"`]\/signin/,
      /redirect\(['"`]\/sign-in/,
      /redirect\(['"`]\/auth/,
      /notFound\(\).*session/i,
    ]
    return authPatterns.some(p => p.test(content))
  } catch {
    return false
  }
}

async function extractApiMethods(filePath: string): Promise<Array<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'>> {
  try {
    const content = await readFile(filePath)
    const methods: Array<'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'> = []
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const
    for (const method of validMethods) {
      if (new RegExp(`export\\s+(async\\s+)?function\\s+${method}|export\\s+const\\s+${method}`).test(content)) {
        methods.push(method)
      }
    }
    return methods.length > 0 ? methods : ['GET']
  } catch {
    return ['GET']
  }
}

function extractRoutesFromContent(content: string): Route[] {
  const routes: Route[] = []

  const jsxMatches = content.matchAll(/path=['"]([^'"]+)['"]/g)
  for (const match of jsxMatches) {
    const routePath = match[1]
    if (routePath !== '*') {
      routes.push({
        path: routePath,
        type: 'page',
        requires_auth: false,
        dynamic_segments: extractDynamicSegments(routePath),
      })
    }
  }

  return routes
}

function extractExpressRoutes(content: string): Route[] {
  const routes: Route[] = []
  const methods = ['get', 'post', 'put', 'delete', 'patch'] as const

  for (const method of methods) {
    const pattern = new RegExp(`\\.(${method})\\(['"\`]([^'"\`]+)['"\`]`, 'gi')
    const matches = content.matchAll(pattern)
    for (const match of matches) {
      routes.push({
        path: match[2],
        method: method.toUpperCase() as Route['method'],
        type: 'api',
        requires_auth: false,
        dynamic_segments: extractDynamicSegments(match[2]),
      })
    }
  }

  return routes
}
