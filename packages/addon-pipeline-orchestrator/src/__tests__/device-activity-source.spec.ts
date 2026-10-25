/**
 * The `device-activity` motion source: the camera's own `recording-signal`
 * LEVEL republished as motion, so a device that says it is working drives the
 * detection pipeline the way firmware motion does.
 *
 * A level is not an edge — a cleaning run is forty minutes of "still
 * happening" — so this unit holds the level in memory (refreshed off the event
 * path, never read back from the device: D224) and re-emits a sustain tick
 * while it is up. Everything here is about that: who emits, who does not, and
 * what is said when nothing is emitted.
 */
import type { IScopedLogger, MotionSources } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOTION_CLOSE_AFTER_MS } from '@camstack/types'
import { DeviceActivitySource, sustainIntervalMs } from '../device-activity-source.js'

interface Emitted {
  readonly deviceId: number
  readonly detected: boolean
  readonly timestamp: number
}

interface LogLine {
  readonly level: string
  readonly message: string
  readonly deviceId: unknown
}

function harness(opts?: { sources?: MotionSources | null; sustainMs?: number }) {
  const emitted: Emitted[] = []
  const logs: LogLine[] = []
  // `?? ` would turn the deliberate `null` (no active detection config) back
  // into a live list — the exact case one of these tests is about.
  let sources: MotionSources | null =
    opts !== undefined && 'sources' in opts ? (opts.sources ?? null) : ['device-activity']

  const record =
    (level: string) =>
    (message: string, extras?: { tags?: Record<string, unknown> }): void => {
      logs.push({ level, message, deviceId: extras?.tags?.deviceId })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }

  const source = new DeviceActivitySource({
    logger,
    emitMotion: (deviceId, detected, timestamp) => {
      emitted.push({ deviceId, detected, timestamp })
    },
    motionSourcesFor: () => sources,
    sustainMsFor: () => opts?.sustainMs ?? 10_000,
  })

  return {
    source,
    emitted,
    logs,
    setSources: (next: MotionSources | null) => {
      sources = next
    },
  }
}

describe('DeviceActivitySource — the level becomes motion', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a rise emits one motion tick for that device', () => {
    const h = harness()
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    expect(h.emitted).toEqual([{ deviceId: 102, detected: true, timestamp: 1_000_000 }])
    h.source.stop()
  })

  it('the same level repeated does not re-emit — the sustain tick owns that', () => {
    const h = harness()
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_100)
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_200)
    expect(h.emitted).toHaveLength(1)
    h.source.stop()
  })

  it('sustains the session while the level is up, one tick per sustain window', () => {
    const h = harness({ sustainMs: 10_000 })
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)

    vi.advanceTimersByTime(10_000)
    vi.advanceTimersByTime(10_000)

    expect(h.emitted.map((e) => e.detected)).toEqual([true, true, true])
    h.source.stop()
  })

  it('a fall emits the falling edge and stops sustaining', () => {
    const h = harness({ sustainMs: 10_000 })
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    h.source.onSignalLevel(102, false, 'docked', 1_005_000)

    expect(h.emitted.at(-1)).toEqual({ deviceId: 102, detected: false, timestamp: 1_005_000 })
    vi.advanceTimersByTime(60_000)
    expect(h.emitted).toHaveLength(2)
    h.source.stop()
  })

  it('a fall with no rise before it emits nothing — there is no session to close', () => {
    const h = harness()
    h.source.onSignalLevel(102, false, 'docked', 1_000_000)
    expect(h.emitted).toHaveLength(0)
    h.source.stop()
  })

  it('keeps devices apart', () => {
    const h = harness()
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    h.source.onSignalLevel(108, true, 'mowing', 1_000_050)
    h.source.onSignalLevel(102, false, 'docked', 1_000_100)
    expect(h.emitted).toEqual([
      { deviceId: 102, detected: true, timestamp: 1_000_000 },
      { deviceId: 108, detected: true, timestamp: 1_000_050 },
      { deviceId: 102, detected: false, timestamp: 1_000_100 },
    ])
    h.source.stop()
  })

  it('stop() drops every sustain timer', () => {
    const h = harness({ sustainMs: 10_000 })
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    h.source.stop()
    vi.advanceTimersByTime(60_000)
    expect(h.emitted).toHaveLength(1)
  })
})

describe('DeviceActivitySource — when the operator has not asked for this source', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits nothing when the camera does not list the source, and says so', () => {
    const h = harness({ sources: ['analyzer'] })
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    expect(h.emitted).toHaveLength(0)
    const line = h.logs.find((l) => l.message.includes('device-activity'))
    expect(line?.deviceId).toBe(102)
    h.source.stop()
  })

  it('emits nothing when the camera has no active detection config', () => {
    const h = harness({ sources: null })
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    expect(h.emitted).toHaveLength(0)
    h.source.stop()
  })

  it('still TRACKS the level while suppressed, so enabling it mid-run starts working', () => {
    const h = harness({ sources: ['analyzer'], sustainMs: 10_000 })
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    expect(h.emitted).toHaveLength(0)

    // The operator ticks the source on while the robot is still cleaning.
    h.setSources(['device-activity'])
    vi.advanceTimersByTime(10_000)

    expect(h.emitted).toEqual([{ deviceId: 102, detected: true, timestamp: 1_010_000 }])
    h.source.stop()
  })

  it('stops sustaining when the source is removed mid-run', () => {
    const h = harness({ sustainMs: 10_000 })
    h.source.onSignalLevel(102, true, 'cleaning', 1_000_000)
    h.setSources(['analyzer'])
    vi.advanceTimersByTime(30_000)
    expect(h.emitted).toHaveLength(1)
    h.source.stop()
  })
})

describe('sustainIntervalMs — ONE formula for every level source (D392, R11)', () => {
  it('is half the cooldown, never under a second, capped at half the episode close', () => {
    expect(sustainIntervalMs(undefined)).toBe(7_500)
    expect(sustainIntervalMs(30_000)).toBe(7_500)
    expect(sustainIntervalMs(10_000)).toBe(5_000)
    expect(sustainIntervalMs(1_500)).toBe(1_000)
  })

  it('always lands before a D475 episode closes on its quiet timer (D672)', () => {
    // A sustained level must keep ONE (camera, source) episode row open: the
    // post-analysis tracker closes it MOTION_CLOSE_AFTER_MS after the last
    // detected:true, so every tick must come sooner than that, whatever the
    // camera's cooldown.
    const late: number[] = []
    for (let cooldown = 0; cooldown <= 60_000; cooldown += 500) {
      if (sustainIntervalMs(cooldown) >= MOTION_CLOSE_AFTER_MS) late.push(cooldown)
    }
    expect(late).toEqual([])
  })
})
