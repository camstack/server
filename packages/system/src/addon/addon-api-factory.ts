/**
 * Factory for creating tRPC clients for addons.
 *
 * In-process only: `createDirectCaller()` uses tRPC's `createCallerFactory`
 * to call procedures directly (zero network overhead) and wraps the raw
 * caller in a proxy so it matches `CreateTRPCClient<AppRouter>` shape —
 * addons use `context.api.namespace.method.query(input)` identically to
 * the cross-process path.
 *
 * Cross-process calls (forked workers, remote agents) ride the Moleculer
 * broker via `brokerTransportLink` in the kernel — not this factory.
 */

export interface DirectCallerOptions {
  /** The tRPC router instance (from buildAppRouter) */
  readonly router: unknown
  /** Context for the caller (user identity, etc.) */
  readonly context: {
    readonly user: { readonly id: string; readonly username: string; readonly role: string }
  }
}

/**
 * Wrap a raw tRPC caller (from `createCallerFactory`) in a proxy that
 * exposes each leaf procedure as `{ query, mutate, subscribe }`, matching
 * the shape of `CreateTRPCClient<AppRouter>`.
 *
 * The tricky part: tRPC v11 callers expose nested routers as callable
 * no-op functions (e.g. `caller.greet` is `typeof === 'function'`), so
 * we can't use `typeof` to tell namespace from leaf. Instead, we return
 * a unified proxy that handles BOTH behaviours:
 *
 *   - Accessing `.query` / `.mutate` treats the current node as a leaf
 *     procedure and invokes `caller(input)` when called.
 *   - Accessing `.subscribe` throws (not supported on direct caller).
 *   - Accessing any other property descends into `caller[prop]` and
 *     returns a nested proxy.
 */
function wrapCallerAsClient<T>(caller: unknown): T {
  return new Proxy(Object.create(null) as Record<string, unknown>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined

      if (prop === 'query' || prop === 'mutate') {
        // Leaf-mode: the current `caller` is expected to be a procedure
        // function. The tRPC caller accepts the raw input as its first
        // argument and returns `Promise<output>`.
        if (typeof caller !== 'function') {
          throw new Error(`Cannot call .${prop}() — this tRPC node is not a procedure`)
        }
        const fn = caller as (input?: unknown) => Promise<unknown>
        return (input?: unknown) => fn(input)
      }

      if (prop === 'subscribe') {
        return () => {
          throw new Error(
            `subscribe() is not supported on direct caller — use the WSS client for subscriptions`,
          )
        }
      }

      // Namespace descent — keep walking the caller tree.
      const child = (caller as Record<string, unknown> | null | undefined)?.[prop]
      if (child === undefined || child === null) return undefined
      return wrapCallerAsClient<unknown>(child)
    },
  }) as T
}

export class AddonApiFactory {
  /**
   * Create a direct caller -- calls tRPC procedures directly in-process.
   * Zero network overhead. Used for in-process addons and dev mode.
   *
   * Returns `AddonApi` — the same tRPC client surface that broker-routed
   * callers get. Callers treat it uniformly as `context.api` regardless
   * of the underlying transport.
   */
  async createDirectCaller(
    options: DirectCallerOptions,
  ): Promise<import('@camstack/types').AddonApi> {
    const { initTRPC } = await import('@trpc/server')
    const t = initTRPC.create()
    type RouterLike = Parameters<typeof t.createCallerFactory>[0]
    const callerFactory = t.createCallerFactory(options.router as RouterLike)
    type CallerContext = Parameters<ReturnType<typeof t.createCallerFactory>>[0]
    const caller = callerFactory(options.context as CallerContext)
    return wrapCallerAsClient<import('@camstack/types').AddonApi>(caller)
  }
}
