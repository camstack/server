import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  integrationInstancesCapability,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionProbe,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SavedDevice,
  type SystemEvent,
  rowsDepsOver,
} from '@dominevo/types'
import { homeConnectActions } from './custom-actions.js'
import { trackHomeConnectContainers } from './home-connect-container-tracker.js'
import {
  finishHomeConnectSignIn,
  homeConnectSignInAttempts,
  publishHomeConnectSignIn,
} from './home-connect-login.js'
import { homeConnectFinishResult } from './home-connect-sign-in-result.js'
import { signOutHomeConnectInstance } from './home-connect-account.js'
import { reconcileHomeConnectIntegrations } from './home-connect-reconcile.js'
import { cascadeRemoveDevicesForIntegration } from '../shared/account-integration-cascade.js'
import { setIntegrationDevicesOnline } from '../shared/account-integration-offline.js'
import { buildHomeConnectAdoptionProvider } from './home-connect-adoption-provider.js'
import { HomeConnectClientRegistry } from './home-connect-client-registry.js'
import { buildHomeConnectConnectionTestProvider } from './home-connect-connection-test.js'
import type { HomeConnectConfig } from './config.js'
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
  buildHomeConnectInstances,
  HOME_CONNECT_MIGRATIONS,
  type HomeConnectInstances,
  homeConnectRecordKinds,
  homeConnectRowsPorts,
  homeConnectStoredOf,
  homeConnectConnectionsEntryKind,
} from './home-connect-instances.js'

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
  private instances: HomeConnectInstances | null = null
  private reconciler: HomeConnectChildReconciler | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof homeConnectActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('bosch-home-connect: ctx.records is required (hub-only addon)')
    await records.declare(homeConnectRecordKinds)
    // Before the provider registers: while it is registered the hub answers from the record.
    this.declareRegistrySwitch({
      kind: homeConnectConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    await this.runMigrations(HOME_CONNECT_MIGRATIONS, (api) =>
      homeConnectRowsPorts({ ...rowsDepsOver(api) }),
    )
    const built = buildHomeConnectInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      tester: this.buildConnectionTestProvider(),
    })
    this.instances = built
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
        {
          capability: deviceAdoptionCapability,
          provider: this.buildAdoptionProvider(),
        },
        {
          capability: integrationInstancesCapability,
          provider: built.provider,
        },
      ],
      customActions: homeConnectActions,
      actionHandlers: {
        beginSignIn: async () => ({
          ...publishHomeConnectSignIn(homeConnectSignInAttempts, Date.now()),
          summary: 'Open the sign-in page, sign in, then paste the address the browser stops on.',
        }),
        finishSignIn: async (input) =>
          homeConnectFinishResult(
            await finishHomeConnectSignIn(
              {
                attemptId: input.attemptId,
                callback: input.callback,
                nowMs: Date.now(),
              },
              homeConnectSignInAttempts,
            ),
          ),
        signOut: async (input) => {
          const integrationId = input.integrationId
          if (integrationId === undefined) {
            // A form that has no record yet: nothing is stored, the form clears its own fields.
            return { signedOut: true as const, summary: 'Signed out.' }
          }
          const stored = await homeConnectStoredOf(built.instances, integrationId)
          if (stored === null) {
            throw new Error(`Home Connect integration ${integrationId} does not exist`)
          }
          await signOutHomeConnectInstance(integrationId, built.instances)
          this.ctx.logger.info('Home Connect signed out — stored sign-in cleared', {
            tags: { integrationId },
          })
          return {
            signedOut: true as const,
            summary: 'Signed out. The appliances stay offline until you sign in again.',
          }
        },
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    this.reconciler?.stop()
    this.reconciler = null
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Home Connect shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.instances = null
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
      read: (id) => homeConnectStoredOf(this.requireInstances().instances, id),
      patch: (id, patch) => this.requireInstances().handle.patch(id, patch),
      logger: this.ctx.logger,
    })(integrationId, connection)
  }

  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      await reconcileHomeConnectIntegrations({
        listEnabled: async () => {
          const all = await this.ctx.api.integrations.list.query()
          return all.filter((i) => i.addonId === this.ctx.id && i.enabled)
        },
        knownIds: () => this.knownIntegrationIds(),
        storedOf: (id) => homeConnectStoredOf(this.requireInstances().instances, id),
        registry: reg,
        onSignedOut: (id) => this.setIntegrationDevicesOnline(id, false),
        onVanished: (id) => this.dropIntegrationDevices(id),
        logger: this.ctx.logger,
      })
    } catch (err) {
      this.ctx.logger.warn('Home Connect integration reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Every integration this addon holds a record or a top-level device for. */
  private async knownIntegrationIds(): Promise<readonly string[]> {
    const ids = new Set<string>()
    for (const row of await this.requireInstances().instances.listResolved()) ids.add(row.id)
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (reg && devices) {
      for (const d of reg.getAllForAddon(this.addonId)) {
        if (d.parentDeviceId !== null) continue
        const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
        const brokerId = cfg['brokerId']
        if (cfg['system'] === 'home-connect' && typeof brokerId === 'string') ids.add(brokerId)
      }
    }
    return [...ids]
  }

  /** The integration is gone: its devices go with it. */
  private async dropIntegrationDevices(integrationId: string): Promise<void> {
    const deviceReg = this.ctx.kernel.deviceRegistry
    const deviceApi = this.ctx.kernel.devices
    if (!deviceReg || !deviceApi) return
    await cascadeRemoveDevicesForIntegration({
      reg: deviceReg,
      devices: deviceApi,
      addonId: this.addonId,
      system: 'home-connect',
      integrationId,
      logger: this.ctx.logger,
    })
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrations()
    }
    this.requireInstances().instances.onSwitched(() => {
      void this.reconcileIntegrations()
    })
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  private buildConnectionTestProvider(): IConnectionProbe {
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
    return [
      ...deriveChildBindings({
        description,
        features: client.getFeatures(haId),
      }),
    ]
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
        devices().applyDerivedSpec(deviceId, {
          config: { entities: [...entities] },
        }),
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

  private requireInstances(): HomeConnectInstances {
    if (!this.instances) throw new Error('Home Connect provider not initialised')
    return this.instances
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
