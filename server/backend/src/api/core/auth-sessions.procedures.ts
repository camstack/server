/**
 * Login-session procedures of the `auth` router: refresh, logout, and the
 * sessions lists (own, and all for an admin). The table itself is
 * `local-auth`'s (`login-session-manager.ts`), reached through its
 * hub-internal surface; the mint is `auth/session-mint.ts`.
 */
import type { CapabilityRegistry } from '@camstack/system'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { DEVICE_REFRESH_REFUSAL_PREFIX, type DeviceRefusalReason } from '@camstack/types'
import { userManagementInternal } from '../../auth/hub-sessions.js'
import {
  type SessionMinter,
  type SessionRefreshRefusal,
  SessionRefreshRefusedError,
  SessionUserGoneError,
} from '../../auth/session-mint.js'
import {
  adminProcedure,
  protectedProcedure,
  type publicProcedure,
} from '../trpc/trpc.middleware.js'
import { trpcUserError } from '../trpc/user-error.js'

/** One login session as the UI lists it. */
export const LoginSessionSchema = z.object({
  id: z.string(),
  userId: z.string(),
  method: z.string(),
  refreshable: z.boolean(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  expiresAt: z.number(),
  client: z.string().nullable(),
  ip: z.string().nullable(),
  /** The session this request was made with. */
  current: z.boolean(),
})

/** What a refresh returns: a new access token and the rotated refresh token. */
export const RefreshResultSchema = z.object({
  token: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  sessionId: z.string(),
  sessionExpiresAt: z.number(),
  user: z.object({ id: z.string(), username: z.string(), isAdmin: z.boolean() }),
})

/** Refresh refusals caused by the device credential behind the session, as wire reasons. */
const DEVICE_REFRESH_REASONS: Readonly<
  Partial<Record<SessionRefreshRefusal, DeviceRefusalReason>>
> = {
  'credential-revoked': 'revoked',
  'credential-expired': 'expired',
  'credential-unknown': 'unknown-credential',
  'credential-unavailable': 'unavailable',
}

export interface SessionProcedureDeps {
  readonly registry: CapabilityRegistry | null
  readonly minter: SessionMinter
  /** The credential-tier, per-client rate-limited public procedure. */
  readonly credentialProcedure: typeof publicProcedure
}

function requireSessions(registry: CapabilityRegistry | null) {
  const internal = registry === null ? null : userManagementInternal(registry)
  if (internal === null) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Login sessions are not available',
    })
  }
  return internal.sessions
}

/** Real user sessions only — a scoped or share token has no login session to manage. */
function assertLoginSession(user: { readonly userDelegated?: boolean }): void {
  if (user.userDelegated !== true) {
    throw trpcUserError(
      'FORBIDDEN',
      'auth.session-required',
      undefined,
      'Requires a signed-in user session',
    )
  }
}

export function createSessionProcedures(deps: SessionProcedureDeps) {
  const list = (userId: string | null, currentId: string | undefined) => {
    const sessions = requireSessions(deps.registry)
    const rows = userId === null ? sessions.listActive() : sessions.listForUser(userId)
    return rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      method: row.method,
      refreshable: row.refreshable,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      client: row.client,
      ip: row.ip,
      current: row.id === currentId,
    }))
  }

  return {
    /**
     * PUBLIC — swap a refresh token for a new access token and a rotated
     * refresh token; the session's expiry slides. A rotated-out token
     * presented again (outside a short grace) is treated as stolen and ends
     * the session. Any refusal is a 401: the client signs in again.
     */
    refreshSession: deps.credentialProcedure
      .input(z.object({ refreshToken: z.string().min(1).max(512) }))
      .output(RefreshResultSchema)
      .mutation(async ({ input }) => {
        try {
          const minted = await deps.minter.refresh(input.refreshToken)
          if (
            minted.refreshToken === undefined ||
            minted.sessionId === undefined ||
            minted.expiresAt === undefined ||
            minted.sessionExpiresAt === undefined
          ) {
            throw new SessionRefreshRefusedError('unknown')
          }
          return {
            token: minted.token,
            refreshToken: minted.refreshToken,
            expiresAt: minted.expiresAt,
            sessionId: minted.sessionId,
            sessionExpiresAt: minted.sessionExpiresAt,
            user: minted.user,
          }
        } catch (error: unknown) {
          if (error instanceof SessionRefreshRefusedError) {
            // A session opened by a device certificate says WHY, in a typed
            // message the app switches on (`deviceRefusalFromMessage`).
            const credentialReason = DEVICE_REFRESH_REASONS[error.reason]
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message:
                credentialReason === undefined
                  ? 'Session expired — sign in again'
                  : `${DEVICE_REFRESH_REFUSAL_PREFIX}${credentialReason}`,
            })
          }
          if (error instanceof SessionUserGoneError) {
            throw new TRPCError({
              code: 'UNAUTHORIZED',
              message: 'Session expired — sign in again',
            })
          }
          throw error
        }
      }),

    /**
     * End the caller's session on the server (its access and refresh tokens
     * stop working at once). `everywhere: true` ends every session of the
     * user, and their pre-session tokens.
     */
    logout: protectedProcedure
      .input(z.object({ everywhere: z.boolean().optional() }).optional())
      .output(z.object({ success: z.literal(true), revoked: z.number() }))
      .mutation(async ({ ctx, input }) => {
        assertLoginSession(ctx.user)
        const sessions = requireSessions(deps.registry)
        if (input?.everywhere === true) {
          const revoked = await sessions.revokeAllForUser(ctx.user.id, {
            reason: 'logout-everywhere',
          })
          return { success: true as const, revoked }
        }
        const sessionId = ctx.user.sessionId
        const revoked = sessionId === undefined ? false : await sessions.revoke(sessionId, 'logout')
        return { success: true as const, revoked: revoked ? 1 : 0 }
      }),

    /** The caller's live sessions, newest first; `current` marks this one. */
    listOwnSessions: protectedProcedure
      .input(z.void())
      .output(z.array(LoginSessionSchema))
      .query(({ ctx }) => {
        assertLoginSession(ctx.user)
        return list(ctx.user.id, ctx.user.sessionId)
      }),

    /** End one of the caller's own sessions (another device). */
    revokeOwnSession: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .output(z.object({ success: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        assertLoginSession(ctx.user)
        const sessions = requireSessions(deps.registry)
        const check = sessions.check(input.id)
        if (check.state !== 'active' || check.session.userId !== ctx.user.id) {
          return { success: false }
        }
        return { success: await sessions.revoke(input.id, 'revoked-by-user') }
      }),

    /** ADMIN — live sessions of one user, or of everyone. */
    listSessions: adminProcedure
      .input(z.object({ userId: z.string().min(1).optional() }).optional())
      .output(z.array(LoginSessionSchema))
      .query(({ ctx, input }) => list(input?.userId ?? null, ctx.user.sessionId)),

    /** ADMIN — end one session, or every session of a user. */
    revokeSessions: adminProcedure
      .input(
        z.union([z.object({ id: z.string().min(1) }), z.object({ userId: z.string().min(1) })]),
      )
      .output(z.object({ revoked: z.number() }))
      .mutation(async ({ input }) => {
        const sessions = requireSessions(deps.registry)
        if ('id' in input) {
          return { revoked: (await sessions.revoke(input.id, 'revoked-by-admin')) ? 1 : 0 }
        }
        return {
          revoked: await sessions.revokeAllForUser(input.userId, { reason: 'revoked-by-admin' }),
        }
      }),
  }
}
