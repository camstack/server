import { describe, expect, it } from 'vitest'
import {
  DRAIN_PROGRESS_EVENT_INTERVAL_MS,
  StorageDrainEventMonitor,
  type StorageDrainEventSample,
} from '../storage-drain-event-monitor.js'

const sample = (overrides: Partial<StorageDrainEventSample> = {}): StorageDrainEventSample => ({
  locationId: 'rec-a',
  locationName: 'Recordings',
  bytesRemaining: 90_000,
  rateBytesPerMs: 1,
  estimatedEmptyAtMs: 1_090_000,
  drained: false,
  ...overrides,
})

describe('StorageDrainEventMonitor', () => {
  it('emits a progress event immediately, then throttles to the cadence', () => {
    let nowMs = 0
    const m = new StorageDrainEventMonitor(DRAIN_PROGRESS_EVENT_INTERVAL_MS, () => nowMs)

    // First sweep ever: fires right away, no waiting for the cadence.
    expect(m.observe([sample()])).toEqual([
      expect.objectContaining({ kind: 'progress', locationId: 'rec-a' }),
    ])

    // A sweep a minute later, well inside the cadence: silent.
    nowMs += 60_000
    expect(m.observe([sample({ bytesRemaining: 89_000 })])).toEqual([])

    // Still silent right up to one ms before the cadence elapses.
    nowMs += DRAIN_PROGRESS_EVENT_INTERVAL_MS - 60_000 - 1
    expect(m.observe([sample({ bytesRemaining: 50_000 })])).toEqual([])

    // The cadence has now elapsed: fires again, with the latest figures.
    nowMs += 1
    expect(m.observe([sample({ bytesRemaining: 49_000 })])).toEqual([
      expect.objectContaining({ kind: 'progress', locationId: 'rec-a', bytesRemaining: 49_000 }),
    ])
  })

  it('emits the completion event exactly once, never again while still drained', () => {
    let nowMs = 0
    const m = new StorageDrainEventMonitor(DRAIN_PROGRESS_EVENT_INTERVAL_MS, () => nowMs)
    m.observe([sample()])

    nowMs += 1_000
    const drained = sample({
      bytesRemaining: 0,
      rateBytesPerMs: null,
      estimatedEmptyAtMs: null,
      drained: true,
    })
    expect(m.observe([drained])).toEqual([
      expect.objectContaining({ kind: 'complete', locationId: 'rec-a', bytesRemaining: 0 }),
    ])

    // Every later sweep while still drained (e.g. nothing wrote yet): silent.
    nowMs += 10 * DRAIN_PROGRESS_EVENT_INTERVAL_MS
    expect(m.observe([drained])).toEqual([])

    // The location leaves the drain sweep entirely (active again) and then
    // drains a second time: a fresh completion is reachable.
    expect(m.observe([])).toEqual([])
    nowMs += 1_000
    expect(m.observe([sample()])).toEqual([
      expect.objectContaining({ kind: 'progress', locationId: 'rec-a' }),
    ])
    nowMs += 1_000
    expect(m.observe([drained])).toEqual([
      expect.objectContaining({ kind: 'complete', locationId: 'rec-a' }),
    ])
  })

  it('a failed occupancy read reports unknown fields, not zero (D393), and keeps the cadence', () => {
    let nowMs = 0
    const m = new StorageDrainEventMonitor(DRAIN_PROGRESS_EVENT_INTERVAL_MS, () => nowMs)
    const unknown = sample({ bytesRemaining: null, rateBytesPerMs: null, estimatedEmptyAtMs: null })
    expect(m.observe([unknown])).toEqual([
      expect.objectContaining({
        kind: 'progress',
        bytesRemaining: null,
        rateBytesPerMs: null,
        estimatedEmptyAtMs: null,
      }),
    ])
  })
})
