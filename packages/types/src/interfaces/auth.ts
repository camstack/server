export { type UserRecord, type TokenScope } from '../schemas/auth-records.js'
import type { UserScope } from '../schemas/auth-records.js'

export interface UserPermissions {
  isAdmin: boolean
  allowedProviders: string[] | '*'
  allowedDevices: Record<string, string[] | '*'>
}

export interface TokenPayload {
  /**
   * The server-side login session this token belongs to. Every session token
   * minted since sessions exist carries one; the hub refuses the token once
   * the session is revoked or expired. A token without it predates sessions.
   */
  sid?: string
  /**
   * The device credential (D855) whose certificate login opened this session.
   * Informational for clients; the hub's authority is the session row, whose
   * refresh re-checks the credential.
   */
  cid?: string
  userId?: string
  username?: string
  /**
   * Admin bypass flag. When true, the middleware skips every scope
   * check. The legacy `role` enum collapsed onto this single boolean
   * in v2.
   */
  isAdmin: boolean
  allowedProviders: string[] | '*'
  allowedDevices: Record<string, string[] | '*'>
  /**
   * Scope grants snapshot at sign-time. Ignored when `isAdmin` is
   * true. Scope changes via `setUserScopes` only take effect on the
   * user's NEXT login — existing JWTs carry the snapshot from
   * issue-time. Re-issue on the client by logging out and back in.
   */
  scopes?: readonly UserScope[]
  iat?: number
  exp?: number
}

export interface AuthenticatedUser {
  id: string
  username: string
  isAdmin: boolean
  permissions: UserPermissions
  isApiKey: boolean
}
