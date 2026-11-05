import {
  BaseDeviceProvider,
  brokerCapability,
  createEvent,
  defineAddonMigrations,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  brokerIdOf,
  composeInstanceKinds,
  type IIntegrationInstancesProvider,
  EventCategory,
  brokerLinkUserFinder,
  guardBrokerDelete,
  type BrokerLinkBody,
  flattenPortsOver,
  integrationInstancesCapability,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type IBrokerProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type IntegrationInstanceRef,
  type ProviderRegistration,
  type RecordIntegrationInstances,
} from '@camstack/types'
import { buildConnectionFormSchema, type MatterAddonConfig } from './config.js'
import { MatterBrokerRegistry } from './matter-broker-registry.js'
import { sameConnection } from './matter-integration-manager.js'
import { buildMatterBrokerProvider } from './matter-broker-provider.js'
import { buildMatterAdoptionProvider } from './matter-adoption-provider.js'
import { cascadeRemoveDevicesForBroker } from './matter-broker-device-cascade.js'
import { setBrokerDevicesOnline, type OfflineTarget } from './matter-broker-offline.js'
import { matterCommands, matterNodes } from './matter-gateway.js'
import type { MatterAttributeReport, MatterNodeSnapshot } from './matter-controller.js'
import { mapMatterEndpointToCamStack } from './matter-cluster-mapping.js'
import { MatterNodeDevice, type MatterEndpointEntry } from './devices/matter-node-device.js'
import {
  type MatterBrokerBody,
  matterBrokersEntryKind,
  matterConnectionsEntryKind,
} from './broker-record-kinds.js'
import { buildMatterAccountInstances } from './matter-account-instances.js'
import { buildMatterInstances } from './matter-instances.js'
import { ADDON_MIGRATIONS, matterBrokerLinkPorts } from './migrations/index.js'
import { MatterBrokerStore } from './matter-broker-store.js'
import type { MatterBrokerEntry } from './config.js'

/** Default config — a fresh install starts with no fabric. */
const DEFAULTS: MatterAddonConfig = {}

/**
 * Matter broker addon (hub-only). Owns a Matter fabric per broker entry via an
 * embedded matter.js controller (behind the {@link matterCommands} /
 * {@link matterNodes} seams). One registered fabric = one "broker"; each
 * commissioned Matter node becomes a {@link DeviceType.Container} parent that
 * fans out one typed endpoint child per mappable endpoint. Modelled on the
 * Ecowitt / Dreame device-provider template with the stream-broker resource
 * discipline (close-controller-first on shutdown, PULL reconcile).
 *
 * The controller is the real matter.js binding (`MatterJsController`, backed by
 * `@matter/main` ServerNode + `@matter/nodejs` storage at the addon dataDir).
 * Commissioning, attribute-report decoding, and outbound cluster commands all go
 * through the live controller. Tests inject the {@link StubMatterController} via
 * the integration manager's `makeController` seam.
 */
export class MatterBrokerAddon extends BaseDeviceProvider<MatterAddonConfig> {
  protected readonly addonId = 'matter-broker'
  protected readonly providerName = 'Matter'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: MatterNodeDevice,
  }

  private registry: MatterBrokerRegistry | null = null
  private brokerStore: MatterBrokerStore | null = null
  private instances: RecordIntegrationInstances<BrokerLinkBody> | null = null
  private accountInstances: RecordIntegrationInstances<MatterBrokerBody> | null = null
  private activeBrokers: readonly MatterBrokerEntry[] = []

  constructor() {
    super({ ...DEFAULTS })
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('matter-broker: ctx.records is required (hub-only addon)')
    }
    await records.declare({
      brokers: matterBrokersEntryKind,
      connections: matterConnectionsEntryKind,
    })
    this.brokerStore = MatterBrokerStore.of(records)
    this.instances = buildMatterInstances(records)
    this.accountInstances = buildMatterAccountInstances(records, {
      mintId: () => this.requireRegistry().allocateId(),
      infoOf: (id) => this.registry?.get(id) ?? null,
      onChanged: (id) => this.syncBrokerRuntime(id),
    })
    // The stored fabric records move to the flat shape BEFORE anything reads them.
    const secrets = this.ctx.secrets
    if (secrets === undefined) throw new Error('matter-broker: ctx.secrets is required')
    await this.runMigrations(
      defineAddonMigrations(ADDON_MIGRATIONS, {
        ...flattenPortsOver(records.kind(matterBrokersEntryKind)),
        ...matterBrokerLinkPorts(records, (message) => this.ctx.logger.warn(message)),
      }),
    )
    this.activeBrokers = await this.loadPersistedBrokers()

    this.registry = new MatterBrokerRegistry(this.ctx.logger, {
      dataDir: this.ctx.dataDir,
      onBrokerConnected: (brokerId) => {
        this.ctx.logger.info('Matter: broker connected', { meta: { brokerId } })
        this.setBrokerDevicesOnline(brokerId, true)
      },
      onBrokerDisconnected: (brokerId) => {
        this.setBrokerDevicesOnline(brokerId, false)
      },
      onNodesChanged: (brokerId, nodes) => {
        void this.reconcileNodeEndpoints(brokerId, nodes)
      },
      onAttributeReport: (brokerId, report) => {
        this.emitAttributeReport(brokerId, report)
      },
    })

    // Wire the outbound command sink to the live controllers (via the registry).
    matterCommands.setDispatcher((brokerId, invocation) =>
      this.requireRegistry().invokeCommand(brokerId, invocation),
    )

    await this.registry.restore(this.activeBrokers)

    this.ctx.logger.info('Matter: broker addon initialised', {
      meta: { brokerCount: this.activeBrokers.length },
    })

    return [
      ...regs,
      { capability: brokerCapability, provider: this.buildBrokerProvider() },
      {
        capability: integrationInstancesCapability,
        provider: this.buildInstancesProvider(),
      },
      { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
    ]
  }

  private async loadPersistedBrokers(): Promise<readonly MatterBrokerEntry[]> {
    return this.requireBrokerStore().listResolved()
  }

  private requireBrokerStore(): MatterBrokerStore {
    if (this.brokerStore === null) throw new Error('matter-broker: broker store not ready')
    return this.brokerStore
  }

  private requireInstances(): RecordIntegrationInstances<BrokerLinkBody> {
    if (this.instances === null) throw new Error('matter-broker: instances not ready')
    return this.instances
  }

  /** One provider over the two record kinds: the fabric (broker) and the integrations using it. */
  private buildInstancesProvider(): IIntegrationInstancesProvider {
    if (this.accountInstances === null) throw new Error('matter-broker: fabric instances not ready')
    return composeInstanceKinds(
      [
        {
          kind: {
            id: 'account',
            label: 'Matter fabric',
            functionCap: 'broker',
            brokerKind: 'matter',
            role: 'services',
          },
          provider: guardBrokerDelete(this.accountInstances.toProvider(), () => [
            brokerLinkUserFinder(this.requireInstances()),
          ]),
        },
        {
          kind: {
            id: 'integration',
            label: 'Matter',
            functionCap: 'device-provider',
            role: 'devices',
          },
          provider: this.requireInstances().toProvider(),
        },
      ],
      {
        role: 'devices',
        instanceMode: 'multiple',
        kind: 'account',
        canTest: true,
        allowRestoreId: true,
      },
    )
  }

  /**
   * Bring the runtime in line with one fabric record after the instances page changed it: a
   * removed record stops its controller and cascades its devices, an off record only stops the
   * controller, a live one re-applies its settings or starts under the record's own id.
   */
  private async syncBrokerRuntime(id: string): Promise<void> {
    const reg = this.requireRegistry()
    const entry = await this.requireBrokerStore().getById(id)
    this.activeBrokers = await this.loadPersistedBrokers()
    if (entry === null) {
      await reg.removeEntry(id)
      await this.cascadeRemoveDevicesForBroker(id)
      return
    }
    if (entry.enabled === false) {
      await reg.removeEntry(id)
      return
    }
    try {
      if (reg.get(id) !== null) await reg.updateEntry(id, entry.connection)
      else await reg.createEntry(entry.name, entry.connection, { id })
    } catch (err) {
      this.ctx.logger.warn('matter instance: could not start the fabric', {
        meta: { brokerId: id, error: errMsg(err) },
      })
    }
  }

  private async persistBrokerEntries(entries: readonly MatterBrokerEntry[]): Promise<void> {
    this.activeBrokers = [...entries]
    await this.requireBrokerStore().replaceAll(entries)
  }

  protected override async onConfigChanged(): Promise<void> {
    const reg = this.registry
    if (!reg) return
    this.activeBrokers = await this.loadPersistedBrokers()
    const persisted = this.activeBrokers
    const liveIds = new Set(reg.list().map((b) => b.id))
    const persistedIds = new Set(persisted.map((e) => e.id))

    for (const liveId of liveIds) {
      if (!persistedIds.has(liveId)) {
        try {
          await reg.removeEntry(liveId)
        } catch (err) {
          this.ctx.logger.warn('Matter onConfigChanged: removeEntry failed', {
            meta: { brokerId: liveId, error: errMsg(err) },
          })
        }
      }
    }

    for (const entry of persisted) {
      if (entry.enabled === false) continue
      if (entry.id && liveIds.has(entry.id)) {
        if (sameConnection(entry.connection, reg.getConnection(entry.id))) continue
        try {
          await reg.updateEntry(entry.id, entry.connection)
        } catch (err) {
          this.ctx.logger.warn('Matter onConfigChanged: updateEntry failed', {
            meta: { brokerId: entry.id, error: errMsg(err) },
          })
        }
        continue
      }
      try {
        const created = await reg.createEntry(entry.name, entry.connection)
        if (created.id !== entry.id) {
          const next = persisted.map((b) => (b === entry ? { ...b, id: created.id } : b))
          await this.persistBrokerEntries(next)
        }
      } catch (err) {
        this.ctx.logger.warn('Matter onConfigChanged: failed to start new broker', {
          meta: { brokerName: entry.name, error: errMsg(err) },
        })
      }
    }
  }

  protected override async onShutdown(): Promise<void> {
    matterCommands.clear()
    try {
      await this.registry?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Matter: addon shutdown error', { meta: { error: errMsg(err) } })
    }
    matterNodes.clear()
    this.registry = null
    await super.onShutdown()
  }

  /** One broker = one fabric; the node id distinguishes Containers within it. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const brokerId = String(config?.['brokerId'] ?? 'unknown')
    const nodeId = String(config?.['nodeId'] ?? 'unknown')
    return `matter:${brokerId}:${nodeId}`
  }

  // ── additive endpoint reconcile ────────────────────────────────────────

  /**
   * Re-derive every adopted node Container's `endpoints[]` from the live node
   * inventory. When an endpoint set changed, re-persist it via the generic
   * `applyDerivedSpec` (kernel re-runs `getAccessoryChildren()` → spawns new
   * endpoint children + removes orphaned ones). Best-effort; never throws.
   */
  private async reconcileNodeEndpoints(
    brokerId: string,
    nodes: readonly MatterNodeSnapshot[],
  ): Promise<void> {
    try {
      const reg = this.ctx.kernel.deviceRegistry
      const devices = this.ctx.kernel.devices
      if (!reg || !devices) return
      const byNode = new Map<string, MatterNodeSnapshot>()
      for (const n of nodes) byNode.set(n.nodeId, n)

      for (const d of reg.getAllForAddon(this.addonId)) {
        if (d.parentDeviceId !== null) continue
        const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
        if (cfg['system'] !== 'matter' || cfg['brokerId'] !== brokerId) continue
        const node = byNode.get(String(cfg['nodeId']))
        if (node === undefined) continue

        const nextEndpoints = mappableEndpoints(node)
        const current = Array.isArray(cfg['endpoints']) ? cfg['endpoints'] : []
        if (endpointsEqual(current, nextEndpoints)) continue

        await devices.applyDerivedSpec(d.id, { config: { endpoints: nextEndpoints } })
        this.ctx.logger.info('Matter: node endpoints reconciled', {
          meta: { brokerId, deviceId: d.id, endpointCount: nextEndpoints.length },
        })
      }
    } catch (err) {
      this.ctx.logger.warn('Matter: node endpoint reconcile failed', {
        meta: { brokerId, error: errMsg(err) },
      })
    }
  }

  /** Emit an inbound attribute report on the bus as a `broker.message` event. */
  private emitAttributeReport(brokerId: string, report: MatterAttributeReport): void {
    const event = createEvent(
      EventCategory.BrokerMessage,
      { type: 'addon', id: this.ctx.id },
      {
        brokerId,
        subscriptionId: '',
        key: `${report.nodeId}:${report.endpointId}`,
        payload: {
          clusterId: report.clusterId,
          attributeId: report.attributeId,
          value: report.value,
        },
      },
    )
    this.ctx.eventBus.emit(event)
  }

  // ── broker cap provider ────────────────────────────────────────────────

  private buildBrokerProvider(): IBrokerProvider {
    return buildMatterBrokerProvider({
      registry: this.requireRegistry(),
      getBrokers: () => this.activeBrokers,
    })
  }

  private async cascadeRemoveDevicesForBroker(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForBroker({
      reg,
      devices,
      addonId: this.addonId,
      brokerId,
      logger: this.ctx.logger,
    })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildMatterAdoptionProvider({
      registry: {
        getNodesForBroker: (id) => matterNodes.getNodes(id),
        list: () =>
          this.requireRegistry()
            .list()
            .map((b) => ({ id: b.id, name: b.name })),
        has: (id) => this.requireRegistry().get(id) !== null,
      },
      logger: this.ctx.logger,
      getBrokerIdForIntegration: async (id) => {
        const brokerId = await brokerIdOf(this.requireInstances(), id)
        if (brokerId === undefined) throw new Error(`integration ${id} has no broker`)
        return brokerId
      },
      listAdoptedMatter: async () => {
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
      adoptNode: async ({ brokerId, nodeId, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('matter adopt: kernel.devices unavailable')
        const node = matterNodes.getNode(brokerId, nodeId)
        const endpoints: MatterEndpointEntry[] = node !== null ? mappableEndpoints(node) : []
        const config = { brokerId, nodeId, endpoints, system: 'matter', integrationId, name }
        const stableId = this.generateStableId(DeviceType.Container, config)
        const device = await devices.create(stableId, MatterNodeDevice, config, null, {
          type: DeviceType.Container,
          name,
          integrationId,
        })
        const children = await devices.getChildren(device.id)
        return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
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

  // ── Instance form ──────────────────────────────────────────────────────

  /** The connection form a record carries; the values live on the record, never in `addon-settings`. */
  protected override async integrationFormSchema(
    _instance: IntegrationInstanceRef,
  ): Promise<ConfigUISchema | null> {
    return buildConnectionFormSchema()
  }

  // ── Manual creation: not supported (nodes are commissioned + adopted) ──

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
    throw new Error('Matter nodes are commissioned + adopted, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setBrokerDevicesOnline(brokerId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setBrokerDevicesOnline(devices, brokerId, online)
    if (n > 0) {
      this.ctx.logger.info('Matter: broker devices ' + (online ? 'online' : 'offline'), {
        meta: { brokerId, count: n },
      })
    }
  }

  private requireRegistry(): MatterBrokerRegistry {
    if (!this.registry) throw new Error('Matter broker addon not initialised')
    return this.registry
  }
}

/** Reduce a node snapshot to its mappable endpoint entries (skip cap-less ones). */
function mappableEndpoints(node: MatterNodeSnapshot): MatterEndpointEntry[] {
  const out: MatterEndpointEntry[] = []
  for (const endpoint of node.endpoints) {
    const mapping = mapMatterEndpointToCamStack(endpoint.clusterIds)
    if (mapping.capabilities.length === 0) continue
    out.push({ endpointId: endpoint.endpointId, clusterIds: [...endpoint.clusterIds] })
  }
  return out
}

/** Structural equality of two persisted endpoint lists (by endpointId set). */
function endpointsEqual(a: readonly unknown[], b: readonly MatterEndpointEntry[]): boolean {
  if (a.length !== b.length) return false
  const aIds = new Set<number>()
  for (const entry of a) {
    if (typeof entry === 'object' && entry !== null && 'endpointId' in entry) {
      const id = entry.endpointId
      if (typeof id === 'number') aIds.add(id)
    }
  }
  for (const entry of b) {
    if (!aIds.has(entry.endpointId)) return false
  }
  return true
}
