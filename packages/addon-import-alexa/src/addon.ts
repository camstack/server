import { randomUUID } from 'node:crypto'
import {
  addonRoutesCapability,
  BaseDeviceProvider,
  brokerCapability,
  buildAddonRouteProvider,
  createEvent,
  defineAddonMigrations,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  EventCategory,
  linkedIdOf,
  linkUserFinder,
  guardInstanceDelete,
  type InstanceUserFinder,
  defaultIntegrationApiOver,
  flattenPortsOver,
  composeInstanceKinds,
  notificationTargetParts,
  type IIntegrationInstancesProvider,
  integrationInstancesCapability,
  type AddonDataPlaneHandle,
  type AddonInitResult,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type IBrokerProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type IntegrationInstanceRef,
  type RecordsAccess,
  type RecordIntegrationInstances,
  notificationOutputCapability,
  VENDOR_LOGIN_PROXY_PREFIX,
  VendorLoginProxy,
  isInstanceEnabled,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  settingsToAlexaConnection,
  type AlexaAddonConfig,
  type AlexaConnection,
} from './config.js'
import { AlexaDeviceCodeManager } from './alexa-device-code-manager.js'
import { AlexaProxyLoginManager } from './alexa-proxy-login-manager.js'
import { buildAlexaLoginRoutes } from './alexa-login-routes.js'
import { AlexaBrokerRegistry } from './alexa-broker-registry.js'
import { sameConnection } from './alexa-integration-manager.js'
import type { AlexaRegistration } from './amazon-auth/registration.js'
import { readNewerSession, removeSessionFile } from './session-file-migration.js'
import { buildAlexaBrokerProvider } from './alexa-broker-provider.js'
import { buildAlexaAdoptionProvider } from './alexa-adoption-provider.js'
import { cascadeRemoveDevicesForBroker } from './alexa-broker-device-cascade.js'
import { setBrokerDevicesOnline, type OfflineTarget } from './alexa-broker-offline.js'
import { alexaAccounts, alexaCommands } from './alexa-gateway.js'
import type { AlexaAppliance, AlexaStateValue } from './alexa-client.js'
import { mapAlexaCapabilitiesToCamStack } from './alexa-domain-mapping.js'
import { AlexaDevice } from './devices/alexa-device.js'
import { AlexaEchoDevice } from './devices/alexa-echo-device.js'
import { alexaEchoSessions } from './alexa-echo-sessions.js'
import {
  type AlexaBrokerBody,
  type AlexaConnectionBody,
  alexaBrokersEntryKind,
  alexaRecordKinds,
} from './broker-record-kinds.js'
import { ALEXA_SIGN_IN_PATH, buildAlexaAccountInstances } from './alexa-account-instances.js'
import { buildAlexaInstances } from './alexa-instances.js'
import { AlexaBrokerStore } from './alexa-broker-store.js'
import { readEchoTargets, type AlexaBrokerEntry } from './config.js'
import type { EchoSettingPorts } from './migrations/echo-targets-to-records.js'
import { readBrokerSeed } from './speak/broker-seed.js'
import {
  alexaNotifyRecordKinds,
  echoRecordPortsOver,
  echoTargetProbe,
  echoRowOf,
  type EchoTargetStore,
  echoTargetStoreOver,
  legacyEchoTargetsOver,
} from './speak/echo-store.js'
import { alexaTargetKind } from './speak/provider.js'
import { AlexaSpeakController } from './speak/controller.js'
import {
  ADDON_MIGRATIONS,
  BROKER_RECORD_MIGRATION_IDS,
  type AlexaMigrationPorts,
  alexaIntegrationRowsPorts,
  alexaBrokerLinkPorts,
} from './migrations/index.js'
import { ALEXA_BROKER_KIND } from './speak/constants.js'
import { speakIconRoutes } from './speak/icon-routes.js'
import { RecordsSpeakSessionStore } from './speak/session-store.js'

/** Default config — a fresh install starts with no accounts. */
const DEFAULTS: AlexaAddonConfig = {
  echoTargets: [],
}

/** Device types an imported Alexa appliance can materialise as. */
const ALEXA_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Switch,
  DeviceType.Light,
  DeviceType.Lock,
  DeviceType.Cover,
  DeviceType.Thermostat,
  DeviceType.Sensor,
  DeviceType.Button,
  DeviceType.Control,
  DeviceType.Generic,
]

/**
 * Alexa device-import addon (any-node). Imports the smart-home devices in an
 * Amazon Alexa account via the unofficial alexa-remote2 cookie/token client
 * (behind the {@link alexaCommands} / {@link alexaAccounts} seams). One Amazon
 * account = one "broker"; each mappable appliance becomes a flat CamStack device
 * (NOT a container — Alexa appliances are standalone). Poll-based state sync.
 * Modelled on the Ecowitt / Matter device-provider template.
 *
 * The Alexa cloud client is the real alexa-remote2 binding (`AlexaRemoteClient`,
 * see `alexa-remote-client.ts`); `StubAlexaClient` remains as a test double.
 * Auth is cookie / cookieData-blob based. The preferred onboarding path is the
 * interactive proxy login (alexa-remote2 proxy auth mode, driven by the
 * onboarding wizard via the addon-routes control plane): the operator opens a
 * local proxy URL in their browser, completes the real Amazon OAuth/2FA flow,
 * and the captured cookie is persisted automatically. Pasting a pre-obtained
 * cookie is kept as a fallback. Either way the cookie lands in the same
 * `connection.cookie` field; the session is persisted to the addon `dataDir`
 * and auto-refreshed.
 */
export class AlexaImportAddon extends BaseDeviceProvider<AlexaAddonConfig> {
  protected readonly addonId = 'import-alexa'
  protected readonly providerName = 'Alexa'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    ...Object.fromEntries(ALEXA_DEVICE_TYPES.map((t) => [t, AlexaDevice])),
    // An Echo is the one media player this addon imports.
    [DeviceType.MediaPlayer]: AlexaEchoDevice,
  }

  private registry: AlexaBrokerRegistry | null = null
  private proxyLogin: AlexaProxyLoginManager | null = null
  private deviceCodeLogin: AlexaDeviceCodeManager | null = null
  private loginPlane: AddonDataPlaneHandle | null = null
  private loginProxy: VendorLoginProxy | null = null
  private brokerStore: AlexaBrokerStore | null = null
  private instances: RecordIntegrationInstances<AlexaConnectionBody> | null = null
  private accountInstances: RecordIntegrationInstances<AlexaBrokerBody> | null = null
  private activeBrokers: readonly AlexaBrokerEntry[] = []
  private speak: AlexaSpeakController | null = null
  private echoStore: EchoTargetStore | null = null

  constructor() {
    super({ ...DEFAULTS })
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('import-alexa: ctx.records is required (hub-only addon)')
    }
    await records.declare({ ...alexaRecordKinds, ...alexaNotifyRecordKinds })
    this.brokerStore = AlexaBrokerStore.of(records)
    this.instances = buildAlexaInstances(records)
    this.accountInstances = buildAlexaAccountInstances(records, {
      mintId: () => this.requireRegistry().allocateId(),
      infoOf: (id) => this.registry?.get(id) ?? null,
      onChanged: (id) => this.syncBrokerRuntime(id),
    })
    // The stored broker records move to the flat shape, and the integration link off them, BEFORE
    // anything reads or rewrites them (a rewrite would drop the retired link).
    await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts(records)),
      { only: BROKER_RECORD_MIGRATION_IDS },
    )
    this.activeBrokers = await this.loadPersistedBrokers()
    await this.adoptSessionFiles()

    this.registry = new AlexaBrokerRegistry(this.ctx.logger, {
      persistRegistration: (brokerId, registration) =>
        this.persistRenewedRegistration(brokerId, registration),
      onBrokerConnected: (brokerId) => {
        this.ctx.logger.info('Alexa: broker connected', { meta: { brokerId } })
        this.setBrokerDevicesOnline(brokerId, true)
      },
      onBrokerDisconnected: (brokerId) => {
        this.setBrokerDevicesOnline(brokerId, false)
      },
      onAuthFailed: (brokerId, error) => {
        this.ctx.logger.warn('Alexa: broker auth failed — re-link required', {
          meta: { brokerId, error },
        })
        this.setBrokerDevicesOnline(brokerId, false)
      },
      onAppliancesChanged: (brokerId, appliances) => {
        void this.reconcileAppliances(brokerId, appliances)
      },
      onStatesPolled: (brokerId, values) => {
        this.emitStateValues(brokerId, values)
      },
    })

    // Wire the outbound command sink to the live clients (via the registry).
    alexaCommands.setDispatcher((brokerId, command) =>
      this.requireRegistry().sendCommand(brokerId, command),
    )

    await this.registry.restore(this.activeBrokers)

    // Interactive Amazon login (through the hub login proxy), driven by the
    // onboarding wizard through the addon-routes control plane below.
    await this.serveLoginProxy()
    this.proxyLogin = new AlexaProxyLoginManager({
      logger: this.ctx.logger,
      getLoginProxy: () => this.loginProxy,
    })

    this.deviceCodeLogin = new AlexaDeviceCodeManager({ logger: this.ctx.logger })

    this.ctx.logger.info('Alexa: import addon initialised', {
      meta: { brokerCount: this.activeBrokers.length },
    })

    const loginRoutes = [
      ...buildAlexaLoginRoutes({
        logger: this.ctx.logger,
        proxyLogin: this.proxyLogin,
        deviceCode: this.deviceCodeLogin,
        commitCookie: (input) => this.commitCapturedCookie(input),
      }),
      ...speakIconRoutes(),
    ]

    await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, this.migrationPorts(records)),
      {
        only: ADDON_MIGRATIONS.map((m) => m.meta.id).filter(
          (id) => !BROKER_RECORD_MIGRATION_IDS.includes(id),
        ),
      },
    )

    // An Echo the migration could not move stays in the setting, and the store keeps serving it.
    const echoStore = echoTargetStoreOver(records, {
      logger: this.ctx.logger,
      legacy: legacyEchoTargetsOver(this.echoSettingPorts()),
    })
    this.echoStore = echoStore
    const speak = new AlexaSpeakController({
      logger: this.ctx.logger.child('speak'),
      readTargets: () => echoStore.list(),
      putTarget: (target) => echoStore.upsert(target),
      removeTarget: (targetId) => echoStore.delete(targetId),
      listBrokers: () =>
        this.activeBrokers.map((entry) => ({
          id: entry.id,
          name: entry.name,
          amazonDomain: entry.connection.amazonDomain,
        })),
      readSeed: async (brokerId) => {
        const entry = this.activeBrokers.find((row) => row.id === brokerId)
        return entry === undefined ? null : readBrokerSeed(entry)
      },
      sessions: RecordsSpeakSessionStore.of(records),
      ensurePython: () => this.ctx.deps.ensurePython(),
      push: alexaEchoSessions,
    })
    this.speak = speak
    alexaEchoSessions.setResolver((brokerId) => speak.echoFor(brokerId))
    // Not awaited: initialize() is on the capability-graph critical path.
    void speak.start().catch((err: unknown) => {
      this.ctx.logger.warn('alexa speak: worker did not start', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })

    return {
      providers: [
        ...regs,
        { capability: brokerCapability, provider: this.buildBrokerProvider() },
        {
          capability: integrationInstancesCapability,
          provider: this.buildInstancesProvider(),
        },
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
        {
          capability: addonRoutesCapability,
          provider: buildAddonRouteProvider('import-alexa', loginRoutes),
        },
        { capability: notificationOutputCapability, provider: speak.provider },
      ],
    }
  }

  /** The `echoTargets` setting, read and written as the migration and the legacy store see it. */
  private echoSettingPorts(): EchoSettingPorts {
    return {
      readRows: () => (Array.isArray(this.config.echoTargets) ? this.config.echoTargets : []),
      writeRows: async (rows) => {
        await this.updateGlobalSettings({
          echoTargets: [...readEchoTargets({ echoTargets: rows })],
        })
      },
    }
  }

  private migrationPorts(records: RecordsAccess): AlexaMigrationPorts {
    const secrets = this.ctx.secrets
    if (secrets === undefined) throw new Error('import-alexa: ctx.secrets is required')
    return {
      ...this.echoSettingPorts(),
      ...flattenPortsOver(records.kind(alexaBrokersEntryKind)),
      ...alexaBrokerLinkPorts(records, (message) => this.ctx.logger.warn(message)),
      ...echoRecordPortsOver(records, this.ctx.logger),
      ...alexaIntegrationRowsPorts({
        api: defaultIntegrationApiOver(this.ctx.api),
        records,
        secrets,
        warn: (message) => this.ctx.logger.warn(message),
      }),
    }
  }

  /** One provider over the two record kinds: the account (broker) and the integrations using it. */
  private buildInstancesProvider(): IIntegrationInstancesProvider {
    if (this.accountInstances === null) throw new Error('import-alexa: account instances not ready')
    const records = this.ctx.records
    if (records === undefined) throw new Error('import-alexa: ctx.records is required')
    return composeInstanceKinds(
      [
        {
          kind: {
            id: 'account',
            label: 'Alexa account',
            functionCap: 'broker',
            brokerKind: ALEXA_BROKER_KIND,
            role: 'services',
            signIn: { basePath: ALEXA_SIGN_IN_PATH, methods: ['device-code', 'proxy'] },
          },
          provider: guardInstanceDelete(this.accountInstances.toProvider(), () =>
            this.brokerUsers(),
          ),
        },
        {
          kind: {
            id: 'integration',
            label: 'Alexa',
            functionCap: 'device-provider',
            role: 'devices',
          },
          provider: this.requireInstances().toProvider(),
        },
        ...notificationTargetParts(records, {
          descriptors: [alexaTargetKind()],
          kinds: alexaNotifyRecordKinds,
          mintId: () => randomUUID(),
          probe: echoTargetProbe(() => this.speak),
          canProbe: () => true,
        }),
      ],
      {
        role: 'devices',
        instanceMode: 'multiple',
        kind: 'account',
        canTest: true,
        allowRestoreId: true,
      },
    )
  }

  /**
   * Bring the runtime in line with one account record after the instances page changed it: a
   * removed record stops its manager and cascades its devices, an off record only stops the
   * manager, a live one re-applies its connection or starts under the record's own id.
   */
  private async syncBrokerRuntime(id: string): Promise<void> {
    const reg = this.requireRegistry()
    const entry = await this.requireBrokerStore().getById(id)
    this.activeBrokers = await this.loadPersistedBrokers()
    if (entry === null) {
      await reg.removeEntry(id)
      await this.cascadeRemoveDevicesForBroker(id)
      void this.speak?.brokersChanged()
      return
    }
    const configured =
      entry.connection.cookie.length > 0 || entry.connection.refreshToken.length > 0
    if (!isInstanceEnabled(entry) || !configured) {
      await reg.removeEntry(id)
      void this.speak?.brokersChanged()
      return
    }
    try {
      if (reg.get(id) !== null) {
        // A record write that changed nothing the client uses (a renewed registration the
        // client already holds) must not restart the account.
        if (!sameConnection(entry.connection, reg.getConnection(id))) {
          await reg.updateEntry(id, entry.connection)
        }
      } else {
        await reg.createEntry(entry.name, entry.connection, { id })
      }
    } catch (err) {
      this.ctx.logger.warn('alexa instance: could not start the account', {
        meta: { brokerId: id, error: errMsg(err) },
      })
    }
    void this.speak?.brokersChanged()
  }

  private requireBrokerStore(): AlexaBrokerStore {
    if (this.brokerStore === null) throw new Error('import-alexa: broker store not ready')
    return this.brokerStore
  }

  private requireInstances(): RecordIntegrationInstances<AlexaConnectionBody> {
    if (this.instances === null) throw new Error('import-alexa: instances not ready')
    return this.instances
  }

  private async loadPersistedBrokers(): Promise<readonly AlexaBrokerEntry[]> {
    return this.requireBrokerStore().listResolved()
  }

  /**
   * The session file an earlier version kept beside each record moves into the record (when it
   * is newer) and is deleted. A failure keeps the file for the next boot.
   */
  private async adoptSessionFiles(): Promise<void> {
    const dataDir = this.ctx.dataDir
    try {
      const adopted = new Map<string, string>()
      for (const entry of this.activeBrokers) {
        const cookie = await readNewerSession(dataDir, entry)
        if (cookie !== null) adopted.set(entry.id, cookie)
      }
      if (adopted.size > 0) {
        await this.persistBrokerEntries(
          this.activeBrokers.map((b) => {
            const cookie = adopted.get(b.id)
            return cookie === undefined ? b : { ...b, connection: { ...b.connection, cookie } }
          }),
        )
        this.ctx.logger.info('Alexa: session files moved into the broker records', {
          meta: { count: adopted.size },
        })
      }
      for (const entry of this.activeBrokers) await removeSessionFile(dataDir, entry.id)
    } catch (err: unknown) {
      this.ctx.logger.warn('Alexa: could not move the session files into the records', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Store a registration the client renewed on its broker's record (the secret `cookie` field). */
  private async persistRenewedRegistration(
    brokerId: string,
    registration: AlexaRegistration,
  ): Promise<void> {
    const cookie = JSON.stringify(registration)
    const entry = this.activeBrokers.find((b) => b.id === brokerId)
    if (entry === undefined || entry.connection.cookie === cookie) return
    await this.persistBrokerEntries(
      this.activeBrokers.map((b) =>
        b.id === brokerId ? { ...b, connection: { ...b.connection, cookie } } : b,
      ),
    )
  }

  private async persistBrokerEntries(entries: readonly AlexaBrokerEntry[]): Promise<void> {
    this.activeBrokers = [...entries]
    await this.requireBrokerStore().replaceAll(entries)
    void this.speak?.brokersChanged()
  }

  protected override async onConfigChanged(): Promise<void> {
    const reg = this.registry
    if (!reg) return
    this.activeBrokers = await this.loadPersistedBrokers()
    const persisted = this.activeBrokers
    const liveIds = new Set(reg.list().map((b) => b.id))
    const persistedIds = new Set(persisted.map((e) => e.id))

    for (const liveId of liveIds) {
      if (!persistedIds.has(liveId)) {
        try {
          await reg.removeEntry(liveId)
        } catch (err) {
          this.ctx.logger.warn('Alexa onConfigChanged: removeEntry failed', {
            meta: { brokerId: liveId, error: errMsg(err) },
          })
        }
      }
    }

    for (const entry of persisted) {
      if (!isInstanceEnabled(entry)) continue
      if (entry.id && liveIds.has(entry.id)) {
        if (sameConnection(entry.connection, reg.getConnection(entry.id))) continue
        try {
          await reg.updateEntry(entry.id, entry.connection)
        } catch (err) {
          this.ctx.logger.warn('Alexa onConfigChanged: updateEntry failed', {
            meta: { brokerId: entry.id, error: errMsg(err) },
          })
        }
        continue
      }
      try {
        const created = await reg.createEntry(entry.name, entry.connection)
        if (created.id !== entry.id) {
          const next = persisted.map((b) => (b === entry ? { ...b, id: created.id } : b))
          await this.persistBrokerEntries(next)
        }
      } catch (err) {
        this.ctx.logger.warn('Alexa onConfigChanged: failed to start new broker', {
          meta: { brokerName: entry.name, error: errMsg(err) },
        })
      }
    }
    void this.speak?.brokersChanged()
  }

  /** The hub's HTTPS face for the Amazon login (D955): admin session only. */
  private async serveLoginProxy(): Promise<void> {
    const proxy = new VendorLoginProxy({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
    })
    try {
      this.loginPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: VENDOR_LOGIN_PROXY_PREFIX,
          access: 'admin',
          handler: proxy.handler,
        })) ?? null
      if (this.loginPlane !== null) this.loginProxy = proxy
    } catch (err) {
      this.ctx.logger.warn(
        'Alexa: login proxy failed to serve — interactive sign-in is unavailable',
        {
          meta: { error: errMsg(err) },
        },
      )
    }
  }

  protected override async onShutdown(): Promise<void> {
    this.speak?.stop()
    this.speak = null
    alexaEchoSessions.clear()
    alexaCommands.clear()
    try {
      await this.proxyLogin?.dispose()
      await this.deviceCodeLogin?.dispose()
    } catch (err) {
      this.ctx.logger.warn('Alexa: proxy-login dispose error', { meta: { error: errMsg(err) } })
    }
    this.proxyLogin = null
    this.deviceCodeLogin = null
    await this.loginPlane?.dispose().catch(() => undefined)
    this.loginPlane = null
    this.loginProxy = null
    try {
      await this.registry?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Alexa: addon shutdown error', { meta: { error: errMsg(err) } })
    }
    alexaAccounts.clear()
    this.registry = null
    await super.onShutdown()
  }

  /** One broker = one account; the appliance id distinguishes devices within it. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const brokerId = String(config?.['brokerId'] ?? 'unknown')
    const serial = config?.['serial']
    if (typeof serial === 'string') return `alexa:${brokerId}:echo:${serial}`
    const applianceId = String(config?.['applianceId'] ?? 'unknown')
    return `alexa:${brokerId}:${applianceId}`
  }

  // ── additive cap reconcile ─────────────────────────────────────────────

  /**
   * Re-derive every adopted Alexa device's `capabilities[]` from the live
   * appliance inventory. When the cap set changed, re-persist it via the generic
   * `applyDerivedSpec`. Best-effort; never throws.
   */
  private async reconcileAppliances(
    brokerId: string,
    appliances: readonly AlexaAppliance[],
  ): Promise<void> {
    try {
      const reg = this.ctx.kernel.deviceRegistry
      const devices = this.ctx.kernel.devices
      if (!reg || !devices) return
      const byId = new Map<string, AlexaAppliance>()
      for (const a of appliances) byId.set(a.applianceId, a)

      for (const d of reg.getAllForAddon(this.addonId)) {
        if (d.parentDeviceId !== null) continue
        const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
        if (cfg['system'] !== 'alexa' || cfg['brokerId'] !== brokerId) continue
        const appliance = byId.get(String(cfg['applianceId']))
        if (appliance === undefined) continue

        const nextCaps = mapAlexaCapabilitiesToCamStack(appliance.interfaces).capabilities
        const current = Array.isArray(cfg['capabilities']) ? cfg['capabilities'] : []
        if (capsEqual(current, nextCaps)) continue

        await devices.applyDerivedSpec(d.id, { config: { capabilities: [...nextCaps] } })
        this.ctx.logger.info('Alexa: device capabilities reconciled', {
          meta: { brokerId, deviceId: d.id, capCount: nextCaps.length },
        })
      }
    } catch (err) {
      this.ctx.logger.warn('Alexa: appliance reconcile failed', {
        meta: { brokerId, error: errMsg(err) },
      })
    }
  }

  /** Emit polled state values on the bus as `broker.message` events. */
  private emitStateValues(brokerId: string, values: readonly AlexaStateValue[]): void {
    for (const value of values) {
      const event = createEvent(
        EventCategory.BrokerMessage,
        { type: 'addon', id: this.ctx.id },
        {
          brokerId,
          subscriptionId: '',
          key: value.applianceId,
          payload: {
            interfaceName: value.interfaceName,
            property: value.property,
            value: value.value,
          },
        },
      )
      this.ctx.eventBus.emit(event)
    }
  }

  // ── broker cap provider ────────────────────────────────────────────────

  private buildBrokerProvider(): IBrokerProvider {
    return buildAlexaBrokerProvider({
      registry: this.requireRegistry(),
      getBrokers: () => this.activeBrokers,
    })
  }

  /**
   * Persist a cookie captured by the interactive proxy-login onto a broker. With
   * a `brokerId` the broker is RE-LINKED (credentials swapped, devices kept);
   * otherwise a NEW broker is created. The captured cookie goes into exactly the
   * same `connection.cookie` field a pasted cookie would — so the registry /
   * poll / adoption layers are unchanged.
   */
  private async commitCapturedCookie(input: {
    readonly cookie: string
    readonly amazonDomain: string
    readonly name: string
    readonly brokerId?: string
  }): Promise<{ readonly brokerId: string }> {
    const reg = this.requireRegistry()

    if (input.brokerId !== undefined) {
      const existing = this.activeBrokers.find((b) => b.id === input.brokerId)
      if (existing === undefined) {
        throw new Error(`commitCookie: unknown broker "${input.brokerId}"`)
      }
      const connection: AlexaConnection = {
        ...existing.connection,
        amazonDomain: input.amazonDomain,
        cookie: input.cookie,
      }
      const updated = await reg.updateEntry(input.brokerId, connection)
      await this.persistBrokerEntries(
        this.activeBrokers.map((b) => (b.id === input.brokerId ? updated : b)),
      )
      this.ctx.logger.info('Alexa: proxy-login cookie committed to existing broker', {
        meta: { brokerId: input.brokerId },
      })
      return { brokerId: input.brokerId }
    }

    const connection = settingsToAlexaConnection({
      amazonDomain: input.amazonDomain,
      cookie: input.cookie,
    })
    const entry = await reg.createEntry(input.name, connection)
    await this.persistBrokerEntries([...this.activeBrokers, entry])
    this.ctx.logger.info('Alexa: proxy-login cookie committed to new broker', {
      meta: { brokerId: entry.id, name: input.name },
    })
    return { brokerId: entry.id }
  }

  /** Who still points at an Alexa account: its integrations and the Echo targets that speak through it. */
  private brokerUsers(): readonly InstanceUserFinder[] {
    return [
      linkUserFinder(this.requireInstances(), 'brokerId'),
      {
        find: async (brokerId) =>
          (this.echoStore === null ? [] : (await this.echoStore.list()).map(echoRowOf))
            .filter((target) => target.brokerId === brokerId)
            .map((target) => ({
              kind: 'notification-target',
              id: target.id,
              name: target.name,
            })),
      },
    ]
  }

  private async cascadeRemoveDevicesForBroker(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForBroker({
      reg,
      devices,
      addonId: this.addonId,
      brokerId,
      logger: this.ctx.logger,
    })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildAlexaAdoptionProvider({
      registry: {
        getAppliancesForBroker: (id) => alexaAccounts.getAppliances(id),
        list: () =>
          this.requireRegistry()
            .list()
            .map((b) => ({ id: b.id, name: b.name })),
        has: (id) => this.requireRegistry().get(id) !== null,
        getEchoesForBroker: (id) => this.speak?.echoFor(id)?.devices ?? [],
      },
      logger: this.ctx.logger,
      getBrokerIdForIntegration: async (id) => {
        const brokerId = await linkedIdOf(this.requireInstances(), id, 'brokerId')
        if (brokerId === undefined) throw new Error(`integration ${id} has no broker`)
        return brokerId
      },
      listAdoptedAlexa: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d.parentDeviceId !== null) continue
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptAppliance: async ({ brokerId, appliance, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('alexa adopt: kernel.devices unavailable')
        const mapping = mapAlexaCapabilitiesToCamStack(appliance.interfaces)
        const config = {
          applianceId: appliance.applianceId,
          brokerId,
          capabilities: [...mapping.capabilities],
          system: 'alexa',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(mapping.deviceType, config)
        const device = await devices.create(stableId, AlexaDevice, config, null, {
          type: mapping.deviceType,
          name,
          integrationId,
        })
        return { deviceId: device.id }
      },
      adoptEcho: async ({ brokerId, echo, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('alexa adopt: kernel.devices unavailable')
        const config = {
          brokerId,
          serial: echo.id,
          deviceType: echo.deviceType,
          system: 'alexa',
          integrationId,
          name,
        }
        const device = await devices.create(
          this.generateStableId(DeviceType.MediaPlayer, config),
          AlexaEchoDevice,
          config,
          null,
          { type: DeviceType.MediaPlayer, name, integrationId },
        )
        return { deviceId: device.id }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
    })
  }

  // ── Instance form ──────────────────────────────────────────────────────

  /** The connection form a record carries; the values live on the record, never in `addon-settings`. */
  protected override async integrationFormSchema(
    _instance: IntegrationInstanceRef,
  ): Promise<ConfigUISchema | null> {
    return buildConnectionFormSchema()
  }

  // ── Manual creation: not supported (appliances are imported + adopted) ──

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('Alexa devices are imported + adopted, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setBrokerDevicesOnline(brokerId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setBrokerDevicesOnline(devices, brokerId, online)
    if (n > 0) {
      this.ctx.logger.info('Alexa: broker devices ' + (online ? 'online' : 'offline'), {
        meta: { brokerId, count: n },
      })
    }
  }

  private requireRegistry(): AlexaBrokerRegistry {
    if (!this.registry) throw new Error('Alexa import addon not initialised')
    return this.registry
  }
}

/** Structural equality of two persisted cap lists (order-independent). */
function capsEqual(a: readonly unknown[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const aSet = new Set<string>()
  for (const entry of a) {
    if (typeof entry === 'string') aSet.add(entry)
  }
  for (const cap of b) {
    if (!aSet.has(cap)) return false
  }
  return true
}
