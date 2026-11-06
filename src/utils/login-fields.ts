/**
 * Shared rules for recognising login form fields from their name, id, label,
 * selector or step description. Used when generating login steps, when
 * locating fields on a live login page, and when remembering which
 * credentials worked.
 */

/** Kind of account identifier a login form asks for. */
export type IdentityKind = 'email' | 'phone' | 'username' | 'id-number'

const PASSWORD_PATTERN = /password|passwd|passcode|\bpass\b/i

/**
 * Identity patterns, most specific first. Sources are exported so the same
 * rules can run inside the browser page (see engine/browser/login-form.ts).
 */
export const IDENTITY_PATTERNS: ReadonlyArray<{ kind: IdentityKind; pattern: RegExp }> = [
  { kind: 'email', pattern: /e-?mail/i },
  { kind: 'phone', pattern: /phone|mobile|\bcell\b|msisdn|\btel\b|telephone|whatsapp/i },
  {
    kind: 'id-number',
    pattern: /(?:employee|customer|member|client|student|patient|policy|staff|badge|national|account|card)[\s_-]?(?:id|no|num|number|code)\b|\b(?:user|login)[\s_-]?id\b/i,
  },
  { kind: 'username', pattern: /user(?:name)?|login|identifier|account|handle/i },
]

/** True when the text describes a password field. */
export function isPasswordField(text: string | undefined): boolean {
  return PASSWORD_PATTERN.test(text ?? '')
}

/**
 * Which kind of account identity the text describes (email, phone number,
 * username, or an ID number such as an employee or customer number), or
 * undefined. A password field is never an identity field, even when its text
 * mentions the account (e.g. "Account password").
 */
export function identityKind(text: string | undefined): IdentityKind | undefined {
  const t = text ?? ''
  if (isPasswordField(t)) return undefined
  return IDENTITY_PATTERNS.find(({ pattern }) => pattern.test(t))?.kind
}

/** True when the text describes the account identity field (email, phone, username or ID number). */
export function isIdentityField(text: string | undefined): boolean {
  return identityKind(text) !== undefined
}

export { PASSWORD_PATTERN }
