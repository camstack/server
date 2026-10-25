import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * `mqtt-broker` — broker-registry cap.
 *
 * NOT a pub/sub proxy. The cap exposes (a) a registry of configured
 * MQTT brokers (external + optionally an embedded `aedes`-backed one)
 * and (b) the connection details a consumer addon needs to spin up
 * its OWN `mqtt.js` client.
 *
 * Why: pub/sub routing over the system event-bus loses fidelity
 * (callback shape, QoS guarantees, will/retain semantics) and adds
 * refcount bookkeeping that addons would rather own themselves. The
 * canonical consumer needs raw `mqtt.js`
 * features anyway — give it the connection config, get out of the way.
 *
 * Consumer flow:
 *   const cfg = await ctx.api.mqttBroker.getBrokerConfig({ id })
 *   const client = mqtt.connect(cfg.url, { username: cfg.username, … })
 *   client.subscribe('zigbee2mqtt/+')
 *
 * Collection mode: multiple brokers (e.g. one local mosquitto + one
 * cloud bridge). The "embedded" entry (when present) is just another
 * broker in the registry — its lifecycle is owned by the addon that
 * spawned it.
 */

const BrokerKindSchema = z.enum(['external', 'embedded'])

/**
 * Broker live-probe status.
 *
 * - `connected` — last probe completed a clean CONNACK
 * - `disconnected` — no probe has run yet (cold cache)
 * - `auth-failed` — CONNACK refused with auth error (RC 4 / 5)
 * - `unreachable` — TCP connect timed out / refused
 * - `tls-error` — TLS handshake failed (cert / SNI / cipher)
 */
const BrokerStatusSchema = z.enum([
  'connected',
  'disconnected',
  'auth-failed',
  'unreachable',
  'tls-error',
])

const BrokerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  kind: BrokerKindSchema,
  status: BrokerStatusSchema,
  latencyMs: z.number().nullable(),
  error: z.string().optional(),
  /** Embedded brokers only: number of MQTT clients currently connected. */
  connectedClients: z.number().int().nonnegative().optional(),
  /** Epoch ms of the last live probe (external) or aedes snapshot (embedded). */
  lastCheckedAt: z.number().optional(),
})

export type BrokerInfo = z.infer<typeof BrokerInfoSchema>
export type BrokerStatus = z.infer<typeof BrokerStatusSchema>

/**
 * Connection details — what a consumer needs to call
 * `mqtt.connect(url, options)`. We split URL + credentials so the
 * consumer can pass them as `mqtt.connect(url, { username, password })`
 * instead of stuffing creds into the URL (which leaks them into logs).
 */
const BrokerConnectionDetailsSchema = z.object({
  url: z.string(),
  username: z.string().optional(),
  password: z.string().optional(),
  /**
   * Suggested prefix for `clientId`. Each consumer should suffix this
   * with its own discriminator (addon id, instance id) so reconnects
   * don't kick each other off (MQTT spec: clientId must be unique per
   * broker).
   */
  clientIdPrefix: z.string().optional(),
})

export type BrokerConnectionDetails = z.infer<typeof BrokerConnectionDetailsSchema>

const AddBrokerInputSchema = z.object({
  name: z.string().min(1),
  url: z.string().regex(/^(mqtt|mqtts|ws|wss):\/\//, 'URL must start with mqtt(s):// or ws(s)://'),
  username: z.string().optional(),
  password: z.string().optional(),
  clientIdPrefix: z.string().optional(),
})

const AddBrokerResultSchema = z.object({
  id: z.string(),
})

const IdInputSchema = z.object({ id: z.string() })

const TestResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), latencyMs: z.number() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

const StartEmbeddedInputSchema = z.object({
  port: z.number().int().min(1).max(65535).default(1883),
  /** Allow anonymous connect (no username/password). Default: false. */
  allowAnonymous: z.boolean().default(false),
  /** Optional shared username/password for clients. */
  username: z.string().optional(),
  password: z.string().optional(),
})

const StartEmbeddedResultSchema = z.object({
  id: z.string(),
  url: z.string(),
})

const StatusSchema = z.object({
  brokerCount: z.number(),
  embeddedRunning: z.boolean(),
})

export const mqttBrokerCapability = {
  name: 'mqtt-broker',
  scope: 'system',
  mode: 'collection',
  providerKind: 'broker',
  status: { schema: StatusSchema, kind: 'poll' },
  methods: {
    // ── Tiers (D634 r3) ────────────────────────────────────────────
    // `getBrokerConfig` returns the DECRYPTED broker password — by design, for
    // addons that connect (`ctx.api`, which never enters the tRPC router). As
    // `protected` it handed every viewer every broker password. The CRUD and
    // embedded-broker controls are an administrator's too. No UI calls any of
    // them; `listBrokers` and `getStatus` stay open (URL userinfo is masked at
    // the transport boundary for a non-admin).
    listBrokers: method(z.void(), z.array(BrokerInfoSchema)),
    getBrokerConfig: method(IdInputSchema, BrokerConnectionDetailsSchema, { auth: 'admin' }),
    addBroker: method(AddBrokerInputSchema, AddBrokerResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    removeBroker: method(IdInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),
    testConnection: method(IdInputSchema, TestResultSchema, { kind: 'mutation', auth: 'admin' }),
    startEmbeddedBroker: method(StartEmbeddedInputSchema, StartEmbeddedResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    stopEmbeddedBroker: method(IdInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),
    getStatus: method(z.void(), StatusSchema),
  },
} as const satisfies CapabilityDefinition

export type IMqttBrokerProvider = InferProvider<typeof mqttBrokerCapability>

export {
  AddBrokerInputSchema,
  BrokerConnectionDetailsSchema,
  BrokerInfoSchema,
  StartEmbeddedInputSchema,
  StatusSchema as MqttBrokerStatusSchema,
}
