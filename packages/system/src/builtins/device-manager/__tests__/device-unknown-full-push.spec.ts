/**
 * D1099 follow-up (planning#690) — a FULL-PUSH integration (Home Assistant) is
 * gated too. Its devices are awaiting from registration until their first
 * state arrives (or the bound passes), because nothing ever READS them: the
 * 07:18Z restart announced ~45 offline -> online flips 40 s apart.
 */
import type { IScopedLogger, StateRefreshPolicy } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateRefreshPolicyRegistry } from '../../../kernel/state-refresh-policies.js'
import { FULL_PUSH_FIRST_REPORT_BOUND_MS, integrationGroupKey } from '../state-refresh-scheduler.js'
import { startStateRefresh } from '../state-refresh-wiring.js'
import { harness } from './mirror-harness.js'

const POLICY: StateRefreshPolicy = {
  integrationId: 'int_0019',
  minIntervalMs: 1_000,
  batch: false,
  push: 'full',
}
const KEY = integrationGroupKey('provider-ha', 'int_0019')
const CHILDREN = [11, 12, 13]
const CONTAINER = 20

const lines: { message: string; tags: unknown }[] = []
const logger: IScopedLogger = {
  debug: () => undefined,
  info: (message, extras) => void lines.push({ message, tags: extras?.tags }),
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

const ONLINE = { online: true, lastChangedAt: 1_000 }
const OFFLINE = { online: false, lastChangedAt: 2_000 }

function broker() {
  const h = harness()
  const policies = new StateRefreshPolicyRegistry()
  // Every HA child declares its own full-push policy under the integration id.
  for (const id of CHILDREN) {
    policies.set('in-process', { deviceId: id, addonId: 'provider-ha', policy: POLICY })
  }
  const stop = startStateRefresh({
    mirror: h.mirror,
    logger,
    policies,
    refresh: async () => undefined,
    resubscribe: async () => undefined,
  })
  for (const id of [...CHILDREN, CONTAINER]) {
    h.mirror.seedMirror(id, { 'device-status': ONLINE })
    h.mirror.noteIntegration(id, KEY)
  }
  return { h, stop, policies }
}

const offlineEmitted = (h: ReturnType<typeof harness>): number =>
  h.events.filter(
    (e) =>
      e.capName === 'device-status' && e.slice['online'] === false && e.slice['unknown'] !== true,
  ).length

describe('a full-push integration restart (07:18Z incident shape)', () => {
  beforeEach(() => {
    lines.length = 0
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('offline writes before the cache replay are held; the replay lands 40 s later: no offline reaches the consumers', async () => {
    const { h, stop } = broker()
    for (const id of CHILDREN) h.mirror.applySingleCapUpdate(id, 'device-status', OFFLINE)
    h.mirror.applySingleCapUpdate(CONTAINER, 'device-status', {
      online: false,
      unknown: true,
      lastChangedAt: 2_000,
    })
    await vi.advanceTimersByTimeAsync(40_000)
    for (const id of CHILDREN) {
      h.mirror.applySingleCapUpdate(id, 'device-status', { online: true, lastChangedAt: 42_000 })
      h.mirror.applySingleCapUpdate(id, 'switch', { state: 'on' })
    }
    h.mirror.applySingleCapUpdate(CONTAINER, 'device-status', {
      online: true,
      lastChangedAt: 42_000,
    })
    expect(offlineEmitted(h)).toBe(0)
    for (const id of CHILDREN) {
      expect(h.mirror.capSlice(id, 'device-status')).toMatchObject({ online: true })
    }
    expect(lines).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('first state'),
        tags: { deviceId: 11 },
      }),
    )
    stop()
  })

  it('a replay that finishes child by child never releases a sibling that is still to come', () => {
    const { h, stop } = broker()
    for (const id of CHILDREN) h.mirror.applySingleCapUpdate(id, 'device-status', OFFLINE)
    h.mirror.applySingleCapUpdate(11, 'device-status', { online: true, lastChangedAt: 3_000 })
    h.mirror.applySingleCapUpdate(11, 'switch', { state: 'on' })
    expect(offlineEmitted(h)).toBe(0)
    stop()
  })

  it('a dead integration is still reported: offline after the bound', async () => {
    const { h, stop } = broker()
    for (const id of CHILDREN) h.mirror.applySingleCapUpdate(id, 'device-status', OFFLINE)
    await vi.advanceTimersByTimeAsync(FULL_PUSH_FIRST_REPORT_BOUND_MS - 1)
    expect(offlineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(offlineEmitted(h)).toBe(CHILDREN.length)
    stop()
  })

  it('an unknown container slice is not an offline claim and is never held as one', () => {
    const { h, stop } = broker()
    h.mirror.applySingleCapUpdate(CONTAINER, 'device-status', {
      online: false,
      unknown: true,
      lastChangedAt: 2_000,
    })
    expect(h.mirror.capSlice(CONTAINER, 'device-status')).toMatchObject({ unknown: true })
    expect(lines.filter((l) => l.message.includes('offline not applied')).length).toBe(0)
    stop()
  })
  it('framework seed writes during activation (feature-probe, onProbe stamp, admin link) are not the first state', async () => {
    const { h, stop } = broker()
    // The real HA child order: its policy is registered in onActivate, then the
    // framework stamps the probe and the broker's replay arrives much later.
    for (const id of CHILDREN) {
      h.mirror.applySingleCapUpdate(id, 'device-status', OFFLINE)
      h.mirror.applySingleCapUpdate(id, 'feature-probe', {
        flags: {},
        deviceType: null,
        model: null,
        channelCount: null,
        lastProbedAt: 0,
        lastFetchedAt: 0,
      })
      h.mirror.applySingleCapUpdate(id, 'feature-probe', {
        flags: {},
        deviceType: null,
        model: null,
        channelCount: null,
        lastProbedAt: 5_000,
        lastFetchedAt: 0,
      })
      h.mirror.applySingleCapUpdate(id, 'device-admin-link', { url: null })
    }
    await vi.advanceTimersByTimeAsync(40_000)
    expect(offlineEmitted(h)).toBe(0)
    for (const id of CHILDREN) {
      h.mirror.applySingleCapUpdate(id, 'device-status', { online: true, lastChangedAt: 42_000 })
      h.mirror.applySingleCapUpdate(id, 'switch', { state: 'on' })
    }
    expect(offlineEmitted(h)).toBe(0)
    stop()
  })

  describe('a device hot-added to a settled integration gates only itself', () => {
    function settled() {
      const r = broker()
      for (const id of CHILDREN) {
        r.h.mirror.applySingleCapUpdate(id, 'device-status', ONLINE)
        r.h.mirror.applySingleCapUpdate(id, 'switch', { state: 'on' })
      }
      return r
    }

    it('a sibling that really goes offline is not held by the newcomer', () => {
      const { h, stop, policies } = settled()
      // The scheduler re-reconciles on a policy change: device 14 arrives.
      policies.set('in-process', { deviceId: 14, addonId: 'provider-ha', policy: POLICY })
      h.mirror.noteIntegration(14, KEY)
      h.mirror.applySingleCapUpdate(11, 'device-status', OFFLINE)
      expect(h.mirror.capSlice(11, 'device-status')).toMatchObject({ online: false })
      stop()
    })

    it('the newcomer itself is held until its own first state', () => {
      const { h, stop, policies } = settled()
      policies.set('in-process', { deviceId: 14, addonId: 'provider-ha', policy: POLICY })
      h.mirror.noteIntegration(14, KEY)
      h.mirror.seedMirror(14, { 'device-status': ONLINE })
      h.mirror.applySingleCapUpdate(14, 'device-status', OFFLINE)
      expect(h.mirror.capSlice(14, 'device-status')).toMatchObject({ online: true, unknown: true })
      stop()
    })
  })
})
