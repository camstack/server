/**
 * Task 2 — two heterogeneous roots must keep independent content-sized
 * geometries and re-project their view-space bboxes back to the same
 * source frame. A shared 640-square letterbox would make these boxes
 * disagree after inversion.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  EngineOutput,
  FrameViewGeometry,
  IInferenceEngine,
  InferenceInput,
  ModelCatalogEntry,
  StepDefinition,
} from '@camstack/types'
import { PipelineExecutor, type RootInputViewProvider } from '../executor.js'
import type { ExecutableStep, ExecutableTree } from '../tree-builder.js'

const SOURCE_WIDTH = 1920
const SOURCE_HEIGHT = 1080

function makeModel(id: string, size: number): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: '',
    formats: {},
    inputSize: { width: size, height: size },
    preprocessMode: 'letterbox',
    labels: [{ id: '0', name: 'person' }],
  }
}

function detectorDefinition(id: string, size: number): StepDefinition {
  return {
    id,
    name: id,
    slot: 'detector',
    postprocessor: 'yolo',
    extractMode: 'full-frame',
    inputClasses: null,
    outputClasses: ['person'],
    models: [makeModel(id, size)],
    defaultModelId: id,
    defaultConfidence: 0.1,
  }
}

function geometryFor(width: number, height: number): FrameViewGeometry {
  return {
    source: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
    sourceCrop: { left: 0, top: 0, width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
    output: { width, height },
    scale: { x: width / SOURCE_WIDTH, y: height / SOURCE_HEIGHT },
  }
}

function capturingEngine(bbox: readonly [number, number, number, number]): {
  engine: IInferenceEngine
  sizes: { width: number; height: number }[]
} {
  const sizes: { width: number; height: number }[] = []
  return {
    sizes,
    engine: {
      runtime: 'onnx',
      device: 'cpu',
      infer: vi.fn(async (input: InferenceInput): Promise<EngineOutput> => {
        if (input.kind === 'jpeg') sizes.push({ width: input.data.byteLength, height: 0 })
        return {
          inferenceMs: 1,
          structured: {
            kind: 'detections',
            detections: [{ class: 'person', score: 0.93, bbox }],
          },
        }
      }),
      dispose: async () => {},
    },
  }
}

function root(definition: StepDefinition, engine: IInferenceEngine): ExecutableStep {
  return {
    stepId: definition.id,
    definition,
    engine,
    modelId: definition.defaultModelId,
    inputClasses: [],
    enabled: true,
    children: [],
  }
}

describe('PipelineExecutor — multi-root view geometry', () => {
  it('reprojects independent 320 and 640 root bboxes into the same source box', async () => {
    const yolo320 = capturingEngine([80, 45, 160, 90])
    const yolo640 = capturingEngine([160, 90, 320, 180])
    const tree: ExecutableTree = {
      roots: [
        root(detectorDefinition('yolo-320', 320), yolo320.engine),
        root(detectorDefinition('yolo-640', 640), yolo640.engine),
      ],
    }
    const seen: { width: number; height: number }[] = []
    const rootInputViewProvider: RootInputViewProvider = async (step) => {
      const width = step.modelId === 'yolo-320' ? 320 : 640
      const height = step.modelId === 'yolo-320' ? 180 : 360
      seen.push({ width, height })
      return {
        input: { kind: 'jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
        jpegProvider: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        width,
        height,
        geometry: geometryFor(width, height),
      }
    }

    const { result } = await new PipelineExecutor({ engineRuntime: 'onnx+cpu' }).run(
      tree,
      { kind: 'jpeg', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) },
      async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      SOURCE_WIDTH,
      SOURCE_HEIGHT,
      1,
      { plane: 'frame' },
      undefined,
      undefined,
      rootInputViewProvider,
    )

    expect(seen).toEqual([
      { width: 320, height: 180 },
      { width: 640, height: 360 },
    ])
    expect(result.detections).toHaveLength(2)
    expect(yolo320.engine.infer).toHaveBeenCalledOnce()
    expect(yolo640.engine.infer).toHaveBeenCalledOnce()
    for (const det of result.detections) {
      expect(det.bbox).toEqual({ x: 480, y: 270, width: 480, height: 270 })
    }
  })
})
