/**
 * D673 on the bridge alone: pass-through, Replace, Confirm, the hand-back, the
 * heartbeat-only camera, a stuck sensor, the not-forwarded camera and an
 * unsplit provider. Fake clock; the bridge's emits are recorded.
 */
import type { CameraSensorMode, IScopedLogger, MotionSources } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CameraSensorsMotion, CameraSensorsSource } from '../camera-sensors/source.js'

const CAM = 103
const PIR = 3299
const GATE = 3301
const T0 = 1_790_000_000_000

interface Line {
  readonly level: string
  readonly message: string
  readonly meta: Readonly<Record<string, unknown>> | undefined
}

interface HarnessOpts {
  readonly sources?: MotionSources | null
  readonly maxHoldMs?: number
  readonly cooldownMs?: number
}

function harness(opts: HarnessOpts = {}) {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  const emitted: CameraSensorsMotion[] = []
  const lines: Line[] = []
  const record =
    (level: string) => (message: string, extras?: { meta?: Readonly<Record<string, unknown>> }) => {
      lines.push({ level, message, meta: extras?.meta })
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
    emitMotion: (m) => emitted.push(m),
    motionSourcesFor: () => (opts.sources === undefined ? ['onboard'] : opts.sources),
    sustainMsFor: () => 7_500,
    cooldownMsFor: () => opts.cooldownMs ?? 30_000,
    maxHoldMsFor: () => opts.maxHoldMs ?? 120_000,
    now: () => Date.now(),
  })
  const attach = (inputs: readonly [number, CameraSensorMode, boolean?][]) =>
    source.setInputs(
      CAM,
      inputs.map(([deviceId, mode, ready = true]) => ({ deviceId, mode, ready })),
    )
  const camera = (detected: boolean) =>
    source.onCameraMotion({ deviceId: CAM, detected, timestamp: Date.now() })
  const level = (sensorId: number, on: boolean) => {
    const now = Date.now()
    if (sensorId === GATE) {
      source.onSensorState({
        sensorId,
        capName: 'contact',
        slice: { entryOpen: on, lastChangedAt: now },
        observedAtMs: now,
      })
    } else {
      source.onSensorState({
        sensorId,
        capName: 'motion',
        slice: { detected: on, lastDetectedAt: on ? now : now - 1_000 },
        observedAtMs: now,
      })
    }
  }
  const after = (ms: number) => vi.advanceTimersByTime(ms)
  return { source, emitted, lines, attach, camera, level, after }
}

afterEach(() => {
  vi.useRealTimers()
})

const trig = (m: CameraSensorsMotion | undefined) => m?.triggeredBy

describe('pass-through (C7)', () => {
  it('a camera whose sensors are not resolved yet (a respawn, settings not loaded) passes through — fail open', () => {
    const h = harness()
    h.camera(true)
    expect(h.emitted).toEqual([
      { deviceId: CAM, detected: true, timestamp: T0, triggeredBy: { kind: 'camera' } },
    ])
  })
  it('a camera with no attached sensor: every raw push goes out verbatim, named as the camera', () => {
    const h = harness()
    h.source.onCameraMotion({ deviceId: 101, detected: true, timestamp: T0, regions: [] })
    h.source.onCameraMotion({ deviceId: 101, detected: false, timestamp: T0 + 3_000 })
    expect(h.emitted).toEqual([
      {
        deviceId: 101,
        detected: true,
        timestamp: T0,
        triggeredBy: { kind: 'camera' },
        regions: [],
      },
      { deviceId: 101, detected: false, timestamp: T0 + 3_000, triggeredBy: { kind: 'camera' } },
    ])
  })
  it('a camera whose sensors are not forwarded (onboard not listed) passes its own motion through; its sensors stay silent', () => {
    const h = harness({ sources: ['analyzer'] })
    h.attach([[PIR, 'replace']])
    h.after(1_000)
    h.camera(true)
    h.level(PIR, true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([[true, { kind: 'camera' }]])
  })
})

describe('Replace (C2, C3, C9)', () => {
  it("the camera's own motion is dropped and said; the sensor's rise and fall are the camera's motion", () => {
    const h = harness()
    h.attach([[PIR, 'replace']])
    h.after(1_000)
    h.camera(true)
    expect(h.emitted).toEqual([])
    expect(
      h.lines.find((l) => l.message === 'camera-sensors: camera motion not counted')?.meta,
    ).toMatchObject({ reason: 'replaced', droppedCount: 1 })
    h.level(PIR, true)
    h.after(2_000)
    h.level(PIR, false)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([
      [true, { kind: 'sensor', deviceId: PIR }],
      [false, { kind: 'sensor', deviceId: PIR }],
    ])
  })
  it('a Replace sensor that is not ready hands the camera back', () => {
    const h = harness()
    h.attach([[PIR, 'replace', false]])
    h.after(1_000)
    h.camera(true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([[true, { kind: 'camera' }]])
  })
})

describe('Confirm (C2, C4, C10)', () => {
  it('with a Replace sensor: the camera counts only while a Confirm sensor is active — either order', () => {
    const h = harness()
    h.attach([
      [PIR, 'replace'],
      [GATE, 'confirm'],
    ])
    h.after(1_000)
    h.camera(true)
    expect(h.emitted).toEqual([])
    h.level(GATE, true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([
      [true, { kind: 'sensor', deviceId: GATE }],
    ])
  })
  it('a Confirm sensor that fell 5 s before the camera still confirms it; 31 s before, it does not', () => {
    const h = harness()
    h.attach([
      [PIR, 'replace'],
      [GATE, 'confirm'],
    ])
    h.after(1_000)
    h.level(GATE, true)
    h.after(1_000)
    h.level(GATE, false)
    h.after(5_000)
    h.camera(true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([[true, { kind: 'camera' }]])
    h.camera(false)
    h.after(31_000)
    h.camera(true)
    expect(h.emitted.filter((m) => m.detected)).toHaveLength(1)
  })
  it('Q1 ruling: a Confirm sensor GATES the camera even without a Replace sensor', () => {
    const h = harness()
    h.attach([[GATE, 'confirm']])
    h.after(1_000)
    h.camera(true)
    expect(h.emitted).toEqual([])
    expect(
      h.lines.find((l) => l.message === 'camera-sensors: camera motion not counted')?.meta,
    ).toMatchObject({
      reason: 'not-confirmed',
      cameraMotion: 'when-confirmed',
    })
    h.level(GATE, true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([
      [true, { kind: 'sensor', deviceId: GATE }],
    ])
  })
  it('a lone Confirm that is not ready hands the camera back (C3)', () => {
    const h = harness()
    h.attach([[GATE, 'confirm', false]])
    h.after(1_000)
    h.camera(true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([[true, { kind: 'camera' }]])
  })
  it('a Confirm sensor ALREADY high when it is first watched (a respawn) confirms, bounded by maxSessionHoldMs (task 10 review M3)', () => {
    const h = harness({ maxHoldMs: 60_000 })
    h.attach([[GATE, 'confirm']])
    // first sighting: the contact has been open for 10 min — a stale first sighting, never an emitted rise
    h.source.onSensorState({
      sensorId: GATE,
      capName: 'contact',
      slice: { entryOpen: true, lastChangedAt: T0 - 600_000 },
      observedAtMs: T0,
    })
    expect(h.emitted).toEqual([])
    h.after(1_000)
    h.camera(true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([[true, { kind: 'camera' }]])
    h.camera(false)
    h.after(61_000)
    h.camera(true)
    expect(h.emitted.filter((m) => m.detected)).toHaveLength(1)
  })
})

describe('In addition, now on the effective stream (D672 rule 8, C8)', () => {
  it('neither side`s false ends motion the other still sees; the last false names the first trigger', () => {
    const h = harness()
    h.attach([[PIR, 'in-addition']])
    h.after(1_000)
    h.level(PIR, true)
    h.camera(true)
    h.level(PIR, false)
    expect(h.emitted.filter((m) => !m.detected)).toEqual([])
    h.camera(false)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([
      [true, { kind: 'sensor', deviceId: PIR }],
      [true, { kind: 'sensor', deviceId: PIR }],
      [false, { kind: 'sensor', deviceId: PIR }],
    ])
  })
  it('a heartbeat-only camera (true, never false) stops counting after its cooldown: the next rise is a NEW trigger', () => {
    const h = harness()
    h.attach([[PIR, 'in-addition']])
    h.after(1_000)
    h.camera(true)
    h.after(31_000)
    h.level(PIR, true)
    expect(h.emitted.map((m) => trig(m))).toEqual([
      { kind: 'camera' },
      { kind: 'sensor', deviceId: PIR },
    ])
  })
})

describe('a sensor stuck high is bounded per sensor (C5, D672 rule 9 amended)', () => {
  it('past maxSessionHoldMs with no new rise: said once, the false goes out, and a ready Replace sensor still replaces', () => {
    const h = harness({ maxHoldMs: 20_000 })
    h.attach([[PIR, 'replace']])
    h.after(1_000)
    h.level(PIR, true)
    h.after(22_500)
    const stuck = h.lines.filter(
      (l) => l.message === 'camera-sensors: sensor high too long — sustain stopped',
    )
    expect(stuck).toHaveLength(1)
    expect(stuck[0]?.meta).toMatchObject({ reason: 'sensor-stuck-high', sourceDeviceId: PIR })
    expect(h.emitted.at(-1)).toMatchObject({
      detected: false,
      triggeredBy: { kind: 'sensor', deviceId: PIR },
    })
    h.camera(true)
    expect(h.emitted.at(-1)?.detected).toBe(false)
  })
})

describe('a stuck sensor is said ONCE per episode while another sensor keeps the sustain running (C5)', () => {
  it('the stuck PIR is said once across many ticks; the other sensor still holds the motion', () => {
    const h = harness({ maxHoldMs: 20_000 })
    h.attach([
      [PIR, 'in-addition'],
      [GATE, 'in-addition'],
    ])
    h.after(1_000)
    h.level(PIR, true)
    h.after(21_000)
    h.level(GATE, true)
    // two sustain ticks while the GATE is fresh: the stuck PIR must not be said again
    h.after(16_000)
    const stuck = h.lines.filter(
      (l) => l.message === 'camera-sensors: sensor high too long — sustain stopped',
    )
    expect(stuck).toHaveLength(1)
    expect(stuck[0]?.meta).toMatchObject({ sourceDeviceId: PIR, falseWithheld: true })
    expect(h.emitted.at(-1)?.detected).toBe(true)
  })
})

describe('an unsplit provider (C13)', () => {
  it('is reported only where Confirm/Replace would have suppressed something, and said once', () => {
    const h = harness()
    h.attach([[PIR, 'in-addition']])
    h.source.noteDirectCameraMotion(CAM, true)
    expect(h.source.enforcementOf(CAM)).toBeNull()
    h.attach([[PIR, 'replace']])
    h.source.noteDirectCameraMotion(CAM, true)
    h.source.noteDirectCameraMotion(CAM, false)
    expect(h.source.enforcementOf(CAM)).toBe('provider-not-split')
    expect(h.lines.filter((l) => l.meta?.['reason'] === 'provider-not-split')).toHaveLength(1)
    expect(h.emitted).toEqual([])
  })
})

describe('the owed false (task 12 review H1, H2)', () => {
  it("an input's own false reaches consumers even after the effective level expired (an edge camera, 60 s of motion)", () => {
    const h = harness()
    h.attach([[PIR, 'in-addition']])
    h.after(1_000)
    h.camera(true)
    h.after(60_000)
    h.camera(false)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([
      [true, { kind: 'camera' }],
      [false, { kind: 'camera' }],
    ])
  })
  it('a pass-through true followed by the first resolution still gets its false (a respawn)', () => {
    const h = harness()
    h.camera(true)
    h.attach([[PIR, 'replace']])
    h.camera(false)
    expect(h.emitted.map((m) => m.detected)).toEqual([true, false])
  })
  it('never two falses in a row; a clear for a camera never seen rising passes once (task 13 review H2)', () => {
    const h = harness()
    h.attach([[PIR, 'in-addition']])
    h.after(1_000)
    h.camera(false) // this instance never saw the rise (a respawn): passed once, for the exports
    h.camera(true)
    h.camera(false)
    h.camera(false)
    h.level(PIR, false)
    expect(h.emitted.map((m) => m.detected)).toEqual([false, true, false])
  })
})

describe('a small motionCooldownMs is floored at two sustain intervals (task 12 review H3)', () => {
  it("cooldown 0: the camera's own motion still counts — never every edge dropped", () => {
    const h = harness({ cooldownMs: 0 })
    h.attach([[PIR, 'in-addition']])
    h.after(1_000)
    h.camera(true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([[true, { kind: 'camera' }]])
    expect(h.lines.some((l) => l.message === 'camera-sensors: camera motion not counted')).toBe(
      false,
    )
  })
  it('cooldown 1 000: a held sensor is sustained across ticks and its false goes out', () => {
    const h = harness({ cooldownMs: 1_000 })
    h.attach([[PIR, 'in-addition']])
    h.after(1_000)
    h.level(PIR, true)
    h.after(16_000)
    h.level(PIR, false)
    expect(h.emitted.filter((m) => m.detected).length).toBeGreaterThan(2)
    expect(h.emitted.at(-1)).toMatchObject({
      detected: false,
      triggeredBy: { kind: 'sensor', deviceId: PIR },
    })
  })
})

describe('a Replace sensor already high at a respawn does not silence the camera (task 12 review M1)', () => {
  it('until its first real edge it hands the camera back', () => {
    const h = harness()
    h.attach([[PIR, 'replace']])
    h.source.onSensorState({
      sensorId: PIR,
      capName: 'motion',
      slice: { detected: true, lastDetectedAt: T0 - 600_000 },
      observedAtMs: T0,
    })
    h.after(1_000)
    h.camera(true)
    expect(h.emitted.map((m) => [m.detected, trig(m)])).toEqual([[true, { kind: 'camera' }]])
  })
})

describe('the gates a disarm left green (task 12 review M2)', () => {
  it('C11: a camera-held motion arms no sustain tick', () => {
    const h = harness()
    h.attach([[GATE, 'confirm']])
    h.after(1_000)
    h.level(GATE, true)
    h.camera(true)
    const before = h.emitted.length
    h.after(20_000)
    expect(h.emitted.length).toBe(before)
  })
  it('a stuck sensor that rises again is said again', () => {
    const h = harness({ maxHoldMs: 20_000 })
    h.attach([
      [PIR, 'in-addition'],
      [GATE, 'in-addition'],
    ])
    h.after(1_000)
    h.level(PIR, true)
    h.after(21_000)
    h.level(GATE, true)
    h.after(8_000)
    const said = () =>
      h.lines.filter((l) => l.message === 'camera-sensors: sensor high too long — sustain stopped')
        .length
    expect(said()).toBe(1)
    h.level(PIR, false)
    h.level(PIR, true)
    h.level(GATE, false)
    h.level(GATE, true)
    h.after(15_000)
    h.level(GATE, false)
    h.level(GATE, true)
    // ticks every 7.5 s from the first rise: the next lands at 53.5 s, the PIR 23.5 s past its re-rise
    h.after(10_000)
    expect(said()).toBe(2)
  })
  it('a new episode says a stuck sensor again', () => {
    const h = harness({ maxHoldMs: 20_000 })
    h.attach([[PIR, 'replace']])
    h.after(1_000)
    h.level(PIR, true)
    h.after(22_500)
    h.level(PIR, false)
    h.after(40_000)
    h.level(PIR, true)
    h.after(22_500)
    expect(
      h.lines.filter((l) => l.message === 'camera-sensors: sensor high too long — sustain stopped'),
    ).toHaveLength(2)
  })
  it('a sensor still stuck when a NEW episode opens (raised by another sensor) is said again in it', () => {
    const h = harness({ maxHoldMs: 20_000 })
    h.attach([
      [PIR, 'in-addition'],
      [GATE, 'in-addition'],
    ])
    h.after(1_000)
    h.level(PIR, true)
    h.after(23_000)
    // the PIR was released as stuck: the episode closed; it never falls (its off was lost)
    expect(h.emitted.at(-1)?.detected).toBe(false)
    h.after(40_000)
    h.level(GATE, true)
    h.after(8_000)
    expect(
      h.lines.filter((l) => l.message === 'camera-sensors: sensor high too long — sustain stopped'),
    ).toHaveLength(2)
  })
  it('the camera-confirmed line names WHO confirmed: only the active Confirm sensors (C10, L4)', () => {
    const h = harness()
    const OTHER = 3302
    h.attach([
      [PIR, 'replace'],
      [GATE, 'confirm'],
      [OTHER, 'confirm'],
    ])
    h.after(1_000)
    h.level(GATE, true)
    h.after(1_000)
    h.level(GATE, false)
    h.after(1_000)
    h.camera(true)
    const counted = h.lines
      .filter((l) => l.message === 'camera-sensors: camera motion counted')
      .at(-1)
    expect(counted?.meta).toMatchObject({ confirmedBy: [GATE] })
  })
  it('a Confirm completing the camera names the camera as the confirmed side', () => {
    const h = harness()
    h.attach([
      [PIR, 'replace'],
      [GATE, 'confirm'],
    ])
    h.after(1_000)
    h.camera(true)
    h.level(GATE, true)
    const rise = h.lines.find(
      (l) => l.message === 'camera-sensors: attached sensor triggered camera motion',
    )
    expect(rise?.meta).toMatchObject({ confirmedBy: 'camera' })
  })
  it('regions ride the combined path too', () => {
    const h = harness()
    h.attach([[PIR, 'in-addition']])
    h.after(1_000)
    h.source.onCameraMotion({ deviceId: CAM, detected: true, timestamp: Date.now(), regions: [] })
    expect(h.emitted.at(-1)).toMatchObject({ regions: [] })
  })
})
