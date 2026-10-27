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
import { enpalBoxSchema, readConnection } from '../config.js'
import { availableSpecs, findSpec } from '../enpal-catalog.js'
import { buildCandidates, parseSpecNativeId, specNativeId } from '../enpal-discovery.js'
import { EnpalIntegrationManager } from '../enpal-integration-manager.js'
import { enpalBoxes } from '../enpal-resolver.js'
import { EnpalSensorDevice } from './enpal-sensor-device.js'

/**
 * One Enpal box, a {@link DeviceType.Hub} device. The connection (host, InfluxDB access,
 * token) lives on this device's config; it owns the poller, publishes it on
 * {@link enpalBoxes} and registers `device-discovery` so the operator adopts the data groups
 * the box actually reports (PV, battery, grid, house, heat pump) as Sensor children.
 */
export class EnpalBoxDevice extends BaseDevice<typeof enpalBoxSchema> {
  readonly features: readonly DeviceFeature[] = []

  private manager: EnpalIntegrationManager | null = null
  private readonly eventUnsubscribers: Array<() => void> = []

  constructor(ctx: DeviceContext) {
    enpalBoxSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, enpalBoxSchema, { type: DeviceType.Hub })
    this.online = false
    this.registerDeviceDiscovery()
    void this.updateSourceInfo({ id: this.stableId, system: 'enpal' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // start() never throws: a box that is off is an `error` status, polled again later.
    void this.ensureManager().catch((err) => {
      this.ctx.logger.warn('Enpal box: start failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    })
    this.eventUnsubscribers.push(
      this.ctx.eventBus.subscribe({ category: EventCategory.DeviceUnregistered }, (event) => {
        const data = event.data as { parentDeviceId?: number | null }
        if (data.parentDeviceId !== this.id) return
        void this.refreshDiscovery().catch(() => undefined)
      }),
    )
  }

  override async removeDevice(): Promise<void> {
    for (const unsub of this.eventUnsubscribers) unsub()
    this.eventUnsubscribers.length = 0
    await this.stopManager()
    await super.removeDevice()
  }

  override async applySettingsPatch(patch: Record<string, unknown>): Promise<void> {
    if (!('connection' in patch)) return
    const parsed = enpalBoxSchema.parse({ connection: patch['connection'], system: 'enpal-box' })
    await this.config.setAll({ connection: parsed.connection })
    await this.stopManager()
    await this.ensureManager()
  }

  private async stopManager(): Promise<void> {
    const mgr = this.manager
    this.manager = null
    enpalBoxes.set(this.stableId, null)
    if (mgr !== null) await mgr.stop()
  }

  private async ensureManager(): Promise<void> {
    if (this.manager !== null) return
    const { connection, tokenLocked } = readConnection(this.config.values.connection)
    const mgr = new EnpalIntegrationManager({
      id: this.stableId,
      name: this.name,
      connection,
      tokenLocked,
      logger: this.ctx.logger.withTags({ deviceId: this.id }),
      onConnected: () => this.setOnline(true),
      onDisconnected: () => {
        this.setOnline(false)
        enpalBoxes.emitSnapshot(this.stableId)
      },
      onPolled: () => {
        void this.refreshDiscovery().catch(() => undefined)
        enpalBoxes.emitSnapshot(this.stableId)
      },
    })
    this.manager = mgr
    enpalBoxes.set(this.stableId, mgr)
    await mgr.start()
    // A box that never answered still has to tell its children.
    if (mgr.status === 'error') {
      this.setOnline(false)
      enpalBoxes.emitSnapshot(this.stableId)
    }
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return
    this.markOnline(online)
    this.ctx.logger.info('Enpal box ' + (online ? 'online' : 'offline'), {
      tags: { deviceId: this.id },
    })
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
        return (
          this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery')?.discovered ?? []
        )
      },
      refreshDiscovery: async ({ deviceId }): Promise<readonly DiscoveredChildDevice[]> => {
        if (deviceId !== this.id) return []
        await this.refreshDiscovery()
        return (
          this.runtimeState.getCapState<DeviceDiscoveryStatus>('device-discovery')?.discovered ?? []
        )
      },
      adoptDevice: async ({ deviceId, childNativeId, name }) => {
        if (deviceId !== this.id) {
          throw new Error(`adoptDevice: deviceId mismatch — got ${deviceId}, expected ${this.id}`)
        }
        return this.adopt(childNativeId, name)
      },
      releaseDevice: async ({ deviceId, childDeviceId }): Promise<void> => {
        if (deviceId !== this.id) return
        await this.release(childDeviceId)
      },
    }
    this.ctx.registerNativeCap(deviceDiscoveryCapability, provider)
    this.setCapSlice(deviceDiscoveryCapability, {
      discovered: [],
      lastDiscoveryAt: null,
      lastError: null,
      lastFetchedAt: 0,
    })
  }

  private async refreshDiscovery(): Promise<void> {
    const snapshot = enpalBoxes.getSnapshot(this.stableId)
    let lastError: string | null = null
    let discovered: readonly DiscoveredChildDevice[] = []
    if (snapshot === null) {
      lastError = enpalBoxes.getManager(this.stableId)?.lastError?.message ?? null
    } else {
      try {
        discovered = buildCandidates({
          boxId: this.stableId,
          boxName: this.name,
          specs: availableSpecs(snapshot),
          adoptedDeviceIdBySpec: await this.adoptedBySpec(),
          online: true,
        })
      } catch (err) {
        lastError = errMsg(err)
        this.ctx.logger.warn('Enpal box: discovery refresh failed', {
          tags: { deviceId: this.id },
          meta: { error: lastError },
        })
      }
    }
    this.runtimeState.setCapState(deviceDiscoveryCapability.name, {
      discovered,
      lastDiscoveryAt: Date.now(),
      lastError,
      lastFetchedAt: Date.now(),
    })
  }

  private async adoptedBySpec(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {}
    const children = await this.ctx.devices.getChildren(this.id).catch((): readonly IDevice[] => [])
    for (const child of children) {
      const cfg = await this.ctx.devices
        .loadConfig(child.id)
        .catch((): Record<string, unknown> => ({}))
      const specId = cfg['specId']
      if (typeof specId === 'string') out[specId] = child.id
    }
    return out
  }

  private async adopt(
    childNativeId: string,
    nameOverride?: string,
  ): Promise<{ deviceId: number; stableId: string }> {
    const specId = parseSpecNativeId(this.stableId, childNativeId)
    const spec = specId === null ? undefined : findSpec(specId)
    if (spec === undefined) {
      throw new Error(`adoptDevice: ${childNativeId} is not an Enpal device of this box`)
    }
    const existingId = (await this.adoptedBySpec())[spec.id]
    if (typeof existingId === 'number') {
      const existing = (await this.ctx.devices.getAll()).find((d) => d.id === existingId)
      if (existing) return { deviceId: existing.id, stableId: existing.stableId }
    }
    const name = nameOverride ?? `${this.name} ${spec.name}`
    const stableId = specNativeId(this.stableId, spec.id)
    const created = await this.ctx.devices.create(
      stableId,
      EnpalSensorDevice,
      { specId: spec.id, boxId: this.stableId, system: 'enpal', name },
      this.id,
      { type: DeviceType.Sensor, name, role: spec.role },
    )
    this.ctx.logger.info('Enpal box: adopted device', {
      tags: { deviceId: created.id },
      meta: { spec: spec.id, stableId },
    })
    await this.refreshDiscovery().catch(() => undefined)
    return { deviceId: created.id, stableId }
  }

  private async release(childDeviceId: number): Promise<void> {
    const child = (await this.ctx.devices.getAll()).find((d) => d.id === childDeviceId)
    if (!child || child.parentDeviceId !== this.id) {
      throw new Error(`releaseDevice: ${childDeviceId} is not a child of box ${this.id}`)
    }
    await this.ctx.devices.remove(childDeviceId)
    await this.refreshDiscovery().catch(() => undefined)
  }
}
