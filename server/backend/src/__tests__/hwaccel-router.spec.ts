/**
 * S3 — hwaccel router repointed onto the `platform-probe` cap.
 *
 * The router no longer calls the retired `$hwaccel` Moleculer service. Instead:
 *   - `resolve` (hub-local) → `capabilityRegistry.getSingleton('platform-probe')`
 *   - `resolveForNode` / `resolveAll` → `moleculer.createCapabilityProxy(
 *     'platform-probe', nodeId)`, whose `resolveHwAccel` result is narrowed
 *     through the cap's Zod output schema (typed adapter, no cast).
 * Unreachable / malformed responses degrade to an EXPLAINED empty list.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CapabilityRegistry } from '@camstack/system'
import { createHwAccelRouter } from '../api/core/hwaccel.router.js'
import type { MoleculerService } from '../core/moleculer/moleculer.service.js'
import { makeCtx } from './cap-routers/harness.js'

interface HwAccelResolution {
  readonly preferred: readonly string[]
  readonly rationale: string
}

type ResolveHwAccel = (input: { readonly prefer?: string | null }) => Promise<HwAccelResolution>
type CapProxy = Record<string, (params: unknown) => Promise<unknown>> | null

function makeRegistry(provider: { resolveHwAccel: ResolveHwAccel } | null): CapabilityRegistry {
  return {
    getSingleton: (name: string) => (name === 'platform-probe' ? provider : null),
  } as unknown as CapabilityRegistry
}

function makeMoleculer(opts: {
  readonly proxyFor?: (cap: string, nodeId: string) => CapProxy
  readonly nodeIds?: readonly string[]
}): MoleculerService {
  return {
    createCapabilityProxy: vi.fn(
      (cap: string, nodeId: string) => opts.proxyFor?.(cap, nodeId) ?? null,
    ),
    broker: {
      registry: {
        getNodeList: (_o: { onlyAvailable: boolean }) => (opts.nodeIds ?? []).map((id) => ({ id })),
      },
    },
  } as unknown as MoleculerService
}

describe('hwaccel router — repointed onto platform-probe', () => {
  it('resolve() serves the hub-local platform-probe singleton', async () => {
    const resolveHwAccel = vi.fn<ResolveHwAccel>(async () => ({
      preferred: ['videotoolbox'],
      rationale: 'macOS VideoToolbox',
    }))
    const router = createHwAccelRouter(makeRegistry({ resolveHwAccel }), makeMoleculer({}))
    const caller = router.createCaller(makeCtx('admin'))

    const res = await caller.resolve({ prefer: null })

    expect(res).toEqual({ preferred: ['videotoolbox'], rationale: 'macOS VideoToolbox' })
    expect(resolveHwAccel).toHaveBeenCalledWith({ prefer: null })
  })

  it('resolve() degrades with an explained empty list when the cap is absent', async () => {
    const router = createHwAccelRouter(makeRegistry(null), makeMoleculer({}))
    const caller = router.createCaller(makeCtx('admin'))

    const res = await caller.resolve({ prefer: 'vaapi' })

    expect(res.preferred).toEqual([])
    expect(res.rationale).toContain('not available')
  })

  it('resolveForNode() builds a platform-probe proxy for the node and returns its resolution', async () => {
    const proxyResolve = vi.fn(async () => ({
      preferred: ['vaapi', 'qsv'],
      rationale: 'Intel iGPU',
    }))
    const proxyFor = vi.fn((_cap: string, _nodeId: string) => ({ resolveHwAccel: proxyResolve }))
    const moleculer = makeMoleculer({ proxyFor })
    const router = createHwAccelRouter(makeRegistry(null), moleculer)
    const caller = router.createCaller(makeCtx('admin'))

    const res = await caller.resolveForNode({ nodeId: 'agent-x', prefer: 'vaapi' })

    expect(res).toEqual({ preferred: ['vaapi', 'qsv'], rationale: 'Intel iGPU' })
    expect(moleculer.createCapabilityProxy).toHaveBeenCalledWith('platform-probe', 'agent-x')
    expect(proxyResolve).toHaveBeenCalledWith({ prefer: 'vaapi' })
  })

  it('resolveForNode() returns an explained empty list when the node is unreachable', async () => {
    const router = createHwAccelRouter(makeRegistry(null), makeMoleculer({ proxyFor: () => null }))
    const caller = router.createCaller(makeCtx('admin'))

    const res = await caller.resolveForNode({ nodeId: 'offline-agent', prefer: null })

    expect(res.preferred).toEqual([])
    expect(res.rationale).toContain('unreachable')
  })

  it('resolveForNode() rejects a malformed proxy response via the Zod output schema', async () => {
    const proxyFor = () => ({ resolveHwAccel: async () => ({ bogus: true }) })
    const router = createHwAccelRouter(makeRegistry(null), makeMoleculer({ proxyFor }))
    const caller = router.createCaller(makeCtx('admin'))

    const res = await caller.resolveForNode({ nodeId: 'agent-x', prefer: null })

    expect(res.preferred).toEqual([])
    expect(res.rationale).toContain('invalid probe response')
  })

  it('resolveAll() resolves every reachable node through its proxy', async () => {
    const proxyFor = (_cap: string, nodeId: string) => ({
      resolveHwAccel: async () => ({
        preferred: nodeId === 'hub' ? ['videotoolbox'] : ['vaapi'],
        rationale: nodeId,
      }),
    })
    const router = createHwAccelRouter(
      makeRegistry(null),
      makeMoleculer({ proxyFor, nodeIds: ['hub', 'agent-x'] }),
    )
    const caller = router.createCaller(makeCtx('admin'))

    const all = await caller.resolveAll()

    expect(all).toEqual([
      { nodeId: 'hub', resolution: { preferred: ['videotoolbox'], rationale: 'hub' } },
      { nodeId: 'agent-x', resolution: { preferred: ['vaapi'], rationale: 'agent-x' } },
    ])
  })
})
