import {
  type AddonDataPlaneHandle,
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  connectionTestCapability,
  integrationInstancesCapability,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
  VENDOR_LOGIN_PROXY_PREFIX,
  VendorLoginProxy,
  rowsDepsOver,
} from '@camstack/types'
import { cascadeRemoveDevicesForIntegration } from '../shared/account-integration-cascade.js'
import { setIntegrationDevicesOnline } from '../shared/account-integration-offline.js'
import { homeComActions } from './custom-actions.js'
import { finishHomeComSignIn, homeComSignInAttempts } from './homecom-sign-in.js'
import { beginHomeComProxiedSignIn, homeComSignInClaims } from './homecom-sign-in-proxy.js'
import {
  buildHomeComGatewayPersister,
  buildHomeComTokenPersister,
} from './homecom-token-persist.js'
import { buildHomeComAdoptionProvider } from './homecom-adoption-provider.js'
import { HomeComClientRegistry } from './homecom-client-registry.js'
import { buildHomeComConnectionTestProvider } from './homecom-connection-test.js'
import {
  buildHomeComInstances,
  HOMECOM_MIGRATIONS,
  type HomeComInstances,
  homeComConnectionOf,
  homeComRecordKinds,
  homeComRowsPorts,
  homeComStoredOf,
} from './homecom-instances.js'
import { homeComConnections } from './homecom-gateway.js'
import { HomeComClimateDevice } from './devices/homecom-climate-device.js'
import { HomeComWaterHeaterDevice } from './devices/homecom-water-heater-device.js'

export class BoschHomeComProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'bosch-homecom'
  protected readonly providerName = 'Bosch HomeCom'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Climate]: HomeComClimateDevice,
    [DeviceType.WaterHeater]: HomeComWaterHeaterDevice,
  }

  private clients: HomeComClientRegistry | null = null
  private instances: HomeComInstances | null = null
  private loginProxy: VendorLoginProxy | null = null
  private loginPlane: AddonDataPlaneHandle | null = null

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
    await this.runMigrations(HOMECOM_MIGRATIONS, (api) =>
      homeComRowsPorts({ ...rowsDepsOver(api) }),
    )
    const built = buildHomeComInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      tester: this.buildConnectionTestProvider(),
    })
    this.instances = built
    await this.serveLoginProxy()
    const persistDeps = {
      read: (id: string) => homeComStoredOf(built.instances, id),
      patch: (id: string, patch: Record<string, unknown>) => built.handle.patch(id, patch),
      logger: this.ctx.logger,
    }
    const persistTokens = buildHomeComTokenPersister(persistDeps)
    const persistGateway = buildHomeComGatewayPersister(persistDeps)
    this.clients = new HomeComClientRegistry(this.ctx.logger, {
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
    return {
      providers: [
        ...regs,
        {
          capability: deviceAdoptionCapability,
          provider: this.buildAdoptionProvider(),
        },
        {
          capability: connectionTestCapability,
          provider: this.buildConnectionTestProvider(),
        },
        { capability: integrationInstancesCapability, provider: built.provider },
      ],
      customActions: homeComActions,
      actionHandlers: {
        beginSignIn: async () => ({
          ...beginHomeComProxiedSignIn({ proxy: this.loginProxy, addonId: this.ctx.id }),
          summary: 'Open the sign-in page and sign in.',
        }),
        claimSignIn: async (input) => {
          const claim = homeComSignInClaims.claim(input.attemptId, Date.now())
          return claim.state === 'pending' ? { pending: true } : { pending: false, ...claim.result }
        },
        finishSignIn: async (input) =>
          finishHomeComSignIn(
            { attemptId: input.attemptId, callback: input.callback, nowMs: Date.now() },
            homeComSignInAttempts,
          ),
        signOut: async () => ({ signedOut: true as const, summary: 'Signed out.' }),
      },
    }
  }

  /** The hub's HTTPS face for the vendor's login pages (D955): admin session only. */
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
      this.ctx.logger.warn('HomeCom login proxy failed to serve — sign-in falls back to paste', {
        meta: { error: errMsg(err) },
      })
    }
  }

  protected override async onShutdown(): Promise<void> {
    await this.loginPlane?.dispose().catch(() => undefined)
    this.loginPlane = null
    this.loginProxy = null
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
    return `homecom:${integrationId}:${nativeId}`
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
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  private buildConnectionTestProvider(): IConnectionTestProvider {
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
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptDevice: async ({ nativeId, integrationId, type, name, kind, circuitId }) => {
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
        const device = await devices.create(stableId, DeviceClass, config, null, {
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
