/**
 * D904, the camera's half: the socket loss feeds the reachability tracker, its
 * verdicts become the normal DeviceOffline / DeviceOnline (once each), and the
 * firmware push keeps working exactly as before.
 */
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { ReolinkCamera } from '../reolink-camera.js'

interface Emitted {
  readonly category: string
  readonly data: Record<string, unknown>
}

interface Subject {
  online: boolean
  readonly emitted: Emitted[]
  readonly reachability: {
    readonly noteFailure: ReturnType<typeof vi.fn>
    readonly noteReachable: ReturnType<typeof vi.fn>
    readonly reset: ReturnType<typeof vi.fn>
  }
  readonly warn: ReturnType<typeof vi.fn>
}

function makeSubject(opts: { online: boolean; isBattery?: boolean; hubChild?: boolean }): Subject {
  const emitted: Emitted[] = []
  const warn = vi.fn()
  const subject = {
    id: 108,
    online: opts.online,
    isBattery: opts.isBattery ?? false,
    sleeping: false,
    api: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    lastEventAt: 0,
    emitted,
    warn,
    reachability: {
      noteFailure: vi.fn(),
      noteReachable: vi.fn(),
      reset: vi.fn(),
    },
    isHubChild: () => opts.hubChild ?? false,
    // The real gates, so the spec exercises the camera's own decision.
    ownsReachability: ReolinkCamera.prototype['ownsReachability'],
    noteUnreachable: ReolinkCamera.prototype['noteUnreachable'],
    markOnline(next: boolean): void {
      subject.online = next
    },
    markPassiveContact: vi.fn(),
    config: { get: (_key: string): unknown => undefined },
    eventSource: () => ({ type: 'device', id: 108, addonId: 'provider-reolink', deviceId: 108 }),
    ctx: {
      logger: { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() },
      eventBus: {
        emit: (e: Emitted): void => {
          emitted.push(e)
        },
      },
    },
  }
  return subject
}

describe('ReolinkCamera — offline from sustained unreachability (D904)', () => {
  it('a lost control socket opens a reachability window on a mains camera', () => {
    const s = makeSubject({ online: true })
    ReolinkCamera.prototype['scheduleReconnect'].call(s, 'close')
    expect(s.reachability.noteFailure).toHaveBeenCalledWith('close')
    expect(s.online).toBe(true)
    expect(s.emitted).toEqual([])
  })

  it('a battery camera losing its socket is asleep, not gone (D173): no window', () => {
    const s = makeSubject({ online: true, isBattery: true })
    ReolinkCamera.prototype['scheduleReconnect'].call(s, 'close')
    expect(s.reachability.noteFailure).not.toHaveBeenCalled()
  })

  it('the sustained verdict is the normal DeviceOffline, once', () => {
    const s = makeSubject({ online: true })
    const info = { since: 1, failures: 7, lastReason: 'EHOSTUNREACH' }
    ReolinkCamera.prototype['onReachabilityOffline'].call(s, info)
    ReolinkCamera.prototype['onReachabilityOffline'].call(s, info)

    expect(s.online).toBe(false)
    expect(s.emitted.map((e) => e.category)).toEqual([EventCategory.DeviceOffline])
    expect(s.emitted[0]?.data).toMatchObject({ deviceId: 108, reason: 'unreachable' })
    expect(s.warn).toHaveBeenCalledWith(
      'Reolink camera unreachable for the whole window — marked offline',
      expect.objectContaining({ tags: { deviceId: 108 } }),
    )
  })

  it('recovery is the normal DeviceOnline, once', () => {
    const s = makeSubject({ online: false })
    ReolinkCamera.prototype['onReachabilityOnline'].call(s, { offlineForMs: 5_000 })
    ReolinkCamera.prototype['onReachabilityOnline'].call(s, { offlineForMs: 5_000 })

    expect(s.online).toBe(true)
    expect(s.emitted.map((e) => e.category)).toEqual([EventCategory.DeviceOnline])
    expect(s.emitted[0]?.data).toMatchObject({ deviceId: 108, reason: 'reachable-again' })
  })

  it('a firmware offline push still emits DeviceOffline, and resets our own verdict', () => {
    const s = makeSubject({ online: true })
    ReolinkCamera.prototype.handleSimpleEvent.call(s, { type: 'offline', channel: 0, timestamp: 5 })

    expect(s.online).toBe(false)
    expect(s.emitted.map((e) => e.category)).toEqual([EventCategory.DeviceOffline])
    expect(s.emitted[0]?.data).toMatchObject({ reason: 'firmware-push' })
    expect(s.reachability.reset).toHaveBeenCalled()
  })
})
