/**
 * Re-authentication: a fresh proof (the current password, or a passkey) that
 * the person at the keyboard is the signed-in user — not just someone holding
 * their session. `auth.reauthenticate` answers a 5-minute `reauthToken`, bound
 * to the user AND the session it was proved in; the sensitive self-service
 * actions require it:
 *
 *  - `beginExternalLink` (a hijacked session could otherwise link the
 *    attacker's IdP account and sign in through it),
 *  - `disableOwnTotp`, `removeOwnPasskey` (stripping the second factor),
 *  - `mintToken` of a token whose scopes grant admin.
 *
 * Limited per user (10/min) and counted against the account's failure bucket
 * like a login.
 */
import type { CapabilityRegistry } from '@camstack/system'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { OptionsJsonSchema, resolvePasskeyProvider } from '../../auth/passkey-provider.js'
import type { AuthService } from '../../core/auth/auth.service.js'
import type { MoleculerService } from '../../core/moleculer/moleculer.service.js'
import type { AuthenticatedAgent } from '../trpc/trpc.context.js'
import { protectedProcedure } from '../trpc/trpc.middleware.js'
import {
  type AuthLimiters,
  assertAccountNotLocked,
  limitByUser,
  recordAccountFailure,
} from './auth-limits.js'
import { trpcUserError } from '../trpc/user-error.js'

/** The input field a re-auth-gated procedure takes. */
export const ReauthTokenInput = z.string().min(1).max(4096)

export const REAUTH_REQUIRED_MESSAGE =
  'Confirm it is you first: re-enter your password or use a passkey (update the app if it cannot ask).'

/**
 * Throw unless `reauthToken` is a live proof by THIS user, made in THIS
 * session. A missing token is the same refusal: the action needs one.
 */
export function assertReauthenticated(
  auth: Pick<AuthService, 'verifyReauthToken'>,
  user: Pick<AuthenticatedAgent, 'id' | 'sessionId'>,
  reauthToken: string | undefined,
): void {
  const claims = reauthToken === undefined ? null : auth.verifyReauthToken(reauthToken)
  const valid =
    claims !== null &&
    claims.userId === user.id &&
    (user.sessionId === undefined || claims.sessionId === user.sessionId)
  if (!valid) throw new TRPCError({ code: 'FORBIDDEN', message: REAUTH_REQUIRED_MESSAGE })
}

interface PasswordChecker {
  validateCredentials(input: {
    username: string
    password: string
  }): Promise<{ readonly id: string } | null>
}

function isPasswordChecker(value: unknown): value is PasswordChecker {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'validateCredentials') === 'function'
  )
}

export interface ReauthProcedureDeps {
  readonly auth: AuthService
  readonly registry: CapabilityRegistry | null
  readonly moleculer: MoleculerService | null
  readonly limiters: AuthLimiters
}

/** Real user sessions only: a scoped or share token cannot prove a password. */
function assertPerson(user: AuthenticatedAgent): void {
  if (user.userDelegated !== true) {
    throw trpcUserError(
      'FORBIDDEN',
      'auth.session-required',
      undefined,
      'Requires a signed-in user session',
    )
  }
}

export function createReauthProcedures(deps: ReauthProcedureDeps) {
  return {
    /** Passkey re-authentication, step 1: assertion options for the caller's own credentials. */
    reauthBeginPasskey: protectedProcedure
      .input(z.void())
      .output(OptionsJsonSchema)
      .mutation(async ({ ctx }) => {
        assertPerson(ctx.user)
        limitByUser(deps.limiters.reauth, 'auth.reauthBeginPasskey', ctx.user.id)
        const provider = resolvePasskeyProvider(deps.registry, deps.moleculer)
        if (!provider) throw new Error('Passkey authentication is not available')
        return provider.beginAuthentication({ userId: ctx.user.id })
      }),

    /**
     * Prove it is you — the current password, or the passkey assertion from
     * `reauthBeginPasskey`. Answers a 5-minute proof for the re-auth-gated
     * actions, valid only for this user in this session.
     */
    reauthenticate: protectedProcedure
      .input(
        z.union([
          z.object({ password: z.string().min(1).max(1024) }),
          z.object({ passkeyResponse: z.record(z.string(), z.unknown()) }),
        ]),
      )
      .output(
        z.object({
          reauthToken: z.string(),
          expiresAt: z.number(),
          method: z.enum(['password', 'passkey']),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        assertPerson(ctx.user)
        limitByUser(deps.limiters.reauth, 'auth.reauthenticate', ctx.user.id)
        assertAccountNotLocked(deps.limiters, ctx.user.username)
        let method: 'password' | 'passkey'
        if ('password' in input) {
          const userMgmt: unknown = deps.registry?.getSingleton('user-management')
          if (!isPasswordChecker(userMgmt)) {
            throw new Error('user-management capability not available')
          }
          const record = await userMgmt.validateCredentials({
            username: ctx.user.username,
            password: input.password,
          })
          if (record === null || record.id !== ctx.user.id) {
            recordAccountFailure(deps.limiters, ctx.user.username)
            throw trpcUserError(
              'UNAUTHORIZED',
              'auth.password-incorrect',
              undefined,
              'Password is incorrect',
            )
          }
          method = 'password'
        } else {
          const provider = resolvePasskeyProvider(deps.registry, deps.moleculer)
          if (!provider) throw new Error('Passkey authentication is not available')
          const result = await provider.finishAuthentication({
            userId: ctx.user.id,
            response: input.passkeyResponse,
          })
          if (!result.verified) {
            recordAccountFailure(deps.limiters, ctx.user.username)
            throw trpcUserError(
              'UNAUTHORIZED',
              'auth.passkey-verification-failed',
              undefined,
              'Passkey verification failed',
            )
          }
          method = 'passkey'
        }
        const reauthToken = deps.auth.signReauthToken({
          userId: ctx.user.id,
          method,
          ...(ctx.user.sessionId !== undefined ? { sessionId: ctx.user.sessionId } : {}),
        })
        return { reauthToken, expiresAt: Date.now() + 300_000, method }
      }),
  }
}
