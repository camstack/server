/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/**
 * Regression tests — 2026-07-17 lost-readiness incident (robust dispatch,
 * reconcile-against-central-registry).
 *
 * Live failure: after an agent update, `pipeline-executor` on
 * `agent-a` came back up and was fully callable, but its
 * `system.ready-state → ready` event never reached the hub orchestrator's
 * `ReadinessRegistry` (readiness events are telemetry — lossy per D8).
 * `PipelineSettingsStore.seedAgentSettingsFromCatalog` and
 * `waitForAgentAndCatalog` gated on
 * `acquireCapability('pipeline-executor', …)` with the DEFAULT Infinity
 * timeout — a wait that resolves ONLY on a registry event. With the event
 * lost, every dispatch wedged forever ("readiness: still awaiting
 * pipeline-executor (node:agent-a) after 210000ms" repeating for
 * 3.5h) even though a single `pipelineExecutor.getSchema` RPC would have
 * answered immediately.
 *
 * The fix makes the gate reconcile-driven: each round first asks the
 * PROVIDER itself (`getSchema` — an authoritative RPC read, not a local
 * cache), and only uses the registry wait as a BOUNDED event-driven fast
 * path. A lost event now delays convergence by at most one reconcile
 * round — never forever.
 */
import { createDurableState, type AddonContext, type DurableState, sleep } from '@camstack/types'
import type { ZodType } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { makeSilentLogger } from './e2e-helpers.js'

/** Minimal-but-valid executor catalog (same shape as the e2e-helpers stub).
 *  object-detection carries an onnx model so it is PROVISIONED for the node's
 *  engine format (the #33 gate-AND-provisioned resolver requires a compatible
 *  model to build the step). */
const FAKE_CATALOG = {
  slots: [
    {
      id: 'detect',
      addons: [
        {
          id: 'object-detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person'],
          enabledByDefault: true,
          defaultModelId: 'yolo',
          defaultConfidence: 0.5,
          models: [
            { id: 'yolo', name: 'yolo', formats: { onnx: { downloaded: true, sizeMB: 1 } } },
          ],
        },
      ],
    },
  ],
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
}

interface HarnessOptions {
  /**
   * Per-call `getSchema` behaviour. Defaults to always answering with
   * `FAKE_CATALOG`.
   */
  readonly getSchema?: (input: { nodeId: string }) => unknown
}

interface Harness {
  readonly store: PipelineSettingsStore
  readonly getSchemaCalls: () => number
  readonly acquireCalls: () => ReadonlyArray<{ timeoutMs: number | undefined }>
}

/**
 * Store harness with:
 *  - an in-memory durable state (same pattern as the atomicity spec),
 *  - a fake `acquireCapability` that models the LOST-EVENT registry
 *    faithfully: an Infinity/absent timeout NEVER settles (the registry
 *    never sees `ready`); a finite timeout rejects shortly after (the
 *    bounded wait timing out, time-compressed for the test),
 *  - a fake `api.pipelineExecutor.getSchema` — the authoritative RPC.
 */
function makeHarness(opts: HarnessOptions = {}): Harness {
  let blob: Record<string, unknown> = {}
  const state = <T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
    createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () => {
        await Promise.resolve()
        return blob
      },
      write: async (patch) => {
        await Promise.resolve()
        blob = { ...blob, ...patch }
      },
    })

  let schemaCalls = 0
  const getSchemaImpl = opts.getSchema ?? ((): unknown => FAKE_CATALOG)
  const fakeApi = {
    pipelineExecutor: {
      getSchema: {
        query: async (input: { nodeId: string }): Promise<unknown> => {
          schemaCalls++
          return getSchemaImpl(input)
        },
      },
    },
    deviceManager: {
      getBindings: {
        query: async (): Promise<unknown> => ({
          entries: [{ capName: 'detection-pipeline', kind: 'wrapped' }],
        }),
      },
    },
  }

  const acquireCalls: Array<{ timeoutMs: number | undefined }> = []
  const acquireCapability = (async (
    _capName: string,
    _scope: unknown,
    acquireOpts?: { timeoutMs?: number },
  ): Promise<unknown> => {
    acquireCalls.push({ timeoutMs: acquireOpts?.timeoutMs })
    const timeoutMs = acquireOpts?.timeoutMs
    if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
      // Infinity wait on a registry that never saw `ready` — never settles.
      return new Promise(() => undefined)
    }
    // Bounded wait: the (lost) event never arrives, so the wait times out.
    // Time-compressed: the real round is 30s; the semantics are identical.
    await sleep(5)
    throw new Error('CapabilityUnavailableError (fake — ready event lost)')
  }) as AddonContext['acquireCapability']

  const store = new PipelineSettingsStore({
    state,
    api: () => fakeApi as never,
    acquireCapability,
    getAssignmentNode: () => 'agent-a',
    hasPackageZone: async () => false,
    logger: makeSilentLogger(),
  })
  return {
    store,
    getSchemaCalls: () => schemaCalls,
    acquireCalls: () => acquireCalls,
  }
}

/** Rejects if `promise` does not settle within `ms` — proves (non-)wedging. */
async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms — waiter wedged`)), ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe('PipelineSettingsStore — executor readiness reconcile (lost-event convergence)', () => {
  it('seedAgentSettingsFromCatalog converges when the ready event was lost but the provider answers', async () => {
    const h = makeHarness()

    const seeded = await withinMs(h.store.seedAgentSettingsFromCatalog('agent-a'), 2_000)

    // The per-node model layer is gone — seeding just ensures a bare entry.
    expect(seeded).not.toBeNull()
    expect(seeded?.maxCameras ?? null).toBeNull()
    // The authoritative RPC was consulted — the registry never fired.
    expect(h.getSchemaCalls()).toBeGreaterThan(0)
    // Every registry wait the gate issued was BOUNDED (no Infinity wait).
    for (const call of h.acquireCalls()) {
      expect(call.timeoutMs).toBeDefined()
      expect(Number.isFinite(call.timeoutMs)).toBe(true)
    }
    const all = await h.store.readAgentSettingsMap()
    expect(all['agent-a']).toBeDefined()
  })

  it('resolvePipelineForDevice converges through waitForAgentAndCatalog on a lost ready event', async () => {
    const h = makeHarness()

    const resolved = await withinMs(h.store.resolvePipelineForDevice(104), 3_000)

    expect(resolved.steps.length).toBeGreaterThan(0)
    expect(h.getSchemaCalls()).toBeGreaterThan(0)
  })

  it('converges on the next reconcile round when the provider starts answering late', async () => {
    let calls = 0
    const h = makeHarness({
      getSchema: () => {
        calls++
        if (calls === 1) throw new Error('no provider for pipeline-executor yet')
        return FAKE_CATALOG
      },
    })

    const seeded = await withinMs(h.store.seedAgentSettingsFromCatalog('agent-a'), 2_000)

    expect(seeded).not.toBeNull()
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('dispose() unblocks an in-flight resolve instead of spinning forever', async () => {
    const neverAnswering = vi.fn(() => {
      throw new Error('no provider for pipeline-executor')
    })
    const h = makeHarness({ getSchema: neverAnswering })

    const inflight = h.store.resolvePipelineForDevice(104)
    await sleep(30)
    h.store.dispose()

    await expect(withinMs(inflight, 2_000)).rejects.toThrow(/disposed/)
  })
})
