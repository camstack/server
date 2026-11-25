import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEVICE_LIVENESS_HOLDOFF_MS,
  DeviceLivenessHoldoff,
  type LivenessSuppressed,
} from '../liveness-holdoff.js'
import type { NcIncomingEvent } from '../event-intake.js'

/** The window the operator asked for (planning#714) — written out, never imported. */
const WINDOW_MS = 90_000

function flip(deviceId: number, online: boolean, timestamp: number): NcIncomingEvent {
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

describe('device liveness stability window (planning#714)', () => {
  const flush = vi.fn()
  const suppressed = vi.fn<(event: NcIncomingEvent, info: LivenessSuppressed) => void>()
  let holdoff: DeviceLivenessHoldoff

  beforeEach(() => {
    vi.useFakeTimers()
    flush.mockReset()
    suppressed.mockReset()
    holdoff = new DeviceLivenessHoldoff(flush, { onSuppressed: suppressed })
    holdoff.remember('device:5', 'online')
  })
  afterEach(() => {
    holdoff.dispose()
    vi.useRealTimers()
  })

  it('is ninety seconds', () => {
    expect(DEVICE_LIVENESS_HOLDOFF_MS).toBe(WINDOW_MS)
  })

  it('offline then online within the window sends nothing, and says why', () => {
    holdoff.arm('device:5', flip(5, false, 1_000))
    vi.advanceTimersByTime(60_000)
    holdoff.arm('device:5', flip(5, true, 61_000))
    vi.advanceTimersByTime(WINDOW_MS * 2)
    expect(flush).not.toHaveBeenCalled()
    expect(suppressed).toHaveBeenCalledTimes(1)
    expect(suppressed.mock.calls[0]![1]).toEqual({
      subject: 'device:5',
      flip: 'offline',
      revertedTo: 'online',
      elapsedMs: 60_000,
    })
  })

  it('offline held for the whole window sends exactly one notification', () => {
    holdoff.arm('device:5', flip(5, false, 1_000))
    vi.advanceTimersByTime(WINDOW_MS - 1)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(WINDOW_MS * 3)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('online → offline → online → offline sends one, at the end of the last window', () => {
    holdoff.arm('device:5', flip(5, false, 0))
    vi.advanceTimersByTime(20_000)
    holdoff.arm('device:5', flip(5, true, 20_000))
    vi.advanceTimersByTime(20_000)
    holdoff.arm('device:5', flip(5, false, 40_000))
    vi.advanceTimersByTime(WINDOW_MS - 1)
    expect(flush).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(flush).toHaveBeenCalledTimes(1)
    expect(flush.mock.calls[0]![0].subject.systemEvent?.kind).toBe('device-offline')
    expect(flush.mock.calls[0]![1]).toEqual({ since: 40_000 })
  })

  it('a removed device fires no timer', () => {
    holdoff.arm('device:5', flip(5, false, 1_000))
    holdoff.forget('device:5')
    vi.advanceTimersByTime(WINDOW_MS * 2)
    expect(flush).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('dispose leaves no timer behind', () => {
    holdoff.arm('device:5', flip(5, false, 1_000))
    holdoff.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
