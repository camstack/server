/**
 * The dispatch path's model loads (D653 and its fix round 1).
 *
 * 2026-09-26, hub `openvino:gpu`: one GPU compile never returned. Every
 * dispatch needing that model lost its frame and not one rejection was logged;
 * the load gate was one node-wide promise, so the hung GPU compile also held
 * the NPU's loads. After the first fix, the opposite failure: `needsPoolUpdate`
 * stays true after a failure, so every FRAME re-issued the failing load and
 * wrote two ERRORs.
 *
 * Pinned here, against the real `PipelineModelManager` behind a stand-in
 * factory (the pool's `loadModel` is the only thing faked):
 *  - N dispatches after a failure make ONE load and ONE ERROR (negative cache);
 *  - every camera that lost a frame gets its own tagged line, once per state;
 *  - a load of a DIFFERENT model set is not handed another set's failure;
 *  - a hung load on one pool does not block another pool;
 *  - a model whose compile times out twice on a device is refused by name,
 *    and the device keeps serving every other model.
 */
import type { IScopedLogger, PipelineDefaultStep, PoolModelConfig } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineFactory } from '../engine/engine-factory.js'
import { MODEL_LOAD_BACKOFF_INITIAL_MS } from '../engine/model-load-governor.js'
import { PipelineModelManager, type PoolModelSource } from '../engine/pipeline-model-manager.js'
import { PoolModelLoadError, SharedInferencePool } from '../engine/shared-inference-pool.js'
import { DetectionPipelineProvider } from '../provider.js'

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown>
  readonly meta: Record<string, unknown>
}

function captureLogger(sink: LoggedLine[]): IScopedLogger {
  const record =
    (level: string) =>
    (
      message: string,
      opts?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
    ): void => {
      sink.push({ level, message, meta: opts?.meta ?? {}, tags: opts?.tags ?? {} })
    }
  const logger: IScopedLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function step(addonId: string, modelId: string): PipelineDefaultStep {
  return {
    addonId,
    addonName: addonId,
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['face'],
    enabled: true,
    modelId,
    children: [],
  }
}

const FACE = step('face-detection', 'yunet-2023mar')
const OBJECTS = step('object-detection', 'yolo26n')

const SOURCE: PoolModelSource = {
  buildConfig: (_stepId, modelId): PoolModelConfig => ({
    path: `/data/models/openvino/camstack-${modelId}.xml`,
    inputSize: 320,
    preprocessMode: 'letterbox',
    postprocessor: 'yolo',
    confidence: 0.5,
  }),
  resolveDecode: () => ({ nmsIouThreshold: 0.45 }),
}

type LoadBehaviour = (index: number, config: PoolModelConfig) => Promise<{ loadMs: number }>

interface Pool {
  readonly factory: EngineFactory
  readonly loadModel: ReturnType<typeof vi.fn>
  behave(fn: LoadBehaviour): void
}

/** A real model manager over a pool whose `loadModel` the test scripts. */
function makePool(log: IScopedLogger, deviceKey: string): Pool {
  const pool = new SharedInferencePool('/nonexistent/python', 'openvino', log, { device: 'gpu' })
  let behaviour: LoadBehaviour = async () => ({ loadMs: 1 })
  const loadModel = vi.fn((index: number, config: PoolModelConfig) => behaviour(index, config))
  vi.spyOn(pool, 'loadModel').mockImplementation(loadModel)
  const manager = new PipelineModelManager(pool, SOURCE, log, { deviceKey })
  const partial: Pick<EngineFactory, 'needsPoolUpdate' | 'loadAdditional'> = {
    needsPoolUpdate: (s) => manager.needsPoolUpdate(s),
    loadAdditional: (steps) => manager.loadAdditional(steps),
  }
  return {
    // A structural stand-in for the two members the gate uses — the test's
    // documented type boundary.
    factory: partial as EngineFactory,
    loadModel,
    behave: (fn) => {
      behaviour = fn
    },
  }
}

const compileTimeout = (): PoolModelLoadError =>
  new PoolModelLoadError(
    'Failed to load model at index 0: compile-timeout: did not return within 120000ms',
    'compile-timeout',
    'camstack-yunet-2023mar',
  )

function makeProvider(lines: LoggedLine[]): DetectionPipelineProvider {
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    captureLogger(lines),
  )
  // Nothing to download: this is about the LOAD, not the artifact.
  provider['resolveModelEntry'] = async () => undefined
  return provider
}

function dispatch(
  p: DetectionPipelineProvider,
  pool: Pool,
  steps: readonly PipelineDefaultStep[],
  deviceId: number,
  deviceKey = 'openvino:gpu',
): Promise<void> {
  return p['ensureModelsForSteps'](steps, pool.factory, 'openvino', { deviceId, deviceKey })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a failed load is not re-issued per frame (item 2)', () => {
  it('N dispatches after a failure make ONE load and ONE ERROR', async () => {
    vi.useFakeTimers()
    const lines: LoggedLine[] = []
    const p = makeProvider(lines)
    const gpu = makePool(captureLogger(lines), 'openvino:gpu')
    gpu.behave(async () => {
      throw new Error('Failed to load model at index 0: CL_OUT_OF_RESOURCES')
    })

    for (let frame = 0; frame < 20; frame++) {
      await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow()
    }
    expect(gpu.loadModel).toHaveBeenCalledTimes(1)
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(1)
    const perCamera = lines.filter((l) => l.message === 'model load for dispatch failed')
    expect(perCamera).toHaveLength(1)
    expect(perCamera[0]!.tags).toEqual({ deviceId: 101 })
    expect(perCamera[0]!.meta).toMatchObject({
      deviceKey: 'openvino:gpu',
      model: 'face-detection/yunet-2023mar',
    })
  })

  it('retries once the back-off has passed, and a success clears it', async () => {
    vi.useFakeTimers()
    const p = makeProvider([])
    const gpu = makePool(captureLogger([]), 'openvino:gpu')
    gpu.behave(async () => {
      throw new Error('transient')
    })
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow()
    gpu.behave(async () => ({ loadMs: 1 }))
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_BACKOFF_INITIAL_MS)
    await expect(dispatch(p, gpu, [FACE], 101)).resolves.toBeUndefined()
    expect(gpu.loadModel).toHaveBeenCalledTimes(2)
  })
})

describe('every camera that lost a frame is told, once per state (item 5)', () => {
  it('two cameras joining one failed load each get their own tagged line', async () => {
    const lines: LoggedLine[] = []
    const p = makeProvider(lines)
    const gpu = makePool(captureLogger(lines), 'openvino:gpu')
    let fail!: (err: Error) => void
    gpu.behave(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject
        }),
    )
    const a = dispatch(p, gpu, [FACE], 101)
    const b = dispatch(p, gpu, [FACE], 102)
    await vi.waitFor(() => expect(gpu.loadModel).toHaveBeenCalled())
    fail(new Error('boom'))
    await expect(a).rejects.toThrow()
    await expect(b).rejects.toThrow()

    expect(gpu.loadModel).toHaveBeenCalledTimes(1)
    const tags = lines
      .filter((l) => l.message === 'model load for dispatch failed')
      .map((l) => l.tags['deviceId'])
      .sort()
    expect(tags).toEqual([101, 102])
  })

  it("a dispatch needing a DIFFERENT model is not handed another model's failure", async () => {
    const lines: LoggedLine[] = []
    const p = makeProvider(lines)
    const gpu = makePool(captureLogger(lines), 'openvino:gpu')
    let fail!: (err: Error) => void
    gpu.behave((_index, config) =>
      config.path.includes('yunet')
        ? new Promise((_resolve, reject) => {
            fail = reject
          })
        : Promise.resolve({ loadMs: 1 }),
    )
    const a = dispatch(p, gpu, [FACE], 101)
    await vi.waitFor(() => expect(gpu.loadModel).toHaveBeenCalledTimes(1))
    const b = dispatch(p, gpu, [OBJECTS], 102)
    fail(new Error('yunet compile failed'))
    await expect(a).rejects.toThrow(/yunet/)
    // Camera 102 queued behind the failed load and then loaded its OWN model.
    await expect(b).resolves.toBeUndefined()
    expect(gpu.loadModel).toHaveBeenCalledTimes(2)
  })
})

describe('a load hung on one pool does not block another pool', () => {
  it('lets the NPU load while the GPU compile is still pending', async () => {
    const p = makeProvider([])
    const gpu = makePool(captureLogger([]), 'openvino:gpu')
    const npu = makePool(captureLogger([]), 'openvino:npu')
    let release!: () => void
    gpu.behave(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ loadMs: 1 })
        }),
    )
    const gpuLoad = dispatch(p, gpu, [FACE], 101)
    await vi.waitFor(() => expect(gpu.loadModel).toHaveBeenCalled())
    await expect(dispatch(p, npu, [FACE], 102, 'openvino:npu')).resolves.toBeUndefined()
    release()
    await gpuLoad
  })
})

describe('a compile that times out repeatedly refuses THAT MODEL, not the device (item 1c)', () => {
  it('refuses the model by name after the second timeout; the device keeps serving others', async () => {
    vi.useFakeTimers()
    const lines: LoggedLine[] = []
    const p = makeProvider(lines)
    const gpu = makePool(captureLogger(lines), 'openvino:gpu')
    gpu.behave((_index, config) =>
      config.path.includes('yunet')
        ? Promise.reject(compileTimeout())
        : Promise.resolve({ loadMs: 1 }),
    )

    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow(/compile-timeout/)
    await vi.advanceTimersByTimeAsync(MODEL_LOAD_BACKOFF_INITIAL_MS)
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow(/compile-timeout/)
    expect(
      lines.find(
        (l) => l.level === 'error' && l.message.startsWith('model REFUSED on this device'),
      ),
    ).toBeDefined()

    // Refused by name, with no further load issued — ever, not after a back-off.
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow(
      /face-detection\/yunet-2023mar is refused on openvino:gpu/,
    )
    expect(gpu.loadModel).toHaveBeenCalledTimes(2)

    // The DEVICE is not failed: it is not on the health channel, and another
    // model loads on it.
    expect((await p.getInferenceDeviceHealth()).unhealthy).toEqual([])
    await expect(dispatch(p, gpu, [OBJECTS], 102)).resolves.toBeUndefined()

    // The operator's re-arm clears the model refusal with the device.
    await expect(p.rearmInferenceDevice({ deviceKey: 'openvino:gpu' })).resolves.toEqual({
      rearmed: true,
    })
    gpu.behave(async () => ({ loadMs: 1 }))
    await expect(dispatch(p, gpu, [FACE], 101)).resolves.toBeUndefined()
  })

  it('an ordinary load failure never refuses the model', async () => {
    vi.useFakeTimers()
    const p = makeProvider([])
    const gpu = makePool(captureLogger([]), 'openvino:gpu')
    gpu.behave(async () => {
      throw new Error('CL_OUT_OF_RESOURCES')
    })
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow(/CL_OUT_OF_RESOURCES/)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    }
    expect(gpu.loadModel).toHaveBeenCalledTimes(4)
  })
})

describe('round 2 — the back-off and the queue', () => {
  it("a late compile lifts the pool's back-off at once, and says so", async () => {
    vi.useFakeTimers()
    const lines: LoggedLine[] = []
    const p = makeProvider(lines)
    const gpu = makePool(captureLogger(lines), 'openvino:gpu')
    gpu.behave(() => Promise.reject(compileTimeout()))
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow(/compile-timeout/)

    // The worker's `compile-finished-late`, as the pool hands it to its owner.
    p['noteLateCompile'](gpu.factory, 'openvino:gpu', { model: 'camstack-yunet-2023mar', ok: true })
    gpu.behave(async () => ({ loadMs: 3 }))
    // No time has passed: without the lift this dispatch would be backed off.
    await expect(dispatch(p, gpu, [FACE], 101)).resolves.toBeUndefined()
    expect(gpu.loadModel).toHaveBeenCalledTimes(2)
    expect(
      lines.filter((l) => l.message === 'model loadable again after late compile'),
    ).toHaveLength(1)
  })

  it('a set queued behind a failed load asks the back-off again before issuing', async () => {
    const lines: LoggedLine[] = []
    const p = makeProvider(lines)
    const gpu = makePool(captureLogger(lines), 'openvino:gpu')
    let fail!: (err: Error) => void
    gpu.behave((_index, config) =>
      config.path.includes('yunet')
        ? new Promise((_resolve, reject) => {
            fail = reject
          })
        : Promise.resolve({ loadMs: 1 }),
    )
    const a = dispatch(p, gpu, [FACE], 101)
    await vi.waitFor(() => expect(gpu.loadModel).toHaveBeenCalledTimes(1))
    // B needs FACE too, plus another model: a different set, so it queues.
    const b = dispatch(p, gpu, [FACE, OBJECTS], 102)
    fail(new Error('yunet compile failed'))
    await expect(a).rejects.toThrow(/yunet/)
    // FACE is now backed off: B is refused by name WITHOUT re-issuing it.
    await expect(b).rejects.toThrow(/face-detection\/yunet-2023mar failed to load/)
    expect(gpu.loadModel).toHaveBeenCalledTimes(1)
    expect(
      lines.find(
        (l) => l.message === 'model load for dispatch failed' && l.tags['deviceId'] === 102,
      ),
    ).toBeDefined()
  })
})

describe('round 3 — a late compile lifts only ITS model', () => {
  it('lifts the back-off of the model that finished, not of another failed model on the pool', async () => {
    vi.useFakeTimers()
    const p = makeProvider([])
    const gpu = makePool(captureLogger([]), 'openvino:gpu')
    gpu.behave((_index, config) =>
      Promise.reject(
        new PoolModelLoadError(
          'Failed to load model: compile-timeout',
          'compile-timeout',
          config.path.includes('yunet') ? 'camstack-yunet-2023mar' : 'camstack-yolo26n',
        ),
      ),
    )
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow()
    await expect(dispatch(p, gpu, [OBJECTS], 102)).rejects.toThrow()

    p['noteLateCompile'](gpu.factory, 'openvino:gpu', { model: 'camstack-yunet-2023mar', ok: true })
    gpu.behave(async () => ({ loadMs: 3 }))
    await expect(dispatch(p, gpu, [FACE], 101)).resolves.toBeUndefined()
    await expect(dispatch(p, gpu, [OBJECTS], 102)).rejects.toThrow(/not retried/)
    expect(gpu.loadModel).toHaveBeenCalledTimes(3)
  })
})

describe('release review — loads refused DURING a compile are lifted when it ends', () => {
  async function failBoth(): Promise<{ p: DetectionPipelineProvider; gpu: Pool }> {
    const p = makeProvider([])
    const gpu = makePool(captureLogger([]), 'openvino:gpu')
    gpu.behave((_index, config) =>
      Promise.reject(
        config.path.includes('yunet')
          ? compileTimeout()
          : new PoolModelLoadError(
              'Failed to load model: worker-poisoned: an earlier compile is still running',
              'worker-poisoned',
              'camstack-yolo26n',
            ),
      ),
    )
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow()
    await expect(dispatch(p, gpu, [OBJECTS], 102)).rejects.toThrow()
    gpu.behave(async () => ({ loadMs: 2 }))
    return { p, gpu }
  }

  it('a successful late compile lifts the compiling model AND the loads refused meanwhile', async () => {
    vi.useFakeTimers()
    const { p, gpu } = await failBoth()
    p['noteLateCompile'](gpu.factory, 'openvino:gpu', { model: 'camstack-yunet-2023mar', ok: true })
    await expect(dispatch(p, gpu, [OBJECTS], 102)).resolves.toBeUndefined()
    await expect(dispatch(p, gpu, [FACE], 101)).resolves.toBeUndefined()
  })

  it('a failed late compile still lifts the loads refused meanwhile, not its own', async () => {
    vi.useFakeTimers()
    const { p, gpu } = await failBoth()
    p['noteLateCompile'](gpu.factory, 'openvino:gpu', {
      model: 'camstack-yunet-2023mar',
      ok: false,
      error: 'CL_OUT_OF_RESOURCES',
    })
    await expect(dispatch(p, gpu, [OBJECTS], 102)).resolves.toBeUndefined()
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow(/not retried/)
  })
})
