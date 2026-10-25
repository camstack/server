/**
 * The platform-probe readiness reconcile must prove THIS node's readiness.
 *
 * When the `system.ready-state` gate times out, the provider asks the probe
 * provider directly (D8: readiness events are telemetry and can be lost).
 * That reconcile used to issue an UNPINNED `platformProbe.getCapabilities`,
 * with a docblock claiming it "routes to this node's own in-process provider
 * (agent parent / hub)".
 *
 * On an agent that is false. A forked child's unowned cap call reaches the
 * agent's `onUnownedCall`, which has `getResolver: () => null` and no outbound
 * in-process lookup, so it goes straight to `forwardToHub` → the HUB's
 * `platform-probe` singleton (`server/backend/src/agent/main.ts`,
 * `packages/system/src/kernel/transport/parent-unowned-call.ts`). Every
 * "readiness reconciled via direct probe RPC (ready event lost)" line ever
 * logged on an agent proved the HUB's probe had finished — not the node's.
 *
 * Cost of the false positive: on 2026-08-07 `agent-a` had no
 * `platform-probe` addon AT ALL (its `@camstack/system` package had been
 * renamed out of `/data/addons`), and this line was the evidence that made it
 * look like a node with a lossy event path instead of a node with no probe.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { DetectionPipelineProvider } from '../provider.js'

const NOOP_LOGGER: IScopedLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => NOOP_LOGGER,
  withTags: () => NOOP_LOGGER,
}

const SETTINGS = {
  readAddonStore: async () => ({}),
  writeAddonStore: async () => undefined,
}

interface ProbeCall {
  readonly input: unknown
}

/**
 * A fake cap plane that behaves like the real one: a call carrying an inline
 * `nodeId` resolves to THAT node's provider; an unpinned call falls through to
 * the hub's singleton (which is what `forwardToHub` does on an agent).
 */
function makeApi(nodesWithProbe: readonly string[], calls: ProbeCall[]) {
  return {
    platformProbe: {
      getCapabilities: {
        query: vi.fn(async (input?: unknown) => {
          calls.push({ input })
          const target =
            input !== null && typeof input === 'object' && 'nodeId' in input
              ? String((input as { nodeId: unknown }).nodeId)
              : 'hub'
          if (!nodesWithProbe.includes(target)) {
            throw new Error(`${target} does not know cap platform-probe`)
          }
          return { hardware: {}, scores: [], devices: [] }
        }),
      },
    },
  }
}

function makeProvider(localNodeId: string, api: unknown): DetectionPipelineProvider {
  const provider = new DetectionPipelineProvider(SETTINGS, '/tmp/models', NOOP_LOGGER)
  Reflect.set(provider, 'addonCtx', { kernel: { localNodeId }, api })
  return provider
}

describe('probePlatformReadinessDirect — pinned to the local node', () => {
  it('pins the reconcile RPC to the local node id', async () => {
    const calls: ProbeCall[] = []
    const provider = makeProvider('agent-a', makeApi(['hub', 'agent-a'], calls))

    const ready = await Reflect.get(provider, 'probePlatformReadinessDirect')?.call(provider)

    expect(ready).toBe(true)
    expect(calls).toEqual([{ input: { nodeId: 'agent-a' } }])
  })

  it('strips the forked-child suffix — the pin names the CLUSTER node', async () => {
    const calls: ProbeCall[] = []
    const provider = makeProvider('agent-a/detection', makeApi(['hub', 'agent-a'], calls))

    await Reflect.get(provider, 'probePlatformReadinessDirect')?.call(provider)

    expect(calls).toEqual([{ input: { nodeId: 'agent-a' } }])
  })

  it('reports NOT ready when only the HUB can answer — never adopts another node`s probe', async () => {
    // The discriminating case. Remove the pin and this call goes out unpinned,
    // the hub answers, and the provider claims readiness (and logs "ready event
    // lost") for a node that has no platform-probe at all.
    const calls: ProbeCall[] = []
    const provider = makeProvider('agent-a', makeApi(['hub'], calls))

    const ready = await Reflect.get(provider, 'probePlatformReadinessDirect')?.call(provider)

    expect(ready).toBe(false)
    expect(calls).toEqual([{ input: { nodeId: 'agent-a' } }])
  })

  it('still resolves on the hub itself', async () => {
    const calls: ProbeCall[] = []
    const provider = makeProvider('hub', makeApi(['hub'], calls))

    const ready = await Reflect.get(provider, 'probePlatformReadinessDirect')?.call(provider)

    expect(ready).toBe(true)
    expect(calls).toEqual([{ input: { nodeId: 'hub' } }])
  })
})
