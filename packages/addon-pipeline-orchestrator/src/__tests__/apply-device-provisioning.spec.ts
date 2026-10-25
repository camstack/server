/**
 * Unit tests for the pure per-(node,device) provisioning stage — the seam the
 * dispatcher uses to attach modelId + settings onto the resolved (structure-
 * only) step tree from the per-(node,device) BASE and the camera's
 * settings-only layer. The model comes from the base alone (D927).
 */
import type { PipelineStepInputOutput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { applyDeviceProvisioning } from '../apply-device-provisioning.js'

const tree: readonly PipelineStepInputOutput[] = [
  {
    addonId: 'object-detection',
    enabled: true,
    children: [{ addonId: 'face-detection', enabled: true, children: [] }],
  },
]

describe('applyDeviceProvisioning', () => {
  it("the model is the base's, recursed; a camera layer adds settings only", () => {
    const out = applyDeviceProvisioning(
      tree,
      { 'object-detection': { modelId: 'base-od' }, 'face-detection': { modelId: 'base-fd' } },
      { 'object-detection': { settings: { enabledClasses: ['person'] } } },
    )
    expect(out[0]?.modelId).toBe('base-od')
    expect(out[0]?.settings).toEqual({ enabledClasses: ['person'] })
    expect(out[0]?.children?.[0]?.modelId).toBe('base-fd') // base (recursed)
  })

  it('carries jumpDeviceKey from the BASE onto the step (device-jump phase 1)', () => {
    const out = applyDeviceProvisioning(
      tree,
      { 'face-detection': { jumpDeviceKey: 'openvino:npu' } },
      {},
    )
    expect(out[0]?.children?.[0]?.jumpDeviceKey).toBe('openvino:npu')
  })

  it('merges settings (override keys over base keys)', () => {
    const out = applyDeviceProvisioning(
      tree,
      { 'object-detection': { settings: { conf: 0.3, iou: 0.5 } } },
      { 'object-detection': { settings: { conf: 0.6 } } },
    )
    expect(out[0]?.settings).toEqual({ conf: 0.6, iou: 0.5 })
  })

  it('no base/override ⇒ structurally identical (format-default path)', () => {
    const out = applyDeviceProvisioning(tree, {}, {})
    expect(out).toBe(tree)
  })

  it('never mutates the input tree (immutability)', () => {
    const snapshot = JSON.parse(JSON.stringify(tree))
    applyDeviceProvisioning(
      tree,
      { 'object-detection': { modelId: 'm', settings: { a: 1 } } },
      { 'face-detection': { settings: { b: 2 } } },
    )
    expect(tree).toEqual(snapshot)
  })
})
