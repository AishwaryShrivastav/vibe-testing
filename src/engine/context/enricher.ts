import { Gap, RouteBehaviour, CoverageMap, TestScenario, TestStep, FormField, PageFunctionality, PageFeature, PageDialog, TestIntelligence, PageButton } from '../../types/index.js'
import type { MemoryRecommendations } from '../memory/index.js'

let scenarioCounter = 1

export async function generateScenarios(
  gaps: Gap[],
  behaviours: RouteBehaviour[],
  coverage: CoverageMap,
  mode: 'fast' | 'deep',
  recommendations?: MemoryRecommendations
): Promise<TestScenario[]> {
  const recs = recommendations ?? { skip_routes: new Set<string>(), auth_routes: new Set<string>(), timeout_hints: {}, selector_hints: {}, first_run: true, auth_intel: null, saved_credentials: null }

  const topGaps = gaps
    .filter(g => !recs.skip_routes.has(g.route))
    .slice(0, 15)

  const { scenarios: authFlows, protectedPaths } = generateAuthFlowScenarios(topGaps, behaviours, coverage, recs)
  const perRoute = topGaps.flatMap(gap =>
    generateFunctionalScenarios(gap, behaviours, coverage, protectedPaths, recs)
  )

  const redirectChecks = authFlows.filter(s => s.name.includes('redirects to login'))
  const regLogin = authFlows.filter(s => !s.name.includes('redirects to login') && !s.requires_auth)
  const authScenarios = authFlows.filter(s => s.requires_auth)
  return [...redirectChecks, ...regLogin, ...perRoute, ...authScenarios]
}

// ─── Functional Scenario Generation ──────────────────────────────────────────
// Uses code analysis + test intelligence to generate scenarios that test
// ACTUAL FUNCTIONALITY, not just "page loads" or "empty form".

function generateFunctionalScenarios(
  gap: Gap,
  behaviours: RouteBehaviour[],
  coverage: CoverageMap,
  protectedPaths: Set<string>,
  recs?: MemoryRecommendations
): TestScenario[] {
  const behaviour = behaviours.find(b => b.route.path === gap.route)
  const intel = coverage[gap.route]?.intelligence
  const scenarios: TestScenario[] = []

  if (protectedPaths.has(gap.route)) return scenarios

  const paramDependentKeywords = ['reset-password', 'verify-email', 'confirm', 'callback', 'oauth']
  if (paramDependentKeywords.some(k => gap.route.toLowerCase().includes(k))) return scenarios

  const isAuthRoute = ['login', 'register', 'signup', 'signin'].some(k => gap.route.toLowerCase().includes(k))
  const func = behaviour?.functionality
  const hasFunctionalTests = func && (
    func.features.some(f => f.type === 'search' || f.type === 'filter') ||
    func.dialogs.length > 0 ||
    func.buttons.some(b => b.action === 'toggles')
  )

  // Only generate standalone "page loads" if the route has NO functional tests.
  // If it has functional tests, the navigation is built into those tests.
  if (!hasFunctionalTests) {
    scenarios.push(makeScenario(gap.route, `${gap.route} page loads successfully`, [
      { action: 'navigate', url: gap.route, description: `Navigate to ${gap.route}` },
      { action: 'wait', value: '1000', description: 'Wait for page to render' },
      { action: 'assert', description: 'Page loaded without errors' },
    ], gap.priority, 'heuristic'))
  }

  if (func && !isAuthRoute) {
    // Consolidated functional test: load page + interact with key features
    const consolidatedSteps: TestStep[] = [
      { action: 'navigate', url: gap.route, description: `Navigate to ${gap.route}` },
      { action: 'wait', value: '1000', description: 'Wait for page to render' },
    ]
    let hasInteractions = false

    // Search
    if (func.features.some(f => f.type === 'search')) {
      const searchSelector = findSearchSelector(func, intel)
      consolidatedSteps.push(
        { action: 'fill', selector: searchSelector, value: 'test', description: 'Enter search term' },
        { action: 'wait', value: '500', description: 'Wait for search results' },
        { action: 'assert', description: 'Search results or empty state displayed' },
      )
      hasInteractions = true
    }

    // Filter tabs
    if (func.features.some(f => f.type === 'filter')) {
      const filterTexts = findFilterOptions(func, intel)
      if (filterTexts.length > 1) {
        consolidatedSteps.push(
          { action: 'click', selector: `text=${filterTexts[1]}`, description: `Click filter "${filterTexts[1]}"` },
          { action: 'wait', value: '500', description: 'Wait for filtered results' },
        )
        hasInteractions = true
      }
    }

    if (hasInteractions) {
      consolidatedSteps.push({ action: 'assert', description: 'Page interactive features work correctly' })
      scenarios.push(makeScenario(gap.route, `Interact with ${gap.route}`, consolidatedSteps, gap.priority, 'heuristic'))
    }
  }

  // Form validation tests (non-auth pages only)
  if (behaviour?.forms.length && !isAuthRoute) {
    const form = behaviour.forms[0]
    const emailField = form.find(f => f.type === 'email' || f.validations.some(v => v.type === 'email'))

    if (emailField) {
      scenarios.push(makeScenario(gap.route, `Submit ${gap.route} with invalid email`, [
        { action: 'navigate', url: gap.route, description: `Navigate to ${gap.route}` },
        { action: 'wait', value: '500', description: 'Wait for form' },
        { action: 'fill', selector: selectorForField(emailField), value: 'notanemail', description: 'Fill email with invalid format' },
        { action: 'click', selector: 'button[type="submit"]', description: 'Submit form' },
        { action: 'assert', description: behaviour.expected_error ?? 'Error message displayed' },
      ], gap.priority, 'heuristic'))
    }

    scenarios.push(makeScenario(gap.route, `Submit empty form on ${gap.route}`, [
      { action: 'navigate', url: gap.route, description: `Navigate to ${gap.route}` },
      { action: 'wait', value: '500', description: 'Wait for form' },
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit empty form' },
      { action: 'assert', description: 'Validation errors shown for required fields' },
    ], gap.priority, 'heuristic'))
  }

  return scenarios
}

// ─── Helpers: smart value generation using test intelligence ─────────────────

function generateSmartValue(field: FormField, intel?: TestIntelligence): string {
  // If test intelligence has mock data keys matching this field, use domain-relevant values
  if (intel?.mock_data_keys.length) {
    const fieldName = field.name.toLowerCase()
    if (fieldName.includes('name') || fieldName.includes('full_name')) return 'Test User'
    if (fieldName.includes('issue') || fieldName.includes('tag')) return 'Anxiety, Depression'
    if (fieldName.includes('phone') || fieldName.includes('tel')) return '+1-555-000-1234'
    if (fieldName.includes('license')) return 'LIC-12345'
    if (fieldName.includes('location') || fieldName.includes('city')) return 'New York, USA'
    if (fieldName.includes('bio') || fieldName.includes('description')) return 'Experienced professional with 10+ years in the field.'
    if (fieldName.includes('experience') || fieldName.includes('year')) return '5'
  }

  // Also check placeholder for hints
  if (field.placeholder) {
    const ph = field.placeholder.toLowerCase()
    if (ph.includes('name')) return 'Test User'
    if (ph.includes('search')) return 'test query'
    if (ph.includes(',')) return field.placeholder
  }

  return generateValidValue(field)
}

function generateValidValue(field: FormField): string {
  switch (field.type) {
    case 'email':    return 'test@vibetest.dev'
    case 'password': return 'TestPassword123!'
    case 'number':   return '5'
    case 'tel':      return '+1-555-000-1234'
    case 'url':      return 'https://example.com'
    case 'textarea': return 'This is a test entry for automated testing.'
    default:         return 'Test input value'
  }
}

function findSearchSelector(func: PageFunctionality, intel?: TestIntelligence): string {
  // Use test intelligence to find the actual search input selector
  if (intel?.selectors.by_placeholder.length) {
    const searchPh = intel.selectors.by_placeholder.find(p =>
      /search|filter|find/i.test(p)
    )
    if (searchPh) return `placeholder=${searchPh}`
  }

  // Fallback: look for search-related state variables
  const searchVar = func.state_vars.find(v => /search|filter|query/i.test(v))
  if (searchVar) return `input[placeholder*="Search"], input[placeholder*="search"], input[type="search"]`

  return 'input[placeholder*="earch"]'
}

function findFilterOptions(func: PageFunctionality, intel?: TestIntelligence): string[] {
  // Extract filter tab texts from test intelligence
  if (intel?.selectors.by_text.length) {
    const filterTexts = intel.selectors.by_text.filter(t =>
      /^(All|Active|Inactive|Draft|Completed|Pending|Archived|Discharged|Open|Closed)$/i.test(t)
    )
    if (filterTexts.length > 1) return filterTexts
  }

  // Fallback: look for button-like state labels
  const labels = func.data_display.filter(d =>
    /^(All|Active|Inactive|Draft|Completed|Pending)$/i.test(d)
  )
  return labels.length > 1 ? labels : ['All', 'Active']
}

function findButtonByText(buttons: PageButton[], text: string): PageButton | undefined {
  return buttons.find(b =>
    b.text.toLowerCase().includes(text.toLowerCase()) ||
    text.toLowerCase().includes(b.text.toLowerCase())
  )
}

// ─── Auth flow scenarios (unchanged logic, uses same intelligence) ───────────

function generateAuthFlowScenarios(
  gaps: Gap[],
  behaviours: RouteBehaviour[],
  coverage: CoverageMap,
  recs?: MemoryRecommendations
): { scenarios: TestScenario[]; protectedPaths: Set<string> } {
  const scenarios: TestScenario[] = []
  const protectedPaths = new Set<string>()

  const registerGap = gaps.find(g => g.route.includes('register') || g.route.includes('signup'))
  const loginGap = gaps.find(g => g.route.includes('login'))
  const registerBehaviour = behaviours.find(b =>
    b.route.path.includes('register') || b.route.path.includes('signup')
  )
  const loginBehaviour = behaviours.find(b => b.route.path.includes('login'))

  if (!loginGap && !registerGap) return { scenarios, protectedPaths }

  // Use saved credentials if available, otherwise generate new ones for registration
  const savedCreds = recs?.saved_credentials
  const hasSavedCredentials = savedCreds && savedCreds.email && savedCreds.password
  
  const testEmail = hasSavedCredentials ? savedCreds.email : `vt${Math.random().toString(36).slice(2, 8)}@gmail.com`
  const testPassword = hasSavedCredentials ? savedCreds.password : 'Test1234!'

  // Skip registration entirely when we have saved credentials
  if (!hasSavedCredentials && registerGap && registerBehaviour?.forms.length) {
    const regForm = registerBehaviour.forms[0]

    const regSteps: TestStep[] = [
      { action: 'navigate', url: registerGap.route, description: `Navigate to ${registerGap.route}` },
      { action: 'wait', value: '1000', description: 'Wait for registration form' },
    ]

    for (const field of regForm) {
      let value: string
      if (field.type === 'email' || field.name.toLowerCase().includes('email')) {
        value = testEmail
      } else if (field.type === 'password' || field.name.toLowerCase().includes('password')) {
        value = testPassword
      } else if (field.name.toLowerCase().includes('name')) {
        value = 'Vibe Test User'
      } else {
        value = generateSmartValue(field)
      }
      regSteps.push({
        action: 'fill',
        selector: selectorForField(field),
        value,
        description: `Fill ${field.name} with "${value}"`,
      })
    }

    regSteps.push(
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit registration form' },
      { action: 'assert', description: 'Registration succeeded — no errors, page indicates success' },
    )

    scenarios.push(makeScenario(registerGap.route, 'Register new account with valid data', regSteps, 'high', 'heuristic'))
  }

  // Always generate login scenario (with saved creds or freshly registered ones)
  if (loginGap) {
    const loginRoute = loginGap.route
    const loginSteps: TestStep[] = [
      { action: 'navigate', url: loginRoute, description: `Navigate to ${loginRoute}` },
      { action: 'wait', value: '1000', description: 'Wait for login form' },
    ]

    if (loginBehaviour?.forms.length) {
      const loginForm = loginBehaviour.forms[0]
      for (const field of loginForm) {
        let value: string
        if (field.type === 'email' || field.name.toLowerCase().includes('email')) {
          value = testEmail
        } else if (field.type === 'password' || field.name.toLowerCase().includes('password')) {
          value = testPassword
        } else {
          value = generateValidValue(field)
        }
        loginSteps.push({
          action: 'fill',
          selector: selectorForField(field),
          value,
          description: `Fill ${field.name} with "${value}"`,
        })
      }
    } else {
      loginSteps.push(
        { action: 'fill', selector: '[type="email"], [name="email"]', value: testEmail, description: `Fill email with ${testEmail}` },
        { action: 'fill', selector: '[type="password"], [name="password"]', value: testPassword, description: 'Fill password' },
      )
    }

    loginSteps.push(
      { action: 'click', selector: 'button[type="submit"]', description: 'Submit login form' },
      { action: 'assert', description: 'Login succeeded — no errors, page indicates success' },
    )

    const loginLabel = hasSavedCredentials ? 'Login with saved credentials' : 'Login with newly registered credentials'
    scenarios.push(makeScenario(loginRoute, loginLabel, loginSteps, 'high', 'heuristic'))
  }

  const publicPaths = ['login', 'register', 'signup', 'forgot', 'reset', 'privacy', 'terms', 'about']
  const memoryAuthRoutes = recs?.auth_routes ?? new Set<string>()
  const protectedRoutes = gaps.filter(g => {
    if (memoryAuthRoutes.has(g.route)) return true
    const routeBehaviour = behaviours.find(b => b.route.path === g.route)
    const isPublicRoute = publicPaths.some(p => g.route.toLowerCase().includes(p))
    const markedAuth = routeBehaviour?.route.requires_auth
    return markedAuth || (!isPublicRoute && g.route !== '/')
  })

  for (const pg of protectedRoutes) protectedPaths.add(pg.route)

  for (const protectedGap of protectedRoutes.slice(0, 2)) {
    scenarios.push(makeScenario(protectedGap.route, `${protectedGap.route} redirects to login when unauthenticated`, [
      { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route} without authentication` },
      { action: 'wait', value: '2000', description: 'Wait for redirect' },
      { action: 'assert', description: 'Redirected to login page' },
    ], 'medium', 'heuristic'))
  }

  const hasLoginForm = loginBehaviour?.forms.length || loginGap
  if (hasLoginForm) {
    // Gather all protected routes with their intelligence for deep testing
    const routeIntel = new Map<string, { behaviour?: RouteBehaviour; func?: PageFunctionality; intel?: TestIntelligence }>()
    for (const pg of protectedRoutes) {
      const behaviour = behaviours.find(b => b.route.path === pg.route)
      routeIntel.set(pg.route, {
        behaviour,
        func: behaviour?.functionality,
        intel: coverage[pg.route]?.intelligence,
      })
    }

    // ── PHASE 1: Smoke load — verify every protected page is accessible ──
    // Use ONE consolidated scenario to verify all protected routes load (no redirect)
    // This replaces individual "page loads" tests per route
    for (const protectedGap of protectedRoutes) {
      const authLoadScenario = makeScenario(
        protectedGap.route,
        `${protectedGap.route} accessible when authenticated`,
        [
          { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
          { action: 'wait', value: '2000', description: 'Wait for page to render' },
          { action: 'assert', description: 'Page loaded with content, no redirect to login' },
        ],
        'low',
        'heuristic'
      )
      authLoadScenario.requires_auth = true
      scenarios.push(authLoadScenario)
    }

    // ── PHASE 2: Deep CRUD / interaction tests — the senior tester pass ──
    for (const protectedGap of protectedRoutes) {
      const { behaviour, func, intel } = routeIntel.get(protectedGap.route)!

      if (!func) continue

      // ─── CRUD CREATE: Open dialog, fill, submit, verify item in list ───
      for (const dialog of func.dialogs) {
        if (dialog.fields.length === 0) continue

        const triggerButton = findButtonByText(func.buttons, dialog.trigger)
        const triggerSelector = triggerButton
          ? `role=button[name="${triggerButton.text}"]`
          : `text=${dialog.trigger}`

        // Generate a unique value so we can verify it appeared
        const uniqueMarker = `VT-${Math.random().toString(36).slice(2, 6)}`
        const firstTextField = dialog.fields.find(f => f.type === 'text' || f.type === 'unknown')

        const createSteps: TestStep[] = [
          { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
          { action: 'wait', value: '1500', description: 'Wait for page and data to load' },
          { action: 'click', selector: triggerSelector, description: `Click "${dialog.trigger}" to open dialog` },
          { action: 'wait', value: '800', description: 'Wait for dialog animation' },
        ]

        for (const field of dialog.fields) {
          let value = generateSmartValue(field, intel)
          if (field === firstTextField) value = `${uniqueMarker} ${value}`
          createSteps.push({
            action: 'fill',
            selector: selectorForField(field),
            value,
            description: `Fill ${field.placeholder || field.name}`,
          })
        }

        createSteps.push(
          { action: 'click', selector: 'button[type="submit"]', description: `Submit "${dialog.submit_text || 'Add'}"` },
          { action: 'wait', value: '2000', description: 'Wait for item to be created' },
          { action: 'assert', description: `New item created — verify "${uniqueMarker}" appears in list or success toast shown` },
        )

        const createScenario = makeScenario(
          protectedGap.route,
          `Create via ${dialog.title || dialog.trigger} on ${protectedGap.route}`,
          createSteps,
          'high',
          'heuristic'
        )
        createScenario.requires_auth = true
        scenarios.push(createScenario)

        // ─── Also test: open dialog then cancel/close without submitting ───
        const cancelSteps: TestStep[] = [
          { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
          { action: 'wait', value: '1500', description: 'Wait for page to load' },
          { action: 'click', selector: triggerSelector, description: `Click "${dialog.trigger}" to open dialog` },
          { action: 'wait', value: '500', description: 'Wait for dialog' },
          { action: 'fill', selector: selectorForField(dialog.fields[0]), value: 'should not be saved', description: 'Fill first field partially' },
          { action: 'click', selector: 'role=button[name="Close"], role=button[name="Cancel"], button.close, [aria-label="Close"]', description: 'Close dialog without saving' },
          { action: 'wait', value: '500', description: 'Wait for dialog to close' },
          { action: 'assert', description: 'Dialog closed, no new item created, list unchanged' },
        ]
        const cancelScenario = makeScenario(
          protectedGap.route,
          `Cancel ${dialog.title || dialog.trigger} on ${protectedGap.route}`,
          cancelSteps,
          'medium',
          'heuristic'
        )
        cancelScenario.requires_auth = true
        scenarios.push(cancelScenario)

        // ─── Test: submit dialog with empty required fields ───
        const emptySteps: TestStep[] = [
          { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
          { action: 'wait', value: '1500', description: 'Wait for page' },
          { action: 'click', selector: triggerSelector, description: `Click "${dialog.trigger}" to open dialog` },
          { action: 'wait', value: '500', description: 'Wait for dialog' },
          { action: 'click', selector: 'button[type="submit"]', description: 'Submit without filling required fields' },
          { action: 'wait', value: '500', description: 'Wait for validation' },
          { action: 'assert', description: 'Validation error shown or form not submitted — required fields enforced' },
        ]
        const emptyScenario = makeScenario(
          protectedGap.route,
          `Empty submit ${dialog.title || dialog.trigger} on ${protectedGap.route}`,
          emptySteps,
          'medium',
          'heuristic'
        )
        emptyScenario.requires_auth = true
        scenarios.push(emptyScenario)
      }

      // ─── SEARCH + FILTER combined: search, then filter, then clear ───
      const hasSearch = func.features.some(f => f.type === 'search')
      const hasFilter = func.features.some(f => f.type === 'filter')
      if (hasSearch || hasFilter) {
        const interactSteps: TestStep[] = [
          { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
          { action: 'wait', value: '1500', description: 'Wait for page and data to load' },
        ]

        if (hasSearch) {
          const searchSelector = findSearchSelector(func, intel)
          interactSteps.push(
            { action: 'fill', selector: searchSelector, value: 'nonexistent-xyz-999', description: 'Search for term that should return no results' },
            { action: 'wait', value: '800', description: 'Wait for search filter' },
            { action: 'assert', description: 'Empty state or "no results" message displayed' },
            { action: 'fill', selector: searchSelector, value: '', description: 'Clear search to restore full list' },
            { action: 'wait', value: '500', description: 'Wait for list to restore' },
          )
        }

        if (hasFilter) {
          const filterTexts = findFilterOptions(func, intel)
          if (filterTexts.length > 1) {
            interactSteps.push(
              { action: 'click', selector: `text=${filterTexts[1]}`, description: `Apply filter "${filterTexts[1]}"` },
              { action: 'wait', value: '500', description: 'Wait for filtered results' },
              { action: 'click', selector: `text=${filterTexts[0]}`, description: `Switch back to "${filterTexts[0]}"` },
              { action: 'wait', value: '500', description: 'Wait for unfiltered results' },
            )
          }
        }

        interactSteps.push({ action: 'assert', description: 'Search and filter controls work correctly, data updates' })

        const interactScenario = makeScenario(
          protectedGap.route,
          `Search and filter on ${protectedGap.route}`,
          interactSteps,
          'high',
          'heuristic'
        )
        interactScenario.requires_auth = true
        scenarios.push(interactScenario)
      }

      // ─── EDIT/TOGGLE + FORM SUBMIT: full edit lifecycle ───
      const editBtn = func.buttons.find(b => b.action === 'toggles')
      if (editBtn && behaviour?.forms.length) {
        const form = behaviour.forms[0]

        const editSteps: TestStep[] = [
          { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
          { action: 'wait', value: '1500', description: 'Wait for page to render' },
          { action: 'click', selector: `text=${editBtn.text}`, description: `Click "${editBtn.text}" to enter edit mode` },
          { action: 'wait', value: '500', description: 'Wait for fields to become editable' },
        ]

        for (const field of form) {
          editSteps.push({
            action: 'fill',
            selector: selectorForField(field),
            value: generateSmartValue(field, intel),
            description: `Update ${field.name}`,
          })
        }

        editSteps.push(
          { action: 'click', selector: 'button[type="submit"]', description: 'Save changes' },
          { action: 'wait', value: '2000', description: 'Wait for save to complete' },
          { action: 'assert', description: 'Changes saved — success toast or fields updated' },
        )

        const editScenario = makeScenario(
          protectedGap.route,
          `Edit and save on ${protectedGap.route}`,
          editSteps,
          'high',
          'heuristic'
        )
        editScenario.requires_auth = true
        scenarios.push(editScenario)
      } else if (behaviour?.forms.length && !func.dialogs.length) {
        // No toggle button, but has a form — direct form test
        const form = behaviour.forms[0]
        const formSteps: TestStep[] = [
          { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
          { action: 'wait', value: '1000', description: 'Wait for page' },
        ]
        formSteps.push(
          ...form.map(field => ({
            action: 'fill' as const,
            selector: selectorForField(field),
            value: generateSmartValue(field, intel),
            description: `Fill ${field.name}`,
          })),
          { action: 'click', selector: 'button[type="submit"]', description: 'Submit form' },
          { action: 'wait', value: '2000', description: 'Wait for submission result' },
          { action: 'assert', description: behaviour.expected_success ?? 'Form submitted successfully' },
        )

        const formScenario = makeScenario(
          protectedGap.route,
          `Submit form on ${protectedGap.route}`,
          formSteps,
          protectedGap.priority,
          'heuristic'
        )
        formScenario.requires_auth = true
        scenarios.push(formScenario)
      }

      // ─── NAVIGATION: test links between authenticated pages ───
      for (const nav of func.navigation_flows.slice(0, 2)) {
        if (nav.destination.includes('${') || nav.destination.includes(':')) continue
        if (nav.trigger === 'navigation' || nav.trigger === 'link') continue
        // Skip navigation to auth pages (not interesting from authenticated state)
        if (['login', 'register', 'signup'].some(k => nav.destination.includes(k))) continue

        const navScenario = makeScenario(
          protectedGap.route,
          `Navigate from ${protectedGap.route} to ${nav.destination}`,
          [
            { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
            { action: 'wait', value: '1000', description: 'Wait for page' },
            { action: 'click', selector: `text=${nav.trigger}`, description: `Click "${nav.trigger}"` },
            { action: 'wait', value: '1500', description: 'Wait for navigation' },
            { action: 'assert', description: `Navigated to ${nav.destination}` },
          ],
          'low',
          'heuristic'
        )
        navScenario.requires_auth = true
        scenarios.push(navScenario)
      }

      // ─── DATA DISPLAY: verify key stats/labels render with data ───
      if (func.data_display.length > 0) {
        const displayLabels = func.data_display
          .filter(d => !/^(All|Active|Inactive|Draft|Completed|Pending|Archived|Discharged|Open|Closed)$/i.test(d))
          .slice(0, 3)

        if (displayLabels.length > 0) {
          const dataScenario = makeScenario(
            protectedGap.route,
            `Data renders on ${protectedGap.route}`,
            [
              { action: 'navigate', url: protectedGap.route, description: `Navigate to ${protectedGap.route}` },
              { action: 'wait', value: '2000', description: 'Wait for data to load' },
              { action: 'assert', description: `Key content visible: ${displayLabels.map(l => `"${l}"`).join(', ')}` },
            ],
            'medium',
            'heuristic'
          )
          dataScenario.requires_auth = true
          scenarios.push(dataScenario)
        }
      }
    }
  }

  return { scenarios, protectedPaths }
}

// ─── Utility functions ──────────────────────────────────────────────────────

function makeScenario(
  route: string,
  name: string,
  steps: TestStep[],
  priority: Gap['priority'],
  generatedBy: 'ai' | 'heuristic'
): TestScenario {
  return {
    id: `VTS-${String(scenarioCounter++).padStart(3, '0')}`,
    name,
    route,
    priority,
    steps,
    expected_outcome: steps[steps.length - 1].description,
    is_gap: true,
    generated_by: generatedBy,
  }
}

function selectorForField(field: FormField): string {
  // Prefer placeholder — works universally including JSX components without id/name
  if (field.placeholder) return `placeholder=${field.placeholder}`
  // Labels work with getByLabel — but short single-word labels often collide with
  // dialog titles / section headers (Radix, shadcn). Prefer id/name for those.
  if (field.label) {
    const t = field.label.trim()
    const tokens = t.split(/\s+/).length
    if (tokens >= 2 || t.length >= 12) return `label=${field.label}`
  }
  if (field.id) return `#${field.id}`
  if (field.name && field.name !== 'unknown' && !/^[_\d]/.test(field.name)) return `[name="${field.name}"]`
  if (field.type && field.type !== 'text' && field.type !== 'unknown') return `[type="${field.type}"]`
  return `input`
}
