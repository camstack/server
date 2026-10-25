/**
 * The loop end to end, with a fake clock, a fake logger and a fake command
 * sink. Nothing here waits on a timer and nothing touches a camera.
 */
import type { IScopedLogger, LogExtras, LogTags, ObjectDetection } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AUTOTRACK_LOOP_CONFIG } from '../autotrack-config.js'
import {
  type AutotrackCommands,
  AutotrackLoop,
  candidatesFromFrame,
  type PulseCommand,
  type TrackedFrame,
} from '../autotrack-loop.js'

const DEVICE_ID = 101
const OTHER_DEVICE_ID = 102
const FRAME_W = 1920
const FRAME_H = 1080

interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly tags: LogTags | undefined
  readonly meta: Record<string, unknown> | undefined
}

class FakeLogger implements IScopedLogger {
  readonly lines: CapturedLog[] = []
  private push(level: CapturedLog['level'], message: string, extras?: LogExtras): void {
    this.lines.push({ level, message, tags: extras?.tags, meta: extras?.meta })
  }
  debug(message: string, extras?: LogExtras): void {
    this.push('debug', message, extras)
  }
  info(message: string, extras?: LogExtras): void {
    this.push('info', message, extras)
  }
  warn(message: string, extras?: LogExtras): void {
    this.push('warn', message, extras)
  }
  error(message: string, extras?: LogExtras): void {
    this.push('error', message, extras)
  }
  child(): IScopedLogger {
    return this
  }
  withTags(): IScopedLogger {
    return this
  }
}

class FakeCommands implements AutotrackCommands {
  readonly pulses: PulseCommand[] = []
  readonly homes: number[] = []
  failNext = false
  async pulse(command: PulseCommand): Promise<void> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('camera said 400')
    }
    this.pulses.push(command)
  }
  async goHome(deviceId: number): Promise<void> {
    this.homes.push(deviceId)
  }
}

function detection(trackId: string | null, x: number, y: number): ObjectDetection {
  return {
    id: `det-${trackId ?? 'none'}-${x}`,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    bbox: { x, y, width: 100, height: 200 },
    labels: [],
    ...(trackId === null ? {} : { track: { trackId } }),
  }
}

function frame(detections: readonly ObjectDetection[], timestamp: number): TrackedFrame {
  return {
    deviceId: DEVICE_ID,
    timestamp,
    frameWidth: FRAME_W,
    frameHeight: FRAME_H,
    detections,
  }
}

/** A box whose CENTRE is at the given normalized error. */
function boxAt(trackId: string, errorX: number, errorY: number): ObjectDetection {
  const cx = (errorX + 0.5) * FRAME_W
  const cy = (errorY + 0.5) * FRAME_H
  return detection(trackId, cx - 50, cy - 100)
}

let clock = 1_000_000
let logger: FakeLogger
let commands: FakeCommands

function makeLoop(armed: boolean): AutotrackLoop {
  return new AutotrackLoop({
    deviceId: DEVICE_ID,
    targetClass: 'person',
    armed,
    config: DEFAULT_AUTOTRACK_LOOP_CONFIG,
    logger,
    commands,
    now: () => clock,
  })
}

function ready(loop: AutotrackLoop): void {
  loop.applyMirror({ kind: 'read', moveImpulseMs: 200, nativeAutotrack: 'absent' })
}

beforeEach(() => {
  clock = 1_000_000
  logger = new FakeLogger()
  commands = new FakeCommands()
})

describe('candidatesFromFrame', () => {
  it('takes only tracked, first-level boxes of the configured class', () => {
    const detail: ObjectDetection = {
      id: 'face',
      kind: 'detail',
      macroClass: 'face',
      score: 0.9,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      labels: [],
      track: { trackId: 'face-t' },
    }
    const untracked = detection(null, 10, 10)
    const vehicle: ObjectDetection = { ...detection('v', 0, 0), macroClass: 'vehicle' }
    const out = candidatesFromFrame([detail, untracked, vehicle, detection('p', 5, 5)], 'person')
    expect(out.map((c) => c.trackId)).toEqual(['p'])
  })

  it('ignores an untracked box: no track means the tracker did not associate it', () => {
    expect(candidatesFromFrame([detection(null, 0, 0)], 'person')).toEqual([])
  })
})

describe('AutotrackLoop — what it measures', () => {
  it('measures the bus latency of every frame and reports it', async () => {
    const loop = makeLoop(false)
    await loop.onFrame(frame([boxAt('a', 0, 0)], clock - 250))
    const hold = logger.lines.find((l) => l.message === 'autotrack hold')
    expect(hold?.meta?.busLatencyMs).toBe(250)
    expect(hold?.tags).toEqual({ deviceId: DEVICE_ID })
  })

  it('counts how often the HELD track is missing from a frame', async () => {
    const loop = makeLoop(false)
    await loop.onFrame(frame([boxAt('a', 0, 0)], clock))
    clock += 100
    await loop.onFrame(frame([], clock))
    clock += 100
    await loop.onFrame(frame([boxAt('a', 0, 0)], clock))
    loop.logSummary()
    const summary = logger.lines.filter((l) => l.message === 'autotrack measurements').at(-1)
    expect(summary?.meta?.framesWithTarget).toBe(3)
    expect(summary?.meta?.absentFrames).toBe(1)
    expect(summary?.meta?.maxGapFrames).toBe(1)
  })

  it('measures on a camera it is not allowed to move — the measurement is the deliverable', async () => {
    const loop = makeLoop(false)
    await loop.onFrame(frame([boxAt('a', 0.4, 0)], clock))
    expect(commands.pulses).toEqual([])
    const hold = logger.lines.find((l) => l.message === 'autotrack hold')
    expect(hold?.meta?.reason).toBe('disarmed')
    expect(hold?.meta?.errorX).toBeCloseTo(0.4)
  })

  it('ignores frames from any other camera', async () => {
    const loop = makeLoop(true)
    ready(loop)
    const linesBefore = logger.lines.length
    await loop.onFrame({ ...frame([boxAt('a', 0.4, 0)], clock), deviceId: OTHER_DEVICE_ID })
    // Nothing decided, nothing measured, nothing commanded. Asserting only
    // "no hold was logged" would have passed with the filter REMOVED, because
    // that frame is off-centre and would have produced a `pulse` instead.
    expect(logger.lines).toHaveLength(linesBefore)
    expect(commands.pulses).toEqual([])
    expect(commands.homes).toEqual([])
  })
})

describe('AutotrackLoop — what it decides', () => {
  it('logs the decision NOT to move, with the error and the reason (D391)', async () => {
    const loop = makeLoop(true)
    ready(loop)
    await loop.onFrame(frame([boxAt('a', 0.1, -0.05)], clock))
    const hold = logger.lines.find((l) => l.message === 'autotrack hold')
    expect(hold?.meta?.reason).toBe('inside-dead-zone')
    expect(hold?.meta?.errorX).toBeCloseTo(0.1)
    expect(hold?.meta?.errorY).toBeCloseTo(-0.05)
    expect(hold?.meta?.trackPresent).toBe(true)
  })

  it('issues ONE self-terminating pulse when the subject leaves the dead zone', async () => {
    const loop = makeLoop(true)
    ready(loop)
    await loop.onFrame(frame([boxAt('a', 0.4, 0)], clock))
    expect(commands.pulses).toEqual([{ deviceId: DEVICE_ID, pan: 1, tilt: 0, speed: 0.4 }])
  })

  it('refuses to move while the mirror has never been read', async () => {
    const loop = makeLoop(true)
    await loop.onFrame(frame([boxAt('a', 0.4, 0)], clock))
    expect(commands.pulses).toEqual([])
    const hold = logger.lines.find((l) => l.message === 'autotrack hold')
    expect(hold?.meta?.reason).toBe('native-autotrack-unknown')
  })

  it('does not issue ten commands for ten frames at 10 Hz', async () => {
    const loop = makeLoop(true)
    ready(loop)
    for (let i = 0; i < 10; i += 1) {
      await loop.onFrame(frame([boxAt('a', 0.4, 0)], clock))
      clock += 100
    }
    expect(commands.pulses).toHaveLength(1)
  })

  it('names a command that failed instead of swallowing it', async () => {
    const loop = makeLoop(true)
    ready(loop)
    commands.failNext = true
    await loop.onFrame(frame([boxAt('a', 0.4, 0)], clock))
    expect(logger.lines.some((l) => l.message === 'autotrack command failed')).toBe(true)
  })
})

describe('AutotrackLoop — the silence watchdog', () => {
  it('does nothing while frames are arriving', async () => {
    const loop = makeLoop(true)
    ready(loop)
    await loop.onFrame(frame([boxAt('a', 0, 0)], clock))
    clock += 1_000
    await loop.tick()
    expect(commands.homes).toEqual([])
  })

  it('releases the target and homes when the event stream dies', async () => {
    const loop = makeLoop(true)
    ready(loop)
    await loop.onFrame(frame([boxAt('a', 0, 0)], clock))
    clock += DEFAULT_AUTOTRACK_LOOP_CONFIG.disappearDelayMs
    await loop.tick()
    expect(commands.homes).toEqual([DEVICE_ID])
    expect(logger.lines.some((l) => l.message === 'autotrack frame silence')).toBe(true)
  })

  it('homes once, not on every tick', async () => {
    const loop = makeLoop(true)
    ready(loop)
    await loop.onFrame(frame([boxAt('a', 0, 0)], clock))
    clock += DEFAULT_AUTOTRACK_LOOP_CONFIG.disappearDelayMs
    await loop.tick()
    clock += 60_000
    await loop.tick()
    expect(commands.homes).toEqual([DEVICE_ID])
  })

  it('is quiet on a camera that never held a target', async () => {
    const loop = makeLoop(true)
    ready(loop)
    await loop.onFrame(frame([], clock))
    clock += 120_000
    await loop.tick()
    expect(commands.homes).toEqual([])
    expect(logger.lines.some((l) => l.message === 'autotrack frame silence')).toBe(false)
  })
})

describe('AutotrackLoop — the mirror is refreshed off the event path', () => {
  it('a failed refresh does not release the target', async () => {
    const loop = makeLoop(true)
    ready(loop)
    await loop.onFrame(frame([boxAt('a', 0, 0)], clock))
    loop.applyMirror({ kind: 'failed', error: 'ETIMEDOUT' })
    expect(loop.ptzMirror.moveImpulseMs).toBe(200)
    clock += 100
    await loop.onFrame(frame([boxAt('a', 0.4, 0)], clock))
    expect(commands.pulses).toHaveLength(1)
  })
})
