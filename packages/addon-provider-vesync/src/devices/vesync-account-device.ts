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
  type InferNativeProvider,
} from '@camstack/types'
import { vesyncAccountSchema } from '../config.js'
import {
  buildPurifierCandidates,
  parsePurifierNativeId,
  purifierNativeId,
} from '../vesync-discovery.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'
import { VeSyncIntegrationManager } from '../vesync-integration-manager.js'
import { VeSyncPurifierDevice } from './vesync-purifier-device.js'

/**
 * VeSync account — a {@link DeviceType.Hub} device (standalone mode, the Reolink /
 * Ecowitt / Velux pattern). The operator-supplied CREDENTIALS (email / password /
 * region) live on THIS device's config; the account owns exactly one live client
 * (via a {@link VeSyncIntegrationManager}) keyed on its own `stableId` and
 * published on the in-process {@link vesyncAccounts} resolver so its purifier
 * children read the live snapshots.
 *
 * It registers the `device-discovery` cap: `refreshDiscovery`/`listDiscovered`
 * enumerate the account's air-purifier candidates; `adoptDevice` spawns a
 * {@link VeSyncPurifierDevice} child (which itself fans out accessory children);
 * `releaseDevice` removes it. On every poll tick the account fans a snapshot out
 * to the adopted purifiers via the resolver.
 */
export class VeSyncAccountDevice extends BaseDevice<typeof vesyncAccountSchema> {
  readonly features: readonly DeviceFeature[] = []

  private manager: VeSyncIntegrationManager | null = null
  private readonly eventUnsubscribers: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    vesyncAccountSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncAccountSchema, { type: DeviceType.Hub })
    this.online = false
    this.registerDeviceDiscovery()
    void this.updateSourceInfo({ id: this.stableId, system: 'vesync' })
  }

  /** Adopt a pre-built manager (created by `onCreateDevice` so the live client
   *  logs in once). Published on the resolver so children pick it up. */
  adoptManager(manager: VeSyncIntegrationManager): void {
    this.manager = manager
    vesyncAccounts.set(this.stableId, manager)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    if (this.manager === null) {
      void this.ensureManager().catch((err) => {
        this.ctx.logger.warn('VeSync account initial login failed', {
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
    vesyncAccounts.set(this.stableId, null)
    if (mgr) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('VeSync account: client stop failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
    await super.removeDevice()
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    if (!('connection' in patch)) return
    const parsed = vesyncAccountSchema.parse({
      connection: patch['connection'],
      system: 'vesync-account',
    })
    await this.config.setAll({ connection: parsed.connection })
    const mgr = this.manager
    if (mgr) {
      try {
        await mgr.applyConnection(parsed.connection)
      } catch (err) {
        this.ctx.logger.warn('VeSync account: applyConnection failed', {
          meta: { error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('VeSync account re-login after settings change failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  // ── Live client lifecycle ──────────────────────────────────────────────────

  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const connection = this.config.values.connection
    const mgr = new VeSyncIntegrationManager({
      id: this.stableId,
      name: this.name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => this.setAccountOnline(true),
      onDisconnected: () => this.setAccountOnline(false),
      onPolled: (accountId) => this.handlePolled(accountId),
    })
    this.manager = mgr
    vesyncAccounts.set(this.stableId, mgr)
    await mgr.start()
  }

  private setAccountOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('VeSync account ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
  }

  /** On each poll tick: re-derive discovery + fan the snapshot out to purifiers. */
  private handlePolled(accountId: string): void {
    void this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    vesyncAccounts.emitSnapshot(accountId)
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
        return this.adoptPurifier(childNativeId, name)
      },
      releaseDevice: async ({ deviceId, childDeviceId }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.releasePurifier(childDeviceId)
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

  /** Enumerate purifier candidates from the live client, flag `alreadyAdopted`
   *  per cid, persist into the discovery slice. */
  private async refreshDiscoveryFromClient(): Promise<void> {
    let lastError: string | null = null
    let discovered: readonly DiscoveredChildDevice[] = []
    try {
      const purifiers = vesyncAccounts.getPurifiers(this.stableId)
      const adoptedByCid = await this.adoptedPurifierIdByCid()
      discovered = buildPurifierCandidates({
        accountId: this.stableId,
        accountName: this.name,
        purifiers,
        adoptedDeviceIdByCid: adoptedByCid,
      })
    } catch (err) {
      lastError = errMsg(err)
      this.ctx.logger.warn('VeSync account discovery refresh failed', {
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

  /** Map each purifier cid → the adopted Fan child's device id (null when not
   *  adopted), by walking this account's direct children. */
  private async adoptedPurifierIdByCid(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {}
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Fan) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      const cid = cfg['purifierNativeId']
      if (typeof cid === 'string') out[cid] = child.id
    }
    return out
  }

  /** Promote a discovered purifier candidate to a real Fan child. */
  private async adoptPurifier(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const cid = parsePurifierNativeId(childNativeId)
    if (cid === null) {
      throw new Error(`adoptDevice: ${childNativeId} is not a VeSync purifier native id`)
    }
    const purifier = vesyncAccounts.getPurifier(this.stableId, cid)
    if (purifier === null) {
      throw new Error(`adoptDevice: no VeSync purifier ${cid} on this account`)
    }

    // Idempotent: return the existing child when this purifier is already adopted.
    const existingByCid = await this.adoptedPurifierIdByCid()
    const existingId = existingByCid[cid]
    if (typeof existingId === 'number') {
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }

    const name = nameOverride ?? (purifier.name.length > 0 ? purifier.name : `purifier ${cid}`)
    const config: Record<string, unknown> = {
      purifierNativeId: cid,
      accountId: this.stableId,
      system: 'vesync',
      ...(purifier.model !== undefined ? { model: purifier.model } : {}),
      name,
    }
    const stableId = purifierNativeId(this.stableId, cid)
    const created = await this.ctx.devices.create(stableId, VeSyncPurifierDevice, config, this.id, {
      type: DeviceType.Fan,
      name,
    })
    this.ctx.logger.info('VeSync account: adopted purifier', {
      tags: { deviceId: created.id },
      meta: { cid, stableId },
    })
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    return { deviceId: created.id, stableId }
  }

  private async releasePurifier(childDeviceId: number): Promise<void> {
    const all = await this.ctx.devices.getAll()
    const child = all.find((d) => d.id === childDeviceId)
    if (!child || child.parentDeviceId !== this.id) {
      throw new Error(`releaseDevice: ${childDeviceId} is not a child of account ${this.id}`)
    }
    await this.ctx.devices.remove(childDeviceId)
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
  }
}
