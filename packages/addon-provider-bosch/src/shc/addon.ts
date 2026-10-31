import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  connectionTestCapability,
  type DeviceConstructor,
  type DeviceSummary,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
} from '@camstack/types'
import { boschShcActions } from './custom-actions.js'
import { buildConnectionFormSchema, connectionFromSettings } from './config.js'
import { registerShcClient } from './shc-register.js'
import {
  proposeShcControllers,
  resolveShcPairingHost,
  SHC_DISCOVERY_MODES,
  shcDiscoveryCandidates,
  shcDiscoverySummary,
  shcHostsFromHits,
} from './shc-controller-discovery.js'
import { ShcGatewayDevice } from './devices/shc-gateway-device.js'
import { ShcClimateRoomDevice } from './devices/shc-climate-room-device.js'
import { ShcRoomClimateDevice } from './devices/shc-room-climate-device.js'
import { ShcSwitchDevice } from './devices/shc-switch-device.js'
import { ShcTrvDevice } from './devices/shc-trv-device.js'
import { buildShcAdoptionProvider } from './shc-adoption-provider.js'
import { ShcClientRegistry } from './shc-client-registry.js'
import { buildShcConnectionTestProvider } from './shc-connection-test.js'
import { shcConnections } from './shc-gateway.js'
import { cascadeRemoveDevicesForIntegration } from './shc-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './shc-integration-offline.js'
import { classifyShcDevice } from './shc-domain-mapping.js'
import { shcClimateEntityName } from './shc-discovery.js'

/**
 * Bosch Smart Home Controller — `mode: account`, broker-less multi-integration.
 */
export class BoschShcProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'bosch-shc'
  protected readonly providerName = 'Bosch SHC'

  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: ShcGatewayDevice,
    [DeviceType.Container]: ShcClimateRoomDevice,
    [DeviceType.Climate]: ShcRoomClimateDevice,
    [DeviceType.Thermostat]: ShcTrvDevice,
    [DeviceType.Switch]: ShcSwitchDevice,
  }

  private clients: ShcClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof boschShcActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    this.clients = new ShcClientRegistry(this.ctx.logger)
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
      ],
      customActions: boschShcActions,
      actionHandlers: {
        discoverController: async () => {
          const { candidates } = await this.ctx.api.deviceManager.discoverProvider.mutate({
            addonId: this.ctx.id,
          })
          const hosts = candidates.map((candidate) => ({
            host: String(candidate.prefilledConfig['host'] ?? ''),
            name: candidate.suggestedName,
            id: candidate.stableId.replace(/^bosch-shc:/, ''),
          }))
          return {
            hosts,
            summary: shcDiscoverySummary(hosts.length, hosts.length),
          }
        },
        registerClient: async (input) => {
          const host = resolveShcPairingHost({
            host: input.host,
            hostManual: input.hostManual,
          })
          const { sslCertificate, sslKey, token } = await registerShcClient({
            host,
            systemPassword: input.systemPassword,
          })
          return {
            sslCertificate,
            sslKey,
            token,
            summary: 'CamStack is registered with your Smart Home Controller.',
          }
        },
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Bosch SHC: shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    await super.onShutdown()
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  /** A controller is found by the scan engine's mDNS browse; this addon only classifies the hits. */
  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return SHC_DISCOVERY_MODES
  }

  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const found = shcHostsFromHits(input.hits)
    const proposals = proposeShcControllers(found, await this.knownControllerHosts())
    if (found.length > proposals.length) {
      this.ctx.logger.info('SHC discovery skipped controllers already added', {
        meta: { found: found.length, proposed: proposals.length },
      })
    }
    return shcDiscoveryCandidates(proposals)
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw new Error('Bosch SHC controllers are paired from the integration form')
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('Bosch SHC devices are adopted from the controller, not created manually')
  }

  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['brokerId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('bosch-shc generateStableId: brokerId required')
    }
    const shcDeviceId = config?.['shcDeviceId']
    if (typeof shcDeviceId !== 'string' || shcDeviceId.length === 0) {
      throw new Error('bosch-shc generateStableId: shcDeviceId required')
    }
    return `bosch-shc:${integrationId}:${shcDeviceId}`
  }

  private async knownControllerHosts(): Promise<readonly string[]> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const hosts: string[] = []
      for (const integration of all) {
        if (integration.addonId !== this.ctx.id) continue
        try {
          const settings = await this.ctx.api.integrations.getSettings.query({
            id: integration.id,
          })
          const connection = connectionFromSettings(settings)
          if (connection) hosts.push(connection.host)
        } catch (err) {
          this.ctx.logger.warn('SHC discovery: settings read failed', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
      return hosts
    } catch (err) {
      this.ctx.logger.warn('SHC discovery: integration list failed', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  private requireClients(): ShcClientRegistry {
    if (!this.clients) throw new Error('Bosch SHC provider not initialised')
    return this.clients
  }

  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const surviving = new Set<string>()
      for (const integration of mine) {
        try {
          const settings = await this.ctx.api.integrations.getSettings.query({
            id: integration.id,
          })
          const connection = connectionFromSettings(settings)
          if (!connection) continue
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Bosch SHC reconcile: settings read failed', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
      const vanished = reg.list().filter((id) => !surviving.has(id))
      await reg.retain(surviving)
      for (const integrationId of vanished) {
        await this.cascadeRemoveDevicesForIntegration(integrationId)
      }
    } catch (err) {
      this.ctx.logger.warn('Bosch SHC integration reconcile failed', {
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

  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForIntegration({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      logger: this.ctx.logger,
    })
  }

  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildShcConnectionTestProvider({ logger: this.ctx.logger })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildShcAdoptionProvider({
      registry: shcConnections,
      logger: this.ctx.logger,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) => this.requireClients().nameOf(integrationId),
      listAdoptedShc: async () => {
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
      adoptDevice: async ({ shcDeviceId, integrationId, name, type, deviceModel }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('bosch-shc adopt: kernel.devices unavailable')
        const summary = shcConnections.devices(integrationId).find((d) => d.id === shcDeviceId)
        const kind =
          type === DeviceType.Gateway
            ? 'gateway'
            : summary
              ? classifyShcDevice(summary)
              : 'unsupported'
        if (kind === 'unsupported') {
          throw new Error(`bosch-shc adopt: unsupported device ${shcDeviceId}`)
        }
        if (type === DeviceType.Gateway) {
          const config = {
            shcDeviceId,
            brokerId: integrationId,
            deviceModel,
            system: 'bosch-shc' as const,
            integrationId,
            name,
          }
          const stableId = this.generateStableId(DeviceType.Gateway, config)
          const meta = { type: DeviceType.Gateway, name, integrationId }
          const device = await devices.create(stableId, ShcGatewayDevice, config, null, meta)
          return { deviceId: device.id }
        }
        const baseConfig = {
          shcDeviceId,
          brokerId: integrationId,
          deviceModel,
          system: 'bosch-shc' as const,
          integrationId,
          name,
        }
        if (kind === 'room-climate') {
          const allDevices = shcConnections.devices(integrationId)
          const summary = allDevices.find((d) => d.id === shcDeviceId)
          const children: {
            shcDeviceId: string
            name: string
            role: 'climate' | 'trv'
          }[] = [{ shcDeviceId, name: shcClimateEntityName(name), role: 'climate' }]
          for (const trvId of summary?.childDeviceIds ?? []) {
            const trv = allDevices.find((d) => d.id === trvId)
            if (trv === undefined || classifyShcDevice(trv) !== 'trv') continue
            children.push({
              shcDeviceId: trvId,
              name: trv.name.length > 0 ? trv.name : trvId,
              role: 'trv',
            })
          }
          const config = { ...baseConfig, children }
          const stableId = this.generateStableId(DeviceType.Container, config)
          const meta = { type: DeviceType.Container, name, integrationId }
          const device = await devices.create(stableId, ShcClimateRoomDevice, config, null, meta)
          return { deviceId: device.id }
        }
        const config = baseConfig
        const stableId = this.generateStableId(type, config)
        const meta = { type, name, integrationId }
        const device =
          kind === 'switch'
            ? await devices.create(stableId, ShcSwitchDevice, config, null, meta)
            : await devices.create(stableId, ShcTrvDevice, config, null, meta)
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

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
  }
}
