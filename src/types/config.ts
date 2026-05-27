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
})

export const VibeConfigSchema = z.object({
  url: z.string().url(),
  codebase_path: z.string().optional(),
  auth: AuthConfigSchema.optional(),
  scope: z.object({
    include: z.array(z.string()).default(['/**']),
    exclude: z.array(z.string()).default([]),
    max_routes: z.number().default(30),
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
  mode: z.enum(['fast', 'deep']).default('deep'),
  routes: z.enum(['auto', 'config']).default('auto'),
})

export type VibeConfig = z.infer<typeof VibeConfigSchema>
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
