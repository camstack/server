/**
 * Account preferences — fixed core API (D894), not a capability.
 *
 *   get           the caller's rows (all, or the namespaces asked)
 *   put           write one namespace; `baseRevision` turns it into a
 *                 compare-and-set that answers `conflict` with the current row
 *   delete        remove one namespace
 *   changedSince  the cheap poll: only rows the client does not hold yet
 *
 * There is no `userId` input anywhere: every call acts on the PRINCIPAL's own
 * rows, admin included — an admin cannot read another user's preferences
 * through this router, and nothing else serves them. The principal must hold
 * `preferences-self` (every person's session does; a unified token only when
 * minted with it), so a share link, a legacy token, an account link and the
 * hub's own mesh principal are refused.
 *
 * Sync is by polling `changedSince`: there is no per-user push channel to a
 * user's sessions, and the event bus is fleet-wide telemetry (D8).
 *
 * The rows live in `local-auth` (it owns the users, and a user's delete wipes
 * them), reached through the hub-internal half of `user-management`.
 */
import { getUserManagementInternal, preferencesLimitReasonOf } from '@camstack/system'
import type { UserPreferencesInternal } from '@camstack/system'
import {
  PreferencesChangedSinceInputSchema,
  PreferencesChangedSinceOutputSchema,
  PreferencesDeleteInputSchema,
  PreferencesDeleteOutputSchema,
  PreferencesGetInputSchema,
  PreferencesGetOutputSchema,
  PreferencesPutInputSchema,
  PreferencesPutOutputSchema,
  scopesAllowOwnPreferences,
  type CredentialScope,
} from '@camstack/types'
import { protectedProcedure, trpcRouter } from '../trpc/trpc.middleware.js'
import { trpcUserError } from '../trpc/user-error.js'

/** What the gate reads off the request principal. */
export interface PreferencesPrincipal {
  readonly id: string
  readonly scopes?: readonly CredentialScope[]
}

export interface PreferencesRouterDeps {
  /** The store, or `null` while `local-auth` has not registered one. Resolved per call. */
  readonly preferences: () => UserPreferencesInternal | null
}

/** What {@link preferencesFromRegistry} reads; `null` before the registry exists. */
export interface PreferencesRegistry {
  getSingleton(capability: string): unknown
}

/** The store behind the hub's in-process `user-management` provider. */
export function preferencesFromRegistry(
  registry: PreferencesRegistry | null,
): () => UserPreferencesInternal | null {
  return () =>
    registry === null
      ? null
      : (getUserManagementInternal(registry.getSingleton('user-management'))?.preferences ?? null)
}

/** The user whose rows this call may touch: the principal itself, or a refusal. */
export function preferencesOwnerOf(principal: PreferencesPrincipal): string {
  if (!scopesAllowOwnPreferences(principal.scopes ?? [])) {
    throw trpcUserError(
      'FORBIDDEN',
      'preferences.forbidden',
      undefined,
      'This credential cannot reach account preferences',
    )
  }
  return principal.id
}

function storeOf(deps: PreferencesRouterDeps): UserPreferencesInternal {
  const store = deps.preferences()
  if (store === null) {
    throw trpcUserError(
      'PRECONDITION_FAILED',
      'preferences.unavailable',
      undefined,
      'Account preferences are not available',
    )
  }
  return store
}

function limitRefusal(error: unknown): never {
  const reason = preferencesLimitReasonOf(error)
  if (reason === 'value-too-large') {
    throw trpcUserError(
      'PAYLOAD_TOO_LARGE',
      'preferences.value-too-large',
      undefined,
      'This preference value is too large',
    )
  }
  if (reason === 'too-many-namespaces') {
    throw trpcUserError(
      'BAD_REQUEST',
      'preferences.too-many-namespaces',
      undefined,
      'Too many preference namespaces for this account',
    )
  }
  throw error
}

export function createPreferencesRouter(deps: PreferencesRouterDeps) {
  return trpcRouter({
    get: protectedProcedure
      .input(PreferencesGetInputSchema)
      .output(PreferencesGetOutputSchema)
      .query(async ({ ctx, input }) => {
        const owner = preferencesOwnerOf(ctx.user)
        return { rows: [...(await storeOf(deps).get(owner, input.namespaces))] }
      }),
    put: protectedProcedure
      .input(PreferencesPutInputSchema)
      .output(PreferencesPutOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const owner = preferencesOwnerOf(ctx.user)
        try {
          return await storeOf(deps).put(owner, input)
        } catch (error: unknown) {
          return limitRefusal(error)
        }
      }),
    delete: protectedProcedure
      .input(PreferencesDeleteInputSchema)
      .output(PreferencesDeleteOutputSchema)
      .mutation(async ({ ctx, input }) => {
        const owner = preferencesOwnerOf(ctx.user)
        return { deleted: await storeOf(deps).delete(owner, input.namespace) }
      }),
    changedSince: protectedProcedure
      .input(PreferencesChangedSinceInputSchema)
      .output(PreferencesChangedSinceOutputSchema)
      .query(async ({ ctx, input }) => {
        const owner = preferencesOwnerOf(ctx.user)
        return storeOf(deps).changedSince(owner, input.revisionByNamespace)
      }),
  })
}
