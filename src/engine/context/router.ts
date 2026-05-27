import { Framework, Route } from '../../types/index.js'
import { glob, readFile } from '../../utils/file.js'
import path from 'path'

export async function parseRoutes(framework: Framework, codebasePath: string): Promise<Route[]> {
  switch (framework) {
    case 'nextjs-app':    return parseNextjsAppRoutes(codebasePath)
    case 'nextjs-pages':  return parseNextjsPagesRoutes(codebasePath)
    case 'sveltekit':     return parseSvelteKitRoutes(codebasePath)
    case 'nuxt':          return parseNuxtRoutes(codebasePath)
    case 'react-spa':     return parseReactSpaRoutes(codebasePath)
    case 'express':       return parseExpressRoutes(codebasePath)
    case 'unknown':       return []
    default:              return []
  }
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

async function parseReactSpaRoutes(codebasePath: string): Promise<Route[]> {
  const candidates = [
    'src/router.tsx', 'src/router.ts',
    'src/routes.tsx', 'src/routes.ts',
    'src/App.tsx', 'src/App.ts',
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

  // Match route path to component: <Route path="/login" element={<Login />} />
  const routeElementPattern = /path=['"]([^'"]+)['"][^>]*element=\{<(\w+)/g
  const pathToComponent: Record<string, string> = {}
  for (const match of routerContent.matchAll(routeElementPattern)) {
    pathToComponent[match[1]] = match[2]
  }

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

async function parseExpressRoutes(codebasePath: string): Promise<Route[]> {
  const routeFiles = await glob('src/routes/**/*.{ts,js}', codebasePath)
  const mainFiles  = await glob('{src/,}index.{ts,js}', codebasePath)

  const routes: Route[] = []

  for (const f of [...routeFiles, ...mainFiles]) {
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
      /auth\(\)/,
      /redirect\(['"]\/login/,
      /redirect\(['"]\/auth/,
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
