/**
 * ONE mint for every token (D892): `auth.mintToken({ scopes, expiresIn, label })`.
 *
 * What a token may do is its `scopes`; there is no admin / scoped / share
 * kind. The rules, the same for every caller:
 *
 *   - minted only from a person's login session (a token never mints a
 *     token, D816) — or, for a lone share-view grant, from an account link
 *     the person consented to (Home Assistant's camera embeds), which is the
 *     reach a share link has always had;
 *   - never more than the caller holds (`scopesWithin`) — escalation is
 *     refused, never trimmed;
 *   - `'*'` needs a fresh re-authentication (D813), as the admin token did;
 *   - a `share-view` grant stands alone (it restricts its holder; mixed with
 *     anything else the rest would be dead weight that reads as a grant);
 *   - a lifetime is mandatory and at most 90 days; only a share-view token may
 *     choose `'never'`, the explicit permanent share link it always could be.
 *
 * `auth.listTokens` lists them (`label` narrows to one client's), and
 * `auth.extendToken` moves one's expiry in place so a client renews rather
 * than mints duplicates; `auth.revokeToken` revokes one by id. A share link
 * is nothing else: a token whose only scope is a share-view grant. There is
 * no other token format and no other share surface (D895).
 */
import type { CapabilityRegistry } from '@camstack/system'
import type { CredentialScope } from '@camstack/types'
import { CredentialScopeSchema, scopesGrantAdmin, shareViewGrantOf } from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import type { AuthNetworkPolicy } from '../../auth/auth-network-policy.js'
import { userManagementInternal } from '../../auth/hub-sessions.js'
import { scopesWithin } from '../../auth/scope-escalation.js'
import type { AuthService } from '../../core/auth/auth.service.js'
import type {
  CredentialTokenRecord,
  CredentialTokenService,
} from '../../core/auth/credential-token.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../trpc/trpc.context.js'
import { protectedProcedure } from '../trpc/trpc.middleware.js'
import { assertReauthenticated, ReauthTokenInput } from './auth-reauth.procedures.js'

const DAY_MS = 86_400_000
/** Every token's longest lifetime — the admin token's bound, now everyone's (D816). */
export const TOKEN_MAX_LIFETIME_SEC = 90 * 86_400
const TOKEN_MIN_LIFETIME_SEC = 60
const MAX_SCOPES = 32

export const TokenExpiresInSchema = z.union([
  z.number().int().min(TOKEN_MIN_LIFETIME_SEC).max(TOKEN_MAX_LIFETIME_SEC),
  z.literal('never'),
])

export const MintTokenInputSchema = z.object({
  scopes: z.array(CredentialScopeSchema).min(1).max(MAX_SCOPES),
  /** Seconds until expiry, or `'never'` (a share-view token only). */
  expiresIn: TokenExpiresInSchema,
  label: z.string().trim().min(1).max(80),
  /** Required when `scopes` holds `'*'`. */
  reauthToken: ReauthTokenInput.optional(),
  /**
   * The user the token acts for — an admin only; omitted, the caller. Its
   * scopes are cut to what that user holds at every verify (a token never
   * outgrows its subject).
   */
  subjectId: z.string().min(1).optional(),
})
export type MintTokenInput = z.infer<typeof MintTokenInputSchema>

export const ListTokensInputSchema = z
  .object({
    /** Only the tokens with exactly this label — how a client finds the one it minted. */
    label: z.string().trim().min(1).max(80).optional(),
  })
  .optional()

export const ExtendTokenInputSchema = z.object({
  id: z.string().min(1),
  /** Seconds from now, or `'never'` (a lone share-view token only). */
  expiresIn: TokenExpiresInSchema,
})

export const TokenSummarySchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  label: z.string(),
  scopes: z.array(CredentialScopeSchema),
  createdAt: z.number(),
  expiresAt: z.number().nullable(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
})
export type TokenSummary = z.infer<typeof TokenSummarySchema>

export interface TokenProcedureDeps {
  readonly auth: AuthService
  readonly registry: CapabilityRegistry | null
  readonly network: AuthNetworkPolicy
  readonly credentialTokens: CredentialTokenService | null
}

export function summarizeToken(record: CredentialTokenRecord): TokenSummary {
  return {
    id: record.id,
    subjectId: record.subjectId,
    label: record.label,
    scopes: [...record.scopes],
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  }
}

export function requireCredentialTokens(
  service: CredentialTokenService | null,
): CredentialTokenService {
  if (service === null) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Tokens are not available' })
  }
  return service
}

export interface MintRequest {
  readonly scopes: readonly CredentialScope[]
  readonly expiresIn: number | 'never'
  readonly label: string
  readonly reauthToken?: string
  /** The user the token acts for; the caller unless an admin names another. */
  readonly subjectId?: string
}

/**
 * May `user` mint (or extend) a token carrying `scopes`? A person's login
 * session may mint anything within its reach; an account link only a lone
 * share-view grant (D895 — the reach the share-link route always gave it);
 * a minted token never.
 */
function provenanceAllows(user: AuthenticatedAgent, scopes: readonly CredentialScope[]): boolean {
  if (user.interactive === true) return true
  return user.userDelegated === true && scopes.length === 1 && shareViewGrantOf(scopes) !== null
}

/** The lifetime rules every mint and every extend obey. Throws a BAD_REQUEST. */
function assertLifetime(scopes: readonly CredentialScope[], expiresIn: number | 'never'): void {
  if (expiresIn === 'never' && shareViewGrantOf(scopes) === null) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Only a share link may be minted without an expiry',
    })
  }
}

function expiryOf(expiresIn: number | 'never'): number | null {
  return expiresIn === 'never' ? null : Date.now() + expiresIn * 1000
}

/**
 * The one mint behind `auth.mintToken`. Refuses; never trims.
 */
export async function mintFor(
  deps: TokenProcedureDeps,
  ctx: Pick<TrpcContext, 'req' | 'deviceScopeLookup'> & { readonly user: AuthenticatedAgent },
  request: MintRequest,
): Promise<{ readonly token: string; readonly record: CredentialTokenRecord }> {
  const user = ctx.user
  if (!provenanceAllows(user, request.scopes)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A token can only be minted from a signed-in session',
    })
  }
  const share = shareViewGrantOf(request.scopes)
  if (share !== null && request.scopes.length !== 1) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'A share-view grant must be the token’s only scope',
    })
  }
  assertLifetime(request.scopes, request.expiresIn)
  const verdict = scopesWithin(request.scopes, user.scopes ?? [], ctx.deviceScopeLookup)
  if (!verdict.ok) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `A token cannot carry more than you hold: ${verdict.reason}`,
    })
  }
  if (scopesGrantAdmin(request.scopes)) {
    assertReauthenticated(deps.auth, user, request.reauthToken)
  }
  const subjectId = request.subjectId ?? user.id
  if (subjectId !== user.id && !user.isAdmin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only an admin mints for another user' })
  }
  if (subjectId !== user.id && scopesGrantAdmin(request.scopes)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: "A '*' token acts for the admin who mints it, never for another user",
    })
  }
  const service = requireCredentialTokens(deps.credentialTokens)
  const minted = await service.mint({
    subjectId,
    createdBy: user.id,
    label: request.label,
    scopes: request.scopes,
    expiresAt: expiryOf(request.expiresIn),
  })
  const internal = deps.registry === null ? null : userManagementInternal(deps.registry)
  if (internal !== null) {
    const ip = deps.network.clientAddress(ctx.req).ip
    await internal.audit
      .record({
        // An admin-capable token keeps the action the audit page already words.
        action: scopesGrantAdmin(request.scopes) ? 'admin-token-created' : 'token-minted',
        userId: user.id,
        ...(ip !== null ? { ip } : {}),
        detail: {
          tokenId: minted.record.id,
          name: minted.record.label,
          subjectId,
          scopes: request.scopes.length,
          ...(minted.record.expiresAt !== null ? { expiresAt: minted.record.expiresAt } : {}),
        },
      })
      .catch(() => {})
  }
  return minted
}

export function createTokenProcedures(deps: TokenProcedureDeps) {
  return {
    /** Issue a token carrying `scopes` (see the module header). Shown once. */
    mintToken: protectedProcedure
      .input(MintTokenInputSchema)
      .output(z.object({ token: z.string(), record: TokenSummarySchema }))
      .mutation(async ({ ctx, input }) => {
        const minted = await mintFor(deps, ctx, {
          scopes: input.scopes,
          expiresIn: input.expiresIn,
          label: input.label,
          ...(input.reauthToken !== undefined ? { reauthToken: input.reauthToken } : {}),
          ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
        })
        return { token: minted.token, record: summarizeToken(minted.record) }
      }),

    /**
     * The caller's tokens (an admin: everyone's). No secret is ever listed.
     */
    listTokens: protectedProcedure
      .input(ListTokensInputSchema)
      .output(z.array(TokenSummarySchema))
      .query(async ({ ctx, input }) => {
        if (ctx.user.userDelegated !== true) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Requires a signed-in user session' })
        }
        const rows = await requireCredentialTokens(deps.credentialTokens).list(
          ctx.user.isAdmin ? undefined : ctx.user.id,
        )
        const label = input?.label
        // An account link manages share links only, so it lists only those.
        const shareOnly = ctx.user.interactive !== true
        return rows
          .filter((row) => label === undefined || row.label === label)
          .filter((row) => !shareOnly || provenanceAllows(ctx.user, row.scopes))
          .map(summarizeToken)
      }),

    /**
     * Move one live token's expiry, in place: the same token keeps working
     * with the new lifetime, so a client renews instead of minting another.
     * The owner or an admin; the same provenance and lifetime rules as a mint
     * (an account link renews only its share links; `'never'` only for one).
     * Shortening is allowed; a revoked or expired token is NOT_FOUND.
     */
    extendToken: protectedProcedure
      .input(ExtendTokenInputSchema)
      .output(TokenSummarySchema)
      .mutation(async ({ ctx, input }) => {
        const service = requireCredentialTokens(deps.credentialTokens)
        const record = await service.get(input.id)
        if (record === null) {
          throw new TRPCError({ code: 'NOT_FOUND', message: `Token not found: ${input.id}` })
        }
        if (!ctx.user.isAdmin && record.subjectId !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the owner or an admin extends a token',
          })
        }
        if (!provenanceAllows(ctx.user, record.scopes)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'A token can only be extended from a signed-in session',
          })
        }
        assertLifetime(record.scopes, input.expiresIn)
        const moved = await service.setExpiry(input.id, expiryOf(input.expiresIn))
        if (moved === null) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Token expired or revoked: ${input.id}`,
          })
        }
        return summarizeToken(moved)
      }),

    /** Revoke one token: its owner or an admin. It stops working at once. */
    revokeToken: protectedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .output(z.object({ success: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.userDelegated !== true) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Requires a signed-in user session' })
        }
        const service = requireCredentialTokens(deps.credentialTokens)
        const record = await service.get(input.id)
        if (record === null) return { success: false }
        if (!ctx.user.isAdmin && record.subjectId !== ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only the owner or an admin revokes a token',
          })
        }
        if (!provenanceAllows(ctx.user, record.scopes)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'An account link revokes only its share links',
          })
        }
        const success = await service.revoke(input.id)
        const internal = deps.registry === null ? null : userManagementInternal(deps.registry)
        if (success && internal !== null) {
          const ip = deps.network.clientAddress(ctx.req).ip
          await internal.audit
            .record({
              action: 'token-revoked',
              userId: ctx.user.id,
              ...(ip !== null ? { ip } : {}),
              detail: { tokenId: input.id },
            })
            .catch(() => {})
        }
        return { success }
      }),
  }
}

/** Days → the `expiresIn` seconds the mint takes. */
export function daysToSeconds(days: number): number {
  return (days * DAY_MS) / 1000
}
