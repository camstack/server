/**
 * D1065 — the step switches, through the REAL settings store and the one
 * owner of an attach's steps (`resolveAttachPipeline`): what the writers store
 * is what the attach obeys, and the roster tells the runner which device
 * switched which step off.
 */
import type { PipelineSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  type AttachPipeline,
  type AttachPipelineOutcome,
  resolveAttachPipeline,
} from '../attach-pipeline.js'
import type { PipelineSettingsStore } from '../pipeline-settings-store.js'
import {
  CORAL,
  CORAL_GPU_CATALOG,
  CORAL_GPU_ELIGIBLE,
  GPU,
  NODE,
  makeRealStore,
  seedCoralGpuNode,
} from './attach-pipeline-fixtures.js'

const DEVICE_ID = 91

function attached(outcome: AttachPipelineOutcome): AttachPipeline {
  if (outcome.kind !== 'resolved') throw new Error(`expected a pipeline, got ${outcome.kind}`)
  return outcome.pipeline
}

async function attachOn(store: PipelineSettingsStore, deviceKey: string): Promise<AttachPipeline> {
  return attached(
    await resolveAttachPipeline(
      { deviceId: DEVICE_ID, nodeId: NODE, deviceKey, eligible: CORAL_GPU_ELIGIBLE, caps: {} },
      store,
    ),
  )
}

function childIds(p: AttachPipeline): readonly string[] {
  return (p.steps.find((s) => s.addonId === 'object-detection')?.children ?? []).map(
    (c) => c.addonId,
  )
}

describe('step switches through the attach path (D1065)', () => {
  it('cluster OFF beats the camera that turned the step on', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    await store.writeCameraSettings(DEVICE_ID, { stepToggles: { 'face-detection': true } })
    expect(childIds(await attachOn(store, GPU))).toContain('face-detection')

    await store.writeClusterStepMode('face-detection', 'off')
    expect(childIds(await attachOn(store, GPU))).not.toContain('face-detection')

    // `null` returns the step to its catalog default.
    await store.writeClusterStepMode('face-detection', null)
    expect(childIds(await attachOn(store, GPU))).toContain('face-detection')
  })

  it('opt-in: only a camera that turned it on runs it', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    await store.writeClusterStepMode('face-detection', 'opt-in')
    expect(childIds(await attachOn(store, GPU))).not.toContain('face-detection')

    await store.writeCameraSettings(DEVICE_ID, { stepToggles: { 'face-detection': true } })
    expect(childIds(await attachOn(store, GPU))).toContain('face-detection')
  })

  it('a node switch skips the step on that node', async () => {
    const { store, warns } = makeRealStore()
    await seedCoralGpuNode(store)
    await store.writeNodeStepEnabled(NODE, 'face-detection', false)
    expect(childIds(await attachOn(store, GPU))).not.toContain('face-detection')
    // Intent, not a fault: no format-skip warn.
    expect(warns().some((w) => w.includes('face-detection'))).toBe(false)
  })

  it('device switch: the roster names it, and with no allowed sibling the step is skipped', async () => {
    const { store } = makeRealStore()
    await seedCoralGpuNode(store)
    // The Coral has no face build — face rides the roster to the GPU…
    expect(childIds(await attachOn(store, CORAL))).toContain('face-detection')

    // …until the GPU switches it off: no device may run it.
    await store.writeDeviceStepEnabled({
      nodeId: NODE,
      deviceKey: GPU,
      stepId: 'face-detection',
      enabled: false,
      deviceEnabled: true,
    })
    const p = await attachOn(store, CORAL)
    expect(childIds(p)).not.toContain('face-detection')
    const gpu = (p.inferenceDevices ?? []).find((d) => d.deviceKey === GPU)
    expect(gpu?.disabledSteps).toEqual(['face-detection'])
    // The device's stored pin survives the switch, and `null` clears it again.
    const stored = (await store.readAgentSettingsMap())[NODE]?.inferenceDevices?.[GPU]
    expect(stored?.steps?.['face-detection']).toEqual({ modelId: 'scrfd-10g', enabled: false })
    await store.writeDeviceStepEnabled({
      nodeId: NODE,
      deviceKey: GPU,
      stepId: 'face-detection',
      enabled: null,
      deviceEnabled: true,
    })
    expect(childIds(await attachOn(store, CORAL))).toContain('face-detection')
  })
})

/**
 * No elected device: the runner's default pool serves the camera. The pool is
 * the node's eligible device(s), or — none eligible — any enabled device, so a
 * step switched off on EVERY one of them is skipped (D1065).
 */
describe('step switches on a default-pool attach (D1065)', () => {
  /** The node's default engine is openvino, so face-detection builds on the pool. */
  const OPENVINO_DEFAULT: PipelineSchema = {
    ...CORAL_GPU_CATALOG,
    selectedEngine: { runtime: 'python', backend: 'openvino', format: 'openvino' },
  }

  async function poolAttach(
    store: PipelineSettingsStore,
    eligible: Readonly<Record<string, number>>,
  ): Promise<AttachPipeline> {
    return attached(
      await resolveAttachPipeline(
        { deviceId: DEVICE_ID, nodeId: NODE, deviceKey: undefined, eligible, caps: {} },
        store,
      ),
    )
  }

  async function switchFaceOff(store: PipelineSettingsStore, deviceKey: string): Promise<void> {
    await store.writeDeviceStepEnabled({
      nodeId: NODE,
      deviceKey,
      stepId: 'face-detection',
      enabled: false,
      deviceEnabled: true,
    })
  }

  it('the one eligible device IS the pool: its switch skips the step', async () => {
    const { store } = makeRealStore(OPENVINO_DEFAULT)
    await seedCoralGpuNode(store)
    await store.writeCameraSettings(DEVICE_ID, { stepToggles: { 'face-detection': true } })
    expect(childIds(await poolAttach(store, { [GPU]: 1 }))).toContain('face-detection')

    await switchFaceOff(store, GPU)
    expect(childIds(await poolAttach(store, { [GPU]: 1 }))).not.toContain('face-detection')
  })

  it('none eligible: skipped only when every enabled device switched it off', async () => {
    const { store } = makeRealStore(OPENVINO_DEFAULT)
    await seedCoralGpuNode(store)
    await store.writeCameraSettings(DEVICE_ID, { stepToggles: { 'face-detection': true } })
    await switchFaceOff(store, GPU)
    // The Coral still allows it: the pool may be the Coral.
    expect(childIds(await poolAttach(store, {}))).toContain('face-detection')

    await switchFaceOff(store, CORAL)
    expect(childIds(await poolAttach(store, {}))).not.toContain('face-detection')
  })
})
