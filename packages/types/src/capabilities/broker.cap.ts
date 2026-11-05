import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `broker` — the pub/sub bus of a connection, system-scoped collection.
 *
 * A broker is an INSTANCE (D1013): it is created, listed, edited, signed in and tested through
 * `integration-instances` (a kind whose `functionCap` is `broker`). This cap keeps only what a
 * consumer needs once the connection exists: `publish` / `subscribe` / `unsubscribe` /
 * `getState` (kind-specific target, filter and key, typed `Record<string, unknown>` on the wire),
 * `getBrokerConfig` (the kind-specific connection config a consumer needs to open its own
 * client) and `getStatus`.
 *
 * `subscribe` returns a subscription handle; the message stream flows over the event bus as
 * `broker.message` events keyed by `(brokerId, subscriptionId)` (events are telemetry, D8: a
 * dropped message is recoverable through `getState({ key })`). Subscriptions persist across
 * reconnects — the provider re-subscribes upstream after a transport drop.
 */

export const BrokerStatusEnum = z.enum([
  'connected',
  'disconnected',
  'connecting',
  'auth-failed',
  'unreachable',
  'error',
])
export type BrokerStatus = z.infer<typeof BrokerStatusEnum>

const RegistryStatusSchema = z.object({
  brokerCount: z.number().int().nonnegative(),
  connectedCount: z.number().int().nonnegative(),
})

const GetInputSchema = z.object({ id: z.string() })

const SettingsRecordSchema = z.record(z.string(), z.unknown())

const PublishInputSchema = z.object({
  brokerId: z.string(),
  /** Kind-specific routing target.
   *  MQTT: `{ topic: string, qos?: 0|1|2, retain?: boolean }`.
   *  HA:   `{ domain: string, service: string, entityId?: string, area?: string }`. */
  target: z.record(z.string(), z.unknown()),
  /** Kind-specific payload.
   *  MQTT: raw string / number / object (provider serialises).
   *  HA:   service-call `data` object (transition, brightness, …). */
  payload: z.unknown().optional(),
})

const SubscribeInputSchema = z.object({
  brokerId: z.string(),
  /** Kind-specific filter.
   *  MQTT: `{ topic: string, qos?: 0|1|2 }` — topic can include wildcards.
   *  HA:   `{ entityIds: string[] }` or `{ domain: string }`. */
  filter: z.record(z.string(), z.unknown()),
})

const SubscribeResultSchema = z.object({
  /** Stable subscription id. Used to unsubscribe and to filter the
   *  matching `broker.message` events on the bus. */
  subscriptionId: z.string(),
})

const UnsubscribeInputSchema = z.object({
  brokerId: z.string(),
  subscriptionId: z.string(),
})

const GetStateInputSchema = z.object({
  brokerId: z.string(),
  /** Kind-specific lookup key.
   *  MQTT: topic string (returns the last retained message).
   *  HA:   entity_id (returns the cached entity state). */
  key: z.string(),
})

export const brokerCapability = {
  name: 'broker',
  scope: 'system',
  mode: 'collection',
  providerKind: 'broker',
  status: { schema: RegistryStatusSchema, kind: 'poll' },
  methods: {
    // ── Connection-config (for consumers that open their own client) ─
    /** Returns the kind-specific connection config the consumer needs
     *  to open its own client (MQTT pattern: `{url, username, password,
     *  clientIdPrefix}`). HA providers MAY return the auth envelope
     *  but typical HA consumers use `publish` / `subscribe` instead.
     *  Returns `null` when the broker id is unknown to the provider. */
    getBrokerConfig: method(GetInputSchema, SettingsRecordSchema.nullable(), { auth: 'admin' }),

    // ── Pub/sub primitives ───────────────────────────────────────────
    publish: method(PublishInputSchema, z.unknown(), { kind: 'mutation', auth: 'admin' }),
    subscribe: method(SubscribeInputSchema, SubscribeResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    unsubscribe: method(UnsubscribeInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),

    /** Read the broker's cached state for a key. Returns `null` when
     *  unknown to the broker (never published / unknown entity). */
    // Admin (D634 r3): the raw upstream entity cache — a Home Assistant camera
    // entity carries an `access_token`. Only addons read it, over `ctx.api`.
    getState: method(GetStateInputSchema, z.unknown().nullable(), { auth: 'admin' }),

    /** Status method — explicit registration with a `z.void()` input so
     *  the codegen-generated tRPC router types its input as
     *  `{addonId?: string, nodeId?: string}` (system-scoped collection
     *  shape) instead of the device-scoped `{deviceId}` fallback. */
    getStatus: method(z.void(), RegistryStatusSchema),
  },
} as const satisfies CapabilityDefinition

export type IBrokerProvider = InferProvider<typeof brokerCapability>

export {
  RegistryStatusSchema as BrokerRegistryStatusSchema,
  PublishInputSchema as BrokerPublishInputSchema,
  SubscribeInputSchema as BrokerSubscribeInputSchema,
  SubscribeResultSchema as BrokerSubscribeResultSchema,
  UnsubscribeInputSchema as BrokerUnsubscribeInputSchema,
  GetStateInputSchema as BrokerGetStateInputSchema,
}
