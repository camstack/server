/**
 * The package stillness path is WIRED in the booted addon (fix round 1,
 * review H4). The units (tracker, sweep driver, evidence builder) were green
 * while every one of these could be cut in `index.ts`:
 *
 * - the analytics' 5 s TTL tick drives the frame-free sweep (F4);
 * - a throw inside that sweep is caught and named, never an uncaught
 *   exception in a timer callback (M3);
 * - the frame's `packageLooked`, its RAW package boxes and the camera's
 *   `packageDropEarlyPickupEnabled` reach the tracker (F4, D687).
 */
import type { FrameResult, IEventBus, PipelineInferenceResultPayload } from '@camstack/types'
import { createEvent, EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type PackageStillnessInput,
  PackageStillnessTracker,
} from '../pipeline/package/package-stillness-tracker.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'

const DEVICE_ID = 101
const TTL_TICK_MS = 5_000

function emitInference(bus: IEventBus, frame: FrameResult): void {
  const payload: PipelineInferenceResultPayload = { deviceId: DEVICE_ID, frame, nodeId: 'hub' }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

const PARCEL_FRAME: FrameResult = {
  kind: 'frame',
  frameId: 'f-1',
  deviceId: DEVICE_ID,
  timestamp: 1_790_774_600_000,
  width: 640,
  height: 360,
  detections: [
    {
      id: 'd0',
      kind: 'first-level',
      macroClass: 'package',
      score: 0.9,
      labels: [],
      bbox: { x: 104, y: 164, width: 60, height: 40 },
    },
  ],
  packageLooked: true,
}

describe('package stillness wiring', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('the TTL tick drives the frame-free sweep', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const visited = vi.spyOn(PackageStillnessTracker.prototype, 'devicesWithCandidates')
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    visited.mockClear()
    vi.advanceTimersByTime(TTL_TICK_MS)
    expect(visited).toHaveBeenCalled()
  })

  it('a throw inside the sweep is caught and named, not an uncaught timer exception', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.spyOn(PackageStillnessTracker.prototype, 'devicesWithCandidates').mockImplementation(() => {
      throw new Error('tracker exploded')
    })
    booted = await bootAnalytics(DEVICE_ID, async () => null)
    expect(() => vi.advanceTimersByTime(TTL_TICK_MS)).not.toThrow()
    expect(booted.logs.some((l) => l.message === 'package stillness sweep threw')).toBe(true)
  })

  it("the frame's look, its raw package boxes and the early switch reach the tracker", async () => {
    const inputs: PackageStillnessInput[] = []
    const observe = PackageStillnessTracker.prototype.observe
    vi.spyOn(PackageStillnessTracker.prototype, 'observe').mockImplementation(function (
      this: PackageStillnessTracker,
      input: PackageStillnessInput,
    ) {
      inputs.push(input)
      return observe.call(this, input)
    })
    booted = await bootAnalytics(DEVICE_ID, async () => null, {
      deviceSettings: { packageDropEarlyPickupEnabled: true },
    })
    // The first frame warms the per-camera settings cache; the second reads it.
    emitInference(booted.bus.bus, PARCEL_FRAME)
    await flush()
    emitInference(booted.bus.bus, {
      ...PARCEL_FRAME,
      frameId: 'f-2',
      timestamp: PARCEL_FRAME.timestamp + 500,
    })
    await flush()
    const last = inputs.filter((i) => i.deviceId === DEVICE_ID).at(-1)
    expect(last?.looked).toBe(true)
    expect(last?.earlyPickup).toBe(true)
    expect(last?.rawPackageBoxes).toEqual([{ x: 104, y: 164, w: 60, h: 40 }])
  }, 20_000)
})
