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
  type DiscoveryHit,
  type DiscoveryMode,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
  collectOwnerIntegrationIds,
} from '@camstack/types'
import { VeluxReconciler, type IntegrationLifecycleKind } from './velux-reconciler.js'
import { buildConnectionFormSchema, connectionFromSettings } from './config.js'
import { veluxActions } from './custom-actions.js'
import { VeluxCoverDevice } from './devices/velux-cover-device.js'
import { VeluxGatewayDevice } from './devices/velux-gateway-device.js'
import { VeluxRainSensorDevice } from './devices/velux-rain-sensor-device.js'
import { VeluxWindowDevice } from './devices/velux-window-device.js'
import { setKlfLibraryLogSink } from './klf-library-log.js'
import { buildVeluxAdoptionProvider } from './velux-adoption-provider.js'
import { gatewayNativeId } from './velux-discovery.js'
import { VeluxClientRegistry } from './velux-client-registry.js'
import type { PowerCycleStore, PowerSourcePort } from './velux-power-recovery.js'
import { buildVeluxConnectionTestProvider } from './velux-connection-test.js'
import { cascadeRemoveDevicesForIntegration } from './velux-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './velux-integration-offline.js'
import {
  proposeVeluxGateways,
  VELUX_DISCOVERY_MODES,
  veluxDiscoveryCandidates,
  veluxDiscoverySummary,
  veluxGatewaysFromHits,
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

  private integrationReconciler: VeluxReconciler | null = null
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

    this.clients = new VeluxClientRegistry(this.ctx.logger, {
      powerSource: this.buildPowerSourcePort(),
      powerCycleStore: this.buildPowerCycleStore(),
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
      ],
      customActions: veluxActions,
      actionHandlers: {
        discoverGateway: async () => {
          const startedAt = Date.now()
          const { candidates } = await this.ctx.api.deviceManager.discoverProvider.mutate({
            addonId: this.ctx.id,
          })
          // An empty scan is a result, not silence: the mDNS browse completed and heard no KLF-200.
          this.ctx.logger.info('Velux gateway scan finished', {
            meta: { found: candidates.length, ms: Date.now() - startedAt },
          })
          const hosts = candidates.map((candidate) => ({
            host: String(candidate.prefilledConfig['host'] ?? ''),
            name: candidate.suggestedName,
            id: candidate.stableId.replace(/^velux:/, ''),
          }))
          return {
            hosts,
            summary: veluxDiscoverySummary(hosts.length, hosts.length),
          }
        },
      },
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Velux: shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    setKlfLibraryLogSink(null)
    await super.onShutdown()
  }

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  /** A KLF-200 is found by the scan engine's mDNS browse; this addon only classifies the hits. */
  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return VELUX_DISCOVERY_MODES
  }

  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const found = veluxGatewaysFromHits(input.hits)
    const proposals = proposeVeluxGateways(found, await this.knownGatewayHosts())
    if (found.length > proposals.length) {
      this.ctx.logger.info('Velux discovery skipped gateways already added', {
        meta: { found: found.length, proposed: proposals.length },
      })
    }
    return veluxDiscoveryCandidates(proposals)
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

  private async knownGatewayHosts(): Promise<readonly string[]> {
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

  private reconciler(): VeluxReconciler {
    this.integrationReconciler ??= new VeluxReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: {
        list: () => this.requireClients().list(),
        remove: async (id) => {
          await this.requireClients().remove(id)
        },
      },
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const connection = connectionFromSettings(
          await this.ctx.api.integrations.getSettings.query({
            id: integration.id,
          }),
        )
        if (!connection) return false
        await this.requireClients().upsert(integration.id, integration.name, connection)
        return true
      },
      removeDevices: (integrationId) => this.cascadeRemoveDevicesForIntegration(integrationId),
      ownerIntegrationIds: () => this.ownerIntegrationIds(),
    })
    return this.integrationReconciler
  }

  /** Upsert one client per enabled integration; never removes a device (D49). */
  private async reconcileIntegrations(): Promise<void> {
    await this.reconciler().reconcile()
  }

  /** Lifecycle events: only an explicit Deleted/Disabled naming an integration removes devices. */
  private subscribeIntegrationLifecycle(): void {
    const on =
      (kind: IntegrationLifecycleKind) =>
      (event: SystemEvent): void => {
        const addonId = event.data['addonId']
        if (typeof addonId === 'string' && addonId !== this.ctx.id) return
        const integrationId = event.data['integrationId']
        void this.reconciler().onLifecycle(
          kind,
          typeof integrationId === 'string' ? integrationId : null,
        )
      }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, on('enabled'))
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, on('disabled'))
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, on('deleted'))
  }

  /** The integrations that own devices here, for the orphan sweep. */
  private async ownerIntegrationIds(): Promise<readonly string[]> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return []
    return await collectOwnerIntegrationIds({
      reg,
      devices,
      addonId: this.addonId,
      ownerOf: (cfg) => {
        const owner = cfg['integrationId']
        return cfg['system'] === 'velux' && typeof owner === 'string' ? owner : null
      },
    })
  }

  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<number> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return 0
    return await cascadeRemoveDevicesForIntegration({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      logger: this.ctx.logger,
    })
  }

  /** The gateway device's `power-source` cap, through `ctx.api`; the cap owns off, wait, on. */
  private buildPowerSourcePort(): PowerSourcePort {
    return {
      gatewayDevice: async (integrationId) => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices)
          return { kind: 'unknown', error: 'the device registry is unavailable' }
        let failure: string | null = null
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d.parentDeviceId !== null) continue
          try {
            const config = await devices.loadConfig(d.id)
            if (
              config['system'] === 'velux' &&
              config['nativeId'] === gatewayNativeId(integrationId)
            ) {
              return { kind: 'found', deviceId: d.id }
            }
          } catch (err) {
            // A failed read is not absence: say so, and keep looking at the others.
            failure = errMsg(err)
            this.ctx.logger.warn(
              'velux: a device config could not be read for the gateway lookup',
              {
                tags: { integrationId, deviceId: d.id },
                meta: { error: failure },
              },
            )
          }
        }
        return failure === null ? { kind: 'missing' } : { kind: 'unknown', error: failure }
      },
      getStatus: (deviceId) => this.ctx.api.powerSource.getStatus.query({ deviceId }),
      forceRestart: (deviceId) => this.ctx.api.powerSource.forceRestart.mutate({ deviceId }),
    }
  }

  /** The last restart attempt per integration, in the addon store, so a respawn keeps the cooldown. */
  private buildPowerCycleStore(): PowerCycleStore {
    // One flat key per integration: `writeAddonStore` merges top-level keys, so
    // one integration's write never rewrites another's (no whole-map read-modify-write).
    const key = (integrationId: string): string => `powerRestartAt:${integrationId}`
    return {
      read: async (integrationId) => {
        const store = (await this.ctx.settings?.readAddonStore()) ?? {}
        const at: unknown = store[key(integrationId)]
        return typeof at === 'number' ? at : null
      },
      write: async (integrationId, at) => {
        await this.ctx.settings?.writeAddonStore({ [key(integrationId)]: at })
      },
    }
  }

  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildVeluxConnectionTestProvider({
      logger: this.ctx.logger,
      liveSessions: (host) => this.clients?.liveSessions(host) ?? 0,
      liveSession: (host) => this.clients?.liveSession(host) ?? null,
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
