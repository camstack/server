import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `broker` — unified pub/sub broker registry, system-scoped collection.
 *
 * The cap models any kind-tagged message broker the user wants to
 * register and that other addons might consume. The first two kinds
 * are MQTT (mosquitto / aedes embedded / cloud bridge) and
 * Home Assistant (HA WebSocket — subscribe_entities + call_service).
 * Future kinds (Zigbee2MQTT bridge, ZHA, KNX, Telegram, …) plug in
 * the same surface.
 *
 * Why one cap, not one cap per kind:
 *   - The integrations page wants a single table of "every broker"
 *     across kinds; a unified cap drives it without join logic.
 *   - Generic admin operations (add / remove / test / status) are
 *     identical across kinds — duplicating them per cap was busywork.
 *   - The `network-access` cap precedent: same interface, many
 *     `providerKind: 'ingress'` implementations (Tailscale, ngrok, …).
 *
 * What stays kind-specific:
 *   - `getBrokerConfig` payload (kind decides whether it returns
 *     mqtt URL+creds, HA baseUrl+token, …) — typed as
 *     `Record<string, unknown>` at the wire; consumers narrow.
 *   - `publish` / `subscribe` / `getState` arguments (target / filter /
 *     key) — also typed as `Record<string, unknown>` so each kind can
 *     evolve its surface (MQTT topic+qos vs HA entity_id+domain)
 *     without rebreaking the cap signature.
 *   - `add` `settings` payload (different fields per kind, validated by
 *     the kind-specific provider).
 *
 * Bidirectionality:
 *   - `publish` is RPC — synchronous result (provider-defined).
 *   - `subscribe` returns a subscription handle; the actual message
 *     stream flows over the typed event-bus as `broker.message` events
 *     keyed by `(brokerId, subscriptionId)`. Consumers filter in their
 *     event handler. Subscriptions persist across reconnects — the
 *     provider re-subscribes upstream after a transport drop.
 *
 * Why event-bus push (not a subscription RPC stream):
 *   - Matches the rest of CamStack's D8 contract — events for telemetry,
 *     RPC for loss-is-a-bug. Broker messages are telemetry (a single
 *     drop is recoverable via `getState({key})`).
 *   - Frees `broker.subscribe` from holding a long-lived RPC channel.
 *   - Cross-process: events already route through `$event-bus`; no
 *     per-broker wire-shaping needed.
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

const BrokerInfoSchema = z.object({
  /** Stable broker id. Persisted; survives addon restarts. */
  id: z.string(),
  /** Addon id of the provider that OWNS this broker.
   *
   *  The `broker` cap is a system-scoped collection: several addons
   *  register a `broker` provider, each owning a DISJOINT set of
   *  brokers (mqtt-broker owns `mqtt_*`, provider-homeassistant owns
   *  `ha_*`). A broker therefore belongs to exactly one addon — like a
   *  device belongs to one integration. The admin UI threads this id
   *  back as the `{ addonId }` system-collection selector on every
   *  id-keyed call (`get` / `getSettings` / `setSettings` / `remove` /
   *  `testConnection`), so the call routes to the OWNING provider
   *  instead of defaulting to the first-registered one. */
  addonId: z.string(),
  /** Human-readable name (operator-chosen at add-time). */
  name: z.string(),
  /** Provider-defined kind tag — `mqtt` / `home-assistant` / future. */
  kind: z.string(),
  status: BrokerStatusEnum,
  /** Free-form provider-specific info (HA version, MQTT broker
   *  flavour, latency, mTLS active, …). */
  info: z.record(z.string(), z.unknown()),
  /** Ms epoch of the last connection probe / status update. */
  lastCheckedAt: z.number().nullable(),
  /** Last error message, when `status` indicates failure. */
  error: z.string().nullable(),
})

export type BrokerInfo = z.infer<typeof BrokerInfoSchema>

const RegistryStatusSchema = z.object({
  brokerCount: z.number().int().nonnegative(),
  connectedCount: z.number().int().nonnegative(),
})

/**
 * One entry per `broker` provider — which addon provides which broker
 * kind(s). The unified create picker reads this to know, for each
 * (addonId, kind) pair the operator can pick, where to route the
 * follow-up `getSettingsSchema` / `testSettings` / `add` calls (via the
 * `{ addonId }` selector). A provider only advertises a kind here when
 * it implements `getSettingsSchema` for that kind (so the picker never
 * offers a kind whose creation form can't be rendered).
 */
const BrokerProviderInfoSchema = z.object({
  /** Addon id of the `broker` provider this entry describes. */
  addonId: z.string(),
  /** Broker kinds this provider can create, with a display label. */
  kinds: z.array(
    z.object({
      kind: z.string(),
      label: z.string(),
      /**
       * Relative hub path to start an interactive account link (OAuth popup).
       * May include `{{brokerId}}`; admin-ui substitutes and appends `?popup=1`.
       */
      interactiveConnectPath: z.string().min(1).optional(),
      /** Relative hub path to disconnect the linked account (same popup pattern). */
      interactiveDisconnectPath: z.string().min(1).optional(),
      /**
       * The kind signs in through a server-held interactive session instead of
       * (or before) typed credentials. `basePath` is a hub-relative route set
       * served by the owning addon (`/addon/<id>/...`) speaking the sign-in
       * contract: `POST {basePath}/start` (body: the form's settings) answers
       * `{ sessionId, loginUrl }`; `GET {basePath}/status?sessionId=` answers
       * `{ phase: 'starting' | 'awaiting-login' | 'captured' | 'error' |
       * 'cancelled', loginUrl, error }`; `POST {basePath}/commit`
       * (`{ sessionId, name, brokerId? }`) stores the credentials on a new or
       * existing broker and answers `{ brokerId }`; `POST {basePath}/cancel`
       * (`{ sessionId }`) drops the session. The dialog that edits a broker
       * offers it as the default path; the fields the session fills are
       * marked `filledBySignIn` in the kind's settings schema.
       *
       * `methods` lists the ways the session can sign in, recommended first:
       * `'device-code'` adds `POST {basePath}/code/start` (body: the form's
       * settings) answering `{ sessionId, userCode, verificationUrl,
       * expiresAt }` — the operator types `userCode` at `verificationUrl` on
       * any device, and the same `status` / `commit` / `cancel` routes follow
       * (status then carries `method`, `userCode`, `verificationUrl`,
       * `expiresAt` and the phases `'awaiting-code'` / `'expired'`);
       * `'proxy'` is the `{basePath}/start` flow above. Absent means
       * `['proxy']`.
       */
      signIn: z
        .object({
          basePath: z.string().min(1),
          methods: z.array(z.enum(['device-code', 'proxy'])).optional(),
        })
        .optional(),
    }),
  ),
})

export type BrokerProviderInfo = z.infer<typeof BrokerProviderInfoSchema>

const ListInputSchema = z.object({
  /** Optional kind filter — `list({kind:'home-assistant'})` returns
   *  only HA brokers. Omit to list every broker. */
  kind: z.string().optional(),
})

const GetInputSchema = z.object({ id: z.string() })

const AddInputSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  /**
   * ADOPT an existing id instead of minting a new one.
   *
   * Written the day this cost an outage. A broker's id is not a detail: HA
   * devices carry it inside their `stableId` (`ha:ha_004:dev:…`), so a broker
   * lost from config and re-added as `ha_001` leaves every one of its devices
   * bound to a broker that no longer exists. Re-entering the password under the
   * ORIGINAL id turns a multi-step device migration back into re-entering a
   * password.
   *
   * A provider MUST refuse an id that is already in use — adopting a live
   * broker's id would silently take it over.
   */
  id: z.string().min(1).optional(),
  /** Kind-specific settings (e.g. MQTT `{url,username,password}` or HA
   *  `{baseUrl,accessToken}`). Validated by the kind-specific provider
   *  branch on receipt — invalid shape rejects the add. */
  settings: z.record(z.string(), z.unknown()),
})

const AddResultSchema = z.object({ id: z.string() })

const RemoveInputSchema = z.object({ id: z.string() })

const TestConnectionResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), latencyMs: z.number().nonnegative() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

const SettingsRecordSchema = z.record(z.string(), z.unknown())

const SettingsSchemaInputSchema = z.object({ kind: z.string() })
const TestSettingsInputSchema = z.object({
  kind: z.string(),
  settings: SettingsRecordSchema,
})
const TestSettingsResultSchema = z.discriminatedUnion('ok', [
  // `.strict()` on the success branch so a stray `error` field is rejected,
  // not silently stripped — a success result must never carry an error.
  z.object({ ok: z.literal(true), latencyMs: z.number().nonnegative().optional() }).strict(),
  z.object({ ok: z.literal(false), error: z.string() }),
])
// ConfigSchema is opaque at the cap boundary (rendered by FormBuilder).
const SettingsSchemaResultSchema = z.unknown().nullable()

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
    // ── Registry CRUD ────────────────────────────────────────────────
    list: method(ListInputSchema, z.array(BrokerInfoSchema)),
    get: method(GetInputSchema, BrokerInfoSchema.nullable()),
    /** Enumerate which addon provides which broker kind(s) for the
     *  unified create picker. The auto-mount fans this array across
     *  every registered `broker` provider (array-output method), so the
     *  picker sees every kind from every provider in one call. */
    listProviders: method(z.void(), z.array(BrokerProviderInfoSchema), { auth: 'admin' }),
    add: method(AddInputSchema, AddResultSchema, { kind: 'mutation', auth: 'admin' }),
    remove: method(RemoveInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),
    testConnection: method(GetInputSchema, TestConnectionResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Settings ─────────────────────────────────────────────────────
    /** Read the persisted settings record for a broker (kind-specific
     *  shape). Admin-only — settings may contain secrets. Returns `null`
     *  when the broker id is unknown to the provider (the collection
     *  fallback may route a foreign id to the first provider). */
    getSettings: method(GetInputSchema, SettingsRecordSchema.nullable(), { auth: 'admin' }),
    /** Overwrite the persisted settings record. The kind-specific
     *  provider validates the shape and applies the change (reconnects
     *  if credentials changed). */
    setSettings: method(z.object({ id: z.string(), settings: SettingsRecordSchema }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),

    // ── Connection-config (for consumers that open their own client) ─
    /** Returns the kind-specific connection config the consumer needs
     *  to open its own client (MQTT pattern: `{url, username, password,
     *  clientIdPrefix}`). HA providers MAY return the auth envelope
     *  but typical HA consumers use `publish` / `subscribe` instead.
     *  Returns `null` when the broker id is unknown to the provider. */
    getBrokerConfig: method(GetInputSchema, SettingsRecordSchema.nullable(), { auth: 'admin' }),

    // ── Per-kind creation schema + pre-creation test ─────────────────
    getSettingsSchema: method(SettingsSchemaInputSchema, SettingsSchemaResultSchema, {
      auth: 'admin',
    }),
    testSettings: method(TestSettingsInputSchema, TestSettingsResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),

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
  BrokerInfoSchema,
  BrokerProviderInfoSchema,
  RegistryStatusSchema as BrokerRegistryStatusSchema,
  TestConnectionResultSchema as BrokerTestConnectionResultSchema,
  PublishInputSchema as BrokerPublishInputSchema,
  SubscribeInputSchema as BrokerSubscribeInputSchema,
  SubscribeResultSchema as BrokerSubscribeResultSchema,
  UnsubscribeInputSchema as BrokerUnsubscribeInputSchema,
  GetStateInputSchema as BrokerGetStateInputSchema,
  AddInputSchema as BrokerAddInputSchema,
  SettingsSchemaInputSchema as BrokerSettingsSchemaInputSchema,
  TestSettingsInputSchema as BrokerTestSettingsInputSchema,
  TestSettingsResultSchema as BrokerTestSettingsResultSchema,
}
