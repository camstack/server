/**
 * Browser-approval login of a terminal client (D988): `cliLoginBegin` /
 * `cliLoginPoll` are the device side (public, rate limited), the rest is the
 * operator side (a signed-in user, in the admin UI at `/approve`).
 */
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { IScopedLogger } from '@camstack/types'
import type { CliApprovalService } from '../../core/auth/cli-approval.service.js'
import type { SessionIssue } from '../../auth/session-mint.js'
import { limitByUser } from './auth-limits.js'
import type { RateLimiter } from '../../auth/auth-rate-limit.js'
import type { TrpcRequest } from '../trpc/trpc.context.js'
import { protectedProcedure, type publicProcedure } from '../trpc/trpc.middleware.js'
import { trpcUserError } from '../trpc/user-error.js'
import type { LoginResultSchema } from './auth.router.js'
import { ReauthTokenInput } from './auth-reauth.procedures.js'

const UserCodeInput = z.string().min(4).max(16)
const ClientLabelInput = z.string().min(1).max(80)

const RequestViewSchema = z.object({
  requestId: z.string(),
  ip: z.string().nullable(),
  client: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
})

export interface CliLoginProcedureDeps {
  readonly cliApprovals: CliApprovalService
  /** `begin` — rate limited per client address, tightly (it opens an entry). */
  readonly beginProcedure: typeof publicProcedure
  /** `poll` — rate limited per client address, loose enough for a poll every few seconds. */
  readonly pollProcedure: typeof publicProcedure
  readonly selfLimiter: RateLimiter
  readonly logger?: IScopedLogger
  /** The requester as the hub sees it: real client address and a label. */
  readonly requesterOf: (
    req: TrpcRequest | undefined,
    label: string | undefined,
  ) => { readonly ip?: string; readonly client?: string; readonly userAgent?: string }
  readonly mintSession: (
    userId: string,
    issue: SessionIssue,
  ) => Promise<z.infer<typeof LoginResultSchema>>
  /** Throws unless this session is a fresh sign-in or carries a single-use reauth token. */
  readonly assertFreshAuthentication: (
    user: { id: string; sessionId?: string },
    reauthToken: string | undefined,
  ) => void
  readonly assertRealUserSession: (user: { readonly userDelegated?: boolean }, what: string) => void
  readonly loginResultSchema: typeof LoginResultSchema
}

const PollOutputSchema = (loginResult: typeof LoginResultSchema) =>
  z.object({
    status: z.enum(['pending', 'slow_down', 'approved', 'denied', 'expired']),
    intervalSec: z.number().optional(),
    session: loginResult.optional(),
  })

/** What an audit line may say about a requester — never the code or the secret. */
function auditOf(requester: {
  readonly ip?: string
  readonly client?: string
  readonly userAgent?: string
}): Record<string, string | undefined> {
  return { ip: requester.ip, client: requester.client, userAgent: requester.userAgent }
}

function refusal(message: string): TRPCError {
  return trpcUserError('NOT_FOUND', 'auth.cli-login-unknown', undefined, message)
}

export function createCliLoginProcedures(deps: CliLoginProcedureDeps) {
  const { cliApprovals } = deps
  const limit = (path: string, userId: string): void => limitByUser(deps.selfLimiter, path, userId)

  return {
    /** PUBLIC — a terminal asks to be signed in. Returns the code to show and a secret to poll with. */
    cliLoginBegin: deps.beginProcedure
      .input(z.object({ client: ClientLabelInput.optional() }).optional())
      .output(
        z.object({
          userCode: z.string(),
          deviceSecret: z.string(),
          expiresAt: z.number(),
          intervalSec: z.number(),
        }),
      )
      .mutation(({ input, ctx }) => cliApprovals.begin(deps.requesterOf(ctx.req, input?.client))),

    /** PUBLIC — the terminal polls. The first poll after an approval mints the session, once. */
    cliLoginPoll: deps.pollProcedure
      .input(z.object({ deviceSecret: z.string().min(1).max(256) }))
      .output(PollOutputSchema(deps.loginResultSchema))
      .mutation(async ({ input }) => {
        const result = cliApprovals.poll(input.deviceSecret)
        if (result.status === 'unknown') {
          throw trpcUserError(
            'UNAUTHORIZED',
            'auth.cli-login-invalid',
            undefined,
            'Unknown or already used sign-in request',
          )
        }
        if (result.status === 'pending' || result.status === 'slow_down') {
          return { status: result.status, intervalSec: result.intervalSec }
        }
        if (result.status !== 'approved') return { status: result.status }
        // Refreshable on purpose: every CLI session (password login included) renews through its
        // refresh token; a non-refreshable one would be a single long-lived bearer token instead.
        const sessionClient = result.requester.userAgent ?? result.requester.client
        const minted = await deps.mintSession(result.userId, {
          method: 'cli-approval',
          refreshable: true,
          ...(sessionClient !== undefined ? { client: sessionClient } : {}),
          ...(result.requester.ip !== undefined ? { ip: result.requester.ip } : {}),
        })
        deps.logger?.info('Terminal sign-in approved and session opened', {
          tags: { userId: result.userId },
          meta: { requestId: result.requestId, ...auditOf(result.requester) },
        })
        return { status: 'approved' as const, session: minted }
      }),

    /** The operator typed a code: who is asking? */
    cliLoginDescribe: protectedProcedure
      .input(z.object({ userCode: UserCodeInput }))
      .output(RequestViewSchema.extend({ approverIp: z.string().nullable() }))
      .query(({ ctx, input }) => {
        deps.assertRealUserSession(ctx.user, 'Approving a terminal sign-in')
        limit('cliLoginDescribe', ctx.user.id)
        const view = cliApprovals.describe(input.userCode)
        if (view === null) throw refusal('No pending sign-in request with that code')
        return { ...view, approverIp: deps.requesterOf(ctx.req, undefined).ip ?? null }
      }),

    cliLoginApprove: protectedProcedure
      .input(z.object({ userCode: UserCodeInput, reauthToken: ReauthTokenInput.optional() }))
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ ctx, input }) => {
        deps.assertRealUserSession(ctx.user, 'Approving a terminal sign-in')
        limit('cliLoginApprove', ctx.user.id)
        deps.assertFreshAuthentication(ctx.user, input.reauthToken)
        const view = cliApprovals.describe(input.userCode)
        const outcome = cliApprovals.approve(input.userCode, ctx.user.id)
        const meta = {
          requestId: view?.requestId,
          ip: view?.ip ?? undefined,
          client: view?.client ?? undefined,
          userAgent: view?.userAgent ?? undefined,
          approverIp: deps.requesterOf(ctx.req, undefined).ip,
        }
        if (outcome !== 'ok') {
          deps.logger?.warn('Terminal sign-in approval refused', {
            tags: { userId: ctx.user.id },
            meta: { ...meta, reason: outcome },
          })
          throw refusal('That sign-in request is unknown, expired or already decided')
        }
        deps.logger?.info('Terminal sign-in approved', { tags: { userId: ctx.user.id }, meta })
        return { ok: true as const }
      }),

    /** Deny by the typed code, or by the id a pending list shows. */
    cliLoginDeny: protectedProcedure
      .input(
        z.union([
          z.object({ userCode: UserCodeInput }),
          z.object({ requestId: z.string().min(1) }),
        ]),
      )
      .output(z.object({ ok: z.literal(true) }))
      .mutation(({ ctx, input }) => {
        deps.assertRealUserSession(ctx.user, 'Denying a terminal sign-in')
        limit('cliLoginDeny', ctx.user.id)
        const view =
          'userCode' in input
            ? cliApprovals.describe(input.userCode)
            : cliApprovals.describeById(input.requestId)
        const outcome = cliApprovals.deny(input)
        if (outcome !== 'ok')
          throw refusal('That sign-in request is unknown, expired or already decided')
        deps.logger?.info('Terminal sign-in denied', {
          tags: { userId: ctx.user.id },
          meta: {
            requestId: view?.requestId,
            ip: view?.ip ?? undefined,
            client: view?.client ?? undefined,
            userAgent: view?.userAgent ?? undefined,
          },
        })
        return { ok: true as const }
      }),

    /** Requests waiting for a decision — no codes, so a list can only deny. */
    cliLoginPending: protectedProcedure.output(z.array(RequestViewSchema)).query(({ ctx }) => {
      deps.assertRealUserSession(ctx.user, 'Listing terminal sign-ins')
      return [...cliApprovals.listPending()]
    }),
  }
}
