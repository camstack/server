/**
 * The hub's session signing key — the HMAC key every JWT this hub mints
 * (sessions, SSO bridge, TOTP challenges, service tokens) is signed with.
 *
 * It lives in the keychain, owner `system` ({@link JWT_SIGNING_KEY_REF}), and
 * nowhere else: no environment variable, no `config.yaml` key (D797). The
 * hub's `local-auth` builtin loads it after the keychain booted and registers
 * it here; every `AuthManager` in the process asks this slot on every mint and
 * every verify, so a key that arrives (or changes) after construction is used
 * from the next call on.
 *
 * ## A locked keychain fails closed, visibly
 *
 * While the key cannot be read, sessions can be neither minted nor verified:
 * {@link JwtSigningKeySource.current} throws {@link JwtSigningKeyUnavailableError}
 * (a login answers that error, a bearer check reads it as "not authenticated").
 * There is deliberately NO fallback — not an env var, and not a fresh random
 * key, which would invalidate every session and every app token without
 * anyone having asked for it. A key is generated ONLY when the keychain
 * answers that none is stored (`missing`), i.e. on a fresh hub.
 *
 * Process-global through a registered symbol, like the desktop platform key,
 * so a second copy of this module (an addon bundle) sees the same key.
 */
import { randomBytes } from 'node:crypto'
import { buildSecretRef, type SecretsAccess } from '@camstack/types'

/** The keychain owner of every system-held secret. */
export const SYSTEM_SECRET_OWNER = 'system'

/** `secret://system/global/jwtSigningKey`. */
export const JWT_SIGNING_KEY_REF: string = buildSecretRef({
  owner: SYSTEM_SECRET_OWNER,
  scope: { kind: 'global' },
  fieldPath: 'jwtSigningKey',
})

export type JwtSigningKeyState =
  | { readonly state: 'ready'; readonly key: string }
  | { readonly state: 'unavailable'; readonly reason: string }

/** Sessions cannot be minted or verified: the signing key is not loaded. */
export class JwtSigningKeyUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(
      `sessions are unavailable: the session signing key could not be read from the keychain (${reason}). ` +
        'Unlock the keychain (System → Secrets, or fix keychain.keyFile and restart).',
    )
    this.name = 'JwtSigningKeyUnavailableError'
  }
}

/** Where an `AuthManager` gets its key. `current()` throws while there is none. */
export interface JwtSigningKeySource {
  current(): string
}

const SLOT = Symbol.for('camstack.auth.jwt-signing-key')
const NOT_LOADED: JwtSigningKeyState = { state: 'unavailable', reason: 'not-loaded' }

function isState(value: unknown): value is JwtSigningKeyState {
  if (value === null || typeof value !== 'object') return false
  const state: unknown = Reflect.get(value, 'state')
  if (state === 'ready') return typeof Reflect.get(value, 'key') === 'string'
  return state === 'unavailable' && typeof Reflect.get(value, 'reason') === 'string'
}

/** Register the loaded (or unloadable) key. Called by the hub's `local-auth`. */
export function setProcessJwtSigningKey(state: JwtSigningKeyState): void {
  Reflect.set(globalThis, SLOT, state)
}

/** Forget the key (tests, shutdown). */
export function clearProcessJwtSigningKey(): void {
  Reflect.deleteProperty(globalThis, SLOT)
}

export function getProcessJwtSigningKeyState(): JwtSigningKeyState {
  const value: unknown = Reflect.get(globalThis, SLOT)
  return isState(value) ? value : NOT_LOADED
}

/** The process slot — the default source of every `AuthManager`. */
export const processJwtSigningKey: JwtSigningKeySource = {
  current(): string {
    const state = getProcessJwtSigningKeyState()
    if (state.state === 'ready') return state.key
    throw new JwtSigningKeyUnavailableError(state.reason)
  },
}

/** A fixed key — tests, and nothing else. */
export function staticJwtSigningKey(key: string): JwtSigningKeySource {
  return { current: () => key }
}

/** 32 random bytes, hex. */
export function generateJwtSigningKey(): string {
  return randomBytes(32).toString('hex')
}

export interface LoadJwtSigningKeyDeps {
  /** A keychain handle acting for owner `system`. */
  readonly secrets: SecretsAccess
  readonly generate?: () => string
}

/**
 * Read the key from the keychain; generate and store one ONLY when the
 * keychain answers that none exists. Never throws.
 */
export async function loadJwtSigningKey(deps: LoadJwtSigningKeyDeps): Promise<JwtSigningKeyState> {
  let entry: Awaited<ReturnType<SecretsAccess['resolve']>>[string] | undefined
  try {
    entry = (await deps.secrets.resolve([JWT_SIGNING_KEY_REF]))[JWT_SIGNING_KEY_REF]
  } catch (err: unknown) {
    return { state: 'unavailable', reason: err instanceof Error ? err.message : String(err) }
  }
  if (entry === undefined) return { state: 'unavailable', reason: 'no-answer' }
  switch (entry.kind) {
    case 'value':
      return { state: 'ready', key: entry.value }
    case 'unavailable':
      return { state: 'unavailable', reason: entry.reason }
    case 'forbidden':
      return { state: 'unavailable', reason: 'forbidden' }
    case 'missing': {
      const key = (deps.generate ?? generateJwtSigningKey)()
      try {
        await deps.secrets.put(JWT_SIGNING_KEY_REF, key)
      } catch (err: unknown) {
        return {
          state: 'unavailable',
          reason: `could not store a new key: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
      return { state: 'ready', key }
    }
  }
}
