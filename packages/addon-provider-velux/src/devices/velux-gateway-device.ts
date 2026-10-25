import {
  BaseDevice,
  type DeviceContext,
  type DeviceDiscoveryStatus,
  type DeviceFeature,
  DeviceType,
  deviceDiscoveryCapability,
  type DiscoveredChildDevice,
  errMsg,
  EventCategory,
  type IDevice,
  buildDeviceAdminUrl,
  deviceAdminLinkCapability,
  type InferNativeProvider,
} from '@camstack/types'
import { veluxGatewaySchema } from '../config.js'
import { buildNodeCandidates, nodeNativeId, parseNodeNativeId } from '../velux-discovery.js'
import { veluxGateways } from '../velux-node-resolver.js'
import { VeluxIntegrationManager } from '../velux-integration-manager.js'
import { VeluxCoverDevice } from './velux-cover-device.js'

/**
 * Velux KLF-200 gateway — a {@link DeviceType.Hub} device (standalone mode, the
 * Reolink / Ecowitt / Rademacher pattern). The operator-supplied CONNECTION
 * lives on THIS device's config; the gateway owns exactly one live client (via a
 * {@link VeluxIntegrationManager}) keyed on its own `stableId` and published on
 * the in-process {@link veluxGateways} resolver so its cover children read the
 * live nodes.
 *
 * It registers the `device-discovery` cap: `refreshDiscovery`/`listDiscovered`
 * enumerate the gateway's actuator candidates; `adoptDevice` spawns a
 * {@link VeluxCoverDevice} child; `releaseDevice` removes it. On every poll tick
 * the gateway fans a snapshot out to the adopted covers via the resolver.
 */
export class VeluxGatewayDevice extends BaseDevice<typeof veluxGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  private manager: VeluxIntegrationManager | null = null
  private readonly eventUnsubscribers: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    veluxGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, veluxGatewaySchema, { type: DeviceType.Hub })
    this.online = false
    this.registerDeviceDiscovery()
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: this.stableId, system: 'velux' })
  }

  /**
   * device-admin-link — the hub's own management page.
   *
   * The KLF-200 serves its web interface over HTTPS only, with a self-signed
   * certificate — the browser will warn, which is the unit's own behaviour and
   * not something to paper over. The password printed on the back of the unit
   * is in the same connection object and is NOT placed in the URL; the page
   * asks for it.
   *
   * Only the hub gets the cap. Its children are radio actuators with no web
   * server anywhere, and the address they would borrow lives on the hub, which
   * is where the operator edits it.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `VeluxGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = this.config.values.connection
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: null,
          scheme: 'https',
          path: '/',
        })
        if (!built.ok) {
          this.ctx.logger.debug('velux admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'KLF-200 web interface',
          target: 'integration' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }

  /** Adopt a pre-built manager (created by `onCreateDevice` so the live client
   *  connects once). Published on the resolver so children pick it up. */
  adoptManager(manager: VeluxIntegrationManager): void {
    this.manager = manager
    veluxGateways.set(this.stableId, manager)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    if (this.manager === null) {
      void this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Velux gateway initial connect failed', {
          meta: { error: errMsg(err) },
        })
      })
    } else {
      void this.refreshDiscoveryFromClient().catch(() => {
        /* best-effort */
      })
    }

    // A child removed externally (operator delete, restore prune) → refresh so
    // the panel's `alreadyAdopted` flag flips without waiting for a poll.
    this.eventUnsubscribers.push(
      this.ctx.eventBus.subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
        const data = event.data as { parentDeviceId?: number | null }
        if (data.parentDeviceId !== this.id) return
        void this.refreshDiscoveryFromClient().catch(() => {
          /* best-effort */
        })
      }),
    )
  }

  override async removeDevice(): Promise<void> {
    for (const unsub of this.eventUnsubscribers) {
      try {
        unsub()
      } catch {
        /* best-effort */
      }
    }
    this.eventUnsubscribers.length = 0
    const mgr = this.manager
    this.manager = null
    veluxGateways.set(this.stableId, null)
    if (mgr) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('Velux gateway: client stop failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
    await super.removeDevice()
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    if (!('connection' in patch)) return
    const parsed = veluxGatewaySchema.parse({
      connection: patch['connection'],
      system: 'velux-gateway',
    })
    await this.config.setAll({ connection: parsed.connection })
    const mgr = this.manager
    if (mgr) {
      try {
        await mgr.applyConnection(parsed.connection)
      } catch (err) {
        this.ctx.logger.warn('Velux gateway: applyConnection failed', {
          meta: { error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Velux gateway re-connect after settings change failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  // ── Live client lifecycle ──────────────────────────────────────────────────

  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const connection = this.config.values.connection
    const mgr = new VeluxIntegrationManager({
      id: this.stableId,
      name: this.name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => this.setGatewayOnline(true),
      onDisconnected: () => this.setGatewayOnline(false),
      onPolled: (gatewayId) => this.handlePolled(gatewayId),
    })
    this.manager = mgr
    veluxGateways.set(this.stableId, mgr)
    await mgr.start()
  }

  private setGatewayOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('Velux gateway ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
  }

  /** On each poll tick: re-derive discovery + fan the snapshot out to covers. */
  private handlePolled(gatewayId: string): void {
    void this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    veluxGateways.emitSnapshot(gatewayId)
  }

  // ── device-discovery cap ────────────────────────────────────────────────────

  private registerDeviceDiscovery(): void {
    const provider: InferNativeProvider<typeof deviceDiscoveryCapability> = {
      getStatus: async ({ deviceId }): Promise<DeviceDiscoveryStatus | null> => {
        if (deviceId !== this.id) return null
        return this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery') ?? null
      },
      listDiscovered: async ({ deviceId }): Promise<readonly DiscoveredChildDevice[]> => {
        if (deviceId !== this.id) return []
        const slice = this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery')
        return slice?.discovered ?? []
      },
      refreshDiscovery: async ({ deviceId }): Promise<readonly DiscoveredChildDevice[]> => {
        if (deviceId !== this.id) return []
        await this.refreshDiscoveryFromClient()
        const slice = this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery')
        return slice?.discovered ?? []
      },
      adoptDevice: async ({ deviceId, childNativeId, name }) => {
        if (deviceId !== this.id) {
          throw new Error(`adoptDevice: deviceId mismatch — got ${deviceId}, expected ${this.id}`)
        }
        return this.adoptCover(childNativeId, name)
      },
      releaseDevice: async ({ deviceId, childDeviceId }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.releaseCover(childDeviceId)
      },
    }
    this.ctx.registerNativeCap(deviceDiscoveryCapability, provider)
    // Seed AFTER registerNativeCap installs the runtime-state schema.
    this.setCapSlice(deviceDiscoveryCapability, {
      discovered: [],
      lastDiscoveryAt: null,
      lastError: null,
      lastFetchedAt: 0,
    })
  }

  /** Enumerate node candidates from the live client, flag `alreadyAdopted` per
   *  node id, persist into the discovery slice. */
  private async refreshDiscoveryFromClient(): Promise<void> {
    let lastError: string | null = null
    let discovered: readonly DiscoveredChildDevice[] = []
    try {
      const nodes = veluxGateways.getNodes(this.stableId)
      const adoptedByNode = await this.adoptedCoverIdByNode()
      discovered = buildNodeCandidates({
        gatewayId: this.stableId,
        gatewayName: this.name,
        nodes,
        adoptedDeviceIdByNode: adoptedByNode,
      })
    } catch (err) {
      lastError = errMsg(err)
      this.ctx.logger.warn('Velux gateway discovery refresh failed', {
        meta: { error: lastError },
      })
    }
    this.runtimeState.setCapState(deviceDiscoveryCapability.name, {
      discovered,
      lastDiscoveryAt: Date.now(),
      lastError,
      lastFetchedAt: Date.now(),
    })
  }

  /** Map each node id → the adopted cover child's device id (null when not
   *  adopted), by walking this gateway's direct children. */
  private async adoptedCoverIdByNode(): Promise<Record<number, number | null>> {
    const out: Record<number, number | null> = {}
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Cover) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      const nodeId = cfg['nodeId']
      if (typeof nodeId === 'number') out[nodeId] = child.id
    }
    return out
  }

  /** Promote a discovered node candidate to a real cover child. */
  private async adoptCover(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const nodeId = parseNodeNativeId(childNativeId)
    if (nodeId === null) {
      throw new Error(`adoptDevice: ${childNativeId} is not a Velux node native id`)
    }
    const node = veluxGateways.getNode(this.stableId, nodeId)
    if (node === null) {
      throw new Error(`adoptDevice: no Velux node ${nodeId} on this gateway`)
    }

    // Idempotent: return the existing child when this node is already adopted.
    const existingByNode = await this.adoptedCoverIdByNode()
    const existingId = existingByNode[nodeId]
    if (typeof existingId === 'number') {
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }

    const name = nameOverride ?? (node.name.length > 0 ? node.name : `${node.coverClass} ${nodeId}`)
    const config: Record<string, unknown> = {
      nodeId,
      gatewayId: this.stableId,
      coverClass: node.coverClass,
      system: 'velux',
      name,
    }
    const stableId = nodeNativeId(this.stableId, nodeId)
    const created = await this.ctx.devices.create(stableId, VeluxCoverDevice, config, this.id, {
      type: DeviceType.Cover,
      name,
    })
    this.ctx.logger.info('Velux gateway: adopted cover', {
      tags: { deviceId: created.id },
      meta: { nodeId, coverClass: node.coverClass, stableId },
    })
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    return { deviceId: created.id, stableId }
  }

  private async releaseCover(childDeviceId: number): Promise<void> {
    const all = await this.ctx.devices.getAll()
    const child = all.find((d) => d.id === childDeviceId)
    if (!child || child.parentDeviceId !== this.id) {
      throw new Error(`releaseDevice: ${childDeviceId} is not a child of gateway ${this.id}`)
    }
    await this.ctx.devices.remove(childDeviceId)
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
  }
}
