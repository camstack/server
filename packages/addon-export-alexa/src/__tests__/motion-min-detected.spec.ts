/**
 * Amazon (alexa-motionsensor): "When a motion sensor changes to `DETECTED`,
 * and then changes to `NOT_DETECTED`, you must wait at least 30 seconds before
 * sending the second change report." The quiet-source hold alone (5 s) let a
 * short motion clear after ~5 s; the clear must also wait until 30 s after the
 * DETECTED report went out.
 */
import { EventCategory } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LwaEventGateway, type LwaEventGatewayDeps } from '../lwa-event-gateway.js'
import { MIN_DETECTED_BEFORE_CLEAR_MS, MotionClearHold } from '../motion-clear-hold.js'

describe('MotionClearHold — minimum DETECTED duration', () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(1_700_000_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pins the Amazon minimum at 30 s', () => {
    expect(MIN_DETECTED_BEFORE_CLEAR_MS).toBe(30_000)
  })

  it('a short motion clears 30 s after DETECTED, not after the 5 s hold', () => {
    const hold = new MotionClearHold({ holdMs: 5_000, minDetectedMs: 30_000 })
    const release = vi.fn()
    expect(hold.onDetected('k')).toBe(true)
    vi.advanceTimersByTime(1_000)
    hold.onCleared('k', release)
    vi.advanceTimersByTime(28_999)
    expect(release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a long motion still clears after the quiet hold', () => {
    const hold = new MotionClearHold({ holdMs: 5_000, minDetectedMs: 30_000 })
    const release = vi.fn()
    hold.onDetected('k')
    vi.advanceTimersByTime(40_000)
    hold.onCleared('k', release)
    vi.advanceTimersByTime(4_999)
    expect(release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a clear for an unknown key (after a restart) waits the full minimum', () => {
    const hold = new MotionClearHold({ holdMs: 5_000, minDetectedMs: 30_000 })
    const release = vi.fn()
    hold.onCleared('k', release)
    vi.advanceTimersByTime(29_999)
    expect(release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('the gateway applies the minimum', () => {
  const noop = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    withTags: () => noop,
  } as unknown as LwaEventGatewayDeps['logger']

  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(1_700_000_000_000)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 202, text: async () => '' }) as unknown as Response),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('NOT_DETECTED for a 1 s motion is posted 30 s after DETECTED', async () => {
    let handler: ((e: { data: unknown }) => void) | null = null
    const gw = new LwaEventGateway({
      ctx: {
        eventBus: {
          subscribe: (f: { category: string }, h: (e: { data: unknown }) => void) => {
            if (f.category === EventCategory.MotionOnMotionChanged) handler = h
            return () => {}
          },
        },
        api: {},
      } as unknown as LwaEventGatewayDeps['ctx'],
      logger: noop,
      listExposed: () =>
        [{ deviceId: 104 }] as unknown as ReturnType<LwaEventGatewayDeps['listExposed']>,
      listLinkedAccounts: () => [{ userId: 'u', username: 'u', linkedAt: 0 }],
      listTokens: () => [
        {
          userId: 'u',
          accessToken: 't',
          refreshToken: 'r',
          expiresAt: Date.now() + 1e9,
          receivedAt: 0,
        },
      ],
      upsertToken: async () => {},
      removeLinkedAccount: async () => {},
      getAdvertisedBrokerUrl: () => null,
      getRegion: () => 'EU',
      getExportedSignature: () => null,
      accountMaySee: () => true,
    })
    gw.start()
    const emit = async (detected: boolean) => {
      handler?.({ data: { deviceId: 104, detected, timestamp: Date.now() } })
      await vi.advanceTimersByTimeAsync(0)
    }
    const posts = () =>
      (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await emit(true)
    await vi.advanceTimersByTimeAsync(1_000)
    await emit(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(posts()).toBe(1)
    await vi.advanceTimersByTimeAsync(19_000)
    expect(posts()).toBe(2)
    gw.stop()
  })
})
