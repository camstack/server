import {
  addonPagesSourceCapability,
  addonRoutesCapability,
  BaseDeviceProvider,
  brokerCapability,
  buildAddonRouteProvider,
  createEvent,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  EventCategory,
  type AddonInitResult,
  type AddonPageDeclaration,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type IAddonPageProvider,
  type IBrokerProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  notificationOutputCapability,
  type SystemEvent,
  SECRET_CLEAR,
} from '@camstack/types'
import {
  alexaProxyLoginSchema,
  settingsToAlexaConnection,
  type AlexaAddonConfig,
  type AlexaConnection,
} from './config.js'
import { AlexaProxyLoginManager } from './alexa-proxy-login-manager.js'
import { buildAlexaLoginRoutes } from './alexa-login-routes.js'
import { AlexaBrokerRegistry } from './alexa-broker-registry.js'
import { sameConnection } from './alexa-integration-manager.js'
import { buildAlexaBrokerProvider } from './alexa-broker-provider.js'
import { buildAlexaAdoptionProvider } from './alexa-adoption-provider.js'
import { cascadeRemoveDevicesForBroker } from './alexa-broker-device-cascade.js'
import { setBrokerDevicesOnline, type OfflineTarget } from './alexa-broker-offline.js'
import { alexaAccounts, alexaCommands } from './alexa-gateway.js'
import type { AlexaAppliance, AlexaStateValue } from './alexa-client.js'
import { mapAlexaCapabilitiesToCamStack } from './alexa-domain-mapping.js'
import { AlexaDevice } from './devices/alexa-device.js'
import { alexaRecordKinds } from './broker-record-kinds.js'
import { AlexaBrokerStore } from './alexa-broker-store.js'
import type { AlexaBrokerEntry } from './config.js'
import { alexaSpeakActions } from './speak/actions.js'
import { readBrokerSeed } from './speak/broker-seed.js'
import { AlexaSpeakController } from './speak/controller.js'
import { speakIconRoutes } from './speak/icon-routes.js'
import { RecordsSpeakSessionStore } from './speak/session-store.js'

export { alexaSpeakActions as customActions } from './speak/actions.js'

const SPEAK_PAGE: AddonPageDeclaration = {
  id: 'speak',
  label: 'Speak on Echo',
  icon: 'megaphone',
  path: '/addon/import-alexa',
  remoteName: 'addon_import_alexa_page',
  bundle: 'remoteEntry.js',
  section: 'administration',
}

/** Default config — a fresh install starts with no accounts. */
const DEFAULTS: AlexaAddonConfig = {
  brokers: [],
  proxyLogin: { proxyHost: '', proxyPort: 3456 },
  speak: { email: '', password: '', region: 'EU', session: '', targets: [] },
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
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> =
    Object.fromEntries(ALEXA_DEVICE_TYPES.map((t) => [t, AlexaDevice]))

  private registry: AlexaBrokerRegistry | null = null
  private proxyLogin: AlexaProxyLoginManager | null = null
  private brokerStore: AlexaBrokerStore | null = null
  private activeBrokers: readonly AlexaBrokerEntry[] = []
  private speak: AlexaSpeakController | null = null

  protected override readonly secretStatePaths = ['speak.password', 'speak.session']

  constructor() {
    super({ ...DEFAULTS })
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof alexaSpeakActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('import-alexa: ctx.records is required (hub-only addon)')
    }
    await records.declare(alexaRecordKinds)
    this.brokerStore = AlexaBrokerStore.of(records)
    this.activeBrokers = await this.loadPersistedBrokers()

    this.registry = new AlexaBrokerRegistry(this.ctx.logger, {
      dataDir: this.ctx.dataDir,
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

    // Interactive Amazon login (alexa-remote2 proxy auth mode), driven by the
    // onboarding wizard through the addon-routes control plane below.
    this.proxyLogin = new AlexaProxyLoginManager({
      logger: this.ctx.logger,
      getProxyConfig: () => {
        const cfg = alexaProxyLoginSchema.parse(this.config.proxyLogin ?? {})
        return { proxyHost: cfg.proxyHost, proxyPort: cfg.proxyPort }
      },
    })

    this.ctx.logger.info('Alexa: import addon initialised', {
      meta: { brokerCount: this.activeBrokers.length },
    })

    await this.reconcileIntegrationsToBrokers()
    this.subscribeIntegrationLifecycle()

    const loginRoutes = [
      ...buildAlexaLoginRoutes({
        logger: this.ctx.logger,
        proxyLogin: this.proxyLogin,
        commitCookie: (input) => this.commitCapturedCookie(input),
      }),
      ...speakIconRoutes(),
    ]

    const speak = new AlexaSpeakController({
      logger: this.ctx.logger.child('speak'),
      readConfig: () => this.config,
      writeSpeak: async (next) => {
        await this.updateGlobalSettings({ speak: next })
      },
      listBrokers: () =>
        this.activeBrokers.map((entry) => ({
          id: entry.id,
          name: entry.name,
          amazonDomain: entry.connection.amazonDomain,
        })),
      readSeed: async (brokerId) => {
        const entry = this.activeBrokers.find((row) => row.id === brokerId)
        return entry === undefined ? null : readBrokerSeed(this.ctx.dataDir, entry)
      },
      sessions: RecordsSpeakSessionStore.of(records),
      clearLegacySecrets: async () => {
        // Nested secrets clear in place; `clearSecrets` only reaches top-level keys,
        // and clearing `speak` would take the targets with it.
        await this.updateGlobalSettingsAsOperator({
          speak: { ...this.config.speak, password: SECRET_CLEAR, session: SECRET_CLEAR },
        })
      },
      ensurePython: () => this.ctx.deps.ensurePython(),
    })
    this.speak = speak
    // Not awaited: initialize() is on the capability-graph critical path.
    void speak.start().catch((err: unknown) => {
      this.ctx.logger.warn('alexa speak: worker did not start', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    })

    const pages: IAddonPageProvider = {
      id: this.addonId,
      listPages: () => [SPEAK_PAGE],
    }

    return {
      providers: [
        ...regs,
        { capability: brokerCapability, provider: this.buildBrokerProvider() },
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
        {
          capability: addonRoutesCapability,
          provider: buildAddonRouteProvider('import-alexa', loginRoutes),
        },
        { capability: notificationOutputCapability, provider: speak.provider },
        { capability: addonPagesSourceCapability, provider: pages },
      ],
      customActions: alexaSpeakActions,
      actionHandlers: speak.handlers(),
    }
  }

  private async loadPersistedBrokers(): Promise<readonly AlexaBrokerEntry[]> {
    const store = this.brokerStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.brokers
  }

  private async persistBrokerEntries(entries: readonly AlexaBrokerEntry[]): Promise<void> {
    this.activeBrokers = [...entries]
    const store = this.brokerStore
    if (store !== null) {
      await store.replaceAll(entries)
    } else {
      await this.updateGlobalSettings({ brokers: [...entries] })
    }
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

  protected override async onShutdown(): Promise<void> {
    this.speak?.stop()
    this.speak = null
    alexaCommands.clear()
    try {
      await this.proxyLogin?.dispose()
    } catch (err) {
      this.ctx.logger.warn('Alexa: proxy-login dispose error', { meta: { error: errMsg(err) } })
    }
    this.proxyLogin = null
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
      ownerAddonId: this.ctx.id,
      registry: this.requireRegistry(),
      getBrokers: () => this.activeBrokers,
      persistBrokers: (brokers) => this.persistBrokerEntries(brokers),
      cascadeRemoveDevices: (brokerId) => this.cascadeRemoveDevicesForBroker(brokerId),
      logger: this.ctx.logger,
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

  // ── integration → broker reconcile (Approach A) ────────────────────────

  private async reconcileIntegrationsToBrokers(): Promise<void> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id)
      const surviving = new Set(mine.map((i) => i.id))

      for (const integration of mine) {
        const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
        const brokerId = typeof settings['brokerId'] === 'string' ? settings['brokerId'] : undefined
        if (brokerId === undefined) continue
        if (!this.activeBrokers.some((b) => b.id === brokerId)) {
          this.ctx.logger.warn('Alexa integration→broker: linked broker not found', {
            meta: { integrationId: integration.id, brokerId },
          })
          continue
        }
        this.requireRegistry().linkIntegration(integration.id, brokerId)
      }

      const toRemove = this.activeBrokers
        .filter((b) => b.integrationId !== undefined && !surviving.has(b.integrationId))
        .map((b) => b.id)
      if (toRemove.length === 0) return

      for (const id of toRemove) {
        try {
          await this.requireRegistry().removeEntry(id)
          await this.cascadeRemoveDevicesForBroker(id)
        } catch (err) {
          this.ctx.logger.warn('Alexa integration→broker: broker cleanup failed', {
            meta: { brokerId: id, error: errMsg(err) },
          })
        }
      }
      const nextBrokers = this.activeBrokers.filter((b) => !toRemove.includes(b.id))
      await this.persistBrokerEntries(nextBrokers)
    } catch (err) {
      this.ctx.logger.warn('Alexa integration→broker reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrationsToBrokers()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
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
      },
      logger: this.ctx.logger,
      getBrokerIdForIntegration: async (id) => {
        const settings = await this.ctx.api.integrations.getSettings.query({ id })
        const brokerId = settings['brokerId']
        if (typeof brokerId !== 'string') {
          throw new Error(`integration ${id} has no linked brokerId`)
        }
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

  // ── Settings UI (informational only) ───────────────────────────────────

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'alexa-account',
          title: 'Amazon Alexa account',
          titleKey: 'import-alexa:globalSettings.s_alexa-account.title',
          description: 'Alexa accounts are managed in the External systems → Brokers tab.',
          descriptionKey: 'import-alexa:globalSettings.s_alexa-account.description',
          columns: 1,
          fields: [
            {
              type: 'info' as const,
              key: 'accountHelp',
              label: 'Accounts are managed separately',
              labelKey: 'import-alexa:globalSettings.s_alexa-account.accountHelp.label',
              content:
                'This integration links to an Amazon Alexa account broker. Add, edit, or remove ' +
                'accounts from External systems → Brokers, then adopt the imported devices. The ' +
                'integration only stores a reference to its broker. NOTE: this is an unofficial ' +
                'integration that Amazon can change or break without notice.',
            },
          ],
        },
        {
          id: 'alexa-proxy-login',
          title: 'Interactive login (proxy)',
          titleKey: 'import-alexa:globalSettings.s_alexa-proxy-login.title',
          description:
            'The "Login to Amazon" button in onboarding opens a local proxy that captures the ' +
            'cookie after you complete the real Amazon login (incl. 2FA). Because Amazon URLs are ' +
            'rewritten to this exact host:port, it must be a directly-reachable address — leave ' +
            'the host blank to auto-detect the server IP, and make sure the port is reachable from ' +
            'the browser you log in from.',
          descriptionKey: 'import-alexa:globalSettings.s_alexa-proxy-login.description',
          columns: 2,
          fields: [
            {
              type: 'text' as const,
              key: 'proxyLogin.proxyHost',
              label: 'Login proxy host/IP (blank = auto-detect)',
              labelKey:
                'import-alexa:globalSettings.s_alexa-proxy-login.proxyLogin_proxyHost.label',
              placeholder: 'auto-detect',
            },
            {
              type: 'number' as const,
              key: 'proxyLogin.proxyPort',
              label: 'Login proxy port',
              labelKey:
                'import-alexa:globalSettings.s_alexa-proxy-login.proxyLogin_proxyPort.label',
              min: 1,
              max: 65535,
              default: 3456,
            },
          ],
        },
      ],
    })
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
