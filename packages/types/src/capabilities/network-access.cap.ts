import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

const NetworkEndpointSchema = z.object({
  url: z.string(),
  hostname: z.string(),
  port: z.number(),
  protocol: z.enum(['http', 'https']),
  /**
   * Whether this address survives a restart of its provider. `false` = it is
   * re-issued every time (a Quick tunnel's random `*.trycloudflare.com`); the
   * hub never selects such an address AUTOMATICALLY for a role (D860), though
   * it stays visible and an operator may still flag it. Absent = stable: every
   * provider except a Quick tunnel owns a name that does not change.
   */
  stable: z.boolean().optional(),
})

/**
 * `data` of a `network.tunnel.started` event — what `local-network` (which
 * tails the bus and cannot import a provider) learns about the new address.
 */
const NetworkTunnelStartedDataSchema = z.object({
  url: z.string(),
  /** Mirrors {@link NetworkEndpointSchema} `stable`; absent = stable. */
  stable: z.boolean().optional(),
  updated: z.boolean().optional(),
})

const NetworkAccessStatusSchema = z.object({
  connected: z.boolean(),
  endpoint: NetworkEndpointSchema.nullable(),
  error: z.string().optional(),
})

export type NetworkAccessStatus = z.infer<typeof NetworkAccessStatusSchema>
export type NetworkEndpoint = z.infer<typeof NetworkEndpointSchema>
export type NetworkTunnelStartedData = z.infer<typeof NetworkTunnelStartedDataSchema>

/**
 * Optional, richer endpoint shape returned by providers that expose
 * MORE than one ingress concurrently (Tailscale Ingress with mixed
 * serve+funnel rules, future ngrok multi-tunnel, …). Each entry carries
 * the originating provider config (mode + sourcePort) so the
 * orchestrator UI can label rows distinctly. Providers that expose only
 * one endpoint just omit `listEndpoints` from their provider impl.
 */
const NetworkEndpointEntrySchema = NetworkEndpointSchema.extend({
  /**
   * Stable id within the provider — typically `<mode>-<sourcePort>` so
   * the orchestrator can dedupe across `listEndpoints` polls.
   */
  id: z.string(),
  /** Operator-facing label (mirrors `MeshEndpoint.label`). */
  label: z.string(),
  /** Optional provider-specific mode tag, used for icon/colour in admin UI. */
  mode: z.string().optional(),
  /** Originating local port the ingress fronts (informational). */
  sourcePort: z.number().optional(),
})

export const networkAccessCapability = {
  name: 'network-access',
  scope: 'system',
  mode: 'collection',
  providerKind: 'ingress',
  methods: {
    start: method(z.void(), NetworkEndpointSchema, { kind: 'mutation' }),
    stop: method(z.void(), z.void(), { kind: 'mutation' }),
    getEndpoint: method(z.void(), NetworkEndpointSchema.nullable()),
    getStatus: method(z.void(), NetworkAccessStatusSchema),
    /**
     * Enumerate every active ingress entry. Providers that expose only a
     * single endpoint may omit this method; callers fall back to
     * `getEndpoint()` in that case.
     */
    listEndpoints: method(z.void(), z.array(NetworkEndpointEntrySchema).readonly()),
  },
} as const satisfies CapabilityDefinition

export type INetworkAccessProvider = InferProvider<typeof networkAccessCapability>

export {
  NetworkEndpointSchema,
  NetworkTunnelStartedDataSchema,
  NetworkAccessStatusSchema,
  NetworkEndpointEntrySchema,
}
