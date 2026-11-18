/**
 * D1062 — the core decides WHEN a device is re-read. The spec's "Done when"
 * list, one case each: the command awaits its refresh, the burst stops on
 * confirmation, the cadence is the declared minimum (slowed only by the
 * setting), a full-push integration is never scheduled, no refresh overlaps,
 * a push that confirms in the window spares the read, a missing push costs one
 * read, silence past the heartbeat re-reads and resubscribes, and a reconnect
 * re-reads everything.
 */
import type {
  IScopedLogger,
  LogExtras,
  StateRefreshPolicy,
  StateRefreshReason,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  StateRefreshPolicyRegistry,
  type StateRefreshPolicyEntry,
} from '../../../kernel/state-refresh-policies.js'
import { StateRefreshScheduler } from '../state-refresh-scheduler.js'
import { startStateRefresh } from '../state-refresh-wiring.js'
import {
  __resetCommandFollowUpRegistryForTests,
  getCommandFollowUpRegistry,
} from '../../../kernel/command-follow-up.js'
import { harness } from './mirror-harness.js'

interface Call {
  readonly kind: 'refresh' | 'resubscribe'
  readonly deviceIds: readonly number[]
  readonly reason?: StateRefreshReason
  readonly at: number
}

interface LogLine {
  readonly level: string
  readonly message: string
  readonly extras: LogExtras | undefined
}

interface Rig {
  readonly scheduler: StateRefreshScheduler
  readonly policies: StateRefreshPolicyRegistry
  readonly calls: Call[]
  readonly logs: LogLine[]
  /** Devices whose command hold is still pending. */
  readonly holding: Set<number>
  /** How long each refresh takes. */
  refreshMs: number
  /** When set, a refresh reports this device's state as it lands. */
  readonly reportOnRefresh: boolean
}

function logger(logs: LogLine[]): IScopedLogger {
  const line =
    (level: string) =>
    (message: string, extras?: LogExtras): void =>
      void logs.push({ level, message, extras })
  const l: IScopedLogger = {
    debug: line('debug'),
    info: line('info'),
    warn: line('warn'),
    error: line('error'),
    child: () => l,
    withTags: () => l,
  }
  return l
}

const BASE: StateRefreshPolicy = {
  integrationId: 'acct-1',
  minIntervalMs: 15_000,
  batch: true,
  push: 'none',
}

function rig(options: { reportOnRefresh?: boolean } = {}): Rig {
  const policies = new StateRefreshPolicyRegistry()
  const calls: Call[] = []
  const logs: LogLine[] = []
  const holding = new Set<number>()
  const state = { refreshMs: 0 }
  // eslint-disable-next-line prefer-const -- assigned below, read by the closures
  let scheduler: StateRefreshScheduler
  scheduler = new StateRefreshScheduler({
    policies,
    logger: logger(logs),
    holdsPending: (deviceId) => holding.has(deviceId),
    refresh: async (_route, deviceIds, reason) => {
      calls.push({ kind: 'refresh', deviceIds, reason, at: Date.now() })
      if (state.refreshMs > 0) await new Promise((resolve) => setTimeout(resolve, state.refreshMs))
      if (options.reportOnRefresh === true) for (const id of deviceIds) scheduler.onReport(id)
    },
    resubscribe: async (route) => {
      calls.push({ kind: 'resubscribe', deviceIds: [route], at: Date.now() })
    },
  })
  return {
    scheduler,
    policies,
    calls,
    logs,
    holding,
    get refreshMs() {
      return state.refreshMs
    },
    set refreshMs(ms: number) {
      state.refreshMs = ms
    },
    reportOnRefresh: options.reportOnRefresh === true,
  }
}

function declare(r: Rig, deviceId: number, policy: Partial<StateRefreshPolicy> = {}): void {
  const entry: StateRefreshPolicyEntry = {
    deviceId,
    addonId: 'provider-vesync',
    policy: { ...BASE, ...policy },
  }
  r.policies.set('in-process', entry)
}

const refreshes = (r: Rig, reason?: StateRefreshReason): Call[] =>
  r.calls.filter((c) => c.kind === 'refresh' && (reason === undefined || c.reason === reason))

describe('StateRefreshScheduler (D1062)', () => {
  let r: Rig
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    r.scheduler.dispose()
    vi.useRealTimers()
  })

  describe('the command path', () => {
    it('awaits the refresh inside the command', async () => {
      r = rig()
      r.refreshMs = 400
      declare(r, 7)
      let returned = false
      const done = r.scheduler
        .onCommand({ deviceId: 7, capName: 'switch', method: 'setState' }, 'ok')
        .then(() => {
          returned = true
        })
      await vi.advanceTimersByTimeAsync(399)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await done
      expect(returned).toBe(true)
      expect(refreshes(r, 'command')).toEqual([
        expect.objectContaining({ deviceIds: [7], reason: 'command', at: 0 }),
      ])
    })

    it('a refresh that fails is logged with the device and does not fail the command', async () => {
      r = rig()
      declare(r, 7)
      r.scheduler.dispose()
      const logs: LogLine[] = []
      const failing = new StateRefreshScheduler({
        policies: r.policies,
        logger: logger(logs),
        holdsPending: () => false,
        refresh: async () => {
          throw new Error('cloud said 503')
        },
        resubscribe: async () => undefined,
      })
      await expect(
        failing.onCommand({ deviceId: 7, capName: 'switch', method: 'setState' }, 'ok'),
      ).resolves.toBeUndefined()
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          extras: expect.objectContaining({ tags: { deviceId: 7 } }),
        }),
      )
      failing.dispose()
    })

    it('bursts at ~3 s and ~10 s while the hold is pending', async () => {
      r = rig()
      declare(r, 7)
      r.holding.add(7)
      await r.scheduler.onCommand({ deviceId: 7, capName: 'switch', method: 'setState' }, 'ok')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(refreshes(r, 'burst').map((c) => c.at)).toEqual([3_000, 10_000])
    })

    it('stops the burst once the holds are confirmed', async () => {
      r = rig()
      declare(r, 7)
      r.holding.add(7)
      await r.scheduler.onCommand({ deviceId: 7, capName: 'switch', method: 'setState' }, 'ok')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(refreshes(r, 'burst')).toHaveLength(1)
      r.holding.delete(7)
      await vi.advanceTimersByTimeAsync(7_000)
      expect(refreshes(r, 'burst')).toHaveLength(1)
    })

    it('does nothing for a device whose provider did not migrate', async () => {
      r = rig()
      await r.scheduler.onCommand({ deviceId: 99, capName: 'switch', method: 'setState' }, 'ok')
      await vi.advanceTimersByTimeAsync(20_000)
      expect(r.calls).toEqual([])
    })
  })

  describe('the schedule', () => {
    it('runs at the declared minimum interval, batched per integration', async () => {
      r = rig()
      declare(r, 7)
      declare(r, 8)
      await vi.advanceTimersByTimeAsync(45_000)
      const scheduled = refreshes(r, 'schedule')
      expect(scheduled.map((c) => c.at)).toEqual([15_000, 30_000, 45_000])
      expect(scheduled[0]?.deviceIds).toEqual([7, 8])
    })

    it('a setting can slow the cadence', async () => {
      r = rig()
      declare(r, 7, { intervalMs: 40_000 })
      await vi.advanceTimersByTimeAsync(80_000)
      expect(refreshes(r, 'schedule').map((c) => c.at)).toEqual([40_000, 80_000])
    })

    it('a setting can never speed it up', async () => {
      r = rig()
      declare(r, 7, { intervalMs: 5_000 })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(refreshes(r, 'schedule').map((c) => c.at)).toEqual([15_000, 30_000])
    })

    it('never schedules a full-push integration', async () => {
      r = rig()
      declare(r, 7, { push: 'full' })
      r.scheduler.onReport(7)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(refreshes(r, 'schedule')).toEqual([])
    })

    it('never overlaps: a tick while the device is refreshing is skipped and logged at debug', async () => {
      r = rig()
      r.refreshMs = 20_000
      declare(r, 7, { batch: false })
      await vi.advanceTimersByTimeAsync(15_000)
      expect(refreshes(r)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(refreshes(r)).toHaveLength(1)
      expect(r.logs).toContainEqual(
        expect.objectContaining({
          level: 'debug',
          extras: expect.objectContaining({ tags: { deviceId: 7 } }),
        }),
      )
    })

    it('a command waits for the refresh in flight instead of overlapping it', async () => {
      r = rig()
      r.refreshMs = 1_000
      declare(r, 7)
      await vi.advanceTimersByTimeAsync(15_000)
      const command = r.scheduler.onCommand(
        { deviceId: 7, capName: 'switch', method: 'setState' },
        'ok',
      )
      await vi.advanceTimersByTimeAsync(2_000)
      await command
      expect(refreshes(r).map((c) => [c.reason, c.at])).toEqual([
        ['schedule', 15_000],
        ['command', 16_000],
      ])
    })
  })

  describe('push integrations', () => {
    it('a push that confirms within the window spares the read', async () => {
      r = rig()
      declare(r, 7, { push: 'partial' })
      await r.scheduler.onCommand({ deviceId: 7, capName: 'switch', method: 'setState' }, 'ok')
      await vi.advanceTimersByTimeAsync(1_000)
      r.scheduler.onReport(7)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(refreshes(r, 'command')).toEqual([])
    })

    it('no push in the window costs exactly one read', async () => {
      r = rig()
      declare(r, 7, { push: 'full' })
      await r.scheduler.onCommand({ deviceId: 7, capName: 'switch', method: 'setState' }, 'ok')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(refreshes(r, 'command').map((c) => c.at)).toEqual([2_500])
    })

    it('silence past the heartbeat re-reads and asks for a resubscribe', async () => {
      r = rig()
      declare(r, 7, { push: 'full', heartbeatMs: 60_000 })
      r.scheduler.onReport(7)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(r.calls).toEqual([])
      await vi.advanceTimersByTimeAsync(1_000)
      expect(r.calls.map((c) => c.kind)).toEqual(['refresh', 'resubscribe', 'refresh'])
      expect(r.logs).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          extras: expect.objectContaining({ tags: { deviceId: 7 } }),
        }),
      )
    })

    it('a report inside the heartbeat keeps the subscription', async () => {
      r = rig()
      declare(r, 7, { push: 'full', heartbeatMs: 60_000 })
      r.scheduler.onReport(7)
      await vi.advanceTimersByTimeAsync(50_000)
      r.scheduler.onReport(7)
      await vi.advanceTimersByTimeAsync(50_000)
      expect(r.calls).toEqual([])
    })

    it('a reconnect re-reads every device of the integration', async () => {
      r = rig()
      declare(r, 7, { push: 'full', connectionEpoch: 1 })
      declare(r, 8, { push: 'full', connectionEpoch: 1 })
      await vi.advanceTimersByTimeAsync(1)
      r.calls.length = 0
      declare(r, 7, { push: 'full', connectionEpoch: 2 })
      await vi.advanceTimersByTimeAsync(1)
      expect(refreshes(r, 'schedule')).toEqual([expect.objectContaining({ deviceIds: [7, 8] })])
    })
  })
})

describe('startStateRefresh wiring (D1062)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    __resetCommandFollowUpRegistryForTests()
  })
  afterEach(() => {
    __resetCommandFollowUpRegistryForTests()
    vi.useRealTimers()
  })

  it('installs the command follow-up and hears the mirror reports', async () => {
    const h = harness()
    const policies = new StateRefreshPolicyRegistry()
    policies.set('in-process', {
      deviceId: 7,
      addonId: 'provider-vesync',
      policy: { ...BASE, push: 'partial' },
    })
    const calls: string[] = []
    const stop = startStateRefresh({
      mirror: h.mirror,
      logger: logger([]),
      policies,
      refresh: async (_route, ids, reason) => void calls.push(`${reason}:${ids.join(',')}`),
      resubscribe: async () => undefined,
    })
    await getCommandFollowUpRegistry().run(
      { deviceId: 7, capName: 'switch', method: 'setState' },
      'ok',
    )
    await vi.advanceTimersByTimeAsync(500)
    h.mirror.applySingleCapUpdate(7, 'switch', { on: true })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls).toEqual([])
    await getCommandFollowUpRegistry().run(
      { deviceId: 7, capName: 'switch', method: 'setState' },
      'ok',
    )
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls).toEqual(['command:7'])
    stop()
    await getCommandFollowUpRegistry().run(
      { deviceId: 7, capName: 'switch', method: 'setState' },
      'ok',
    )
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls).toEqual(['command:7'])
  })
})
