import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

const AddonHttpRouteSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  path: z.string(),
  access: z.enum(['public', 'authenticated', 'admin']).optional(),
  description: z.string().optional(),
  /** The hub limits this route per client address before the handler runs. */
  rateLimit: z.enum(['auth']).optional(),
})

/**
 * Cross-process route invocation envelope. The hub captures the
 * request as plain data, ships it to the worker via Moleculer, and
 * the worker runs the local handler against a capturing reply. The
 * envelope returned describes what the handler intended (status,
 * headers, body, or a redirect) so the hub can translate it back to
 * the Fastify reply that's actually wired to the socket.
 */
const InvokeRequestSchema = z.object({
  method: z.string(),
  path: z.string(),
  params: z.record(z.string(), z.string()),
  query: z.record(z.string(), z.string()),
  body: z.unknown(),
  headers: z.record(z.string(), z.string()),
  user: z
    .object({
      id: z.string(),
      username: z.string(),
      isAdmin: z.boolean(),
    })
    .optional(),
  scopedToken: z.unknown().optional(),
})

const InvokeReplyEnvelopeSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  /** When set, the hub MUST `reply.redirect(redirectUrl)` instead of
   *  sending `body`. Status defaults to 302 when this is set unless
   *  the handler called `reply.code(...)` explicitly. */
  redirectUrl: z.string().nullable(),
  /** JSON-serializable body. `undefined` is treated as "no body". */
  body: z.unknown().optional(),
  /** Set when the handler called `reply.type(mime)`. */
  contentType: z.string().optional(),
})

export const addonRoutesCapability = {
  name: 'addon-routes',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    getRoutes: method(z.void(), z.array(AddonHttpRouteSchema)),
    /**
     * Cross-process dispatch entry point. Forked addons implement this
     * (via `buildAddonRouteProvider`) so the hub's Fastify catch-all
     * can route through Moleculer when the handler lives in a worker.
     *
     * Local addons can implement it for free with the same helper;
     * the hub bypasses the wire on co-located addons.
     */
    invoke: method(InvokeRequestSchema, InvokeReplyEnvelopeSchema, { kind: 'mutation' }),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/system` `buildCapRouters`. */
  mount: { kind: 'skip' },
} as const satisfies CapabilityDefinition

export type IAddonRoutesProvider = InferProvider<typeof addonRoutesCapability>
export { InvokeRequestSchema, InvokeReplyEnvelopeSchema }
