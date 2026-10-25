/**
 * A node with exactly ONE eligible accelerator (a Mac's `coreml:all`, an N100
 * with only `openvino:gpu` on) is never given a `deviceKey`: the balancer
 * returns `single-eligible-device` and the runner's default pool serves the
 * camera — the default pool IS that device. Its provisioning must therefore be
 * that device's: the node-level model pin and the camera's override stored
 * under that deviceKey. Before D745 the attach read the provisioning of the
 * empty key `''`, which no store ever writes, so a model picked for the Mac's
 * only accelerator was silently never run.
 */
import type { PipelineSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type AttachPipelineOutcome, resolveAttachPipeline } from '../attach-pipeline.js'
import { CORAL_GPU_CATALOG, GPU, NODE, makeRealStore } from './attach-pipeline-fixtures.js'

const DEVICE_ID = 91

/** An openvino-default node whose detector catalog offers two openvino models. */
const GPU_ONLY_CATALOG: PipelineSchema = {
  ...CORAL_GPU_CATALOG,
  selectedEngine: { runtime: 'python', backend: 'openvino', format: 'openvino' },
  slots: CORAL_GPU_CATALOG.slots.map((slot) =>
    slot.id !== 'detector'
      ? slot
      : {
          ...slot,
          addons: slot.addons.map((addon) => ({
            ...addon,
            models: [
              ...addon.models,
              {
                id: 'yolov9m-640-int8',
                name: 'yolov9m-640-int8',
                formats: { openvino: { downloaded: true, sizeMB: 1 } },
              },
            ],
          })),
        },
  ),
}

function rootModel(outcome: AttachPipelineOutcome): string | undefined {
  if (outcome.kind !== 'resolved') throw new Error(`expected a pipeline, got ${outcome.kind}`)
  return outcome.pipeline.steps.find((s) => s.addonId === 'object-detection')?.modelId
}

describe('attach on a single-eligible-device node (default pool)', () => {
  it("runs the model pinned on the node's only device", async () => {
    const { store } = makeRealStore(GPU_ONLY_CATALOG)
    await store.writeAgentSettings(NODE, {
      maxCameras: null,
      inferenceDevices: {
        [GPU]: { enabled: true, steps: { 'object-detection': { modelId: 'yolov9m-640-int8' } } },
      },
    })

    const outcome = await resolveAttachPipeline(
      { deviceId: DEVICE_ID, nodeId: NODE, deviceKey: undefined, eligible: { [GPU]: 1 }, caps: {} },
      store,
    )

    expect(rootModel(outcome)).toBe('yolov9m-640-int8')
    // Still the default pool: no deviceKey is invented for the runner.
    if (outcome.kind === 'resolved') expect(outcome.pipeline.deviceKey).toBeUndefined()
  })

  it('with NO eligible device the default pool keeps the node-folded settings and no pin', async () => {
    const { store } = makeRealStore(GPU_ONLY_CATALOG)
    await store.writeAgentSettings(NODE, {
      maxCameras: null,
      inferenceDevices: {
        [GPU]: { enabled: false, steps: { 'object-detection': { modelId: 'yolov9m-640-int8' } } },
      },
    })

    const outcome = await resolveAttachPipeline(
      { deviceId: DEVICE_ID, nodeId: NODE, deviceKey: undefined, eligible: {}, caps: {} },
      store,
    )

    expect(rootModel(outcome)).not.toBe('yolov9m-640-int8')
  })
})
