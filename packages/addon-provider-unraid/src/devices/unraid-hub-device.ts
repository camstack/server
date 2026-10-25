import { registerUnraidAdminLink } from '../unraid-admin-link.js'
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
import { unraidHubSchema } from '../config.js'
import { buildInstanceCandidate, instanceNativeId } from '../unraid-discovery.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import { UnraidIntegrationManager } from '../unraid-integration-manager.js'
import { buildEntityIdentities, type UnraidEntityIdentity } from '../unraid-mapping.js'
import { UnraidInstanceDevice } from './unraid-instance-device.js'

/**
 * Unraid instance Hub — a {@link DeviceType.Hub} device (standalone mode, the
 * Reolink / Ecowitt / Velux pattern). The operator-supplied CONNECTION lives on
 * THIS device's config; the Hub owns exactly one live client (via a
 * {@link UnraidIntegrationManager}) keyed on its own `stableId` and published on
 * the in-process {@link unraidInstances} resolver so its Container + entity
 * children read the live snapshot.
 *
 * It registers the `device-discovery` cap and advertises exactly ONE candidate:
 * the instance itself, adopted as a {@link DeviceType.Container}
 * ({@link UnraidInstanceDevice}) whose array / disk / docker / notification
 * entities materialise as accessory children. On every poll the Hub re-derives
 * that Container's `entities[]` additively from the fresh snapshot.
 */
export class UnraidHubDevice extends BaseDevice<typeof unraidHubSchema> {
  readonly features: readonly DeviceFeature[] = []

  private manager: UnraidIntegrationManager | null = null
  private readonly eventUnsubscribers: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    unraidHubSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unraidHubSchema, { type: DeviceType.Hub })
    this.online = false
    this.registerDeviceDiscovery()
    // device-admin-link — the Hub HOLDS the WebGUI connection, and the
    // operator edits it, so the reader re-reads it on every call rather than
    // capturing it at construction.
    registerUnraidAdminLink(
      ctx,
      this.id,
      { kind: 'own', connection: this.config.values.connection },
      () => this.config.values.connection,
    )
    void this.updateSourceInfo({ id: this.stableId, system: 'unraid' })
  }

  /** Adopt a pre-built manager (created by `onCreateDevice` so the live client
   *  connects once). Published on the resolver so children pick it up. */
  adoptManager(manager: UnraidIntegrationManager): void {
    this.manager = manager
    unraidInstances.set(this.stableId, manager)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    if (this.manager === null) {
      void this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Unraid hub initial connect failed', {
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
    unraidInstances.set(this.stableId, null)
    if (mgr) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('Unraid hub: client stop failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
    await super.removeDevice()
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    if (!('connection' in patch)) return
    const parsed = unraidHubSchema.parse({
      connection: patch['connection'],
      system: 'unraid-hub',
    })
    await this.config.setAll({ connection: parsed.connection })
    const mgr = this.manager
    if (mgr) {
      try {
        await mgr.applyConnection(parsed.connection)
      } catch (err) {
        this.ctx.logger.warn('Unraid hub: applyConnection failed', {
          meta: { error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Unraid hub re-connect after settings change failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  // ── Live client lifecycle ──────────────────────────────────────────────────

  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const connection = this.config.values.connection
    const mgr = new UnraidIntegrationManager({
      id: this.stableId,
      name: this.name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => this.setInstanceOnline(true),
      onDisconnected: () => this.setInstanceOnline(false),
      onPolled: (instanceId) => this.handlePolled(instanceId),
    })
    this.manager = mgr
    unraidInstances.set(this.stableId, mgr)
    await mgr.start()
  }

  private setInstanceOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('Unraid hub ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
    void this.setContainerOnline(online).catch(() => {
      /* best-effort */
    })
  }

  private async setContainerOnline(online: boolean): Promise<void> {
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Container) continue
      if (child.online === online) continue
      child.markOnline(online)
    }
  }

  /** On each poll tick: re-derive discovery + reconcile entities + fan out. */
  private handlePolled(instanceId: string): void {
    void this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    void this.reconcileEntities().catch((err) => {
      this.ctx.logger.warn('Unraid hub: entity reconcile failed', {
        meta: { error: errMsg(err) },
      })
    })
    unraidInstances.emitSnapshot(instanceId)
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
        return this.adoptInstance(childNativeId, name)
      },
      releaseDevice: async ({ deviceId, childDeviceId }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.releaseInstance(childDeviceId)
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

  /** Enumerate the single instance Container candidate, flag `alreadyAdopted`,
   *  persist into the discovery slice. */
  private async refreshDiscoveryFromClient(): Promise<void> {
    let lastError: string | null = null
    let discovered: readonly DiscoveredChildDevice[] = []
    try {
      const adoptedDeviceId = await this.adoptedInstanceId()
      discovered = [
        buildInstanceCandidate({
          instanceId: this.stableId,
          instanceName: this.name,
          online: unraidInstances.getSnapshot(this.stableId) !== null,
          adoptedDeviceId,
        }),
      ]
    } catch (err) {
      lastError = errMsg(err)
      this.ctx.logger.warn('Unraid hub discovery refresh failed', {
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

  /** The adopted instance Container's device id, or null when not adopted. */
  private async adoptedInstanceId(): Promise<number | null> {
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Container) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      if (cfg['system'] === 'unraid') return child.id
    }
    return null
  }

  /** Promote the discovered candidate to the real instance Container child. */
  private async adoptInstance(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    if (childNativeId !== instanceNativeId(this.stableId)) {
      throw new Error(`adoptDevice: ${childNativeId} is not this instance's candidate`)
    }

    // Idempotent: return the existing Container when already adopted.
    const existingId = await this.adoptedInstanceId()
    if (existingId !== null) {
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }

    const entities = this.currentIdentities()
    const name = nameOverride ?? this.name
    const config: Record<string, unknown> = {
      instanceId: this.stableId,
      entities,
      system: 'unraid',
      name,
    }
    const stableId = instanceNativeId(this.stableId)
    const created = await this.ctx.devices.create(stableId, UnraidInstanceDevice, config, this.id, {
      type: DeviceType.Container,
      name,
    })
    this.ctx.logger.info('Unraid hub: adopted instance container', {
      tags: { deviceId: created.id },
      meta: { stableId, entityCount: entities.length },
    })
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    return { deviceId: created.id, stableId }
  }

  private async releaseInstance(childDeviceId: number): Promise<void> {
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

  // ── Additive entity reconcile ───────────────────────────────────────────────

  /** The entity identity list for the current snapshot (empty before first poll). */
  private currentIdentities(): readonly UnraidEntityIdentity[] {
    const snapshot = unraidInstances.getSnapshot(this.stableId)
    if (snapshot === null) return []
    return buildEntityIdentities(snapshot)
  }

  /** Re-derive the adopted Container's `entities[]` from the live snapshot and
   *  re-persist via `applyDerivedSpec` when it changed. Best-effort. */
  private async reconcileEntities(): Promise<void> {
    const next = this.currentIdentities()
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Container) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      if (cfg['system'] !== 'unraid') continue
      const current = Array.isArray(cfg['entities']) ? cfg['entities'] : []
      if (identitiesEqual(current, next)) continue
      await this.ctx.devices.applyDerivedSpec(child.id, { config: { entities: next } })
      this.ctx.logger.info('Unraid hub: entities reconciled', {
        meta: { deviceId: child.id, entityCount: next.length },
      })
    }
  }
}

/** Structural equality of a persisted identity list vs a freshly-derived one.
 *  Order is deterministic (the mapping emits a stable order), so a positional
 *  JSON compare is sufficient and cheap. */
function identitiesEqual(a: readonly unknown[], b: readonly UnraidEntityIdentity[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < b.length; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
  }
  return true
}
