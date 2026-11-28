/**
 * planning#720 — a device marked failed or absent is never used, for any step.
 *
 * A CPU-only node whose hardware probe still lists an Intel iGPU: the node
 * default engine was derived as `openvino:gpu`, the election (correctly) sent
 * the camera's frames to `cpu`, and one detail dispatch that carried no device
 * key landed on the default pool. Its load answered `no-gpu-device`, the
 * default device was marked failed — and from then on `runPipeline` refused
 * EVERY frame at the default-pool gate, the ones elected onto the healthy CPU
 * included (17 641 `runInference failed` in a day, 5 tracks from 98 sessions).
 *
 * Pinned here, against the real provider, catalog, resolution, liveness and
 * model manager; only the pools' `loadModel`, the download and the executor's
 * `run` are faked:
 *  - a frame elected onto a usable device is not gated on the default pool;
 *  - a default device that turns out absent is re-derived onto the next usable
 *    device of the node, the pool that device already runs is adopted (never a
 *    second pool on one device), and both lines name the camera;
 *  - with no usable device at all the camera says so once, not once per frame.
 */
import type {
  FrameResult,
  IScopedLogger,
  PipelineStepInput,
  PoolModelConfig,
} from '@dominevo/types'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineFactory } from '../engine/engine-factory.js'
import { PipelineModelManager, type PoolModelSource } from '../engine/pipeline-model-manager.js'
import { deviceKeyOf, resolveDeviceEngine } from '../engine/resolve-device-engine.js'
import { PoolModelLoadError, SharedInferencePool } from '../engine/shared-inference-pool.js'
import { PipelineExecutor } from '../pipeline/executor.js'
import { DetectionPipelineProvider } from '../provider.js'
import { getStepDefinition } from '../registry/step-definitions.js'
import { assumeKnownClusterRowIsDefaults } from './fixtures/known-cluster-row.js'

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

const SOURCE: PoolModelSource = {
  buildConfig: (_stepId, modelId): PoolModelConfig => ({
    path: `/models/${modelId}`,
    inputSize: 320,
    preprocessMode: 'letterbox',
    postprocessor: 'yolo',
    confidence: 0.5,
  }),
  resolveDecode: () => ({ nmsIouThreshold: 0.45 }),
}

interface Pool {
  readonly factory: EngineFactory
  readonly loaded: () => string[]
  readonly disposed: () => number
}

/** A real model manager over a pool whose `loadModel` the test scripts. */
function makePool(log: IScopedLogger, deviceKey: string, absent: boolean): Pool {
  const pool = new SharedInferencePool('/nonexistent/python', 'openvino', log, { device: 'gpu' })
  const loadModel = vi.fn(async (_index: number, config: PoolModelConfig) => {
    if (absent) {
      throw new PoolModelLoadError(
        'Failed to load model at index 0: no-gpu-device: OpenVINO sees no supported GPU',
        'no-gpu-device',
        config.path,
      )
    }
    return { loadMs: 1 }
  })
  vi.spyOn(pool, 'loadModel').mockImplementation(loadModel)
  const manager = new PipelineModelManager(pool, SOURCE, log, { deviceKey })
  let disposals = 0
  const partial: Pick<
    EngineFactory,
    | 'needsPoolUpdate'
    | 'loadAdditional'
    | 'getStepVariant'
    | 'notePlacement'
    | 'entryForPool'
    | 'isReady'
    | 'dispose'
  > = {
    needsPoolUpdate: (s) => manager.needsPoolUpdate(s),
    notePlacement: () => ({ kind: 'unchanged' }),
    entryForPool: (_stepId, entry) => entry,
    loadAdditional: (steps) => manager.loadAdditional(steps),
    getStepVariant: (stepId, modelId) => ({
      ...manager.getVariant(stepId, modelId),
      engine: {
        runtime: 'onnx',
        device: 'cpu',
        infer: async () => ({ inferenceMs: 1 }),
        dispose: async () => undefined,
      },
    }),
    isReady: () => true,
    dispose: async () => {
      disposals++
    },
  }
  return {
    // A structural stand-in for the members the dispatch uses — the test's
    // documented type boundary (as in jumped-steps-load-on-target).
    factory: partial as EngineFactory,
    loaded: () => loadModel.mock.calls.map((c) => c[1].path.replace('/models/', '')),
    disposed: () => disposals,
  }
}

interface Harness {
  readonly provider: DetectionPipelineProvider
  readonly lines: LoggedLine[]
  readonly gpu: Pool
  readonly cpu: Pool
}

/** A node whose default engine is `openvino:gpu`, with a healthy `cpu` pool beside it. */
function harness(candidates: readonly string[]): Harness {
  const lines: LoggedLine[] = []
  const log = captureLogger(lines)
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models-720',
    log,
  )
  const gpu = makePool(log, 'openvino:gpu', true)
  const cpu = makePool(log, 'cpu', false)
  provider['currentEngine'] = resolveDeviceEngine('openvino:gpu')
  provider['defaultDeviceCandidates'] = candidates
  provider['engineFactory'] = gpu.factory
  provider['factoriesByDevice'].set('cpu', cpu.factory)
  // No provisioning machine in a spec: nothing is installed or probed here.
  provider['startProvisioningForCurrentEngine'] = () => undefined
  provider['assertEngineReady'] = async () => undefined
  provider['ensureBackendDeps'] = async () => undefined
  provider['gateDetectionsByZoneRules'] = (_deviceId: number, result: FrameResult) => result
  provider['ensureDeviceProxy'] = async () => null
  provider['resolveModelEntry'] = async (addonId: string, modelId: string) =>
    getStepDefinition(addonId).models.find((m) => m.id === modelId)
  provider['downloadWithRetry'] = async () => undefined
  vi.spyOn(PipelineExecutor.prototype, 'run').mockImplementation(async () => {
    const result: FrameResult = {
      kind: 'frame',
      frameId: 'f',
      deviceId: 7,
      timestamp: 1,
      width: 16,
      height: 16,
      detections: [],
    }
    return { result, trace: null }
  })
  return { provider, lines, gpu, cpu }
}

async function tinyJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .jpeg()
    .toBuffer()
  return new Uint8Array(buf)
}

const RAW = {
  data: new Uint8Array(16 * 16 * 3),
  width: 16,
  height: 16,
  format: 'rgb' as const,
  timestamp: 1,
}
const ROOT: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', enabled: true, children: [] },
]
const FACE: readonly PipelineStepInput[] = [
  { addonId: 'face-detection', enabled: true, children: [] },
]

beforeEach(() => {
  assumeKnownClusterRowIsDefaults()
  vi.useRealTimers()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a failed default device', () => {
  it('does not gate a frame elected onto a usable device', async () => {
    // No other candidate is known, so the default STAYS the failed GPU.
    const h = harness([])
    h.provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')

    await expect(
      h.provider.runPipeline({
        steps: ROOT,
        image: await tinyJpeg(),
        deviceId: 7,
        deviceKey: 'cpu',
        plane: 'frame',
      }),
    ).resolves.toMatchObject({ kind: 'frame' })
    expect(h.cpu.loaded()).toHaveLength(1)
    expect(h.gpu.loaded()).toEqual([])
  })

  it('is re-derived onto the next usable device, which then serves the dispatch with no device key', async () => {
    const h = harness(['openvino:gpu', 'cpu'])
    const image = await tinyJpeg()
    const detail = (): Promise<FrameResult> =>
      h.provider.runPipeline({ steps: FACE, image, deviceId: 7, plane: 'full' })

    // The dispatch that discovers the device is absent loses its own work.
    await expect(detail()).rejects.toThrow(/no-gpu-device/)

    const absent = h.lines.filter((l) => l.message.startsWith('inference device ABSENT'))
    expect(absent).toHaveLength(1)
    expect(absent[0]!.tags).toEqual({ deviceId: 7 })
    const rederived = h.lines.filter((l) => l.message.startsWith('node-default inference device'))
    expect(rederived).toHaveLength(1)
    expect(rederived[0]!.tags).toEqual({ deviceId: 7 })
    expect(rederived[0]!.meta).toMatchObject({ from: 'openvino:gpu', to: 'cpu' })

    // The default IS the cpu now, served by the pool the cpu already had.
    expect(deviceKeyOf(h.provider['currentEngine'])).toBe(deviceKeyOf(resolveDeviceEngine('cpu')))
    expect(h.provider['engineFactory']).toBe(h.cpu.factory)
    expect(h.provider['factoriesByDevice'].has('cpu')).toBe(false)
    expect(h.gpu.disposed()).toBe(1)

    // The next dispatch with no device key runs — on the cpu, never the GPU.
    const gpuLoadsBefore = h.gpu.loaded().length
    await expect(detail()).resolves.toMatchObject({ kind: 'frame' })
    expect(h.cpu.loaded().length).toBeGreaterThan(0)
    expect(h.gpu.loaded()).toHaveLength(gpuLoadsBefore)
    // And a frame elected onto the cpu shares that pool.
    await expect(
      h.provider.runPipeline({ steps: ROOT, image, deviceId: 7, deviceKey: 'cpu', plane: 'frame' }),
    ).resolves.toMatchObject({ kind: 'frame' })
  })

  it('with no usable device at all, the camera says so once — not once per frame', async () => {
    const h = harness(['openvino:gpu'])
    h.provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')
    const frame = {
      data: new Uint8Array(16 * 16 * 3),
      width: 16,
      height: 16,
      format: 'rgb' as const,
      timestamp: 1,
    }
    for (let i = 0; i < 5; i++) {
      await expect(
        h.provider.runPipeline({ steps: ROOT, frame, deviceId: 7, plane: 'frame' }),
      ).rejects.toThrow(/inference device "openvino:gpu" is failed/)
    }
    const said = h.lines.filter((l) => l.message.startsWith('no usable inference device'))
    expect(said).toHaveLength(1)
    expect(said[0]!.tags).toEqual({ deviceId: 7 })
    expect(said[0]!.meta).toMatchObject({ deviceKey: 'openvino:gpu', state: 'failed' })
  })

  it('never moves onto an accelerator nobody enabled — a Coral beside a failed GPU', () => {
    const h = harness(['openvino:gpu', 'edgetpu:usb', 'cpu'])
    h.provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')
    h.provider['rederiveDefaultEngineIfFailed'](7)
    const rederived = h.lines.filter((l) => l.message.startsWith('node-default inference device'))
    expect(rederived).toHaveLength(1)
    expect(rederived[0]!.meta).toMatchObject({ from: 'openvino:gpu', to: 'cpu' })
    expect(deviceKeyOf(h.provider['currentEngine'])).toBe(deviceKeyOf(resolveDeviceEngine('cpu')))
  })

  it('moves onto an accelerator the orchestrator already routed a camera to', async () => {
    const h = harness(['openvino:gpu', 'edgetpu:usb', 'cpu'])
    const coral = makePool(captureLogger(h.lines), 'edgetpu:usb', false)
    h.provider['factoriesByDevice'].set('edgetpu:usb', coral.factory)
    // The live dispatch that names the Coral is the operator's opt-in.
    await h.provider
      .runPipeline({
        steps: ROOT,
        frame: RAW,
        deviceId: 7,
        deviceKey: 'edgetpu:usb',
        plane: 'frame',
      })
      .catch(() => undefined)
    h.provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')
    h.provider['rederiveDefaultEngineIfFailed'](7)
    expect(deviceKeyOf(h.provider['currentEngine'])).toBe(
      deviceKeyOf(resolveDeviceEngine('edgetpu:usb')),
    )
  })

  it('a benchmark that names a device is not an opt-in', async () => {
    const h = harness(['openvino:gpu', 'edgetpu:usb', 'cpu'])
    const coral = makePool(captureLogger(h.lines), 'edgetpu:usb', false)
    h.provider['factoriesByDevice'].set('edgetpu:usb', coral.factory)
    await h.provider
      .runPipeline({
        steps: ROOT,
        frame: RAW,
        deviceId: 7,
        deviceKey: 'edgetpu:usb',
        sessionId: 'bench-1',
        plane: 'frame',
      })
      .catch(() => undefined)
    h.provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')
    h.provider['rederiveDefaultEngineIfFailed'](7)
    expect(deviceKeyOf(h.provider['currentEngine'])).toBe(deviceKeyOf(resolveDeviceEngine('cpu')))
  })

  it('an operator-set default that fails is re-derived from a list read when it was set', async () => {
    // The auto derivation never ran: the list is empty, as on a node whose
    // default was only ever set by hand.
    const h = harness([])
    h.provider['currentEngine'] = resolveDeviceEngine('cpu')
    h.provider['ensureEngineFactory'] = async () => undefined
    await h.provider.spinEngine({ engine: resolveDeviceEngine('openvino:gpu') })
    expect(h.provider['defaultDeviceCandidates']).toContain('cpu')

    h.provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')
    h.provider['rederiveDefaultEngineIfFailed'](7)
    expect(deviceKeyOf(h.provider['currentEngine'])).toBe(deviceKeyOf(resolveDeviceEngine('cpu')))
  })

  it('moves back to the original default when it is re-armed, and says why', async () => {
    const h = harness(['openvino:gpu', 'cpu'])
    h.provider['deviceLiveness'].recordAbsent('openvino:gpu', 'no-gpu-device', 'no GPU')
    h.provider['rederiveDefaultEngineIfFailed'](7)
    expect(h.provider['engineFactory']).toBe(h.cpu.factory)

    await h.provider.rearmInferenceDevice({ deviceKey: 'openvino:gpu' })

    expect(deviceKeyOf(h.provider['currentEngine'])).toBe('openvino:gpu')
    const back = h.lines.filter((l) => l.message.startsWith('node-default inference device usable'))
    expect(back).toHaveLength(1)
    expect(back[0]!.meta).toMatchObject({ to: 'openvino:gpu', reason: 're-armed' })
    // The fallback pool keeps serving the cameras elected onto it: kept, not disposed.
    expect(h.provider['factoriesByDevice'].get('cpu')).toBe(h.cpu.factory)
    expect(h.cpu.disposed()).toBe(0)
    // And a second re-arm moves nothing.
    await h.provider.rearmInferenceDevice({ deviceKey: 'openvino:gpu' })
    expect(
      h.lines.filter((l) => l.message.startsWith('node-default inference device usable')),
    ).toHaveLength(1)
  })
})
