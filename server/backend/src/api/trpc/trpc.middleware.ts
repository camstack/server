import { getCatalogRegistry } from '@camstack/system'
import {
  capabilityScopesOf,
  DEFAULT_CATALOG_LANG,
  localizeConfigTree,
  viewerScopeOf,
} from '@camstack/types'
import { personSessionScopes } from '../../auth/person-session-scopes.js'
import { logPersonWithoutViewer } from './person-without-viewer.js'
import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { formatTrpcError } from './cap-route-error-formatter.js'
import { NON_ADMIN_CONFIG_REDACTED_METHODS } from './device-config-secret-redaction.js'
import { projectListAllForPrincipal } from './principal-visibility.js'
import { LOCALIZED_SCHEMA_PATHS } from './localized-schema-paths.js'
import { authorizeProcedure, viewerPassesAdminTier } from './principal-authorization.js'
import { DEVICE_ENUMERATION_METHODS } from './scope-access.js'
import {
  projectListAllForShareScope,
  projectShareScopeRows,
  SHARE_SCOPE_PROJECTED_METHODS,
} from './share-view-access.js'
import type { TrpcContext } from './trpc.context'
import { trpcUserError } from './user-error.js'

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter: formatTrpcError,
})

// ---------------------------------------------------------------------------
// Async-generator subscription helpers (tRPC v11 — replaces deprecated observable)
// ---------------------------------------------------------------------------

/**
 * Convert a push-based subscription (callback → unsubscribe) into an async generator
 * suitable for tRPC v11 `.subscription()`.
 *
 * @param subscribe — called once; receives a `push` callback and must return an unsubscribe fn.
 */
export async function* iterableSubscription<T>(
  subscribe: (push: (value: T) => void) => () => void,
): AsyncGenerator<T> {
  const queue: T[] = []
  let resolve: (() => void) | null = null

  const unsub = subscribe((value) => {
    queue.push(value)
    resolve?.()
  })

  try {
    while (true) {
      while (queue.length > 0) {
        yield queue.shift()!
      }
      await new Promise<void>((r) => {
        resolve = r
      })
    }
  } finally {
    unsub()
  }
}

/**
 * Create an interval-based async generator that yields a value on each tick.
 * Useful for polling subscriptions.
 */
export async function* iterableInterval<T>(
  intervalMs: number,
  getValue: () => T,
): AsyncGenerator<T> {
  try {
    while (true) {
      yield getValue()
      await new Promise<void>((r) => setTimeout(r, intervalMs))
    }
  } finally {
    // cleanup handled by generator return
  }
}

/**
 * Outermost middleware (D863): on the methods that serialise a settings schema
 * for the UI, substitute `labelKey` / `descriptionKey` / `titleKey` with the
 * catalog text in the request language. English (and an unknown key) leave the
 * English text the field carries untouched.
 */
const localizeSchemaOutput = t.middleware(async ({ ctx, path, next }) => {
  const out = await next()
  const lang = ctx.lang ?? DEFAULT_CATALOG_LANG
  if (!out.ok || lang === DEFAULT_CATALOG_LANG || !LOCALIZED_SCHEMA_PATHS.has(path)) return out
  return { ...out, data: localizeConfigTree(out.data, getCatalogRegistry().lookupFor(lang)) }
})

/** Every authenticated procedure starts from here, so the localizing middleware is the outermost. */
const localized = t.procedure.use(localizeSchemaOutput)

export const trpcRouter = t.router
export const publicProcedure = t.procedure

/**
 * Server-side caller factory — turns the hub appRouter into a directly
 * invokable record under a supplied `TrpcContext`. The core-cap bridge
 * (`core-cap-bridge.ts`) uses it to expose core routers over the
 * Moleculer mesh without an HTTP round-trip.
 */
export const createCallerFactory = t.createCallerFactory

/**
 * The authenticated procedure (D892).
 *
 * The principal's `scopes` decide, through ONE matcher
 * (`authorizeProcedure`, `principal-authorization.ts`):
 *
 *   - a `share-view` grant restricts it to the fail-closed embed allowlist
 *     (`share-view-access.ts`) — enumerated methods, in-scope devices only —
 *     and its answers are projected to that perimeter;
 *   - `'*'` passes;
 *   - otherwise a cap route (`METHOD_ACCESS_MAP`) is scope-matched, and a
 *     hand-written core route (`auth.*`, `system.info` …) needs authentication
 *     only — `adminProcedure` on top gates what is destructive.
 *
 * What kind of credential the principal came from is never read here.
 */
export const protectedProcedure = localized.use(async ({ ctx, next, path, getRawInput }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  // A WebSocket resolves its principal once, at connect. Its login session is
  // re-checked on every call, so a logout or revocation ends a socket that is
  // already open — not only the next one.
  if (ctx.sessionLive !== undefined && !ctx.sessionLive()) {
    throw trpcUserError(
      'UNAUTHORIZED',
      'auth.session-ended',
      undefined,
      'Session ended — sign in again',
    )
  }
  const user = ctx.user
  const rawScopes = user.scopes ?? []
  // A person is an admin or a viewer (D921). Grant rows on the user record
  // are not a role: the session is decided by its viewer row alone, and a
  // person with none reaches no labelled method. Tokens keep their rows.
  const scopes =
    user.interactive === true && !user.isAdmin ? personSessionScopes(rawScopes) : rawScopes
  const verdict = authorizeProcedure(scopes, path, await getRawInput(), ctx.deviceScopeLookup)
  if (!verdict.ok) {
    if (
      user.interactive === true &&
      !user.isAdmin &&
      viewerScopeOf(capabilityScopesOf(rawScopes)) === null
    ) {
      logPersonWithoutViewer(ctx.logger, user.id)
    }
    throw new TRPCError({ code: 'FORBIDDEN', message: verdict.reason })
  }
  // Spread+reassign of `user` narrows downstream ctx from `User | null` to
  // `User` so `adminProcedure` can read fields without re-checking.
  if (verdict.mode === 'all') {
    return next({ ctx: { ...ctx, user } })
  }
  if (verdict.mode === 'share') {
    const grant = verdict.grant
    // `deviceManager.listAll` is allowlisted for the embed's tile names, but
    // its raw rows describe EVERY device (config incl. credentials): project
    // it down to the in-scope whitelisted rows. The events surface answers
    // with ROWS carrying a `deviceId`, and two of its methods can reach
    // devices outside the scope — this is where that answer is cut.
    if (path === 'deviceManager.listAll') {
      const out = await next({ ctx: { ...ctx, user } })
      return out.ok ? { ...out, data: projectListAllForShareScope(out.data, grant) } : out
    }
    if (SHARE_SCOPE_PROJECTED_METHODS.has(path)) {
      const out = await next({ ctx: { ...ctx, user } })
      return out.ok ? { ...out, data: projectShareScopeRows(out.data, grant) } : out
    }
    return next({ ctx: { ...ctx, user } })
  }
  // A non-admin who is allowed to READ a device is not thereby allowed to
  // read the credential that opens it. `deviceManager.getDevice` &co. are
  // `auth: 'protected'`, so a read-only `category:system` grant reaches
  // them — and the raw row carries `config.password` in plaintext. The value
  // is withheld HERE, at the transport boundary, so in-process callers
  // (`ctx.api`, the drivers that must actually connect) are unaffected.
  const redactConfigSecrets = NON_ADMIN_CONFIG_REDACTED_METHODS.get(path)
  const out = await next({ ctx: { ...ctx, user } })
  if (!out.ok) return out
  // A device-scoped principal ENUMERATES only its own devices (F1 #4). The
  // matcher lets a `device`-selector grant reach `deviceManager.listAll`
  // precisely because the answer is cut here.
  if (DEVICE_ENUMERATION_METHODS.has(path)) {
    const projected = projectListAllForPrincipal(
      out.data,
      false,
      verdict.scopes,
      ctx.deviceFleet?.() ?? [],
    )
    return {
      ...out,
      data: redactConfigSecrets ? redactConfigSecrets(projected) : projected,
    }
  }
  // Batch device methods need no response projection: the matcher already
  // required EVERY device the request names to be covered.
  if (redactConfigSecrets) {
    return { ...out, data: redactConfigSecrets(out.data) }
  }
  return out
})

/**
 * Destructive-ops gate. Adds an explicit admin check on top of
 * `protectedProcedure`. Useful on hand-written routes whose admin-only
 * nature should be obvious to a code reader.
 */
export const adminProcedure = protectedProcedure.use(({ ctx, next, path }) => {
  // A viewer passes the admin tier only on a method of a feature it was
  // granted (D921); the matcher in `protectedProcedure` already checked the
  // feature and every device the call names.
  if (!ctx.user.isAdmin && !viewerPassesAdminTier(ctx.user.scopes ?? [], path)) {
    throw trpcUserError('FORBIDDEN', 'auth.admin-required', undefined, 'Admin required')
  }
  return next({ ctx })
})
