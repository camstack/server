/**
 * The VeSync session kept across restarts, one per integration.
 *
 * A sign-in mints a token; signing in on every start is what VeSync answered with "auth code
 * expired" refusals. The session is therefore persisted and adopted on the next start when it is
 * still for the same credentials and not about to expire.
 *
 * Storage: a durable-state list in the addon store, one row per integration. The token and the
 * credentials fingerprint are hidden secrets (`secretStatePaths`, {@link VESYNC_SESSION_SECRET_PATHS}):
 * the keychain holds them, the blob holds markers. The fingerprint is a hash of email, password,
 * region and country code, so a changed credential invalidates the session without the password
 * ever being compared in the clear; it sits in the keychain too, so the blob gives nothing to
 * guess a password against.
 */
import { createHash } from 'node:crypto'
import type { DurableState } from '@camstack/types'
import { z } from 'zod'
import type { VeSyncConnectionConfig } from './config.js'
import type { VeSyncSession } from './vesync-client-contract.js'

/** The addon-store key the session rows live under. */
export const VESYNC_SESSIONS_STATE_KEY = 'vesyncSessions'

/** Hidden-state secrets: each row's token and credentials fingerprint (rows addressed by id). */
export const VESYNC_SESSION_SECRET_PATHS: readonly string[] = [
  `${VESYNC_SESSIONS_STATE_KEY}[integrationId].token`,
  `${VESYNC_SESSIONS_STATE_KEY}[integrationId].fingerprint`,
]

/**
 * A session whose token expires within this margin is not adopted: a start would sign in a few
 * minutes later anyway, mid-poll.
 */
export const VESYNC_SESSION_EXPIRY_MARGIN_S = 60 * 60

/** One persisted session row. */
export const vesyncStoredSessionSchema = z.object({
  integrationId: z.string().min(1),
  fingerprint: z.string().min(1).meta({ secret: true }),
  token: z.string().min(1).meta({ secret: true }),
  accountId: z.string().min(1),
  countryCode: z.string().nullable(),
  region: z.string(),
  apiBaseUrl: z.string(),
  authFlowUsed: z.enum(['legacy', 'new']).nullable(),
  issuedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
})

export type VeSyncStoredSession = z.infer<typeof vesyncStoredSessionSchema>

/** The durable list every integration's row lives in. */
export const vesyncStoredSessionsSchema = z.array(vesyncStoredSessionSchema)

export type VeSyncStoredSessions = z.infer<typeof vesyncStoredSessionsSchema>

/** One integration's view of the store. */
export interface VeSyncSessionStore {
  load(integrationId: string): Promise<VeSyncStoredSession | null>
  save(row: VeSyncStoredSession): Promise<void>
  clear(integrationId: string): Promise<void>
  /**
   * Drop every row whose integration is not in `existing` — the reconcile's answer to a delete
   * event that was dropped, or a sign-in that saved after its integration was deleted.
   */
  prune(existing: ReadonlySet<string>): Promise<void>
}

/**
 * The store over the addon's durable state. Writes are serialized: two accounts saving at once
 * read-modify-write the same list, and the second must see the first.
 */
export function createVeSyncSessionStore(
  state: DurableState<VeSyncStoredSessions>,
): VeSyncSessionStore {
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = (fn: () => Promise<void>): Promise<void> => {
    const next = queue.then(fn)
    queue = next.catch((): null => null)
    return next
  }
  return {
    load: async (integrationId) =>
      (await state.get()).find((row) => row.integrationId === integrationId) ?? null,
    save: (row) =>
      serialized(() =>
        state.update((rows) => [...rows.filter((r) => r.integrationId !== row.integrationId), row]),
      ),
    clear: (integrationId) =>
      serialized(async () => {
        const rows = await state.get()
        if (!rows.some((r) => r.integrationId === integrationId)) return
        await state.set(rows.filter((r) => r.integrationId !== integrationId))
      }),
    prune: (existing) =>
      serialized(async () => {
        const rows = await state.get()
        const kept = rows.filter((r) => existing.has(r.integrationId))
        if (kept.length === rows.length) return
        await state.set(kept)
      }),
  }
}

/** The hash a session is bound to: a change to any of these signs in fresh. */
export function vesyncCredentialsFingerprint(connection: VeSyncConnectionConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        connection.email.trim().toLowerCase(),
        connection.password,
        connection.region,
        connection.countryCode ?? null,
      ]),
    )
    .digest('hex')
}

/** Why a start signed in instead of adopting the stored session. */
export type VeSyncSignInReason = 'none-stored' | 'expired' | 'account-changed' | 'rejected'

/** What a start does with the stored session. */
export type VeSyncRestoreDecision =
  | { readonly kind: 'restore'; readonly session: VeSyncSession }
  | { readonly kind: 'sign-in'; readonly reason: VeSyncSignInReason }

/**
 * Adopt the stored session only when it was minted for these exact credentials and its token
 * (when it says when) outlives {@link VESYNC_SESSION_EXPIRY_MARGIN_S}.
 */
export function decideSessionRestore(
  stored: VeSyncStoredSession | null,
  fingerprint: string,
  nowMs: number,
): VeSyncRestoreDecision {
  if (stored === null) return { kind: 'sign-in', reason: 'none-stored' }
  if (stored.fingerprint !== fingerprint) return { kind: 'sign-in', reason: 'account-changed' }
  if (
    stored.expiresAt !== null &&
    stored.expiresAt - VESYNC_SESSION_EXPIRY_MARGIN_S <= Math.floor(nowMs / 1000)
  ) {
    return { kind: 'sign-in', reason: 'expired' }
  }
  return { kind: 'restore', session: sessionOfRow(stored) }
}

/** A stored row → the session a client adopts. */
export function sessionOfRow(row: VeSyncStoredSession): VeSyncSession {
  return {
    token: row.token,
    accountId: row.accountId,
    countryCode: row.countryCode,
    region: row.region,
    apiBaseUrl: row.apiBaseUrl,
    authFlowUsed: row.authFlowUsed,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
  }
}

/** A session the client minted → the row persisted for this integration. */
export function rowOfSession(
  integrationId: string,
  fingerprint: string,
  session: VeSyncSession,
): VeSyncStoredSession {
  return { integrationId, fingerprint, ...session }
}
