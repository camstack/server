import type {
  AddonHttpReply,
  AddonHttpRequest,
  IAddonHttpRoute,
  IAddonRouteProvider,
} from '../interfaces/addon-routes.js'

/**
 * Cross-process bridge envelope returned by the cap's `invoke` method.
 * The hub's Fastify catch-all reads this and reproduces the intent
 * onto the real reply (status, headers, body, or redirect).
 */
export interface AddonRouteInvokeRequest {
  readonly method: string
  readonly path: string
  readonly params: Record<string, string>
  readonly query: Record<string, string>
  readonly body: unknown
  readonly headers: Record<string, string>
  readonly user?: {
    readonly id: string
    readonly username: string
    readonly isAdmin: boolean
  }
  readonly scopedToken?: unknown
}

export interface AddonRouteReplyEnvelope {
  status: number
  headers: Record<string, string>
  redirectUrl: string | null
  body?: unknown
  contentType?: string
}

/**
 * Build an `IAddonRouteProvider` from a list of routes. Implements
 * both the operator-facing `getRoutes` (returning route descriptors
 * minus the handlers, which can't cross JSON) and the framework-
 * private `invoke` method that the hub calls when this provider lives
 * in a forked worker.
 *
 * Co-located addons use the returned `getRoutes` directly because
 * their handlers don't need to cross any wire. The `invoke` method
 * is present anyway so the bridge code on the hub is uniform — it
 * doesn't need to switch on "local vs remote provider" at the call
 * site.
 *
 * Example:
 *   const routes: IAddonHttpRoute[] = [
 *     { method: 'GET', path: '/start', access: 'public', handler: this.handleStart },
 *   ]
 *   return [
 *     {
 *       capability: addonRoutesCapability,
 *       provider: buildAddonRouteProvider('auth-oidc', routes),
 *     },
 *   ]
 */
export function buildAddonRouteProvider(
  id: string,
  routes: readonly IAddonHttpRoute[],
): IAddonRouteProvider & {
  // The cap surface auto-discovers methods on the provider object,
  // so we expose `invoke` alongside `getRoutes`. The IAddonRouteProvider
  // interface from `interfaces/addon-routes.ts` only requires `id` +
  // `getRoutes`; the `invoke` method is the bridge contract.
  invoke(input: AddonRouteInvokeRequest): Promise<AddonRouteReplyEnvelope>
} {
  return {
    id,
    getRoutes: () => routes as IAddonHttpRoute[],
    invoke: async (input) => {
      const match = matchRoute(routes, input.method, input.path)
      if (!match) {
        return {
          status: 404,
          headers: {},
          redirectUrl: null,
          body: { error: `No route matches ${input.method} ${input.path}` },
        }
      }
      const envelope: AddonRouteReplyEnvelope = {
        status: 200,
        headers: {},
        redirectUrl: null,
      }
      const reply = buildCapturingReply(envelope)
      const request: AddonHttpRequest = {
        // The hub already matched the route; its params win over a re-match.
        params: { ...match.params, ...input.params },
        query: input.query,
        body: input.body,
        headers: input.headers,
        ...(input.user ? { user: input.user } : {}),
        // The scopedToken shape is intentionally `unknown` on the wire
        // (it includes nested `TokenScope` discriminated unions that
        // wouldn't gain from re-validation across the bridge).
        ...(input.scopedToken !== undefined ? { scopedToken: input.scopedToken as never } : {}),
      }
      await match.route.handler(request, reply)
      return envelope
    },
  }
}

/**
 * Pattern matcher: same semantics as `AddonRouteRegistry.matchRoute`
 * but operating on a flat list and bypassing the `/addon/<id>/` prefix
 * — the bridge sends the post-prefix path directly so we don't need
 * to round-trip it through normalization.
 */
function matchRoute(
  routes: readonly IAddonHttpRoute[],
  method: string,
  path: string,
): { route: IAddonHttpRoute; params: Record<string, string> } | null {
  const normalizedMethod = method.toUpperCase()
  for (const route of routes) {
    if (route.method !== normalizedMethod) continue
    const params = matchPath(route.path, path)
    if (params !== null) return { route, params }
  }
  return null
}

function matchPath(pattern: string, p: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean)
  const pathParts = p.split('/').filter(Boolean)
  if (patternParts.length !== pathParts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const a = patternParts[i]!
    const b = pathParts[i]!
    if (a.startsWith(':')) params[a.slice(1)] = b
    else if (a !== b) return null
  }
  return params
}

function buildCapturingReply(envelope: AddonRouteReplyEnvelope): AddonHttpReply {
  const wrapper: AddonHttpReply = {
    status(code: number) {
      envelope.status = code
      return wrapper
    },
    code(code: number) {
      envelope.status = code
      return wrapper
    },
    send(data: unknown) {
      envelope.body = data
    },
    redirect(url: string) {
      envelope.redirectUrl = url
      // A handler that called .code() before .redirect() keeps its
      // chosen code (e.g. 301). Otherwise default to 302.
      if (envelope.status === 200) envelope.status = 302
    },
    header(name: string, value: string) {
      envelope.headers[name.toLowerCase()] = value
      return wrapper
    },
    type(mime: string) {
      envelope.contentType = mime
      return wrapper
    },
  }
  return wrapper
}
