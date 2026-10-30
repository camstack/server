import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BATTERY_REFRESH_TICK_MS,
  BatteryHourlyRefresh,
  type BatteryRefreshOutcome,
  decideBatteryRefresh,
  MAX_ATTEMPTS_PER_WINDOW,
  RETRY_BACKOFF_MS,
  resolveBatteryRefreshIntervalMs,
  staggerOffsetMs,
  wakeLeadMs,
  windowIndex,
} from '../battery-hourly-refresh.js'
import { createRecordingLogger } from './clip-test-logger.js'

/**
 * D847 — a battery camera refreshes ALL its facts and its snapshot exactly once
 * per window: found awake ⇒ refresh then and skip the wake; otherwise woken
 * ONCE at the window's deadline. Driven through the real 60 s timer on a fake
 * clock, with fakes standing in for the camera.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const DEVICE_ID = 106
const INTERVAL = HOUR
const OFFSET = staggerOffsetMs(DEVICE_ID, INTERVAL)

/** A clock origin that sits exactly at the start of window 1_000 for DEVICE_ID. */
const WINDOW_START = OFFSET + 1_000 * INTERVAL

interface Rig {
  readonly ctl: BatteryHourlyRefresh
  readonly logger: ReturnType<typeof createRecordingLogger>
  readonly counts: { wakes: number; refreshes: number }
  readonly state: {
    awake: boolean
    stamp: number | undefined
    wakeWorks: boolean
    nextOutcome: BatteryRefreshOutcome
    intervalMs: number
  }
  readonly stop: () => void
}

function rig(overrides?: Partial<Rig['state']>): Rig {
  const logger = createRecordingLogger()
  const counts = { wakes: 0, refreshes: 0 }
  const state: Rig['state'] = {
    awake: false,
    stamp: undefined,
    wakeWorks: true,
    nextOutcome: { failed: [] },
    intervalMs: INTERVAL,
    ...overrides,
  }
  const ctl = new BatteryHourlyRefresh({
    deviceId: DEVICE_ID,
    logger,
    now: () => Date.now(),
    isAwake: () => state.awake,
    intervalMs: () => state.intervalMs,
    lastFullRefreshAt: () => state.stamp,
    wake: async () => {
      counts.wakes += 1
      if (state.wakeWorks) state.awake = true
      return state.wakeWorks
    },
    refreshAll: async () => {
      counts.refreshes += 1
      return state.nextOutcome
    },
    stamp: (at) => {
      state.stamp = at
    },
  })
  const timer = setInterval(() => void ctl.tick(), BATTERY_REFRESH_TICK_MS)
  return { ctl, logger, counts, state, stop: () => clearInterval(timer) }
}

describe('scheduled battery refresh (D847)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(WINDOW_START)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('found awake and due: ONE refresh, no wake', async () => {
    const r = rig({ awake: true })
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(r.counts).toEqual({ wakes: 0, refreshes: 1 })
    expect(r.state.stamp).toBeDefined()
    r.stop()
  })

  it('never awake for the whole window: exactly ONE wake and ONE refresh, at the deadline', async () => {
    const r = rig({ awake: false })
    // Well inside the window: nothing may touch the camera.
    await vi.advanceTimersByTimeAsync(INTERVAL - wakeLeadMs(INTERVAL) - 2 * MIN)
    expect(r.counts).toEqual({ wakes: 0, refreshes: 0 })
    // Through the window's end: the single wake.
    await vi.advanceTimersByTimeAsync(wakeLeadMs(INTERVAL) + MIN)
    expect(r.counts).toEqual({ wakes: 1, refreshes: 1 })
    expect(r.state.stamp).toBeDefined()
    r.stop()
  })

  it('awake twice within the window: one refresh', async () => {
    const r = rig({ awake: false })
    await vi.advanceTimersByTimeAsync(10 * MIN)
    r.state.awake = true // an event wakes it
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(r.counts.refreshes).toBe(1)
    r.state.awake = false
    await vi.advanceTimersByTimeAsync(10 * MIN)
    r.state.awake = true // a live view wakes it again
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(r.counts).toEqual({ wakes: 0, refreshes: 1 })
    r.stop()
  })

  it('an awake moment in the window spares the wake: three hours, three refreshes, zero wakes', async () => {
    const r = rig({ awake: false })
    for (let hour = 0; hour < 3; hour += 1) {
      await vi.advanceTimersByTimeAsync(20 * MIN)
      r.state.awake = true
      await vi.advanceTimersByTimeAsync(5 * MIN)
      r.state.awake = false
      await vi.advanceTimersByTimeAsync(35 * MIN)
    }
    expect(r.counts).toEqual({ wakes: 0, refreshes: 3 })
    r.stop()
  })

  it('a sleeping camera over three windows costs one wake per window, never more', async () => {
    const r = rig({ awake: false })
    for (let i = 0; i < 3 * 60; i += 1) {
      await vi.advanceTimersByTimeAsync(MIN)
      r.state.awake = false // it goes back to sleep after each refresh
    }
    expect(r.counts.wakes).toBe(3)
    expect(r.counts.refreshes).toBe(3)
    r.stop()
  })

  it('a wake-transition noticed while due refreshes once and tells the caller it covered the tail', async () => {
    const r = rig({ awake: false })
    await vi.advanceTimersByTimeAsync(15 * MIN)
    const covered = await r.ctl.noteAwake()
    expect(covered).toBe(true)
    expect(r.counts).toEqual({ wakes: 0, refreshes: 1 })
    // …and the same call again in this window is not a second refresh.
    expect(await r.ctl.noteAwake()).toBe(false)
    expect(r.counts.refreshes).toBe(1)
    r.stop()
  })

  it('a refresh in flight is joined, never started twice', async () => {
    let release: (outcome: BatteryRefreshOutcome) => void = () => {}
    let started = 0
    const logger = createRecordingLogger()
    let stamp: number | undefined
    const ctl = new BatteryHourlyRefresh({
      deviceId: DEVICE_ID,
      logger,
      now: () => Date.now(),
      isAwake: () => true,
      intervalMs: () => INTERVAL,
      lastFullRefreshAt: () => stamp,
      wake: async () => true,
      refreshAll: () => {
        started += 1
        return new Promise<BatteryRefreshOutcome>((resolve) => {
          release = resolve
        })
      },
      stamp: (at) => {
        stamp = at
      },
    })
    const first = ctl.tick()
    const second = ctl.noteAwake()
    const third = ctl.tick()
    release({ failed: [] })
    expect(await Promise.all([first, second, third])).toEqual([true, true, true])
    expect(started).toBe(1)
  })

  it('a stamp that survived a restart is not repeated', async () => {
    const r = rig({ awake: true, stamp: WINDOW_START + MIN })
    await vi.advanceTimersByTimeAsync(5 * MIN)
    expect(r.counts).toEqual({ wakes: 0, refreshes: 0 })
    r.stop()
  })

  it('a failed refresh is logged with the deviceId, not stamped, and bounded per window', async () => {
    const r = rig({ awake: true, nextOutcome: { failed: ['battery', 'snapshot'] } })
    await vi.advanceTimersByTimeAsync((3 * HOUR) / 4)
    // Two attempts at most in a window, however long the camera stays up.
    expect(r.counts.refreshes).toBe(MAX_ATTEMPTS_PER_WINDOW)
    expect(r.state.stamp).toBeUndefined()
    const warn = r.logger.warns.find((l) => l.message.includes('incomplete'))
    expect(warn?.extras.tags).toEqual({ deviceId: DEVICE_ID })
    expect(warn?.extras.meta).toMatchObject({ failed: ['battery', 'snapshot'] })
    // The dropped window says so on the record.
    expect(
      r.logger.infos.some(
        (l) =>
          l.message.includes('skipped') &&
          (l.extras.meta as { reason?: string } | undefined)?.reason === 'attempts-exhausted',
      ),
    ).toBe(true)
    r.stop()
  })

  it('the retry waits out the backoff and then succeeds', async () => {
    const r = rig({ awake: true, nextOutcome: { failed: ['snapshot'] } })
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(r.counts.refreshes).toBe(1)
    r.state.nextOutcome = { failed: [] }
    await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS - 5 * MIN)
    expect(r.counts.refreshes).toBe(1) // still backing off
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(r.counts.refreshes).toBe(2)
    expect(r.state.stamp).toBeDefined()
    r.stop()
  })

  it('a wake that fails is logged and is not a wake loop', async () => {
    const r = rig({ awake: false, wakeWorks: false })
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    // Two windows: at most two attempts each, spaced by the backoff.
    expect(r.counts.wakes).toBeLessThanOrEqual(2 * MAX_ATTEMPTS_PER_WINDOW)
    expect(r.counts.wakes).toBeGreaterThanOrEqual(1)
    expect(r.counts.refreshes).toBe(0)
    const warn = r.logger.warns.find((l) => l.message.includes('wake did not bring'))
    expect(warn?.extras.tags).toEqual({ deviceId: DEVICE_ID })
    r.stop()
  })

  it('interval 0 turns it off: no wake, no refresh, ever', async () => {
    const r = rig({ awake: false, intervalMs: 0 })
    await vi.advanceTimersByTimeAsync(5 * HOUR)
    r.state.awake = true
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(r.counts).toEqual({ wakes: 0, refreshes: 0 })
    r.stop()
  })

  it('a refresh that throws is logged and retried, not fatal', async () => {
    const logger = createRecordingLogger()
    let calls = 0
    const ctl = new BatteryHourlyRefresh({
      deviceId: DEVICE_ID,
      logger,
      now: () => Date.now(),
      isAwake: () => true,
      intervalMs: () => INTERVAL,
      lastFullRefreshAt: () => undefined,
      wake: async () => true,
      refreshAll: async () => {
        calls += 1
        throw new Error('socket closed')
      },
      stamp: () => {},
    })
    await expect(ctl.tick()).resolves.toBe(false)
    expect(calls).toBe(1)
    expect(logger.warns[0]?.extras.tags).toEqual({ deviceId: DEVICE_ID })
  })
})

describe('the pure pieces', () => {
  it('resolves the window: default, off, clamp', () => {
    expect(resolveBatteryRefreshIntervalMs(undefined)).toBe(HOUR)
    expect(resolveBatteryRefreshIntervalMs(0)).toBe(0)
    expect(resolveBatteryRefreshIntervalMs(1)).toBe(15 * MIN)
    expect(resolveBatteryRefreshIntervalMs(9_999)).toBe(240 * MIN)
  })

  it('staggers devices inside one window', () => {
    const offsets = new Set([1, 2, 3, 640, 4263].map((id) => staggerOffsetMs(id, INTERVAL)))
    expect(offsets.size).toBeGreaterThan(1)
    for (const o of offsets) expect(o).toBeLessThan(INTERVAL)
  })

  it('does not wake before the deadline and does at it', () => {
    const base = {
      intervalMs: INTERVAL,
      offsetMs: 0,
      lastFullRefreshAt: undefined,
      awake: false,
      attemptsInWindow: 0,
      lastAttemptAt: undefined,
    }
    expect(decideBatteryRefresh({ ...base, nowMs: 10 * HOUR + 10 * MIN })).toEqual({
      kind: 'skip',
      reason: 'asleep-before-deadline',
    })
    expect(decideBatteryRefresh({ ...base, nowMs: 11 * HOUR - 1 * MIN })).toEqual({
      kind: 'wake-then-refresh',
    })
    expect(windowIndex(10 * HOUR, INTERVAL, 0)).toBe(10)
  })
})
