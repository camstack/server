/**
 * A replayed frame logs on its OWN channel (D646, fix round 1).
 *
 * A session replay runs the camera's own tree over stored pixels, under the
 * camera's deviceId. The phantom guard's drop log keeps a FIRST example per
 * `(device, class)` and counts the rest — so, sharing the key, a replay used
 * up the live camera's one example line and its lines read as live ones.
 * A replay samples under its own key and every line it writes says
 * `occasion: 'replay'`.
 */
import type {
  EngineOutput,
  IInferenceEngine,
  IScopedLogger,
  ModelCatalogEntry,
  PipelineRunOptions,
  StepDefinition,
} from '@camstack/types'
import { COCO_TO_MACRO } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import { PipelineExecutor } from '../executor.js'
import type { ExecutableTree } from '../tree-builder.js'

const SIDE = 200
const DEVICE = 101
const DROPPED = 'full-frame phantom guard: detection dropped'

interface LogLine {
  readonly message: string
  readonly tags: Record<string, unknown> | undefined
}

function capturingLogger(lines: LogLine[]): IScopedLogger {
  const record = (message: string, extras?: { tags?: Record<string, unknown> }): void => {
    lines.push({ message, tags: extras?.tags })
  }
  const logger: IScopedLogger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const model: ModelCatalogEntry = {
  id: 'stub',
  name: 'stub',
  description: '',
  formats: {},
  inputSize: { width: 64, height: 64 },
  labels: [],
}

const definition: StepDefinition = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['person', 'vehicle'],
  models: [model],
  defaultModelId: 'stub',
  defaultConfidence: 0.3,
  labels: [],
  classMap: COCO_TO_MACRO,
}

/** The cam-101 phantom: a low-score car box over the whole frame. */
const phantom: EngineOutput = {
  inferenceMs: 1,
  structured: {
    kind: 'detections',
    detections: [{ class: 'car', score: 0.55, bbox: [0, 0, SIDE, SIDE] }],
  },
}

function tree(): ExecutableTree {
  const engine: IInferenceEngine = {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (): Promise<EngineOutput> => phantom),
    dispose: async () => {},
  }
  return {
    roots: [
      {
        stepId: definition.id,
        definition,
        engine,
        modelId: 'stub',
        inputClasses: [],
        enabled: true,
        children: [],
        settings: {},
        effectiveClassMap: COCO_TO_MACRO,
      },
    ],
  }
}

async function frame(): Promise<Buffer> {
  return sharp({
    create: { width: SIDE, height: SIDE, channels: 3, background: { r: 9, g: 9, b: 9 } },
  })
    .jpeg()
    .toBuffer()
}

async function runOnce(executor: PipelineExecutor, opts: PipelineRunOptions): Promise<void> {
  const jpeg = await frame()
  const { result } = await executor.run(
    tree(),
    { kind: 'jpeg', data: jpeg },
    async () => jpeg,
    SIDE,
    SIDE,
    DEVICE,
    opts,
  )
  expect(result.discarded?.[0]?.reason).toBe('full-frame-guard')
}

describe('PipelineExecutor — replay logs on its own channel', () => {
  it('a replay does not use up the live example, and says it is a replay', async () => {
    const lines: LogLine[] = []
    const executor = new PipelineExecutor({
      engineRuntime: 'onnx+cpu',
      logger: capturingLogger(lines),
    })

    await runOnce(executor, { plane: 'frame', occasion: 'replay' })
    await runOnce(executor, { plane: 'frame', occasion: 'replay' })
    await runOnce(executor, { plane: 'frame' })

    const dropped = lines.filter((l) => l.message === DROPPED)
    expect(dropped.map((l) => l.tags)).toEqual([
      { deviceId: DEVICE, occasion: 'replay' },
      { deviceId: DEVICE },
    ])
  })

  it('a live example already logged does not silence the replay one', async () => {
    const lines: LogLine[] = []
    const executor = new PipelineExecutor({
      engineRuntime: 'onnx+cpu',
      logger: capturingLogger(lines),
    })

    await runOnce(executor, { plane: 'frame' })
    await runOnce(executor, { plane: 'frame', occasion: 'replay' })

    expect(lines.filter((l) => l.message === DROPPED).map((l) => l.tags?.['occasion'])).toEqual([
      undefined,
      'replay',
    ])
  })
})
