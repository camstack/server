/**
 * Zone-driven activation of the toggle-less `package-detection` step
 * (`applyPackageZoneActivation`). The step runs for a device IFF it has a
 * package zone — no operator toggle. See
 * docs/superpowers/specs/2026-07-17-package-zones-design.md (ADDENDUM).
 */
import { describe, it, expect } from 'vitest'
import type { PipelineStepInputOutput } from '@camstack/types'
import { applyPackageZoneActivation, PACKAGE_DETECTION_STEP_ID } from '../pipeline-resolver.js'

const objectDetection: PipelineStepInputOutput = {
  addonId: 'object-detection',
  enabled: true,
  children: [],
}

function packageStep(overrides: Partial<PipelineStepInputOutput> = {}): PipelineStepInputOutput {
  return { addonId: PACKAGE_DETECTION_STEP_ID, enabled: true, children: [], ...overrides }
}

describe('applyPackageZoneActivation', () => {
  it('appends an enabled package-detection root when a zone exists and it is absent', () => {
    const out = applyPackageZoneActivation([objectDetection], true)
    expect(out).toHaveLength(2)
    const pkg = out.find((s) => s.addonId === PACKAGE_DETECTION_STEP_ID)
    expect(pkg).toEqual({ addonId: PACKAGE_DETECTION_STEP_ID, enabled: true, children: [] })
    // Existing steps untouched.
    expect(out[0]).toBe(objectDetection)
  })

  it('enables an existing (disabled) package-detection node, preserving its fields', () => {
    const disabled = packageStep({
      enabled: false,
      modelId: 'yolov8n-package',
      settings: { minConfidence: 0.6 },
    })
    const out = applyPackageZoneActivation([objectDetection, disabled], true)
    const pkg = out.find((s) => s.addonId === PACKAGE_DETECTION_STEP_ID)
    expect(pkg).toMatchObject({
      enabled: true,
      modelId: 'yolov8n-package',
      settings: { minConfidence: 0.6 },
    })
  })

  it('is a no-op (same reference) when the step is already present and enabled', () => {
    const steps = [objectDetection, packageStep()]
    expect(applyPackageZoneActivation(steps, true)).toBe(steps)
  })

  it('strips the package-detection step when no zone exists', () => {
    const out = applyPackageZoneActivation([objectDetection, packageStep()], false)
    expect(out).toEqual([objectDetection])
    expect(out.some((s) => s.addonId === PACKAGE_DETECTION_STEP_ID)).toBe(false)
  })

  it('does not add the step when no zone exists', () => {
    const steps = [objectDetection]
    expect(applyPackageZoneActivation(steps, false)).toBe(steps)
  })

  it('adds the step even when it is the only one (package-only camera)', () => {
    const out = applyPackageZoneActivation([], true)
    expect(out).toEqual([{ addonId: PACKAGE_DETECTION_STEP_ID, enabled: true, children: [] }])
  })
})
