/**
 * Replay over stored media runs EXACTLY the model it was asked for, on the
 * pool it was asked for, or refuses (D56, D646).
 *
 * `runPipeline` substitutes silently for live traffic — a model with no build
 * for the node's format becomes that format's default, with an info line —
 * because a degraded detector beats no detector. For a replay that compares a
 * model against what the camera stored, the same substitution would report a
 * delta produced by a different encoder and say nothing about it.
 */
import type { PipelineDefaultStep, PipelineStepInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkReplayPin, resolveRootModelId } from '../model-pin.js'

function resolved(
  addonId: string,
  modelId: string,
  children: readonly PipelineDefaultStep[] = [],
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

const REQUESTED: readonly PipelineStepInput[] = [
  { addonId: 'object-detection', modelId: 'yolov9s-640', enabled: true },
]

describe('checkReplayPin', () => {
  it('passes when every executing step runs the requested model on the requested pool', () => {
    expect(
      checkReplayPin({
        requested: REQUESTED,
        executing: [resolved('object-detection', 'yolov9s-640')],
        requestedDeviceKey: 'openvino:npu',
        dispatchDeviceKey: 'openvino:npu',
        format: 'openvino',
      }),
    ).toEqual({ kind: 'pinned' })
  })

  it('refuses a substituted model, naming both the asked and the served model', () => {
    const verdict = checkReplayPin({
      requested: REQUESTED,
      executing: [resolved('object-detection', 'yolov8n-320')],
      requestedDeviceKey: undefined,
      dispatchDeviceKey: undefined,
      format: 'onnx',
    })
    expect(verdict.kind).toBe('refused')
    if (verdict.kind !== 'refused') return
    expect(verdict.reason).toBe('model-not-servable')
    expect(verdict.detail).toContain('yolov9s-640')
    expect(verdict.detail).toContain('yolov8n-320')
    expect(verdict.detail).toContain('onnx')
  })

  it('refuses a step that executes with no model pinned by the caller', () => {
    const verdict = checkReplayPin({
      requested: [{ addonId: 'object-detection', modelId: '', enabled: true }],
      executing: [resolved('object-detection', 'yolov8n-320')],
      requestedDeviceKey: undefined,
      dispatchDeviceKey: undefined,
      format: 'onnx',
    })
    expect(verdict).toMatchObject({ kind: 'refused', reason: 'model-not-servable' })
  })

  it('refuses when the capability gate moved the call off the requested device pool', () => {
    const verdict = checkReplayPin({
      requested: REQUESTED,
      executing: [resolved('object-detection', 'yolov9s-640')],
      requestedDeviceKey: 'edgetpu:usb',
      dispatchDeviceKey: undefined,
      format: 'onnx',
    })
    expect(verdict).toMatchObject({ kind: 'refused', reason: 'device-not-servable' })
    if (verdict.kind === 'refused') expect(verdict.detail).toContain('edgetpu:usb')
  })
})

describe('resolveRootModelId — the model a frame result is stamped with', () => {
  it('is the object-detection root when it runs', () => {
    expect(
      resolveRootModelId([
        resolved('package-detection', 'yolov8n-package'),
        resolved('object-detection', 'yolov9s-640'),
      ]),
    ).toBe('yolov9s-640')
  })

  it('falls back to the first enabled root when object-detection does not run', () => {
    expect(resolveRootModelId([resolved('package-detection', 'yolov8n-package')])).toBe(
      'yolov8n-package',
    )
  })

  it('is undefined when no root runs — never a fabricated id', () => {
    expect(resolveRootModelId([])).toBeUndefined()
  })
})
