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
}

function recordedPeer(nodeId: string): {
  peer: Record<string, unknown>
  requests: RecordedRequest[]
  goOffline: () => void
} {
  const requests: RecordedRequest[] = []
  const offlineHandlers: Array<() => void> = []
  const lifecycle = {
    isOnline: true,
    online: { on: () => undefined, off: () => undefined },
    offline: {
      on: (handler: () => void) => offlineHandlers.push(handler),
      off: () => undefined,
    },
  }
  const peer: Record<string, unknown> = {
    id: nodeId,
    lifecycle,
    stateOf: () => ({ autoSubscribe: true }),
    interaction: {
      subscribe: async (request: RecordedRequest) => {
        requests.push(request)
        return { close: async () => undefined }
      },
    },
  }
  return {
    peer,
    requests,
    goOffline: () => {
      lifecycle.isOnline = false
      for (const handler of offlineHandlers) handler()
    },
  }
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

  it('keeps one sustained subscription for a node that went offline (no second session)', async () => {
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
    recorded.goOffline()
    await vi.advanceTimersByTimeAsync(SUBSCRIPTION_BACKOFF_INITIAL_MS)
    expect(recorded.requests).toHaveLength(1)
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

describe('MatterJsController commissioning failures', () => {
  function recordingLogger(warns: string[]): IScopedLogger {
    const logger: IScopedLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => {
        warns.push(message)
      },
      error: () => undefined,
      child: () => logger,
      withTags: () => logger,
    }
    return logger
  }

  it('logs and names the reason when the commission call itself fails', async () => {
    const warns: string[] = []
    const phases: CommissionProgress[] = []
    const controller = new MatterJsController(
      {
        brokerId: 'matter_001',
        dataDir: '/tmp/matter-test',
        onCommissionProgress: (p) => phases.push(p),
        openServer: async () => ({
          start: async () => undefined,
          close: async () => undefined,
          listPeers: () => [],
          commission: async () => {
            throw new Error('Unexpected failure code 0x1c')
          },
        }),
      },
      recordingLogger(warns),
    )
    await controller.start()
    await expect(controller.commissionNode('34970112332')).rejects.toThrow(/0x1c/)
    expect(warns.some((m) => m.includes('commissioning failed'))).toBe(true)
    expect(phases.at(-1)?.message).toContain('0x1c')
  })

  it('a committed node whose first subscription fails still ends Done', async () => {
    const warns: string[] = []
    const phases: CommissionProgress[] = []
    const recorded = recordedPeer('11')
    let committed = false
    const controller = new MatterJsController(
      {
        brokerId: 'matter_001',
        dataDir: '/tmp/matter-test',
        onCommissionProgress: (p) => phases.push(p),
        openServer: async () => ({
          start: async () => undefined,
          close: async () => undefined,
          listPeers: () => {
            if (committed) throw new Error('registry busy')
            return []
          },
          commission: async () => {
            committed = true
            return recorded.peer
          },
        }),
      },
      recordingLogger(warns),
    )
    await controller.start()
    await expect(controller.commissionNode('34970112332')).resolves.toEqual({
      nodeId: '11',
    })
    expect(phases.at(-1)?.phase).toBe(CommissionPhase.Done)
    expect(warns.some((m) => m.includes('first subscription failed'))).toBe(true)
  })
})
