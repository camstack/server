/**
 * A Coral pool loads ONE co-compiled set, chosen from the models placed on it
 * (D724).
 *
 * Separately compiled Edge TPU files carry different parameter-cache tokens:
 * two of them alternating on one Coral flush and re-stream the cache on every
 * switch (D710 measured 6.39 MiB for the root SSD alone). Models compiled
 * together share one token. Pinned here:
 *  1. the selection rules against the PUBLISHED sets — root + plate share a
 *     set, root + face deliberately has none (the face detector's activations
 *     would make the root stream on every frame), a second Coral without the
 *     root gets a rootless set;
 *  2. the planner reports a change only when the set (or what it leaves out)
 *     changes, and grows with the placement;
 *  3. the entry a pool loads points at the SET's file for a member, and at
 *     the model's own build otherwise — on the real EngineFactory, through
 *     the real pool-config builder;
 *  4. a pool that switches set reloads its resident slots from the new files,
 *     new slot loaded before the old one goes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger, PipelineDefaultStep, PoolModelConfig } from '@camstack/types'
import {
  CoralSetPlanner,
  placedModelsOf,
  selectCoCompiledSet,
  type PlacedModel,
} from '../coral-cocompiled-set.js'
import { EDGETPU_COCOMPILED_SETS } from '../../registry/edgetpu-cocompiled-sets.js'
import { EngineFactory, buildPoolModelConfigForStep } from '../engine-factory.js'
import { PipelineModelManager, type PoolModelSource } from '../pipeline-model-manager.js'
import { SharedInferencePool } from '../shared-inference-pool.js'
import { getStepDefinition } from '../../registry/step-definitions.js'

const ROOT: PlacedModel = { stepId: 'object-detection', modelId: 'ssd-mobilenet-v2-coco-edgetpu' }
const FACE: PlacedModel = { stepId: 'face-detection', modelId: 'yunet-2023mar' }
const PLATE: PlacedModel = { stepId: 'plate-detection', modelId: 'yolox-tiny-plate' }
const BIRD: PlacedModel = { stepId: 'bird-classifier', modelId: 'bird-classifier' }

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

function setOf(placed: readonly PlacedModel[]): string {
  const s = selectCoCompiledSet(placed, EDGETPU_COCOMPILED_SETS)
  return s.kind === 'set' ? s.set.id : `separate:${s.reason}`
}

describe('which published set a Coral pool loads', () => {
  it('one model alone keeps the whole cache — no set', () => {
    expect(setOf([ROOT])).toBe('separate:single-model')
    expect(setOf([FACE])).toBe('separate:single-model')
  })

  it('root + plate (+ bird) share the root set, the root first', () => {
    expect(setOf([ROOT, PLATE])).toBe('root-plate-bird')
    expect(setOf([ROOT, PLATE, BIRD])).toBe('root-plate-bird')
    expect(setOf([ROOT, BIRD])).toBe('root-plate-bird')
  })

  it('root + face has NO set: co-compiled, the root would stream 2.93 MiB on every frame', () => {
    expect(setOf([ROOT, FACE])).toBe('separate:no-set-covers-two')
  })

  it('root + face + plate: the root set, with the face detector left out (and named)', () => {
    const s = selectCoCompiledSet([ROOT, FACE, PLATE], EDGETPU_COCOMPILED_SETS)
    expect(s.kind).toBe('set')
    if (s.kind !== 'set') return
    expect(s.set.id).toBe('root-plate-bird')
    expect(s.uncovered).toEqual([FACE])
  })

  it('a Coral without the root never loads a set that reserves the root’s cache', () => {
    expect(setOf([FACE, PLATE, BIRD])).toBe('face-plate-bird')
    expect(setOf([FACE, PLATE])).toBe('face-plate-bird')
    // Both rootless sets cover these two; the one with no idle member wins.
    expect(setOf([PLATE, BIRD])).toBe('plate-bird')
  })
})

describe('the planner follows the placement', () => {
  it('reports a change only when the set changes, and grows with each dispatch', () => {
    const planner = new CoralSetPlanner(EDGETPU_COCOMPILED_SETS)
    expect(planner.note([ROOT]).kind).toBe('changed') // nothing-placed -> single-model
    expect(planner.note([ROOT]).kind).toBe('unchanged')
    const withPlate = planner.note([PLATE])
    expect(withPlate.kind).toBe('changed')
    if (withPlate.kind !== 'changed') return
    expect(withPlate.to.kind === 'set' && withPlate.to.set.id).toBe('root-plate-bird')
    expect(withPlate.placed).toEqual([ROOT, PLATE])
    // A later dispatch that carries only the root does not shrink the placement.
    expect(planner.note([ROOT]).kind).toBe('unchanged')
    expect(planner.selection().kind).toBe('set')
  })

  it('a placed model the set does not cover is a change too (it will swap)', () => {
    const planner = new CoralSetPlanner(EDGETPU_COCOMPILED_SETS)
    planner.note([ROOT, PLATE])
    expect(planner.note([FACE]).kind).toBe('changed')
  })

  it('reads the placement from a dispatch: enabled video steps only', () => {
    const step = (
      addonId: string,
      modelId: string,
      enabled: boolean,
      children: PipelineDefaultStep[] = [],
    ): PipelineDefaultStep => ({
      addonId,
      addonName: addonId,
      slot: 'detector',
      inputClasses: [],
      outputClasses: [],
      enabled,
      modelId,
      children,
    })
    const tree = [
      step(ROOT.stepId, ROOT.modelId, true, [
        step(PLATE.stepId, PLATE.modelId, true),
        step(FACE.stepId, FACE.modelId, false),
      ]),
    ]
    expect(placedModelsOf(tree)).toEqual([ROOT, PLATE])
  })
})

describe('the file a pool loads', () => {
  const plateEntry = getStepDefinition('plate-detection').models.find((m) => m.id === PLATE.modelId)

  it('the plate detector has its own Coral build to fall back to', () => {
    expect(plateEntry?.formats.tflite?.url).toMatch(/plateDetection\/yolox-tiny-plate\/tflite\//)
  })

  it('a Coral pool loads a member from the set, through the real config builder', () => {
    const factory = new EngineFactory({
      engine: { runtime: 'python', backend: 'edgetpu', format: 'tflite', device: 'usb' },
      modelsDir: '/models',
      pythonPath: '/nonexistent/python',
      logger: silent,
    })
    const config = (model: PlacedModel): PoolModelConfig =>
      buildPoolModelConfigForStep({
        stepId: model.stepId,
        modelId: model.modelId,
        poolRuntime: 'edgetpu',
        modelsDir: '/models',
        entryForPool: (sid, entry) => factory.entryForPool(sid, entry),
      })
    // Nothing placed yet: the model's own build.
    expect(config(PLATE).path).toBe('/models/camstack-yolox-tiny-plate_edgetpu.tflite')
    factory.notePlacement([ROOT, PLATE])
    expect(config(PLATE).path).toBe(
      '/models/root-plate-bird__camstack-yolox-tiny-plate_int8_edgetpu.tflite',
    )
    expect(config(ROOT).path).toBe(
      '/models/root-plate-bird__ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite',
    )
  })

  it('no other runtime ever places anything', () => {
    const factory = new EngineFactory({
      engine: { runtime: 'python', backend: 'openvino', format: 'openvino', device: 'gpu' },
      modelsDir: '/models',
      pythonPath: '/nonexistent/python',
      logger: silent,
    })
    expect(factory.notePlacement([ROOT, PLATE]).kind).toBe('unchanged')
    expect(factory.coralSetSelection()).toBeNull()
  })
})

describe('a set switch reloads the resident slots from the new files', () => {
  it('loads the new slot before unloading the old, and leaves unchanged files alone', async () => {
    const pool = new SharedInferencePool('/nonexistent/python', 'edgetpu', silent, {
      device: 'usb',
    })
    const calls: string[] = []
    vi.spyOn(pool, 'loadModel').mockImplementation(async (index, config) => {
      calls.push(`load ${index} ${config.path}`)
      return { loadMs: 1 }
    })
    vi.spyOn(pool, 'unloadModel').mockImplementation(async (index) => {
      calls.push(`unload ${index}`)
    })
    let plateFile = '/models/camstack-yolox-tiny-plate_edgetpu.tflite'
    const source: PoolModelSource = {
      buildConfig: (stepId): PoolModelConfig => ({
        path: stepId === PLATE.stepId ? plateFile : '/models/bird-classifier_edgetpu.tflite',
        inputSize: 640,
        preprocessMode: 'letterbox',
        postprocessor: 'yolo',
        confidence: 0.5,
      }),
      resolveDecode: () => ({ nmsIouThreshold: 0.45 }),
    }
    const manager = new PipelineModelManager(pool, source, silent, { deviceKey: 'edgetpu:usb' })
    const step = (model: PlacedModel): PipelineDefaultStep => ({
      addonId: model.stepId,
      addonName: model.stepId,
      slot: 'detector',
      inputClasses: [],
      outputClasses: [],
      enabled: true,
      modelId: model.modelId,
      children: [],
    })
    await manager.loadAdditional([step(PLATE), step(BIRD)])
    expect(await manager.reloadChangedPaths()).toEqual([])

    plateFile = '/models/root-plate-bird__camstack-yolox-tiny-plate_int8_edgetpu.tflite'
    calls.length = 0
    const reloaded = await manager.reloadChangedPaths()
    expect(reloaded).toEqual([{ stepId: PLATE.stepId, modelId: PLATE.modelId }])
    expect(calls).toEqual([`load 2 ${plateFile}`, 'unload 0'])
    expect(manager.getVariant(PLATE.stepId, PLATE.modelId).poolIndex).toBe(2)
    expect(manager.getVariant(BIRD.stepId, BIRD.modelId).poolIndex).toBe(1)
  })
})
