import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  connectionTestCapability,
  type DeviceConstructor,
  type DeviceSummary,
  DeviceType,
  type DiscoveryCandidate,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
} from '@camstack/types'
import { buildConnectionFormSchema, connectionFromSettings } from './config.js'
import { veluxActions } from './custom-actions.js'
import { VeluxCoverDevice } from './devices/velux-cover-device.js'
import { VeluxGatewayDevice } from './devices/velux-gateway-device.js'
import { VeluxRainSensorDevice } from './devices/velux-rain-sensor-device.js'
import { VeluxWindowDevice } from './devices/velux-window-device.js'
import { setKlfLibraryLogSink } from './klf-library-log.js'
import { buildVeluxAdoptionProvider } from './velux-adoption-provider.js'
import { VeluxClientRegistry } from './velux-client-registry.js'
import { buildVeluxConnectionTestProvider } from './velux-connection-test.js'
import { cascadeRemoveDevicesForIntegration } from './velux-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './velux-integration-offline.js'
import {
  browseVeluxGateways,
  proposeVeluxGateways,
  type VeluxDiscoveredGateway,
  veluxDiscoveryCandidates,
  veluxDiscoverySummary,
} from './velux-gateway-discovery.js'
import { veluxGateways } from './velux-node-resolver.js'

/**
 * Velux KLF-200 — `mode: account`, one integration per gateway.
 *
 * The integration holds the connection (host + keychain password) and owns one
 * live session per enabled integration. Adoption offers the gateway box
 * ({@link DeviceType.Gateway}), a container per window with a rain sensor and a
 * plain cover per other product; none of them is a child of the gateway. The
 * session is the `klf-200-api` library behind `KlfGatewayClient`: one TLS socket
 * per gateway, node changes PUSHED by the gateway, a keepalive and a
 * bounded-backoff reconnect (the gateway accepts two sessions in total).
 */
export class VeluxProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-velux'
  protected readonly providerName = 'Velux'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: VeluxGatewayDevice,
    [DeviceType.Container]: VeluxWindowDevice,
    [DeviceType.Cover]: VeluxCoverDevice,
    [DeviceType.Sensor]: VeluxRainSensorDevice,
  }

  private clients: VeluxClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof veluxActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    // The library writes its own diagnostics to the console; keep them on our logger.
    setKlfLibraryLogSink((level, message) => {
      this.ctx.logger.debug(`klf-200-api ${level}: ${message}`)
    })

    this.clients = new VeluxClientRegistry(this.ctx.logger)
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
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
        { capability: connectionTestCapability, provider: this.buildConnectionTestProvider() },
      ],
      customActions: veluxActions,
      actionHandlers: {
        discoverGateway: async () => {
          const { proposals, summary } = await this.discoverGateways()
          return {
            hosts: proposals.map((found) => ({ host: found.host, name: found.name, id: found.id })),
            summary,
          }
        },
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Velux: shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    setKlfLibraryLogSink(null)
    await super.onShutdown()
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  /**
   * LAN mDNS probe for a KLF-200. This addon is hub-only, so the socket is the
   * hub's. The probe asks for a unicast reply and does not bind 5353.
   */
  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async discoverDevices(): Promise<readonly DiscoveryCandidate[]> {
    const { proposals } = await this.discoverGateways()
    return veluxDiscoveryCandidates(proposals).map((candidate) => ({
      stableId: candidate.stableId,
      type: DeviceType.Gateway,
      suggestedName: candidate.suggestedName,
      prefilledConfig: { ...candidate.prefilledConfig },
    }))
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw new Error('A Velux gateway is added from the integration form')
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('Velux devices are adopted from the integration, not created manually')
  }

  /** Every top-level Velux device is keyed on its adoption native id, which carries the integration. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const nativeId = config?.['nativeId']
    if (typeof nativeId !== 'string' || nativeId.length === 0) {
      throw new Error('provider-velux generateStableId: nativeId required')
    }
    return `velux:${nativeId}`
  }

  private async discoverGateways(): Promise<{
    readonly proposals: readonly VeluxDiscoveredGateway[]
    readonly summary: string
  }> {
    let found: readonly VeluxDiscoveredGateway[] = []
    try {
      found = await browseVeluxGateways()
    } catch (err) {
      this.ctx.logger.warn('Velux gateway discovery failed', { meta: { error: errMsg(err) } })
    }
    const proposals = proposeVeluxGateways(found, await this.knownGatewayHosts())
    if (found.length > proposals.length) {
      this.ctx.logger.info('Velux discovery skipped gateways already added', {
        meta: { found: found.length, proposed: proposals.length },
      })
    }
    return { proposals, summary: veluxDiscoverySummary(found.length, proposals.length) }
  }

  private async knownGatewayHosts(): Promise<readonly string[]> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const hosts: string[] = []
      for (const integration of all) {
        if (integration.addonId !== this.ctx.id) continue
        try {
          const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
          const connection = connectionFromSettings(settings)
          if (connection) hosts.push(connection.host)
        } catch (err) {
          this.ctx.logger.warn('Velux discovery: settings read failed', {
            tags: { integrationId: integration.id },
            meta: { error: errMsg(err) },
          })
        }
      }
      return hosts
    } catch (err) {
      this.ctx.logger.warn('Velux discovery: integration list failed', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  private requireClients(): VeluxClientRegistry {
    if (!this.clients) throw new Error('Velux provider not initialised')
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
          const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
          const connection = connectionFromSettings(settings)
          if (!connection) {
            this.ctx.logger.warn('Velux reconcile: host or password missing, no session opened', {
              tags: { integrationId: integration.id },
            })
            continue
          }
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Velux reconcile: settings read failed', {
            tags: { integrationId: integration.id },
            meta: { error: errMsg(err) },
          })
        }
      }
      const vanished = reg.list().filter((id) => !surviving.has(id))
      await reg.retain(surviving)
      for (const integrationId of vanished) {
        await this.cascadeRemoveDevicesForIntegration(integrationId)
      }
    } catch (err) {
      this.ctx.logger.warn('Velux integration reconcile failed', {
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
    return buildVeluxConnectionTestProvider({
      logger: this.ctx.logger,
      liveSessions: (host) => this.clients?.liveSessions(host) ?? 0,
    })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildVeluxAdoptionProvider({
      logger: this.ctx.logger,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) =>
        this.requireClients().getName(integrationId) ?? 'Velux KLF-200',
      isOnline: (integrationId) => veluxGateways.getManager(integrationId)?.status === 'connected',
      nodesOf: (integrationId) => veluxGateways.getNodes(integrationId),
      listAdopted: async () => {
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
      adoptDevice: async ({ integrationId, nativeId, resolved, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('velux adopt: kernel.devices unavailable')
        const base = { integrationId, system: 'velux' as const, nativeId }
        const stableId = this.generateStableId(DeviceType.Cover, base)
        const meta = { name, integrationId }
        if (resolved.kind === 'gateway') {
          const device = await devices.create(stableId, VeluxGatewayDevice, base, null, {
            ...meta,
            type: DeviceType.Gateway,
          })
          return { deviceId: device.id }
        }
        const node = {
          ...base,
          nodeId: resolved.node.nodeId,
          serial: resolved.node.serial,
          coverClass: resolved.node.coverClass,
        }
        if (resolved.kind === 'window') {
          const device = await devices.create(stableId, VeluxWindowDevice, node, null, {
            ...meta,
            type: DeviceType.Container,
          })
          return { deviceId: device.id }
        }
        const device = await devices.create(stableId, VeluxCoverDevice, node, null, {
          ...meta,
          type: DeviceType.Cover,
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

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
  }
}
