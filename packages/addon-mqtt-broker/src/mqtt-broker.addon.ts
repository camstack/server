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
 *   `clusterSettingsSchema()` and rendered automatically inside the
 *   Integrations → Brokers tab's docked Settings panel, like every other
 *   integration-type addon.
 *
 * Lifecycle:
 *   - External broker entries are persisted in `this.activeExternalBrokers`.
 *   - The legacy single embedded broker is an onboard `brokers` record (migrated from the flat
 *     `embedded*` keys, same id); `startEmbeddedBroker` / `stopEmbeddedBroker` act on that record.
 *   - `addBroker` / `removeBroker` mutate the records and the runtime state.
 *   - `testConnection` does a one-shot `mqtt.connect` race against a 3s
 *     timeout AND refreshes the probe cache for the broker.
 */
import {
  BaseAddon,
  brokerCapability,
  type ConfigUISchema,
  defineAddonMigrations,
  EventCategory,
  integrationInstancesCapability,
  type IBrokerProvider,
  type IIntegrationInstancesProvider,
  type IMqttBrokerProvider,
  type MqttBrokerInfo,
  type MqttBrokerLiveStatus,
  mqttBrokerCapability,
  type ProviderRegistration,
  type RecordKindHandle,
  resolveSecretMarkers,
  isInstanceEnabled,
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
  type OnboardDescriptor,
  onboardToEmbeddedEntry,
} from './onboard-helpers.js'
import {
  LegacyCiphertextError,
  type LegacyKey,
  loadLegacyKey,
  resolveStoredPassword,
  retiredCiphertextPaths,
} from './retired-ciphertext.js'
import { type MqttBrokerBody, mqttBrokersEntryKind } from './broker-record-kinds.js'
import { buildMqttBrokerInstances, type MqttLiveState } from './mqtt-broker-instances.js'
import {
  ADDON_MIGRATIONS,
  type EmbeddedMigrationPorts,
  type LegacyEmbedded,
  type MqttBrokerRecordState,
} from './migrations/index.js'
import {
  LEGACY_EMBEDDED_FALLBACK_ID,
  LEGACY_EMBEDDED_KEYS,
  LEGACY_EMBEDDED_NAME,
} from './migrations/embedded-to-onboard.js'
import { mqttAclEntryKind, mqttClientEntryKind } from './mqtt-entry-record-kinds.js'
import { MqttBrokerStore } from './mqtt-broker-store.js'
import { listMqttHaInstancesOver } from './mqtt-broker-users.js'
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

/**
 * Internal, fully-resolved descriptor of an `aedes` server the addon runs for an onboard broker
 * record. NOT persisted: `onboardSpawnEntry` derives it from the record.
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
 * Persisted addon config: the embedded broker's per-client credentials and ACL. The broker itself
 * is an onboard `brokers` record; the flat `embedded*` keys that once described it are migrated
 * away (`migrations/embedded-to-onboard.ts`).
 */
interface MqttBrokerConfig {
  readonly embeddedClients: readonly EmbeddedClientEntry[]
  readonly embeddedAcl: readonly EmbeddedAclEntry[]
}

const DEFAULT_CONFIG: MqttBrokerConfig = {
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

export class MqttBrokerAddon extends BaseAddon<MqttBrokerConfig> {
  /** Per-record onboard `aedes` runtimes, keyed by `ExternalBrokerEntry.id`. */
  private onboardRuntimes = new Map<string, EmbeddedRuntime>()
  private probeCache: BrokerProbeCache | null = null
  private brokerStore: MqttBrokerStore | null = null
  private brokerInstances: IIntegrationInstancesProvider | null = null
  private clientStore: MqttClientStore | null = null
  private aclStore: MqttAclStore | null = null
  /** The external broker rows: the `brokers` records, secrets resolved. */
  private activeExternalBrokers: readonly ExternalBrokerEntry[] = []
  private activeEmbeddedClients: readonly EmbeddedClientEntry[] = []
  private activeEmbeddedAcl: readonly EmbeddedAclEntry[] = []

  constructor() {
    super({ ...DEFAULT_CONFIG })
  }

  private requireBrokerStore(): MqttBrokerStore {
    if (this.brokerStore === null) throw new Error('mqtt-broker: the broker records are not open')
    return this.brokerStore
  }

  /** What the addon knows of a broker right now: its onboard server or its last probe. */
  private liveState(id: string): MqttLiveState {
    const running = this.onboardRuntimes.get(id)
    const probe = this.probeCache?.get(id)
    return {
      onboard: running === undefined ? null : { connectedClients: running.aedes.connectedClients },
      ...(probe !== undefined
        ? {
            probe: {
              status: probe.status,
              latencyMs: probe.latencyMs,
              ...(probe.error !== undefined ? { error: probe.error } : {}),
              lastCheckedAt: probe.lastCheckedAt,
            },
          }
        : {}),
    }
  }

  private async persistExternalBrokers(entries: readonly ExternalBrokerEntry[]): Promise<void> {
    this.activeExternalBrokers = [...entries]
    await this.requireBrokerStore().replaceAll(entries)
  }

  /** Re-read the broker records after an instance create / update / delete / switch. */
  private async refreshExternalBrokers(): Promise<void> {
    const before = new Set(this.activeExternalBrokers.map((b) => b.id))
    this.activeExternalBrokers = await this.requireBrokerStore().listResolved()
    const now = new Set(this.activeExternalBrokers.map((b) => b.id))
    for (const id of before) if (!now.has(id)) this.probeCache?.evict(id)
    await this.reconcileOnboardRuntimes()
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
    this.brokerInstances = buildMqttBrokerInstances(records, {
      formSchema: (id, onboard) => this.brokerForm(id, onboard),
      listMqttHaInstances: () => listMqttHaInstancesOver(this.ctx.api),
      freePort: () => findFreePort(),
      probe: (cfg) => this.probeMqtt(cfg),
      onboardListening: (id) => this.onboardRuntimes.has(id),
      liveState: (id) => this.liveState(id),
      onChanged: async () => {
        await this.refreshExternalBrokers()
      },
    })
    // The addon checks the old settings list against the records, then serves the records.
    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts()))
    this.activeExternalBrokers = await this.brokerStore.listResolved()
    this.reportRetiredCiphertext()
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

    // Start every persisted onboard broker.
    await this.reconcileOnboardRuntimes()

    this.ctx.addDisposer(async () => {
      await this.probeCache?.stop()
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
        brokerCount: this.activeExternalBrokers.length,
        embeddedRunning: this.onboardRuntimes.size > 0,
      }),
    }

    // Unified `broker` cap provider (kind='mqtt'). Sits ALONGSIDE
    // the legacy `mqtt-broker` cap during the migration window. The
    // long-term path is to deprecate the legacy cap once every
    // consumer has migrated to the unified surface.
    const unifiedProvider = this.buildUnifiedBrokerProvider()
    const brokerInstances = this.brokerInstances
    if (brokerInstances === null) throw new Error('mqtt-broker: the broker instances are not built')

    return [
      { capability: mqttBrokerCapability, provider },
      { capability: brokerCapability, provider: unifiedProvider },
      {
        capability: integrationInstancesCapability,
        provider: brokerInstances,
      },
    ]
  }

  // ── Unified `broker` cap (kind='mqtt') ────────────────────────────────

  /**
   * The bus-only `broker` cap (D1013). The brokers themselves are the `integration-instances`
   * provider; this one only answers the config read and the status.
   */
  private buildUnifiedBrokerProvider(): IBrokerProvider {
    // True when this provider owns the given broker id (a `brokers` record, onboard or external).
    // `getBrokerConfig` answers null for a foreign id (NOT throw) so the no-addonId collection
    // fallback degrades gracefully when it routes a foreign id to the first provider.
    const owns = (id: string): boolean => this.activeExternalBrokers.some((b) => b.id === id)

    return {
      getBrokerConfig: async ({ id }) => {
        if (!owns(id)) return null
        const cfg = this.getBrokerConfig(id)
        return cfg
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
          brokerCount: this.activeExternalBrokers.length,
          connectedCount: all.filter((b) => b.status === 'connected').length,
        }
      },
    }
  }

  protected async onShutdown(): Promise<void> {
    await this.probeCache?.stop()
    await this.shutdownAllOnboard()
  }

  protected async onConfigChanged(): Promise<void> {
    this.activeExternalBrokers = await this.requireBrokerStore().listResolved()
    await this.syncEmbeddedEntriesFromConfig()

    // The clients and ACL are shared by every onboard broker: reconcile the servers, then
    // hot-reload their credentials without dropping every session.
    await this.reconcileOnboardRuntimes()
    this.reconcileEmbeddedClients()
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
      if (!isInstanceEnabled(external)) {
        throw new Error(`mqtt-broker: broker '${id}' is switched off`)
      }
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
   * the instance test (`testInstance`) of a broker not saved yet (the typed values).
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

  /** The `brokers` records, for the two legacy cap methods that create or switch off one. */
  private brokerRecordHandle(): RecordKindHandle<MqttBrokerBody> {
    const handle = this.ctx.records?.kind(mqttBrokersEntryKind)
    if (handle === undefined) throw new Error('mqtt-broker: the broker records are not open')
    return handle
  }

  /** Create an ONBOARD broker record; the reconcile then spawns its `aedes` server. */
  private async startEmbeddedBroker(input: {
    port: number
    allowAnonymous: boolean
    username?: string
    password?: string
  }): Promise<{ id: string; url: string }> {
    const id = randomUUID()
    const built = buildOnboardEntry({
      id,
      name: LEGACY_EMBEDDED_NAME,
      port: input.port,
      settings: {
        allowAnonymous: input.allowAnonymous,
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.password !== undefined ? { password: input.password } : {}),
      },
    })
    const handle = this.brokerRecordHandle()
    await handle.put(
      {
        id,
        data: mqttBrokersEntryKind.schema.parse({
          name: built.name,
          url: built.url,
          ...(built.username !== undefined ? { username: built.username } : {}),
          ...(built.password !== undefined ? { password: built.password } : {}),
          onboard: built.onboard,
        }),
      },
      { ifRev: 0 },
    )
    await this.refreshExternalBrokers()
    if (!this.onboardRuntimes.has(id)) {
      await handle.delete(id)
      await this.refreshExternalBrokers()
      throw new Error(`embedded broker could not listen on port ${input.port}`)
    }
    this.ctx.logger.info('embedded mqtt broker started', {
      meta: { id, port: input.port },
      tags: { topic: 'mqtt-broker', phase: 'embedded-started' },
    })
    this.ctx.eventBus?.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'addon', id: this.ctx.id },
      category: EventCategory.AddonUpdated,
      data: { addonId: this.ctx.id, action: 'embedded-broker-started' },
    })
    return { id, url: built.url }
  }

  /** Switch an onboard broker off (its record stays, so it can be switched on again). */
  private async stopEmbeddedBroker(id: string): Promise<void> {
    const handle = this.brokerRecordHandle()
    const row = await handle.get(id)
    if (row === null || row.data.onboard === undefined) return // idempotent
    await handle.patch(id, { enabled: false })
    await this.refreshExternalBrokers()
    this.ctx.logger.info('embedded mqtt broker stopped', { meta: { id } })
  }

  /**
   * Build + listen an `aedes` server for `entry` and RETURN the runtime
   * without assigning it to any field (the onboard brokers keep theirs in
   * {@link spawnOnboard}).
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
    const desiredEntries = this.activeExternalBrokers
      .filter(hasOnboard)
      .filter((b) => isInstanceEnabled(b))
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
    for (const runtime of this.onboardRuntimes.values()) this.reconcileRuntimeClients(runtime)
  }

  private reconcileRuntimeClients(runtime: EmbeddedRuntime): void {
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
      if (b.onboard !== undefined || !isInstanceEnabled(b)) continue
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
    const paths = retiredCiphertextPaths({
      brokers: this.activeExternalBrokers,
    })
    if (paths.length === 0) return
    const unreadable: string[] = []
    const values = [
      ...this.activeExternalBrokers.map((b) => ({
        id: `brokers[${b.id}].password`,
        v: b.password,
      })),
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

  // ── Instance form ─────────────────────────────────────────────────

  /**
   * The broker form. The create form (`id` null) offers "run an onboard broker" (CamStack hosts an
   * `aedes` server on this hub: a port, anonymous access) or an external URL; an existing onboard
   * broker edits only its credentials, since its address is the one it was given.
   */
  private brokerForm(id: string | null, onboard: boolean) {
    const credentials = [
      {
        type: 'text' as const,
        key: 'username',
        label: 'Username',
        labelKey: 'mqtt-broker:fullSettings.brokers.username.label',
      },
      {
        type: 'password' as const,
        key: 'password',
        label: 'Password',
        labelKey: 'mqtt-broker:fullSettings.brokers.password.label',
        showToggle: true,
      },
    ]
    if (onboard) {
      return this.schema({
        sections: [
          {
            id: 'broker',
            title: 'Onboard broker',
            description:
              'A CamStack-hosted broker on this hub. Its port was chosen when it was created.',
            columns: 1,
            fields: credentials,
          },
        ],
      })
    }
    const creating = id === null
    const external = { field: 'onboard', equals: false } as const
    return this.schema({
      sections: [
        {
          id: 'broker',
          title: creating ? 'MQTT broker' : 'External broker',
          description: creating
            ? 'Run a broker on this hub, or connect to one running outside CamStack (mosquitto, EMQX, HiveMQ, cloud bridges, …). The password is kept in the keychain.'
            : 'A broker running outside CamStack (mosquitto, EMQX, HiveMQ, cloud bridges, …). The password is kept in the keychain.',
          columns: 1,
          fields: [
            ...(creating
              ? [
                  {
                    type: 'boolean' as const,
                    key: 'onboard',
                    label: 'Run an onboard broker',
                    labelKey: 'mqtt-broker:fullSettings.brokers.onboard.label',
                    description:
                      'Spin up a CamStack-hosted aedes broker on this hub instead of connecting to an external one. Each onboard broker gets its own dedicated server + port.',
                    descriptionKey: 'mqtt-broker:fullSettings.brokers.onboard.description',
                    default: false,
                  },
                  {
                    type: 'number' as const,
                    key: 'port',
                    label: 'Port',
                    labelKey: 'mqtt-broker:fullSettings.brokers.port.label',
                    placeholder: '(auto)',
                    description:
                      'TCP port for the onboard broker. Leave blank to auto-allocate a free port.',
                    descriptionKey: 'mqtt-broker:fullSettings.brokers.port.description',
                    showWhen: { field: 'onboard', equals: true },
                  },
                  {
                    type: 'boolean' as const,
                    key: 'allowAnonymous',
                    label: 'Allow anonymous',
                    labelKey: 'mqtt-broker:fullSettings.brokers.allowAnonymous.label',
                    description: 'Permit clients to connect without a username/password.',
                    descriptionKey: 'mqtt-broker:fullSettings.brokers.allowAnonymous.description',
                    default: false,
                    showWhen: { field: 'onboard', equals: true },
                  },
                ]
              : []),
            {
              type: 'text' as const,
              key: 'url',
              label: 'Broker URL',
              labelKey: 'mqtt-broker:fullSettings.brokers.url.label',
              description: 'mqtt://, mqtts://, ws://, wss://',
              descriptionKey: 'mqtt-broker:fullSettings.brokers.url.description',
              ...(creating ? { showWhen: external } : { required: true }),
            },
            ...credentials,
            {
              type: 'text' as const,
              key: 'clientIdPrefix',
              label: 'Client id prefix',
              labelKey: 'mqtt-broker:fullSettings.brokers.clientIdPrefix.label',
              ...(creating ? { showWhen: external } : {}),
            },
          ],
        },
      ],
    })
  }

  /** The ports of the settings migrations: the old `brokers` key in, the records read. */
  private migrationPorts(): EmbeddedMigrationPorts {
    const handle = this.ctx.records?.kind(mqttBrokersEntryKind)
    if (handle === undefined) throw new Error('records are not available')
    return {
      // The value as stored, markers unresolved: the plan's precondition is that very row.
      readRawBrokers: async (): Promise<unknown> =>
        (await this.ctx.settings?.readAddonStore())?.['brokers'],
      readLegacyEmbedded: async (): Promise<LegacyEmbedded | null> => {
        const raw = (await this.ctx.settings?.readAddonStore()) ?? {}
        // The password as the keychain holds it, then through the retired-codec bridge; an
        // unreadable value throws, so the migration fails loudly and the keys stay.
        const secrets = this.ctx.secrets
        const { value } =
          secrets === undefined
            ? { value: raw }
            : await resolveSecretMarkers(raw, secrets, {
                unresolved: 'keep-marker',
                ownedBy: secrets.owner,
              })
        const text = (key: string): string | undefined => {
          const v = value[key]
          return typeof v === 'string' && v.length > 0 ? v : undefined
        }
        const port = value['embeddedPort']
        const username = text('embeddedUsername')
        const password = this.storedPassword(text('embeddedPassword'))
        const enabled = value['embeddedEnabled'] === true
        // A stopped broker that was never started or given credentials is the form's defaults.
        const configured =
          enabled ||
          text('embeddedId') !== undefined ||
          username !== undefined ||
          password !== undefined
        if (!configured) return null
        return {
          enabled,
          id: text('embeddedId') ?? LEGACY_EMBEDDED_FALLBACK_ID,
          port: typeof port === 'number' && Number.isInteger(port) ? port : 1883,
          allowAnonymous: value['embeddedAllowAnonymous'] === true,
          ...(username !== undefined ? { username } : {}),
          ...(password !== undefined ? { password } : {}),
        }
      },
      readRawEmbeddedKeys: async (): Promise<Readonly<Record<string, unknown>>> => {
        const raw = (await this.ctx.settings?.readAddonStore()) ?? {}
        return Object.fromEntries(
          LEGACY_EMBEDDED_KEYS.filter((key) => key in raw).map((key) => [key, raw[key]]),
        )
      },
      putOnboardRecord: async (id, body): Promise<void> => {
        await handle.put({ id, data: mqttBrokersEntryKind.schema.parse(body) }, { ifRev: 0 })
      },
      readRecords: async (): Promise<ReadonlyMap<string, MqttBrokerRecordState>> => {
        const page = await handle.query({ limit: 1000 })
        return new Map(
          page.records.map((r): [string, MqttBrokerRecordState] => [
            r.id,
            { hasPassword: (r.data.password ?? '').length > 0 },
          ]),
        )
      },
      warn: (message: string) => {
        this.ctx.logger.warn(message, { tags: { topic: 'mqtt-broker', phase: 'migration' } })
      },
    }
  }

  // ── Settings UI ─────────────────────────────────────────────────

  protected override scopedSettingsCapabilities(): readonly string[] {
    return ['mqtt-broker', 'broker']
  }

  /**
   * The credentials and the ACL of the onboard brokers. The brokers are records, listed
   * on the Brokers page and edited as integration instances (`brokerForm`).
   */
  protected override async clusterSettingsSchema(cap: string): Promise<ConfigUISchema | null> {
    // `broker` is the scope the Connectivity page asks for; both answer with the credentials and ACL form.
    if (cap !== 'mqtt-broker' && cap !== 'broker') return null
    return this.schema({
      sections: [
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
