import { describe, expect, it, vi, afterEach } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  MatterSubscriptionSupervisor,
  SUBSCRIPTION_BACKOFF_INITIAL_MS,
  SUBSCRIPTION_BACKOFF_MAX_MS,
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
  emitClosed: () => void
  goOnline: () => void
  goOffline: () => void
  subscribeCount: () => number
} {
  let online = input.online ?? true
  let subscribeCount = 0
  let closed: (() => void) | null = null
  const onlineHandlers: Array<() => void> = []
  const offlineHandlers: Array<() => void> = []
  const view: MatterSubscribablePeer = {
    nodeId: input.nodeId,
    online: () => online,
    subscribe: async (handlers) => {
      subscribeCount += 1
      closed = handlers.onClosed
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
    emitClosed: () => closed?.(),
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
        { kind: 'attr-status', path: { endpointId: 1, clusterId: 1, attributeId: 0 }, status: 1 },
      ],
    ])
    expect(reports).toEqual([
      { nodeId: '7', endpointId: 1, clusterId: 0x0101, attributeId: 0, value: 1 },
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

  it('resubscribes after the session drops, with a bounded backoff', async () => {
    vi.useFakeTimers()
    let fail = false
    const supervisor = new MatterSubscriptionSupervisor({
      brokerId: 'matter_001',
      logger: silentLogger([]),
      resolveDeviceId: () => null,
      onReport: () => undefined,
    })
    const node = peer({
      nodeId: 'n1',
      onSubscribe: () => {
        if (fail) throw new Error('session down')
      },
    })
    await supervisor.sync([node.peer])
    expect(node.subscribeCount()).toBe(1)

    fail = true
    node.emitClosed()
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS)
    expect(node.subscribeCount()).toBe(2)

    const before = node.subscribeCount()
    for (let i = 0; i < 8; i += 1) {
      await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_MAX_MS)
    }
    // An uncapped doubling would exceed the cap and these waits would not fire.
    expect(node.subscribeCount()).toBeGreaterThanOrEqual(before + 8)
    await supervisor.stop()
  })

  it('resubscribes when the node comes back online', async () => {
    const supervisor = new MatterSubscriptionSupervisor({
      brokerId: 'matter_001',
      logger: silentLogger([]),
      resolveDeviceId: () => 9,
      onReport: () => undefined,
    })
    const node = peer({ nodeId: 'n1', online: true })
    await supervisor.sync([node.peer])
    node.goOffline()
    node.emitClosed()
    expect(node.subscribeCount()).toBe(1)
    node.goOnline()
    await vi.waitFor(() => expect(node.subscribeCount()).toBe(2))
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
})
