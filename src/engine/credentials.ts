import type { VibeConfig } from '../types/config.js'
import type { MemoryRecommendations } from './memory/index.js'

/**
 * Inject explicit auth.credentials from the config into the recommendations
 * bundle so the scenario generator uses real creds instead of inventing
 * random ones. Config wins over memory — the user just told us which account
 * to test as.
 */
export function mergeConfigCredentials(
  recs: MemoryRecommendations,
  config: VibeConfig
): MemoryRecommendations {
  const creds = config.auth?.credentials
  if (!creds?.email || !creds?.password) return recs
  return {
    ...recs,
    saved_credentials: {
      email: creds.email,
      password: creds.password,
      registered_at: recs.saved_credentials?.registered_at ?? new Date().toISOString(),
      last_login_success: recs.saved_credentials?.last_login_success,
    },
  }
}
