import { describe, expect, it, vi } from 'vitest'
import {
  DEVICE_LIVENESS_HOLDOFF_MS,
  DeviceLivenessHoldoff,
  isDeviceLivenessKind,
  isNodeLivenessKind,
} from '../liveness-holdoff.js'
import type { NcIncomingEvent } from '../event-intake.js'

function incoming(deviceId: number, online: boolean, timestamp = 1): NcIncomingEvent {
  const kind = online ? 'device-online' : 'device-offline'
  return {
    kind: 'system-event',
    origin: 'system',
    subject: {
      kind: 'system-event',
      recordId: `device:${deviceId}:${kind}`,
      deviceId,
      timestamp,
      classNames: [],
      zones: [],
      systemEvent: {
        kind,
        subject: `device:${deviceId}`,
        titleKey: 'system.device-offline.title',
        bodyKey: 'system.device-offline.body',
        textParams: {},
        deviceId,
        data: {},
      },
    },
    log: () => ({ tags: { deviceId }, meta: { kind } }),
  }
}

describe('isDeviceLivenessKind', () => {
  it('covers cameras, not nodes or streams', () => {
    expect(isDeviceLivenessKind('device-offline')).toBe(true)
    expect(isDeviceLivenessKind('device-online')).toBe(true)
    expect(isDeviceLivenessKind('node-offline')).toBe(false)
    expect(isDeviceLivenessKind('stream-offline')).toBe(false)
  })
})

describe('DeviceLivenessHoldoff', () => {
  it('swallows a plugin-restart bounce that returns to the seeded state', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const holdoff = new DeviceLivenessHoldoff(flush)
    holdoff.remember('device:108', 'online')
    holdoff.arm('device:108', incoming(108, false))
    holdoff.arm('device:108', incoming(108, true))
    vi.advanceTimersByTime(DEVICE_LIVENESS_HOLDOFF_MS)
    expect(flush).not.toHaveBeenCalled()
    holdoff.dispose()
    vi.useRealTimers()
  })

  it('notifies once the new state has been stable for the hold-off', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const holdoff = new DeviceLivenessHoldoff(flush)
    holdoff.remember('device:108', 'online')
    holdoff.arm('device:108', incoming(108, false))
    vi.advanceTimersByTime(DEVICE_LIVENESS_HOLDOFF_MS - 1)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]![0].subject.systemEvent?.kind).toBe('device-offline')
    holdoff.dispose()
    vi.useRealTimers()
  })

  it('delay 0 flushes immediately (test wiring)', () => {
    const flush = vi.fn()
    const holdoff = new DeviceLivenessHoldoff(flush, { delayMs: 0 })
    holdoff.remember('device:1', 'online')
    holdoff.arm('device:1', incoming(1, false))
    expect(flush).toHaveBeenCalledTimes(1)
    holdoff.dispose()
  })
})

describe('isNodeLivenessKind', () => {
  it('covers node-online / node-offline only', () => {
    expect(isNodeLivenessKind('node-offline')).toBe(true)
    expect(isNodeLivenessKind('node-online')).toBe(true)
    expect(isNodeLivenessKind('node-restarting')).toBe(false)
    expect(isNodeLivenessKind('device-offline')).toBe(false)
  })
})

describe('DeviceLivenessHoldoff timing', () => {
  it('reports when the announced state began and when the one it replaces began', () => {
    const flush = vi.fn()
    const holdoff = new DeviceLivenessHoldoff(flush, { delayMs: 0 })
    holdoff.remember('device:7', 'online')
    holdoff.arm('device:7', incoming(7, false, 1_000))
    expect(flush.mock.calls[0]![1]).toEqual({ since: 1_000 })
    holdoff.arm('device:7', incoming(7, true, 61_000))
    expect(flush.mock.calls[1]![1]).toEqual({ since: 61_000, previousSince: 1_000 })
    holdoff.dispose()
  })

  it('counts an outage from the FIRST departure, not the flip that finally settled', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const holdoff = new DeviceLivenessHoldoff(flush, { delayMs: 60_000 })
    holdoff.remember('node:a', 'online')
    holdoff.arm('node:a', incoming(1, false, 10_000))
    holdoff.arm('node:a', incoming(1, false, 20_000)) // same state again
    vi.advanceTimersByTime(60_000)
    expect(flush.mock.calls[0]![1]).toEqual({ since: 10_000 })
    holdoff.dispose()
    vi.useRealTimers()
  })

  it('a bounce back to the notified state resets the departure', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const holdoff = new DeviceLivenessHoldoff(flush, { delayMs: 60_000 })
    holdoff.remember('node:a', 'online')
    holdoff.arm('node:a', incoming(1, false, 10_000))
    holdoff.arm('node:a', incoming(1, true, 12_000))
    holdoff.arm('node:a', incoming(1, false, 30_000))
    vi.advanceTimersByTime(60_000)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]![1]).toEqual({ since: 30_000 })
    holdoff.dispose()
    vi.useRealTimers()
  })

  it('remember() settles the subject: a pending flip is no longer announced', () => {
    vi.useFakeTimers()
    const flush = vi.fn()
    const holdoff = new DeviceLivenessHoldoff(flush, { delayMs: 60_000 })
    holdoff.remember('node:a', 'online')
    holdoff.arm('node:a', incoming(1, false, 10_000))
    // e.g. the recovery came back with the all-clear switched off
    holdoff.remember('node:a', 'online')
    vi.advanceTimersByTime(120_000)
    expect(flush).not.toHaveBeenCalled()
    holdoff.dispose()
    vi.useRealTimers()
  })
})
