/**
 * An exposed accessory follows its device: it is rebuilt when an input of its
 * SHAPE moves, and only then.
 *
 * The case that cost rings (615, 2026-11-11..17): a camera whose `doorbell` is
 * grafted by a composition block. A hub boot built the accessory before the
 * graft bound, so it came up a plain IP camera with no Doorbell service. The
 * persisted features already carried `doorbell-button`, the reconcile compared
 * the persisted key with a fresh key that ignored bindings, found them equal,
 * and logged "fingerprint unchanged, no rebuild" — for every boot.
 *
 * These drive the real attach → reconcile path; only the HAP build itself is
 * faked, and it reports the caps it saw exactly as the real mappers do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Accessory } from '@homebridge/hap-nodejs'
import { EventCategory } from '@camstack/types'
import type { DurableState, IScopedLogger, LogExtras, LogTags, SystemEvent } from '@camstack/types'
import type { z } from 'zod'
import { BridgeHost } from '../bridge-host.js'
import { BridgeInstance } from '../bridge-instance.js'
import type { ExposedConfigEntry } from '../hap-export-records.js'
import { ExportHapAddon, type ExportSyncStateSchema } from '../hap-export.addon.js'
import { HAP_DEFAULT_INSTANCE_ID } from '../hap-instance-kinds.js'
import { accessoryUuidFor } from '../mappers/kind.js'
import type { DeviceMapper } from '../mappers/types.js'
import { accessoryShapeKey, shapeCapsFor } from '../reconcile/accessory-shape.js'

type ExportSyncState = z.infer<typeof ExportSyncStateSchema>
type Handler = (event: SystemEvent) => void

const CAM = 615

interface FakeDevice {
  type: string
  name: string
  features: readonly string[]
  probed: boolean
  role?: string
}

interface Build {
  readonly caps: readonly string[]
  readonly name: string
  readonly uuid: string
}

interface LogLine {
  readonly msg: string
  readonly tags: LogTags
  readonly meta: LogExtras['meta']
}

/** A logger that records its info lines with the tags they were scoped to. */
function recordingLogger(sink: LogLine[], tags: LogTags = {}): IScopedLogger {
  const noop = (): void => {}
  return {
    debug: noop,
    info: (msg, extras) => {
      sink.push({ msg, tags, meta: extras?.meta })
    },
    warn: noop,
    error: noop,
    child: () => recordingLogger(sink, tags),
    withTags: (more) => recordingLogger(sink, { ...tags, ...more }),
  }
}

class TestAddon extends ExportHapAddon {
  device: FakeDevice = {
    type: 'camera',
    name: 'Front door',
    // Persisted from earlier boots — the composer's doorbell was bound then.
    features: ['doorbell-button', 'motion-trigger'],
    probed: true,
  }
  bindings: string[] = ['camera-streams', 'motion-detection', 'snapshot']
  /** The binding the forked context's cache serves; `null` until the first fetch. */
  cachedBindings: string[] | null = null
  /** How long one HAP build takes; a slow build is what lets two reconciles overlap. */
  buildMs = 0
  /** The per-device name store fails to answer (a transient settings read). */
  nameReadFails = false
  builds: Build[] = []
  disposed = 0
  /** Builds running at once, and the most ever seen: one device builds one at a time. */
  private building = 0
  maxBuilding = 0
  configWrites = 0
  infos: LogLine[] = []
  private readonly logger = recordingLogger(this.infos)
  private syncState: ExportSyncState = {}
  private handlers = new Map<EventCategory, Handler>()

  readonly inst = new BridgeInstance(
    HAP_DEFAULT_INSTANCE_ID,
    'Test bridge',
    { username: 'AA:BB:CC:DD:EE:FF', uuid: 'u', pincode: '031-45-154' },
    // The fake build publishes no accessory, so the (lazy) bridge is never brought up.
    new BridgeHost({
      displayName: 'Test bridge',
      uuid: 'u',
      pincode: '031-45-154',
      logger: recordingLogger([]),
    }),
    {
      name: 'HomeKit exposure',
      devices: [{ deviceId: String(CAM), displayName: 'Front door', mapperKind: 'camera' }],
      actions: [],
    },
  )

  constructor() {
    super()
    this.bridges.set(HAP_DEFAULT_INSTANCE_ID, this.inst)
  }

  override get ctx() {
    const fake = {
      api: {
        deviceManager: {
          getDevice: {
            query: async ({ deviceId }: { deviceId: number }) =>
              deviceId === CAM ? this.device : null,
          },
        },
      },
      // Mirrors the forked context: a cached binding is served until a fetch asks `fresh`.
      fetchDevice: async (_id: number, options?: { readonly fresh?: boolean }) => {
        if (options?.fresh === true || this.cachedBindings === null) {
          this.cachedBindings = [...this.bindings]
        }
        const served = this.cachedBindings ?? this.bindings
        return { binding: { entries: served.map((capName) => ({ capName })) } }
      },
      settings: {
        readDeviceStore: async () => {
          if (this.nameReadFails) throw new Error('settings store unavailable')
          return {}
        },
        writeDeviceStore: async () => {},
      },
      logger: this.logger,
      eventBus: {
        subscribe: (filter: { category: EventCategory }, handler: Handler) => {
          this.handlers.set(filter.category, handler)
          return () => this.handlers.delete(filter.category)
        },
      },
      addDisposer: () => () => {},
    }
    // The one type boundary of this harness: `AddonContext` has no test double
    // in the repo, and this fake implements only what the reconcile path reads.
    return fake as unknown as ExportHapAddon['ctx']
  }

  protected override readonly exportSyncState: DurableState<ExportSyncState> = {
    get: async () => this.syncState,
    set: async (next) => {
      this.syncState = next
    },
    update: async (fn) => {
      this.syncState = fn(this.syncState)
    },
  }

  protected override async buildMapper(
    inst: BridgeInstance,
    entry: ExposedConfigEntry,
  ): Promise<DeviceMapper> {
    const caps = shapeCapsFor(entry.mapperKind, this.bindings)
    const uuid = accessoryUuidFor(entry.mapperKind, Number(entry.deviceId), inst.id)
    this.building += 1
    this.maxBuilding = Math.max(this.maxBuilding, this.building)
    if (this.buildMs > 0) await new Promise((resolve) => setTimeout(resolve, this.buildMs))
    this.building -= 1
    this.builds.push({ caps, name: entry.displayName, uuid })
    return {
      accessory: new Accessory(entry.displayName, uuid),
      // Nothing to publish: the bridge and mDNS are not under test.
      accessories: [],
      builtFrom: { caps, role: null },
      dispose: async () => {
        this.disposed += 1
      },
    }
  }

  protected override async setExposedDevices(
    inst: BridgeInstance,
    devices: readonly ExposedConfigEntry[],
  ): Promise<void> {
    this.configWrites += 1
    inst.exposure = { ...inst.exposure, devices: [...devices] }
  }

  /** What `startInstance` does for each exposed entry at boot. */
  async boot(): Promise<void> {
    const entry = this.inst.findEntry(CAM)
    if (entry === null) throw new Error('no entry')
    await this.attachMapper(this.inst, entry)
    this.subscribeDeviceChangesForReconcile()
  }

  emit(category: EventCategory, data: Record<string, unknown> = { deviceId: CAM }): void {
    const event: SystemEvent = {
      id: `evt-${category}`,
      timestamp: new Date(),
      source: { type: 'device', id: CAM },
      category,
      data,
    }
    this.handlers.get(category)?.(event)
  }

  /** The key an earlier boot persisted for this device. */
  seedPersisted(fingerprint: string): void {
    this.syncState = { [String(CAM)]: { fingerprint, externalIds: ['uuid'] } }
  }

  get lastBuild(): Build | undefined {
    return this.builds.at(-1)
  }

  /** Accessories built and not torn down: must never exceed one per device. */
  get liveBuilds(): number {
    return this.builds.length - this.disposed
  }
}

/** Let the 500 ms debounce fire and the reconcile it starts finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(500)
  await vi.advanceTimersByTimeAsync(0)
}

let addon: TestAddon

beforeEach(() => {
  vi.useFakeTimers()
  addon = new TestAddon()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('accessory shape — rebuild when an input moves, and only then', () => {
  it('a doorbell bound after the boot rebuilds the camera as a doorbell, same accessory', async () => {
    await addon.boot()
    expect(addon.builds).toHaveLength(1)
    expect(addon.lastBuild?.caps).not.toContain('doorbell')

    addon.bindings = [...addon.bindings, 'doorbell']
    addon.emit(EventCategory.DeviceBindingsChanged)
    await settle()

    expect(addon.builds).toHaveLength(2)
    expect(addon.lastBuild?.caps).toContain('doorbell')
    // Same HAP identity: the Home app keeps the device and gains the doorbell.
    expect(addon.lastBuild?.uuid).toBe(addon.builds[0]?.uuid)
    const line = addon.infos.find((l) => l.msg.includes('rebuilding accessory'))
    expect(line?.tags).toEqual({ deviceId: CAM })
    expect(line?.meta?.['changed']).toBe('caps +doorbell')
  })

  it('a doorbell grafted after the boot rebuilds even when the context cache still serves the boot binding', async () => {
    await addon.boot()
    // The forked context cached the boot binding and the invalidating event was dropped.
    addon.cachedBindings = [...addon.bindings]
    addon.bindings = [...addon.bindings, 'doorbell']
    addon.emit(EventCategory.DeviceBindingsChanged)
    await settle()

    expect(addon.builds).toHaveLength(2)
    expect(addon.lastBuild?.caps).toContain('doorbell')
  })

  it('a boot that built while the device was still probing rebuilds once the doorbell binds', async () => {
    // An earlier boot advertised the full doorbell shape and persisted its key.
    addon.seedPersisted(
      accessoryShapeKey({
        inputs: {
          kind: 'camera',
          deviceType: 'camera',
          features: addon.device.features,
          caps: ['doorbell', 'motion-detection'],
          role: null,
          name: 'Front door',
        },
        recordability: null,
      }),
    )
    // This boot: the probe has not finished and the graft has not bound yet.
    addon.device = { ...addon.device, probed: false }
    await addon.boot()
    expect(addon.lastBuild?.caps).not.toContain('doorbell')

    addon.bindings = [...addon.bindings, 'doorbell']
    addon.device = { ...addon.device, probed: true }
    addon.emit(EventCategory.DeviceReady)
    await settle()

    expect(addon.builds).toHaveLength(2)
    expect(addon.lastBuild?.caps).toContain('doorbell')
  })

  it('a shape cap removed rebuilds the accessory without it', async () => {
    addon.bindings = [...addon.bindings, 'ptz']
    await addon.boot()
    expect(addon.lastBuild?.caps).toContain('ptz')

    addon.bindings = addon.bindings.filter((cap) => cap !== 'ptz')
    addon.emit(EventCategory.DeviceBindingsChanged)
    await settle()

    expect(addon.builds).toHaveLength(2)
    expect(addon.lastBuild?.caps).not.toContain('ptz')
    const line = addon.infos.find((l) => l.msg.includes('rebuilding accessory'))
    expect(line?.meta?.['changed']).toBe('caps -ptz')
  })

  it('a device rename rebuilds the accessory under the new name', async () => {
    await addon.boot()

    addon.device = { ...addon.device, name: 'Porch' }
    addon.emit(EventCategory.DeviceMetaChanged, { deviceId: CAM, field: 'name', value: 'Porch' })
    await settle()

    expect(addon.builds).toHaveLength(2)
    expect(addon.lastBuild?.name).toBe('Porch')
    expect(addon.lastBuild?.uuid).toBe(addon.builds[0]?.uuid)
  })

  it('a cap the accessory does not branch on rebinding rebuilds nothing', async () => {
    await addon.boot()

    addon.bindings = [...addon.bindings, 'recording']
    addon.emit(EventCategory.DeviceBindingsChanged)
    await settle()

    expect(addon.builds).toHaveLength(1)
  })

  it('a runtime state change rebuilds nothing', async () => {
    await addon.boot()

    addon.emit(EventCategory.DeviceStateChanged, {
      deviceId: CAM,
      capName: 'motion-detection',
      slice: { detected: true },
    })
    await settle()

    expect(addon.builds).toHaveLength(1)
  })

  it('bindings that answered nothing are unknown, not a shape with every cap gone', async () => {
    await addon.boot()

    addon.bindings = []
    addon.emit(EventCategory.DeviceBindingsChanged)
    await settle()

    expect(addon.builds).toHaveLength(1)
  })

  it('DeviceReady with an unchanged shape rebuilds nothing', async () => {
    await addon.boot()

    addon.emit(EventCategory.DeviceReady)
    await settle()

    expect(addon.builds).toHaveLength(1)
  })

  it('a meta change that is not a shape input rebuilds nothing', async () => {
    await addon.boot()

    addon.emit(EventCategory.DeviceMetaChanged, { deviceId: CAM, field: 'location', value: 'Hall' })
    await settle()

    expect(addon.builds).toHaveLength(1)
  })

  it('an unreadable name store is unknown: no rebuild, no rename written', async () => {
    addon.device = { ...addon.device, name: 'Porch' } // differs from the built "Front door"
    await addon.boot()
    addon.nameReadFails = true

    addon.emit(EventCategory.DeviceMetaChanged, { deviceId: CAM, field: 'location', value: 'Hall' })
    await settle()

    expect(addon.builds).toHaveLength(1)
    expect(addon.configWrites).toBe(0)
  })

  it('changes landing during a slow rebuild coalesce: one live accessory, latest shape', async () => {
    addon.buildMs = 2000
    const booted = addon.boot()
    await vi.advanceTimersByTimeAsync(2000)
    await booted

    addon.bindings = [...addon.bindings, 'battery']
    addon.emit(EventCategory.DeviceBindingsChanged)
    await vi.advanceTimersByTimeAsync(1000) // the first rebuild is now mid-build
    addon.bindings = [...addon.bindings, 'doorbell']
    addon.emit(EventCategory.DeviceBindingsChanged)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(addon.maxBuilding).toBe(1)
    expect(addon.liveBuilds).toBe(1)
    expect(addon.inst.exposed.size).toBe(1)
    expect(addon.lastBuild?.caps).toEqual(expect.arrayContaining(['battery', 'doorbell']))
  })

  it('a device unexposed during a rebuild stays unexposed', async () => {
    addon.buildMs = 2000
    const booted = addon.boot()
    await vi.advanceTimersByTimeAsync(2000)
    await booted

    addon.device = { ...addon.device, name: 'Porch' } // a rename: the rebuild would write config
    addon.emit(EventCategory.DeviceMetaChanged, { deviceId: CAM, field: 'name', value: 'Porch' })
    await vi.advanceTimersByTimeAsync(1000) // mid-build
    addon.inst.exposure = { ...addon.inst.exposure, devices: [] } // the operator unexposed it
    await vi.advanceTimersByTimeAsync(10_000)

    expect(addon.inst.exposure.devices).toEqual([])
    expect(addon.inst.exposed.size).toBe(0)
    expect(addon.liveBuilds).toBe(0)
  })
})
