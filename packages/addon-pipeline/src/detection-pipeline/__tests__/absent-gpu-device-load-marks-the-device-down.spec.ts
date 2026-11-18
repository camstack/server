/**
 * i7-8700K / UHD 630: the compute runtime no longer supports the iGPU, OpenVINO
 * enumerates no GPU, and the worker answers every GPU load with `no-gpu-device`.
 * That is a DEVICE fact, not a model that failed to compile: the device must be
 * published as down with that typed reason (the orchestrator then frees the CPU)
 * instead of retrying the load behind a backoff forever.
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

describe('a load answered `no-gpu-device`', () => {
  it('publishes the device as failed with its typed reason, and refuses further dispatch', async () => {
    vi.useFakeTimers()
    const lines: LoggedLine[] = []
    const p = makeProvider(lines)
    const gpu = makePool(captureLogger(lines), 'openvino:gpu')
    gpu.behave(async () => {
      throw new PoolModelLoadError(
        'Failed to load model at index 0: OpenVINO sees no supported GPU',
        'no-gpu-device',
        'camstack-yunet-2023mar',
      )
    })

    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow()

    const health = await p.getInferenceDeviceHealth()
    expect(health.unhealthy).toEqual([
      expect.objectContaining({
        deviceKey: 'openvino:gpu',
        state: 'failed',
        absentReason: 'no-gpu-device',
      }),
    ])
  })

  it('an ordinary load failure does NOT mark the device absent', async () => {
    vi.useFakeTimers()
    const p = makeProvider([])
    const gpu = makePool(captureLogger([]), 'openvino:gpu')
    gpu.behave(async () => {
      throw new Error('CL_OUT_OF_RESOURCES')
    })
    await expect(dispatch(p, gpu, [FACE], 101)).rejects.toThrow()
    const health = await p.getInferenceDeviceHealth()
    expect(health.unhealthy.filter((u) => u.absentReason !== undefined)).toEqual([])
  })
})
