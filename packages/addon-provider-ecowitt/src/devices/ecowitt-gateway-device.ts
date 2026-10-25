import { buildDeviceAdminUrl, deviceAdminLinkCapability } from '@camstack/types'
import type { Sensor } from '@apocaliss92/nodewitt'
import {
  BaseDevice,
  type DeviceContext,
  type DeviceDiscoveryStatus,
  DeviceFeature,
  DeviceType,
  type DiscoveredChildDevice,
  deviceDiscoveryCapability,
  EventCategory,
  errMsg,
  type IDevice,
  type InferNativeProvider,
} from '@camstack/types'
import { ecowittGatewaySchema } from '../config.js'
import { buildEcowittGatewayCandidates, groupNativeId } from '../ecowitt-discovery.js'
import { ecowittFacades } from '../ecowitt-gateway.js'
import { EcowittIntegrationManager } from '../ecowitt-integration-manager.js'
import {
  deviceGroupForSensor,
  ECOWITT_DEVICE_GROUPS,
  type EcowittDeviceGroup,
} from '../ecowitt-mapping.js'
import { EcowittContainerDevice, type EcowittSensorEntry } from './ecowitt-container-device.js'

/**
 * Ecowitt gateway — a {@link DeviceType.Hub} device (standalone mode, Reolink
 * pattern). The operator-supplied CONNECTION lives on THIS device's config; the
 * gateway owns exactly one live `@apocaliss92/nodewitt` client (via an
 * {@link EcowittIntegrationManager}) keyed on its own `stableId` and published on
 * the in-process {@link ecowittFacades} resolver so its container + sensor
 * children read the live snapshot.
 *
 * It registers the `device-discovery` cap: `refreshDiscovery`/`listDiscovered`
 * enumerate the THREE gateway-group Container candidates (gateway /
 * weather-station / temp-sensor-ch1) that actually have sensors; `adoptDevice`
 * spawns a group {@link EcowittContainerDevice} child whose sensors materialise
 * as entity children; `releaseDevice` removes it. On every nodewitt snapshot the
 * gateway re-derives each adopted group Container's `sensors[]` additively.
 */
export class EcowittGatewayDevice extends BaseDevice<typeof ecowittGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  private manager: EcowittIntegrationManager | null = null
  private readonly eventUnsubscribers: Array<() => void> = []
  private latestSensors: readonly Sensor[] = []

  constructor(ctx: DeviceContext) {
    ecowittGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, ecowittGatewaySchema, { type: DeviceType.Hub })
    this.online = false
    this.registerDeviceDiscovery()
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: this.stableId, system: 'ecowitt' })
  }

  /**
   * device-admin-link — the gateway's own web page.
   *
   * Only the `local` transport knows an address. In `listener` transport the
   * gateway PUSHES to this hub and the addon never learns where it lives, so
   * `getAdminLink` answers null with the reason logged — a real "I cannot say"
   * for a device whose sibling gateway can.
   *
   * The children (the Container and each sensor) do NOT get this cap: a
   * battery radio sensor has no page anywhere, and the resolver they reach the
   * gateway through carries the live nodewitt client, not its connection
   * settings. Registering it on them would mean inventing a second copy of the
   * gateway's address in a consumer, which D224 forbids for exactly the reason
   * it would bite here — the operator edits that address on the gateway.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `EcowittGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = this.config.values.connection
        if (connection.transport !== 'local') {
          this.ctx.logger.debug(
            'ecowitt admin link unavailable: listener transport has no address',
            {
              tags: { deviceId: this.id },
              meta: { transport: connection.transport },
            },
          )
          return null
        }
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: connection.port,
          scheme: 'http',
          path: '/',
        })
        if (!built.ok) {
          this.ctx.logger.debug('ecowitt admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'Gateway page',
          target: 'device' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }

  /** Adopt a pre-built manager (created by `onCreateDevice` so the live client
   *  starts once) — mirrors `ReolinkHub.adoptApi`. Published on the resolver so
   *  children pick it up. */
  adoptManager(manager: EcowittIntegrationManager): void {
    this.manager = manager
    const facade = manager.facade
    if (facade !== null) ecowittFacades.set(this.stableId, facade)
  }

  override async onActivate(): Promise<void> {
    // Best-effort first dial. A manager may already be adopted from create; on
    // restore we build + start one here. Failures are logged; the library keeps
    // retrying (poll) or stays bound (listener).
    if (this.manager === null) {
      void this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Ecowitt gateway initial connect failed', {
          meta: { error: errMsg(err) },
        })
      })
    } else {
      // Adopted-from-create: seed the discovery slice from the current snapshot.
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
    ecowittFacades.set(this.stableId, null)
    if (mgr) {
      try {
        await mgr.stop()
      } catch (err) {
        this.ctx.logger.warn('Ecowitt gateway: client stop failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    // Only the nested `connection` blob is operator-editable here; a change
    // rebuilds the terminal-stop client. Re-parse through the schema so defaults
    // + the discriminated union apply.
    if (!('connection' in patch)) return
    const parsed = ecowittGatewaySchema.parse({
      connection: patch['connection'],
      system: 'ecowitt-gateway',
    })
    await this.config.setAll({ connection: parsed.connection })
    const mgr = this.manager
    if (mgr) {
      try {
        await mgr.applyConnection(parsed.connection)
      } catch (err) {
        this.ctx.logger.warn('Ecowitt gateway: applyConnection failed', {
          meta: { error: errMsg(err) },
        })
      }
    } else {
      await this.ensureManager().catch((err) => {
        this.ctx.logger.warn('Ecowitt gateway re-connect after settings change failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  // ── Live client lifecycle ────────────────────────────────────────────────

  /** Build + start the per-device nodewitt client (if not already running). */
  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const connection = this.config.values.connection
    const mgr = new EcowittIntegrationManager({
      id: this.stableId,
      name: this.name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => this.setGatewayOnline(true),
      onDisconnected: () => this.setGatewayOnline(false),
      onSensorsChanged: (_id, sensors) => this.handleSensorsChanged(sensors),
      onFacadeBuilt: (_id, facade) => ecowittFacades.set(this.stableId, facade),
    })
    this.manager = mgr
    await mgr.start()
  }

  private setGatewayOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('Ecowitt gateway ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
    // Propagate to adopted group Containers (children).
    void this.setContainersOnline(online).catch(() => {
      /* best-effort */
    })
  }

  private async setContainersOnline(online: boolean): Promise<void> {
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Container) continue
      if (child.online === online) continue
      child.markOnline(online)
    }
  }

  /** On each snapshot: cache sensors, re-derive discovery, additively reconcile
   *  every adopted group Container's `sensors[]`. */
  private handleSensorsChanged(sensors: readonly Sensor[]): void {
    this.latestSensors = sensors
    void this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    void this.reconcileGroupSensors(sensors).catch((err) => {
      this.ctx.logger.warn('Ecowitt gateway: sensor reconcile failed', {
        meta: { error: errMsg(err) },
      })
    })
    // Fan this single facade snapshot out to all sensor/container children via
    // the shared bus (they no longer each subscribe to the facade directly).
    ecowittFacades.emitSnapshot(this.stableId)
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
        return this.adoptGroupContainer(childNativeId, name)
      },
      releaseDevice: async ({ deviceId, childDeviceId }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.releaseGroupContainer(childDeviceId)
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

  /** Enumerate the three gateway-group Container candidates from the live client
   *  snapshot, flag `alreadyAdopted` per group, persist into the slice. */
  private async refreshDiscoveryFromClient(): Promise<void> {
    let lastError: string | null = null
    let discovered: readonly DiscoveredChildDevice[] = []
    try {
      const facade = ecowittFacades.get(this.stableId)
      const sensors = facade?.getSensors() ?? this.latestSensors
      const adoptedByGroup = await this.adoptedContainerIdByGroup()
      discovered = buildEcowittGatewayCandidates({
        gatewayId: this.stableId,
        gatewayName: this.name,
        sensors,
        adoptedDeviceIdByGroup: adoptedByGroup,
      })
    } catch (err) {
      lastError = errMsg(err)
      this.ctx.logger.warn('Ecowitt gateway discovery refresh failed', {
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

  /** Map each device group → the adopted group Container's device id (null when
   *  not adopted), by walking this gateway's direct children. */
  private async adoptedContainerIdByGroup(): Promise<
    Partial<Record<EcowittDeviceGroup, number | null>>
  > {
    const out: Partial<Record<EcowittDeviceGroup, number | null>> = {}
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Container) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      if (cfg['system'] !== 'ecowitt') continue
      out[configDeviceGroup(cfg)] = child.id
    }
    return out
  }

  /** Promote a discovered group candidate to a real group Container child. */
  private async adoptGroupContainer(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const group = ECOWITT_DEVICE_GROUPS.find(
      (g) => groupNativeId(this.stableId, g) === childNativeId,
    )
    if (group === undefined) {
      throw new Error(`adoptDevice: ${childNativeId} does not match any gateway group`)
    }

    // Idempotent: return the existing child when this group is already adopted.
    const existingByGroup = await this.adoptedContainerIdByGroup()
    const existingId = existingByGroup[group]
    if (typeof existingId === 'number') {
      const all = await this.ctx.devices.getAll()
      const existing = all.find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }

    const sensors: EcowittSensorEntry[] = (
      ecowittFacades.get(this.stableId)?.getSensors() ?? this.latestSensors
    )
      .filter((s) => deviceGroupForSensor(s.category, s.channel) === group)
      .map(sensorToEntry)

    const name = nameOverride ?? `${this.name} — ${group}`
    const config: Record<string, unknown> = {
      gatewayId: this.stableId,
      deviceGroup: group,
      sensors,
      system: 'ecowitt',
      name,
    }
    const stableId = `${this.stableId}:${group}`
    const created = await this.ctx.devices.create(
      stableId,
      EcowittContainerDevice,
      config,
      this.id,
      { type: DeviceType.Container, name },
    )
    this.ctx.logger.info('Ecowitt gateway: adopted group container', {
      tags: { deviceId: created.id },
      meta: { group, stableId, sensorCount: sensors.length },
    })
    await this.refreshDiscoveryFromClient().catch(() => {
      /* best-effort */
    })
    return { deviceId: created.id, stableId }
  }

  private async releaseGroupContainer(childDeviceId: number): Promise<void> {
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

  // ── Additive sensor reconcile ────────────────────────────────────────────

  /** Re-derive every adopted group Container's `sensors[]` from the live
   *  snapshot (group-filtered) and re-persist via `applyDerivedSpec` when it
   *  changed. Best-effort. */
  private async reconcileGroupSensors(sensors: readonly Sensor[]): Promise<void> {
    const byGroup = bucketSensorsByGroup(sensors)
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      if (child.type !== DeviceType.Container) continue
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      if (cfg['system'] !== 'ecowitt') continue
      const group = configDeviceGroup(cfg)
      const nextSensors = byGroup.get(group) ?? []
      const current = Array.isArray(cfg['sensors']) ? cfg['sensors'] : []
      if (sensorsEqual(current, nextSensors)) continue
      await this.ctx.devices.applyDerivedSpec(child.id, { config: { sensors: nextSensors } })
      this.ctx.logger.info('Ecowitt gateway: group sensors reconciled', {
        meta: { deviceId: child.id, group, sensorCount: nextSensors.length },
      })
    }
  }
}

/** Resolve `deviceGroup` from a persisted container config (defaults to 'gateway'). */
function configDeviceGroup(config: Record<string, unknown>): EcowittDeviceGroup {
  const g = config['deviceGroup']
  return ECOWITT_DEVICE_GROUPS.find((group) => group === g) ?? 'gateway'
}

/** Build the persisted sensor entry (incl. self-describing category) from a live Sensor. */
function sensorToEntry(s: Sensor): EcowittSensorEntry {
  return {
    sensorId: s.id,
    quantity: s.quantity,
    ...(s.channel !== undefined ? { channel: s.channel } : {}),
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.category !== undefined ? { category: s.category } : {}),
  }
}

/** Bucket live sensors into their device group. */
function bucketSensorsByGroup(
  sensors: readonly Sensor[],
): Map<EcowittDeviceGroup, EcowittSensorEntry[]> {
  const byGroup = new Map<EcowittDeviceGroup, EcowittSensorEntry[]>()
  for (const group of ECOWITT_DEVICE_GROUPS) byGroup.set(group, [])
  for (const s of sensors) {
    const group = deviceGroupForSensor(s.category, s.channel)
    byGroup.get(group)?.push(sensorToEntry(s))
  }
  return byGroup
}

/** Structural equality of two persisted sensor lists (order-independent by id + name). */
function sensorsEqual(a: readonly unknown[], b: readonly EcowittSensorEntry[]): boolean {
  if (a.length !== b.length) return false
  const aById = new Map<string, string | undefined>()
  for (const entry of a) {
    if (typeof entry === 'object' && entry !== null && 'sensorId' in entry) {
      const id = entry.sensorId
      if (typeof id === 'string') {
        const name = 'name' in entry && typeof entry.name === 'string' ? entry.name : undefined
        aById.set(id, name)
      }
    }
  }
  for (const entry of b) {
    if (!aById.has(entry.sensorId)) return false
    if (aById.get(entry.sensorId) !== entry.name) return false
  }
  return true
}
