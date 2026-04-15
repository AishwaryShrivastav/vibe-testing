import { CoverageMap, TestIntelligence, TestInteraction } from '../../types/index.js'
import { glob, readFile } from '../../utils/file.js'
import path from 'path'

export async function readExistingTests(codebasePath: string): Promise<CoverageMap> {
  const coverage: CoverageMap = {}

  const [jestFiles, cypressFiles, playwrightFiles] = await Promise.all([
    glob('**/*.{test,spec}.{ts,tsx,js,jsx}', codebasePath),
    glob('cypress/e2e/**/*.{ts,js,cy.ts,cy.js}', codebasePath),
    glob('{playwright/,e2e/,tests/}**/*.{ts,js}', codebasePath),
  ])

  await Promise.all([
    ...jestFiles.map(f => parseTestFile(f, codebasePath, coverage, 'jest')),
    ...cypressFiles.map(f => parseTestFile(f, codebasePath, coverage, 'cypress')),
    ...playwrightFiles.map(f => parseTestFile(f, codebasePath, coverage, 'playwright')),
  ])

  return coverage
}

async function parseTestFile(
  filePath: string,
  codebasePath: string,
  coverage: CoverageMap,
  framework: string
): Promise<void> {
  try {
    const content = await readFile(path.join(codebasePath, filePath))

    const tests = extractTestNames(content)
    const routes = extractRouteHints(content, framework)
    const intelligence = extractTestIntelligence(content)

    // Map route from the component being tested (import path)
    const componentRoute = inferRouteFromImport(content, filePath)

    const allRoutes = [...routes]
    if (componentRoute && !allRoutes.includes(componentRoute)) {
      allRoutes.push(componentRoute)
    }

    for (const route of allRoutes) {
      addToCoverage(coverage, route, tests, framework, intelligence)
    }

    if (allRoutes.length === 0 && tests.length > 0) {
      const key = `__file:${filePath}`
      addToCoverage(coverage, key, tests, framework, intelligence)
    }
  } catch { /* skip unreadable files */ }
}

function extractTestNames(content: string): string[] {
  const tests: string[] = []
  const testPattern = /(?:it|test)\(\s*['"`]([^'"`]+)['"`]/g
  for (const m of content.matchAll(testPattern)) tests.push(m[1])
  return tests
}

function extractTestIntelligence(content: string): TestIntelligence {
  return {
    selectors: extractSelectors(content),
    interactions: extractInteractions(content),
    assertions: extractAssertions(content),
    mock_data_keys: extractMockDataKeys(content),
    user_flows: extractUserFlows(content),
  }
}

function extractSelectors(content: string): TestIntelligence['selectors'] {
  const by_text: string[] = []
  const by_role: Array<{ role: string; name?: string }> = []
  const by_placeholder: string[] = []
  const by_test_id: string[] = []
  const by_label: string[] = []

  // screen.getByText / queryByText / findByText / getAllByText etc.
  for (const m of content.matchAll(/(?:get|query|find)(?:All)?By(?:Text|DisplayValue)\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])/g)) {
    const text = m[1] ?? m[2]
    if (text && !by_text.includes(text)) by_text.push(text)
  }

  // screen.getByRole('button', { name: /text/ })
  for (const m of content.matchAll(/getByRole\(\s*['"`](\w+)['"`](?:\s*,\s*\{[^}]*name:\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`]))?/g)) {
    const role = m[1]
    const name = m[2] ?? m[3]
    if (!by_role.some(r => r.role === role && r.name === name)) {
      by_role.push({ role, name: name || undefined })
    }
  }

  // screen.getByPlaceholderText
  for (const m of content.matchAll(/getByPlaceholderText\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!by_placeholder.includes(m[1])) by_placeholder.push(m[1])
  }

  // screen.getByTestId / data-testid
  for (const m of content.matchAll(/getByTestId\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!by_test_id.includes(m[1])) by_test_id.push(m[1])
  }

  // screen.getByLabelText
  for (const m of content.matchAll(/getByLabelText\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!by_label.includes(m[1])) by_label.push(m[1])
  }

  // Playwright-specific selectors
  for (const m of content.matchAll(/page\.(?:getByText|locator)\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!by_text.includes(m[1])) by_text.push(m[1])
  }
  for (const m of content.matchAll(/page\.getByRole\(\s*['"`](\w+)['"`](?:\s*,\s*\{[^}]*name:\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`]))?/g)) {
    const role = m[1]
    const name = m[2] ?? m[3]
    if (!by_role.some(r => r.role === role && r.name === name)) {
      by_role.push({ role, name: name || undefined })
    }
  }

  // Cypress selectors
  for (const m of content.matchAll(/cy\.(?:get|find|contains)\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (!by_text.includes(m[1])) by_text.push(m[1])
  }

  return { by_text, by_role, by_placeholder, by_test_id, by_label }
}

function extractInteractions(content: string): TestInteraction[] {
  const interactions: TestInteraction[] = []

  // fireEvent.click(screen.getByRole('button', { name: /New Client/ }))
  for (const m of content.matchAll(/fireEvent\.click\([^)]*(?:getBy\w+)\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])/g)) {
    interactions.push({ action: 'click', target: m[1] ?? m[2] })
  }

  // fireEvent.click(screen.getByText("..."))
  for (const m of content.matchAll(/fireEvent\.click\([^)]*getByText\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])/g)) {
    interactions.push({ action: 'click', target: m[1] ?? m[2] })
  }

  // fireEvent.change(element, { target: { value: '...' } })
  for (const m of content.matchAll(/fireEvent\.change\([^)]*(?:getBy\w+)\(\s*['"`]([^'"`]+)['"`][^)]*value:\s*['"`]([^'"`]+)['"`]/g)) {
    interactions.push({ action: 'change', target: m[1], value: m[2] })
  }

  // userEvent.click / type
  for (const m of content.matchAll(/userEvent\.(click|type)\([^)]*(?:getBy\w+)\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])/g)) {
    interactions.push({ action: m[1] as 'click' | 'type', target: m[2] ?? m[3] })
  }

  // Playwright: page.click, page.fill
  for (const m of content.matchAll(/page\.(click|fill)\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*['"`]([^'"`]+)['"`])?\)/g)) {
    interactions.push({
      action: m[1] === 'fill' ? 'type' : 'click',
      target: m[2],
      value: m[3],
    })
  }

  // Cypress: .type(), .click()
  for (const m of content.matchAll(/\.type\(\s*['"`]([^'"`]+)['"`]\)/g)) {
    interactions.push({ action: 'type', target: 'input', value: m[1] })
  }

  return interactions
}

function extractAssertions(content: string): string[] {
  const assertions: string[] = []

  // expect(screen.getByText("...")).toBeInTheDocument()
  for (const m of content.matchAll(/expect\([^)]*(?:getBy\w+)\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])[^)]*\)\.to\w+/g)) {
    const text = m[1] ?? m[2]
    if (text) assertions.push(text)
  }

  // expect(...).toHaveBeenCalledWith(...)
  for (const m of content.matchAll(/expect\((\w+)\)\.toHaveBeenCalledWith\(\s*(\{[^}]+\})/g)) {
    assertions.push(`${m[1]} called with ${m[2].slice(0, 80)}`)
  }

  // Playwright: expect(page).toHaveURL, expect(locator).toHaveText
  for (const m of content.matchAll(/expect\([^)]+\)\.toHave(?:URL|Text)\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])/g)) {
    const val = m[1] ?? m[2]
    if (val) assertions.push(val)
  }

  return [...new Set(assertions)]
}

function extractMockDataKeys(content: string): string[] {
  const keys: string[] = []

  // Extract keys from mock object literals: { key: value, ... }
  // Look for makeXxx functions or mock data objects
  for (const m of content.matchAll(/(?:make\w+|mock\w+)\s*(?:\([^)]*\)\s*:\s*\w+\s*=>|=)\s*(?:\([^)]*\)\s*=>)?\s*\{([^}]{20,})\}/g)) {
    const body = m[1]
    for (const kv of body.matchAll(/(\w+):/g)) {
      if (!keys.includes(kv[1]) && kv[1].length > 1) keys.push(kv[1])
    }
  }

  // Also look for TypeScript type references (tells us about data structure)
  for (const m of content.matchAll(/type\s+\w+.*?=.*?(\w+Response|\w+Data)/g)) {
    if (!keys.includes(m[1])) keys.push(m[1])
  }

  // Import type hints
  for (const m of content.matchAll(/import\s+type\s*\{([^}]+)\}/g)) {
    for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (name.endsWith('Response') || name.endsWith('Data') || name.endsWith('Type')) {
        if (!keys.includes(name)) keys.push(name)
      }
    }
  }

  return keys
}

function extractUserFlows(content: string): Array<{ description: string; steps: string[] }> {
  const flows: Array<{ description: string; steps: string[] }> = []

  // Each it/test block that contains multiple interactions is a user flow
  const testBlocks = content.matchAll(/(?:it|test)\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{([\s\S]*?)(?=\n\s*\}\))/g)

  for (const block of testBlocks) {
    const description = block[1]
    const body = block[2]
    const steps: string[] = []

    // Extract sequential actions from the test body
    for (const action of body.matchAll(/(?:fireEvent|userEvent|screen|page|cy)\.\w+\([^)]*(?:getBy\w+)\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])/g)) {
      const target = action[1] ?? action[2]
      if (target) steps.push(target)
    }

    // Also capture waitFor / expect patterns as verification steps
    for (const assertion of body.matchAll(/expect\([^)]*(?:getBy\w+)\(\s*(?:\/([^/]+)\/|['"`]([^'"`]+)['"`])/g)) {
      const check = assertion[1] ?? assertion[2]
      if (check) steps.push(`verify: ${check}`)
    }

    if (steps.length > 0) {
      flows.push({ description, steps })
    }
  }

  return flows
}

function inferRouteFromImport(content: string, filePath: string): string | null {
  // Match: import Component from "../ComponentName" or "../../pages/ComponentName"
  const importMatch = content.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/)
  if (!importMatch) return null

  const componentName = importMatch[1]
  const importPath = importMatch[2]

  // If importing from pages directory, the component name maps to a route
  if (importPath.includes('/pages/') || importPath.includes('../')) {
    const routeMap: Record<string, string> = {}

    // Build a generic mapping from component name to route
    // Common patterns: Dashboard → /dashboard, Clients → /clients, Profile → /profile
    const name = componentName.toLowerCase()
    if (name === 'login') return '/login'
    if (name === 'register' || name === 'signup') return '/register'
    if (name === 'dashboard' || name === 'home') return '/dashboard'
    if (name === 'notfound') return null

    // Generic: PascalCase → /kebab-case
    const route = '/' + componentName
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '')

    return routeMap[componentName] ?? route
  }

  return null
}

function extractRouteHints(content: string, framework: string): string[] {
  const routes: string[] = []

  // page.goto / cy.visit
  for (const m of content.matchAll(/(?:page\.goto|cy\.visit)\(\s*['"`]([^'"`]+)['"`]/g)) {
    const url = m[1]
    const routePath = url.startsWith('http') ? (() => { try { return new URL(url).pathname } catch { return url } })() : url
    routes.push(routePath)
  }

  // fetch('/api/...')
  for (const m of content.matchAll(/fetch\(\s*['"`](\/[^'"`]+)['"`]/g)) {
    routes.push(m[1])
  }

  // MemoryRouter initialEntries
  for (const m of content.matchAll(/initialEntries=\{\[['"`]([^'"`]+)['"`]\]\}/g)) {
    routes.push(m[1])
  }

  return [...new Set(routes)]
}

function addToCoverage(
  coverage: CoverageMap,
  route: string,
  scenarios: string[],
  framework: string,
  intelligence?: TestIntelligence
): void {
  if (!coverage[route]) {
    coverage[route] = { tested: false, scenarios: [], frameworks: [] }
  }
  coverage[route].tested = true
  coverage[route].scenarios.push(...scenarios)
  if (!coverage[route].frameworks.includes(framework)) {
    coverage[route].frameworks.push(framework)
  }

  // Merge intelligence from multiple test files for the same route
  if (intelligence) {
    if (!coverage[route].intelligence) {
      coverage[route].intelligence = intelligence
    } else {
      const existing = coverage[route].intelligence!
      existing.selectors.by_text.push(...intelligence.selectors.by_text.filter(t => !existing.selectors.by_text.includes(t)))
      existing.selectors.by_role.push(...intelligence.selectors.by_role.filter(r => !existing.selectors.by_role.some(e => e.role === r.role && e.name === r.name)))
      existing.selectors.by_placeholder.push(...intelligence.selectors.by_placeholder.filter(t => !existing.selectors.by_placeholder.includes(t)))
      existing.selectors.by_test_id.push(...intelligence.selectors.by_test_id.filter(t => !existing.selectors.by_test_id.includes(t)))
      existing.selectors.by_label.push(...intelligence.selectors.by_label.filter(t => !existing.selectors.by_label.includes(t)))
      existing.interactions.push(...intelligence.interactions)
      existing.assertions.push(...intelligence.assertions.filter(a => !existing.assertions.includes(a)))
      existing.mock_data_keys.push(...intelligence.mock_data_keys.filter(k => !existing.mock_data_keys.includes(k)))
      existing.user_flows.push(...intelligence.user_flows)
    }
  }
}
