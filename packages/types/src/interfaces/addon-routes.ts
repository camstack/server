import type { TokenScope } from './scoped-token.js'

export type RouteAccess = 'public' | 'authenticated' | 'admin'

/**
 * Request object passed to addon route handlers.
 */
export interface AddonHttpRequest {
  readonly params: Record<string, string>
  readonly query: Record<string, string>
  readonly body: unknown
  readonly headers: Record<string, string>
  /** Populated for 'authenticated' and 'admin' routes */
  readonly user?: {
    readonly id: string
    readonly username: string
    readonly isAdmin: boolean
  }
  /** Populated when request uses a scoped token */
  readonly scopedToken?: {
    readonly id: string
    readonly userId: string
    readonly scopes: TokenScope[]
  }
}

/**
 * Reply object for addon route handlers. Method names mirror Fastify's
 * `FastifyReply` surface so addons that already think in Fastify terms
 * don't need to relearn — `status`/`code` are aliases, both work.
 */
export interface AddonHttpReply {
  status(code: number): AddonHttpReply
  /** Alias for `status(code)` — matches Fastify's reply.code(n). */
  code(code: number): AddonHttpReply
  send(data: unknown): void
  redirect(url: string): void
  header(name: string, value: string): AddonHttpReply
  /** Set the Content-Type header — matches Fastify's reply.type(mime). */
  type(mime: string): AddonHttpReply
}

/**
 * A single HTTP route registered by an addon.
 */
/**
 * Per-client-IP limiting the HUB applies before a route's handler runs.
 * `'auth'` — a public sign-in leg (an IdP start or callback): 30 per minute
 * per client address. The address is the real client behind a trusted proxy.
 */
export type RouteRateLimit = 'auth'

export interface IAddonHttpRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly path: string
  readonly access: RouteAccess
  readonly description?: string
  readonly rateLimit?: RouteRateLimit
  readonly handler: (request: AddonHttpRequest, reply: AddonHttpReply) => Promise<void>
}

/**
 * Provider interface for addons that expose HTTP endpoints.
 */
export interface IAddonRouteProvider {
  readonly id: string
  getRoutes(): IAddonHttpRoute[]
}
