/**
 * D1062 — the cloud motion read is the core's to schedule: a camera on the
 * `cloud` motion source registers `device-state-refresh` (push none) and owns
 * no timer; a refresh reads the events API and a failing cloud fails the call.
 */
import { EventCategory } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { WyzeCamera } from '../wyze-camera.js'

const MAC = 'AABBCCDDEEFF'

interface CloudEvent {
  readonly deviceMac: string
  readonly alarmType: string
  readonly timestamp: number
  readonly aiTags: readonly string[]
}

function makeSubject(options: {
  readonly motionSource: string
  readonly events: () => Promise<readonly CloudEvent[]>
  readonly signedIn?: boolean
}) {
  const registered: {
    name: string
    provider: unknown
    registration: unknown
  }[] = []
  const emitted: { category: string; data: Record<string, unknown> }[] = []
  const config = new Map<string, unknown>([
    ['motionSource', options.motionSource],
    ['mac', MAC],
    ['integrationId', 'wyze-int'],
  ])
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
  const subject = {
    id: 620,
    lastMotionEventTs: 0,
    cloudSignedOut: false,
    signedIn: options.signedIn !== false,
    config: { get: (key: string) => config.get(key) },
    deps: {
      cloud: () => (subject.signedIn ? { getEventList: vi.fn(options.events) } : null),
    },
    emitMotion: (timestamp: number) =>
      emitted.push({
        category: EventCategory.ProviderMotion,
        data: { timestamp },
      }),
    pollCloudMotion: WyzeCamera.prototype['pollCloudMotion'],
    ctx: {
      logger,
      registerNativeCap: (cap: { name: string }, provider: unknown, registration?: unknown) => {
        registered.push({ name: cap.name, provider, registration })
      },
    },
  }
  const refresh = async (): Promise<unknown> => {
    const found = registered.find((r) => r.name === 'device-state-refresh')?.provider
    if (typeof found !== 'object' || found === null || !('refresh' in found)) {
      throw new Error('no refresh provider registered')
    }
    const call: unknown = found.refresh
    if (typeof call !== 'function') throw new Error('refresh is not a function')
    return call({ deviceId: 620, deviceIds: [620], reason: 'interval' })
  }
  return { subject, registered, emitted, refresh, logger }
}

describe('Wyze cloud motion through device-state-refresh (D1062)', () => {
  it('a cloud camera declares a polled read of 15 s under its integration', () => {
    const h = makeSubject({ motionSource: 'cloud', events: async () => [] })
    WyzeCamera.prototype['startMotionPolling'].call(h.subject)
    expect(h.registered.find((r) => r.name === 'device-state-refresh')?.registration).toMatchObject(
      {
        stateRefresh: {
          integrationId: 'wyze-int',
          minIntervalMs: 15_000,
          push: 'none',
        },
      },
    )
  })

  it('a camera on another motion source registers no refresh', () => {
    const h = makeSubject({ motionSource: 'boa', events: async () => [] })
    WyzeCamera.prototype['startMotionPolling'].call(h.subject)
    expect(h.registered.some((r) => r.name === 'device-state-refresh')).toBe(false)
  })

  it('a refresh emits the newest motion once, and not again until a newer one', async () => {
    const events: CloudEvent[] = [
      { deviceMac: MAC, alarmType: 'motion', timestamp: 100, aiTags: [] },
      { deviceMac: MAC, alarmType: 'motion', timestamp: 300, aiTags: [] },
      { deviceMac: 'OTHER', alarmType: 'motion', timestamp: 900, aiTags: [] },
    ]
    const h = makeSubject({
      motionSource: 'cloud',
      events: async () => events,
    })
    WyzeCamera.prototype['startMotionPolling'].call(h.subject)
    await h.refresh()
    await h.refresh()
    expect(h.emitted.map((e) => e.data['timestamp'])).toEqual([300])
  })

  it('a refresh fails when the cloud cannot answer, so the core backs off', async () => {
    const down = makeSubject({
      motionSource: 'cloud',
      events: async () => {
        throw new Error('cloud 500')
      },
    })
    WyzeCamera.prototype['startMotionPolling'].call(down.subject)
    await expect(down.refresh()).rejects.toThrow(/cloud 500/)
  })

  it('signed out is not a failed read: it returns, logs once on the change, and logs the return', async () => {
    const h = makeSubject({ motionSource: 'cloud', events: async () => [], signedIn: false })
    WyzeCamera.prototype['startMotionPolling'].call(h.subject)
    await expect(h.refresh()).resolves.toEqual({ ok: true })
    await expect(h.refresh()).resolves.toEqual({ ok: true })
    await expect(h.refresh()).resolves.toEqual({ ok: true })
    expect(h.logger.warn).toHaveBeenCalledTimes(1)
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('not signed in'), {
      tags: { deviceId: 620 },
    })
    h.subject.signedIn = true
    await h.refresh()
    expect(h.logger.info).toHaveBeenCalledWith(expect.stringContaining('resumed'), {
      tags: { deviceId: 620 },
    })
    h.subject.signedIn = false
    await h.refresh()
    expect(h.logger.warn).toHaveBeenCalledTimes(2)
  })

  it('owns no timer: nothing is read while time passes', async () => {
    vi.useFakeTimers()
    try {
      const reads = vi.fn(async () => [])
      const h = makeSubject({ motionSource: 'cloud', events: reads })
      WyzeCamera.prototype['startMotionPolling'].call(h.subject)
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(reads).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
