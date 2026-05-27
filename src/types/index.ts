export type Framework =
  | 'nextjs-app'
  | 'nextjs-pages'
  | 'sveltekit'
  | 'nuxt'
  | 'vue-spa'
  | 'react-spa'
  | 'express'
  | 'unknown'

export interface Route {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  type: 'page' | 'api'
  requires_auth: boolean
  dynamic_segments: string[]
  file_path?: string
}

export interface FormField {
  name: string
  type: string
  required: boolean
  validations: Validation[]
  label?: string
  placeholder?: string
  id?: string
}

export interface Validation {
  type: 'min' | 'max' | 'minLength' | 'maxLength' | 'pattern' | 'email' | 'url' | 'custom'
  value?: string | number
  message?: string
}

export interface PageButton {
  text: string
  action: 'opens_dialog' | 'navigates' | 'submits' | 'toggles' | 'unknown'
  target?: string
}

export interface PageDialog {
  trigger: string
  title?: string
  fields: FormField[]
  submit_text?: string
}

export interface PageFeature {
  name: string
  type: 'crud_create' | 'crud_read' | 'crud_update' | 'crud_delete' | 'search' | 'filter' | 'pagination' | 'navigation' | 'display' | 'upload' | 'dialog' | 'other'
  description: string
}

export interface PageFunctionality {
  features: PageFeature[]
  buttons: PageButton[]
  dialogs: PageDialog[]
  navigation_flows: Array<{ trigger: string; destination: string }>
  data_display: string[]
  state_vars: string[]
}

export interface RouteBehaviour {
  route: Route
  forms: FormField[][]
  api_calls: string[]
  functionality?: PageFunctionality
  expected_success?: string
  expected_error?: string
  notes?: string
}

export interface TestInteraction {
  action: 'click' | 'change' | 'type' | 'submit' | 'hover' | 'focus'
  target: string
  value?: string
}

export interface TestIntelligence {
  selectors: {
    by_text: string[]
    by_role: Array<{ role: string; name?: string }>
    by_placeholder: string[]
    by_test_id: string[]
    by_label: string[]
  }
  interactions: TestInteraction[]
  assertions: string[]
  mock_data_keys: string[]
  user_flows: Array<{ description: string; steps: string[] }>
}

export interface CoverageEntry {
  tested: boolean
  scenarios: string[]
  frameworks: string[]
  intelligence?: TestIntelligence
}

export type CoverageMap = Record<string, CoverageEntry>

export interface Gap {
  route: string
  reason: 'no_tests' | 'partial_coverage' | 'flaky_history'
  priority_score: number
  priority: 'high' | 'medium' | 'low'
  untested_aspects?: string[]
}

export type StepAction = 'navigate' | 'fill' | 'click' | 'wait' | 'assert' | 'select' | 'upload'

export interface TestStep {
  action: StepAction
  selector?: string
  value?: string
  url?: string
  timeout?: number
  description: string
}

export interface TestScenario {
  id: string
  name: string
  route: string
  priority: 'high' | 'medium' | 'low'
  steps: TestStep[]
  expected_outcome: string
  is_gap: boolean
  generated_by: 'ai' | 'heuristic'
  requires_auth?: boolean
}

export type TestStatus = 'pass' | 'fail' | 'skip' | 'error'

export interface StepLog {
  step: TestStep
  status: 'ok' | 'failed' | 'skipped'
  url_before: string
  url_after: string
  duration_ms: number
  error?: string
  selector_used?: string
  screenshot_path?: string
}

export interface ApiError {
  url: string
  status: number
  body: string
}

export interface TestResult {
  scenario: TestScenario
  status: TestStatus
  duration_ms: number
  screenshot_path?: string
  current_url?: string
  navigated_url?: string
  failure_reason?: string
  ai_verdict?: string
  step_logs: StepLog[]
  api_errors?: ApiError[]
}

export interface ProductModel {
  project_name: string
  url: string
  framework: Framework
  codebase_path: string
  scanned_at: string
  routes: Route[]
  behaviours: RouteBehaviour[]
  coverage: CoverageMap
  gaps: Gap[]
  scenarios: TestScenario[]
}

export interface Bug {
  id: string
  scenario_name: string
  route: string
  status: 'open' | 'closed'
  found_at: string
  closed_at?: string
  screenshot_path?: string
  steps_to_reproduce: string[]
}

export interface FlakyFlow {
  flow: string
  fail_count: number
  run_count: number
  fail_rate: number
  last_seen: string
}

export interface VerifiedFlow {
  flow: string
  consecutive_passes: number
  last_verified: string
}

export interface Memory {
  project: string
  last_run: string
  run_count: number
  known_bugs: Bug[]
  flaky_flows: FlakyFlow[]
  verified_flows: VerifiedFlow[]
}

// ─── Coverage Gap Suggestions ─────────────────────────────────────────────────

export interface CoverageGapSuggestion {
  route: string
  missing: string
  severity: 'critical' | 'important' | 'nice_to_have'
  suggested_test: {
    name: string
    steps: string[]
  }
}

// ─── Run Result ───────────────────────────────────────────────────────────────

export interface VibeRunResult {
  product_model: ProductModel
  results: TestResult[]
  report: string
  report_path: string
  coverage_gaps: CoverageGapSuggestion[]
  summary: {
    total: number
    passed: number
    failed: number
    errors: number
    duration_ms: number
    elements_explored: number
    api_calls_observed: number
    /** Set by `converge`: baseline + follow-up rounds executed */
    converge_rounds?: number
  }
}
