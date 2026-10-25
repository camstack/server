/**
 * D214 follow-up — `nmsIouThreshold` must be a LIVE knob.
 *
 * The defect these pin (audited 2026-08-21, D214): the object-detection slider
 * wrote `step.settings.nmsIouThreshold`, `PoolModelConfig` carried the field,
 * `serializeModelConfig` forwarded it and the Python decoders read it — but
 * NOTHING in between ever supplied a value. `PipelineModelManager` dropped
 * `step.settings` on the floor and `buildPoolConfig(stepId, modelId)` had no
 * channel for it, so the pool ran the 0.45 literal whatever the operator set.
 * The D62 class: a control that writes a store nobody reads.
 *
 * The chain pinned here is end to end on the TypeScript side:
 *   step.settings → PipelineModelManager → buildConfig → pool.loadModel(config)
 * and, for an ALREADY-loaded pair, the narrow reconfiguration:
 *   step.settings changed → pool.reconfigureModel(thatIndexOnly)
 *
 * Remove the threading (drop `settings` from the manager, or stop passing
 * `stepSettings` into `buildPoolModelConfigForStep`) and these go red.
 */
import { describe, expect, it, vi } from 'vitest'
import * as os from 'node:os'
import type {
  IScopedLogger,
  ModelCatalogEntry,
  PipelineDefaultStep,
  PoolModelConfig,
} from '@camstack/types'
import { PipelineModelManager, type PoolModelSource } from '../pipeline-model-manager.js'
import { SharedInferencePool } from '../shared-inference-pool.js'
import { buildPoolModelConfigForStep } from '../engine-factory.js'
import { resolvePoolDecodeSettings, NMS_IOU_DEFAULT } from '../pool-decode-settings.js'
import { getStepDefinition } from '../../registry/step-definitions.js'

interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly meta: Record<string, unknown>
}

function captureLogger(sink: LoggedLine[]): IScopedLogger {
  const record =
    (level: string) =>
    (message: string, opts?: { meta?: Record<string, unknown> }): void => {
      sink.push({ level, message, meta: opts?.meta ?? {} })
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

/** A flat-NMS YOLO-NAS export: NMS is fused into the graph, so the knob
 *  is declared inapplicable by `model-knob-applicability` and must be IGNORED
 *  at the pool too — never "applied" to a decode that cannot consult it. */
const FUSED_NMS_ENTRY: ModelCatalogEntry = {
  id: 'frigate-yolonas-s',
  name: 'plus catalog YOLO-NAS S',
  description: 'plus catalog style YOLO-NAS (fused NMS export)',
  formats: {
    onnx: {
      url: 'camstack-local://frigate-yolonas-s/frigate-yolonas-s.onnx',
      sizeMB: 49,
    },
  },
  inputSize: { width: 320, height: 320 },
  labels: ['person', 'car', 'dog'].map((id) => ({ id, name: id })),
  preprocessMode: 'letterbox',
  postprocessor: 'yolonas',
}

function step(settings: Readonly<Record<string, unknown>> | undefined): PipelineDefaultStep {
  return {
    addonId: 'object-detection',
    addonName: 'Object Detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: ['person'],
    enabled: true,
    modelId: 'yolo26n',
    children: [],
    ...(settings === undefined ? {} : { settings }),
  }
}

function fusedNmsStep(settings: Readonly<Record<string, unknown>>): PipelineDefaultStep {
  return { ...step(settings), modelId: FUSED_NMS_ENTRY.id }
}

const resolveCustomModel = (stepId: string, modelId: string): ModelCatalogEntry | undefined =>
  stepId === 'object-detection' && modelId === FUSED_NMS_ENTRY.id ? FUSED_NMS_ENTRY : undefined

/** The SAME wiring `EngineFactory.initPythonPool` builds, minus the pool spawn. */
function poolModelSource(): PoolModelSource {
  return {
    buildConfig: (stepId, modelId, settings) =>
      buildPoolModelConfigForStep({
        stepId,
        modelId,
        poolRuntime: 'onnxruntime',
        modelsDir: os.tmpdir(),
        stepSettings: settings,
        resolveCustomModel,
      }),
    resolveDecode: (stepId, modelId, settings) => {
      const def = getStepDefinition(stepId)
      const entry =
        def.models.find((m) => m.id === modelId) ?? resolveCustomModel(stepId, modelId) ?? null
      if (entry === null) return null
      return resolvePoolDecodeSettings({ def, modelEntry: entry, settings })
    },
  }
}

interface Harness {
  readonly manager: PipelineModelManager
  readonly loadModel: ReturnType<typeof vi.fn>
  readonly reconfigureModel: ReturnType<typeof vi.fn>
  readonly unloadModel: ReturnType<typeof vi.fn>
  readonly lines: readonly LoggedLine[]
}

function harness(): Harness {
  const lines: LoggedLine[] = []
  const log = captureLogger(lines)
  const pool = new SharedInferencePool('/nonexistent/python', 'onnxruntime', log)
  const loadModel = vi.fn(async () => ({ loadMs: 1 }))
  const reconfigureModel = vi.fn(async () => undefined)
  const unloadModel = vi.fn(async () => undefined)
  vi.spyOn(pool, 'loadModel').mockImplementation(loadModel)
  vi.spyOn(pool, 'reconfigureModel').mockImplementation(reconfigureModel)
  vi.spyOn(pool, 'unloadModel').mockImplementation(unloadModel)
  return {
    manager: new PipelineModelManager(pool, poolModelSource(), log),
    loadModel,
    reconfigureModel,
    unloadModel,
    lines,
  }
}

function loadedConfig(loadModel: Harness['loadModel'], call = 0): PoolModelConfig {
  const args = loadModel.mock.calls[call]
  if (!args) throw new Error(`loadModel was not called ${call + 1} time(s)`)
  const config = args[1]
  if (typeof config !== 'object' || config === null) throw new Error('no config argument')
  return config as PoolModelConfig
}

describe('the operator NMS slider reaches the inference pool', () => {
  it('sends the step setting in the load command, not the 0.45 literal', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.7 })])
    expect(h.loadModel).toHaveBeenCalledTimes(1)
    expect(loadedConfig(h.loadModel).nmsIouThreshold).toBe(0.7)
  })

  it('falls back to the historical literal when the step carries no setting', async () => {
    const h = harness()
    await h.manager.applyConfig([step(undefined)])
    expect(loadedConfig(h.loadModel).nmsIouThreshold).toBe(NMS_IOU_DEFAULT)
  })

  it('reaches the pool on the per-dispatch path too (loadAdditional)', async () => {
    const h = harness()
    await h.manager.loadAdditional([step({ nmsIouThreshold: 0.25 })])
    expect(loadedConfig(h.loadModel).nmsIouThreshold).toBe(0.25)
  })
})

describe('a changed threshold reconfigures ONLY that (step, model) pair', () => {
  it('reconfigures the loaded slot in place — no reload, no unload', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.7 })])
    const poolIndex = h.manager.getPoolIndex('object-detection', 'yolo26n')
    h.loadModel.mockClear()

    await h.manager.applyConfig([step({ nmsIouThreshold: 0.35 })])

    expect(h.reconfigureModel).toHaveBeenCalledTimes(1)
    expect(h.reconfigureModel).toHaveBeenCalledWith(poolIndex, {
      nmsIouThreshold: 0.35,
    })
    // The knob must NOT cost a model reload: `replace`/`load` re-instantiates
    // the session (~1.4s on coreml) and stalls every live camera on the node.
    expect(h.loadModel).not.toHaveBeenCalled()
    expect(h.unloadModel).not.toHaveBeenCalled()
  })

  it('leaves every other loaded pair untouched', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.7 })])
    await h.manager.loadAdditional([fusedNmsStep({ nmsIouThreshold: 0.7 })])
    const yoloIndex = h.manager.getPoolIndex('object-detection', 'yolo26n')

    await h.manager.loadAdditional([step({ nmsIouThreshold: 0.6 })])

    expect(h.reconfigureModel.mock.calls).toEqual([[yoloIndex, { nmsIouThreshold: 0.6 }]])
  })

  it('is idempotent — an unchanged threshold sends nothing', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.5 })])
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.5 })])
    await h.manager.loadAdditional([step({ nmsIouThreshold: 0.5 })])
    expect(h.reconfigureModel).not.toHaveBeenCalled()
  })

  it('says so in the log — a silent reconfiguration is an unanswerable question', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.7 })])
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.35 })])
    const line = h.lines.find((l) => l.meta['nmsIouThreshold'] === 0.35)
    expect(line).toBeDefined()
    expect(line?.meta['step']).toBe('object-detection')
    expect(line?.meta['modelId']).toBe('yolo26n')
  })

  it('needsPoolUpdate reports the pending change (the per-dispatch skip gate)', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.7 })])
    expect(h.manager.needsPoolUpdate(step({ nmsIouThreshold: 0.7 }))).toBe(false)
    expect(h.manager.needsPoolUpdate(step({ nmsIouThreshold: 0.35 }))).toBe(true)
  })
})

describe('a node-level slot cannot serve two disagreeing dispatches', () => {
  it('reports the flip-flop — one camera always decodes with the other’s value', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.7 })])
    // Camera B's per-camera override, then camera A's again.
    await h.manager.loadAdditional([step({ nmsIouThreshold: 0.3 })])
    await h.manager.loadAdditional([step({ nmsIouThreshold: 0.7 })])

    const warn = h.lines.find((l) => l.level === 'warn')
    expect(warn?.meta['step']).toBe('object-detection')
    expect(warn?.meta['valuesSeen']).toEqual([0.3, 0.7])
  })

  it('a one-way retune is not contention', async () => {
    const h = harness()
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.7 })])
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.6 })])
    await h.manager.applyConfig([step({ nmsIouThreshold: 0.5 })])
    expect(h.lines.filter((l) => l.level === 'warn')).toEqual([])
  })
})

describe('an inapplicable model ignores the knob without pretending', () => {
  it('a fused-NMS export loads with the default, whatever the slider says', async () => {
    const h = harness()
    await h.manager.applyConfig([fusedNmsStep({ nmsIouThreshold: 0.9 })])
    expect(loadedConfig(h.loadModel).nmsIouThreshold).toBe(NMS_IOU_DEFAULT)
  })

  it('and moving that slider never churns the pool', async () => {
    const h = harness()
    await h.manager.applyConfig([fusedNmsStep({ nmsIouThreshold: 0.9 })])
    await h.manager.applyConfig([fusedNmsStep({ nmsIouThreshold: 0.2 })])
    expect(h.reconfigureModel).not.toHaveBeenCalled()
  })
})

describe('buildConfig and resolveDecode never disagree', () => {
  it('the value recorded for the diff is the value that was loaded', () => {
    const source = poolModelSource()
    for (const settings of [
      undefined,
      { nmsIouThreshold: 0.7 },
      { nmsIouThreshold: 'nonsense' },
      { nmsIouThreshold: 3 },
    ]) {
      for (const modelId of ['yolo26n', FUSED_NMS_ENTRY.id]) {
        const built = source.buildConfig('object-detection', modelId, settings)
        const resolved = source.resolveDecode('object-detection', modelId, settings)
        expect(resolved).toEqual({ nmsIouThreshold: built.nmsIouThreshold })
      }
    }
  })
})
