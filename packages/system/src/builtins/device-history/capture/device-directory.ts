/**
 * Which devices exist and what type they are — the "real devices only" gate
 * (`hub` and `container` are not devices anyone charts) and the
 * `excludeDeviceTypes` gate of a history field.
 *
 * Built from `deviceManager.listAll({ projection: 'slim' })` at boot and every
 * reconcile, and per device (`getDevice`) the first time a state event names one
 * the map does not know. A FAILED read changes nothing (D49): the previous map
 * stays, and the failure is counted and logged, never read as "no devices".
 */
import { DeviceType, type IScopedLogger } from '@camstack/types'
import type { HistoryCounters } from '../status/counters.js'

export interface DeviceTypeSource {
  listAll(): Promise<readonly { readonly id: number; readonly type: DeviceType }[]>
  getDevice(deviceId: number): Promise<{ readonly id: number; readonly type: DeviceType } | null>
}

export function isRealDeviceType(type: DeviceType): boolean {
  return type !== DeviceType.Hub && type !== DeviceType.Container
}

export class DeviceDirectory {
  private types = new Map<number, DeviceType>()
  private readonly inflight = new Map<number, Promise<DeviceType | undefined>>()
  private refreshInflight: Promise<boolean> | null = null
  private lastFullRefreshAt: number | null = null

  constructor(
    private readonly source: DeviceTypeSource,
    private readonly counters: HistoryCounters,
    private readonly logger: IScopedLogger,
    private readonly clock: () => number,
  ) {}

  typeOf(deviceId: number): DeviceType | undefined {
    return this.types.get(deviceId)
  }

  size(): number {
    return this.types.size
  }

  /** When the full listing last ANSWERED; `null` before the first answer. */
  lastRefreshAt(): number | null {
    return this.lastFullRefreshAt
  }

  /** Ids in the directory now (the last full listing plus per-device lookups). */
  listedIds(): ReadonlySet<number> {
    return new Set(this.types.keys())
  }

  knows(deviceId: number): boolean {
    return this.types.has(deviceId)
  }

  /** Replace the map from the full listing. Returns false (map untouched) when the read failed. */
  refresh(): Promise<boolean> {
    if (this.refreshInflight !== null) return this.refreshInflight
    const run = this.doRefresh().finally(() => {
      this.refreshInflight = null
    })
    this.refreshInflight = run
    return run
  }

  private async doRefresh(): Promise<boolean> {
    try {
      const all = await this.source.listAll()
      this.types = new Map(all.map((d) => [d.id, d.type]))
      this.lastFullRefreshAt = this.clock()
      this.counters.directoryRefreshAt = this.lastFullRefreshAt
      return true
    } catch (err) {
      this.logger.warn('device directory: listing failed — keeping the previous map', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
  }

  /** The device's type, asking the hub once when the map does not know it. */
  ensure(deviceId: number): Promise<DeviceType | undefined> {
    const known = this.types.get(deviceId)
    if (known !== undefined) return Promise.resolve(known)
    const pending = this.inflight.get(deviceId)
    if (pending !== undefined) return pending
    const run = this.lookup(deviceId).finally(() => {
      this.inflight.delete(deviceId)
    })
    this.inflight.set(deviceId, run)
    return run
  }

  private async lookup(deviceId: number): Promise<DeviceType | undefined> {
    try {
      const device = await this.source.getDevice(deviceId)
      if (device === null) return undefined
      this.types.set(device.id, device.type)
      return device.type
    } catch (err) {
      this.logger.warn('device directory: lookup failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return undefined
    }
  }
}
