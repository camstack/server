/**
 * D1099 — a device whose integration has not answered since a (re)start is
 * `unknown`, never offline. Offline is concluded only once the integration's
 * first read settled; an event that never arrives cannot strand a device.
 */
import type { IScopedLogger, StateRefreshPolicy } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateRefreshPolicyRegistry } from '../../../kernel/state-refresh-policies.js'
import { startStateRefresh } from '../state-refresh-wiring.js'
import { harness } from './mirror-harness.js'

const POLICY: StateRefreshPolicy = {
  integrationId: 'acct-1',
  minIntervalMs: 15_000,
  batch: true,
  push: 'none',
}

const noopLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  withTags: () => noopLogger,
}

const OFFLINE = { online: false, lastChangedAt: 2_000 }
const ONLINE = { online: true, lastChangedAt: 1_000 }

function setup(options: { refreshFails?: boolean } = {}) {
  const h = harness()
  const policies = new StateRefreshPolicyRegistry()
  policies.set('in-process', { deviceId: 7, addonId: 'provider-x', policy: POLICY })
  const stop = startStateRefresh({
    mirror: h.mirror,
    logger: noopLogger,
    policies,
    refresh: async () => {
      if (options.refreshFails === true) throw new Error('integration unreachable')
    },
    resubscribe: async () => undefined,
  })
  // The previous session's reading, restored at boot.
  h.mirror.seedMirror(7, { 'device-status': ONLINE })
  return { h, stop }
}

describe('restart -> unknown -> ready -> online/offline (D1099)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('an offline before the first read is unknown, not offline, and is logged with the device', () => {
    const { h, stop } = setup()
    h.mirror.applySingleCapUpdate(7, 'device-status', OFFLINE)
    expect(h.mirror.capSlice(7, 'device-status')).toMatchObject({ online: true, unknown: true })
    const line = h.logs.find((l) => l.message.includes('has not answered yet'))
    expect(line?.extras).toMatchObject({ tags: { deviceId: 7 } })
    stop()
  })

  it('after the first read settles, the held offline is applied (still unanswered = offline)', async () => {
    const { h, stop } = setup()
    h.mirror.applySingleCapUpdate(7, 'device-status', OFFLINE)
    await vi.advanceTimersByTimeAsync(15_001)
    const slice = h.mirror.capSlice(7, 'device-status')
    expect(slice).toMatchObject({ online: false })
    expect(slice).not.toHaveProperty('unknown')
    stop()
  })

  it('a failed first read is an answer too: the device goes offline', async () => {
    const { h, stop } = setup({ refreshFails: true })
    h.mirror.applySingleCapUpdate(7, 'device-status', OFFLINE)
    await vi.advanceTimersByTimeAsync(15_001)
    expect(h.mirror.capSlice(7, 'device-status')).toMatchObject({ online: false })
    stop()
  })

  it('an online before ready is an answer: the held offline is dropped', async () => {
    const { h, stop } = setup()
    h.mirror.applySingleCapUpdate(7, 'device-status', OFFLINE)
    h.mirror.applySingleCapUpdate(7, 'device-status', { online: true, lastChangedAt: 3_000 })
    await vi.advanceTimersByTimeAsync(15_001)
    expect(h.mirror.capSlice(7, 'device-status')).toMatchObject({ online: true })
    stop()
  })

  it('after ready an offline passes straight through', async () => {
    const { h, stop } = setup()
    await vi.advanceTimersByTimeAsync(15_001)
    h.mirror.applySingleCapUpdate(7, 'device-status', OFFLINE)
    expect(h.mirror.capSlice(7, 'device-status')).toMatchObject({ online: false })
    stop()
  })

  it('a device no scheduler governs is not gated', () => {
    const { h, stop } = setup()
    h.mirror.applySingleCapUpdate(99, 'device-status', OFFLINE)
    expect(h.mirror.capSlice(99, 'device-status')).toMatchObject({ online: false })
    stop()
  })
})

describe('a lost readiness push is reconciled (D8, D49)', () => {
  it('the next device-status write releases an offline whose readiness push never came', () => {
    const h = harness()
    const awaiting = new Set([7])
    h.mirror.seedMirror(7, { 'device-status': ONLINE })
    h.mirror.setReadinessGate((id) => awaiting.has(id))
    h.mirror.applySingleCapUpdate(7, 'device-status', OFFLINE)
    expect(h.mirror.capSlice(7, 'device-status')).toMatchObject({ unknown: true })

    awaiting.delete(7) // the scheduler settled; releaseDeferredOffline was never called
    h.mirror.applySingleCapUpdate(8, 'device-status', ONLINE)
    expect(h.mirror.capSlice(7, 'device-status')).toMatchObject({ online: false })
  })

  it('reconcileReadiness releases on its own', () => {
    const h = harness()
    const awaiting = new Set([7])
    h.mirror.seedMirror(7, { 'device-status': ONLINE })
    h.mirror.setReadinessGate((id) => awaiting.has(id))
    h.mirror.applySingleCapUpdate(7, 'device-status', OFFLINE)
    awaiting.delete(7)
    expect(h.mirror.reconcileReadiness()).toEqual([7])
    expect(h.mirror.capSlice(7, 'device-status')).toMatchObject({ online: false })
  })
})
