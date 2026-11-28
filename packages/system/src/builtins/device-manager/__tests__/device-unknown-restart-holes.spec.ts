/**
 * planning#713 — three holes left by D1099 / planning#710:
 *  A. the scheduler group and the mirror key one integration differently;
 *  B. a runner stopped for a restart writes its teardown offline into a ready group;
 *  C. the construction seed counted as an answer.
 */
import type { IScopedLogger, StateRefreshPolicy } from '@dominevo/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  childRefreshSource,
  StateRefreshPolicyRegistry,
} from '../../../kernel/state-refresh-policies.js'
import { integrationGroupKey } from '../state-refresh-scheduler.js'
import { startStateRefresh } from '../state-refresh-wiring.js'
import { harness } from './mirror-harness.js'

interface Line {
  readonly message: string
  readonly tags: unknown
}
const warns: Line[] = []
const infos: Line[] = []
const logger: IScopedLogger = {
  debug: () => undefined,
  info: (message, extras) => void infos.push({ message, tags: extras?.tags }),
  warn: (message, extras) => void warns.push({ message, tags: extras?.tags }),
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

type Harness = ReturnType<typeof harness>

const policy = (integrationId: string): StateRefreshPolicy => ({
  integrationId,
  minIntervalMs: 10_000,
  batch: false,
  push: 'none',
})

const ONLINE = { online: true, lastChangedAt: 1_000 }
const OFFLINE = { online: false, lastChangedAt: 2_000 }
const PRESUMED = { online: true, lastChangedAt: 3_000, unknown: true }

const plainOfflineEmitted = (h: Harness): number =>
  h.events.filter(
    (e) =>
      e.capName === 'device-status' && e.slice['online'] === false && e.slice['unknown'] !== true,
  ).length
const plainOnlineEmitted = (h: Harness): number =>
  h.events.filter(
    (e) =>
      e.capName === 'device-status' && e.slice['online'] === true && e.slice['unknown'] !== true,
  ).length

beforeEach(() => {
  warns.length = 0
  infos.length = 0
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

describe('A — one key for the scheduler group and the mirror (planning#713)', () => {
  const AC = 554
  const SIBLING = 555
  const ROW_KEY = integrationGroupKey('provider-gree', 'int_0011')

  function rig() {
    const h = harness()
    const policies = new StateRefreshPolicyRegistry()
    // The provider names its integration by its connection, the row by `int_0011`.
    policies.set('in-process', {
      deviceId: AC,
      addonId: 'provider-gree',
      policy: policy('gree:580d0d32f25f'),
    })
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger,
      policies,
      refresh: async () => {
        throw new Error('unreachable')
      },
      resubscribe: async () => undefined,
    })
    h.mirror.seedMirror(AC, { 'device-status': ONLINE })
    h.mirror.seedMirror(SIBLING, { 'device-status': ONLINE })
    return { h, stop }
  }

  it('a sibling carrying no policy is held through the row key, whatever key the policy used', () => {
    const { h, stop } = rig()
    h.mirror.noteIntegration(AC, ROW_KEY)
    h.mirror.noteIntegration(SIBLING, ROW_KEY)
    h.mirror.applySingleCapUpdate(SIBLING, 'device-status', OFFLINE)
    expect(plainOfflineEmitted(h)).toBe(0)
    expect(h.mirror.capSlice(SIBLING, 'device-status')).toMatchObject({
      online: true,
      unknown: true,
    })
    stop()
  })

  it('warns, with the device, when a policy names the integration differently from the row', () => {
    const { h, stop } = rig()
    h.mirror.noteIntegration(AC, ROW_KEY)
    expect(warns).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('integration key differs'),
        tags: { deviceId: AC },
      }),
    )
    stop()
  })

  it('does not warn when the policy and the row agree', () => {
    const h = harness()
    const policies = new StateRefreshPolicyRegistry()
    policies.set('in-process', {
      deviceId: AC,
      addonId: 'provider-gree',
      policy: policy('int_0011'),
    })
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger,
      policies,
      refresh: async () => undefined,
      resubscribe: async () => undefined,
    })
    h.mirror.noteIntegration(AC, ROW_KEY)
    expect(warns).toHaveLength(0)
    stop()
  })
})

describe('B — a stopped runner leaves a tombstone, not a hole (planning#713)', () => {
  const GATEWAY = 7
  const CHILD = 8
  const SOURCE = childRefreshSource('runner-1')
  const KEY = integrationGroupKey('provider-homematic', 'int_0003')
  const entry = {
    deviceId: GATEWAY,
    addonId: 'provider-homematic',
    policy: policy('int_0003'),
  }

  function rig() {
    const h = harness()
    const state = { runnerAnswers: true }
    const policies = new StateRefreshPolicyRegistry()
    policies.replaceSource(SOURCE, [entry])
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger,
      policies,
      refresh: async (_route, ids) => {
        if (!state.runnerAnswers) throw new Error('the runner is gone')
        // The integration's read answers for its gateway and its children.
        for (const id of [...ids, CHILD]) h.mirror.applySingleCapUpdate(id, 'device-status', ONLINE)
      },
      resubscribe: async () => undefined,
    })
    h.mirror.seedMirror(GATEWAY, { 'device-status': ONLINE })
    h.mirror.seedMirror(CHILD, { 'device-status': ONLINE })
    h.mirror.noteIntegration(GATEWAY, KEY)
    h.mirror.noteIntegration(CHILD, KEY)
    return { h, stop, policies, state }
  }

  /** What the hub does around a runner stop: re-gate, then the disconnect empties the source. */
  function stopRunner(policies: StateRefreshPolicyRegistry): void {
    policies.regateSource(SOURCE)
    policies.replaceSource(SOURCE, [])
  }

  it('without the re-gate the teardown offline of a settled integration is applied (the old behaviour)', async () => {
    const { h, stop, policies } = rig()
    await vi.advanceTimersByTimeAsync(10_001)
    policies.replaceSource(SOURCE, [])
    h.mirror.applySingleCapUpdate(GATEWAY, 'device-status', OFFLINE)
    expect(plainOfflineEmitted(h)).toBe(1)
    stop()
  })

  it('a teardown offline written AFTER the source was emptied is held, for the gateway and for a sibling; the new runner answers and no offline reaches a consumer', async () => {
    const { h, stop, policies } = rig()
    await vi.advanceTimersByTimeAsync(10_001)
    stopRunner(policies)
    h.mirror.applySingleCapUpdate(GATEWAY, 'device-status', OFFLINE)
    h.mirror.applySingleCapUpdate(CHILD, 'device-status', OFFLINE)
    expect(plainOfflineEmitted(h)).toBe(0)
    expect(h.mirror.capSlice(CHILD, 'device-status')).toMatchObject({
      online: true,
      unknown: true,
    })
    expect(infos).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('the stopped runner left'),
        tags: { deviceId: GATEWAY },
      }),
    )
    // The new runner registers (normal boot gating) and answers.
    policies.replaceSource(SOURCE, [entry])
    await vi.advanceTimersByTimeAsync(10_001)
    await vi.advanceTimersByTimeAsync(130_000)
    expect(plainOfflineEmitted(h)).toBe(0)
    expect(h.mirror.capSlice(GATEWAY, 'device-status')).toMatchObject({ online: true })
    expect(h.mirror.capSlice(CHILD, 'device-status')).toMatchObject({ online: true })
    stop()
  })

  it("a stopping runner's late reports and reads settle nothing", async () => {
    const { h, stop, policies } = rig()
    await vi.advanceTimersByTimeAsync(10_001)
    policies.regateSource(SOURCE)
    h.mirror.applySingleCapUpdate(GATEWAY, 'device-status', OFFLINE)
    h.mirror.applySingleCapUpdate(GATEWAY, 'thermostat', { mode: 'cool' })
    await vi.advanceTimersByTimeAsync(10_001)
    expect(plainOfflineEmitted(h)).toBe(0)
    stop()
  })

  it('the new runner registers BEFORE the old connection closes: its answers count, a real offline is applied', async () => {
    const { h, stop, policies } = rig()
    await vi.advanceTimersByTimeAsync(10_001)
    policies.regateSource(SOURCE)
    // A new entry for the same device, with no empty source in between.
    policies.replaceSource(SOURCE, [{ ...entry, policy: policy('int_0003') }])
    h.mirror.applySingleCapUpdate(GATEWAY, 'thermostat', { mode: 'cool' })
    h.mirror.applySingleCapUpdate(GATEWAY, 'device-status', OFFLINE)
    expect(plainOfflineEmitted(h)).toBe(1)
    stop()
  })

  it('a second stop of the same integration re-arms a full bound', async () => {
    const h = harness()
    const SECOND = childRefreshSource('runner-2')
    const second = { deviceId: 9, addonId: 'provider-homematic', policy: policy('int_0003') }
    const policies = new StateRefreshPolicyRegistry()
    policies.replaceSource(SOURCE, [entry])
    policies.replaceSource(SECOND, [second])
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger,
      policies,
      refresh: async () => undefined,
      resubscribe: async () => undefined,
    })
    h.mirror.seedMirror(GATEWAY, { 'device-status': ONLINE })
    h.mirror.seedMirror(9, { 'device-status': ONLINE })
    h.mirror.noteIntegration(GATEWAY, KEY)
    h.mirror.noteIntegration(9, KEY)
    await vi.advanceTimersByTimeAsync(10_001)
    policies.regateSource(SOURCE)
    policies.replaceSource(SOURCE, [])
    await vi.advanceTimersByTimeAsync(100_000)
    policies.regateSource(SECOND)
    policies.replaceSource(SECOND, [])
    h.mirror.applySingleCapUpdate(9, 'device-status', OFFLINE)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(plainOfflineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(100_000)
    expect(plainOfflineEmitted(h)).toBe(1)
    stop()
  })

  it('a runner that never comes back: the held offline is released through the normal path at the bound', async () => {
    const { h, stop, policies, state } = rig()
    await vi.advanceTimersByTimeAsync(10_001)
    state.runnerAnswers = false
    stopRunner(policies)
    h.mirror.applySingleCapUpdate(CHILD, 'device-status', OFFLINE)
    expect(plainOfflineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(plainOfflineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(plainOfflineEmitted(h)).toBe(1)
    expect(infos).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining('did not come back within the bound'),
        tags: { deviceId: GATEWAY },
      }),
    )
    stop()
  })
})

describe('A — a batch integration is never split across two groups (planning#713)', () => {
  it('two devices of one policy key read once per tick after the row key arrives', async () => {
    const h = harness()
    const policies = new StateRefreshPolicyRegistry()
    for (const deviceId of [21, 22]) {
      policies.set('in-process', {
        deviceId,
        addonId: 'provider-batch',
        policy: { integrationId: 'acct', minIntervalMs: 10_000, batch: true, push: 'none' },
      })
    }
    const reads: (readonly number[])[] = []
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger,
      policies,
      refresh: async (_route, ids) => {
        reads.push([...ids])
      },
      resubscribe: async () => undefined,
    })
    const rowKey = integrationGroupKey('provider-batch', 'int_0042')
    h.mirror.noteIntegration(21, rowKey)
    h.mirror.noteIntegration(22, rowKey)
    await vi.advanceTimersByTimeAsync(10_001)
    expect(reads).toEqual([[21, 22]])
    stop()
  })
})

describe('forgetting a device clears the readiness gate (planning#713)', () => {
  it('a removed device is never written by reconcileReadiness or releasePresumed', async () => {
    const h = harness()
    const policies = new StateRefreshPolicyRegistry()
    policies.set('in-process', {
      deviceId: 1,
      addonId: 'provider-ha',
      policy: policy('int_0019'),
    })
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger,
      policies,
      refresh: async () => undefined,
      resubscribe: async () => undefined,
    })
    const DEVICE = 31
    h.mirror.noteIntegration(DEVICE, integrationGroupKey('provider-ha', 'int_0019'))
    h.mirror.applySingleCapUpdate(DEVICE, 'device-status', PRESUMED)
    h.mirror.applySingleCapUpdate(32, 'device-status', PRESUMED)
    h.mirror.noteIntegration(32, integrationGroupKey('provider-ha', 'int_0019'))
    h.mirror.applySingleCapUpdate(32, 'device-status', OFFLINE)
    await h.mirror.forgetDevice(DEVICE)
    await h.mirror.forgetDevice(32)
    const before = h.events.length
    await vi.advanceTimersByTimeAsync(10_001)
    await vi.advanceTimersByTimeAsync(130_000)
    h.mirror.reconcileReadiness()
    expect(h.mirror.hasIntegrationNote(DEVICE)).toBe(false)
    // The harness drops deviceId; 31 and 32 are the only devices with a slice here.
    expect(h.events.slice(before).filter((e) => e.capName === 'device-status')).toEqual([])
    expect(h.mirror.capSlice(DEVICE, 'device-status')).toBeNull()
    stop()
  })
})

describe('C — the construction seed is a presumption, never an answer (planning#713)', () => {
  const DEVICE = 9
  const KEY = integrationGroupKey('provider-ha', 'int_0019')

  function rig(options: { gated: boolean }) {
    const h = harness()
    const policies = new StateRefreshPolicyRegistry()
    if (options.gated) {
      // The integration's policy sits on its gateway (device 1); this device is a child.
      policies.set('in-process', {
        deviceId: 1,
        addonId: 'provider-ha',
        policy: policy('int_0019'),
      })
    }
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger,
      policies,
      refresh: async () => undefined,
      resubscribe: async () => undefined,
    })
    // The previous session persisted this device OFFLINE.
    h.mirror.seedMirror(DEVICE, { 'device-status': OFFLINE })
    if (options.gated) h.mirror.noteIntegration(DEVICE, KEY)
    return { h, stop }
  }

  it('the seed keeps the persisted offline (marked unknown); the driver offline then lands once the integration answers, with no online flip in between', async () => {
    const { h, stop } = rig({ gated: true })
    h.mirror.applySingleCapUpdate(DEVICE, 'device-status', PRESUMED)
    expect(h.mirror.capSlice(DEVICE, 'device-status')).toMatchObject({
      online: false,
      unknown: true,
    })
    h.mirror.applySingleCapUpdate(DEVICE, 'device-status', {
      online: false,
      lastChangedAt: 4_000,
    })
    await vi.advanceTimersByTimeAsync(130_000)
    expect(plainOnlineEmitted(h)).toBe(0)
    expect(h.mirror.capSlice(DEVICE, 'device-status')).toMatchObject({
      online: false,
    })
    expect(h.mirror.capSlice(DEVICE, 'device-status')?.['unknown']).toBeUndefined()
    stop()
  })

  it('a driver that never calls markOnline ends plain online once the integration is ready', async () => {
    const { h, stop } = rig({ gated: true })
    h.mirror.applySingleCapUpdate(DEVICE, 'device-status', PRESUMED)
    expect(plainOnlineEmitted(h)).toBe(0)
    await vi.advanceTimersByTimeAsync(10_001)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.mirror.capSlice(DEVICE, 'device-status')).toMatchObject({
      online: true,
    })
    expect(h.mirror.capSlice(DEVICE, 'device-status')?.['unknown']).toBeUndefined()
    stop()
  })

  it("a device with no integration keeps today's behaviour: the seed is a plain online", () => {
    const { h, stop } = rig({ gated: false })
    h.mirror.applySingleCapUpdate(DEVICE, 'device-status', PRESUMED)
    expect(h.mirror.capSlice(DEVICE, 'device-status')).toMatchObject({
      online: true,
    })
    expect(h.mirror.capSlice(DEVICE, 'device-status')?.['unknown']).toBeUndefined()
    stop()
  })
})
