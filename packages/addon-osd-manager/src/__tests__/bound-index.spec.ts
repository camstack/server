/**
 * The render loop's work list is a DURABLE INDEX, reconciled in the background.
 *
 * What this replaces, measured on the boot of 2026-08-19: `start()` awaited
 * `reloadBoundDevices()`, which listed all 976 devices in the directory and read
 * each one's binding block over its own UDS round-trip, one at a time — 559 ms
 * each under boot load, 546 s total — and `start()` was awaited inside
 * `onInitialize()`. So for nine minutes the `osd-manager` and
 * `addon-pages-source` capabilities were absent CLUSTER-WIDE, and the answer the
 * nine minutes computed was `boundDevices = 0`.
 *
 * Three things fix it and all three are pinned here: the index makes boot a
 * single key read, the reconcile that keeps the index honest is CAMERAS ONLY and
 * fans out, and a reconcile can never destroy work on the strength of a read
 * that failed (D49).
 */
import { type IScopedLogger, type OsdSlotBinding, OsdSlotBindingSchema } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { BindingsHandle, OsdDeviceBindings } from '../bindings-store.js'
import { EMPTY_TEMPLATES } from '../templates-store.js'
import { EMPTY_BINDINGS } from '../bindings-store.js'
import type { BoundIndexHandle, OsdBoundIndex } from '../bound-index.js'
import { type OsdDeviceSummary, OsdManager, type OsdManagerDeps } from '../osd-manager.js'

const STATUS = {
  overlays: [
    { id: 'text-1', kind: 'text' as const, enabled: false, text: '', availablePositions: [] },
    { id: 'text-2', kind: 'text' as const, enabled: false, text: '', availablePositions: [] },
  ],
}

function binding(): OsdSlotBinding {
  return OsdSlotBindingSchema.parse({ source: { kind: 'static', text: 'hello' } })
}

interface Recorded {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: unknown
}

function recordingLogger(lines: Recorded[]): IScopedLogger {
  const at =
    (level: Recorded['level']) =>
    (message: string, extras?: unknown): void => {
      lines.push({ level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Deferred {
  readonly promise: Promise<void>
  readonly release: () => void
}

function deferred(): Deferred {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

interface Harness {
  readonly manager: OsdManager
  readonly lines: Recorded[]
  /** What is persisted under the index key. `null` ⇒ never written. */
  index(): OsdBoundIndex
  readonly counts: { listCameras: number; listDevices: number; bindingReads: number }
  readonly stored: Map<number, OsdDeviceBindings>
}

interface HarnessOptions {
  /** Bindings already in the per-device store, keyed by camera. */
  readonly bindings?: ReadonlyMap<number, OsdDeviceBindings>
  /** The persisted index. Omit for "never written". */
  readonly index?: readonly number[]
  /** Cameras `deviceManager.listAll({isCamera:true})` answers. */
  readonly cameras?: readonly number[]
  /** Cameras whose binding read THROWS. */
  readonly unreadable?: ReadonlySet<number>
  /** Held open, the camera scan cannot progress past `listCameras`. */
  readonly gate?: Deferred
  readonly overrides?: Partial<OsdManagerDeps>
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const lines: Recorded[] = []
  const stored = new Map<number, OsdDeviceBindings>(options.bindings ?? [])
  const counts = { listCameras: 0, listDevices: 0, bindingReads: 0 }
  let persisted: OsdBoundIndex = options.index === undefined ? null : [...options.index]

  const bindings = (deviceId: number): BindingsHandle => ({
    get: async () => {
      counts.bindingReads += 1
      if (options.unreadable?.has(deviceId) === true) {
        throw new Error(`settings store unreachable for ${deviceId}`)
      }
      return stored.get(deviceId) ?? EMPTY_BINDINGS
    },
    set: async (next) => {
      stored.set(deviceId, next)
    },
    update: async (fn) => {
      stored.set(deviceId, fn(stored.get(deviceId) ?? EMPTY_BINDINGS))
    },
  })

  const boundIndex: BoundIndexHandle = {
    get: async () => persisted,
    set: async (next) => {
      persisted = next === null ? null : [...next]
    },
  }

  const cameras: readonly OsdDeviceSummary[] = (options.cameras ?? []).map((id) => ({
    id,
    name: `cam-${id}`,
  }))

  const manager = new OsdManager({
    logger: recordingLogger(lines),
    readOsdStatus: async () => STATUS,
    writeOverlay: async () => undefined,
    readDeviceSnapshot: async () => ({}),
    listDevices: async () => {
      counts.listDevices += 1
      return cameras
    },
    listCameras: async () => {
      counts.listCameras += 1
      if (options.gate) await options.gate.promise
      return cameras
    },
    listDeviceCapsBatch: async () => new Map(),
    readLatestRecognitions: async () => ({}),
    bindings,
    boundIndex,
    templates: {
      get: async () => EMPTY_TEMPLATES,
      set: async () => undefined,
    },
    reconcileConcurrency: 4,
    ...options.overrides,
  })

  return { manager, lines, index: () => persisted, counts, stored }
}

describe('OsdManager — boot off the durable index', () => {
  it('has its work list before the camera scan has answered a single read', async () => {
    const gate = deferred()
    const h = makeHarness({ index: [101, 102], cameras: [101, 102], gate })

    await h.manager.start(10_000)

    // The scan is still blocked inside `listCameras`. The loop is already
    // correct — that is the whole point of the index.
    expect(h.manager.boundDeviceIds).toEqual([101, 102])
    expect(h.counts.bindingReads).toBe(0)

    gate.release()
    await h.manager.settleReconcile()
    h.manager.stop()
  })

  it('seeds the index from a scan the first time, and says which path it took', async () => {
    const h = makeHarness({
      cameras: [101, 102, 620],
      bindings: new Map([[102, { 'text-1': binding() }]]),
    })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    expect(h.index()).toEqual([102])
    expect(h.manager.boundDeviceIds).toEqual([102])
    const started = h.lines.find((line) => line.message.includes('render loop started'))
    const startedExtras = started?.extras as { meta?: { source?: string } } | undefined
    expect(startedExtras?.meta?.source).toBe('seed')
  })

  it('reconciles CAMERAS only — the other 946 devices are never read', async () => {
    const h = makeHarness({ cameras: [101, 102], index: [] })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    // Two cameras, two binding reads. The device directory is not walked at all.
    expect(h.counts.bindingReads).toBe(2)
    expect(h.counts.listDevices).toBe(0)
    expect(h.counts.listCameras).toBe(1)
  })

  it('overlaps the camera reads up to the bound', async () => {
    let inFlight = 0
    let peak = 0
    const h = makeHarness({
      cameras: [1, 2, 3, 4, 5, 6, 7, 8],
      index: [],
      overrides: {
        bindings: (): BindingsHandle => ({
          get: async () => {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            await new Promise<void>((resolve) => setTimeout(resolve, 2))
            inFlight -= 1
            return EMPTY_BINDINGS
          },
          set: async () => undefined,
          update: async () => undefined,
        }),
        reconcileConcurrency: 4,
      },
    })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    // The bound is a bound: the settings store is shared with every other addon
    // on this node, so a boot reconcile must never become the reason it queues.
    expect(peak).toBe(4)
  })
})

describe('OsdManager — the index is written where bindings are written', () => {
  it('records a camera the moment its first binding is saved', async () => {
    const h = makeHarness({ index: [], cameras: [101] })
    await h.manager.setSlotBinding({ deviceId: 101, slotId: 'text-1', binding: binding() })
    expect(h.index()).toEqual([101])
  })

  it('drops a camera when its LAST binding is cleared, and keeps it while others remain', async () => {
    const h = makeHarness({ index: [], cameras: [101] })
    await h.manager.setSlotBinding({ deviceId: 101, slotId: 'text-1', binding: binding() })
    await h.manager.setSlotBinding({ deviceId: 101, slotId: 'text-2', binding: binding() })

    await h.manager.clearSlotBinding({ deviceId: 101, slotId: 'text-1' })
    expect(h.index()).toEqual([101])

    await h.manager.clearSlotBinding({ deviceId: 101, slotId: 'text-2' })
    expect(h.index()).toEqual([])
  })

  it('follows a copy onto the target camera', async () => {
    const h = makeHarness({ index: [], cameras: [101, 616] })
    await h.manager.setSlotBinding({ deviceId: 101, slotId: 'text-1', binding: binding() })
    await h.manager.copyDeviceConfiguration({ sourceDeviceId: 101, targetDeviceId: 616 })
    expect(h.index()).toEqual([101, 616])
  })
})

describe('OsdManager — the reconcile keeps the index honest', () => {
  it('adds a camera the index missed, corrects it, and names it', async () => {
    const h = makeHarness({
      index: [101],
      cameras: [101, 102],
      bindings: new Map([
        [101, { 'text-1': binding() }],
        [102, { 'text-1': binding() }],
      ]),
    })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    expect(h.manager.boundDeviceIds).toEqual([101, 102])
    expect(h.index()).toEqual([101, 102])
    const diverged = h.lines.filter(
      (line) => line.level === 'warn' && line.message.includes('bound-device index'),
    )
    expect(diverged).toHaveLength(1)
    const divergedExtras = diverged[0]?.extras as { tags?: { deviceId?: number } } | undefined
    expect(divergedExtras?.tags).toEqual({ deviceId: 102 })
  })

  it('removes a camera the index claims but the store does not, and names it', async () => {
    const h = makeHarness({ index: [101, 102], cameras: [101, 102] })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    expect(h.manager.boundDeviceIds).toEqual([])
    expect(h.index()).toEqual([])
    const named = h.lines
      .filter((line) => line.level === 'warn' && line.message.includes('bound-device index'))
      .map((line) => (line.extras as { tags?: { deviceId?: number } }).tags?.deviceId)
    expect(named.toSorted((a, b) => Number(a) - Number(b))).toEqual([101, 102])
  })

  it('a binding read that FAILS never unbinds a camera (D49)', async () => {
    const h = makeHarness({
      index: [101, 102],
      cameras: [101, 102],
      bindings: new Map([[101, { 'text-1': binding() }]]),
      unreadable: new Set([102]),
    })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    // 102 stays: a read that failed decides nothing. 101 is proven bound.
    expect(h.manager.boundDeviceIds).toEqual([101, 102])
    expect(h.index()).toEqual([101, 102])
  })

  it('a camera missing from the listing is left alone — it may just not be restored yet', async () => {
    // The device restore pass runs for minutes after boot (D167). A camera the
    // directory has not published yet is not an unbound camera.
    const h = makeHarness({ index: [101, 102], cameras: [101] })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    expect(h.manager.boundDeviceIds).toEqual([102])
    expect(h.index()).toEqual([102])
  })

  it('an unreachable camera list leaves the index untouched and says so', async () => {
    const h = makeHarness({
      index: [101],
      overrides: {
        listCameras: async () => {
          throw new Error('device-manager not ready')
        },
      },
    })

    await h.manager.start(10_000)
    await h.manager.settleReconcile()
    h.manager.stop()

    expect(h.manager.boundDeviceIds).toEqual([101])
    expect(h.index()).toEqual([101])
    expect(h.lines.some((line) => line.level === 'warn')).toBe(true)
  })
})

describe('OsdManager.start — the boot path itself', () => {
  it('returns without waiting for the reconcile', async () => {
    const gate = deferred()
    const h = makeHarness({ index: [101], cameras: [101], gate })
    const spy = vi.fn()

    await h.manager.start(10_000)
    spy()
    expect(spy).toHaveBeenCalled()

    gate.release()
    await h.manager.settleReconcile()
    h.manager.stop()
  })
})
