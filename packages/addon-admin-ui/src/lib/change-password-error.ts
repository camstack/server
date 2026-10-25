/**
 * Why a password change failed, read from the tRPC error the hub sent.
 *
 * A request whose socket closed under it reaches the client as a tRPC error
 * with NO server payload and the message "Unknown error" — the text an
 * operator saw after the first-run change ended his own session. A failure is
 * named here so the page never shows that string for a case it knows.
 */

export type ChangePasswordFailure =
  | { readonly kind: 'wrong-current' }
  | { readonly kind: 'session-ended' }
  | { readonly kind: 'connection-lost' }
  | { readonly kind: 'rejected'; readonly message: string }

/** The stable server code for a wrong current password (D863 catalog). */
const PASSWORD_INCORRECT_CODE = 'auth.password-incorrect'

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

export function classifyChangePasswordError(err: unknown): ChangePasswordFailure {
  if (!(err instanceof Error)) return { kind: 'connection-lost' }
  const data = readField(err, 'data')
  // No server payload: the hub never answered this request.
  if (typeof data !== 'object' || data === null) return { kind: 'connection-lost' }
  if (readField(readField(data, 'i18n'), 'code') === PASSWORD_INCORRECT_CODE) {
    return { kind: 'wrong-current' }
  }
  if (readField(data, 'code') === 'UNAUTHORIZED') return { kind: 'session-ended' }
  return { kind: 'rejected', message: err.message }
}
