import type { CoverDevice } from '@apocaliss92/noderademacher'
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
import { rademacherHubSchema } from '../config.js'
import { buildCoverCandidates, type DiscoverableCover } from '../rademacher-discovery.js'
import { rademacherHubs } from '../rademacher-hub-resolver.js'
import { RademacherIntegrationManager } from '../rademacher-integration-manager.js'
import { RademacherCoverDevice } from './rademacher-cover-device.js'

/**
 * Rademacher HomePilot hub — a {@link DeviceType.Hub} device (standalone mode,
 * Reolink / Ecowitt pattern). The operator-supplied CONNECTION lives on THIS
 * device's config; the hub owns exactly one live `@apocaliss92/noderademacher`
 * client (via a {@link RademacherIntegrationManager}) keyed on its own
 * `stableId` and published on the in-process {@link rademacherHubs} resolver so
 * its cover children read the live handles.
 *
 * It registers the `device-discovery` cap: `refreshDiscovery`/`listDiscovered`
 * enumerate the hub's roller-shutter candidates; `adoptDevice` spawns a
 * {@link RademacherCoverDevice} child; `releaseDevice` removes it. On every poll
 * tick the hub fans a snapshot out to the adopted covers via the resolver.
 */
export class RademacherHubDevice extends BaseDevice<typeof rademacherHubSchema> {
  readonly features: readonly DeviceFeature[] = []

  private manager: RademacherIntegrationManager | null = null
  private readonly eventUnsubscribers: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    rademacherHubSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, rademacherHubSchema, { type: DeviceType.Hub })
    this.online = false
    this.registerDeviceDiscovery()
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: this.stableId, system: 'rademacher' })
  }

  /**
   * device-admin-link — the hub's own management page.
   *
   * The HomePilot serves its web UI on plain HTTP at the hub's own address.
   * `basePath` is the operator's API base-path override ("" for v1, "/hp" for
   * v2) and is carried through, because a hub reached under a prefix serves its
   * page under the same prefix.
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
            `RademacherHubDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = this.config.values.connection
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: null,
          scheme: 'http',
          path: connection.basePath === '' ? '/' : `${connection.basePath}/`,
        })
        if (!built.ok) {
          this.ctx.logger.debug('rademacher admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'HomePilot web UI',
          target: 'integration' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }

  /** Adopt a pre-built manager (created by `onCreateDevice` so the live client
   *  connects once). Published on the resolver so children pick it up. */
  adoptManager(manager: RademacherIntegrationManager): void {
    this.manager = manager
    rademacherHubs.set(this.stableId, manager)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    if (this.manager === null) {
      void this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Rademacher hub initial connect failed', {
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
    rademacherHubs.set(this.stableId, null)
    if (mgr) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('Rademacher hub: client stop failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
    await super.removeDevice()
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    if (!('connection' in patch)) return
    const parsed = rademacherHubSchema.parse({
      connection: patch['connection'],
      system: 'rademacher-hub',
    })
    await this.config.setAll({ connection: parsed.connection })
    const mgr = this.manager
    if (mgr) {
      try {
        await mgr.applyConnection(parsed.connection)
      } catch (err) {
        this.ctx.logger.warn('Rademacher hub: applyConnection failed', {
          meta: { error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Rademacher hub re-connect after settings change failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  // ── Live client lifecycle ──────────────────────────────────────────────────

  /** Build + start the per-device noderademacher client (if not already running). */
  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const connection = this.config.values.connection
    const mgr = new RademacherIntegrationManager({
      id: this.stableId,
      name: this.name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => this.setHubOnline(true),
      onDisconnected: () => this.setHubOnline(false),
      onPolled: (hubId) => this.handlePolled(hubId),
    })
    this.manager = mgr
    rademacherHubs.set(this.stableId, mgr)
    await mgr.start()
  }

  private setHubOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('Rademacher hub ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
  }

  /** On each poll tick: re-derive discovery + fan the snapshot out to covers. */
  private handlePolled(hubId: string): void {
    void this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    rademacherHubs.emitSnapshot(hubId)
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

  /** Enumerate cover candidates from the live client, flag `alreadyAdopted` per
   *  did, persist into the discovery slice. */
  private async refreshDiscoveryFromClient(): Promise<void> {
    let lastError: string | null = null
    let discovered: readonly DiscoveredChildDevice[] = []
    try {
      const covers = rademacherHubs.getCovers(this.stableId).map(toDiscoverableCover)
      const adoptedByDid = await this.adoptedCoverIdByDid()
      discovered = buildCoverCandidates({
        hubName: this.name,
        covers,
        adoptedDeviceIdByDid: adoptedByDid,
      })
    } catch (err) {
      lastError = errMsg(err)
      this.ctx.logger.warn('Rademacher hub discovery refresh failed', {
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

  /** Map each HomePilot did → the adopted cover child's device id (null when not
   *  adopted), by walking this hub's direct children. */
  private async adoptedCoverIdByDid(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {}
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Cover) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      const did = cfg['did']
      if (typeof did === 'string' && did.length > 0) out[did] = child.id
    }
    return out
  }

  /** Promote a discovered cover candidate to a real cover child. */
  private async adoptCover(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const handle = rademacherHubs.getCover(this.stableId, childNativeId)
    if (handle === null) {
      throw new Error(`adoptDevice: no HomePilot cover with did ${childNativeId} on this hub`)
    }

    // Idempotent: return the existing child when this did is already adopted.
    const existingByDid = await this.adoptedCoverIdByDid()
    const existingId = existingByDid[childNativeId]
    if (typeof existingId === 'number') {
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }

    const name = nameOverride ?? (handle.name.length > 0 ? handle.name : `Cover ${childNativeId}`)
    const config: Record<string, unknown> = {
      did: childNativeId,
      hubId: this.stableId,
      invertPosition: false,
      supportsPosition: handle.supportsPosition,
      supportsTilt: handle.supportsTilt,
      system: 'rademacher',
      name,
    }
    const stableId = `${this.stableId}:cover:${childNativeId}`
    const created = await this.ctx.devices.create(
      stableId,
      RademacherCoverDevice,
      config,
      this.id,
      { type: DeviceType.Cover, name },
    )
    this.ctx.logger.info('Rademacher hub: adopted cover', {
      tags: { deviceId: created.id },
      meta: { did: childNativeId, stableId },
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
      throw new Error(`releaseDevice: ${childDeviceId} is not a child of hub ${this.id}`)
    }
    await this.ctx.devices.remove(childDeviceId)
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
  }
}

/** Project a live library cover handle onto the discovery-candidate shape. */
function toDiscoverableCover(handle: CoverDevice): DiscoverableCover {
  return {
    did: handle.did,
    name: handle.name,
    model: handle.model,
    online: handle.online,
  }
}
