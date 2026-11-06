/**
 * Paths that end the session or change data just by being opened
 * (GET /logout, /items/3/delete). Never visit them as test pages: a logout
 * route in the signed-in session would sign out every check after it.
 */
export const DESTRUCTIVE_PATH = /(?:^|\/)(?:logout|log-out|signout|sign-out|delete|remove|destroy|cancel|unsubscribe|revoke)(?:\/|$)/i

export function isDestructivePath(path: string): boolean {
  return DESTRUCTIVE_PATH.test(path)
}
