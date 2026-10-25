import { describe, it, expect } from 'vitest'
import { getStep, getStepDefinition } from '../registry/step-definitions.js'

/**
 * Config plumbing for format-aware plate-OCR rescoring. Locks that the
 * plate-ocr step DEFINITION carries the DE/3/0 defaults forwarded to the Python
 * CTC postprocessor (engine-factory `buildPoolModelConfig` reads them off the
 * definition, exactly like `charset`), and — D62 — that the step's per-camera
 * config schema offers ONLY knobs the runtime actually reads per camera.
 */
describe('plate-ocr format-aware rescoring — config plumbing', () => {
  it('the plate-ocr step definition carries the rescoring + gate defaults', () => {
    const def = getStepDefinition('plate-ocr')
    expect(def.plateRegion).toBe('DE')
    expect(def.minTextLength).toBe(3)
    expect(def.minTextConfidence).toBe(0)
    // charset stays intact — rescoring rides alongside the existing decode config.
    expect(def.charset?.length).toBe(97)
  })

  /**
   * D62 — a per-camera switch that stores nothing is worse than no switch.
   * `plateRegion` / `minTextLength` / `minTextConfidence` are consumed INSIDE
   * the Python CTC postprocessor, whose config is bound when the model is
   * loaded into the shared pool: node-level by construction, exactly like
   * `nmsIouThreshold` and the pool confidence floor. Offering them per camera
   * wrote a settings row nobody read — the operator moved a slider and the
   * runtime kept using the step definition's static value.
   */
  it('offers no per-camera knob the runtime cannot honour', () => {
    const keys = getStep('plate-ocr')
      .getConfigSchema()
      .map((f) => f.key)
    expect(keys).toEqual(['rectify'])
  })

  it('keeps the rectify toggle — the one knob the executor reads per camera', () => {
    const schema = getStep('plate-ocr').getConfigSchema()
    const rectify = schema.find((f) => f.key === 'rectify')
    expect(rectify?.type).toBe('boolean')
    expect(rectify && 'default' in rectify ? rectify.default : undefined).toBe(true)
  })
})
