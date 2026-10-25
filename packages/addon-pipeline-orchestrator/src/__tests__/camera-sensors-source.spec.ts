/**
 * `CameraSensorsSource` (D672) — the hot path. A sensor the operator ATTACHED
 * to a camera is part of that camera's `onboard` motion: its rise is emitted
 * as the CAMERA's motion, named by `triggeredBy`, first trigger winning while
 * the aggregate is high; `false` only when every attached sensor is quiet; a
 * sustain tick at the D392 interval; and every rise that reaches nothing is
 * SAID. No I/O anywhere: the source reads only its own memory and the deps.
 */
import type { IScopedLogger, MotionSources } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type CameraSensorInput,
  type CameraSensorsMotion,
  CameraSensorsSource,
} from '../camera-sensors/source.js'

/** A CS-1 routing: an in-addition sensor, ready (D673 C1). */
function inAddition(deviceId: number): CameraSensorInput {
  return { deviceId, mode: 'in-addition', ready: true }
}

const CAM = 103
const CAM2 = 101
const PIR = 3299
const PIR2 = 3300

interface LogLine {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

interface LogExtras {
  readonly tags?: Readonly<Record<string, unknown>>
  readonly meta?: Readonly<Record<string, unknown>>
}

interface HarnessOptions {
  readonly sources?: MotionSources | null
  readonly sustainMs?: number
}

const motionSlice = (detected: boolean, lastDetectedAt: number) => ({ detected, lastDetectedAt })

function harness(opts: HarnessOptions = {}) {
  const emitted: CameraSensorsMotion[] = []
  const logs: LogLine[] = []
  const sources: MotionSources | null = 'sources' in opts ? (opts.sources ?? null) : ['onboard']
  const record =
    (level: string) =>
    (message: string, extras?: LogExtras): void => {
      logs.push({ level, message, deviceId: extras?.tags?.['deviceId'], meta: extras?.meta })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  const source = new CameraSensorsSource({
    logger,
    emitMotion: (motion) => {
      emitted.push(motion)
    },
    motionSourcesFor: () => sources,
    sustainMsFor: () => opts.sustainMs ?? 15_000,
    cooldownMsFor: () => 30_000,
    maxHoldMsFor: () => 120_000,
    now: () => Date.now(),
  })
  const state = (
    sensorId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
    observedAtMs: number,
  ): void => source.onSensorState({ sensorId, capName, slice, observedAtMs })
  return { source, emitted, logs, state }
}

describe('CameraSensorsSource — attached sensors are the camera onboard motion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(500)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a genuine PIR rise emits the CAMERA onboard motion with the sensor as trigger', () => {
    const h = harness({ sources: ['onboard'] })
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    expect(h.emitted).toEqual([
      {
        deviceId: CAM,
        detected: true,
        timestamp: 2_000,
        triggeredBy: { kind: 'sensor', deviceId: PIR },
      },
    ])
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'camera-sensors: attached sensor triggered camera motion',
        deviceId: CAM,
      }),
    )
  })

  it('first trigger wins while the aggregate is high', () => {
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR), inAddition(PIR2)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR2, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    h.state(PIR2, 'motion', motionSlice(true, 3_000), 3_000)
    expect(h.emitted).toHaveLength(2)
    for (const m of h.emitted) {
      expect(m).toMatchObject({
        deviceId: CAM,
        detected: true,
        triggeredBy: { kind: 'sensor', deviceId: PIR },
      })
    }
  })

  it('false only when EVERY attached sensor is quiet', () => {
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR), inAddition(PIR2)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR2, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    h.state(PIR2, 'motion', motionSlice(true, 3_000), 3_000)
    h.state(PIR, 'motion', motionSlice(false, 3_000), 4_000)
    expect(h.emitted.filter((m) => !m.detected)).toEqual([])
    h.state(PIR2, 'motion', motionSlice(false, 3_000), 5_000)
    expect(h.emitted.filter((m) => !m.detected)).toEqual([
      {
        deviceId: CAM,
        detected: false,
        timestamp: 5_000,
        triggeredBy: { kind: 'sensor', deviceId: PIR },
      },
    ])
  })

  it('sustains at sustainMsFor while high and stops when quiet', () => {
    const h = harness({ sustainMs: 15_000 })
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    vi.advanceTimersByTime(15_000)
    expect(h.emitted).toHaveLength(2)
    expect(h.emitted[1]).toMatchObject({
      deviceId: CAM,
      detected: true,
      triggeredBy: { kind: 'sensor', deviceId: PIR },
    })
    h.state(PIR, 'motion', motionSlice(false, 2_000), 20_000)
    const afterFall = h.emitted.length
    vi.advanceTimersByTime(60_000)
    expect(h.emitted).toHaveLength(afterFall)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a stale first sighting is not a rise, and says so', () => {
    vi.setSystemTime(100_000)
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(true, 1_000), 100_000)
    expect(h.emitted).toEqual([])
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'camera-sensors: sensor rise not forwarded',
        deviceId: CAM,
        meta: expect.objectContaining({
          reason: 'baseline-seeded-stale-active',
          sourceDeviceId: PIR,
        }),
      }),
    )
  })

  it('a first sighting that changed BEFORE the watch began is not a rise, even inside the freshness window', () => {
    // Freshness alone would pass 95_000 at 100_000 (30 s window); the watch
    // floor is what refuses it: a boot hydration of a sensor that flipped
    // seconds before we started watching is not a rise we saw.
    vi.setSystemTime(100_000)
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(true, 95_000), 100_000)
    expect(h.emitted).toEqual([])
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        message: 'camera-sensors: sensor rise not forwarded',
        meta: expect.objectContaining({ reason: 'baseline-seeded-stale-active' }),
      }),
    )
  })

  it('a camera that does not list onboard gets nothing, and the drop is said', () => {
    const h = harness({ sources: ['analyzer'] })
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    expect(h.emitted).toEqual([])
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'camera-sensors: trigger not forwarded — the camera does not list `onboard`',
        deviceId: CAM,
      }),
    )
    // The sustain ticks of the same episode are dropped too, but only the
    // rise is said at info: a tick every half-cooldown would drown the log.
    vi.advanceTimersByTime(45_000)
    const dropped = h.logs.filter(
      (l) =>
        l.message === 'camera-sensors: trigger not forwarded — the camera does not list `onboard`',
    )
    expect(dropped.map((l) => l.level)).toEqual(['info', 'debug', 'debug', 'debug'])
  })

  it('removing a HIGH sensor from the camera emits the camera false', () => {
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    vi.setSystemTime(9_000)
    h.source.setInputs(CAM, [])
    expect(h.emitted.at(-1)).toEqual({
      deviceId: CAM,
      detected: false,
      timestamp: 9_000,
      triggeredBy: { kind: 'sensor', deviceId: PIR },
    })
    expect(h.source.watches(PIR)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('one PIR can feed two cameras; each gets its own first trigger', () => {
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.source.setInputs(CAM2, [inAddition(PIR2), inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR2, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR2, 'motion', motionSlice(true, 2_000), 2_000)
    h.state(PIR, 'motion', motionSlice(true, 3_000), 3_000)
    expect(h.emitted).toEqual([
      {
        deviceId: CAM2,
        detected: true,
        timestamp: 2_000,
        triggeredBy: { kind: 'sensor', deviceId: PIR2 },
      },
      {
        deviceId: CAM,
        detected: true,
        timestamp: 3_000,
        triggeredBy: { kind: 'sensor', deviceId: PIR },
      },
      {
        deviceId: CAM2,
        detected: true,
        timestamp: 3_000,
        triggeredBy: { kind: 'sensor', deviceId: PIR2 },
      },
    ])
  })

  it('a slice with no level leaves the mirror alone and is said at debug', () => {
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', { lastDetectedAt: 2_000 }, 2_000)
    h.state(PIR, 'motion', motionSlice(true, 3_000), 3_000)
    expect(h.emitted).toHaveLength(1)
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        level: 'debug',
        message: 'camera-sensors: slice carries no level — ignored',
        deviceId: PIR,
      }),
    )
  })

  it('an unwatched device is ignored', () => {
    const h = harness()
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    expect(h.emitted).toEqual([])
    expect(h.source.watches(PIR)).toBe(false)
  })

  it('stop() clears timers and ignores later state', () => {
    const h = harness()
    h.source.setInputs(CAM, [inAddition(PIR)])
    h.state(PIR, 'motion', motionSlice(false, 0), 1_000)
    h.state(PIR, 'motion', motionSlice(true, 2_000), 2_000)
    h.source.stop()
    expect(vi.getTimerCount()).toBe(0)
    const before = h.emitted.length
    h.state(PIR, 'motion', motionSlice(false, 2_000), 3_000)
    h.state(PIR, 'motion', motionSlice(true, 4_000), 4_000)
    expect(h.emitted).toHaveLength(before)
  })
})
