import {
  type AddonInitResult,
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceClassRow,
  type DeviceConstructor,
  type DeviceRestoreReport,
  type DeviceSummary,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
  DeviceType,
  deviceAdoptionCapability,
  errMsg,
  EventCategory,
  type IDevice,
  type IDeviceAdoptionProvider,
  integrationInstancesCapability,
  integrationRowsMigration,
  integrationRowsPortsOver,
  type RecordIntegrationInstances,
  type SavedDevice,
  type SystemEvent,
  collectOwnerIntegrationIds,
  rowsDepsOver,
} from '@camstack/types'
import { UNRAID_SYSTEM } from './config.js'
import { UnraidEntityDevice } from './devices/unraid-entity-device.js'
import { UnraidInstanceDevice } from './devices/unraid-instance-device.js'
import { UnraidWorkloadDevice } from './devices/unraid-workload-device.js'
import { buildUnraidAdoptionProvider } from './unraid-adoption-provider.js'
import { makeLiveUnraidClient } from './unraid-client-live.js'
import { UnraidClientRegistry } from './unraid-client-registry.js'
import { buildUnraidDeviceAdopter } from './unraid-device-adopter.js'
import { UNRAID_INSTANCE_ID, unraidStableId } from './unraid-discovery.js'
import {
  UNRAID_DISCOVERY_MODES,
  type UnraidDroppedHit,
  unraidServerCandidates,
  unraidServersFromHits,
} from './unraid-lan-discovery.js'
import { reconcileInstanceEntities } from './unraid-entity-reconcile.js'
import { retireLegacyUnraidGatewayRows } from './unraid-legacy-gateway.js'
import { UnraidReconciler, type IntegrationLifecycleKind } from './unraid-reconciler.js'
import { cascadeRemoveDevicesForIntegration } from './unraid-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './unraid-integration-offline.js'
import {
  buildUnraidInstances,
  unraidConnectionOf,
  unraidConnectionsEntryKind,
  type UnraidConnectionBody,
  unraidRecordKinds,
} from './unraid-instances.js'
import { unraidInstances } from './unraid-node-resolver.js'

/** The date of the integration-rows-to-record migration (D1007). */
const UNRAID_MIGRATIONS_DATE = '2026-11-05'

/**
 * Unraid device-provider addon, `mode: account` and broker-less. An integration is one
 * server: its host, port and ADMIN-role API key (a keychain secret) live on the
 * integration's settings, and the addon polls it with one client per `integrationId`.
 * Discovery offers the server itself as the {@link DeviceType.Workload} Host (with the link to
 * its WebGUI and the server's identifiers; there is no Gateway, D1064), and each Docker container
 * (role `app-container`) and VM (role `vm`) as a workload, all as siblings (D1056); the
 * server device fans array / disk / CPU / notification entities out as accessory children.
 * Rows adopted before the workload type (a Container server, Generic workloads) are rebuilt
 * with their classes and serve no `workload` cap.
 *
 * The server is reached through `node-unraid` ({@link makeLiveUnraidClient}), polled on
 * the integration's `pollIntervalMs`; a failed connect keeps the devices offline.
 *
 * `instanceMode: multiple` — many servers may be added. A LAN scan finds a server by its
 * GraphQL endpoint (`unraid-lan-discovery.ts`) and offers it as an integration to set up, host,
 * port and scheme prefilled; the API key is asked at setup.
 */
export class UnraidProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-unraid'
  protected readonly providerName = 'Unraid'
  // The entity children are spawned by the Container's accessory specs, not restored here.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: UnraidInstanceDevice,
    [DeviceType.Generic]: UnraidWorkloadDevice,
    // A container or VM; the server shares the type and is told apart in deviceClassForRow.
    [DeviceType.Workload]: UnraidWorkloadDevice,
    [DeviceType.Sensor]: UnraidEntityDevice,
    [DeviceType.Switch]: UnraidEntityDevice,
    [DeviceType.Button]: UnraidEntityDevice,
    [DeviceType.EventEmitter]: UnraidEntityDevice,
  }

  /** D1056 — the server and its containers / VMs are all `workload`: rebuild each with its class. */
  protected override deviceClassForRow(
    row: DeviceClassRow,
  ): DeviceConstructor<IDevice> | undefined {
    if (row.type !== DeviceType.Workload) return super.deviceClassForRow(row)
    return row.stableId.endsWith(`:${UNRAID_INSTANCE_ID}`)
      ? UnraidInstanceDevice
      : UnraidWorkloadDevice
  }

  /**
   * A Gateway row an older version adopted (D1064) has no class: it is retired through the
   * kernel's removal (tombstone, D865) before the rest is restored.
   */
  protected override async onRestoreDevices(
    savedDevices: readonly SavedDevice[],
  ): Promise<DeviceRestoreReport | void> {
    const devices = this.ctx.kernel.devices
    const rest = await retireLegacyUnraidGatewayRows({
      saved: savedDevices,
      remove: async (deviceId) => {
        if (!devices) throw new Error('kernel.devices unavailable')
        await devices.remove(deviceId)
      },
      logger: this.ctx.logger,
    })
    return super.onRestoreDevices(rest)
  }

  private integrationReconciler: UnraidReconciler | null = null
  private clients: UnraidClientRegistry | null = null
  private instances: RecordIntegrationInstances<UnraidConnectionBody> | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-unraid: ctx.records is required (hub-only addon)')
    await records.declare(unraidRecordKinds)
    this.declareRegistrySwitch({
      kind: unraidConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    await this.runMigrations(
      [
        integrationRowsMigration({
          addonId: this.addonId,
          date: UNRAID_MIGRATIONS_DATE,
          kind: unraidConnectionsEntryKind,
          fixtureMark: 'host',
        }),
      ],
      (api) =>
        integrationRowsPortsOver({
          ...rowsDepsOver(api),
          kind: unraidConnectionsEntryKind,
        }),
    )
    this.instances = buildUnraidInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
      makeClient: makeLiveUnraidClient,
    })
    this.clients = new UnraidClientRegistry(this.ctx.logger, {
      makeClient: makeLiveUnraidClient,
      onConnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, true),
      onDisconnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, false),
      onPolled: (integrationId) => this.handlePolled(integrationId),
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
          capability: integrationInstancesCapability,
          provider: this.requireInstances().toProvider(),
        },
      ],
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Unraid shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    unraidInstances.clear()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<UnraidConnectionBody> {
    if (!this.instances) throw new Error('Unraid provider not initialised')
    return this.instances
  }

  private requireClients(): UnraidClientRegistry {
    if (!this.clients) throw new Error('Unraid provider not initialised')
    return this.clients
  }

  /** Every Unraid device is `unraid:<integrationId>:<nativeId>` (instance, docker:…, vm:…). */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['integrationId']
    const nativeId = config?.['nativeId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('unraid generateStableId: integrationId required')
    }
    if (typeof nativeId !== 'string' || nativeId.length === 0) {
      throw new Error('unraid generateStableId: nativeId required')
    }
    return unraidStableId(integrationId, nativeId)
  }

  /**
   * Upsert one client per enabled integration and drop the client of one the list ANSWERED is
   * gone. Never removes a device (D49): that follows only an explicit lifecycle event.
   * Idempotent; runs at boot and on every integration lifecycle event.
   */
  private reconciler(): UnraidReconciler {
    this.integrationReconciler ??= new UnraidReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: this.requireClients(),
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const reg = this.requireClients()
        const read = await unraidConnectionOf(this.requireInstances(), integration.id)
        if (read === null) return false
        await reg.upsert(integration.id, integration.name, read.connection, read.apiKeyLocked)
        return true
      },
      removeDevices: (integrationId) => this.cascadeRemoveDevicesForIntegration(integrationId),
      ownerIntegrationIds: () => this.ownerIntegrationIds(),
    })
    return this.integrationReconciler
  }

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
    this.requireInstances().onSwitched((id, enabled) => {
      void this.reconciler().onLifecycle(enabled ? 'enabled' : 'disabled', id)
    })
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
        return cfg['system'] === UNRAID_SYSTEM && typeof owner === 'string' ? owner : null
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

  /** On each poll tick: fan the snapshot out to the entities, and reconcile the Container. */
  private handlePolled(integrationId: string): void {
    unraidInstances.emitSnapshot(integrationId)
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    void reconcileInstanceEntities({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      snapshot: unraidInstances.getSnapshot(integrationId),
      logger: this.ctx.logger,
    }).catch((err) => {
      this.ctx.logger.warn('Unraid entity reconcile failed', {
        meta: { integrationId, error: errMsg(err) },
      })
    })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    const getSnapshot = (integrationId: string) => unraidInstances.getSnapshot(integrationId)
    const adopter = () => {
      const devices = this.ctx.kernel.devices
      if (!devices) throw new Error('unraid adopt: kernel.devices unavailable')
      return buildUnraidDeviceAdopter({ devices, getSnapshot })
    }
    return buildUnraidAdoptionProvider({
      getSnapshot,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) => unraidInstances.getManager(integrationId)?.name ?? null,
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const kernelDevices = this.ctx.kernel.devices
        if (!reg || !kernelDevices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d.parentDeviceId !== null) continue
          const config = await kernelDevices
            .loadConfig(d.id)
            .catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptInstance: async (input) => adopter().adoptInstance(input),
      adoptWorkload: async (input) => adopter().adoptWorkload(input),
      childDeviceIds: async (deviceId) => {
        const children = (await this.ctx.kernel.devices?.getChildren(deviceId)) ?? []
        return children.map((c) => c.id)
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const kernelDevices = this.ctx.kernel.devices
        if (!kernelDevices) return null
        return kernelDevices.loadConfig(id).catch((): null => null)
      },
      logger: this.ctx.logger,
    })
  }

  // ── LAN discovery: the scan engine finds it, this addon classifies the hits ──

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return UNRAID_DISCOVERY_MODES
  }

  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const scan = unraidServersFromHits(input.hits)
    const proposal = unraidServerCandidates(scan.servers, await this.knownServerHosts())
    for (const drop of [...scan.dropped, ...proposal.dropped]) this.logDroppedHit(drop)
    this.ctx.logger.info('Unraid server discovery finished', {
      meta: { found: scan.servers.length, proposed: proposal.candidates.length },
    })
    return proposal.candidates
  }

  /** A hit the scan did not turn into a candidate is logged with its reason (D391). */
  private logDroppedHit(drop: UnraidDroppedHit): void {
    this.ctx.logger.debug('Unraid discovery: hit not proposed', {
      meta: { host: drop.host, port: drop.port, reason: drop.reason },
    })
  }

  /** The hosts the existing Unraid integrations dial; an unreadable one is skipped and logged. */
  private async knownServerHosts(): Promise<readonly string[]> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const hosts: string[] = []
      for (const integration of all) {
        if (integration.addonId !== this.ctx.id) continue
        try {
          const read = await unraidConnectionOf(this.requireInstances(), integration.id)
          if (read !== null) hosts.push(read.connection.host)
        } catch (err) {
          this.ctx.logger.warn('Unraid discovery: settings read failed', {
            tags: { integrationId: integration.id },
            meta: { error: errMsg(err) },
          })
        }
      }
      return hosts
    } catch (err) {
      this.ctx.logger.warn('Unraid discovery: integration list failed', {
        meta: { error: errMsg(err) },
      })
      return []
    }
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw new Error('An Unraid server is set up as an integration, not added as a device')
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
    throw new Error('Unraid devices are adopted from the integration')
  }

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const n = setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Unraid integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
