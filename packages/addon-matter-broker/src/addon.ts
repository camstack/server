import {
  BaseDeviceProvider,
  brokerCapability,
  createEvent,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  EventCategory,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type IBrokerProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type ProviderRegistration,
  type SystemEvent,
} from '@camstack/types'
import { type MatterAddonConfig } from './config.js'
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
import { matterBrokersEntryKind } from './broker-record-kinds.js'
import { MatterBrokerStore } from './matter-broker-store.js'
import type { MatterBrokerEntry } from './config.js'

/** Default config — a fresh install starts with no fabric. */
const DEFAULTS: MatterAddonConfig = { brokers: [] }

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
    await records.declare({ brokers: matterBrokersEntryKind })
    this.brokerStore = MatterBrokerStore.of(records)
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

    await this.reconcileIntegrationsToBrokers()
    this.subscribeIntegrationLifecycle()

    return [
      ...regs,
      { capability: brokerCapability, provider: this.buildBrokerProvider() },
      { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
    ]
  }

  private async loadPersistedBrokers(): Promise<readonly MatterBrokerEntry[]> {
    const store = this.brokerStore
    if (store !== null) {
      const fromRecords = await store.listResolved()
      if (fromRecords.length > 0) return fromRecords
    }
    return this.config.brokers
  }

  private async persistBrokerEntries(entries: readonly MatterBrokerEntry[]): Promise<void> {
    this.activeBrokers = [...entries]
    const store = this.brokerStore
    if (store !== null) {
      await store.replaceAll(entries)
      return
    }
    await this.updateGlobalSettings({ brokers: [...entries] })
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
      ownerAddonId: this.ctx.id,
      registry: this.requireRegistry(),
      getBrokers: () => this.activeBrokers,
      persistBrokers: (brokers) => this.persistBrokerEntries(brokers),
      cascadeRemoveDevices: (brokerId) => this.cascadeRemoveDevicesForBroker(brokerId),
      logger: this.ctx.logger,
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

  // ── integration → broker reconcile (Approach A) ────────────────────────

  private async reconcileIntegrationsToBrokers(): Promise<void> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id)
      const surviving = new Set(mine.map((i) => i.id))

      for (const integration of mine) {
        const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
        const brokerId = typeof settings['brokerId'] === 'string' ? settings['brokerId'] : undefined
        if (brokerId === undefined) continue
        if (!this.activeBrokers.some((b) => b.id === brokerId)) {
          this.ctx.logger.warn('Matter integration→broker: linked broker not found', {
            meta: { integrationId: integration.id, brokerId },
          })
          continue
        }
        this.requireRegistry().linkIntegration(integration.id, brokerId)
      }

      const toRemove = this.activeBrokers
        .filter((b) => b.integrationId !== undefined && !surviving.has(b.integrationId))
        .map((b) => b.id)
      if (toRemove.length === 0) return

      for (const id of toRemove) {
        try {
          await this.requireRegistry().removeEntry(id)
          await this.cascadeRemoveDevicesForBroker(id)
        } catch (err) {
          this.ctx.logger.warn('Matter integration→broker: broker cleanup failed', {
            meta: { brokerId: id, error: errMsg(err) },
          })
        }
      }
      const nextBrokers = this.activeBrokers.filter((b) => !toRemove.includes(b.id))
      await this.persistBrokerEntries(nextBrokers)
    } catch (err) {
      this.ctx.logger.warn('Matter integration→broker reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrationsToBrokers()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
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
        const settings = await this.ctx.api.integrations.getSettings.query({ id })
        const brokerId = settings['brokerId']
        if (typeof brokerId !== 'string') {
          throw new Error(`integration ${id} has no linked brokerId`)
        }
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

  // ── Settings UI (informational only) ───────────────────────────────────

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'matter-fabric',
          title: 'Matter fabric',
          titleKey: 'matter-broker:globalSettings.s_matter-fabric.title',
          description: 'Matter fabrics are managed in the External systems → Brokers tab.',
          descriptionKey: 'matter-broker:globalSettings.s_matter-fabric.description',
          columns: 1,
          fields: [
            {
              type: 'info' as const,
              key: 'fabricHelp',
              label: 'Fabrics are managed separately',
              labelKey: 'matter-broker:globalSettings.s_matter-fabric.fabricHelp.label',
              content:
                'This integration links to a Matter fabric broker. Add, edit, or remove ' +
                'fabrics from External systems → Brokers, then commission devices into the ' +
                'fabric. The integration only stores a reference to its broker.',
            },
          ],
        },
      ],
    })
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
