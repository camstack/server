/**
 * `auth.revokeCredentials` — the ONE bulk revoke (D819).
 *
 * ## Why it exists, and why it is shaped like this
 *
 * On 2026-10-09 a client-side "Revoke all never used" button on Identity →
 * Tokens deleted every share link on the hub (167 rows in one burst). It
 * looped `revokeShareToken` over every user's links whose `lastUsedAt` was
 * absent — a predicate the CLIENT evaluated, over rows the operator never saw
 * one by one, behind a yes/no dialog. "Never used" also matched links minted
 * minutes earlier and not yet opened by whoever they were sent to.
 *
 * The replacement takes no predicate at all:
 *
 *  - **Exact ids.** The server revokes the ids it is handed and nothing else.
 *    The client builds them from a selection the operator made and previewed;
 *    a filter can help select, it can never be the thing that revokes.
 *  - **The confirmed count travels.** `confirmCount` is the number the
 *    operator typed in the confirmation. A mismatch with `ids.length`
 *    refuses the whole call — a stale or widened selection cannot slip through.
 *  - **Never the caller's own credential.** The caller's current login session
 *    (`ctx.user.sessionId`) is skipped and reported. An admin token cannot call
 *    this at all, so it can never revoke itself or another script's token.
 *  - **Per-row semantics.** A login session is ended one by one
 *    (`revoke(id)`), never through `revokeAllForUser`, which would also move
 *    the user's legacy cutoff and end sessions nobody listed.
 *  - **By id, whatever it is (D892).** A token (admin, scoped or share
 *    link — one store), a login session or an account link; the caller never
 *    names a kind.
 *  - **Audited.** One `credentials-revoked` row per call: counts, ids.
 */
import type { CapabilityRegistry } from '@camstack/system'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { AuthNetworkPolicy } from '../../auth/auth-network-policy.js'
import { userManagementInternal } from '../../auth/hub-sessions.js'
import type { CredentialTokenService } from '../../core/auth/credential-token.service.js'
import { adminProcedure } from '../trpc/trpc.middleware.js'

/** Upper bound of one bulk call — a page of a table, several times over. */
export const REVOKE_CREDENTIALS_MAX = 500

export const RevokeSkipReasonSchema = z.enum(['current-session', 'not-active'])
export type RevokeSkipReason = z.infer<typeof RevokeSkipReasonSchema>

const RevokeCredentialsInputSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(REVOKE_CREDENTIALS_MAX),
    /** The count the operator confirmed. Must equal `ids.length`. */
    confirmCount: z.number().int().min(1),
  })
  .refine((input) => new Set(input.ids).size === input.ids.length, {
    message: 'Each id may be listed once',
    path: ['ids'],
  })

const RevokeCredentialsOutputSchema = z.object({
  revoked: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: RevokeSkipReasonSchema })),
})

/** Keep the audit row bounded; the ids beyond this are counted, not listed. */
const AUDIT_IDS_MAX_CHARS = 4000

export interface RevokeCredentialsDeps {
  readonly registry: CapabilityRegistry | null
  readonly network: AuthNetworkPolicy
  readonly credentialTokens?: CredentialTokenService | null
}

interface Caller {
  readonly id: string
  readonly sessionId?: string
  readonly credentialId?: string
  readonly interactive?: boolean
}

function assertSignedInAdminSession(user: Caller): void {
  if (user.interactive !== true) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Revoking credentials in bulk needs a signed-in admin session',
    })
  }
}

type RevokeOne = (id: string) => Promise<RevokeSkipReason | null>

/**
 * Revoke one credential BY ITS ID, whatever it is (D892). Every store is asked
 * in turn; ids are random UUIDs per store, so at most one knows it. The
 * caller's own credential is never revoked here.
 */
function revokerById(caller: Caller, deps: RevokeCredentialsDeps): RevokeOne {
  const internal = deps.registry === null ? null : userManagementInternal(deps.registry)
  return async (id) => {
    if (id === caller.sessionId || id === caller.credentialId) return 'current-session'
    const tokens = deps.credentialTokens ?? null
    if (tokens !== null && (await tokens.get(id)) !== null) {
      return (await tokens.revoke(id)) ? null : 'not-active'
    }
    if (internal !== null) {
      if (internal.sessions.check(id).state === 'active') {
        return (await internal.sessions.revoke(id, 'revoked-by-admin')) ? null : 'not-active'
      }
      if (await internal.oauthSessions.revoke(id)) return null
    }
    return 'not-active'
  }
}

function auditIds(ids: readonly string[]): string {
  const joined = ids.join(',')
  return joined.length <= AUDIT_IDS_MAX_CHARS ? joined : `${joined.slice(0, AUDIT_IDS_MAX_CHARS)}…`
}

export function createRevokeCredentialsProcedures(deps: RevokeCredentialsDeps) {
  return {
    /** ADMIN — revoke exactly `ids`, by credential id; see the module header. */
    revokeCredentials: adminProcedure
      .input(RevokeCredentialsInputSchema)
      .output(RevokeCredentialsOutputSchema)
      .mutation(async ({ ctx, input }) => {
        assertSignedInAdminSession(ctx.user)
        if (input.confirmCount !== input.ids.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Confirmed ${input.confirmCount} but ${input.ids.length} were listed — nothing was revoked`,
          })
        }
        const revokeOne = revokerById(ctx.user, deps)
        const revoked: string[] = []
        const skipped: { id: string; reason: RevokeSkipReason }[] = []
        // Sequential on purpose: the stores are single-writer, and a partial
        // failure must leave an exact account of what already happened.
        for (const id of input.ids) {
          const reason = await revokeOne(id)
          if (reason === null) revoked.push(id)
          else skipped.push({ id, reason })
        }
        const internal = deps.registry === null ? null : userManagementInternal(deps.registry)
        if (internal !== null) {
          const ip = deps.network.clientAddress(ctx.req).ip
          await internal.audit.record({
            action: 'credentials-revoked',
            userId: ctx.user.id,
            ...(ip !== null ? { ip } : {}),
            detail: {
              kind: 'by-id',
              requested: input.ids.length,
              revoked: revoked.length,
              skipped: skipped.length,
              ids: auditIds(revoked),
            },
          })
        }
        return { revoked, skipped }
      }),
  }
}
