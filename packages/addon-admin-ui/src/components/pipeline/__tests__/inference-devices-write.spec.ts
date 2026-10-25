/**
 * Regression guard for the `setAgentInferenceDevices` payload builder (2026-08-01).
 *
 * Both write surfaces (the placement board's `NodeInferenceDevices.commit` and
 * the per-node `NodeDeviceStepsMatrix.handleSave`) used to PRUNE disabled
 * devices from the wholesale write. The backend resolves an ABSENT key to its
 * policy default (`autoDefault`), which is ON for every non-CPU/non-Coral
 * accelerator — so "switch it off" wrote nothing, and nothing meant on: the
 * toggle read OFF while the device kept taking sessions (a mistakenly-enabled
 * Coral held camera 101 at 2.4fps for hours; every opt-OUT accelerator had the
 * same trap).
 *
 * The contract pinned here: EVERY device the operator can see is written with
 * its honest `enabled` bit — a disabled device appears as `enabled: false`.
 * Absence from the payload is reserved for hardware the surface was never shown
 * (never-configured), which must keep its policy default.
 */
import { describe, expect, it } from 'vitest'
import {
  buildInferenceDevicesWrite,
  effectiveStepSettingsForDevice,
  type InferenceDeviceWriteSource,
} from '../inference-devices-write'

function source(
  overrides: Partial<InferenceDeviceWriteSource> & { key: string },
): InferenceDeviceWriteSource {
  return {
    enabled: true,
    weight: 1,
    maxSessions: null,
    steps: {},
    ...overrides,
  }
}

describe('buildInferenceDevicesWrite — the wholesale setAgentInferenceDevices payload', () => {
  it('a DISABLED device is still in the payload, with enabled:false (never pruned)', () => {
    // THE 2026-08-01 bug: pruning this row made "off" unwritable — the store
    // held nothing, and the opt-OUT default silently re-enabled the device.
    const write = buildInferenceDevicesWrite([
      source({ key: 'openvino:gpu', enabled: false, weight: 50 }),
      source({ key: 'openvino:npu', enabled: true, weight: 50 }),
    ])
    expect(Object.keys(write).toSorted()).toEqual(['openvino:gpu', 'openvino:npu'])
    expect(write['openvino:gpu']).toMatchObject({ enabled: false })
    expect(write['openvino:npu']).toMatchObject({ enabled: true })
  })

  it('a disabled device keeps its weight, cap and steps (re-enabling restores them)', () => {
    const write = buildInferenceDevicesWrite([
      source({
        key: 'openvino:gpu',
        enabled: false,
        weight: 70,
        maxSessions: 3,
        steps: { 'object-detection': { modelId: 'yolov9m-320-int8' } },
      }),
    ])
    expect(write['openvino:gpu']).toEqual({
      enabled: false,
      weight: 70,
      maxSessions: 3,
      steps: { 'object-detection': { modelId: 'yolov9m-320-int8' } },
    })
  })

  it('emits ONLY the given keys — never invents an entry for unseen hardware', () => {
    // Absence is the one remaining way to say "never configured": a device
    // missing from the sources (new hardware plugged in later) must keep its
    // policy default, so the builder must not synthesize keys.
    const write = buildInferenceDevicesWrite([source({ key: 'cpu', enabled: false })])
    expect(Object.keys(write)).toEqual(['cpu'])
  })

  it('floors weight at 1 (backend requires strictly positive)', () => {
    const write = buildInferenceDevicesWrite([source({ key: 'openvino:npu', weight: 0 })])
    expect(write['openvino:npu']!.weight).toBe(1)
  })

  it('omits maxSessions unless a strictly positive cap is set, and steps unless non-empty', () => {
    const write = buildInferenceDevicesWrite([
      source({ key: 'openvino:npu', maxSessions: null, steps: {} }),
      source({ key: 'openvino:gpu', maxSessions: 0 }),
    ])
    expect(write['openvino:npu']).toEqual({ enabled: true, weight: 1 })
    expect(write['openvino:gpu']).toEqual({ enabled: true, weight: 1 })
  })
})

describe('effectiveStepSettingsForDevice — what the runtime builds (D927)', () => {
  const devices = [
    source({
      key: 'cpu',
      enabled: false,
      steps: { 'animal-classifier': { settings: { enabledClasses: ['cow'] } } },
    }),
    source({
      key: 'openvino:npu',
      steps: { 'object-detection': { settings: { minConfidencePerson: 0.7 } } },
    }),
  ]
  const node = { 'object-detection': { nmsIouThreshold: 0.5 } }

  it("node-wide settings under the device's own entry", () => {
    expect(
      effectiveStepSettingsForDevice(devices, 'openvino:npu', 'object-detection', node),
    ).toEqual({ nmsIouThreshold: 0.5, minConfidencePerson: 0.7 })
  })

  it('never reads a sibling entry — not even a disabled one that holds the only copy', () => {
    expect(
      effectiveStepSettingsForDevice(devices, 'openvino:npu', 'animal-classifier', node),
    ).toBeUndefined()
  })

  it('the step view (no device) shows the node layer alone', () => {
    expect(effectiveStepSettingsForDevice(devices, undefined, 'object-detection', node)).toEqual({
      nmsIouThreshold: 0.5,
    })
  })
})
