/**
 * Shared rules for recognising login form fields from their name, id, label,
 * selector or step description. Used when generating login steps and when
 * remembering which credentials worked.
 */

const PASSWORD_PATTERN = /password|passwd|passcode|\bpass\b/i
const IDENTITY_PATTERN = /e-?mail|user(name)?|login|identifier|account/i

/** True when the text describes a password field. */
export function isPasswordField(text: string | undefined): boolean {
  return PASSWORD_PATTERN.test(text ?? '')
}

/**
 * True when the text describes the account identity field (email or username).
 * A password field is never an identity field, even when its text mentions
 * the account (e.g. "Account password").
 */
export function isIdentityField(text: string | undefined): boolean {
  const t = text ?? ''
  return !isPasswordField(t) && IDENTITY_PATTERN.test(t)
}
