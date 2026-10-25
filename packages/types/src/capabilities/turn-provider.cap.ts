import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * A single ICE TURN/STUN server entry, shape compatible with
 * `RTCIceServer` in the WebRTC spec.
 */
const TurnServerSchema = z.object({
  /** Single URL or list of URLs (e.g. "turn:turn.example.com:3478?transport=udp"). */
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
})

/**
 * turn-provider — system collection of TURN/STUN server providers.
 *
 * Consumed by `webrtc` providers when building the
 * ICE server list for an offer. Multiple providers can coexist
 * (Cloudflare, self-hosted coturn, Twilio, etc.) — the webrtc layer
 * concatenates servers from all registered implementations.
 *
 * Exposed over tRPC so that out-of-process addons (forked workers or
 * remote agents) can also enumerate available TURN servers without
 * requiring in-process access to the capability registry.
 */
export const turnProviderCapability = {
  name: 'turn-provider',
  scope: 'system',
  mode: 'collection',
  methods: {
    /**
     * Return the current list of TURN/STUN servers with credentials.
     * Implementations may fetch fresh short-lived credentials on each call
     * (e.g. Cloudflare API) — consumers SHOULD call this per-session.
     */
    getTurnServers: method(z.void(), z.array(TurnServerSchema).readonly(), { role: 'viewer' }),
  },
} as const satisfies CapabilityDefinition

export type ITurnProvider = InferProvider<typeof turnProviderCapability>

export { TurnServerSchema }
