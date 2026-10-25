/**
 * The hub-internal half of `user-management`.
 *
 * Some credential operations must never be reachable over a wire: not tRPC,
 * not the Moleculer mesh, not an addon's `ctx.api`. Putting them on the cap
 * would mount them on all three (an `auth: 'admin'` tier still lets any admin
 * session, and any mesh caller, plant them). So they are not on the cap.
 * `local-auth` attaches them to its in-process provider object under a
 * process-global symbol, and only code running in the hub process that holds
 * that object — the SSO finish, the auth router — can reach them.
 *
 * A symbol does not survive serialization, so the boundary holds by
 * construction: a remote proxy of the provider simply has no such key, and
 * {@link getUserManagementInternal} answers `null` (the caller fails closed).
 */

import type { AuthAuditEvent, AuthAuditRecord } from './auth-audit-log.js'
import type { DeviceCredentialManager } from './device-credential-manager.js'
import type { LoginSessionManager } from './login-session-manager.js'
import type { UserPreferencesStore } from '../builtins/local-auth/user-preferences-store.js'

/** Process-global, so every bundled copy of this module agrees on the key. */
export const USER_MANAGEMENT_INTERNAL: unique symbol = Symbol.for(
  'camstack.user-management.internal',
)

export interface LinkExternalIdentityInput {
  readonly userId: string
  readonly provider: string
  readonly subject: string
  readonly issuer: string
  readonly label?: string
}

/** The login-session table, as the hub uses it (`login-session-manager.ts`). */
export type LoginSessionsInternal = Pick<
  LoginSessionManager,
  | 'create'
  | 'refresh'
  | 'extend'
  | 'check'
  | 'legacyCutoff'
  | 'revoke'
  | 'revokeAllForUser'
  | 'revokeByCredential'
  | 'peekByRefreshToken'
  | 'listForUser'
  | 'listActive'
>

/**
 * Device credentials (D855), as the hub's public `auth` procedures use them.
 * Hub-internal for the same reason as the rest: completing an enrollment or
 * proving a certificate are proofs of possession, never cap calls.
 */
export type DeviceCredentialsInternal = Pick<
  DeviceCredentialManager,
  | 'completeEnrollment'
  | 'enrollSelf'
  | 'issueNonce'
  | 'authenticate'
  | 'renew'
  | 'check'
  | 'get'
  | 'revoke'
  | 'list'
>

export interface SetPasswordInput {
  readonly userId: string
  readonly newPassword: string
  /**
   * The session the change was made from: it stays signed in, every other
   * session of the user ends. Absent — every session ends.
   */
  readonly keepSessionId?: string
}

export interface UserManagementInternal {
  /**
   * Link `(provider, subject)` to `userId`. Idempotent for the same user;
   * throws for an identity linked to another user and for a user that does
   * not exist.
   */
  linkExternalIdentity(input: LinkExternalIdentityInput): Promise<{ readonly success: true }>
  /** Server-side login sessions: create, refresh, check, revoke, list. */
  readonly sessions: LoginSessionsInternal
  /** Change a password and end the user's other sessions (and pre-session tokens). */
  setPassword(input: SetPasswordInput): Promise<void>
  /**
   * OAuth account-link sessions — hub bulk revoke. Active → mark revoked;
   * already revoked → delete the row (so "Remove revoked" clears the list).
   */
  readonly oauthSessions: OauthSessionsInternal
  /** The authentication audit trail. */
  readonly audit: AuthAuditInternal
  /** Device certificates: enrollment legs, challenge, proof, renewal, liveness check. */
  readonly deviceCredentials: DeviceCredentialsInternal
  /**
   * Per-user account preferences (D894). Every method takes the OWNER's id
   * first; the hub's `preferences.*` router stamps it from the principal.
   * Absent on a provider that keeps none.
   */
  readonly preferences?: UserPreferencesInternal
}

/** The account-preferences store, as the hub router uses it. */
export type UserPreferencesInternal = Pick<
  UserPreferencesStore,
  'get' | 'put' | 'delete' | 'changedSince'
>

export interface OauthSessionsInternal {
  revoke(id: string): Promise<boolean>
}

export interface AuthAuditInternal {
  record(event: AuthAuditEvent): Promise<void>
  list(input?: {
    readonly limit?: number
    readonly userId?: string
  }): Promise<readonly AuthAuditRecord[]>
}

/** Attach `internal` to `provider` (returns the same object, now carrying it). */
export function attachUserManagementInternal<T extends object>(
  provider: T,
  internal: UserManagementInternal,
): T {
  Object.defineProperty(provider, USER_MANAGEMENT_INTERNAL, {
    value: internal,
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return provider
}

/** The hub-internal surface of a `user-management` provider, or `null` when it carries none. */
export function getUserManagementInternal(provider: unknown): UserManagementInternal | null {
  if (provider === null || typeof provider !== 'object') return null
  const internal: unknown = Reflect.get(provider, USER_MANAGEMENT_INTERNAL)
  if (internal === null || typeof internal !== 'object') return null
  // Shape is ours: only `attachUserManagementInternal` writes this key.
  return internal as UserManagementInternal
}
