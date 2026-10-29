import {
  BaseDevice,
  buildDeviceAdminUrl,
  type DeviceContext,
  type DeviceDiscoveryStatus,
  type DeviceFeature,
  DeviceType,
  type DiscoveredChildDevice,
  deviceAdminLinkCapability,
  deviceDiscoveryCapability,
  EventCategory,
  errMsg,
  type IDevice,
  type InferNativeProvider,
} from '@camstack/types'
import { veluxGatewaySchema } from '../config.js'
import { buildNodeCandidates, findNodeByNativeId } from '../velux-discovery.js'
import { VeluxIntegrationManager } from '../velux-integration-manager.js'
import { veluxGateways } from '../velux-node-resolver.js'
import { VeluxCoverDevice } from './velux-cover-device.js'
import { VeluxRainSensorDevice } from './velux-rain-sensor-device.js'

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

  override async onActivate(): Promise<void> {
    await super.onActivate()
    void this.ensureManager().catch((err) => {
      this.ctx.logger.warn('Velux gateway initial connect failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    })

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
          tags: { deviceId: this.id },
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
          tags: { deviceId: this.id },
          meta: { error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Velux gateway re-connect after settings change failed', {
          tags: { deviceId: this.id },
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
      onNodesChanged: (gatewayId) => this.handleNodesChanged(gatewayId),
    })
    mgr.bindDevice(this.id)
    this.manager = mgr
    veluxGateways.set(this.stableId, mgr)
    // start() never throws: a gateway that is down is retried with backoff.
    await mgr.start()
  }

  private setGatewayOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('Velux gateway ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
  }

  /** On every push, (re)connect or drop: re-derive discovery + fan the snapshot out to the children. */
  private handleNodesChanged(gatewayId: string): void {
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
      const adoptedByNativeId = await this.adoptedIdByNativeId()
      discovered = buildNodeCandidates({
        gatewayId: this.stableId,
        gatewayName: this.name,
        nodes,
        adoptedDeviceIdByNativeId: adoptedByNativeId,
      })
    } catch (err) {
      lastError = errMsg(err)
      this.ctx.logger.warn('Velux gateway discovery refresh failed', {
        tags: { deviceId: this.id },
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

  /** Map each adopted child's native id (= its stableId) to its device id, by
   *  walking this gateway's direct children. */
  private async adoptedIdByNativeId(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {}
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) out[child.stableId] = child.id
    return out
  }

  /** Promote a discovered candidate (a cover, or a window's rain sensor) to a real child. */
  private async adoptCover(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const resolved = findNodeByNativeId(
      this.stableId,
      veluxGateways.getNodes(this.stableId),
      childNativeId,
    )
    if (resolved === null) {
      throw new Error(`adoptDevice: ${childNativeId} is not a node of this Velux gateway`)
    }
    const { kind, node } = resolved

    // Idempotent: return the existing child when this candidate is already adopted.
    const existingId = (await this.adoptedIdByNativeId())[childNativeId]
    if (typeof existingId === 'number') return { deviceId: existingId, stableId: childNativeId }

    const baseName = node.name.length > 0 ? node.name : `${node.coverClass} ${node.nodeId}`
    const name = nameOverride ?? (kind === 'rain' ? `${baseName} rain` : baseName)
    const identity = {
      nodeId: node.nodeId,
      serial: node.serial,
      gatewayId: this.stableId,
      system: 'velux',
      name,
    }
    const created =
      kind === 'rain'
        ? await this.ctx.devices.create(childNativeId, VeluxRainSensorDevice, identity, this.id, {
            type: DeviceType.Sensor,
            name,
          })
        : await this.ctx.devices.create(
            childNativeId,
            VeluxCoverDevice,
            { ...identity, coverClass: node.coverClass },
            this.id,
            { type: DeviceType.Cover, name },
          )
    this.ctx.logger.info('Velux gateway: adopted child', {
      tags: { deviceId: created.id },
      meta: {
        kind,
        nodeId: node.nodeId,
        coverClass: node.coverClass,
        stableId: childNativeId,
      },
    })
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    return { deviceId: created.id, stableId: childNativeId }
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
