import { describe, it, expect } from 'vitest'
import { resolvePoolConfidenceFloor, NMS_IOU_DEFAULT } from '../engine/engine-factory.js'

describe('resolvePoolConfidenceFloor (#4 confidence-floor foot-gun fix)', () => {
  it('drops the object-detection pool floor to 0.05 so per-macro sliders are authoritative', () => {
    // Historically this was def.defaultConfidence (0.5), which silently pre-empted
    // any per-macro minConfidence* slider set below 0.5.
    expect(resolvePoolConfidenceFloor('object-detection', 0.5)).toBe(0.05)
  })

  it('drops the package-detection pool floor too — it gained a per-macro slider', () => {
    // 2026-08-07: `package-detection` exposes `minConfidencePackage`. While its
    // pool floor stayed at defaultConfidence (0.5) every sub-0.5 position of
    // that slider was dead — the same foot-gun, on a brand-new control.
    expect(resolvePoolConfidenceFloor('package-detection', 0.5)).toBe(0.05)
  })

  it('leaves steps with no per-macro re-filter on their own defaultConfidence floor', () => {
    expect(resolvePoolConfidenceFloor('face-detection', 0.3)).toBe(0.3)
    expect(resolvePoolConfidenceFloor('animal-classifier', 0.2)).toBe(0.2)
    expect(resolvePoolConfidenceFloor('plate-detection', 0)).toBe(0)
  })

  it('NMS_IOU_DEFAULT matches the historical hardcoded literal (unset == today)', () => {
    expect(NMS_IOU_DEFAULT).toBe(0.45)
  })
})
