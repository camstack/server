import { describe, expect, it, vi, afterEach } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { MatterJsController, type MatterFabricServer } from '../matter-controller-impl.js'
import { CommissionPhase } from '../matter-commission-progress.js'
import type { CommissionProgress } from '../matter-commission-progress.js'
import { SUBSCRIPTION_BACKOFF_INITIAL_MS } from '../matter-subscription.js'

function silentLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface RecordedRequest {
  updated?: (update: unknown) => Promise<void>
  closed?: () => void
}

function recordedPeer(nodeId: string): {
  peer: Record<string, unknown>
  requests: RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const peer: Record<string, unknown> = {
    id: nodeId,
    lifecycle: {
      isOnline: true,
      online: { on: () => undefined, off: () => undefined },
      offline: { on: () => undefined, off: () => undefined },
    },
    stateOf: () => ({ autoSubscribe: true }),
    interaction: {
      subscribe: async (request: RecordedRequest) => {
        requests.push(request)
        return { close: async () => undefined }
      },
    },
  }
  return { peer, requests }
}

function serverOf(peers: readonly Record<string, unknown>[]): MatterFabricServer {
  return {
    start: async () => undefined,
    close: async () => undefined,
    listPeers: () => peers,
    commission: async () => peers[0],
  }
}

describe('MatterJsController subscriptions', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('applies a recorded attribute report to listeners', async () => {
    const recorded = recordedPeer('11')
    const controller = new MatterJsController(
      {
        brokerId: 'matter_001',
        dataDir: '/tmp/matter-test',
        openServer: async () => serverOf([recorded.peer]),
        resolveDeviceId: () => 5,
      },
      silentLogger(),
    )
    const values: unknown[] = []
    controller.subscribe((report) => values.push(report.value))
    await controller.start()
    const request = recorded.requests[0]
    expect(request?.updated).toBeTypeOf('function')
    await request?.updated?.([
      [
        {
          kind: 'attr-value',
          path: { endpointId: 1, clusterId: 0x0101, attributeId: 0 },
          value: 1,
          version: 1,
        },
      ],
    ])
    expect(values).toEqual([1])
    await controller.stop()
  })

  it('resubscribes after the recorded subscription closes', async () => {
    vi.useFakeTimers()
    const recorded = recordedPeer('11')
    const controller = new MatterJsController(
      {
        brokerId: 'matter_001',
        dataDir: '/tmp/matter-test',
        openServer: async () => serverOf([recorded.peer]),
      },
      silentLogger(),
    )
    await controller.start()
    expect(recorded.requests).toHaveLength(1)
    recorded.requests[0]?.closed?.()
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS)
    expect(recorded.requests.length).toBeGreaterThanOrEqual(2)
    await controller.stop()
  })

  it('reports commissioning phases and a named failure', async () => {
    const phases: CommissionProgress[] = []
    const controller = new MatterJsController(
      {
        brokerId: 'matter_001',
        dataDir: '/tmp/matter-test',
        onCommissionProgress: (progress) => phases.push(progress),
        openServer: async () => ({
          start: async () => undefined,
          close: async () => undefined,
          listPeers: () => [],
          commission: async ({ onPase }) => {
            onPase()
            throw new Error('commissioning window expired')
          },
        }),
      },
      silentLogger(),
    )
    await controller.start()
    await expect(controller.commissionNode('34970112332')).rejects.toThrow(
      /matter-commission:code-expired/,
    )
    expect(phases.map((phase) => phase.phase)).toEqual([
      CommissionPhase.Discovering,
      CommissionPhase.Pase,
      CommissionPhase.Commissioning,
      CommissionPhase.Failed,
    ])
    expect(phases.at(-1)?.failure).toBe('code-expired')
    await controller.stop()
  })
})
