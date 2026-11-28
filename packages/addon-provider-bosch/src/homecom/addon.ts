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
  type SystemEvent,
  rowsDepsOver,
} from '@dominevo/types'
import { cascadeRemoveDevicesForIntegration } from '../shared/account-integration-cascade.js'
import { setIntegrationDevicesOnline } from '../shared/account-integration-offline.js'
import { homeComActions } from './custom-actions.js'
import {
  signOutHomeComInstance,
  storedSignInResult,
  storeHomeComSignIn,
} from './homecom-account.js'
import { reconcileHomeComIntegrations } from './homecom-reconcile.js'
import { createHomeComSessionAlert, type HomeComSessionAlert } from './homecom-session-alert.js'
import { createHomeComExploreAction, homeComExploreDeps } from './homecom-explore-action.js'
import {
  finishHomeComSignIn,
  homeComSignInAttempts,
  publishHomeComSignIn,
} from './homecom-sign-in.js'
import {
  buildHomeComGatewayPersister,
  buildHomeComTokenPersister,
} from './homecom-token-persist.js'
import { buildHomeComAdoptionProvider } from './homecom-adoption-provider.js'
import { HomeComClientRegistry } from './homecom-client-registry.js'
import { createHomeComBridge, type HomeComBridge } from './homecom-bridge.js'
import { resolveHomeComWorker } from './homecom-python-paths.js'
import { buildHomeComConnectionTestProvider } from './homecom-connection-test.js'
import {
  buildHomeComInstances,
  HOMECOM_MIGRATIONS,
  type HomeComInstances,
  homeComConnectionOf,
  homeComRecordKinds,
  homeComRowsPorts,
  homeComStoredOf,
  homeComConnectionsEntryKind,
} from './homecom-instances.js'
import { homeComConnections, homeComStableId } from './homecom-gateway.js'
import { HomeComClimateDevice } from './devices/homecom-climate-device.js'
import { HomeComWaterHeaterDevice } from './devices/homecom-water-heater-device.js'
import { HomeComGatewayDevice } from './devices/homecom-gateway-device.js'
import { HomeComHeatPumpDevice } from './devices/homecom-heat-pump-device.js'

export class BoschHomeComProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'bosch-homecom'
  protected readonly providerName = 'Bosch HomeCom'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Climate]: HomeComClimateDevice,
    [DeviceType.WaterHeater]: HomeComWaterHeaterDevice,
    [DeviceType.HeatPump]: HomeComHeatPumpDevice,
    [DeviceType.Gateway]: HomeComGatewayDevice,
  }

  private clients: HomeComClientRegistry | null = null
  private instances: HomeComInstances | null = null
  private sessionAlert: HomeComSessionAlert | null = null
  private readonly integrationNames = new Map<string, string>()

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof homeComActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('bosch-homecom: ctx.records is required (hub-only addon)')
    await records.declare(homeComRecordKinds)
    // Before the provider registers: while it is registered the hub answers from the record.
    this.declareRegistrySwitch({
      kind: homeComConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    await this.runMigrations(HOMECOM_MIGRATIONS, (api) =>
      homeComRowsPorts({ ...rowsDepsOver(api) }),
    )
    const built = buildHomeComInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      tester: this.buildConnectionTestProvider(),
    })
    this.instances = built
    const persistDeps = {
      read: (id: string) => homeComStoredOf(built.instances, id),
      patch: (id: string, patch: Record<string, unknown>) => built.handle.patch(id, patch),
      logger: this.ctx.logger,
    }
    const persistTokens = buildHomeComTokenPersister(persistDeps)
    const persistGateway = buildHomeComGatewayPersister(persistDeps)
    const bridge = await this.createBridge()
    const sessionAlert = createHomeComSessionAlert({
      logger: this.ctx.logger,
      getAlerts: () => this.ctx.api.alerts,
      nameOf: (id) => this.integrationNames.get(id) ?? id,
      addonId: this.addonId,
    })
    this.sessionAlert = sessionAlert
    this.clients = new HomeComClientRegistry(this.ctx.logger, {
      onAuthFailed: (integrationId) => sessionAlert.authFailed(integrationId),
      ...(bridge !== null ? { bridge } : {}),
      onTokensRotated: (integrationId, tokens) => persistTokens(integrationId, tokens),
      onGatewayChosen: (integrationId, gatewayId) => void persistGateway(integrationId, gatewayId),
    })
    this.clients.setOnConnected((integrationId) => {
      void sessionAlert.connected(integrationId)
      this.setIntegrationDevicesOnline(integrationId, true)
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()
    const explore = createHomeComExploreAction(
      homeComExploreDeps({
        registry: this.clients,
        connections: homeComConnections,
        logger: this.ctx.logger,
      }),
    )
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
      customActions: homeComActions,
      actionHandlers: {
        beginSignIn: async () => ({
          ...publishHomeComSignIn(homeComSignInAttempts, Date.now()),
          summary: 'Open the sign-in page, sign in, then paste the address the browser stops on.',
        }),
        finishSignIn: async (input) => {
          const finished = await finishHomeComSignIn(
            {
              attemptId: input.attemptId,
              callback: input.callback,
              nowMs: Date.now(),
            },
            homeComSignInAttempts,
          )
          const integrationId = input.integrationId
          if (integrationId === undefined) return finished
          await this.storeSignIn(integrationId, () =>
            storeHomeComSignIn(integrationId, finished, built.instances),
          )
          return storedSignInResult(integrationId, finished, built.handle)
        },
        signOut: async (input) => {
          const integrationId = input.integrationId
          if (integrationId === undefined) {
            // A form that has no record yet: nothing is stored, the form clears its own fields.
            return { signedOut: true as const, summary: 'Signed out.' }
          }
          await this.storeSignIn(integrationId, () =>
            signOutHomeComInstance(integrationId, built.instances),
          )
          this.ctx.logger.info('HomeCom signed out — stored sign-in cleared', {
            tags: { integrationId },
          })
          return {
            signedOut: true as const,
            summary: 'Signed out. The devices stay offline until you sign in again.',
          }
        },
        exploreResources: explore,
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('HomeCom shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.instances = null
    this.sessionAlert?.dispose()
    this.sessionAlert = null
    await super.onShutdown()
  }

  /** The `homecom_alt` bridge on the embedded Python; null leaves k40/k30/icom on plain reads. */
  private async createBridge(): Promise<HomeComBridge | null> {
    try {
      const pythonPath = await this.ctx.deps.ensurePython()
      if (pythonPath === null) {
        this.ctx.logger.warn('HomeCom: embedded Python is unavailable, the heat pump is not read')
        return null
      }
      return createHomeComBridge({
        pythonPath,
        scriptPath: resolveHomeComWorker(),
      })
    } catch (err) {
      this.ctx.logger.warn('HomeCom: the Python bridge could not be prepared', {
        meta: { error: errMsg(err) },
      })
      return null
    }
  }

  private requireClients(): HomeComClientRegistry {
    if (!this.clients) throw new Error('HomeCom provider not initialised')
    return this.clients
  }

  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['brokerId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('homecom generateStableId: brokerId required')
    }
    const nativeId = config?.['nativeId']
    if (typeof nativeId !== 'string' || nativeId.length === 0) {
      throw new Error('homecom generateStableId: nativeId required')
    }
    return homeComStableId(integrationId, nativeId)
  }

  /** Write a sign-in change on an instance that exists; a missing one is refused by name. */
  private async storeSignIn(integrationId: string, write: () => Promise<void>): Promise<void> {
    const stored = await homeComStoredOf(this.requireInstances().instances, integrationId)
    if (stored === null) {
      throw new Error(`HomeCom integration ${integrationId} does not exist`)
    }
    await write()
  }

  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      await reconcileHomeComIntegrations({
        listEnabled: async () => {
          const all = await this.ctx.api.integrations.list.query()
          return all.filter((i) => i.addonId === this.ctx.id && i.enabled)
        },
        knownIds: () => this.knownIntegrationIds(),
        connectionOf: (id) => homeComConnectionOf(this.requireInstances().instances, id),
        registry: reg,
        onNamed: (id, name) => this.integrationNames.set(id, name),
        onSignedOut: (id) => this.setIntegrationDevicesOnline(id, false),
        onVanished: (id) => this.dropIntegration(id),
        logger: this.ctx.logger,
      })
    } catch (err) {
      this.ctx.logger.warn('HomeCom integration reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Every integration this addon holds a record or a top-level device for. */
  private async knownIntegrationIds(): Promise<readonly string[]> {
    // A signed-out integration may hold only a session alert: its name entry keeps it known.
    const ids = new Set<string>(this.integrationNames.keys())
    for (const row of await this.requireInstances().instances.listResolved()) ids.add(row.id)
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (reg && devices) {
      for (const d of reg.getAllForAddon(this.addonId)) {
        if (d.parentDeviceId !== null) continue
        const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
        const brokerId = cfg['brokerId']
        if (cfg['system'] === 'homecom' && typeof brokerId === 'string') ids.add(brokerId)
      }
    }
    return [...ids]
  }

  /** The integration is gone: its alert and its devices go with it. */
  private async dropIntegration(integrationId: string): Promise<void> {
    this.integrationNames.delete(integrationId)
    void this.sessionAlert?.removed(integrationId)
    const deviceReg = this.ctx.kernel.deviceRegistry
    const deviceApi = this.ctx.kernel.devices
    if (!deviceReg || !deviceApi) return
    await cascadeRemoveDevicesForIntegration({
      reg: deviceReg,
      devices: deviceApi,
      addonId: this.addonId,
      system: 'homecom',
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
    return buildHomeComConnectionTestProvider({ logger: this.ctx.logger })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildHomeComAdoptionProvider({
      registry: homeComConnections,
      hasIntegration: (id) => this.requireClients().has(id),
      listIntegrations: () => this.requireClients().list(),
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices) return []
        const out: {
          id: number
          stableId: string
          parentDeviceId: number | null
          config: Record<string, unknown>
        }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({
            id: d.id,
            stableId: d.stableId,
            parentDeviceId: d.parentDeviceId,
            config,
          })
        }
        return out
      },
      adoptDevice: async ({
        nativeId,
        integrationId,
        type,
        name,
        kind,
        circuitId,
        parentDeviceId,
      }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('homecom adopt: devices unavailable')
        const config: Record<string, unknown> = {
          nativeId,
          brokerId: integrationId,
          system: 'homecom',
          integrationId,
          name,
        }
        if (kind === 'heating-circuit' && circuitId) {
          config['circuitId'] = circuitId
        }
        // A zone child names its zone in its own key, so it never reads as a heating circuit.
        if (kind === 'zone' && circuitId) {
          config['zoneId'] = circuitId
        }
        const stableId = this.generateStableId(type, config)
        const DeviceClass = this.deviceClasses[type]
        if (!DeviceClass) throw new Error(`homecom adopt: unsupported type ${type}`)
        const device = await devices.create(stableId, DeviceClass, config, parentDeviceId, {
          type,
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
      logger: this.ctx.logger,
    })
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
    throw new Error('HomeCom devices are adopted from the cloud')
  }

  private requireInstances(): HomeComInstances {
    if (!this.instances) throw new Error('HomeCom provider not initialised')
    return this.instances
  }

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), 'homecom', integrationId, online)
  }
}
