import type { IScopedLogger, ShareSource, ShareWeights, SuggestSharesResult } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  EffectiveSharesService,
  type EffectiveSharesServiceDeps,
} from '../load-balancing/effective-shares-service.js'

interface Logged {
  readonly level: 'info' | 'warn' | 'debug'
  readonly message: string
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

function recordingLogger(lines: Logged[]): IScopedLogger {
  const at =
    (level: Logged['level']) =>
    (
      message: string,
      extra?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ) => {
      lines.push({ level, message, ...extra })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function suggestion(
  shares: Record<string, number>,
  devices: Record<string, Record<string, number>> = {},
): SuggestSharesResult {
  return {
    headroom: 0.4,
    source: 'hardware',
    cameraFps: 10,
    minSessionsPerDevice: 2,
    nodes: Object.entries(shares).map(([nodeId, share]) => ({
      nodeId,
      share,
      capacitySessions: 1,
      skippedReason: null,
      capacitySource: 'hardware' as const,
      capacityFallback: null,
      devices: Object.entries(devices[nodeId] ?? {}).map(([deviceKey, s]) => ({
        deviceKey,
        share: s,
        modelId: null,
        fps: null,
        measured: true,
        suggestedMaxSessions: 1,
      })),
    })),
  }
}

const STORED: ShareWeights = { nodes: { hub: 20, 'agent-a': 10, mac: 70 }, devices: {} }

function harness(over: Partial<EffectiveSharesServiceDeps> = {}) {
  let source: ShareSource = 'hardware'
  let signature = 'sig-1'
  let clock = 1_000
  const lines: Logged[] = []
  const suggest = vi.fn(async () =>
    suggestion(
      { hub: 46, 'agent-a': 9, mac: 45 },
      { hub: { 'openvino:npu': 54, 'openvino:gpu': 46 } },
    ),
  )
  const deps: EffectiveSharesServiceDeps = {
    readSource: () => source,
    readStored: async () => STORED,
    suggest,
    topologySignature: async () => signature,
    logger: recordingLogger(lines),
    now: () => clock,
    ...over,
  }
  const service = new EffectiveSharesService(deps)
  return {
    service,
    suggest,
    lines,
    setSource: (s: ShareSource) => {
      source = s
    },
    setSignature: (s: string) => {
      signature = s
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe('EffectiveSharesService (D750, D755)', () => {
  it('hardware: the election reads the capacity shares once computed', async () => {
    const h = harness()
    expect(await h.service.nodeWeights()).toEqual(STORED.nodes)
    await h.service.recompute('startup')
    expect(await h.service.nodeWeights()).toEqual({ hub: 46, 'agent-a': 9, mac: 45 })
    expect(h.service.deviceWeights('hub', { 'openvino:npu': 50, 'openvino:gpu': 50 })).toEqual({
      'openvino:npu': 54,
      'openvino:gpu': 46,
    })
  })

  it('logs every recompute per node, with the shares before and after', async () => {
    const h = harness()
    await h.service.recompute('device-disabled')
    const recomputed = h.lines.filter((l) => l.message.includes('automatic shares recomputed'))
    expect(recomputed.map((l) => l.tags?.nodeId).toSorted()).toEqual(['agent-a', 'hub', 'mac'])
    expect(recomputed.find((l) => l.tags?.nodeId === 'hub')?.meta).toMatchObject({
      trigger: 'device-disabled',
      before: null,
      after: 46,
    })
  })

  it('a trigger recomputes immediately — a disabled device or an offline node moves the shares', async () => {
    const h = harness()
    await h.service.recompute('startup')
    h.suggest.mockResolvedValueOnce(suggestion({ hub: 80, mac: 20 }))
    await h.service.recompute('node-offline:agent-a')
    expect(await h.service.nodeWeights()).toEqual({ hub: 80, mac: 20 })
  })

  it('the periodic reconcile catches a change no trigger reported', async () => {
    const h = harness()
    await h.service.reconcile()
    expect(h.suggest).toHaveBeenCalledTimes(1)
    await h.service.reconcile()
    expect(h.suggest).toHaveBeenCalledTimes(1)
    h.setSignature('sig-2')
    await h.service.reconcile()
    expect(h.suggest).toHaveBeenCalledTimes(2)
  })

  it('an answer computed while a node was not ready yet is recomputed on the NEXT reconcile', async () => {
    // Live 2026-10-07: `node-online:agent-a` recomputed before the
    // node's catalog answered, so the N100 was skipped (share null → weight 1,
    // 1 %) while `suggestShares` a minute later said 6 %. The topology
    // signature had not changed, so the wrong answer was held up to 15 min.
    const h = harness()
    const notReady = suggestion({ hub: 67, mac: 33 })
    h.suggest.mockResolvedValueOnce({
      ...notReady,
      nodes: [
        ...notReady.nodes,
        {
          nodeId: 'agent-a',
          share: null,
          capacitySessions: 0,
          skippedReason: 'node-offline',
          capacitySource: null,
          capacityFallback: null,
          devices: [],
        },
      ],
    })
    h.suggest.mockResolvedValueOnce(suggestion({ hub: 63, 'agent-a': 6, mac: 31 }))
    await h.service.recompute('node-online:agent-a')
    expect((await h.service.nodeWeights())['agent-a']).toBeUndefined()
    h.advance(EffectiveSharesService.RECONCILE_MS)
    await h.service.reconcile()
    expect(await h.service.nodeWeights()).toEqual({ hub: 63, 'agent-a': 6, mac: 31 })
  })

  it('the reconcile also refreshes an answer that has grown old', async () => {
    const h = harness()
    await h.service.reconcile()
    h.advance(EffectiveSharesService.MAX_AGE_MS + 1)
    await h.service.reconcile()
    expect(h.suggest).toHaveBeenCalledTimes(2)
  })

  it('manual: the stored sliders apply and nothing is computed', async () => {
    const h = harness()
    h.setSource('manual')
    await h.service.reconcile()
    expect(h.suggest).not.toHaveBeenCalled()
    expect(await h.service.nodeWeights()).toEqual(STORED.nodes)
    expect(h.service.deviceWeights('hub', { 'openvino:npu': 50 })).toEqual({ 'openvino:npu': 50 })
  })

  it('a failed computation keeps the last answer and says so', async () => {
    const h = harness()
    await h.service.recompute('startup')
    h.suggest.mockRejectedValueOnce(new Error('catalog not answered'))
    await h.service.recompute('device-enabled')
    expect(await h.service.nodeWeights()).toEqual({ hub: 46, 'agent-a': 9, mac: 45 })
    expect(h.lines.some((l) => l.level === 'warn' && l.message.includes('kept'))).toBe(true)
  })

  it('the suggestion is asked for the CURRENT automatic source', async () => {
    const h = harness()
    h.setSource('benchmark')
    await h.service.recompute('source:benchmark')
    expect(h.suggest).toHaveBeenLastCalledWith('benchmark')
  })

  it('switching between automatic sources recomputes on the next reconcile; the old answer is not used meanwhile', async () => {
    const h = harness()
    await h.service.recompute('startup')
    h.setSource('benchmark')
    expect(h.service.current()).toBeNull()
    await h.service.reconcile()
    expect(h.suggest).toHaveBeenLastCalledWith('benchmark')
    expect(h.service.current()?.trigger).toBe('reconcile:source:benchmark')
  })

  it('records per node what each automatic share was computed from', async () => {
    const h = harness()
    await h.service.recompute('startup')
    expect(h.service.current()?.capacity.hub).toEqual({ source: 'hardware', fallback: null })
  })

  it('concurrent triggers coalesce into one trailing recompute', async () => {
    const h = harness()
    await Promise.all([
      h.service.recompute('a'),
      h.service.recompute('b'),
      h.service.recompute('c'),
    ])
    expect(h.suggest.mock.calls.length).toBeLessThanOrEqual(2)
  })
})
