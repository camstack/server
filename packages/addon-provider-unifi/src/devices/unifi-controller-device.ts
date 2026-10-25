import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  type DeviceContext,
  type DeviceDiscoveryStatus,
  type DeviceFeature,
  DeviceType,
  type DiscoveredChildDevice,
  deviceDiscoveryCapability,
  errMsg,
  EventCategory,
  type IDevice,
  type InferNativeProvider,
} from '@camstack/types'
import { unifiControllerSchema } from '../config.js'
import {
  buildDiscoveryCandidates,
  clientNativeId,
  infraNativeId,
  parseNativeId,
} from '../unifi-discovery.js'
import { buildInfraFeatures, featuresEqual } from '../unifi-mapping.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { UnifiIntegrationManager } from '../unifi-integration-manager.js'
import { UnifiFeatureDevice } from './unifi-feature-device.js'
import { UnifiInfraDevice } from './unifi-infra-device.js'

/**
 * UniFi Network controller — a {@link DeviceType.Hub} device (standalone mode,
 * the Reolink / Ecowitt / Velux pattern). The operator-supplied CONNECTION lives
 * on THIS device's config; the controller owns exactly one live client (via a
 * {@link UnifiIntegrationManager}) keyed on its own `stableId` and published on
 * the in-process {@link unifiControllers} resolver so its infra + client children
 * read the live snapshot.
 *
 * It registers the `device-discovery` cap. Discovery enumerates TWO candidate
 * families:
 *   - infra devices → adopting one spawns a {@link UnifiInfraDevice}
 *     ({@link DeviceType.Container}) that fans out per-port PoE / restart / LED /
 *     sensor accessory children,
 *   - network clients → adopting one spawns a {@link UnifiFeatureDevice} with
 *     `kind: 'presence'` ({@link DeviceType.Presence}).
 * On every poll tick the controller re-derives discovery, additively reconciles
 * each adopted infra Container's `features[]`, and fans a snapshot out to all
 * children via the resolver.
 */
export class UnifiControllerDevice extends BaseDevice<typeof unifiControllerSchema> {
  readonly features: readonly DeviceFeature[] = []

  private manager: UnifiIntegrationManager | null = null
  private readonly eventUnsubscribers: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    unifiControllerSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unifiControllerSchema, { type: DeviceType.Hub })
    this.online = false
    this.registerDeviceDiscovery()
    registerUnifiAdminLink(ctx, this.id, {
      kind: 'own',
      read: () => this.config.values.connection,
    })
    void this.updateSourceInfo({ id: this.stableId, system: 'unifi' })
  }

  /** Adopt a pre-built manager (created by `onCreateDevice` so the live client
   *  connects once). Published on the resolver so children pick it up. */
  adoptManager(manager: UnifiIntegrationManager): void {
    this.manager = manager
    unifiControllers.set(this.stableId, manager)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    if (this.manager === null) {
      void this.ensureManager().catch((err) => {
        this.ctx.logger.warn('UniFi controller initial connect failed', {
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
    unifiControllers.set(this.stableId, null)
    if (mgr) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('UniFi controller: client stop failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
    await super.removeDevice()
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    if (!('connection' in patch)) return
    const parsed = unifiControllerSchema.parse({
      connection: patch['connection'],
      system: 'unifi-controller',
    })
    await this.config.setAll({ connection: parsed.connection })
    const mgr = this.manager
    if (mgr) {
      try {
        await mgr.applyConnection(parsed.connection)
      } catch (err) {
        this.ctx.logger.warn('UniFi controller: applyConnection failed', {
          meta: { error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('UniFi controller re-connect after settings change failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  // ── Live client lifecycle ────────────────────────────────────────────────

  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const connection = this.config.values.connection
    const mgr = new UnifiIntegrationManager({
      id: this.stableId,
      name: this.name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => this.setControllerOnline(true),
      onDisconnected: () => this.setControllerOnline(false),
      onPolled: (controllerId) => this.handlePolled(controllerId),
    })
    this.manager = mgr
    unifiControllers.set(this.stableId, mgr)
    await mgr.start()
  }

  private setControllerOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('UniFi controller ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
  }

  /** On each poll tick: re-derive discovery, reconcile infra features, fan out. */
  private handlePolled(controllerId: string): void {
    void this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    void this.reconcileInfraFeatures().catch((err) => {
      this.ctx.logger.warn('UniFi controller: feature reconcile failed', {
        meta: { error: errMsg(err) },
      })
    })
    unifiControllers.emitSnapshot(controllerId)
  }

  // ── device-discovery cap ─────────────────────────────────────────────────

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
        return this.adoptCandidate(childNativeId, name)
      },
      releaseDevice: async ({ deviceId, childDeviceId }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.releaseChild(childDeviceId)
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

  /** Enumerate infra + client candidates from the live client, flag
   *  `alreadyAdopted`, persist into the discovery slice. */
  private async refreshDiscoveryFromClient(): Promise<void> {
    let lastError: string | null = null
    let discovered: readonly DiscoveredChildDevice[] = []
    try {
      const infra = unifiControllers.getInfraList(this.stableId)
      const clients = unifiControllers.getClientList(this.stableId)
      const { infraById, clientByMac } = await this.adoptedChildIndex()
      discovered = buildDiscoveryCandidates({
        controllerId: this.stableId,
        controllerName: this.name,
        infra,
        clients,
        adoptedInfraIdById: infraById,
        adoptedClientIdByMac: clientByMac,
      })
    } catch (err) {
      lastError = errMsg(err)
      this.ctx.logger.warn('UniFi controller discovery refresh failed', {
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

  /** Index adopted children: infra id → deviceId (Container children) and client
   *  MAC → deviceId (Presence children). */
  private async adoptedChildIndex(): Promise<{
    infraById: Record<string, number | null>
    clientByMac: Record<string, number | null>
  }> {
    const infraById: Record<string, number | null> = {}
    const clientByMac: Record<string, number | null> = {}
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      if (cfg['system'] !== 'unifi') continue
      if (child.type === DeviceType.Container) {
        const id = cfg['infraNativeId']
        if (typeof id === 'string') infraById[id] = child.id
      } else if (child.type === DeviceType.Presence) {
        const mac = cfg['mac']
        if (typeof mac === 'string') clientByMac[mac] = child.id
      }
    }
    return { infraById, clientByMac }
  }

  /** Dispatch an adopt on the candidate's native-id family. */
  private async adoptCandidate(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const parsed = parseNativeId(childNativeId)
    if (parsed === null) {
      throw new Error(`adoptDevice: ${childNativeId} is not a UniFi candidate native id`)
    }
    if (parsed.kind === 'infra') return this.adoptInfra(parsed.id, nameOverride)
    return this.adoptClient(parsed.mac, nameOverride)
  }

  /** Promote a discovered infra candidate to a real infra Container child. */
  private async adoptInfra(
    id: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const infra = unifiControllers.getInfra(this.stableId, id)
    if (infra === null) {
      throw new Error(`adoptDevice: no UniFi infra device ${id} on this controller`)
    }

    const { infraById } = await this.adoptedChildIndex()
    const existingId = infraById[id]
    if (typeof existingId === 'number') {
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }

    const name = nameOverride ?? (infra.name.length > 0 ? infra.name : infra.model)
    const config: Record<string, unknown> = {
      controllerId: this.stableId,
      infraNativeId: id,
      model: infra.model,
      features: buildInfraFeatures(infra),
      system: 'unifi',
      name,
    }
    const stableId = infraNativeId(this.stableId, id)
    const created = await this.ctx.devices.create(stableId, UnifiInfraDevice, config, this.id, {
      type: DeviceType.Container,
      name,
    })
    this.ctx.logger.info('UniFi controller: adopted infra container', {
      tags: { deviceId: created.id },
      meta: { infraId: id, model: infra.model, stableId },
    })
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    return { deviceId: created.id, stableId }
  }

  /** Promote a discovered client candidate to a real Presence child. */
  private async adoptClient(
    mac: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const client = unifiControllers.getClient(this.stableId, mac)
    if (client === null) {
      throw new Error(`adoptDevice: no UniFi client ${mac} on this controller`)
    }

    const { clientByMac } = await this.adoptedChildIndex()
    const existingId = clientByMac[mac]
    if (typeof existingId === 'number') {
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }

    const name = nameOverride ?? (client.hostname.length > 0 ? client.hostname : mac)
    const config: Record<string, unknown> = {
      kind: 'presence',
      controllerId: this.stableId,
      mac,
      system: 'unifi',
      name,
    }
    const stableId = clientNativeId(this.stableId, mac)
    const created = await this.ctx.devices.create(stableId, UnifiFeatureDevice, config, this.id, {
      type: DeviceType.Presence,
      name,
    })
    this.ctx.logger.info('UniFi controller: adopted client presence', {
      tags: { deviceId: created.id },
      meta: { mac, stableId },
    })
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    return { deviceId: created.id, stableId }
  }

  private async releaseChild(childDeviceId: number): Promise<void> {
    const all = await this.ctx.devices.getAll()
    const child = all.find((d) => d.id === childDeviceId)
    if (!child || child.parentDeviceId !== this.id) {
      throw new Error(`releaseDevice: ${childDeviceId} is not a child of controller ${this.id}`)
    }
    await this.ctx.devices.remove(childDeviceId)
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
  }

  // ── Additive infra-feature reconcile ─────────────────────────────────────

  /** Re-derive every adopted infra Container's `features[]` from the live
   *  snapshot and re-persist via `applyDerivedSpec` when it changed. */
  private async reconcileInfraFeatures(): Promise<void> {
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Container) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      if (cfg['system'] !== 'unifi') continue
      const id = cfg['infraNativeId']
      if (typeof id !== 'string') continue
      const infra = unifiControllers.getInfra(this.stableId, id)
      if (infra === null) continue
      const nextFeatures = buildInfraFeatures(infra)
      const current = Array.isArray(cfg['features']) ? cfg['features'] : []
      if (featuresEqual(readDescriptors(current), nextFeatures)) continue
      await this.ctx.devices.applyDerivedSpec(child.id, { config: { features: nextFeatures } })
      this.ctx.logger.info('UniFi controller: infra features reconciled', {
        meta: { deviceId: child.id, infraId: id, featureCount: nextFeatures.length },
      })
    }
  }
}

/** Best-effort narrowing of a persisted `features[]` blob to descriptor shape for
 *  the equality check (only the discriminant fields are read). */
function readDescriptors(raw: readonly unknown[]): Array<{
  kind: 'switch' | 'button' | 'sensor'
  switchFeature?: 'poe' | 'led'
  buttonAction?: 'restart' | 'power-cycle'
  portIdx?: number
  metric?: 'cpu_utilization' | 'cpu_temperature' | 'clients' | 'state' | 'uptime'
}> {
  const out: ReturnType<typeof readDescriptors> = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec: Record<string, unknown> = Object.fromEntries(Object.entries(entry))
    const kind = rec['kind']
    if (kind !== 'switch' && kind !== 'button' && kind !== 'sensor') continue
    out.push({
      kind,
      ...(rec['switchFeature'] === 'poe' || rec['switchFeature'] === 'led'
        ? { switchFeature: rec['switchFeature'] }
        : {}),
      ...(rec['buttonAction'] === 'restart' || rec['buttonAction'] === 'power-cycle'
        ? { buttonAction: rec['buttonAction'] }
        : {}),
      ...(typeof rec['portIdx'] === 'number' ? { portIdx: rec['portIdx'] } : {}),
      ...(isMetric(rec['metric']) ? { metric: rec['metric'] } : {}),
    })
  }
  return out
}

/** Type guard for a persisted sensor-metric string. */
function isMetric(
  value: unknown,
): value is 'cpu_utilization' | 'cpu_temperature' | 'clients' | 'state' | 'uptime' {
  return (
    value === 'cpu_utilization' ||
    value === 'cpu_temperature' ||
    value === 'clients' ||
    value === 'state' ||
    value === 'uptime'
  )
}
