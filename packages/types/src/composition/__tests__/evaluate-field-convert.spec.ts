import { describe, expect, it } from 'vitest'
import type { CompositionFieldSource } from '../composition.js'
import { evaluateCompositionField } from '../evaluate-field.js'

const SRC = { addonId: 'provider-homeassistant', stableId: 'sensor.porch_temperature_f' }

function expr(text: string): CompositionFieldSource {
  return {
    kind: 'expression',
    expr: text,
    bindings: { t: { kind: 'from', source: SRC, cap: 'temperature-sensor', fieldPath: 'celsius' } },
  }
}

describe('convert() inside a composition (G3)', () => {
  it('converts between units of one dimension', () => {
    const out = evaluateCompositionField({
      source: expr('convert(t, "°F", "°C")'),
      read: () => ({ state: 'fresh', value: 68 }),
      now: 1_000,
    })
    expect(out.state).toBe('fresh')
    if (out.state === 'unavailable') throw new Error(out.reason)
    expect(out.value).toBeCloseTo(20, 10)
  })

  it('a cross-dimension pair makes the field unavailable, named, never a number', () => {
    const out = evaluateCompositionField({
      source: expr('convert(t, "°F", "m/s")'),
      read: () => ({ state: 'fresh', value: 68 }),
      now: 1_000,
    })
    expect(out.state).toBe('unavailable')
    expect(out.value).toBeNull()
    if (out.state !== 'unavailable') throw new Error('expected unavailable')
    expect(out.reason).toContain("cannot convert '°F' to 'm/s'")
  })

  it('accepts the spellings normalizeUnit knows (a hand-written "F" / "celsius")', () => {
    for (const [from, to] of [
      ['F', 'C'],
      ['fahrenheit', 'celsius'],
    ]) {
      const out = evaluateCompositionField({
        source: expr(`convert(t, "${from}", "${to}")`),
        read: () => ({ state: 'fresh', value: 68 }),
        now: 1_000,
      })
      if (out.state === 'unavailable') throw new Error(out.reason)
      expect(out.value).toBeCloseTo(20, 10)
    }
  })

  it('a refused pair in a loose spelling is still unavailable, named as written', () => {
    const out = evaluateCompositionField({
      source: expr('convert(t, "F", "m/s")'),
      read: () => ({ state: 'fresh', value: 68 }),
      now: 1_000,
    })
    if (out.state !== 'unavailable') throw new Error('expected unavailable')
    expect(out.value).toBeNull()
    expect(out.reason).toContain("cannot convert 'F' to 'm/s'")
  })
})
