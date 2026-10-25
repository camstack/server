/**
 * A live dispatch onto a Coral pool downloads and loads the co-compiled SET's
 * files for the models placed together on it, and a pool whose placement
 * grows into a set moves its resident models onto the set (D724).
 *
 * Without this, the root SSD and the plate detector each load their separately
 * compiled file: two cache tokens on one Coral, so every alternation flushes
 * the parameter cache and re-streams the incoming model (the root alone is
 * 6.39 MiB). Pinned on the REAL provider dispatch path
 * (`loadDispatchModels`), the real EngineFactory set selection, the real
 * pool-config builder and the real model manager; only the Python pool and
 * the download are stubbed.
 */
import type { IScopedLogger, ModelCatalogEntry, PipelineDefaultStep } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { EngineFactory } from '../engine/engine-factory.js'
import { PipelineModelManager } from '../engine/pipeline-model-manager.js'
import { SharedInferencePool } from '../engine/shared-inference-pool.js'
import { DetectionPipelineProvider } from '../provider.js'

interface Line {
  readonly level: string
  readonly message: string
  readonly tags: Record<string, unknown>
  readonly meta: Record<string, unknown>
}

function recordingLogger(sink: Line[]): IScopedLogger {
  const record =
    (level: string) =>
    (
      message: string,
      opts?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ): void => {
      sink.push({ level, message, tags: opts?.tags ?? {}, meta: opts?.meta ?? {} })
    }
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const SSD = 'ssd-mobilenet-v2-coco-edgetpu'
const PLATE = 'yolox-tiny-plate'
const MODELS = '/tmp/camstack-coral-set-test-models'

function step(
  addonId: string,
  modelId: string,
  children: PipelineDefaultStep[] = [],
): PipelineDefaultStep {
  return {
    addonId,
    addonName: addonId,
    slot: 'detector',
    inputClasses: [],
    outputClasses: [],
    enabled: true,
    modelId,
    children,
  }
}

function harness() {
  const lines: Line[] = []
  const log = recordingLogger(lines)
  const provider = new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    MODELS,
    log,
  )
  const engine = { runtime: 'python', backend: 'edgetpu', format: 'tflite', device: 'usb' } as const
  provider['currentEngine'] = engine
  const pool = new SharedInferencePool('/nonexistent/python', 'edgetpu', log, { device: 'usb' })
  const events: string[] = []
  const file = (p: string): string => p.replace(`${MODELS}/`, '')
  vi.spyOn(pool, 'loadModel').mockImplementation(async (index, config) => {
    events.push(`load ${index} ${file(config.path)}`)
    return { loadMs: 1 }
  })
  vi.spyOn(pool, 'unloadModel').mockImplementation(async (index) => {
    events.push(`unload ${index}`)
  })
  const factory = new EngineFactory({ engine, modelsDir: MODELS, logger: log, pythonPath: '' })
  factory['poolManager'] = new PipelineModelManager(
    pool,
    {
      buildConfig: (stepId, modelId, settings) =>
        factory['buildPoolModelConfig'](stepId, modelId, 'edgetpu', settings),
      resolveDecode: (stepId, modelId, settings) =>
        factory['resolveDecode'](stepId, modelId, settings),
    },
    log,
    { deviceKey: 'edgetpu:usb' },
  )
  const downloaded: string[] = []
  provider['downloadWithRetry'] = async (entry: ModelCatalogEntry) => {
    downloaded.push(file(`${MODELS}/${entry.formats.tflite?.url.split('/').pop() ?? ''}`))
  }
  const dispatch = (steps: readonly PipelineDefaultStep[]) =>
    provider['loadDispatchModels'](
      steps,
      factory,
      'tflite',
      { deviceId: 102, deviceKey: 'edgetpu:usb' },
      'partial',
    )
  return { provider, factory, events, downloaded, lines, dispatch }
}

const SET_SSD = 'root-plate-bird__ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite'
const SET_PLATE = 'root-plate-bird__camstack-yolox-tiny-plate_int8_edgetpu.tflite'

describe('a Coral pool loads the co-compiled set of what is placed on it', () => {
  it('root + plate in one dispatch: both download and load from the set', async () => {
    const h = harness()
    expect(
      await h.dispatch([step('object-detection', SSD, [step('plate-detection', PLATE)])]),
    ).toEqual([])
    expect(h.downloaded).toEqual([SET_SSD, SET_PLATE])
    expect(h.events).toEqual([`load 0 ${SET_SSD}`, `load 1 ${SET_PLATE}`])
    const line = h.lines.find((l) => l.message.startsWith('Coral pool loads a co-compiled set'))
    expect(line?.tags).toEqual({ deviceId: 102 })
    expect(line?.meta).toMatchObject({
      deviceKey: 'edgetpu:usb',
      set: 'root-plate-bird',
      separatelyCompiled: [],
    })
  })

  it('the root alone keeps its own file; when the plate joins, the root moves onto the set', async () => {
    const h = harness()
    await h.dispatch([step('object-detection', SSD)])
    expect(h.events).toEqual(['load 0 ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite'])

    h.events.length = 0
    await h.dispatch([step('object-detection', SSD, [step('plate-detection', PLATE)])])
    // The new root slot is loaded before the old one goes; then the plate loads from the set.
    // (Index 2: the stubbed pool does not recycle index 0 on unload.)
    expect(h.events).toEqual([`load 1 ${SET_SSD}`, 'unload 0', `load 2 ${SET_PLATE}`])
    expect(h.factory.getStepVariant('object-detection', SSD).poolIndex).toBe(1)
    expect(
      h.lines.some((l) => l.message === 'Coral pool reloaded its resident models from the new set'),
    ).toBe(true)
  })

  it('root + face: no published set — separately compiled, and the swap is a WARN with the camera', async () => {
    const h = harness()
    await h.dispatch([step('object-detection', SSD, [step('face-detection', 'yunet-2023mar')])])
    expect(h.events).toEqual([
      'load 0 ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite',
      'load 1 camstack-yunet-2023mar_edgetpu.tflite',
    ])
    const warn = h.lines.find(
      (l) => l.level === 'warn' && l.message.startsWith('Coral pool has no co-compiled set'),
    )
    expect(warn?.tags).toEqual({ deviceId: 102 })
  })
})
