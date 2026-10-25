/**
 * End-to-end tests for the `benchmark` addon's customActions surface.
 *
 * Each custom action is exercised through the addon's own
 * `actionHandlers` map (the same surface dispatched from the admin UI
 * via `api.addons.custom.mutate({ addonId:'benchmark', action, input })`).
 *
 * What's covered:
 *   - runPipelineTest — direct call with explicit steps + global-steps
 *     fallback + validation error when no steps available.
 *
 * Heavy deps (the inference pool, the hub's tRPC router, actual
 * models) are mocked at the `ctx.api.pipelineExecutor` seam: every
 * `runPipeline` call is answered by the fake with a deterministic
 * `{ detections, debug.totalInferenceMs }` shape so assertions can
 * pin exact values without process-level nondeterminism.
 */

import {
  type AddonContext,
  type IEventBus,
  type InMemoryRecords,
  makeInMemoryRecords,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { benchmarkActions } from '../benchmark-actions.js'
import { BenchmarkAddon } from '../benchmark-addon.js'
import { PipelineRunInputSchema } from '../benchmark-schemas.js'
import { benchmarkRecordKinds } from '../record-kinds.js'

/**
 * Dispatch exactly as the hub does: `dispatchCustomAction` parses the body
 * against the action's declared input schema BEFORE calling the handler, and
 * a `z.object` strips every key it does not declare.
 *
 * Invoking the handler directly skips that parse, which is why the plain
 * `invoke` below cannot prove a forwarding claim on its own — deleting a
 * field from `PipelineRunInputSchema` while leaving the addon's spread in
 * place kept those assertions GREEN. Routing the new cases through the
 * schema makes the schema half of the change load-bearing too.
 */
function parseRunInput(input: Record<string, unknown>): z.infer<typeof PipelineRunInputSchema> {
  return PipelineRunInputSchema.parse(input)
}

// ── Fake context ───────────────────────────────────────────────────────

/**
 * Everything the fake `pipelineExecutor.runPipeline` was handed. Recorded
 * verbatim so a spec can assert on what the cap RECEIVED — asserting on the
 * action's own input instead would stay green after the forwarding is
 * deleted.
 */
interface RunPipelineCall {
  readonly nodeId?: string
  readonly steps: readonly unknown[]
  readonly imageBase64?: string
  readonly deviceKey?: string
  readonly plane?: string
}

interface FakeContextOpts {
  runPipelineImpl?: (input: RunPipelineCall) => Promise<{
    detections: readonly unknown[]
    debug?: { totalInferenceMs?: number }
  }>
  /** Extra `ctx.api` namespaces (the session replay's reads). */
  api?: Readonly<Record<string, unknown>>
  /** `false` boots the addon with no `ctx.records` (a kernel that predates records). */
  records?: boolean
}

interface FakeContext {
  ctx: AddonContext
  store: Record<string, unknown>
  runPipelineCalls: RunPipelineCall[]
  /** Messages passed to `ctx.logger.warn` — lets specs pin the durable-state fallback path. */
  warnings: string[]
  records: InMemoryRecords
}

function makeFakeContext(opts: FakeContextOpts = {}): FakeContext {
  const store: Record<string, unknown> = {}
  const warnings: string[] = []
  const runPipelineCalls: RunPipelineCall[] = []
  const records = makeInMemoryRecords('benchmark')

  const defaultRunPipeline = async (): Promise<{
    detections: readonly unknown[]
    debug?: { totalInferenceMs?: number }
  }> => ({ detections: [{ class: 'person', score: 0.9 }], debug: { totalInferenceMs: 10 } })

  const runPipeline = opts.runPipelineImpl ?? defaultRunPipeline

  const eventBus: IEventBus = {
    emit: () => {
      /* tests no longer assert bus events */
    },
    subscribe: () => () => {
      /* no-op */
    },
    getRecent: () => [],
  }

  const leaf = <T>(fn: (input: T) => Promise<unknown>) => ({
    query: (input: T) => fn(input),
    mutate: (input: T) => fn(input),
  })

  const ctx: AddonContext = {
    id: 'benchmark',
    ...(opts.records === false ? {} : { records: records.records }),
    addDisposer: () => () => {
      /* no-op */
    },
    logger: {
      debug: () => {
        /* silent */
      },
      info: () => {
        /* silent */
      },
      warn: (message: string) => {
        warnings.push(message)
      },
      error: () => {
        /* silent */
      },
      child: () => ctx.logger,
      withTags: () => ctx.logger,
    } as AddonContext['logger'],
    eventBus,
    dataDir: '/tmp/benchmark-test',
    nodeDataDir: '/tmp',
    addonConfig: {},
    api: {
      // Minimal in-memory `settingsStore` — only what `ReplayStore.declare`
      // needs at boot (`onInitialize` now declares `benchmark:replay-runs`
      // unconditionally, the same way every other declared collection in
      // this repo works). Not exercised by any of THIS file's assertions;
      // it exists so `bootBenchmark` doesn't throw on a capability the
      // addon now genuinely requires at init.
      settingsStore: (() => {
        const collections = new Map<string, Map<string, Record<string, unknown>>>()
        const table = (c: string): Map<string, Record<string, unknown>> => {
          let t = collections.get(c)
          if (t === undefined) {
            t = new Map()
            collections.set(c, t)
          }
          return t
        }
        return {
          declareCollection: leaf(async () => undefined),
          insert: leaf(
            async (input: {
              collection: string
              record: { id: string; data: Record<string, unknown> }
            }) => {
              table(input.collection).set(input.record.id, {
                id: input.record.id,
                ...input.record.data,
              })
            },
          ),
          query: leaf(async (input: { collection: string }) =>
            [...table(input.collection).values()].map((r) => ({ id: String(r['id']), data: r })),
          ),
          deleteWhere: leaf(async () => ({ deleted: 0 })),
        }
      })(),
      pipelineExecutor: {
        runPipeline: leaf(async (input: RunPipelineCall) => {
          runPipelineCalls.push(input)
          return runPipeline(input)
        }),
        validatePipeline: leaf(async () => ({
          ok: true,
          issues: [],
          substitutions: [],
          format: 'onnx',
        })),
      },
      ...opts.api,
    } as unknown as AddonContext['api'],
    settings: {
      readAddonStore: async () => ({ ...store }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      },
      readDeviceStoreBatch: async (ids: readonly number[]) => new Map(ids.map((id) => [id, {}])),
      listDeviceStoreIds: async () => [],
      readDeviceStore: async (_deviceId: number) => ({}),
      writeDeviceStore: async (_deviceId: number, _patch: Record<string, unknown>) => {
        /* no-op */
      },
      clearDeviceStore: async (_deviceId: number) => {
        /* no-op */
      },
      readDeviceRuntimeState: async (_deviceId: number) => ({}),
      writeDeviceRuntimeState: async (_deviceId: number, _data: Record<string, unknown>) => {
        /* no-op */
      },
      clearDeviceRuntimeState: async (_deviceId: number) => {
        /* no-op */
      },
      getSection: async (_section: string) => ({}),
      setSection: async (_section: string, _patch: Record<string, unknown>) => {
        /* no-op */
      },
    } satisfies AddonContext['settings'],
    kernel: {
      localNodeId: 'hub',
      capabilityRegistry: null,
    } as unknown as AddonContext['kernel'],
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      installPythonRequirements: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/benchmark-test/deps',
    },
    getNativeProvider: (): never => {
      throw new Error('not available in fake ctx')
    },
    fetchDevice: async (): Promise<never> => {
      throw new Error('not available in fake ctx')
    },
    useCapability: (): never => {
      throw new Error('not available in fake ctx')
    },
    acquireCapability: async (): Promise<never> => {
      throw new Error('not available in fake ctx')
    },
    onCapabilityStateChange: () => () => {
      /* no-op */
    },
  }

  return { ctx, store, runPipelineCalls, warnings, records }
}

async function bootBenchmark(opts: FakeContextOpts = {}): Promise<{
  addon: BenchmarkAddon
  fake: FakeContext
  // Typed handle on the internal actionHandlers map so tests can dispatch
  // actions through the exact surface the hub forwards from
  // `api.addons.custom.mutate`.
  invoke: <K extends keyof BenchmarkActionHandlers>(
    action: K,
    input: Parameters<BenchmarkActionHandlers[K]>[0],
  ) => ReturnType<BenchmarkActionHandlers[K]>
}> {
  const fake = makeFakeContext(opts)
  const addon = new BenchmarkAddon()
  const result = await addon.initialize(fake.ctx)
  if (!result || !('actionHandlers' in result) || !result.actionHandlers) {
    throw new Error('benchmark.initialize did not return actionHandlers')
  }
  const handlers = result.actionHandlers as unknown as BenchmarkActionHandlers
  const invoke = <K extends keyof BenchmarkActionHandlers>(
    action: K,
    input: Parameters<BenchmarkActionHandlers[K]>[0],
  ) => {
    // The generic K distributes `Parameters<...>` into a union; calling
    // `handlers[action](...)` at this site would have TS intersect the
    // argument shape, which never matches. Cast the handler to a
    // non-generic shape for the call — the public `invoke` signature
    // above keeps callers type-safe.
    const handler = handlers[action] as (input: unknown) => ReturnType<BenchmarkActionHandlers[K]>
    return handler(input)
  }
  return { addon, fake, invoke }
}

// Local mirror of the action-handler surface — the concrete types would
// require importing internal addon types, which aren't re-exported.
// These match the benchmark-actions.ts schemas.
interface BenchmarkActionHandlers {
  runPipelineTest: (input: {
    steps: readonly unknown[]
    imageBase64?: string
    referenceImage?: string
    nodeId?: string
    sessionId?: string
  }) => Promise<unknown>
}

// ── Tests: runPipelineTest ─────────────────────────────────────────────

describe('benchmark addon — runPipelineTest', () => {
  let addon: BenchmarkAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('calls pipelineExecutor.runPipeline with the provided steps', async () => {
    const {
      addon: a,
      invoke,
      fake,
    } = await bootBenchmark({
      runPipelineImpl: async () => ({
        detections: [{ class: 'car' }],
        debug: { totalInferenceMs: 42 },
      }),
    })
    addon = a

    const result = (await invoke('runPipelineTest', {
      steps: [
        {
          addonId: 'object-detection',
          modelId: 'yolov9s',
          enabled: true,
          children: [],
        },
      ],
      imageBase64: 'AAAA',
      nodeId: 'hub',
    })) as { detections: readonly unknown[]; debug?: { totalInferenceMs?: number } }

    expect(result.detections).toHaveLength(1)
    expect(fake.runPipelineCalls).toHaveLength(1)
    expect(fake.runPipelineCalls[0]!.steps).toHaveLength(1)
  })

  it('forwards nodeId IN THE BODY so the cap router routes to the target node', async () => {
    // ROUTING CONTRACT (do not "fix" by moving to nodePin): the generated
    // pipelineExecutor.runPipeline router is `.input(...runPipeline.input.loose())`
    // then `const { nodeId, ...methodInput } = input` → resolveProvider(..., nodeId).
    // It routes per-node by reading nodeId FROM THE BODY (loose() lets the extra
    // field through); it does NOT read an out-of-band nodePin. Live-verified: a
    // runPipeline with nodeId:'agent-a' in the body executes on the agent.
    // Stripping nodeId here makes every benchmark run hub-local.
    const { addon: a, invoke, fake } = await bootBenchmark()
    addon = a
    await invoke('runPipelineTest', {
      steps: [{ addonId: 'object-detection', modelId: 'yolov9s', enabled: true, children: [] }],
      imageBase64: 'AAAA',
      nodeId: 'agent-a',
    })
    expect((fake.runPipelineCalls[0] as { nodeId?: string }).nodeId).toBe('agent-a')
  })

  /**
   * The bench must be able to name the SAME `(node, deviceKey)` the pipeline
   * dispatches on. Before this, `PipelineRunInputSchema` had a node and an
   * engine triple and no `deviceKey` at all — so a node hosting
   * `edgetpu:usb` and `openvino:npu` was one dropdown where the system has
   * three coordinates, and the tab could not name either accelerator.
   *
   * Asserted on the object the FAKE RECEIVED, not on the input handed to
   * the action: deleting the schema field alone must not leave this green.
   */
  it('forwards deviceKey to pipelineExecutor.runPipeline', async () => {
    const { addon: a, invoke, fake } = await bootBenchmark()
    addon = a
    await invoke(
      'runPipelineTest',
      parseRunInput({
        steps: [{ addonId: 'object-detection', modelId: 'yolov9s', enabled: true, children: [] }],
        imageBase64: 'AAAA',
        nodeId: 'hub',
        deviceKey: 'edgetpu:usb',
      }),
    )
    expect(fake.runPipelineCalls[0]!.deviceKey).toBe('edgetpu:usb')
  })

  it('forwards the execution plane to pipelineExecutor.runPipeline', async () => {
    const { addon: a, invoke, fake } = await bootBenchmark()
    addon = a
    await invoke(
      'runPipelineTest',
      parseRunInput({
        steps: [{ addonId: 'object-detection', modelId: 'yolov9s', enabled: true, children: [] }],
        imageBase64: 'AAAA',
        nodeId: 'hub',
        plane: 'frame',
      }),
    )
    expect(fake.runPipelineCalls[0]!.plane).toBe('frame')
  })

  /**
   * `deviceKey` omitted means "the node's default pool". Sending an explicit
   * `undefined` is NOT the same thing on a `.loose()` router input, so the
   * key must be absent, not present-and-undefined.
   */
  it('omits deviceKey and plane when the operator picked neither', async () => {
    const { addon: a, invoke, fake } = await bootBenchmark()
    addon = a
    await invoke(
      'runPipelineTest',
      parseRunInput({
        steps: [{ addonId: 'object-detection', modelId: 'yolov9s', enabled: true, children: [] }],
        imageBase64: 'AAAA',
        nodeId: 'hub',
      }),
    )
    const received = fake.runPipelineCalls[0]!
    expect('deviceKey' in received).toBe(false)
    expect('plane' in received).toBe(false)
  })

  it('refuses steps=[] by name and runs nothing — there is no node-wide tree to fall back to', async () => {
    // A model is chosen by the accelerator that runs it (D927): the caller
    // names the steps (a camera's resolved tree or the builder's), and an
    // empty request is an error, never "whatever the node computes".
    const { addon: a, invoke, fake } = await bootBenchmark()
    addon = a

    await expect(
      invoke('runPipelineTest', {
        steps: [],
        imageBase64: 'AAAA',
        nodeId: 'hub',
      }),
    ).rejects.toThrow(/runPipelineTest needs the steps to run/)
    expect(fake.runPipelineCalls).toHaveLength(0)
  })

  it('forwards sessionId to the pipeline call so progress events can be filtered', async () => {
    const { addon: a, invoke, fake } = await bootBenchmark()
    addon = a
    await invoke('runPipelineTest', {
      steps: [
        {
          addonId: 'object-detection',
          modelId: 'yolov9s',
          enabled: true,
          children: [],
        },
      ],
      imageBase64: 'AAAA',
      nodeId: 'hub',
      sessionId: 'session-42',
    })
    expect((fake.runPipelineCalls[0]! as { sessionId?: string }).sessionId).toBe('session-42')
  })
})

// ── Tests: the catalog after D646 ──────────────────────────────────────

describe('benchmark addon — the catalog (D646)', () => {
  it('is exactly the surviving surface — no engine, sustained, decoder, batch, stress or clip upload', () => {
    // D791: the node benchmark is the orchestrator's; history and the
    // session replay are gone. One action is left — the Image run.
    expect(Object.keys(benchmarkActions)).toEqual(['runPipelineTest'])
  })

  it('runPipelineTest strips a smuggled `engine` before the executor sees it', async () => {
    const { addon, invoke, fake } = await bootBenchmark()
    try {
      await invoke(
        'runPipelineTest',
        parseRunInput({
          steps: [{ addonId: 'object-detection', modelId: 'yolov9s', enabled: true, children: [] }],
          imageBase64: 'AAAA',
          nodeId: 'hub',
          engine: { runtime: 'python', backend: 'openvino', format: 'openvino' },
        }),
      )
      expect('engine' in fake.runPipelineCalls[0]!).toBe(false)
    } finally {
      await addon.shutdown()
    }
  })

  it('declares the accuracy record kinds at boot, so a run and its samples can be written', async () => {
    const { addon, fake } = await bootBenchmark()
    try {
      const runs = fake.records.records.kind(benchmarkRecordKinds['eval-run'])
      const samples = fake.records.records.kind(benchmarkRecordKinds['eval-sample'])
      expect(await runs.get('missing')).toBeNull()
      expect(await samples.query({ where: { runId: 'missing' } })).toEqual({
        records: [],
        nextCursor: null,
      })
    } finally {
      await addon.shutdown()
    }
  })

  it('refuses to boot without ctx.records rather than run with nowhere to keep a run', async () => {
    const fake = makeFakeContext({ records: false })
    await expect(new BenchmarkAddon().initialize(fake.ctx)).rejects.toThrow(/ctx\.records/)
  })
})
