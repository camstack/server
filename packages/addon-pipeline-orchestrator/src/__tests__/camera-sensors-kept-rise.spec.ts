/**
 * Contract, consumer half: a sensor's `motion` slice keeps its LAST RISE
 * across an `off` (`motion.cap.ts`: `lastDetectedAt` null = never detected;
 * the HA binary sensor, Homematic and Matter all keep it). So an `off` slice
 * carries a STALE rise time, and the source must never read that as a rise:
 * not on the first slice after a restart, not on a repeated `off`, not on a
 * fall. And every real rise must still reach the camera exactly once.
 *
 * Every slice here is built through `MotionStatusSchema.parse` — the shape a
 * provider may legally write, not a shape the author of this file finds
 * convenient. The provider half,
 * `addon-provider-homeassistant/src/devices/__tests__/ha-motion-edge-contract.spec.ts`,
 * pins that the HA device's REAL slices are of this shape and that the shared
 * edge rule reads them the same way. Addons never import each other, so the
 * two halves meet at the schema and at `evaluateSensorEdge`, both in
 * `@camstack/types`.
 */
import { type IScopedLogger, MotionStatusSchema, type MotionStatus } from '@camstack/types'
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
const PIR = 3299
const START = Date.parse('2026-09-29T17:00:00.000Z')

interface LogLine {
  readonly level: string
  readonly message: string
}

/** A slice exactly as a `Sensor` device writes it, validated by the cap's schema. */
function motion(detected: boolean, lastDetectedAt: number | null): MotionStatus {
  return MotionStatusSchema.parse({ detected, lastDetectedAt, autoClearAfterMs: null })
}

interface KeptRiseHarness {
  readonly emitted: CameraSensorsMotion[]
  readonly logs: LogLine[]
  /** Deliver a slice at the current fake time, as `DeviceStateChanged` would. */
  readonly deliver: (slice: MotionStatus) => void
  readonly rises: () => readonly number[]
  readonly falls: () => number
}

function harness(): KeptRiseHarness {
  const emitted: CameraSensorsMotion[] = []
  const logs: LogLine[] = []
  const record =
    (level: string) =>
    (message: string): void => {
      logs.push({ level, message })
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
    emitMotion: (m) => {
      emitted.push(m)
    },
    motionSourcesFor: () => ['onboard'],
    sustainMsFor: () => 15_000,
    cooldownMsFor: () => 30_000,
    maxHoldMsFor: () => 120_000,
    now: () => Date.now(),
  })
  source.setInputs(CAM, [inAddition(PIR)])
  return {
    emitted,
    logs,
    deliver: (slice) =>
      source.onSensorState({ sensorId: PIR, capName: 'motion', slice, observedAtMs: Date.now() }),
    rises: () => emitted.filter((m) => m.detected).map((m) => m.timestamp),
    falls: () => emitted.filter((m) => !m.detected).length,
  }
}

describe('CameraSensorsSource — a rise kept across off is never re-read as a rise', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('off → on: one rise, stamped with the rise', () => {
    const h = harness()
    h.deliver(motion(false, null))
    vi.setSystemTime(START + 1_000)
    h.deliver(motion(true, START + 1_000))
    expect(h.emitted).toEqual([
      {
        deviceId: CAM,
        detected: true,
        timestamp: START + 1_000,
        triggeredBy: { kind: 'sensor', deviceId: PIR },
      },
    ])
  })

  it('on → off with the kept rise: only the camera false', () => {
    const h = harness()
    h.deliver(motion(false, null))
    vi.setSystemTime(START + 1_000)
    h.deliver(motion(true, START + 1_000))
    vi.setSystemTime(START + 5_000)
    h.deliver(motion(false, START + 1_000))
    expect(h.rises()).toEqual([START + 1_000])
    expect(h.emitted.at(-1)).toEqual({
      deviceId: CAM,
      detected: false,
      timestamp: START + 5_000,
      triggeredBy: { kind: 'sensor', deviceId: PIR },
    })
  })

  it('on → off → off → on with a new time: exactly one rise per rise', () => {
    const h = harness()
    h.deliver(motion(false, null))
    vi.setSystemTime(START + 1_000)
    h.deliver(motion(true, START + 1_000))
    vi.setSystemTime(START + 5_000)
    h.deliver(motion(false, START + 1_000))
    h.deliver(motion(false, START + 1_000))
    vi.setSystemTime(START + 60_000)
    h.deliver(motion(true, START + 60_000))
    expect(h.rises()).toEqual([START + 1_000, START + 60_000])
    expect(h.falls()).toBe(1)
  })

  it('restart: a first slice that is off with a fresh kept rise is no rise, and not "not forwarded"', () => {
    // 20 s old: inside the first-sighting freshness window, so a stale stamp
    // on a level that read ACTIVE would fire.
    const h = harness()
    h.deliver(motion(false, START - 20_000))
    h.deliver(motion(false, START - 20_000))
    expect(h.emitted).toEqual([])
    expect(h.logs.filter((l) => l.message.includes('not forwarded'))).toEqual([])

    vi.setSystemTime(START + 30_000)
    h.deliver(motion(true, START + 30_000))
    expect(h.rises()).toEqual([START + 30_000])
  })
})
