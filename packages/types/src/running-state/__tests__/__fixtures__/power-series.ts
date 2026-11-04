/**
 * Deterministic power histories for the running-threshold proposal. Every
 * fixture is a held-value step series; a seeded generator keeps them stable.
 */
import { DeviceType } from '../../../device/device-type.js'
import type { ProposalSeries, ProposalStepPoint } from '../../propose-threshold.js'

export const SEC = 1000
export const MIN = 60 * SEC
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
export const T0 = Date.UTC(2026, 0, 5, 0, 0, 0)

function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

interface Builder {
  readonly points: ProposalStepPoint[]
  readonly rand: () => number
  /** Hold a value from `t`. */
  put(t: number, value: number): void
  /** Sample `value()` every `stepMs` over [from, to). */
  span(from: number, to: number, stepMs: number, value: (t: number) => number): void
}

function builder(seed: number): Builder {
  const points: ProposalStepPoint[] = []
  const rand = rng(seed)
  return {
    points,
    rand,
    put: (t, value) => points.push({ t, value }),
    span: (from, to, stepMs, value) => {
      for (let t = from; t < to; t += stepMs) points.push({ t, value: value(t) })
    },
  }
}

function series(b: Builder, days: number): ProposalSeries {
  return {
    tier: 'raw',
    from: T0,
    to: T0 + days * DAY,
    truncated: false,
    before: null,
    points: [...b.points].sort((x, y) => x.t - y.t),
  }
}

function standby(b: Builder, from: number, to: number, lo: number, hi: number, blip: number): void {
  b.span(from, to, 60 * SEC, () => lo + b.rand() * (hi - lo))
  // a short blip every few hours, as a display waking
  for (let t = from + 3 * HOUR; t < to - HOUR; t += 5 * HOUR) b.put(t, blip)
}

export interface WasherOptions {
  readonly days: number
}

/** 2 kW heat, 60-200 W tumble, two 3-8 min soak pauses near 2 W, standby 0.5-1.5 W with 4 W blips. */
export function washer({ days }: WasherOptions = { days: 6 }): ProposalSeries {
  const b = builder(11)
  for (let d = 0; d < days; d += 1) {
    const day = T0 + d * DAY
    const runAt = day + 9 * HOUR
    standby(b, day, runAt, 0.5, 1.5, 4)
    let t = runAt
    const tumble = (ms: number): void => {
      b.span(t, t + ms, 30 * SEC, () => 60 + b.rand() * 140)
      t += ms
    }
    const heat = (ms: number): void => {
      b.span(t, t + ms, 30 * SEC, () => 1950 + b.rand() * 100)
      t += ms
    }
    const soak = (ms: number): void => {
      b.span(t, t + ms, 30 * SEC, () => 1.5 + b.rand())
      t += ms
    }
    heat(15 * MIN)
    tumble(20 * MIN)
    soak(3 * MIN + d * MIN)
    tumble(15 * MIN)
    soak(8 * MIN - (d % 3) * MIN)
    tumble(10 * MIN)
    standby(b, t, day + DAY, 0.5, 1.5, 4)
  }
  return series(b, days)
}

/** 1.8 kW plateau for 90 min, a 15 min cool-down taper, one run a day. */
export function dryer({ days }: WasherOptions = { days: 3 }): ProposalSeries {
  const b = builder(23)
  for (let d = 0; d < days; d += 1) {
    const day = T0 + d * DAY
    const runAt = day + 14 * HOUR
    standby(b, day, runAt, 0.5, 1.5, 3)
    b.span(runAt, runAt + 90 * MIN, 60 * SEC, () => 1750 + b.rand() * 100)
    const taperAt = runAt + 90 * MIN
    b.span(
      taperAt,
      taperAt + 15 * MIN,
      60 * SEC,
      (t) => 1800 * Math.exp(-(t - taperAt) / (3 * MIN)),
    )
    standby(b, taperAt + 15 * MIN, day + DAY, 0.5, 1.5, 3)
  }
  return series(b, days)
}

/** 1.2 kW thermostat, 8 min on / 15 min off for 90 min, morning and evening, for three days. */
export function heater(): ProposalSeries {
  const b = builder(37)
  const days = 3
  for (let d = 0; d < days; d += 1) {
    const day = T0 + d * DAY
    let t = day
    for (const sessionAt of [day + 6 * HOUR, day + 18 * HOUR]) {
      b.span(t, sessionAt, 60 * SEC, () => 0.2 + b.rand() * 0.8)
      t = sessionAt
      const end = sessionAt + 90 * MIN
      while (t < end) {
        b.span(t, t + 8 * MIN, 60 * SEC, () => 1180 + b.rand() * 40)
        t += 8 * MIN
        b.span(t, t + 15 * MIN, 60 * SEC, () => 0.2 + b.rand() * 0.8)
        t += 15 * MIN
      }
    }
    b.span(t, day + DAY, 60 * SEC, () => 0.2 + b.rand() * 0.8)
  }
  return series(b, days)
}

/** A good washer cycle, but only three hours of it. */
export function tooShort(): ProposalSeries {
  const b = builder(5)
  standby(b, T0, T0 + HOUR, 0.5, 1.5, 4)
  b.span(T0 + HOUR, T0 + 2 * HOUR, 30 * SEC, () => 1950 + b.rand() * 100)
  standby(b, T0 + 2 * HOUR, T0 + 3 * HOUR, 0.5, 1.5, 4)
  return { ...series(b, 0), to: T0 + 3 * HOUR }
}

/** Two watts, three days, nothing ever ran. */
export function flat(): ProposalSeries {
  const b = builder(7)
  b.put(T0, 2)
  return series(b, 3)
}

/** Standby jittering 1-8 W (a chatty smart plug), a 100-130 W run each day. */
export function noisyStandby(): ProposalSeries {
  const b = builder(41)
  const days = 4
  for (let d = 0; d < days; d += 1) {
    const day = T0 + d * DAY
    b.span(day, day + 10 * HOUR, 30 * SEC, () => 1 + b.rand() * 7)
    b.span(day + 10 * HOUR, day + 12 * HOUR, 30 * SEC, () => 100 + b.rand() * 30)
    b.span(day + 12 * HOUR, day + DAY, 30 * SEC, () => 1 + b.rand() * 7)
  }
  return series(b, days)
}

/** Spends equal time at 0, 500 and 1000 W: no level to call idle. */
export function noFloor(): ProposalSeries {
  const b = builder(3)
  const days = 2
  const levels = [0, 500, 1000]
  for (let t = T0, i = 0; t < T0 + days * DAY; t += 30 * MIN, i += 1) b.put(t, levels[i % 3] ?? 0)
  return series(b, days)
}

/**
 * A wash whose drum rests at 10 W for 5 minutes mid-cycle: above the coarse
 * activity bar, below the threshold the proposal picks, so no pause is seen
 * and only the replay can tell the stop dwell is too short.
 */
export function washerWithLulls(): ProposalSeries {
  const b = builder(53)
  const days = 5
  for (let d = 0; d < days; d += 1) {
    const day = T0 + d * DAY
    const runAt = day + 9 * HOUR
    standby(b, day, runAt, 0.5, 1.5, 4)
    let t = runAt
    const level = (ms: number, value: () => number): void => {
      b.span(t, t + ms, 30 * SEC, value)
      t += ms
    }
    level(15 * MIN, () => 1950 + b.rand() * 100)
    level(30 * MIN, () => 80 + b.rand() * 120)
    level(5 * MIN, () => 10)
    level(40 * MIN, () => 80 + b.rand() * 120)
    standby(b, t, day + DAY, 0.5, 1.5, 4)
  }
  return series(b, days)
}

/** Standby gaps of one hour and of a day alongside short pauses: the cut lands in the wrong place. */
export function ambiguousGaps(): ProposalSeries {
  const b = builder(61)
  const days = 3
  for (let d = 0; d < days; d += 1) {
    const day = T0 + d * DAY
    standby(b, day, day + 8 * HOUR, 0.5, 1.5, 4)
    let t = day + 8 * HOUR
    for (const gap of [3 * MIN, 4 * MIN, 5 * MIN, HOUR, 70 * MIN]) {
      b.span(t, t + 20 * MIN, 30 * SEC, () => 100 + b.rand() * 50)
      t += 20 * MIN
      b.span(t, t + gap, 30 * SEC, () => 0.5 + b.rand())
      t += gap
    }
    b.span(t, t + 20 * MIN, 30 * SEC, () => 100 + b.rand() * 50)
    standby(b, t + 20 * MIN, day + DAY, 0.5, 1.5, 4)
  }
  return series(b, days)
}

/** One cycle of the heat-pump dryer: start offset from `T0` and duration. */
interface DryerCycle {
  readonly startAt: number
  readonly durationMs: number
}

function at(day: number, hours: number, minutes: number): number {
  return T0 + day * DAY + hours * HOUR + minutes * MIN
}

/** The fourteen cycles of the real trace (days 0..3 = 2026-11-01..04), one of them a 4.7 min restart. */
const HEAT_PUMP_CYCLES: readonly DryerCycle[] = [
  { startAt: at(0, 21, 3), durationMs: 317 * MIN },
  { startAt: at(1, 8, 49), durationMs: 34 * MIN },
  { startAt: at(1, 10, 44), durationMs: 43 * MIN },
  { startAt: at(2, 11, 19), durationMs: 242 * MIN },
  { startAt: at(2, 15, 26), durationMs: 38 * MIN },
  { startAt: at(2, 16, 42), durationMs: 35 * MIN },
  { startAt: at(2, 17, 48), durationMs: 33 * MIN },
  { startAt: at(2, 19, 4), durationMs: 34 * MIN },
  { startAt: at(2, 21, 20), durationMs: 34 * MIN },
  { startAt: at(2, 22, 5), durationMs: 388 * MIN },
  { startAt: at(3, 9, 33), durationMs: 43 * MIN },
  { startAt: at(3, 10, 37), durationMs: 33 * MIN },
  { startAt: at(3, 16, 10), durationMs: 307 * MIN },
  { startAt: at(3, 22, 9), durationMs: 34 * MIN },
]

const HEAT_PUMP_RAMP_MS = 25 * MIN
const HEAT_PUMP_COMPRESSOR_MS = 4.5 * MIN
const HEAT_PUMP_DRUM_MS = 4 * MIN
const HEAT_PUMP_PULSE_MS = 45 * SEC
/** Anti-crease pulses after a cycle: +1.5, +11.5 and +21.5 minutes. */
const HEAT_PUMP_PULSE_OFFSETS_MS: readonly number[] = [1.5 * MIN, 11.5 * MIN, 21.5 * MIN]
const HEAT_PUMP_POWER_OFF_MS = 31 * MIN

/**
 * A heat-pump dryer as measured on a smart plug (planning#424): a 160-650 W ramp,
 * then compressor 650 W / drum-only 120-180 W alternating (never below ~115 W),
 * a 38 s dip to 2 W once mid-cycle, then a tail to 2 W and three 320 W x 45 s
 * anti-crease pulses before the dryer powers off (0 W). Fourteen cycles in four
 * days; one is a restart 4.7 min after the previous one ended.
 */
export function heatPumpDryer(): ProposalSeries {
  const b = builder(97)
  b.put(T0, 0)
  HEAT_PUMP_CYCLES.forEach((cycle, i) => {
    const end = cycle.startAt + cycle.durationMs
    const next = HEAT_PUMP_CYCLES[i + 1]?.startAt ?? Number.POSITIVE_INFINITY
    const rampEnd = cycle.startAt + HEAT_PUMP_RAMP_MS
    b.span(
      cycle.startAt,
      rampEnd,
      60 * SEC,
      (t) => 160 + ((t - cycle.startAt) / HEAT_PUMP_RAMP_MS) * 490,
    )
    let t = rampEnd
    while (t < end) {
      const compressorEnd = Math.min(end, t + HEAT_PUMP_COMPRESSOR_MS)
      b.span(t, compressorEnd, 60 * SEC, () => 560 + b.rand() * 150)
      t = compressorEnd
      const drumEnd = Math.min(end, t + HEAT_PUMP_DRUM_MS)
      b.span(t, drumEnd, 60 * SEC, () => 120 + b.rand() * 60)
      t = drumEnd
    }
    b.put(end, 12)
    b.put(end + 40 * SEC, 2)
    for (const offset of HEAT_PUMP_PULSE_OFFSETS_MS) {
      const pulseAt = end + offset
      if (pulseAt + HEAT_PUMP_PULSE_MS >= next) continue
      b.put(pulseAt, 280 + b.rand() * 90)
      b.put(pulseAt + HEAT_PUMP_PULSE_MS, 2)
    }
    if (end + HEAT_PUMP_POWER_OFF_MS < next) b.put(end + HEAT_PUMP_POWER_OFF_MS, 0)
  })
  // The one mid-cycle dip (2026-11-03 12:45): 38 s at 2 W.
  b.put(at(2, 12, 45), 2)
  b.put(at(2, 12, 45) + 38 * SEC, 600)
  return { ...series(b, 4), deviceType: DeviceType.Dryer }
}
