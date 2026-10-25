/**
 * D696: the orchestrator is the only writer of a camera's `motion` runtime
 * slice, with the EFFECTIVE motion. It is fed by the motion events the
 * orchestrator already receives:
 * - the bridge's events (`triggeredBy` present) for a split camera;
 * - an unsplit provider's direct `onboard` event;
 * - the analyzer, and device activity.
 * The camera's `motionSources` decides which of them count, under D475's rule.
 *
 * The level is high from a counted `true` until that source's own `false`, or
 * until one window (the camera's cooldown, floored at two sustain ticks) after
 * its last `true`. So a source that never clears (Reolink, Wyze) cannot leave
 * the slice stuck ON.
 */
import {
  type IScopedLogger,
  MOTION_CLOSE_AFTER_MS,
  type MotionSources,
  type MotionStatus,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CameraIdsRead } from '../camera-sensors/controller.js'
import {
  CameraMotionSlice,
  camerasTheSliceOwns,
  type MotionSliceEdge,
  type MotionSliceRead,
} from '../camera-sensors/motion-slice.js'

const CAM = 103
const OTHER = 101
const WINDOW_MS = 30_000
const MAX_HOLD_MS = 120_000

interface Line {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

interface Written {
  readonly deviceId: number
  readonly slice: MotionStatus
}

interface HarnessOptions {
  readonly sources?: Readonly<Record<number, MotionSources | null>>
  readonly hubSlice?: Readonly<Record<number, MotionSliceRead>>
  readonly cameras?: CameraIdsRead
  readonly failWrites?: () => boolean
  /** Cameras the provider gate keeps closed (their provider may still write the slice). */
  readonly providerClosed?: Set<number>
}

function harness(options: HarnessOptions = {}) {
  const lines: Line[] = []
  const record =
    (level: string) =>
    (
      message: string,
      extras?: {
        tags?: Readonly<Record<string, unknown>>
        meta?: Readonly<Record<string, unknown>>
      },
    ): void => {
      lines.push({ level, message, deviceId: extras?.tags?.['deviceId'], meta: extras?.meta })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  const written: Written[] = []
  const reads: number[] = []
  let edgesWhileClosed = 0
  const providerClosed = options.providerClosed ?? new Set<number>()
  const slice = new CameraMotionSlice({
    logger,
    writeSlice: async (deviceId, s) => {
      if (options.failWrites?.() === true) throw new Error('hub refused')
      written.push({ deviceId, slice: s })
    },
    readSlice: async (deviceId) => {
      reads.push(deviceId)
      return options.hubSlice?.[deviceId] ?? { kind: 'answered', slice: null }
    },
    listCameraIds: async () => options.cameras ?? { kind: 'ids', ids: [CAM] },
    motionSourcesFor: (id) => {
      const s = options.sources?.[id]
      return s === undefined ? ['onboard'] : s
    },
    windowMsFor: () => WINDOW_MS,
    maxHoldMsFor: () => MAX_HOLD_MS,
    now: () => Date.now(),
    onEdgeWhileClosed: () => {
      edgesWhileClosed += 1
    },
    isCameraOpen: (id) => !providerClosed.has(id),
  })
  const setProviderOpen = (deviceId: number, open: boolean): Promise<void> => {
    if (open) providerClosed.delete(deviceId)
    else providerClosed.add(deviceId)
    return slice.camerasChanged([deviceId])
  }
  const edge = (patch: Partial<MotionSliceEdge> & Pick<MotionSliceEdge, 'detected'>): void =>
    slice.onMotion({
      deviceId: CAM,
      timestamp: Date.now(),
      source: 'onboard',
      viaBridge: true,
      ...patch,
    })
  const settle = async (): Promise<void> => {
    await slice.idle()
  }
  return {
    slice,
    lines,
    written,
    reads,
    edge,
    settle,
    edgesWhileClosed: () => edgesWhileClosed,
    setProviderOpen,
    detectedWrites: (deviceId = CAM) =>
      written.filter((w) => w.deviceId === deviceId).map((w) => w.slice.detected),
  }
}

/** Open the gate on a camera list nobody moved on, and let the grace window pass. */
async function openQuiet(h: ReturnType<typeof harness>): Promise<void> {
  await h.slice.setWriterOpen(true)
  await vi.advanceTimersByTimeAsync(WINDOW_MS)
  await h.settle()
}

describe('CameraMotionSlice (D696)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('the provider gate, per camera (D696 amended: an old provider may still write)', () => {
    it('a camera whose provider may still write is never written; another camera is', async () => {
      const h = harness({
        providerClosed: new Set([CAM]),
        cameras: { kind: 'ids', ids: [CAM, OTHER] },
      })
      await openQuiet(h)
      h.edge({ detected: true })
      h.edge({ deviceId: OTHER, detected: true })
      await h.settle()
      expect(h.detectedWrites(CAM)).toEqual([])
      expect(h.detectedWrites(OTHER)).toEqual([true])
      // Its edge lets the gate look again.
      expect(h.edgesWhileClosed()).toBe(1)
    })

    it('the takeover leaves a closed camera alone: no grace-window OFF over the old provider`s slice', async () => {
      const h = harness({
        providerClosed: new Set([CAM]),
        hubSlice: { [CAM]: { kind: 'answered', slice: { detected: true, lastDetectedAt: 5 } } },
      })
      await openQuiet(h)
      expect(h.written).toEqual([])
      expect(h.reads).toEqual([])
    })

    it('a camera opened later gets its OWN full grace window — none ran out while it was closed', async () => {
      const h = harness({
        providerClosed: new Set([CAM]),
        hubSlice: { [CAM]: { kind: 'answered', slice: { detected: true, lastDetectedAt: 5 } } },
      })
      await openQuiet(h)
      await vi.advanceTimersByTimeAsync(WINDOW_MS * 3)
      await h.setProviderOpen(CAM, true)
      await h.settle()
      // A live episode the old provider was in still has one window to re-assert.
      expect(h.detectedWrites()).toEqual([])
      await vi.advanceTimersByTimeAsync(WINDOW_MS)
      await h.settle()
      expect(h.detectedWrites()).toEqual([false])
    })

    it('the camera`s provider answering re-publishes that camera (its known level at once)', async () => {
      const h = harness({ providerClosed: new Set([CAM]) })
      await openQuiet(h)
      h.edge({ detected: true })
      await h.settle()
      expect(h.detectedWrites()).toEqual([])
      await h.setProviderOpen(CAM, true)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
    })

    it('a camera re-closed (its provider came back up) is not written again until it reopens', async () => {
      // The hub still holds the ON this instance wrote before the closure.
      const h = harness({
        hubSlice: {
          [CAM]: { kind: 'answered', slice: { detected: true, lastDetectedAt: 1_000_000 } },
        },
      })
      await openQuiet(h)
      h.edge({ detected: true })
      await h.settle()
      const before = h.detectedWrites()
      expect(before.at(-1)).toBe(true)
      await h.setProviderOpen(CAM, false)
      h.edge({ detected: false })
      await h.settle()
      expect(h.detectedWrites()).toEqual(before)
      await h.setProviderOpen(CAM, true)
      await h.settle()
      expect(h.detectedWrites()).toEqual([...before, false])
    })
  })

  describe('the writer gate', () => {
    it('writes nothing while closed, asks the gate to look again, and publishes what it saw when it opens', async () => {
      const h = harness()
      h.edge({ detected: true })
      await h.settle()
      expect(h.written).toEqual([])
      expect(h.edgesWhileClosed()).toBe(1)
      await h.slice.setWriterOpen(true)
      await h.settle()
      expect(h.written).toEqual([
        {
          deviceId: CAM,
          slice: {
            detected: true,
            lastDetectedAt: 1_000_000,
            autoClearAfterMs: MOTION_CLOSE_AFTER_MS,
          },
        },
      ])
      const line = h.lines.find((l) => l.message.includes('re-published'))
      expect(line).toMatchObject({ deviceId: CAM, meta: { reason: 'takeover', detected: true } })
    })

    it('the takeover writes the RISE`s stamp, not the last heartbeat`s', async () => {
      const h = harness()
      h.edge({ detected: true, timestamp: 5 })
      h.edge({ detected: true, timestamp: 6 })
      await h.slice.setWriterOpen(true)
      await h.settle()
      expect(h.written.map((w) => w.slice.lastDetectedAt)).toEqual([5])
    })

    it('a runner rollback closes the gate: it stops writing at once', async () => {
      const h = harness()
      await openQuiet(h)
      h.edge({ detected: true })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
      await h.slice.setWriterOpen(false)
      h.edge({ detected: false })
      await vi.advanceTimersByTimeAsync(WINDOW_MS * 2)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
    })
  })

  describe('edges', () => {
    it('one write per EFFECTIVE edge: heartbeats write nothing, the clear keeps lastDetectedAt', async () => {
      const h = harness()
      await openQuiet(h)
      const riseAt = Date.now()
      h.edge({ detected: true })
      vi.advanceTimersByTime(1_000)
      h.edge({ detected: true })
      vi.advanceTimersByTime(1_000)
      h.edge({ detected: true })
      h.edge({ detected: false })
      await h.settle()
      expect(h.written.map((w) => w.slice)).toEqual([
        { detected: true, lastDetectedAt: riseAt, autoClearAfterMs: MOTION_CLOSE_AFTER_MS },
        { detected: false, lastDetectedAt: riseAt, autoClearAfterMs: null },
      ])
    })

    it('a source that never clears falls one window after its last true — never stuck ON (D1)', async () => {
      const h = harness()
      await openQuiet(h)
      h.edge({ detected: true })
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 1)
      h.edge({ detected: true })
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 1)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
      await vi.advanceTimersByTimeAsync(1)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true, false])
    })

    it('lastDetectedAt moves only on an effective rise', async () => {
      const h = harness()
      await openQuiet(h)
      h.edge({ detected: true, timestamp: 5 })
      h.edge({ detected: true, timestamp: 6 })
      h.edge({ detected: false, timestamp: 7 })
      h.edge({ detected: true, timestamp: 8 })
      await h.settle()
      expect(h.written.map((w) => [w.slice.detected, w.slice.lastDetectedAt])).toEqual([
        [true, 5],
        [false, 5],
        [true, 8],
      ])
    })

    it('a failed write is said with the camera and retried by the next edge (D391)', async () => {
      let fail = true
      const h = harness({ failWrites: () => fail })
      await openQuiet(h)
      h.edge({ detected: true })
      await h.settle()
      expect(h.lines.find((l) => l.message.includes('write failed'))).toMatchObject({
        level: 'warn',
        deviceId: CAM,
      })
      fail = false
      h.edge({ detected: true })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
    })
  })

  describe('which input feeds each camera class', () => {
    it("an analyzer-only camera: the analyzer's edges are its motion", async () => {
      const h = harness({ sources: { [CAM]: ['analyzer'] } })
      await openQuiet(h)
      h.edge({ detected: true, source: 'analyzer', viaBridge: false })
      h.edge({ detected: false, source: 'analyzer', viaBridge: false })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true, false])
    })

    it('a sensor-owned camera ignores the analyzer, even when it lists it (D475)', async () => {
      const h = harness({ sources: { [CAM]: ['onboard', 'analyzer'] } })
      await openQuiet(h)
      h.edge({ detected: true, source: 'analyzer', viaBridge: false })
      await h.settle()
      expect(h.written).toEqual([])
      const line = h.lines.find((l) => l.message.includes('camera motion slice: input'))
      expect(line).toMatchObject({ deviceId: CAM, meta: { inputs: [], ignored: ['analyzer'] } })
    })

    it('device activity counts when listed, and OR-s with onboard', async () => {
      const h = harness({ sources: { [CAM]: ['onboard', 'device-activity'] } })
      await openQuiet(h)
      h.edge({ detected: true, source: 'device-activity', viaBridge: false })
      h.edge({ detected: true })
      h.edge({ detected: false })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
      h.edge({ detected: false, source: 'device-activity', viaBridge: false })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true, false])
    })

    it('an unsplit provider’s direct onboard event is the camera’s motion, and the class is said once per change', async () => {
      const h = harness()
      await openQuiet(h)
      h.edge({ detected: true, viaBridge: false })
      h.edge({ detected: true, viaBridge: false })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
      h.edge({ detected: true, viaBridge: true })
      h.edge({ detected: true, viaBridge: true })
      const classes = h.lines
        .filter((l) => l.message === 'camera motion slice: input')
        .map((l) => l.meta?.['inputs'])
      expect(classes).toEqual([['onboard:unsplit'], ['onboard:bridge']])
    })

    it('a camera with no active detection config: onboard counts, the analyzer does not', async () => {
      const h = harness({ sources: { [CAM]: null } })
      await openQuiet(h)
      h.edge({ detected: true, source: 'analyzer', viaBridge: false })
      await h.settle()
      expect(h.written).toEqual([])
      h.edge({ detected: true })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
    })

    it('an onboard event for a camera that does not list onboard is not its motion', async () => {
      const h = harness({ sources: { [CAM]: ['analyzer'] } })
      await openQuiet(h)
      h.edge({ detected: true })
      await h.settle()
      expect(h.written).toEqual([])
    })
  })

  describe('re-publish on boot / takeover (the grace window)', () => {
    const stuckOn: MotionSliceRead = {
      kind: 'answered',
      slice: { detected: true, lastDetectedAt: 42, autoClearAfterMs: MOTION_CLOSE_AFTER_MS },
    }

    it('a slice left ON with no motion within the window is published OFF, keeping its stamp', async () => {
      const h = harness({ hubSlice: { [CAM]: stuckOn } })
      await h.slice.setWriterOpen(true)
      await vi.advanceTimersByTimeAsync(WINDOW_MS - 1)
      await h.settle()
      expect(h.written).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await h.settle()
      expect(h.written).toEqual([
        { deviceId: CAM, slice: { detected: false, lastDetectedAt: 42, autoClearAfterMs: null } },
      ])
      expect(h.lines.find((l) => l.message.includes('re-published'))).toMatchObject({
        level: 'info',
        deviceId: CAM,
        meta: { reason: 'grace-expired', detected: false, graceMs: WINDOW_MS },
      })
    })

    it('motion inside the window continues the episode: no OFF blip', async () => {
      const h = harness({ hubSlice: { [CAM]: stuckOn } })
      await h.slice.setWriterOpen(true)
      await vi.advanceTimersByTimeAsync(WINDOW_MS / 2)
      h.edge({ detected: true })
      await vi.advanceTimersByTimeAsync(WINDOW_MS / 2)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
    })

    it('a slice already OFF needs no write; an unreadable one is said and left (D49)', async () => {
      const h = harness({
        cameras: { kind: 'ids', ids: [CAM, OTHER] },
        hubSlice: {
          [CAM]: {
            kind: 'answered',
            slice: { detected: false, lastDetectedAt: 1, autoClearAfterMs: null },
          },
          [OTHER]: { kind: 'unreadable', error: 'hub busy' },
        },
      })
      await openQuiet(h)
      expect(h.written).toEqual([])
      expect(h.lines.find((l) => l.message.includes('unreadable'))).toMatchObject({
        level: 'warn',
        deviceId: OTHER,
      })
    })

    it('an unreadable camera list re-publishes nothing, and says so', async () => {
      const h = harness({ cameras: { kind: 'unreadable', error: 'device manager down' } })
      await openQuiet(h)
      expect(h.reads).toEqual([])
      expect(h.lines.find((l) => l.message.includes('camera list unreadable'))?.level).toBe('warn')
    })

    it('a clear this instance never saw rise still reaches a stuck-ON slice', async () => {
      const h = harness({ hubSlice: { [CAM]: stuckOn } })
      await h.slice.setWriterOpen(true)
      h.edge({ detected: false })
      await h.settle()
      expect(h.written).toEqual([
        { deviceId: CAM, slice: { detected: false, lastDetectedAt: 42, autoClearAfterMs: null } },
      ])
    })
  })

  it('a camera the composer owns is never re-published: its slices are the composer`s', () => {
    expect(
      camerasTheSliceOwns([
        { id: 1, addonId: 'provider-reolink' },
        { id: 2, addonId: 'composer' },
        { id: 3, addonId: 'camera-grid' },
      ]),
    ).toEqual([1, 3])
  })

  describe('a source that sends its OWN clear is held until it (review F3)', () => {
    it("a long analyzer episode stays ON past the window, until the analyzer's false", async () => {
      const h = harness({ sources: { [CAM]: ['analyzer'] } })
      await openQuiet(h)
      h.edge({ detected: true, source: 'analyzer', viaBridge: false })
      await vi.advanceTimersByTimeAsync(WINDOW_MS * 2)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
      h.edge({ detected: false, source: 'analyzer', viaBridge: false })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true, false])
    })

    it('a stuck-high analyzer is released at maxSessionHoldMs, and the release is said with the camera', async () => {
      const h = harness({ sources: { [CAM]: ['analyzer'] } })
      await openQuiet(h)
      h.edge({ detected: true, source: 'analyzer', viaBridge: false })
      await vi.advanceTimersByTimeAsync(MAX_HOLD_MS - 1)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
      await vi.advanceTimersByTimeAsync(1)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true, false])
      expect(h.lines.find((l) => l.message.includes('held past maxSessionHoldMs'))).toMatchObject({
        level: 'warn',
        deviceId: CAM,
        meta: { source: 'analyzer', maxHoldMs: MAX_HOLD_MS },
      })
    })

    it('an unsplit onboard emitter (camera-grid sends only edges) is held until its own false too', async () => {
      const h = harness()
      await openQuiet(h)
      h.edge({ detected: true, viaBridge: false })
      await vi.advanceTimersByTimeAsync(WINDOW_MS * 2)
      await h.settle()
      expect(h.detectedWrites()).toEqual([true])
      h.edge({ detected: false, viaBridge: false })
      await h.settle()
      expect(h.detectedWrites()).toEqual([true, false])
    })

    it('an analyzer-only camera`s takeover grace is maxSessionHoldMs: a live analyzer episode is not clipped', async () => {
      const h = harness({
        sources: { [CAM]: ['analyzer'] },
        hubSlice: {
          [CAM]: {
            kind: 'answered',
            slice: { detected: true, lastDetectedAt: 42, autoClearAfterMs: null },
          },
        },
      })
      await h.slice.setWriterOpen(true)
      await vi.advanceTimersByTimeAsync(WINDOW_MS * 2)
      await h.settle()
      expect(h.written).toEqual([])
      await vi.advanceTimersByTimeAsync(MAX_HOLD_MS - WINDOW_MS * 2)
      await h.settle()
      expect(h.detectedWrites()).toEqual([false])
    })
  })

  describe('review F7, F8', () => {
    const stuckOn: MotionSliceRead = {
      kind: 'answered',
      slice: { detected: true, lastDetectedAt: 42, autoClearAfterMs: MOTION_CLOSE_AFTER_MS },
    }
    it('a gate closure keeps the grace deadline already armed: flapping cannot push a stuck ON past it', async () => {
      const h = harness({ hubSlice: { [CAM]: stuckOn } })
      await h.slice.setWriterOpen(true)
      await vi.advanceTimersByTimeAsync(WINDOW_MS / 2)
      await h.slice.setWriterOpen(false)
      await h.slice.setWriterOpen(true)
      await vi.advanceTimersByTimeAsync(WINDOW_MS / 2)
      await h.settle()
      expect(h.detectedWrites()).toEqual([false])
    })

    it('lastDetectedAt never moves backwards: a takeover keeps the slice`s later stamp', async () => {
      const h = harness({
        hubSlice: {
          [CAM]: {
            kind: 'answered',
            slice: { detected: true, lastDetectedAt: 9_000_000, autoClearAfterMs: null },
          },
        },
      })
      h.edge({ detected: true, timestamp: 5 })
      await h.slice.setWriterOpen(true)
      await h.settle()
      expect(h.written.map((w) => [w.slice.detected, w.slice.lastDetectedAt])).toEqual([
        [true, 9_000_000],
      ])
    })
  })
})
