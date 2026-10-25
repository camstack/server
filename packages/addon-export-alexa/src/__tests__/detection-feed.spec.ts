/**
 * R1 — the detection sensors' feed: pipeline events in, ChangeReports out,
 * with the reconcile that heals a dropped `end`, and nothing at all while the
 * integration switch is off.
 */
import type { AddonContext } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DetectionSensorFeed } from '../detection-sensors/detection-feed.js'
import { quietLogger } from './helpers/fake-device-api.js'

type Handler = (event: { data: unknown }) => void

function harness(
  opts: {
    enabled?: boolean
    active?: () => Promise<{ trackId: string; className: string }[]>
  } = {},
) {
  const handlers = new Map<string, Handler>()
  const eventBus = {
    subscribe: (filter: { category: string }, handler: Handler) => {
      handlers.set(filter.category, handler)
      return () => handlers.delete(filter.category)
    },
  } as unknown as AddonContext['eventBus']
  const pushed: string[] = []
  const feed = new DetectionSensorFeed({
    eventBus,
    enabled: () => opts.enabled ?? true,
    isExposed: (id) => id === 101,
    readActiveTracks: opts.active ?? (async () => []),
    push: async (deviceId, cls, detected) => {
      pushed.push(`${deviceId}:${cls}:${detected ? 'DETECTED' : 'NOT_DETECTED'}`)
    },
    logger: quietLogger,
  })
  feed.start()
  const emit = (category: string, data: unknown) => handlers.get(category)?.({ data })
  return { feed, emit, pushed, handlers }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DetectionSensorFeed', () => {
  it('a person track on an exposed camera reports its sensor DETECTED, then cleared on end', async () => {
    const h = harness()
    h.emit(EventCategory.PipelineAnalyticsTrackLifecycle, {
      deviceId: 101,
      trackId: 't1',
      phase: 'start',
      bestClassName: 'person',
    })
    h.emit(EventCategory.PipelineAnalyticsTrackLifecycle, {
      deviceId: 101,
      trackId: 't1',
      phase: 'end',
      bestClassName: 'person',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.pushed).toEqual(['101:person:DETECTED', '101:person:NOT_DETECTED'])
  })

  it('the minute reconcile clears a sensor whose end was dropped', async () => {
    const h = harness({ active: async () => [] })
    h.emit(EventCategory.PipelineAnalyticsTrackLifecycle, {
      deviceId: 101,
      trackId: 't1',
      phase: 'start',
      bestClassName: 'vehicle',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.pushed).toEqual(['101:vehicle:DETECTED', '101:vehicle:NOT_DETECTED'])
  })

  it('a failed reconcile read changes nothing', async () => {
    const h = harness({
      active: async () => {
        throw new Error('down')
      },
    })
    h.emit(EventCategory.PipelineAnalyticsTrackLifecycle, {
      deviceId: 101,
      trackId: 't1',
      phase: 'start',
      bestClassName: 'vehicle',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.pushed).toEqual(['101:vehicle:DETECTED'])
    expect(h.feed.isPresent(101, 'vehicle')).toBe(true)
  })

  it('a package delivery pulses the Package sensor', async () => {
    const h = harness()
    h.emit(EventCategory.PipelineAnalyticsPackageDelivered, { deviceId: 101, entryId: 'e1' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.pushed).toEqual(['101:package:DETECTED', '101:package:NOT_DETECTED'])
  })

  it('nothing is sent while the switch is off, or for a camera that is not exposed', async () => {
    const off = harness({ enabled: false })
    off.emit(EventCategory.PipelineAnalyticsTrackLifecycle, {
      deviceId: 101,
      trackId: 't1',
      phase: 'start',
      bestClassName: 'person',
    })
    const other = harness()
    other.emit(EventCategory.PipelineAnalyticsTrackLifecycle, {
      deviceId: 999,
      trackId: 't1',
      phase: 'start',
      bestClassName: 'person',
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(off.pushed).toEqual([])
    expect(other.pushed).toEqual([])
    expect(off.feed.isPresent(101, 'person')).toBe(false)
  })

  it('stop() unsubscribes', () => {
    const h = harness()
    h.feed.stop()
    expect(h.handlers.size).toBe(0)
  })
})
