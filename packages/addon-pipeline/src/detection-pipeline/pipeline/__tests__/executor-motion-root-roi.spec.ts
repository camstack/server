/**
 * D1060 — the executor runs the object-detection root on the motion ROI the
 * provider decided, re-projects its boxes into frame space, and never lets the
 * motion ROI touch a `crop-zone` root (package detection keeps its zones).
 */

import type {
  EngineOutput,
  IInferenceEngine,
  ModelCatalogEntry,
  RootInputSource,
  StepDefinition,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { resolveFrameViewGeometry } from '../../../session-decode/frame-view-geometry.js'
import { resolveRootFrameViewSpec } from '../../root-frame-view.js'
import type { AbsoluteBbox } from '../crop-utils.js'
import { PipelineExecutor, type RootInputViewProvider } from '../executor.js'
import type { ExecutableStep, ExecutableTree } from '../tree-builder.js'

const W = 4256
const H = 1888
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

function model(id: string): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: '',
    formats: {},
    inputSize: { width: 640, height: 640 },
    preprocessMode: 'letterbox',
    labels: [{ id: '0', name: 'person' }],
  }
}

function definition(id: string, extractMode: StepDefinition['extractMode']): StepDefinition {
  return {
    id,
    name: id,
    slot: 'detector',
    postprocessor: 'yolo',
    extractMode,
    inputClasses: null,
    outputClasses: ['person'],
    models: [model(id)],
    defaultModelId: id,
    defaultConfidence: 0.1,
  }
}

function engine(bbox: readonly [number, number, number, number]): IInferenceEngine {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(
      async (): Promise<EngineOutput> => ({
        inferenceMs: 1,
        structured: { kind: 'detections', detections: [{ class: 'person', score: 0.9, bbox }] },
      }),
    ),
    dispose: async () => {},
  }
}

function step(def: StepDefinition, eng: IInferenceEngine): ExecutableStep {
  return {
    stepId: def.id,
    definition: def,
    engine: eng,
    modelId: def.defaultModelId,
    inputClasses: [],
    enabled: true,
    children: [],
  }
}

/**
 * A view provider that records the crop it was asked for and returns the
 * geometry the decode worker would: the provider's own spec derivation
 * (`resolveRootFrameViewSpec`) and the worker's geometry
 * (`resolveFrameViewGeometry`), so re-projection is checked against the real
 * view math, not a hand-made scale.
 */
function viewProvider(seen: Map<string, AbsoluteBbox | undefined>): RootInputViewProvider {
  return async (root, crop) => {
    seen.set(root.stepId, crop)
    const rootModel =
      root.definition.models.find((m) => m.id === root.modelId) ?? model(root.stepId)
    const spec = resolveRootFrameViewSpec(
      rootModel,
      { width: W, height: H },
      crop
        ? { left: crop[0], top: crop[1], width: crop[2] - crop[0], height: crop[3] - crop[1] }
        : undefined,
    )
    const geometry = resolveFrameViewGeometry(W, H, spec)
    return {
      input: { kind: 'jpeg', data: JPEG },
      jpegProvider: async () => JPEG,
      width: geometry.output.width,
      height: geometry.output.height,
      geometry,
    }
  }
}

const ROI: RootInputSource = {
  stepId: 'object-detection',
  source: 'roi',
  reason: 'motion',
  crop: { left: 1100, top: 0, width: 1920, height: 1888 },
}

async function run(
  tree: ExecutableTree,
  rootInputSource: RootInputSource | undefined,
  cropZone?: AbsoluteBbox,
): Promise<{ seen: Map<string, AbsoluteBbox | undefined>; boxes: { x: number; y: number }[] }> {
  const seen = new Map<string, AbsoluteBbox | undefined>()
  const { result } = await new PipelineExecutor({ engineRuntime: 'onnx+cpu' }).run(
    tree,
    { kind: 'jpeg', data: JPEG },
    async () => JPEG,
    W,
    H,
    1441,
    { plane: 'frame', ...(rootInputSource ? { rootInputSource } : {}) },
    undefined,
    cropZone,
    viewProvider(seen),
  )
  return { seen, boxes: result.detections.map((d) => ({ x: d.bbox.x, y: d.bbox.y })) }
}

describe('PipelineExecutor — motion-guided root crop (D1060)', () => {
  it('runs the object-detection root on the ROI and re-projects its boxes to the frame', async () => {
    // 1920x1888 crop letterboxed into 640 → a 640x629 view (x scale 1/3, y
    // scale 629/1888). View box (100, 200) → frame (1100+300, 0+~600.3).
    const tree: ExecutableTree = {
      roots: [step(definition('object-detection', 'full-frame'), engine([100, 200, 130, 300]))],
    }
    const { seen, boxes } = await run(tree, ROI)
    expect(seen.get('object-detection')).toEqual([1100, 0, 3020, 1888])
    expect(boxes[0]?.x).toBeCloseTo(1400, 5)
    expect(boxes[0]?.y).toBeCloseTo(200 / (629 / 1888), 5)
  })

  it('a full decision keeps the full frame', async () => {
    const tree: ExecutableTree = {
      roots: [step(definition('object-detection', 'full-frame'), engine([10, 10, 20, 20]))],
    }
    const { seen } = await run(tree, {
      stepId: 'object-detection',
      source: 'full',
      reason: 'forced-full',
    })
    expect(seen.get('object-detection')).toBeUndefined()
  })

  it('a crop-zone root keeps its package-zone crop; the motion ROI never applies to it', async () => {
    const zone: AbsoluteBbox = [10, 20, 650, 660]
    const tree: ExecutableTree = {
      roots: [
        step(definition('object-detection', 'full-frame'), engine([0, 0, 10, 10])),
        step(definition('package-detection', 'crop-zone'), engine([0, 0, 10, 10])),
      ],
    }
    // Even a decision naming the package root does not move it off its zones.
    const { seen } = await run(tree, { ...ROI, stepId: 'package-detection' }, zone)
    expect(seen.get('package-detection')).toEqual(zone)
    expect(seen.get('object-detection')).toBeUndefined()
  })

  it('without a decision every root behaves as before', async () => {
    const tree: ExecutableTree = {
      roots: [step(definition('object-detection', 'full-frame'), engine([0, 0, 10, 10]))],
    }
    const { seen } = await run(tree, undefined)
    expect(seen.get('object-detection')).toBeUndefined()
  })
})
