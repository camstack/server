/**
 * planning#710 — EVERY integration is held unknown after a (re)start, not only
 * the full-push ones. A POLLED integration (Gree) whose first read fails
 * because its connection is not bound yet is NOT an answer: the 09:03Z
 * restart flipped five climates offline then online 20 s later, and each flip
 * was notified. The first read that ANSWERED, the first state report or the
 * bound (120 s) releases the hold; a real first offline is still applied.
 */
import type { IScopedLogger, StateRefreshPolicy } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateRefreshPolicyRegistry } from '../../../kernel/state-refresh-policies.js'
import { FULL_PUSH_FIRST_REPORT_BOUND_MS } from '../state-refresh-scheduler.js'
import { startStateRefresh } from '../state-refresh-wiring.js'
import { harness } from './mirror-harness.js'

const POLICY: StateRefreshPolicy = {
  integrationId: 'gree-1',
  minIntervalMs: 10_000,
  batch: false,
  push: 'none',
}
const AC = 554
const ONLINE = { online: true, lastChangedAt: 1_000 }
const OFFLINE = { online: false, lastChangedAt: 2_000 }

const lines: { message: string; tags: unknown }[] = []
const logger: IScopedLogger = {
  debug: () => undefined,
  info: (message, extras) => void lines.push({ message, tags: extras?.tags }),
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

type Harness = ReturnType<typeof harness>

function rig(refresh: (h: Harness) => Promise<void>) {
  const h = harness()
  const policies = new StateRefreshPolicyRegistry()
  policies.set('in-process', {
    deviceId: AC,
    addonId: 'provider-gree',
    policy: POLICY,
  })
  const stop = startStateRefresh({
    mirror: h.mirror,
    logger,
    policies,
    refresh: () => refresh(h),
    resubscribe: async () => undefined,
  })
  h.mirror.seedMirror(AC, { 'device-status': ONLINE })
  return { h, stop }
}

const offlineEmitted = (h: Harness): number =>
  h.events.filter(
    (e) =>
      e.capName === 'device-status' && e.slice['online'] === false && e.slice['unknown'] !== true,
  ).length

describe('a polled integration restart (09:03Z incident shape)', () => {
  beforeEach(() => {
    lines.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('a first read that fails (connection not bound yet) does not release the held offline; the later online is never preceded by one', async () => {
    let reads = 0
    const { h, stop } = rig(async (hh) => {
      reads += 1
      if (reads === 1) throw new Error('gree: connection is not bound — no refresh')
      hh.mirror.applySingleCapUpdate(AC, 'device-status', {
        online: true,
        lastChangedAt: 21_000,
      })
    })
    h.mirror.applySingleCapUpdate(AC, 'device-status', OFFLINE)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(reads).toBe(1)
    expect(offlineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(reads).toBeGreaterThan(1)
    expect(offlineEmitted(h)).toBe(0)
    expect(h.mirror.capSlice(AC, 'device-status')).toMatchObject({
      online: true,
    })
    stop()
  })

  it('a real first offline that ANSWERED a read is applied', async () => {
    const { h, stop } = rig(async (hh) => {
      hh.mirror.applySingleCapUpdate(AC, 'device-status', OFFLINE)
    })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(offlineEmitted(h)).toBe(1)
    stop()
  })

  it('a device that never answers is still reported offline once the bound passes', async () => {
    const { h, stop } = rig(async () => {
      throw new Error('unreachable')
    })
    h.mirror.applySingleCapUpdate(AC, 'device-status', OFFLINE)
    await vi.advanceTimersByTimeAsync(FULL_PUSH_FIRST_REPORT_BOUND_MS - 1)
    expect(offlineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(offlineEmitted(h)).toBe(1)
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('within the bound'),
        tags: { deviceId: AC },
      }),
    )
    stop()
  })

  it('a state report on any provider cap is the first state, even before a read answered', async () => {
    const { h, stop } = rig(async () => {
      throw new Error('unreachable')
    })
    h.mirror.applySingleCapUpdate(AC, 'device-status', OFFLINE)
    h.mirror.applySingleCapUpdate(AC, 'thermostat', { mode: 'cool' })
    expect(offlineEmitted(h)).toBe(1)
    stop()
  })

  it('a provider silent past the bound (every read failed, nothing written) is concluded offline exactly once', async () => {
    const { h, stop } = rig(async () => {
      throw new Error('unreachable')
    })
    await vi.advanceTimersByTimeAsync(FULL_PUSH_FIRST_REPORT_BOUND_MS - 1)
    expect(offlineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(offlineEmitted(h)).toBe(1)
    await vi.advanceTimersByTimeAsync(FULL_PUSH_FIRST_REPORT_BOUND_MS * 2)
    expect(offlineEmitted(h)).toBe(1)
    stop()
  })
})
