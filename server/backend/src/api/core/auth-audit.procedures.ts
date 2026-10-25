/**
 * The authentication audit trail, as the `auth` router serves it. The trail
 * itself is local-auth's (`auth-audit-log.ts`): every token mint, every use of
 * a token holding `'*'`, every revoke (D892).
 *
 * There is no admin-token surface here any more (D895): an admin token is a
 * token whose scopes hold `'*'`, created, listed and revoked through
 * `auth.mintToken` / `auth.listTokens` / `auth.revokeToken`.
 */
import type { CapabilityRegistry } from '@camstack/system'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { userManagementInternal } from '../../auth/hub-sessions.js'
import { adminProcedure } from '../trpc/trpc.middleware.js'

export const AuthAuditRecordSchema = z.object({
  id: z.string(),
  at: z.number(),
  action: z.string(),
  userId: z.string().optional(),
  ip: z.string().optional(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
})

export interface AuthAuditProcedureDeps {
  readonly registry: CapabilityRegistry | null
}

export function createAuthAuditProcedures(deps: AuthAuditProcedureDeps) {
  return {
    /** ADMIN — the authentication audit trail, newest first. */
    listAuthAudit: adminProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(500).optional(),
            userId: z.string().min(1).optional(),
          })
          .optional(),
      )
      .output(z.array(AuthAuditRecordSchema))
      .query(async ({ input }) => {
        const internal = deps.registry === null ? null : userManagementInternal(deps.registry)
        if (internal === null) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'User management is not available',
          })
        }
        return [
          ...(await internal.audit.list({
            ...(input?.limit !== undefined ? { limit: input.limit } : {}),
            ...(input?.userId !== undefined ? { userId: input.userId } : {}),
          })),
        ]
      }),
  }
}
