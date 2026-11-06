import { z } from 'zod'

export const AuthConfigSchema = z.object({
  strategy: z.enum(['credentials', 'basic', 'skip']).default('skip'),
  login_url: z.string().optional(),
  fields: z.object({
    email: z.string().default('email'),
    password: z.string().default('password'),
  }).optional(),
  credentials: z.object({
    email: z.string(),
    password: z.string(),
  }).optional(),
  /**
   * More accounts on the same login form. With two different accounts
   * (credentials + one here, or two here), runs check that one user cannot
   * open the other's pages. `email` is the login identifier (email, username, …).
   */
  accounts: z.array(z.object({
    name: z.string().optional(),
    credentials: z.object({
      email: z.string(),
      password: z.string(),
    }),
  })).optional(),
})

export const VibeConfigSchema = z.object({
  url: z.string().url(),
  codebase_path: z.string().optional(),
  auth: AuthConfigSchema.optional(),
  scope: z.object({
    include: z.array(z.string()).default(['/**']),
    exclude: z.array(z.string()).default([]),
    max_routes: z.number().default(30),
    seed_routes: z.array(z.string()).default([]),
    /**
     * What "changed" is compared against for mode "auto" / "changed": a
     * branch, tag or commit. Default: the commit of the last vibe-test run
     * (stored in .vibe/baseline.json), plus uncommitted changes.
     */
    since: z.string().optional(),
  }).optional(),
  never_interact: z.array(z.string()).default([]),
  memory: z.object({
    verify_after_n_passes: z.number().default(3),
    max_runs_stored: z.number().default(20),
  }).optional(),
  browser: z.object({
    headed: z.boolean().default(true),
    slowMo: z.number().default(40),
    timeout: z.number().default(30000),
  }).optional(),
  /**
   * How much to test each page.
   * "deep" (default): every page thoroughly (all checks).
   * "fast": every page lightly: load, server/console errors, broken values
   *   and resources, blank page; no clicks or submissions.
   * "auto": change-based: pages changed since `scope.since` thoroughly,
   *   indirectly affected pages at standard depth, all others lightly. With no
   *   baseline yet (first run) it behaves like "deep".
   * "changed": only changed and affected pages, thoroughly; nothing else.
   */
  mode: z.enum(['fast', 'deep', 'auto', 'changed']).default('deep'),
  /**
   * Extra attempts for operations that should succeed: logins (resubmitted on
   * the same page), scenarios and crawl page loads. Success on a retry is
   * always reported as a finding, never hidden. 0 disables retries (use it
   * when repeating an action has side effects, e.g. payments).
   */
  retries: z.number().int().min(0).max(2).default(1),
  /** @deprecated Accepted for old config files and ignored; use `scope` to choose pages. */
  routes: z.enum(['auto', 'config']).default('auto'),
  /**
   * What exploration may change in the app under test.
   * "safe" (default): create new records (add/create forms, "add" buttons,
   * probes on blank forms) but never overwrite existing values or submit forms
   * that edit existing data (settings, profile, branding…).
   * "all": also overwrite existing values and test edit forms.
   * "none": no data-changing submissions.
   * Every data-changing request is reported either way.
   */
  explore: z.object({
    writes: z.enum(['safe', 'all', 'none']).default('safe'),
  }).optional(),
})

export type VibeConfig = z.infer<typeof VibeConfigSchema>
export type RunMode = VibeConfig['mode']
export type VibeConfigInput = z.input<typeof VibeConfigSchema>
export type AuthConfig = z.infer<typeof AuthConfigSchema>

// ─── VIBE.md parsed guidance ──────────────────────────────────────────────────

export interface VibeGuidance {
  test_framework?: string
  auth_strategy?: string
  login_url?: string
  known_flaky?: string[]
  never_automate?: string[]
  env_vars?: string[]
  notes?: string[]
  raw: string
}
