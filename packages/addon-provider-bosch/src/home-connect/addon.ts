import {
  type AddonDataPlaneHandle,
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  connectionTestCapability,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SavedDevice,
  type SystemEvent,
  VendorLoginProxy,
} from '@camstack/types'
import { homeConnectActions } from './custom-actions.js'
import { trackHomeConnectContainers } from './home-connect-container-tracker.js'
import { finishHomeConnectSignIn, homeConnectSignInAttempts } from './home-connect-login.js'
import { homeConnectFinishResult } from './home-connect-sign-in-result.js'
import {
  beginHomeConnectProxiedSignIn,
  HOME_CONNECT_PROXY_PREFIX,
  homeConnectSignInClaims,
} from './home-connect-sign-in-proxy.js'
import { cascadeRemoveDevicesForIntegration } from '../shared/account-integration-cascade.js'
import { setIntegrationDevicesOnline } from '../shared/account-integration-offline.js'
import { buildHomeConnectAdoptionProvider } from './home-connect-adoption-provider.js'
import { HomeConnectClientRegistry } from './home-connect-client-registry.js'
import { buildHomeConnectConnectionTestProvider } from './home-connect-connection-test.js'
import {
  appliancesWithoutCredential,
  buildHomeConnectFormSchema,
  connectionFromSettings,
  logHomeConnectSettingsGap,
  type HomeConnectConfig,
} from './config.js'
import { buildHomeConnectConnectionPersister } from './home-connect-connection-persist.js'
import { homeConnectConnections } from './home-connect-gateway.js'
import { HomeConnectApplianceDevice } from './devices/home-connect-appliance-device.js'
import { HomeConnectDishwasherDevice } from './devices/home-connect-dishwasher-device.js'
import { HomeConnectEventDevice } from './devices/home-connect-event-device.js'
import { HomeConnectSensorDevice } from './devices/home-connect-sensor-device.js'
import { deriveChildBindings } from './home-connect-child-bindings.js'
import {
  HomeConnectChildReconciler,
  persistedChildBindingsFromConfig,
} from './home-connect-child-reconciler.js'
import {
  planLegacyApplianceSecretAdopt,
  type SecretAdoptPlan,
} from './home-connect-secret-adopt.js'

export class BoschHomeConnectProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'bosch-home-connect'
  protected readonly providerName = 'Bosch Home Connect'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: HomeConnectApplianceDevice,
    [DeviceType.Dishwasher]: HomeConnectDishwasherDevice,
    [DeviceType.Sensor]: HomeConnectSensorDevice,
    [DeviceType.EventEmitter]: HomeConnectEventDevice,
  }

  private clients: HomeConnectClientRegistry | null = null
  private reconciler: HomeConnectChildReconciler | null = null
  private loginProxy: VendorLoginProxy | null = null
  private loginPlane: AddonDataPlaneHandle | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof homeConnectActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    await this.serveLoginProxy()
    this.clients = new HomeConnectClientRegistry(this.ctx.logger, {
      onConnectionUpdated: (integrationId, connection) => {
        void this.persistIntegrationAppliances(integrationId, connection)
      },
    })
    this.clients.setOnConnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, true)
      void this.trackAppliances('connected')
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })
    this.reconciler = this.buildChildReconciler()
    await this.reconcileIntegrations()
    await this.trackAppliances('init')
    this.subscribeIntegrationLifecycle()
    return {
      providers: [
        ...regs,
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
        { capability: connectionTestCapability, provider: this.buildConnectionTestProvider() },
      ],
      customActions: homeConnectActions,
      actionHandlers: {
        beginSignIn: async () => ({
          ...beginHomeConnectProxiedSignIn({
            proxy: this.loginProxy,
            addonId: this.ctx.id,
          }),
          summary: 'Open the sign-in page and sign in.',
        }),
        finishSignIn: async (input) =>
          homeConnectFinishResult(
            await finishHomeConnectSignIn(
              { attemptId: input.attemptId, callback: input.callback, nowMs: Date.now() },
              homeConnectSignInAttempts,
            ),
          ),
        claimSignIn: async (input) => {
          const claim = homeConnectSignInClaims.claim(input.attemptId, Date.now())
          return claim.state === 'pending' ? { pending: true } : { pending: false, ...claim.result }
        },
        signOut: async () => ({ signedOut: true as const, summary: 'Signed out.' }),
      },
    }
  }

  /** The hub's HTTPS face for the vendor's login pages (D955): admin session only. */
  private async serveLoginProxy(): Promise<void> {
    const proxy = new VendorLoginProxy({
      addonId: this.ctx.id,
      prefix: HOME_CONNECT_PROXY_PREFIX,
      logger: this.ctx.logger,
    })
    try {
      this.loginPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: HOME_CONNECT_PROXY_PREFIX,
          access: 'admin',
          handler: proxy.handler,
        })) ?? null
      if (this.loginPlane !== null) this.loginProxy = proxy
    } catch (err) {
      this.ctx.logger.warn(
        'Home Connect login proxy failed to serve — sign-in falls back to paste',
        {
          meta: { error: errMsg(err) },
        },
      )
    }
  }

  protected override async onShutdown(): Promise<void> {
    await this.loginPlane?.dispose().catch(() => undefined)
    this.loginPlane = null
    this.loginProxy = null
    this.reconciler?.stop()
    this.reconciler = null
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Home Connect shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    await super.onShutdown()
  }

  private requireClients(): HomeConnectClientRegistry {
    if (!this.clients) throw new Error('Home Connect provider not initialised')
    return this.clients
  }

  protected override generateStableId(type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['brokerId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('home-connect generateStableId: brokerId required')
    }
    const haId = config?.['haId']
    if (typeof haId !== 'string' || haId.length === 0) {
      throw new Error('home-connect generateStableId: haId required')
    }
    // Container appliance root — distinct from the legacy flat Dishwasher
    // stableId (`home-connect:…:haId`) so a tombstoned flat adopt cannot
    // fence the Container re-adopt of the same haId.
    if (type === DeviceType.Container) {
      return `home-connect:${integrationId}:${haId}:appliance`
    }
    return `home-connect:${integrationId}:${haId}`
  }

  /** Enriched IDDF maps and a rotated token pair, in one keychain-aware write. */
  private persistIntegrationAppliances(
    integrationId: string,
    connection: HomeConnectConfig,
  ): Promise<void> {
    return buildHomeConnectConnectionPersister({
      getSettings: (id) => this.ctx.api.integrations.getSettings.query({ id }),
      setSettings: (input) => this.ctx.api.integrations.setSettings.mutate(input),
      logger: this.ctx.logger,
    })(integrationId, connection)
  }

  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const surviving = new Set<string>()
      const secretMoves: SecretAdoptPlan[] = []
      for (const integration of mine) {
        try {
          const stored = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
          const adopt = planLegacyApplianceSecretAdopt(
            {
              setSettings: (input) => this.ctx.api.integrations.setSettings.mutate(input),
              logger: this.ctx.logger,
            },
            integration.id,
            stored,
          )
          if (adopt !== null) secretMoves.push(adopt)
          const settings = adopt?.settings ?? stored
          const connection = connectionFromSettings(settings)
          if (!connection) {
            logHomeConnectSettingsGap(this.ctx.logger, integration.id, settings)
            continue
          }
          for (const haId of appliancesWithoutCredential(settings)) {
            this.ctx.logger.warn(
              'Home Connect appliance has no usable pairing key — cannot connect to it',
              {
                tags: { integrationId: integration.id },
                meta: { haId },
              },
            )
          }
          await reg.upsert(integration.id, integration.name, connection)
          const brokerInfo = reg.getInfo(integration.id)
          const applianceCount =
            typeof brokerInfo?.info['applianceCount'] === 'number'
              ? brokerInfo.info['applianceCount']
              : 0
          this.ctx.logger.info('Home Connect integration reconciled', {
            meta: {
              integrationId: integration.id,
              applianceCount,
            },
          })
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Home Connect reconcile failed for integration', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
      // Written last and not awaited: the hub restarts this addon after a settings write, and
      // this boot already connects with the keys it read.
      for (const move of secretMoves) void move.persist()
      const vanished = reg.list().filter((id) => !surviving.has(id))
      await reg.retain(surviving)
      const deviceReg = this.ctx.kernel.deviceRegistry
      const deviceApi = this.ctx.kernel.devices
      if (deviceReg && deviceApi) {
        for (const integrationId of vanished) {
          await cascadeRemoveDevicesForIntegration({
            reg: deviceReg,
            devices: deviceApi,
            addonId: this.addonId,
            system: 'home-connect',
            integrationId,
            logger: this.ctx.logger,
          })
        }
      }
    } catch (err) {
      this.ctx.logger.warn('Home Connect integration reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrations()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildHomeConnectConnectionTestProvider({ logger: this.ctx.logger })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildHomeConnectAdoptionProvider({
      registry: homeConnectConnections,
      hasIntegration: (id) => this.requireClients().has(id),
      listIntegrations: () => this.requireClients().list(),
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptDevice: async ({ haId, integrationId, type, name, applianceType }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('home-connect adopt: devices unavailable')
        if (type !== DeviceType.Container) {
          throw new Error(`home-connect adopt: expected Container, got ${type}`)
        }
        const config = {
          haId,
          brokerId: integrationId,
          applianceType,
          // The entities the appliance declares, when it is connected already; otherwise the
          // reconciler fills them in as soon as its description and values are known.
          entities: this.initialEntities(integrationId, haId),
          system: 'home-connect',
          integrationId,
        }
        const stableId = this.generateStableId(type, config)
        const device = await devices.create(stableId, HomeConnectApplianceDevice, config, null, {
          type: DeviceType.Container,
          name,
          integrationId,
        })
        void this.trackAppliances('adopt')
        return { deviceId: device.id }
      },
      removeDevice: async (id) => {
        this.reconciler?.untrack(id)
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
      logger: this.ctx.logger,
    })
  }

  private initialEntities(integrationId: string, haId: string) {
    const client = homeConnectConnections.getClient(integrationId)
    const description = client?.getDescription(haId) ?? null
    if (client === null || description === null || description.state === 'missing') return []
    return [...deriveChildBindings({ description, features: client.getFeatures(haId) })]
  }

  private buildChildReconciler(): HomeConnectChildReconciler {
    const devices = () => {
      const api = this.ctx.kernel.devices
      if (!api) throw new Error('home-connect: devices unavailable')
      return api
    }
    return new HomeConnectChildReconciler({
      watch: (integrationId, haId, listener) =>
        homeConnectConnections.watch(integrationId, haId, listener),
      getClient: (integrationId) => homeConnectConnections.getClient(integrationId),
      readPersisted: async (deviceId) => {
        return persistedChildBindingsFromConfig(await devices().loadConfig(deviceId))
      },
      applyEntities: (deviceId, entities) =>
        devices().applyDerivedSpec(deviceId, { config: { entities: [...entities] } }),
      logger: this.ctx.logger,
    })
  }

  /**
   * The runner restores devices only AFTER `onInitialize` returned, so the init pass of
   * {@link trackAppliances} sees none: watch the restored containers here, or a description
   * that loads later never derives their children.
   */
  override async restoreDevices(savedDevices: readonly SavedDevice[]): Promise<void> {
    await super.restoreDevices(savedDevices)
    await this.trackAppliances('restore')
  }

  /** Keep a reconciler watch on every adopted appliance container. */
  private async trackAppliances(trigger: string): Promise<void> {
    const devices = this.ctx.kernel.devices
    const reconciler = this.reconciler
    if (!reconciler) return
    await trackHomeConnectContainers(
      {
        listDevices: () => devices.getAll(),
        loadConfig: (id) => devices.loadConfig(id),
        reconciler,
        logger: this.ctx.logger,
      },
      trigger,
    )
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildHomeConnectFormSchema()
  }

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
    throw new Error('Home Connect devices are adopted from the gateway')
  }

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    setIntegrationDevicesOnline(
      reg.getAllForAddon(this.addonId),
      'home-connect',
      integrationId,
      online,
    )
  }
}
