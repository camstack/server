/**
 * Test harness for codegen'd capability tRPC routers.
 *
 * Provides helpers to:
 *  - Build a minimal `TrpcContext` per auth role (anonymous/user/admin/agent)
 *  - Wrap a `createCapRouter_X` with a mock provider and get a typed caller
 *  - Assert that a procedure enforces the expected auth level
 *  - Drive subscriptions via mock push callbacks
 *
 * This harness is the foundation for per-cap `.router.spec.ts` files. See
 * `system-info.router.spec.ts` for a usage example.
 */
import { TRPCError } from '@trpc/server'
import { buildCapRouters, type CapRouterServices } from '@camstack/system'
import { kebabToCamel } from '@camstack/types'
import type { TrpcContext, AuthenticatedAgent } from '../../api/trpc/trpc.context.js'
import { createCapRouterPrimitives } from '../../api/trpc/cap-router-runtime.js'

// v2 auth model — there's no role enum, just `isAdmin`. The harness
// exposes four synthetic identities covering every gate we ship:
//   anonymous : no auth (null user)
//   user      : authenticated, isAdmin=false (the only non-admin tier)
//   admin     : authenticated, isAdmin=true
//   agent     : authenticated, isAdmin=true with `agentId` set
export type AuthLevel = 'public' | 'protected' | 'admin'
export type TestRole = 'anonymous' | 'user' | 'admin' | 'agent'

/** Build an AuthenticatedAgent stub for a given synthetic identity. */
export function makeUser(
  role: Exclude<TestRole, 'anonymous'>,
  overrides: Partial<AuthenticatedAgent> = {},
): AuthenticatedAgent {
  const isAdmin = role === 'admin' || role === 'agent'
  const base: AuthenticatedAgent = {
    id: `user-${role}`,
    username: role,
    isAdmin,
    permissions: { isAdmin, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    // Authorization reads the scopes (D892): an admin holds `'*'`.
    ...(isAdmin ? { scopes: ['*'] } : {}),
  }
  return { ...base, ...overrides }
}

/** Build a minimal TrpcContext with the given identity (or `anonymous` for an unauthenticated ctx). */
export function makeCtx(role: TestRole, overrides: Partial<AuthenticatedAgent> = {}): TrpcContext {
  const user = role === 'anonymous' ? null : makeUser(role, overrides)
  // `req` is only used by subscription/WS plumbing which we don't exercise here.
  // Cast via `unknown` to avoid pulling in a full Fastify stub.
  return { user, req: {} as unknown as TrpcContext['req'] }
}

/**
 * Identities that SHOULD pass for each auth level (positive set).
 * Anything outside the allow-list should receive UNAUTHORIZED or FORBIDDEN.
 */
export const ALLOWED_ROLES_BY_AUTH: Readonly<Record<AuthLevel, readonly TestRole[]>> = {
  public: ['anonymous', 'user', 'admin', 'agent'],
  protected: ['user', 'admin', 'agent'],
  admin: ['admin', 'agent'],
}

export const ALL_ROLES: readonly TestRole[] = ['anonymous', 'user', 'admin', 'agent']

/** Determine whether a synthetic identity should be allowed to call a procedure with the given auth level. */
export function isRoleAllowed(role: TestRole, auth: AuthLevel): boolean {
  return ALLOWED_ROLES_BY_AUTH[auth].includes(role)
}

/**
 * Minimal router interface returned by the codegen. Each method is a tRPC procedure;
 * calling `.createCaller(ctx)` returns an object with one async function per method.
 */
export interface CreateCallerCapableRouter {
  readonly createCaller: (ctx: TrpcContext) => Record<string, (input?: unknown) => unknown>
}

/** Structural method bag a resolved provider satisfies inside the builder. */
type MethodBag = Readonly<Record<string, (input?: unknown) => unknown>>

/**
 * Build a single capability's tRPC router via the LIVE runtime builder
 * (`@camstack/system` `buildCapRouters`) with a mock provider — the
 * drop-in replacement for the retired codegen `createCapRouter_<Cap>`
 * value factories. Tests now exercise the EXACT router the running hub
 * builds (structural output pass-through, `mount`-driven resolution),
 * not the value-dead codegen path.
 *
 * `getProvider(ctx)` returns the mock provider (or null → the procedure
 * surfaces PRECONDITION_FAILED). `createRemoteProxy` mirrors the codegen
 * factory's optional second arg for cross-node routing tests.
 */
export function buildCapRouterForTest(
  capName: string,
  getProvider: (ctx: TrpcContext, addonId?: string) => unknown,
  createRemoteProxy?: (capName: string, nodeId: string) => unknown,
): CreateCallerCapableRouter {
  const services = testCapRouterServices(capName, getProvider, createRemoteProxy)
  const routers = buildCapRouters(createCapRouterPrimitives(), services)
  const router = routers[kebabToCamel(capName)]
  if (router === undefined) {
    throw new Error(`buildCapRouterForTest: no router built for cap "${capName}"`)
  }
  return router as CreateCallerCapableRouter
}

/** A router whose caller is nested one level, under the cap's camel key. */
interface MountedCapRouter {
  readonly createCaller: (
    ctx: TrpcContext,
  ) => Readonly<Record<string, Record<string, (input?: unknown) => unknown>>>
}

/**
 * Like {@link buildCapRouterForTest}, but the cap router is MOUNTED under its
 * camel key (`motionTrigger.setMotionTrigger`), as the hub mounts it. The
 * scope matcher (`authorizeProcedure`) keys on the full tRPC path: a
 * standalone router reports `setMotionTrigger`, which is not in
 * `METHOD_ACCESS_MAP`, so the device grant is never consulted. A spec that
 * asserts what a device grant reaches must use this builder.
 */
export function buildMountedCapRouterForTest(
  capName: string,
  getProvider: (ctx: TrpcContext, addonId?: string) => unknown,
): CreateCallerCapableRouter {
  const primitives = createCapRouterPrimitives()
  const key = kebabToCamel(capName)
  const inner = buildCapRouters(primitives, testCapRouterServices(capName, getProvider))[key]
  if (inner === undefined) {
    throw new Error(`buildMountedCapRouterForTest: no router built for cap "${capName}"`)
  }
  // Documented test boundary, as above: the builder types routers as `unknown`.
  const root = primitives.router({ [key]: inner }) as MountedCapRouter
  return {
    createCaller: (ctx) => {
      const nested = root.createCaller(ctx)[key]
      if (nested === undefined) throw new Error(`no caller mounted at "${key}"`)
      return nested
    },
  }
}

function testCapRouterServices(
  capName: string,
  getProvider: (ctx: TrpcContext, addonId?: string) => unknown,
  createRemoteProxy?: (capName: string, nodeId: string) => unknown,
): CapRouterServices {
  return {
    getLocalProvider: (name, _mountKind, ctx, addonId) =>
      name === capName ? (getProvider(ctx as TrpcContext, addonId) as MethodBag | null) : null,
    remoteProxy: (name, nodeId) =>
      createRemoteProxy ? (createRemoteProxy(name, nodeId) as MethodBag | null) : null,
    noProvider: (name, nodeId) => {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message:
          nodeId !== undefined && nodeId !== 'hub'
            ? `Capability "${name}" not available on node "${nodeId}"`
            : `Capability "${name}" provider not available`,
      })
    },
    noNodeRouting: (name) => {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Node routing not available for "${name}"`,
      })
    },
    badRequest: (message) => {
      throw new TRPCError({ code: 'BAD_REQUEST', message })
    },
  }
}

/**
 * Invoke a procedure and capture the outcome (ok | trpc error code | other throw).
 * Useful for auth matrix assertions without leaking exceptions.
 */
export async function invokeProcedure(
  router: CreateCallerCapableRouter,
  procedure: string,
  ctx: TrpcContext,
  input?: unknown,
): Promise<{ ok: true; value: unknown } | { ok: false; code: string; message: string }> {
  try {
    const caller = router.createCaller(ctx)
    const fn = caller[procedure]
    if (typeof fn !== 'function') {
      return { ok: false, code: 'NOT_FOUND', message: `procedure "${procedure}" missing on caller` }
    }
    const value = await fn(input)
    return { ok: true, value }
  } catch (err) {
    if (err instanceof TRPCError) {
      return { ok: false, code: err.code, message: err.message }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, code: 'THROWN', message }
  }
}

/**
 * Assert that a procedure enforces the expected auth level: each identity in `ALL_ROLES`
 * should either succeed (allowed) or fail with UNAUTHORIZED/FORBIDDEN (denied).
 *
 * @returns An array of `{ role, allowed, outcome }` describing what happened — useful
 *          for building focused expectations in the calling test.
 */
export async function checkAuthMatrix(
  router: CreateCallerCapableRouter,
  procedure: string,
  auth: AuthLevel,
  input?: unknown,
): Promise<
  ReadonlyArray<{
    readonly role: TestRole
    readonly allowed: boolean
    readonly outcome: Awaited<ReturnType<typeof invokeProcedure>>
  }>
> {
  const results: Array<{
    role: TestRole
    allowed: boolean
    outcome: Awaited<ReturnType<typeof invokeProcedure>>
  }> = []
  for (const role of ALL_ROLES) {
    const outcome = await invokeProcedure(router, procedure, makeCtx(role), input)
    results.push({ role, allowed: isRoleAllowed(role, auth), outcome })
  }
  return results
}

/**
 * Collect the first N values pushed to a subscription within `timeoutMs`.
 * The codegen wraps subscriptions with `iterableSubscription`, which yields an
 * async iterator — this helper just reads `count` values and returns them.
 */
export async function collectSubscription<T = unknown>(
  iter: AsyncIterable<T>,
  count: number,
  timeoutMs = 1000,
): Promise<readonly T[]> {
  const out: T[] = []
  const iterator = iter[Symbol.asyncIterator]()
  const deadline = Date.now() + timeoutMs
  while (out.length < count) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((_, reject) =>
        setTimeout(() => reject(new Error('collectSubscription timeout')), remaining),
      ),
    ])
    if (result.done) break
    out.push(result.value)
  }
  // Best-effort cleanup — async generators from iterableSubscription handle return() in their finally block.
  await iterator.return?.()
  return out
}
