/**
 * MQTT Broker addon — broker REGISTRY (not a pub/sub proxy).
 *
 * Maintains a list of MQTT broker entries (external + optionally an
 * embedded `aedes`-backed broker) and exposes connection details via
 * the `mqtt-broker` cap. Consumer addons (e.g. `addon-export-ha-mqtt`)
 * fetch the details with `getBrokerConfig({id})` and spin up their
 * OWN `mqtt.js` client — the addon does NOT relay messages.
 *
 * What's polished in this revision:
 *   - #164 — `BrokerProbeCache` runs a 30s background probe loop; the
 *     `listBrokers` response now reflects real connect/auth/TLS status.
 *   - #165 — Embedded broker supports per-client credentials + topic
 *     ACL via `aedes.authenticate` + `authorizePublish` /
 *     `authorizeSubscribe`. Credential changes hot-reload without
 *     dropping all clients — only users whose hashes changed get
 *     disconnected.
 *   - Passwords (external entries, onboard entries, the embedded shared
 *     password) are `type: 'password'` fields: the keychain holds them
 *     (D787) and `this.config` carries the resolved value. The addon's own
 *     `enc:v1` codec is retired — a leftover `enc:v1:` value is reported,
 *     never decrypted (see `retired-ciphertext.ts`).
 *
 * Configuration surface:
 *   The addon has NO standalone admin page. All configuration — external
 *   broker entries, the embedded `aedes` broker, embedded credentials,
 *   and the topic ACL — is exposed through the standard
 *   `globalSettingsSchema()` and rendered automatically inside the
 *   Integrations → Brokers tab's docked Settings panel, like every other
 *   integration-type addon.
 *
 * Lifecycle:
 *   - External broker entries are persisted in `this.activeExternalBrokers`.
 *   - The embedded broker is persisted as flat `embedded*` config keys
 *     (`embeddedEnabled`, `embeddedPort`, …) so the standard settings
 *     form can drive it; {@link MqttBrokerAddon.deriveEmbeddedEntry}
 *     reassembles them into an `EmbeddedBrokerEntry`.
 *   - On boot we start the embedded broker when `embeddedEnabled`.
 *   - `addBroker` / `removeBroker` / `startEmbeddedBroker` /
 *     `stopEmbeddedBroker` mutate the config and the runtime state.
 *   - `testConnection` does a one-shot `mqtt.connect` race against a 3s
 *     timeout AND refreshes the probe cache for the broker.
 */
import {
  BaseAddon,
  brokerCapability,
  EventCategory,
  type IBrokerProvider,
  type IMqttBrokerProvider,
  type MqttBrokerInfo,
  type MqttBrokerLiveStatus,
  mqttBrokerCapability,
  type ProviderRegistration,
  type UnifiedBrokerInfo,
} from '@camstack/types'

type BrokerStatus = MqttBrokerLiveStatus

import { randomUUID } from 'node:crypto'
import { createServer, type Server as NetServer } from 'node:net'
import type {
  Client as AedesClient,
  PublishPacket as AedesPublishPacket,
  Subscription as AedesSubscription,
} from 'aedes'
// `aedes` exports a class as its default. Persistence + queue defaults
// are in-memory, which is what we want.
import Aedes from 'aedes'
import * as bcrypt from 'bcryptjs'
import mqtt from 'mqtt'

import { BrokerProbeCache } from './broker-probe-cache.js'
import {
  buildOnboardEntry,
  diffOnboardRuntimes,
  isOnboardRequested,
  type OnboardDescriptor,
  onboardToEmbeddedEntry,
  readOnboardPort,
} from './onboard-helpers.js'
import {
  LegacyCiphertextError,
  type LegacyKey,
  loadLegacyKey,
  resolveStoredPassword,
  retiredCiphertextPaths,
} from './retired-ciphertext.js'
import { mqttBrokersEntryKind } from './broker-record-kinds.js'
import { mqttAclEntryKind, mqttClientEntryKind } from './mqtt-entry-record-kinds.js'
import { MqttBrokerStore } from './mqtt-broker-store.js'
import type { MqttExternalBrokerEntry } from './mqtt-external-broker-entry.js'
import {
  MqttAclStore,
  MqttClientStore,
  type EmbeddedAclEntry,
  type EmbeddedClientEntry,
} from './mqtt-entry-store.js'

type ExternalBrokerEntry = MqttExternalBrokerEntry
type AedesInstance = InstanceType<typeof Aedes>

/** bcrypt cost factor — exported for tests. */
export const MQTT_EMBEDDED_BCRYPT_ROUNDS = 10
const PROBE_INTERVAL_MS = 30_000
const DEFAULT_EMBEDDED_PORT = 1883

/**
 * Per-kind broker creation form for kind='mqtt', rendered by the unified
 * Broker manager / create picker (via `broker.getSettingsSchema`). PURE
 * DATA — emits the flat `{ url, username, password, clientIdPrefix }`
 * shape `broker.add`'s `settings` payload consumes. Mirrors the external
 * broker fields `addBroker` accepts.
 */
const mqttBrokerSettingsSchema = {
  sections: [
    {
      id: 'mqtt-broker-connection',
      title: 'MQTT connection',
      titleKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.title',
      columns: 1,
      fields: [
        {
          type: 'boolean',
          key: 'onboard',
          label: 'Run an onboard broker',
          labelKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.onboard.label',
          description:
            'Spin up a CamStack-hosted aedes broker on this hub instead of connecting to an external one. Each onboard broker gets its own dedicated server + port.',
          descriptionKey:
            'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.onboard.description',
          default: false,
        },
        {
          type: 'number',
          key: 'port',
          label: 'Port',
          labelKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.port.label',
          placeholder: '(auto)',
          description: 'TCP port for the onboard broker. Leave blank to auto-allocate a free port.',
          descriptionKey:
            'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.port.description',
          showWhen: { field: 'onboard', equals: true },
        },
        {
          type: 'boolean',
          key: 'allowAnonymous',
          label: 'Allow anonymous',
          labelKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.allowAnonymous.label',
          description: 'Permit clients to connect without a username/password.',
          descriptionKey:
            'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.allowAnonymous.description',
          default: false,
          showWhen: { field: 'onboard', equals: true },
        },
        {
          type: 'text',
          key: 'url',
          label: 'Broker URL',
          labelKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.url.label',
          placeholder: 'mqtt://localhost:1883',
          showWhen: { field: 'onboard', equals: false },
        },
        {
          type: 'text',
          key: 'username',
          label: 'Username',
          labelKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.username.label',
          placeholder: '(optional)',
        },
        {
          type: 'password',
          key: 'password',
          label: 'Password',
          labelKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.password.label',
          showToggle: true,
        },
        {
          type: 'text',
          key: 'clientIdPrefix',
          label: 'Client ID prefix',
          labelKey: 'mqtt-broker:mqttBrokerSettings.s_mqtt-broker-connection.clientIdPrefix.label',
          placeholder: '(optional)',
          showWhen: { field: 'onboard', equals: false },
        },
      ],
    },
  ],
} as const

/**
 * Internal, fully-resolved embedded-broker descriptor. NOT persisted
 * directly — {@link MqttBrokerAddon.deriveEmbeddedEntry} reassembles it
 * from the flat `embedded*` config keys so the standard settings form
 * can drive each property as an individual field.
 */
interface EmbeddedBrokerEntry {
  readonly id: string
  readonly name: string
  readonly port: number
  readonly allowAnonymous: boolean
  /** Legacy shared credentials — used as a single-user fallback when the new credential list is empty. */
  readonly username?: string
  /** Legacy shared credentials — the resolved keychain value. */
  readonly password?: string
}

/**
 * Persisted addon config.
 *
 * The embedded broker is stored as FLAT keys (`embedded*`) rather than a
 * nested object so every property maps to a single field in
 * `globalSettingsSchema()` — the standard settings form saves flat
 * config keys, mirroring `addon-export-ha-mqtt`.
 */
interface MqttBrokerConfig {
  readonly brokers: readonly ExternalBrokerEntry[]
  /** Whether the embedded `aedes` broker should be running. */
  readonly embeddedEnabled: boolean
  /** Stable id for the embedded broker entry — generated lazily. */
  readonly embeddedId: string
  /** TCP port the embedded broker listens on. */
  readonly embeddedPort: number
  /** Allow anonymous connect (no username/password). */
  readonly embeddedAllowAnonymous: boolean
  /** Legacy shared username — fallback when `embeddedClients` is empty. */
  readonly embeddedUsername: string
  /** Legacy shared password — stored in the keychain. */
  readonly embeddedPassword: string
  readonly embeddedClients: readonly EmbeddedClientEntry[]
  readonly embeddedAcl: readonly EmbeddedAclEntry[]
}

const DEFAULT_CONFIG: MqttBrokerConfig = {
  brokers: [],
  embeddedEnabled: false,
  embeddedId: '',
  embeddedPort: DEFAULT_EMBEDDED_PORT,
  embeddedAllowAnonymous: false,
  embeddedUsername: '',
  embeddedPassword: '',
  embeddedClients: [],
  embeddedAcl: [],
}

interface EmbeddedRuntime {
  readonly entry: EmbeddedBrokerEntry
  readonly aedes: AedesInstance
  readonly server: NetServer
  /**
   * Snapshot of the credential hashes that were live when the broker was
   * spawned. Used by {@link reconcileEmbeddedClients} to detect
   * password changes vs username additions/removals.
   */
  credentialsSnapshot: ReadonlyMap<string, string>
}

/** The section that edits `config.brokers`, the same store the broker cap lists. */
const EXTERNAL_BROKERS_SECTION_ID = 'mqtt-broker-external'

export class MqttBrokerAddon extends BaseAddon<MqttBrokerConfig> {
  private embeddedRuntime: EmbeddedRuntime | null = null
  /** Per-entry onboard `aedes` runtimes, keyed by `ExternalBrokerEntry.id`. */
  private onboardRuntimes = new Map<string, EmbeddedRuntime>()
  private probeCache: BrokerProbeCache | null = null
  private brokerStore: MqttBrokerStore | null = null
  private clientStore: MqttClientStore | null = null
  private aclStore: MqttAclStore | null = null
  /** External broker rows (records when B2 is live, else settings mirror). */
  private activeExternalBrokers: readonly ExternalBrokerEntry[] = []
  private activeEmbeddedClients: readonly EmbeddedClientEntry[] = []
  private activeEmbeddedAcl: readonly EmbeddedAclEntry[] = []

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  private async loadPersistedExternalBrokers(): Promise<readonly ExternalBrokerEntry[]> {
    const store = this.brokerStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.brokers
  }

  private async persistExternalBrokers(entries: readonly ExternalBrokerEntry[]): Promise<void> {
    this.activeExternalBrokers = [...entries]
    const store = this.brokerStore
    if (store !== null) {
      await store.replaceAll(entries)
      return
    }
    await this.updateGlobalSettings({ brokers: entries })
  }

  private async loadEmbeddedClients(): Promise<readonly EmbeddedClientEntry[]> {
    const store = this.clientStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.embeddedClients
  }

  private async loadEmbeddedAcl(): Promise<readonly EmbeddedAclEntry[]> {
    const store = this.aclStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.embeddedAcl
  }

  private async syncEmbeddedEntriesFromConfig(): Promise<void> {
    const clients = [...this.config.embeddedClients]
    const acl = [...this.config.embeddedAcl]
    this.activeEmbeddedClients = clients
    this.activeEmbeddedAcl = acl
    const clientStore = this.clientStore
    const aclStore = this.aclStore
    if (clientStore !== null) await clientStore.replaceAll(clients)
    if (aclStore !== null) await aclStore.replaceAll(acl)
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    this.reportRetiredCiphertext()

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('mqtt-broker: ctx.records is required (hub-only addon)')
    }
    await records.declare({
      brokers: mqttBrokersEntryKind,
      'mqtt-client': mqttClientEntryKind,
      'mqtt-acl-rule': mqttAclEntryKind,
    })
    this.brokerStore = MqttBrokerStore.of(records)
    this.clientStore = MqttClientStore.of(records)
    this.aclStore = MqttAclStore.of(records)
    this.activeExternalBrokers = await this.loadPersistedExternalBrokers()
    if ((await this.brokerStore.listResolved()).length === 0 && this.config.brokers.length > 0) {
      await this.brokerStore.replaceAll(this.config.brokers)
      this.activeExternalBrokers = await this.loadPersistedExternalBrokers()
    }
    this.activeEmbeddedClients = await this.loadEmbeddedClients()
    this.activeEmbeddedAcl = await this.loadEmbeddedAcl()
    if (
      (await this.clientStore.listResolved()).length === 0 &&
      this.config.embeddedClients.length > 0
    ) {
      await this.clientStore.replaceAll(this.config.embeddedClients)
      this.activeEmbeddedClients = await this.loadEmbeddedClients()
    }
    if ((await this.aclStore.listResolved()).length === 0 && this.config.embeddedAcl.length > 0) {
      await this.aclStore.replaceAll(this.config.embeddedAcl)
      this.activeEmbeddedAcl = await this.loadEmbeddedAcl()
    }

    // Probe loop.
    this.probeCache = new BrokerProbeCache({
      intervalMs: PROBE_INTERVAL_MS,
      onError: (id, err) => {
        this.ctx.logger.debug('mqtt broker probe failed', {
          meta: { id, error: errMsg(err) },
        })
      },
    })
    this.probeCache.setBrokersSource(() => this.collectExternalProbeInputs())
    this.probeCache.start()

    // Restart persisted embedded broker, if enabled.
    const persistedEmbedded = this.deriveEmbeddedEntry()
    if (persistedEmbedded) {
      try {
        await this.spawnEmbedded(persistedEmbedded)
        this.ctx.logger.info('embedded mqtt broker restarted', {
          meta: { port: persistedEmbedded.port },
          tags: { topic: 'mqtt-broker', phase: 'embedded-restarted' },
        })
      } catch (err) {
        this.ctx.logger.warn('embedded mqtt broker failed to restart', {
          meta: { error: errMsg(err) },
          tags: { topic: 'mqtt-broker', phase: 'embedded-restart-failed' },
        })
      }
    }

    // Start every persisted onboard broker.
    await this.reconcileOnboardRuntimes()

    this.ctx.addDisposer(async () => {
      await this.probeCache?.stop()
      await this.shutdownEmbedded().catch(() => undefined)
      await this.shutdownAllOnboard()
    })

    const provider: IMqttBrokerProvider = {
      listBrokers: async () => this.listBrokers(),
      getBrokerConfig: async ({ id }) => this.getBrokerConfig(id),
      addBroker: async (input) => this.addBroker(input),
      removeBroker: async ({ id }) => this.removeBroker(id),
      testConnection: async ({ id }) => this.testConnection(id),
      startEmbeddedBroker: async (input) => this.startEmbeddedBroker(input),
      stopEmbeddedBroker: async ({ id }) => this.stopEmbeddedBroker(id),
      getStatus: async () => ({
        brokerCount: this.activeExternalBrokers.length + (this.config.embeddedEnabled ? 1 : 0),
        embeddedRunning: this.embeddedRuntime !== null,
      }),
    }

    // Unified `broker` cap provider (kind='mqtt'). Sits ALONGSIDE
    // the legacy `mqtt-broker` cap during the migration window. The
    // long-term path is to deprecate the legacy cap once every
    // consumer has migrated to the unified surface.
    const unifiedProvider = this.buildUnifiedBrokerProvider()

    return [
      { capability: mqttBrokerCapability, provider },
      { capability: brokerCapability, provider: unifiedProvider },
    ]
  }

  // ── Unified `broker` cap (kind='mqtt') ────────────────────────────────

  private buildUnifiedBrokerProvider(): IBrokerProvider {
    const KIND = 'mqtt'
    // The owning addon id — stamped onto every BrokerInfo so the admin
    // UI threads it back as the `{ addonId }` system-collection selector,
    // routing id-keyed calls to THIS provider instead of defaulting to
    // the first-registered broker provider.
    const ownerAddonId = this.ctx.id
    const adapt = (info: MqttBrokerInfo): UnifiedBrokerInfo => ({
      id: info.id,
      addonId: ownerAddonId,
      name: info.name,
      kind: KIND,
      status: mapMqttStatus(info.status),
      info: {
        ...(info.latencyMs !== null ? { latencyMs: info.latencyMs } : {}),
        ...(info.kind === 'embedded'
          ? { embedded: true, connectedClients: info.connectedClients ?? 0 }
          : {}),
      },
      lastCheckedAt: info.lastCheckedAt ?? null,
      error: info.error ?? null,
    })
    // True when this provider owns the given broker id (external or the
    // embedded broker). Id-keyed methods return null / no-op for foreign
    // ids (NOT throw) so the no-addonId collection fallback degrades
    // gracefully when it routes a foreign id to the first provider.
    const owns = (id: string): boolean => {
      if (this.activeExternalBrokers.some((b) => b.id === id)) return true
      const embedded = this.deriveEmbeddedEntry()
      return embedded !== null && embedded.id === id
    }

    return {
      list: async ({ kind }) => {
        if (kind && kind !== KIND) return []
        const all = await this.listBrokers()
        return all.map(adapt)
      },
      get: async ({ id }) => {
        const all = await this.listBrokers()
        const match = all.find((b) => b.id === id)
        return match ? adapt(match) : null
      },
      listProviders: async () => [
        { addonId: ownerAddonId, kinds: [{ kind: KIND, label: 'MQTT' }] },
      ],
      add: async ({ kind, name, settings, id }) => {
        if (kind !== KIND) {
          throw new Error(`mqtt-broker: only kind '${KIND}' is handled here (got '${kind}')`)
        }
        // REFUSED, not ignored. `id` exists so a broker lost from config can be
        // restored under its original id; this provider does not implement that
        // yet, and silently minting a different id would leave the operator
        // believing they had recovered the old one.
        if (id !== undefined) {
          throw new Error(
            'mqtt-broker: adopting an existing broker id is not supported by this provider',
          )
        }
        if (isOnboardRequested(settings)) {
          return this.addOnboardBroker(name, settings)
        }
        const url = typeof settings['url'] === 'string' ? settings['url'] : ''
        if (!url) throw new Error('mqtt-broker.add: settings.url is required')
        const input = {
          name,
          url,
          ...(typeof settings['username'] === 'string'
            ? { username: settings['username'] as string }
            : {}),
          ...(typeof settings['password'] === 'string'
            ? { password: settings['password'] as string }
            : {}),
          ...(typeof settings['clientIdPrefix'] === 'string'
            ? { clientIdPrefix: settings['clientIdPrefix'] as string }
            : {}),
        }
        return this.addBroker(input)
      },
      remove: async ({ id }) => {
        // `removeBroker` is already idempotent (no-op on unknown id), so
        // a foreign id routed here via the collection fallback is safe.
        if (!owns(id)) return
        await this.removeBroker(id)
      },
      testConnection: async ({ id }) => {
        if (!owns(id)) return { ok: false, error: 'unknown broker' }
        return this.testConnection(id)
      },
      getSettings: async ({ id }) => {
        if (!owns(id)) return null
        const cfg = this.getBrokerConfig(id)
        return cfg
      },
      setSettings: async () => {
        // Legacy mqtt-broker cap has no per-broker settings mutation —
        // brokers are immutable post-add (use remove + add to replace).
        throw new Error(
          'mqtt-broker.setSettings: not supported — use remove + add to replace a broker',
        )
      },
      getBrokerConfig: async ({ id }) => {
        if (!owns(id)) return null
        const cfg = this.getBrokerConfig(id)
        return cfg
      },
      getSettingsSchema: async ({ kind }) => {
        if (kind !== KIND) return null
        return mqttBrokerSettingsSchema
      },
      testSettings: async ({ kind, settings }) => {
        if (kind !== KIND) return { ok: false, error: `unsupported kind: ${kind}` }
        if (isOnboardRequested(settings)) {
          // An onboard broker is created+listened locally on add — there's
          // nothing to probe pre-creation, so report ok.
          return { ok: true, latencyMs: 0 }
        }
        const url = typeof settings['url'] === 'string' ? settings['url'] : ''
        if (!url) return { ok: false, error: 'settings.url is required' }
        return this.probeMqtt({
          url,
          ...(typeof settings['username'] === 'string' ? { username: settings['username'] } : {}),
          ...(typeof settings['password'] === 'string' ? { password: settings['password'] } : {}),
        })
      },
      // Pub/sub primitives — MQTT broker is a CONFIG REGISTRY, not a
      // pub/sub proxy. Consumers fetch `getBrokerConfig` and open
      // their own mqtt.js client. We surface these methods on the
      // unified cap so the contract is uniform, but reject calls with
      // a clear redirect.
      publish: async () => {
        throw new Error(
          'mqtt-broker.publish: not supported — fetch getBrokerConfig + open your own mqtt.js client (see "NOT a pub/sub proxy" in mqtt-broker.cap.ts)',
        )
      },
      subscribe: async () => {
        throw new Error('mqtt-broker.subscribe: not supported — open your own mqtt.js client')
      },
      unsubscribe: async () => {
        throw new Error('mqtt-broker.unsubscribe: not supported')
      },
      getState: async () => null,
      getStatus: async () => {
        const all = await this.listBrokers()
        return {
          brokerCount: this.activeExternalBrokers.length + (this.config.embeddedEnabled ? 1 : 0),
          connectedCount: all.filter((b) => b.status === 'connected').length,
        }
      },
    }
  }

  protected async onShutdown(): Promise<void> {
    await this.probeCache?.stop()
    await this.shutdownEmbedded().catch(() => undefined)
    await this.shutdownAllOnboard()
  }

  protected async onConfigChanged(): Promise<void> {
    this.activeExternalBrokers = await this.loadPersistedExternalBrokers()
    await this.syncEmbeddedEntriesFromConfig()

    // Reconcile per-entry onboard brokers first (independent of the legacy
    // single embedded broker below).
    await this.reconcileOnboardRuntimes()

    // Reconcile the legacy single embedded broker against the new config.
    const desired = this.deriveEmbeddedEntry()
    const running = this.embeddedRuntime?.entry ?? null

    if (!desired && running) {
      await this.shutdownEmbedded()
      return
    }
    if (desired && !running) {
      await this.spawnEmbedded(desired).catch((err) => {
        this.ctx.logger.warn('embedded mqtt broker spawn (on config change) failed', {
          meta: { error: errMsg(err) },
        })
      })
      return
    }
    if (desired && running) {
      if (requiresEmbeddedRespawn(desired, running)) {
        await this.shutdownEmbedded()
        await this.spawnEmbedded(desired).catch((err) => {
          this.ctx.logger.warn('embedded mqtt broker respawn failed', {
            meta: { error: errMsg(err) },
          })
        })
        return
      }
      // Soft reconcile — hot-reload ACL + per-client credentials without
      // dropping every connected session.
      this.reconcileEmbeddedClients()
    }
  }

  // ── Registry mutations ──────────────────────────────────────────

  private async listBrokers(): Promise<MqttBrokerInfo[]> {
    const out: MqttBrokerInfo[] = []
    for (const entry of this.activeExternalBrokers) {
      if (entry.onboard) {
        // Onboard entry — backed by a dedicated aedes server we own.
        // Report it as an embedded broker (the BrokerInfo `kind` union has
        // no 'onboard' member), with live status from the runtime map.
        const running = this.onboardRuntimes.get(entry.id) ?? null
        const status: BrokerStatus = running !== null ? 'connected' : 'disconnected'
        const info: MqttBrokerInfo = {
          id: entry.id,
          name: entry.name,
          url: `mqtt://127.0.0.1:${entry.onboard.port}`,
          kind: 'embedded',
          status,
          latencyMs: null,
          ...(running ? { connectedClients: running.aedes.connectedClients } : {}),
          lastCheckedAt: Date.now(),
        }
        out.push(info)
        continue
      }
      const probe = this.probeCache?.get(entry.id)
      const info: MqttBrokerInfo = {
        id: entry.id,
        name: entry.name,
        url: entry.url,
        kind: 'external',
        status: probe?.status ?? 'disconnected',
        latencyMs: probe?.latencyMs ?? null,
        ...(probe?.error ? { error: probe.error } : {}),
        ...(probe?.lastCheckedAt ? { lastCheckedAt: probe.lastCheckedAt } : {}),
      }
      out.push(info)
    }
    const embedded = this.deriveEmbeddedEntry()
    if (embedded) {
      const running = this.embeddedRuntime
      const status: BrokerStatus = running !== null ? 'connected' : 'disconnected'
      const info: MqttBrokerInfo = {
        id: embedded.id,
        name: embedded.name,
        url: `mqtt://127.0.0.1:${embedded.port}`,
        kind: 'embedded',
        status,
        latencyMs: null,
        ...(running ? { connectedClients: running.aedes.connectedClients } : {}),
        lastCheckedAt: Date.now(),
      }
      out.push(info)
    }
    return out
  }

  private getBrokerConfig(id: string): {
    url: string
    username?: string
    password?: string
    clientIdPrefix?: string
  } {
    const external = this.activeExternalBrokers.find((b) => b.id === id)
    if (external) {
      // Throws for an enc:v1 leftover that cannot be decrypted — never
      // connects without the password it stands for.
      const password = this.storedPassword(external.password)
      return {
        url: external.url,
        ...(external.username !== undefined ? { username: external.username } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(external.clientIdPrefix !== undefined
          ? { clientIdPrefix: external.clientIdPrefix }
          : {}),
      }
    }
    const embedded = this.deriveEmbeddedEntry()
    if (embedded && embedded.id === id) {
      const password = this.storedPassword(embedded.password)
      return {
        url: `mqtt://127.0.0.1:${embedded.port}`,
        ...(embedded.username !== undefined ? { username: embedded.username } : {}),
        ...(password !== undefined ? { password } : {}),
      }
    }
    throw new Error(`mqtt-broker: broker '${id}' not found`)
  }

  private async addBroker(input: {
    name: string
    url: string
    username?: string
    password?: string
    clientIdPrefix?: string
  }): Promise<{ id: string }> {
    const id = randomUUID()
    const entry: ExternalBrokerEntry = {
      id,
      name: input.name,
      url: input.url,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(input.clientIdPrefix !== undefined ? { clientIdPrefix: input.clientIdPrefix } : {}),
    }
    const next = [...this.activeExternalBrokers, entry]
    await this.persistExternalBrokers(next)
    this.ctx.logger.info('mqtt broker added', { meta: { id, url: entry.url } })
    return { id }
  }

  /**
   * Create a per-entry ONBOARD broker from `broker.add` settings: allocate
   * (or honour) a port, persist an `ExternalBrokerEntry` carrying an
   * `onboard` descriptor, then spawn its dedicated `aedes` server.
   */
  private async addOnboardBroker(
    name: string,
    settings: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const id = randomUUID()
    const port = readOnboardPort(settings) ?? (await findFreePort())
    const built = buildOnboardEntry({
      id,
      name,
      port,
      settings,
    })
    const entry: ExternalBrokerEntry = {
      id: built.id,
      name: built.name,
      url: built.url,
      ...(built.username !== undefined ? { username: built.username } : {}),
      ...(built.password !== undefined ? { password: built.password } : {}),
      onboard: built.onboard,
    }
    const next = [...this.activeExternalBrokers, entry]
    await this.persistExternalBrokers(next)

    const spawn = this.onboardSpawnEntry(entry)
    if (spawn) {
      await this.spawnOnboard(spawn)
    }
    this.ctx.logger.info('onboard mqtt broker added', {
      meta: { id, port },
      tags: { topic: 'mqtt-broker', phase: 'onboard-started' },
    })
    return { id }
  }

  private async removeBroker(id: string): Promise<void> {
    // External entry (includes onboard entries)
    const removed = this.activeExternalBrokers.find((b) => b.id === id)
    if (removed) {
      const next = this.activeExternalBrokers.filter((b) => b.id !== id)
      await this.persistExternalBrokers(next)
      this.probeCache?.evict(id)
      if (removed.onboard) {
        await this.shutdownOnboard(id)
      }
      this.ctx.logger.info('mqtt broker removed', { meta: { id } })
      return
    }
    // Embedded entry — also requires shutdown
    const embedded = this.deriveEmbeddedEntry()
    if (embedded && embedded.id === id) {
      await this.shutdownEmbedded()
      await this.updateGlobalSettings({ embeddedEnabled: false })
      this.ctx.logger.info('embedded mqtt broker removed', { meta: { id } })
      return
    }
    // Idempotent — `removeBroker` on a missing id is a no-op
  }

  private async testConnection(
    id: string,
  ): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    let cfg: { url: string; username?: string; password?: string }
    try {
      cfg = this.getBrokerConfig(id)
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }

    // Refresh the live probe cache as a side effect so the page table
    // reflects the latest result immediately after the operator clicks
    // "Test connection".
    void this.probeCache?.probeNow(id).catch(() => undefined)

    return this.probeMqtt(cfg)
  }

  /**
   * One-shot connectivity probe against an MQTT endpoint built from a
   * flat config (`{url, username?, password?}`). Shared by the
   * id-keyed `testConnection` (existing broker) and the pre-creation
   * `testSettings` (throwaway settings the operator hasn't saved yet).
   * Never throws — every failure resolves to `{ ok: false, error }`.
   */
  private async probeMqtt(cfg: {
    url: string
    username?: string
    password?: string
  }): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    const startedAt = Date.now()
    return await new Promise((resolve) => {
      const opts: mqtt.IClientOptions = {
        reconnectPeriod: 0,
        connectTimeout: 3_000,
      }
      if (cfg.username) opts.username = cfg.username
      if (cfg.password) opts.password = cfg.password

      const client = mqtt.connect(cfg.url, opts)
      const timer = setTimeout(() => {
        try {
          client.end(true)
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: 'timeout (3s)' })
      }, 3_000)

      client.once('connect', () => {
        clearTimeout(timer)
        const latencyMs = Date.now() - startedAt
        try {
          client.end(true)
        } catch {
          /* ignore */
        }
        resolve({ ok: true, latencyMs })
      })
      client.once('error', (err) => {
        clearTimeout(timer)
        try {
          client.end(true)
        } catch {
          /* ignore */
        }
        resolve({ ok: false, error: errMsg(err) })
      })
    })
  }

  // ── Embedded broker lifecycle ───────────────────────────────────

  private async startEmbeddedBroker(input: {
    port: number
    allowAnonymous: boolean
    username?: string
    password?: string
  }): Promise<{ id: string; url: string }> {
    if (this.embeddedRuntime) {
      throw new Error('embedded broker already running — call stopEmbeddedBroker first')
    }
    const id = this.config.embeddedId || randomUUID()
    const entry: EmbeddedBrokerEntry = {
      id,
      name: 'Embedded broker',
      port: input.port,
      allowAnonymous: input.allowAnonymous,
      ...(input.username !== undefined ? { username: input.username } : {}),
      ...(input.password !== undefined ? { password: input.password } : {}),
    }
    await this.spawnEmbedded(entry)
    await this.updateGlobalSettings({
      embeddedEnabled: true,
      embeddedId: id,
      embeddedPort: input.port,
      embeddedAllowAnonymous: input.allowAnonymous,
      embeddedUsername: input.username ?? '',
      embeddedPassword: input.password ?? '',
    })
    this.ctx.logger.info('embedded mqtt broker started', {
      meta: { id, port: entry.port },
      tags: { topic: 'mqtt-broker', phase: 'embedded-started' },
    })
    this.ctx.eventBus?.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'addon', id: this.ctx.id },
      category: EventCategory.AddonUpdated,
      data: { addonId: this.ctx.id, action: 'embedded-broker-started' },
    })
    return { id, url: `mqtt://127.0.0.1:${entry.port}` }
  }

  private async stopEmbeddedBroker(id: string): Promise<void> {
    if (!this.embeddedRuntime || this.embeddedRuntime.entry.id !== id) {
      return // idempotent
    }
    await this.shutdownEmbedded()
    // Persist the disabled state so a later `onConfigChanged` reconcile
    // (or a hub restart) doesn't immediately respawn the broker.
    await this.updateGlobalSettings({ embeddedEnabled: false })
    this.ctx.logger.info('embedded mqtt broker stopped', { meta: { id } })
  }

  /**
   * Build + listen an `aedes` server for `entry` and RETURN the runtime
   * without assigning it to any field. Shared by the legacy single
   * embedded broker ({@link spawnEmbedded}) and the per-entry onboard
   * brokers ({@link spawnOnboard}).
   */
  private async spawnAedes(entry: EmbeddedBrokerEntry): Promise<EmbeddedRuntime> {
    const aedes: AedesInstance = new Aedes()
    const credentialsSnapshot = this.buildCredentialsSnapshot()

    aedes.authenticate = this.makeAuthenticateHandler(entry)
    aedes.authorizePublish = this.makePublishAuthorizer()
    aedes.authorizeSubscribe = this.makeSubscribeAuthorizer()

    const server = createServer((socket) => aedes.handle(socket))

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(entry.port)
    })

    return { entry, aedes, server, credentialsSnapshot }
  }

  /** Close an `aedes` runtime's server + broker. */
  private async closeRuntime(runtime: EmbeddedRuntime): Promise<void> {
    const { server, aedes } = runtime
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    await new Promise<void>((resolve) => {
      aedes.close(() => resolve())
    })
  }

  private async spawnEmbedded(entry: EmbeddedBrokerEntry): Promise<void> {
    this.embeddedRuntime = await this.spawnAedes(entry)
  }

  private async shutdownEmbedded(): Promise<void> {
    if (!this.embeddedRuntime) return
    const runtime = this.embeddedRuntime
    this.embeddedRuntime = null
    await this.closeRuntime(runtime)
  }

  /** Spawn a dedicated onboard `aedes` server for an onboard entry. */
  private async spawnOnboard(entry: EmbeddedBrokerEntry): Promise<void> {
    const runtime = await this.spawnAedes(entry)
    this.onboardRuntimes.set(entry.id, runtime)
  }

  /** Close + remove a single onboard runtime. Idempotent. */
  private async shutdownOnboard(id: string): Promise<void> {
    const runtime = this.onboardRuntimes.get(id)
    if (!runtime) return
    this.onboardRuntimes.delete(id)
    await this.closeRuntime(runtime)
  }

  /** Close + clear every onboard runtime. */
  private async shutdownAllOnboard(): Promise<void> {
    const runtimes = [...this.onboardRuntimes.values()]
    this.onboardRuntimes.clear()
    for (const runtime of runtimes) {
      await this.closeRuntime(runtime).catch(() => undefined)
    }
  }

  /**
   * Resolve the {@link EmbeddedBrokerEntry} used to spawn an onboard
   * entry's `aedes` server. Returns null when the entry carries no
   * `onboard` descriptor.
   */
  private onboardSpawnEntry(entry: ExternalBrokerEntry): EmbeddedBrokerEntry | null {
    if (!entry.onboard) return null
    return onboardToEmbeddedEntry({
      id: entry.id,
      name: entry.name,
      ...(entry.username !== undefined ? { username: entry.username } : {}),
      ...(entry.password !== undefined ? { password: entry.password } : {}),
      onboard: entry.onboard,
    })
  }

  /**
   * Reconcile onboard `aedes` runtimes against the persisted config:
   * start any onboard entry without a running runtime, stop runtimes whose
   * entry disappeared, and respawn runtimes whose port changed.
   */
  private async reconcileOnboardRuntimes(): Promise<void> {
    const desiredEntries = this.activeExternalBrokers.filter(hasOnboard)
    const desired = desiredEntries.map((b) => ({ id: b.id, port: b.onboard.port }))
    const runningIds = [...this.onboardRuntimes.keys()]
    const portById = new Map<string, number>()
    for (const [id, runtime] of this.onboardRuntimes) {
      portById.set(id, runtime.entry.port)
    }

    const plan = diffOnboardRuntimes(desired, runningIds, portById)
    const byId = new Map(desiredEntries.map((b) => [b.id, b]))

    for (const id of plan.toStop) {
      await this.shutdownOnboard(id)
    }
    for (const id of plan.toRespawn) {
      await this.shutdownOnboard(id)
      const entry = byId.get(id)
      const spawn = entry ? this.onboardSpawnEntry(entry) : null
      if (spawn) {
        await this.spawnOnboard(spawn).catch((err) => {
          this.ctx.logger.warn('onboard mqtt broker respawn failed', {
            meta: { id, error: errMsg(err) },
          })
        })
      }
    }
    for (const id of plan.toStart) {
      const entry = byId.get(id)
      const spawn = entry ? this.onboardSpawnEntry(entry) : null
      if (spawn) {
        await this.spawnOnboard(spawn).catch((err) => {
          this.ctx.logger.warn('onboard mqtt broker spawn failed', {
            meta: { id, error: errMsg(err) },
          })
        })
      }
    }
  }

  // ── Aedes auth + ACL (#165) ─────────────────────────────────────

  private makeAuthenticateHandler(entry: EmbeddedBrokerEntry) {
    return (
      _client: AedesClient,
      username: string | undefined,
      password: Buffer | undefined,
      done: (err: (Error & { returnCode: number }) | null, success: boolean | null) => void,
    ): void => {
      const allowAnonymous = entry.allowAnonymous
      const passwordStr = password?.toString('utf-8') ?? ''

      // 1) Anonymous path — only allowed when explicitly enabled AND no
      //    credentials were sent. Sending credentials when anonymous is
      //    off should NOT silently succeed.
      if (!username) {
        done(null, allowAnonymous)
        return
      }

      // 2) Per-client credential list (#165 primary path)
      const clients = this.activeEmbeddedClients
      const match = clients.find((c) => c.username === username)
      if (match) {
        const ok = bcryptCompareSafe(passwordStr, match.passwordHash)
        done(null, ok)
        return
      }

      // 3) Legacy shared credentials (fallback). `entry.password` is the
      //    resolved keychain value, or an `enc:v1` leftover read through the
      //    read-only bridge; one that cannot be read matches nothing.
      if (entry.username) {
        let expected: string | undefined
        try {
          expected = this.storedPassword(entry.password)
        } catch (err: unknown) {
          this.ctx.logger.error(errMsg(err), { tags: { topic: 'mqtt-broker' } })
          expected = undefined
        }
        const ok = expected !== undefined && username === entry.username && passwordStr === expected
        done(null, ok)
        return
      }

      // 4) No matching credential — reject.
      done(null, false)
    }
  }

  private makePublishAuthorizer() {
    return (
      client: AedesClient | null,
      packet: AedesPublishPacket,
      callback: (err?: Error | null) => void,
    ): void => {
      if (this.isAclAllowed(client, packet.topic, 'pub')) {
        callback()
      } else {
        callback(new Error('not authorized: publish denied by ACL'))
      }
    }
  }

  private makeSubscribeAuthorizer() {
    return (
      client: AedesClient,
      subscription: AedesSubscription,
      callback: (err: Error | null, subscription?: AedesSubscription | null) => void,
    ): void => {
      if (this.isAclAllowed(client, subscription.topic, 'sub')) {
        callback(null, subscription)
      } else {
        callback(new Error('not authorized: subscribe denied by ACL'))
      }
    }
  }

  /**
   * ACL evaluation. Order:
   *   1. If no ACL rules exist at all → allow everything (back-compat).
   *   2. If the broker is in anonymous mode and the client has no
   *      username → allow everything (no rule to evaluate against).
   *   3. Otherwise the client must match at least one ACL rule for the
   *      requested topic and access mode.
   */
  private isAclAllowed(client: AedesClient | null, topic: string, access: 'pub' | 'sub'): boolean {
    const acl = this.activeEmbeddedAcl
    if (acl.length === 0) return true
    const username = readClientUsername(client)
    if (!username) {
      // anonymous client — ACL is silent for them; allow.
      return true
    }
    return acl.some((rule) => {
      if (rule.username !== username) return false
      if (rule.access !== 'both' && rule.access !== access) return false
      return topicMatches(topic, rule.topicPattern)
    })
  }

  /**
   * Hot-reload embedded credentials + ACL without dropping every
   * connected client. Only sessions whose user's password hash changed
   * (or whose username was removed entirely) get force-closed.
   */
  private reconcileEmbeddedClients(): void {
    const runtime = this.embeddedRuntime
    if (!runtime) return

    const prevSnapshot = runtime.credentialsSnapshot
    const nextSnapshot = this.buildCredentialsSnapshot()

    const affectedUsers: string[] = []
    for (const [username, prevHash] of prevSnapshot) {
      const nextHash = nextSnapshot.get(username)
      if (nextHash !== prevHash) {
        affectedUsers.push(username)
      }
    }

    // Replace the auth handler so future connects validate against the
    // new list, and refresh the snapshot.
    runtime.aedes.authenticate = this.makeAuthenticateHandler(runtime.entry)
    runtime.aedes.authorizePublish = this.makePublishAuthorizer()
    runtime.aedes.authorizeSubscribe = this.makeSubscribeAuthorizer()
    runtime.credentialsSnapshot = nextSnapshot

    if (affectedUsers.length === 0) {
      this.ctx.logger.debug('mqtt embedded hot-reload — no password changes', {
        meta: { aclRules: this.activeEmbeddedAcl.length },
      })
      return
    }

    // Force-disconnect sessions for users whose creds changed. aedes
    // exposes clients via `aedes.clients` (Record<id, Client>) but the
    // shape isn't in the .d.ts — use a typed view.
    const clients = readClientMap(runtime.aedes)
    let closed = 0
    for (const client of clients) {
      if (!client) continue
      const u = readClientUsername(client)
      if (u && affectedUsers.includes(u)) {
        try {
          client.close(() => undefined)
          closed++
        } catch {
          /* ignore */
        }
      }
    }
    this.ctx.logger.info('mqtt embedded credentials rotated', {
      meta: { users: affectedUsers, closedSessions: closed },
      tags: { topic: 'mqtt-broker', phase: 'embedded-cred-rotation' },
    })
  }

  private buildCredentialsSnapshot(): ReadonlyMap<string, string> {
    const m = new Map<string, string>()
    for (const c of this.activeEmbeddedClients) {
      m.set(c.username, c.passwordHash)
    }
    return m
  }

  /**
   * Reassemble the internal {@link EmbeddedBrokerEntry} from the flat
   * `embedded*` config keys the settings form writes. Returns `null`
   * when the embedded broker is disabled — that's the signal
   * `onConfigChanged` / `onInitialize` use to decide whether to spawn
   * or shut down the `aedes` instance.
   */
  private deriveEmbeddedEntry(): EmbeddedBrokerEntry | null {
    if (!this.config.embeddedEnabled) return null
    const username = this.config.embeddedUsername
    const password = this.config.embeddedPassword
    return {
      id: this.config.embeddedId || 'embedded',
      name: 'Embedded broker',
      port: this.config.embeddedPort,
      allowAnonymous: this.config.embeddedAllowAnonymous,
      ...(username.length > 0 ? { username } : {}),
      ...(password.length > 0 ? { password } : {}),
    }
  }

  // ── Probe cache wiring ──────────────────────────────────────────

  private collectExternalProbeInputs(): readonly {
    id: string
    url: string
    username?: string
    password?: string
  }[] {
    // Onboard entries are backed by aedes servers we own — their live
    // status comes from the runtime map, not the external probe loop.
    const out: { id: string; url: string; username?: string; password?: string }[] = []
    for (const b of this.activeExternalBrokers) {
      if (b.onboard !== undefined) continue
      let password: string | undefined
      try {
        password = this.storedPassword(b.password)
      } catch {
        // An unreadable enc:v1 leftover: not probed at all (never probed
        // anonymously); the boot report names the field.
        continue
      }
      out.push({
        id: b.id,
        url: b.url,
        ...(b.username !== undefined ? { username: b.username } : {}),
        ...(password !== undefined ? { password } : {}),
      })
    }
    return out
  }

  // ── Retired codec (enc:v1) — read-only bridge ─────────────────────

  /** The retired codec's key, read once and only when an enc:v1 value exists. */
  private legacyKey: LegacyKey | null = null

  /**
   * The credential a stored password stands for — see `resolveStoredPassword`.
   * Throws `LegacyCiphertextError` for an `enc:v1` leftover it cannot decrypt.
   */
  private storedPassword(value: string | undefined): string | undefined {
    if (value === undefined || !value.startsWith('enc:v1:')) {
      return resolveStoredPassword(value, { kind: 'absent' })
    }
    if (this.legacyKey === null) this.legacyKey = loadLegacyKey(this.ctx.dataDir)
    return resolveStoredPassword(value, this.legacyKey)
  }

  /**
   * Say which fields still hold a value the retired `enc:v1` codec wrote, and
   * whether the read-only bridge can still read them. Nothing is migrated
   * here (no migration code ships): the operator's one-off `mqtt` step does.
   */
  private reportRetiredCiphertext(): void {
    const paths = retiredCiphertextPaths(this.config)
    if (paths.length === 0) return
    const unreadable: string[] = []
    const values = [
      ...this.activeExternalBrokers.map((b) => ({
        id: `brokers[${b.id}].password`,
        v: b.password,
      })),
      { id: 'embeddedPassword', v: this.config.embeddedPassword },
    ]
    for (const { id, v } of values) {
      try {
        this.storedPassword(v)
      } catch (err: unknown) {
        if (err instanceof LegacyCiphertextError) unreadable.push(id)
      }
    }
    if (unreadable.length > 0) {
      this.ctx.logger.error(
        'mqtt-broker: stored passwords in the retired enc:v1 form cannot be read — those brokers ' +
          'are not used until the one-off scripts/ops/keychain-migrate-hub.mjs mqtt step runs or ' +
          'the passwords are re-entered',
        {
          meta: { fields: unreadable },
          tags: { topic: 'mqtt-broker', phase: 'retired-ciphertext' },
        },
      )
      return
    }
    this.ctx.logger.info(
      'mqtt-broker: enc:v1 passwords read through the read-only bridge until the one-off mqtt ' +
        'step moves them into the keychain',
      { meta: { fields: paths }, tags: { topic: 'mqtt-broker', phase: 'retired-ciphertext' } },
    )
  }

  // ── Settings UI ─────────────────────────────────────────────────

  /**
   * Under the unified `broker` cap (Connectivity → MQTT Broker) the external
   * brokers are the CONNECTIONS that page's own panel lists and edits through
   * `broker.list` / `add` / `setSettings`, all over `config.brokers`. Drawing
   * the editable array as well would put two "Add broker" editors for ONE
   * store on one page, so that scope leaves it out; the addon's full page (no
   * cap) keeps it.
   */
  protected globalSettingsSchema(cap?: string) {
    const schema = this.fullSettingsSchema()
    if (cap !== brokerCapability.name) return schema
    return {
      ...schema,
      sections: schema.sections.filter((s) => s.id !== EXTERNAL_BROKERS_SECTION_ID),
    }
  }

  private fullSettingsSchema() {
    return this.schema({
      sections: [
        {
          id: EXTERNAL_BROKERS_SECTION_ID,
          title: 'External brokers',
          description:
            'Brokers running outside CamStack (mosquitto, EMQX, HiveMQ, cloud bridges, …). Passwords are kept in the keychain.',
          columns: 1,
          fields: [
            {
              type: 'editable-array',
              key: 'brokers',
              label: 'External brokers',
              labelKey: 'mqtt-broker:fullSettings.brokers.label',
              emptyMessage: 'No external brokers configured.',
              addLabel: 'Add broker',
              rowTitleTemplate: '{name} — {url}',
              defaultItem: {
                id: '',
                name: '',
                url: 'mqtt://',
                username: '',
                password: '',
                clientIdPrefix: '',
              },
              itemFields: [
                {
                  type: 'text',
                  key: 'id',
                  label: 'ID',
                  labelKey: 'mqtt-broker:fullSettings.brokers.id.label',
                  description: 'Auto-generated; leave blank when adding new rows.',
                  descriptionKey: 'mqtt-broker:fullSettings.brokers.id.description',
                },
                {
                  type: 'text',
                  key: 'name',
                  label: 'Display name',
                  labelKey: 'mqtt-broker:fullSettings.brokers.name.label',
                },
                {
                  type: 'text',
                  key: 'url',
                  label: 'Broker URL',
                  labelKey: 'mqtt-broker:fullSettings.brokers.url.label',
                  description: 'mqtt://, mqtts://, ws://, wss://',
                  descriptionKey: 'mqtt-broker:fullSettings.brokers.url.description',
                },
                {
                  type: 'text',
                  key: 'username',
                  label: 'Username',
                  labelKey: 'mqtt-broker:fullSettings.brokers.username.label',
                },
                {
                  type: 'password',
                  key: 'password',
                  label: 'Password',
                  labelKey: 'mqtt-broker:fullSettings.brokers.password.label',
                  showToggle: true,
                },
                {
                  type: 'text',
                  key: 'clientIdPrefix',
                  label: 'Client id prefix',
                  labelKey: 'mqtt-broker:fullSettings.brokers.clientIdPrefix.label',
                },
              ],
            },
          ],
        },
        {
          id: 'mqtt-broker-embedded',
          title: 'Embedded broker',
          titleKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded.title',
          description:
            'Optional CamStack-hosted aedes broker. Enable it to run a broker on this hub without standing up an external one — its connection details are exposed through the `mqtt-broker` cap like any external entry.',
          descriptionKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded.description',
          columns: 2,
          fields: [
            this.field({
              type: 'boolean',
              key: 'embeddedEnabled',
              label: 'Run embedded broker',
              labelKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedEnabled.label',
              description:
                'Starts an aedes broker on this hub. Disabling it shuts the broker down and disconnects clients.',
              descriptionKey:
                'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedEnabled.description',
              style: 'switch',
              default: false,
            }),
            this.field({
              type: 'number',
              key: 'embeddedPort',
              label: 'Port',
              labelKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedPort.label',
              description: 'TCP port the embedded broker listens on.',
              descriptionKey:
                'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedPort.description',
              min: 1,
              max: 65535,
              default: DEFAULT_EMBEDDED_PORT,
              showWhen: { field: 'embeddedEnabled', equals: true },
            }),
            this.field({
              type: 'boolean',
              key: 'embeddedAllowAnonymous',
              label: 'Allow anonymous',
              labelKey:
                'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedAllowAnonymous.label',
              description: 'Permit clients to connect without a username/password.',
              descriptionKey:
                'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedAllowAnonymous.description',
              style: 'switch',
              default: false,
              showWhen: { field: 'embeddedEnabled', equals: true },
            }),
            this.field({
              type: 'text',
              key: 'embeddedUsername',
              label: 'Shared username',
              labelKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedUsername.label',
              description:
                'Legacy single-user fallback — used only when no per-client credentials are configured below.',
              descriptionKey:
                'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedUsername.description',
              default: '',
              showWhen: { field: 'embeddedEnabled', equals: true },
            }),
            this.field({
              type: 'password',
              key: 'embeddedPassword',
              label: 'Shared password',
              labelKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedPassword.label',
              description: 'Kept in the keychain. Paired with the shared username above.',
              descriptionKey:
                'mqtt-broker:fullSettings.s_mqtt-broker-embedded.embeddedPassword.description',
              showToggle: true,
              default: '',
              showWhen: { field: 'embeddedEnabled', equals: true },
            }),
          ],
        },
        {
          id: 'mqtt-broker-embedded-clients',
          title: 'Embedded broker — credentials',
          titleKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded-clients.title',
          description:
            'Per-client username + bcrypt password hash for the embedded aedes broker. Generate the hash with `npx bcrypt-cli` (or any bcrypt tool, cost factor 10) and paste it here.',
          descriptionKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded-clients.description',
          columns: 1,
          fields: [
            {
              type: 'editable-array',
              key: 'embeddedClients',
              label: 'Clients',
              labelKey:
                'mqtt-broker:fullSettings.s_mqtt-broker-embedded-clients.embeddedClients.label',
              emptyMessage:
                'No clients configured — embedded broker is in shared-creds / anonymous mode.',
              addLabel: 'Add client',
              rowTitleTemplate: '{username}',
              defaultItem: {
                username: '',
                passwordHash: '',
              },
              itemFields: [
                {
                  type: 'text',
                  key: 'username',
                  label: 'Username',
                  labelKey:
                    'mqtt-broker:fullSettings.s_mqtt-broker-embedded-clients.embeddedClients.username.label',
                },
                {
                  type: 'text',
                  key: 'passwordHash',
                  label: 'bcrypt hash',
                  labelKey:
                    'mqtt-broker:fullSettings.s_mqtt-broker-embedded-clients.embeddedClients.passwordHash.label',
                  description: 'bcrypt hash of the password (cost factor 10).',
                  descriptionKey:
                    'mqtt-broker:fullSettings.s_mqtt-broker-embedded-clients.embeddedClients.passwordHash.description',
                },
              ],
            },
          ],
        },
        {
          id: 'mqtt-broker-embedded-acl',
          title: 'Embedded broker — topic ACL',
          titleKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.title',
          description:
            'Per-user pub/sub allow-list. With zero rules the broker is fully open to authenticated clients. With at least one rule, every user needs at least one rule that matches the topic.',
          descriptionKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.description',
          columns: 1,
          fields: [
            {
              type: 'editable-array',
              key: 'embeddedAcl',
              label: 'Rules',
              labelKey: 'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.label',
              emptyMessage: 'No ACL rules — embedded broker is wide open to authenticated users.',
              addLabel: 'Add rule',
              rowTitleTemplate: '{username} → {topicPattern} ({access})',
              defaultItem: {
                username: '',
                topicPattern: '#',
                access: 'both',
              },
              itemFields: [
                {
                  type: 'text',
                  key: 'username',
                  label: 'Username',
                  labelKey:
                    'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.username.label',
                },
                {
                  type: 'text',
                  key: 'topicPattern',
                  label: 'Topic pattern',
                  labelKey:
                    'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.topicPattern.label',
                  description: 'MQTT wildcards: `+` = single level, `#` = multi-level.',
                  descriptionKey:
                    'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.topicPattern.description',
                },
                {
                  type: 'select',
                  key: 'access',
                  label: 'Access',
                  labelKey:
                    'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.access.label',
                  options: [
                    {
                      value: 'sub',
                      label: 'Subscribe only',
                      labelKey:
                        'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.access.o_sub.label',
                    },
                    {
                      value: 'pub',
                      label: 'Publish only',
                      labelKey:
                        'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.access.o_pub.label',
                    },
                    {
                      value: 'both',
                      label: 'Subscribe + publish',
                      labelKey:
                        'mqtt-broker:fullSettings.s_mqtt-broker-embedded-acl.embeddedAcl.access.o_both.label',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  }
}

/**
 * MQTT topic-pattern matcher.
 *
 *   - `+` matches exactly one level
 *   - `#` matches zero-or-more levels — only valid as the last segment
 */
function topicMatches(topic: string, pattern: string): boolean {
  const tParts = topic.split('/')
  const pParts = pattern.split('/')
  for (let i = 0; i < pParts.length; i++) {
    const p = pParts[i]
    if (p === '#') return true
    if (i >= tParts.length) return false
    if (p === '+') continue
    if (p !== tParts[i]) return false
  }
  return tParts.length === pParts.length
}

function bcryptCompareSafe(plain: string, hash: string): boolean {
  if (!hash) return false
  try {
    return bcrypt.compareSync(plain, hash)
  } catch {
    return false
  }
}

/**
 * Decide whether a config update to the embedded broker requires a full
 * restart (port change) or can be hot-reloaded (credential / ACL change).
 */
function requiresEmbeddedRespawn(
  desired: EmbeddedBrokerEntry,
  running: EmbeddedBrokerEntry,
): boolean {
  return (
    desired.id !== running.id ||
    desired.port !== running.port ||
    desired.allowAnonymous !== running.allowAnonymous ||
    desired.username !== running.username ||
    desired.password !== running.password
  )
}

/**
 * Read the `username` field off an aedes Client without leaking a cast.
 * aedes attaches the username at runtime but its `.d.ts` doesn't carry
 * it — we narrow with a small structural check.
 */
function readClientUsername(client: unknown): string | null {
  if (typeof client !== 'object' || client === null) return null
  if (!('username' in client)) return null
  const value = (client as { username?: unknown }).username
  return typeof value === 'string' ? value : null
}

/**
 * Read aedes's internal client map. aedes typings don't expose
 * `.clients` so we narrow with structural guards on `unknown`.
 */
interface AedesWithClientMap extends AedesInstance {
  clients?: Record<string, unknown>
}

function hasClientMap(aedes: AedesInstance): aedes is AedesWithClientMap {
  if (!('clients' in aedes)) return false
  const c: unknown = (aedes as AedesWithClientMap).clients
  return typeof c === 'object' && c !== null
}

function isAedesClient(value: unknown): value is AedesClient {
  if (typeof value !== 'object' || value === null) return false
  const v: { id?: unknown; close?: unknown } = value
  return typeof v.id === 'string' && typeof v.close === 'function'
}

function readClientMap(aedes: AedesInstance): readonly AedesClient[] {
  if (!hasClientMap(aedes)) return []
  const view = aedes.clients ?? {}
  return Object.values(view).filter(isAedesClient)
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** An external broker entry that carries an onboard descriptor. */
interface OnboardExternalBrokerEntry extends ExternalBrokerEntry {
  readonly onboard: OnboardDescriptor
}

/** Narrow an {@link ExternalBrokerEntry} to one with an onboard descriptor. */
function hasOnboard(entry: ExternalBrokerEntry): entry is OnboardExternalBrokerEntry {
  return entry.onboard !== undefined
}

/**
 * Bind a `net` server to port 0 to discover a free ephemeral TCP port, then
 * close it and return the number. The caller binds the real `aedes` server
 * immediately after, so the small TOCTOU window is acceptable here.
 */
async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (err) => reject(err))
    probe.listen(0, () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('mqtt-broker: could not allocate a free port')))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

export default MqttBrokerAddon

function mapMqttStatus(
  s: BrokerStatus,
): 'connected' | 'disconnected' | 'connecting' | 'auth-failed' | 'unreachable' | 'error' {
  switch (s) {
    case 'connected':
      return 'connected'
    case 'disconnected':
      return 'disconnected'
    case 'auth-failed':
      return 'auth-failed'
    case 'unreachable':
      return 'unreachable'
    case 'tls-error':
      return 'error'
    default:
      return 'error'
  }
}
