/**
 * The person detection floor.
 *
 * Raised from 0.50 to 0.65 on 2026-07-30 after a delivered notification turned
 * out to be a dead ornamental grass in a gravel bed, detected as `person` at
 * **0.5005** — the lowest score in the camera's whole 24-hour sample.
 *
 * Measured on device 101 over 24 h (161 person object-events):
 *   min 0.500 · p25 0.538 · median 0.641 · p75 0.801 · max 0.913
 *   ≥0.55 → 116 · ≥0.60 → 96 · ≥0.65 → 79 · ≥0.70 → 68
 *
 * Why raising the floor does not cost real detections: a genuine subject
 * produces at least one HIGH-confidence frame across its track, a phantom only
 * ever grazes the floor. Both ends were verified by looking at the stored
 * media, not assumed — the 0.855 track was a person walking a dog; the 0.5005
 * track was the plant.
 *
 * The default is enforced, not decorative: `tree-builder.collectSchemaDefaults`
 * hydrates every declared default into the runtime `settings`, and
 * `executor.macroFilterVerdict` compares each detection against
 * `minConfidence<Macro>`. A step whose settings omit the key would be
 * unfiltered, which is why the hydration exists.
 */

import { describe, expect, it } from 'vitest'
import { ALL_PIPELINE_STEPS } from '../registry/step-definitions.js'

interface SliderField {
  readonly key: string
  readonly type: string
  readonly default?: unknown
  readonly min?: number
  readonly max?: number
  readonly step?: number
}

function findSlider(key: string): SliderField {
  const step = ALL_PIPELINE_STEPS.find((s) => s.definition.id === 'object-detection')
  if (!step) throw new Error('object-detection step is not registered')
  const fields = step.getConfigSchema() as readonly SliderField[]
  const found = fields.find((f) => 'key' in f && f.key === key)
  if (!found) throw new Error(`no config field "${key}" on the object-detection step`)
  return found
}

describe('object-detection per-macro confidence floors', () => {
  it('drops person predictions below 0.65 by default', () => {
    expect(findSlider('minConfidencePerson').default).toBe(0.65)
  })

  it('leaves vehicle and animal at 0.5 — only person was measured and changed', () => {
    expect(findSlider('minConfidenceVehicle').default).toBe(0.5)
    expect(findSlider('minConfidenceAnimal').default).toBe(0.5)
  })

  it('keeps the floor operator-adjustable in both directions', () => {
    const person = findSlider('minConfidencePerson')
    expect(person.type).toBe('slider')
    expect(person.min).toBe(0)
    expect(person.max).toBe(1)
    // 0.65 must be reachable on the slider's own grid, or the UI cannot
    // represent the value the runtime is using.
    const step = person.step ?? 0
    expect(step).toBeGreaterThan(0)
    expect(Math.round(0.65 / step) * step).toBeCloseTo(0.65, 10)
  })

  it('would have rejected the observed phantom and kept the observed person', () => {
    const floor = findSlider('minConfidencePerson').default as number
    expect(0.5005).toBeLessThan(floor) // the dead plant
    expect(0.855).toBeGreaterThanOrEqual(floor) // the person with the dog
  })
})
