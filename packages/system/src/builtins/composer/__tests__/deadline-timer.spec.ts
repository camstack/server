import {
  type CompositionFieldPlan,
  compositionReadKey,
  planComposition,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  roomCompositionExample,
  type SourceReading,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompositionRuntime } from '../composition-runtime.js'
import { MAX_TIMER_DELAY_MS, NodeDeadlineTimer } from '../deadline-timer.js'
import { FakeTarget, LOOKUP_CAP, recordingLogger } from './fixtures.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** "Seen within 30 days": a legitimate window longer than Node's largest timer delay (~24.8 days). */
const WINDOW_MS = 30 * DAY_MS
const T0 = 1_000_000

const [T1, T2, T3] = ROOM_EXAMPLE_TEMPERATURE_SOURCES
const [M1, M2] = ROOM_EXAMPLE_MOTION_SOURCES

function longWindowPlan(): readonly CompositionFieldPlan[] {
  const composition = roomCompositionExample({
    temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
    motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
    occupancyWindowMs: WINDOW_MS,
  })
  const plan = planComposition(composition, LOOKUP_CAP)
  if (plan.problems.length > 0) throw new Error(plan.problems.map((p) => p.message).join('; '))
  return plan.fields
}

function readings(): Map<string, SourceReading> {
  const k = (source: typeof T1, cap: string, fieldPath: string) =>
    compositionReadKey({ source: source!, cap, fieldPath })
  const fresh = (value: number | boolean | null): SourceReading => ({ state: 'fresh', value })
  return new Map<string, SourceReading>([
    [k(T1, 'temperature-sensor', 'celsius'), fresh(21.0)],
    [k(T2, 'temperature-sensor', 'celsius'), fresh(21.5)],
    [k(T3, 'temperature-sensor', 'celsius'), fresh(21.4)],
    [k(T1, 'temperature-sensor', 'lastFetchedAt'), fresh(990_000)],
    [k(T2, 'temperature-sensor', 'lastFetchedAt'), fresh(995_000)],
    [k(T3, 'temperature-sensor', 'lastFetchedAt'), fresh(980_000)],
    [k(M1, 'motion', 'detected'), fresh(false)],
    [k(M2, 'motion', 'detected'), fresh(false)],
    [k(M1, 'motion', 'lastDetectedAt'), fresh(T0)],
    [k(M2, 'motion', 'lastDetectedAt'), fresh(null)],
  ])
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('NodeDeadlineTimer — a deadline beyond the largest timer delay (D3)', () => {
  it('never schedules more than MAX_TIMER_DELAY_MS, and re-arms the remainder instead of firing', () => {
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const timer = new NodeDeadlineTimer(() => Date.now())
    const fire = vi.fn()
    const at = T0 + 40 * DAY_MS
    timer.arm(at, fire)
    expect(scheduled).toHaveBeenCalledTimes(1)
    expect(scheduled.mock.calls[0]?.[1]).toBe(MAX_TIMER_DELAY_MS)
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    // The clamped wake-up is not the deadline: nothing fires, the remainder is armed.
    expect(fire).not.toHaveBeenCalled()
    expect(scheduled).toHaveBeenCalledTimes(2)
    expect(scheduled.mock.calls[1]?.[1]).toBe(at - (T0 + MAX_TIMER_DELAY_MS))
    vi.advanceTimersByTime(at - Date.now() - 1)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveBeenCalledTimes(2)
  })

  it('a disarm during the clamped leg cancels the whole deadline', () => {
    const timer = new NodeDeadlineTimer(() => Date.now())
    const fire = vi.fn()
    timer.arm(T0 + 40 * DAY_MS, fire)
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    timer.disarm()
    vi.advanceTimersByTime(40 * DAY_MS)
    expect(fire).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a composition with a `within` window of 30 days', () => {
  it('does not spin on a 1 ms re-fire, and flips at the real deadline', () => {
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const target = new FakeTarget(1901)
    const table = readings()
    let reads = 0
    const runtime = new CompositionRuntime({
      blockId: 'b-room',
      fields: longWindowPlan(),
      eventPlans: [],
      events: { emit: () => undefined },
      target,
      lookupCap: LOOKUP_CAP,
      read: (r) => {
        reads += 1
        return (
          table.get(compositionReadKey(r)) ?? {
            state: 'unavailable',
            reason: 'no fixture',
            fatal: false,
          }
        )
      },
      now: () => Date.now(),
      timer: new NodeDeadlineTimer(() => Date.now()),
      logger: recordingLogger().logger,
    })
    runtime.start()
    const binary = () => target.writes.filter((w) => w.cap === 'binary')
    expect(binary().at(-1)?.values).toMatchObject({ on: true })
    const readsAfterStart = reads
    const armsAfterStart = scheduled.mock.calls.length

    // A spin would wake every millisecond: one second is a thousand wake-ups.
    vi.advanceTimersByTime(1000)
    expect(scheduled.mock.calls.length).toBe(armsAfterStart)
    for (const call of scheduled.mock.calls) expect(call[1]).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS)

    const deadline = T0 + WINDOW_MS + 1
    vi.advanceTimersByTime(deadline - Date.now() - 1)
    expect(binary()).toHaveLength(1)
    expect(reads).toBe(readsAfterStart)
    // One clamped leg plus its remainder — never a loop.
    expect(scheduled.mock.calls.length).toBe(armsAfterStart + 1)

    vi.advanceTimersByTime(1)
    expect(binary().at(-1)).toEqual({
      op: 'patch',
      cap: 'binary',
      values: { on: false, lastChangedAt: deadline },
    })
    runtime.stop()
  })
})
