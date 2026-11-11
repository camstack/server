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
} from '@camstack/types'
import { cascadeRemoveDevicesForIntegration } from '../shared/account-integration-cascade.js'
import { setIntegrationDevicesOnline } from '../shared/account-integration-offline.js'
import { homeComActions } from './custom-actions.js'
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
    this.clients = new HomeComClientRegistry(this.ctx.logger, {
      ...(bridge !== null ? { bridge } : {}),
      onTokensRotated: (integrationId, tokens) => persistTokens(integrationId, tokens),
      onGatewayChosen: (integrationId, gatewayId) => void persistGateway(integrationId, gatewayId),
    })
    this.clients.setOnConnected((integrationId) => {
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
        finishSignIn: async (input) =>
          finishHomeComSignIn(
            {
              attemptId: input.attemptId,
              callback: input.callback,
              nowMs: Date.now(),
            },
            homeComSignInAttempts,
          ),
        signOut: async () => ({
          signedOut: true as const,
          summary: 'Signed out.',
        }),
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

  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const surviving = new Set<string>()
      for (const integration of mine) {
        try {
          const connection = await homeComConnectionOf(
            this.requireInstances().instances,
            integration.id,
          )
          if (!connection) continue
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('HomeCom reconcile failed for integration', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
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
            system: 'homecom',
            integrationId,
            logger: this.ctx.logger,
          })
        }
      }
    } catch (err) {
      this.ctx.logger.warn('HomeCom integration reconcile failed', {
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
