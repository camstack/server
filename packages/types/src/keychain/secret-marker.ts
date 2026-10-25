/**
 * What a settings blob holds where a secret used to be.
 *
 * A keychain-stored field never holds its value. It holds a self-describing
 * MARKER, `{"$secret":"secret://…","v":1}` — an object, never a string, so no
 * code can mistake it for a credential and no form can send it to a camera as
 * a password. The empty state is `null` / absent, never `''`.
 *
 * The same shapes travel to and from the admin UI:
 *
 *  - read: `hydrateSchema` hands a secret field a {@link SecretFieldView}
 *    (`{ $secret, v, set: true }`) or `null` — the browser learns whether a
 *    value is set, never the value.
 *  - write: an untouched field submits the view back unchanged (KEEP); a typed
 *    value is a plain non-empty string (CHANGE); the Clear button submits
 *    {@link SECRET_CLEAR} (CLEAR). `''`, `null` and the legacy redaction tokens
 *    are KEEP — an empty string is what a defaults-fallback pushes back, and
 *    treating it as "clear" is how a save destroyed a stored credential before.
 *
 * Pure and browser-safe.
 */
import { REDACTED_SECRET } from '../interfaces/config-ui-secrets.js'

/** The marker a settings blob stores in place of a secret value. */
export interface SecretMarker {
  readonly $secret: string
  readonly v: 1
}

/**
 * What a read surface hands the UI for a secret field that holds something.
 * `$secret` is `null` when the stored value predates the keychain (it is still
 * plaintext in the blob until the operator's one-off migration moves it): the
 * UI draws "set" either way and the value never leaves the hub.
 */
export interface SecretFieldView {
  readonly $secret: string | null
  readonly v: 1
  readonly set: true
  /** The stored value is still inline plaintext (pre-keychain). */
  readonly inline?: true
}

/** The explicit "remove this secret" instruction a form sends. */
export interface SecretClearInstruction {
  readonly $secretClear: true
}

export const SECRET_CLEAR: SecretClearInstruction = { $secretClear: true }

/** The `'***'` token D634 redaction writes for non-admins. */
const LEGACY_DEVICE_REDACTION = '***'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function makeSecretMarker(ref: string): SecretMarker {
  return { $secret: ref, v: 1 }
}

/** A stored marker: an object whose `$secret` is a non-empty string. */
export function isSecretMarker(value: unknown): value is SecretMarker {
  if (!isRecord(value)) return false
  const ref = value['$secret']
  return typeof ref === 'string' && ref.length > 0
}

/** Anything carrying a `$secret` key — a stored marker or a UI view of one. */
export function isSecretMarkerLike(value: unknown): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, '$secret')
}

export function isSecretClear(value: unknown): value is SecretClearInstruction {
  return isRecord(value) && value['$secretClear'] === true
}

export function isSecretFieldView(value: unknown): value is SecretFieldView {
  return isRecord(value) && value['set'] === true && isSecretMarkerLike(value)
}

/**
 * The UI view of a stored secret field value: a marker becomes "set", inline
 * plaintext becomes "set (inline)", nothing becomes `null`. A value never
 * survives this function.
 */
export function toSecretFieldView(stored: unknown): SecretFieldView | null {
  if (isSecretMarker(stored)) return { $secret: stored.$secret, v: 1, set: true }
  if (typeof stored === 'string' && stored.length > 0) {
    return { $secret: null, v: 1, set: true, inline: true }
  }
  return null
}

/** How an incoming value for a secret path is to be treated. */
export type SecretWriteIntent =
  | { readonly kind: 'keep' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'set'; readonly value: string }

/**
 * Classify an incoming value for a secret path. Only a non-empty string that is
 * not a redaction token sets a value; only {@link SECRET_CLEAR} clears.
 * Everything else — a marker (ours or anyone's), a UI view, `''`, `null`,
 * `undefined`, a redaction token, a non-string — keeps what is stored.
 */
export function classifySecretWrite(incoming: unknown): SecretWriteIntent {
  if (isSecretClear(incoming)) return { kind: 'clear' }
  if (typeof incoming !== 'string') return { kind: 'keep' }
  if (incoming.length === 0) return { kind: 'keep' }
  if (incoming === REDACTED_SECRET || incoming === LEGACY_DEVICE_REDACTION) {
    return { kind: 'keep' }
  }
  return { kind: 'set', value: incoming }
}
