import { describe, expect, it, vi, afterEach } from 'vitest'
import type { IScopedLogger } from '@dominevo/types'
import {
  MatterSubscriptionSupervisor,
  SUBSCRIPTION_BACKOFF_INITIAL_MS,
  SUBSCRIPTION_BACKOFF_MAX_MS,
  SUBSCRIBE_ATTEMPT_TIMEOUT_MS,
  collectAttributeReports,
  type MatterSubscribablePeer,
  type MatterSubscriptionHandlers,
} from '../matter-subscription.js'
import { planDoorLockCommand } from '../matter-lock-command.js'
import { classifyCommissionError, CommissionFailureCode } from '../matter-commission-progress.js'

function silentLogger(lines: string[]): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: (message, extras) => {
      const deviceId = extras?.tags?.deviceId
      lines.push(`${message}:${String(deviceId ?? '')}:${String(extras?.meta?.['phase'] ?? '')}`)
    },
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function peer(input: {
  nodeId: string
  online?: boolean
  onSubscribe?: (handlers: MatterSubscriptionHandlers) => void
}): {
  peer: MatterSubscribablePeer
  goOnline: () => void
  goOffline: () => void
  subscribeCount: () => number
} {
  let online = input.online ?? true
  let subscribeCount = 0
  const onlineHandlers: Array<() => void> = []
  const offlineHandlers: Array<() => void> = []
  const view: MatterSubscribablePeer = {
    nodeId: input.nodeId,
    online: () => online,
    subscribe: async (handlers) => {
      subscribeCount += 1
      input.onSubscribe?.(handlers)
      return { close: async () => undefined }
    },
    onOnline: (handler) => {
      onlineHandlers.push(handler)
      return () => undefined
    },
    onOffline: (handler) => {
      offlineHandlers.push(handler)
      return () => undefined
    },
  }
  return {
    peer: view,
    goOnline: () => {
      online = true
      for (const handler of onlineHandlers) handler()
    },
    goOffline: () => {
      online = false
      for (const handler of offlineHandlers) handler()
    },
    subscribeCount: () => subscribeCount,
  }
}

describe('collectAttributeReports', () => {
  it('delivers an attribute value and drops a missing one', async () => {
    const reports = await collectAttributeReports('7', [
      [
        {
          kind: 'attr-value',
          path: { endpointId: 1, clusterId: 0x0101, attributeId: 0 },
          value: 1,
          version: 1,
        },
        {
          kind: 'attr-value',
          path: { endpointId: 1, clusterId: 0x0101, attributeId: 0 },
          value: null,
          version: 2,
        },
        {
          kind: 'attr-status',
          path: { endpointId: 1, clusterId: 1, attributeId: 0 },
          status: 1,
        },
      ],
    ])
    expect(reports).toEqual([
      {
        nodeId: '7',
        endpointId: 1,
        clusterId: 0x0101,
        attributeId: 0,
        value: 1,
      },
    ])
  })
})

describe('MatterSubscriptionSupervisor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('forwards a subscription report into state and logs the transition with deviceId', async () => {
    const lines: string[] = []
    const seen: unknown[] = []
    const supervisor = new MatterSubscriptionSupervisor({
      brokerId: 'matter_001',
      logger: silentLogger(lines),
      resolveDeviceId: () => 42,
      onReport: (report) => seen.push(report.value),
    })
    const node = peer({
      nodeId: 'n1',
      onSubscribe: (handlers) => {
        handlers.onReport({
          nodeId: 'n1',
          endpointId: 1,
          clusterId: 0x0101,
          attributeId: 0,
          value: 2,
        })
      },
    })
    await supervisor.sync([node.peer])
    expect(seen).toEqual([2])
    expect(lines.some((line) => line.includes(':42:subscribed'))).toBe(true)
    await supervisor.stop()
  })

  it('does not treat a missing report as a value', async () => {
    const seen: unknown[] = []
    const supervisor = new MatterSubscriptionSupervisor({
      brokerId: 'matter_001',
      logger: silentLogger([]),
      resolveDeviceId: () => 42,
      onReport: (report) => seen.push(report.value),
    })
    const node = peer({
      nodeId: 'n1',
      onSubscribe: (handlers) => {
        handlers.onReport({
          nodeId: 'n1',
          endpointId: 1,
          clusterId: 0x0101,
          attributeId: 0,
          value: null,
        })
      },
    })
    await supervisor.sync([node.peer])
    expect(seen).toEqual([])
    await supervisor.stop()
  })

  it('keeps its one sustained subscription when the node comes back online', async () => {
    const supervisor = new MatterSubscriptionSupervisor({
      brokerId: 'matter_001',
      logger: silentLogger([]),
      resolveDeviceId: () => 9,
      onReport: () => undefined,
    })
    const node = peer({ nodeId: 'n1', online: true })
    await supervisor.sync([node.peer])
    node.goOffline()
    expect(node.subscribeCount()).toBe(1)
    node.goOnline()
    await vi.waitFor(() => expect(supervisor.phase('n1')).toBe('subscribed'))
    expect(node.subscribeCount()).toBe(1)
    await supervisor.stop()
  })
})

describe('planDoorLockCommand', () => {
  it('omits the PIN unless one was passed, and refuses when the device requires one', () => {
    expect(planDoorLockCommand({ pinRequired: false, code: undefined })).toEqual({
      ok: true,
      args: {},
    })
    expect(planDoorLockCommand({ pinRequired: false, code: '1234' })).toEqual({
      ok: true,
      args: { pinCode: '1234' },
    })
    expect(planDoorLockCommand({ pinRequired: true, code: undefined })).toEqual({
      ok: false,
      reason: 'pin-required',
    })
    expect(planDoorLockCommand({ pinRequired: true, code: '1234' }).ok).toBe(true)
  })

  it('an unread requirement (null, D393) is attempted: the lock itself refuses a missing PIN', () => {
    expect(planDoorLockCommand({ pinRequired: null, code: undefined })).toEqual({
      ok: true,
      args: {},
    })
    expect(planDoorLockCommand({ pinRequired: null, code: '1234' })).toEqual({
      ok: true,
      args: { pinCode: '1234' },
    })
  })
})

describe('classifyCommissionError', () => {
  it('names expired, missing and rejected codes', () => {
    expect(classifyCommissionError('commissioning window expired')).toBe(
      CommissionFailureCode.CodeExpired,
    )
    expect(classifyCommissionError('Discovery timed out, no device found')).toBe(
      CommissionFailureCode.DeviceNotFound,
    )
    expect(classifyCommissionError('PASE failed: invalid passcode')).toBe(
      CommissionFailureCode.WrongCode,
    )
    expect(classifyCommissionError('matter-broker: invalid pairing code — empty code')).toBe(
      CommissionFailureCode.InvalidCode,
    )
  })

  describe('offline re-establishment', () => {
    function setup(deviceId: number | null = 7): {
      supervisor: MatterSubscriptionSupervisor
      lines: string[]
    } {
      const lines: string[] = []
      const supervisor = new MatterSubscriptionSupervisor({
        brokerId: 'matter_001',
        logger: silentLogger(lines),
        resolveDeviceId: () => deviceId,
        onReport: () => undefined,
      })
      return { supervisor, lines }
    }

    it('retries an offline node at 15 s, 30 s, then capped at 60 s, and stops when online', async () => {
      vi.useFakeTimers()
      const { supervisor, lines } = setup()
      const node = peer({ nodeId: 'n1' })
      await supervisor.sync([node.peer])
      expect(node.subscribeCount()).toBe(1)
      node.goOffline()
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS - 1)
      expect(node.subscribeCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(node.subscribeCount()).toBe(2)
      await vi.advanceTimersByTimeAsync(2 * SUBSCRIPTION_BACKOFF_INITIAL_MS)
      expect(node.subscribeCount()).toBe(3)
      // Capped: 60 s apart, never longer, however many attempts have passed.
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_MAX_MS)
      expect(node.subscribeCount()).toBe(4)
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_MAX_MS)
      expect(node.subscribeCount()).toBe(5)
      // Info carries the first attempt only; repeats are debug.
      expect(lines.filter((l) => l.includes(':7:resubscribing')).length).toBe(1)
      node.goOnline()
      await vi.waitFor(() => expect(supervisor.phase('n1')).toBe('subscribed'))
      const settled = node.subscribeCount()
      await vi.advanceTimersByTimeAsync(10 * SUBSCRIPTION_BACKOFF_MAX_MS)
      expect(node.subscribeCount()).toBe(settled)
      await supervisor.stop()
    })

    it('stop cancels the pending retry', async () => {
      vi.useFakeTimers()
      const { supervisor } = setup()
      const node = peer({ nodeId: 'n1' })
      await supervisor.sync([node.peer])
      node.goOffline()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await supervisor.stop()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(10 * SUBSCRIPTION_BACKOFF_MAX_MS)
      expect(node.subscribeCount()).toBe(1)
    })

    it('never runs two attempts for one node at once', async () => {
      vi.useFakeTimers()
      const { supervisor } = setup()
      let inFlight = 0
      let maxInFlight = 0
      const gate: { release: (() => void) | null } = { release: null }
      const node = peer({ nodeId: 'n1' })
      const slowPeer: MatterSubscribablePeer = {
        ...node.peer,
        subscribe: async (handlers) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          if (gate.release === null) {
            await new Promise<void>((resolve) => {
              gate.release = resolve
            })
          }
          const sub = await node.peer.subscribe(handlers)
          inFlight -= 1
          return sub
        },
      }
      const first = supervisor.sync([slowPeer])
      await vi.advanceTimersByTimeAsync(0)
      // While the first attempt hangs, a reconcile tick and an online event arrive.
      void supervisor.sync([slowPeer])
      node.goOffline()
      node.goOnline()
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_MAX_MS)
      expect(maxInFlight).toBe(1)
      gate.release?.()
      await first
      await supervisor.stop()
    })

    it('a subscribe that never settles fails the attempt, closes the late result and retries', async () => {
      vi.useFakeTimers()
      const { supervisor } = setup()
      const closes: string[] = []
      let calls = 0
      let resolveFirst: ((sub: { close: () => Promise<void> }) => void) | null = null
      const node = peer({ nodeId: 'n1' })
      const hanging: MatterSubscribablePeer = {
        ...node.peer,
        subscribe: (handlers) => {
          calls += 1
          if (calls === 1) {
            return new Promise((resolve) => {
              resolveFirst = resolve
            })
          }
          return node.peer.subscribe(handlers)
        },
      }
      void supervisor.sync([hanging])
      await vi.advanceTimersByTimeAsync(SUBSCRIBE_ATTEMPT_TIMEOUT_MS)
      expect(supervisor.phase('n1')).not.toBe('resubscribing')
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS)
      expect(calls).toBe(2)
      expect(supervisor.phase('n1')).toBe('subscribed')
      const late = resolveFirst as ((sub: { close: () => Promise<void> }) => void) | null
      late?.({
        close: async () => {
          closes.push('late')
        },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(closes).toEqual(['late'])
      await supervisor.stop()
    })

    it('reconcile sync arms a retry for an offline slot that has none', async () => {
      vi.useFakeTimers()
      const { supervisor } = setup()
      const node = peer({ nodeId: 'n1' })
      await supervisor.sync([node.peer])
      node.goOffline()
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS)
      expect(node.subscribeCount()).toBe(2)
      await supervisor.sync([node.peer])
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_MAX_MS)
      expect(node.subscribeCount()).toBeGreaterThanOrEqual(3)
      await supervisor.stop()
    })
  })
})
