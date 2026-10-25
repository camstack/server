import { EventCategory, type IEventBus, type IScopedLogger } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AddonHealthMonitor,
  HEALTH_MONITOR_RETRY_INTERVALS_MS,
  HEALTH_MONITOR_TICK_MS,
} from '../addon-health-monitor.js'

const noopLogger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
  withTags: () => noopLogger,
}

interface CapturedEvent {
  category: EventCategory
  data: Record<string, unknown>
}

interface BusEvent {
  readonly category?: string
  readonly data?: Record<string, unknown>
}

function makeBus(): { bus: IEventBus; events: CapturedEvent[] } {
  const events: CapturedEvent[] = []
  const bus: IEventBus = {
    emit: (e: BusEvent) => {
      events.push({
        category: (e.category as EventCategory | undefined) ?? ('' as EventCategory),
        data: e.data ?? {},
      })
    },
    subscribe: () => () => {},
    subscribeToCategory: () => () => {},
  } as unknown as IEventBus
  return { bus, events }
}

let now = 0
const clock = () => now

beforeEach(() => {
  now = 1_000_000
})

describe('AddonHealthMonitor', () => {
  describe('grace period semantics', () => {
    it('suppresses AddonLoadFailed during grace, emits it after grace', async () => {
      const { bus, events } = makeBus()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn: vi.fn(),
        gracePeriodMs: 60_000,
        tickIntervalMs: 30_000,
        now: clock,
      })

      // Failure during grace → no AddonLoadFailed
      m.recordFailure('@camstack/addon-foo', new Error('boom'))
      const failedDuringGrace = events.filter((e) => e.category === EventCategory.AddonLoadFailed)
      expect(failedDuringGrace).toEqual([])

      // Move past grace + tick → flushes deferred alert
      now += 70_000
      await m.tick()
      const failedAfterGrace = events.filter((e) => e.category === EventCategory.AddonLoadFailed)
      expect(failedAfterGrace).toHaveLength(1)
      expect(failedAfterGrace[0]!.data['packageName']).toBe('@camstack/addon-foo')
    })

    it('emits AddonLoadFailed immediately when failure happens after grace', () => {
      const { bus, events } = makeBus()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn: vi.fn(),
        gracePeriodMs: 60_000,
        now: clock,
      })

      now += 70_000 // past grace
      m.recordFailure('@camstack/addon-foo', new Error('boom'))
      const failed = events.filter((e) => e.category === EventCategory.AddonLoadFailed)
      expect(failed).toHaveLength(1)
    })

    it('emits exactly once per failure-streak (not on every retry)', async () => {
      const { bus, events } = makeBus()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn: vi.fn().mockRejectedValue(new Error('still broken')),
        gracePeriodMs: 60_000,
        now: clock,
      })

      now += 70_000
      m.recordFailure('@camstack/addon-foo', new Error('first'))
      m.recordFailure('@camstack/addon-foo', new Error('second'))
      m.recordFailure('@camstack/addon-foo', new Error('third'))

      const failed = events.filter((e) => e.category === EventCategory.AddonLoadFailed)
      expect(failed).toHaveLength(1)
    })
  })

  describe('retry intervals', () => {
    it('retries first within ONE tick — a boot-transient load failure is not a minute of downtime', () => {
      // A retry can only fire on a tick, so a first interval larger than the
      // tick is pure added latency. It was 60 s, which kept an addon that
      // failed only because the boot was still settling down for 60–90 s
      // (docs/design/boot-to-usable-camera.md, item E).
      expect(HEALTH_MONITOR_RETRY_INTERVALS_MS[0]!).toBeLessThanOrEqual(HEALTH_MONITOR_TICK_MS)
    })

    it('schedules next retry at the configured intervals (30s, 120s, 300s, 300s, 300s...)', () => {
      const { bus } = makeBus()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn: vi.fn(),
        now: clock,
      })

      const t0 = now
      m.recordFailure('@x', new Error('1'))
      expect(m.getHealth('@x')!.nextRetryAt).toBe(t0 + HEALTH_MONITOR_RETRY_INTERVALS_MS[0]!)

      now += 1
      m.recordFailure('@x', new Error('2'))
      expect(m.getHealth('@x')!.nextRetryAt).toBe(now + HEALTH_MONITOR_RETRY_INTERVALS_MS[1]!)

      now += 1
      m.recordFailure('@x', new Error('3'))
      expect(m.getHealth('@x')!.nextRetryAt).toBe(now + HEALTH_MONITOR_RETRY_INTERVALS_MS[2]!)

      // Beyond the configured array — caps at the last entry (5min).
      now += 1
      m.recordFailure('@x', new Error('4'))
      expect(m.getHealth('@x')!.nextRetryAt).toBe(now + HEALTH_MONITOR_RETRY_INTERVALS_MS[2]!)

      now += 1
      m.recordFailure('@x', new Error('5'))
      expect(m.getHealth('@x')!.nextRetryAt).toBe(now + HEALTH_MONITOR_RETRY_INTERVALS_MS[2]!)
    })
  })

  describe('recovery', () => {
    it('emits AddonLoadRecovered when previously-alerting addon recovers', async () => {
      const { bus, events } = makeBus()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn: vi.fn(),
        gracePeriodMs: 60_000,
        now: clock,
      })

      // Fail post-grace → emits AddonLoadFailed
      now += 70_000
      m.recordFailure('@camstack/addon-foo', new Error('boom'))
      expect(events.filter((e) => e.category === EventCategory.AddonLoadFailed)).toHaveLength(1)

      // Recover → emits AddonLoadRecovered
      m.recordSuccess('@camstack/addon-foo')
      const recovered = events.filter((e) => e.category === EventCategory.AddonLoadRecovered)
      expect(recovered).toHaveLength(1)
      expect(m.getHealth('@camstack/addon-foo')!.phase).toBe('healthy')
    })

    it('does NOT emit AddonLoadRecovered when never alerted', () => {
      const { bus, events } = makeBus()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn: vi.fn(),
        gracePeriodMs: 60_000,
        now: clock,
      })

      // Fail during grace (no alert), then recover
      m.recordFailure('@camstack/addon-foo', new Error('boom'))
      m.recordSuccess('@camstack/addon-foo')
      expect(events.filter((e) => e.category === EventCategory.AddonLoadRecovered)).toEqual([])
    })
  })

  describe('tick + retry execution', () => {
    it('runs retryFn when nextRetryAt is reached', async () => {
      const { bus } = makeBus()
      const retryFn = vi.fn().mockResolvedValue(undefined)
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn,
        gracePeriodMs: 60_000,
        now: clock,
      })

      m.recordFailure('@camstack/addon-foo', new Error('boom'))
      expect(retryFn).not.toHaveBeenCalled()

      // Advance past nextRetryAt and tick.
      now += HEALTH_MONITOR_RETRY_INTERVALS_MS[0]! + 1
      await m.tick()

      expect(retryFn).toHaveBeenCalledWith('@camstack/addon-foo')
      // retryFn resolved without throwing → monitor should have marked
      // the addon healthy (auto-resolve fallback in attemptRetry).
      expect(m.getHealth('@camstack/addon-foo')!.phase).toBe('healthy')
    })

    it('rebumps nextRetryAt when retryFn throws', async () => {
      const { bus } = makeBus()
      const retryFn = vi.fn().mockRejectedValue(new Error('still broken'))
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn,
        gracePeriodMs: 60_000,
        now: clock,
      })

      m.recordFailure('@x', new Error('1'))
      now += HEALTH_MONITOR_RETRY_INTERVALS_MS[0]! + 1
      await m.tick()

      expect(retryFn).toHaveBeenCalledTimes(1)
      expect(m.getHealth('@x')!.phase).toBe('failed')
      expect(m.getHealth('@x')!.retryCount).toBe(2)
      // Next interval should be 120s (second slot).
      expect(m.getHealth('@x')!.nextRetryAt).toBe(now + HEALTH_MONITOR_RETRY_INTERVALS_MS[1]!)
    })
  })

  describe('retryNow', () => {
    it('resets counter and runs retryFn immediately', async () => {
      const { bus } = makeBus()
      const retryFn = vi.fn().mockResolvedValue(undefined)
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn,
        gracePeriodMs: 60_000,
        now: clock,
      })

      // Build up a failure history.
      m.recordFailure('@x', new Error('1'))
      m.recordFailure('@x', new Error('2'))
      m.recordFailure('@x', new Error('3'))
      expect(m.getHealth('@x')!.retryCount).toBe(3)

      // User clicks retry → counter resets to 0, then attempts.
      await m.retryNow('@x')

      expect(retryFn).toHaveBeenCalledWith('@x')
      expect(m.getHealth('@x')!.phase).toBe('healthy')
      expect(m.getHealth('@x')!.retryCount).toBe(0)
    })

    it('logs warning when called on unknown package', async () => {
      const warn = vi.fn()
      const logger: IScopedLogger = { ...noopLogger, warn }
      const { bus } = makeBus()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger,
        retryFn: vi.fn(),
        now: clock,
      })

      await m.retryNow('@unknown')
      expect(warn).toHaveBeenCalledWith('retryNow called on unknown package', expect.any(Object))
    })
  })

  describe('forget (uninstall path)', () => {
    it('drops state so no further retries are attempted', async () => {
      const { bus } = makeBus()
      const retryFn = vi.fn()
      const m = new AddonHealthMonitor({
        eventBus: bus,
        logger: noopLogger,
        retryFn,
        gracePeriodMs: 60_000,
        now: clock,
      })

      m.recordFailure('@x', new Error('boom'))
      m.forget('@x')

      now += HEALTH_MONITOR_RETRY_INTERVALS_MS[0]! + 1
      await m.tick()
      expect(retryFn).not.toHaveBeenCalled()
      expect(m.getHealth('@x')).toBeNull()
    })
  })
})
