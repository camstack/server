import type { CoverDevice } from '@apocaliss92/noderademacher'
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
import { rademacherActions } from './custom-actions.js'
import { RademacherCoverDevice } from './devices/rademacher-cover-device.js'
import { RademacherGatewayDevice } from './devices/rademacher-gateway-device.js'
import { buildRademacherAdoptionProvider } from './rademacher-adoption-provider.js'
import type { AdoptableCover } from './rademacher-discovery.js'
import { RademacherClientRegistry } from './rademacher-client-registry.js'
import { buildRademacherConnectionTestProvider } from './rademacher-connection-test.js'
import { cascadeRemoveDevicesForIntegration } from './rademacher-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './rademacher-integration-offline.js'
import {
  browseRademacherHubs,
  proposeRademacherHubs,
  type RademacherDiscoveredHub,
  rademacherDiscoveryCandidates,
  rademacherDiscoverySummary,
} from './rademacher-hub-discovery.js'
import { rademacherSessions } from './rademacher-session-resolver.js'

/**
 * Rademacher HomePilot / Start2Smart — `mode: account`, one integration per hub.
 *
 * The integration holds the connection (host, optional keychain password, base
 * path, poll interval) and owns one live session per enabled integration.
 * Adoption offers the hub box ({@link DeviceType.Gateway}) and one cover per
 * roller shutter; none of them is a child of the gateway. The session is the
 * `noderademacher` client behind {@link RademacherIntegrationManager}: HomePilot
 * has no push channel, so it is polled, with a bounded-backoff reconnect.
 */
export class RademacherProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-rademacher'
  protected readonly providerName = 'Rademacher'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: RademacherGatewayDevice,
    [DeviceType.Cover]: RademacherCoverDevice,
  }

  private clients: RademacherClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof rademacherActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    this.clients = new RademacherClientRegistry(this.ctx.logger)
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
      customActions: rademacherActions,
      actionHandlers: {
        discoverHub: async () => {
          const { proposals, summary } = await this.discoverHubs()
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
      this.ctx.logger.warn('Rademacher: shutdown error', { meta: { error: errMsg(err) } })
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

  /**
   * LAN scan for HomePilot / Start2Smart hubs: the library's HTTP probe over the
   * local /24 networks of this (hub-only) addon's host.
   */
  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async discoverDevices(): Promise<readonly DiscoveryCandidate[]> {
    const { proposals } = await this.discoverHubs()
    return rademacherDiscoveryCandidates(proposals).map((candidate) => ({
      stableId: candidate.stableId,
      type: DeviceType.Gateway,
      suggestedName: candidate.suggestedName,
      prefilledConfig: { ...candidate.prefilledConfig },
    }))
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw new Error('A Rademacher hub is added from the integration form')
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('Rademacher devices are adopted from the integration, not created manually')
  }

  /** Every top-level Rademacher device is keyed on its adoption native id, which carries the integration. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const nativeId = config?.['nativeId']
    if (typeof nativeId !== 'string' || nativeId.length === 0) {
      throw new Error('provider-rademacher generateStableId: nativeId required')
    }
    return `rademacher:${nativeId}`
  }

  private async discoverHubs(): Promise<{
    readonly proposals: readonly RademacherDiscoveredHub[]
    readonly summary: string
  }> {
    let found: readonly RademacherDiscoveredHub[] = []
    try {
      found = await browseRademacherHubs()
    } catch (err) {
      this.ctx.logger.warn('Rademacher hub discovery failed', { meta: { error: errMsg(err) } })
    }
    const proposals = proposeRademacherHubs(found, await this.knownHubHosts())
    if (found.length > proposals.length) {
      this.ctx.logger.info('Rademacher discovery skipped hubs already added', {
        meta: { found: found.length, proposed: proposals.length },
      })
    }
    return { proposals, summary: rademacherDiscoverySummary(found.length, proposals.length) }
  }

  private async knownHubHosts(): Promise<readonly string[]> {
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
          this.ctx.logger.warn('Rademacher discovery: settings read failed', {
            tags: { integrationId: integration.id },
            meta: { error: errMsg(err) },
          })
        }
      }
      return hosts
    } catch (err) {
      this.ctx.logger.warn('Rademacher discovery: integration list failed', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  private requireClients(): RademacherClientRegistry {
    if (!this.clients) throw new Error('Rademacher provider not initialised')
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
            this.ctx.logger.warn(
              'Rademacher reconcile: host missing or invalid, no session opened',
              {
                tags: { integrationId: integration.id },
              },
            )
            continue
          }
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Rademacher reconcile: settings read failed', {
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
      this.ctx.logger.warn('Rademacher integration reconcile failed', {
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
    return buildRademacherConnectionTestProvider({ logger: this.ctx.logger })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildRademacherAdoptionProvider({
      logger: this.ctx.logger,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) =>
        this.requireClients().getName(integrationId) ?? 'Rademacher HomePilot',
      isOnline: (integrationId) =>
        rademacherSessions.getManager(integrationId)?.status === 'connected',
      hubModel: (integrationId) =>
        rademacherSessions.getManager(integrationId)?.identity?.model ?? null,
      coversOf: (integrationId) =>
        rademacherSessions.getCovers(integrationId).map(toAdoptableCover),
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
        if (!devices) throw new Error('rademacher adopt: kernel.devices unavailable')
        const base = { integrationId, system: 'rademacher' as const, nativeId }
        const stableId = this.generateStableId(DeviceType.Cover, base)
        const meta = { name, integrationId }
        if (resolved.kind === 'gateway') {
          const device = await devices.create(stableId, RademacherGatewayDevice, base, null, {
            ...meta,
            type: DeviceType.Gateway,
          })
          return { deviceId: device.id }
        }
        const config = {
          ...base,
          did: resolved.cover.did,
          invertPosition: false,
          supportsPosition: resolved.cover.supportsPosition,
          supportsTilt: resolved.cover.supportsTilt,
        }
        const device = await devices.create(stableId, RademacherCoverDevice, config, null, {
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

/** Project a live library cover handle onto what adoption needs. */
function toAdoptableCover(handle: CoverDevice): AdoptableCover {
  return {
    did: handle.did,
    name: handle.name,
    model: handle.model,
    online: handle.online,
    supportsPosition: handle.supportsPosition,
    supportsTilt: handle.supportsTilt,
  }
}
