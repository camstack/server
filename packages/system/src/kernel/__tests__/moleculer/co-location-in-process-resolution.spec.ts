/**
 * Co-location zero-copy proof.
 *
 * The ENTIRE payoff of an `execution.group` (e.g. the `detection` group:
 * pipeline-runner + detection-pipeline + motion-wasm) is that cap calls BETWEEN
 * co-located addons resolve IN-PROCESS — never crossing a process boundary.
 * Two addons in one runner share one Moleculer nodeId, hence one
 * `getRegistries(nodeId)` provider registry; `localProviderLink` short-circuits
 * any cap the local registry can serve BEFORE the call reaches the next link
 * (`ipcParentLink`, the UDS hop to the hub-main parent).
 *
 * This spec drives the REAL `localProviderLink` + the REAL per-node registry
 * (`getRegistries` / `getCurrentAddonId` scoping) exactly as
 * `addon-context-factory` wires them, and asserts:
 *   - a call to a SIBLING's cap invokes the sibling provider directly, and
 *   - the terminating link (`next`, standing in for the UDS parent hop) is
 *     NEVER invoked — i.e. the frame/detection hop stays in-process (zero copy).
 *
 * If a future refactor breaks the shared-registry-per-node assumption, this
 * turns red: co-located calls would fall through to the parent and re-introduce
 * the hub-main pixel-buffering OOM the co-location was built to avoid.
 */

import { observable } from '@trpc/server/observable'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetBindingSubscriptionForTests,
  getRegistries,
  withAddonScope,
} from '../../moleculer/provider-registry.js'
import type { LocalProviderResolver } from '../../moleculer/trpc-links.js'
import { localProviderLink } from '../../moleculer/trpc-links.js'

// A shared runner node id — the two addons below are "co-located" here, exactly
// like the `detection` group's members all run under `hub/detection`.
const RUNNER_NODE_ID = 'hub/detection'

/**
 * Faithful re-creation of `addon-context-factory`'s `workerResolver`: reads the
 * per-node shared registry with a preferred-provider fallback to first-registered.
 */
function makeWorkerResolver(nodeId: string): LocalProviderResolver {
  const regs = getRegistries(nodeId)
  return {
    localNodeId: nodeId,
    getByName(capabilityName: string): unknown | null {
      const preferred = regs.preferred.get(capabilityName)
      if (preferred) {
        const provider = regs.byAddonId.get(capabilityName)?.get(preferred)
        if (provider) return provider
      }
      const providers = regs.providers.get(capabilityName)
      return (providers && providers.length > 0 ? providers[0] : undefined) ?? null
    },
  }
}

/** Register a provider under `addonId`'s scope, exactly as the runner does. */
function registerProvider(
  nodeId: string,
  addonId: string,
  capName: string,
  provider: object,
): void {
  const regs = getRegistries(nodeId)
  withAddonScope(addonId, () => {
    const providers = regs.providers.get(capName) ?? []
    if (!providers.includes(provider)) providers.push(provider)
    regs.providers.set(capName, providers)
    const byAddon = regs.byAddonId.get(capName) ?? new Map<string, unknown>()
    byAddon.set(addonId, provider)
    regs.byAddonId.set(capName, byAddon)
  })
}

/** Drive one operation through the link and collect the result/next-calls. */
async function runOp(
  resolver: LocalProviderResolver,
  path: string,
  input: unknown,
): Promise<{ data: unknown; nextCalls: number }> {
  const link = localProviderLink(resolver)({}) // instantiate the link runtime
  let nextCalls = 0
  const next = vi.fn(() => {
    nextCalls += 1
    // Stand-in for the terminating parent hop — if co-location works, never hit.
    return observable((observer) => {
      observer.error(new Error('call fell through to the parent hop (NOT co-located)'))
      return () => {}
    })
  })

  const op = {
    id: 1,
    type: 'query' as const,
    path,
    input,
    context: {},
    signal: null,
  }

  const data = await new Promise<unknown>((resolve, reject) => {
    link({ op, next }).subscribe({
      next: (envelope: unknown) => {
        const result = (envelope as { result?: { data?: unknown } }).result
        resolve(result?.data)
      },
      error: reject,
      complete: () => {},
    })
  })
  return { data, nextCalls }
}

describe('co-location — in-process (zero-copy) sibling cap resolution', () => {
  beforeEach(() => {
    __resetBindingSubscriptionForTests()
  })

  it('a call to a co-located sibling cap resolves in-process, never reaching the parent hop', async () => {
    // detection-pipeline registers `pipeline-executor`; pipeline-runner
    // registers `pipeline-runner`. Both are on the SAME runner node.
    const runPipeline = vi.fn((input: { frameId: number }) => ({ tracks: input.frameId }))
    registerProvider(RUNNER_NODE_ID, 'detection-pipeline', 'pipeline-executor', {
      runPipeline,
    })
    registerProvider(RUNNER_NODE_ID, 'pipeline-runner', 'pipeline-runner', {
      getStatus: vi.fn(() => ({ active: true })),
    })

    // pipeline-runner calls its co-located executor (the hot decode→detect hop).
    const resolver = makeWorkerResolver(RUNNER_NODE_ID)
    const { data, nextCalls } = await runOp(resolver, 'pipelineExecutor.runPipeline', {
      frameId: 42,
    })

    expect(runPipeline).toHaveBeenCalledWith({ frameId: 42 })
    expect(data).toEqual({ tracks: 42 })
    // THE zero-copy assertion: the call never fell through to the parent hop.
    expect(nextCalls).toBe(0)
  })

  it('a cap NOT hosted on this runner falls through to the parent hop', async () => {
    // Only pipeline-runner is co-located here; `snapshot` lives elsewhere.
    registerProvider(RUNNER_NODE_ID, 'pipeline-runner', 'pipeline-runner', {
      getStatus: vi.fn(() => ({ active: true })),
    })
    const resolver = makeWorkerResolver(RUNNER_NODE_ID)

    await expect(runOp(resolver, 'snapshot.getSnapshot', {})).rejects.toThrow(/parent hop/)
  })
})
