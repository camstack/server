import { describe, expect, it } from 'vitest'
import {
  diffStepSettings,
  effectiveStepSettings,
  fieldsPinnedAtValueBelow,
  fieldUnitKeys,
  settingsBelow,
  stepSettingSource,
  withFieldFrom,
  withoutField,
} from '../step-settings-layers.js'

const BOUND = ['minConfidencePerson']

describe('step settings layers (D754)', () => {
  it('a model-bound field is one unit of two keys', () => {
    expect(fieldUnitKeys('minConfidencePerson', BOUND)).toEqual([
      'minConfidencePerson',
      'minConfidencePersonModelId',
    ])
    expect(fieldUnitKeys('nmsIouThreshold', BOUND)).toEqual(['nmsIouThreshold'])
  })

  it('merges node ⊕ camera — the only two layers (D927) — and says which supplies a field', () => {
    const layers = {
      node: { a: 1, b: 2, c: 3 },
      camera: { b: 20 },
    }
    expect(effectiveStepSettings(layers)).toEqual({ a: 1, b: 20, c: 3 })
    expect(stepSettingSource(layers, 'a', [])).toBe('node')
    expect(stepSettingSource(layers, 'b', [])).toBe('camera')
    expect(stepSettingSource(layers, 'd', [])).toBe('default')
    expect(settingsBelow(layers, 'camera')).toEqual({ a: 1, b: 2, c: 3 })
    expect(settingsBelow(layers, 'node')).toEqual({})
  })

  it('a binding key alone makes the layer the source of its field', () => {
    expect(
      stepSettingSource(
        { camera: { minConfidencePersonModelId: 'm' } },
        'minConfidencePerson',
        BOUND,
      ),
    ).toBe('camera')
  })

  it('writes and resets a model-bound field as a pair', () => {
    const next = { minConfidencePerson: 0.7, minConfidencePersonModelId: 'yolo', other: 1 }
    const written = withFieldFrom({ keep: true }, 'minConfidencePerson', next, BOUND)
    expect(written).toEqual({
      keep: true,
      minConfidencePerson: 0.7,
      minConfidencePersonModelId: 'yolo',
    })
    expect(withoutField(written, 'minConfidencePerson', BOUND)).toEqual({ keep: true })
  })

  it("a unit key the next bag lacks is removed (the slider's own reset)", () => {
    expect(
      withFieldFrom(
        { minConfidencePerson: 0.7, minConfidencePersonModelId: 'yolo' },
        'minConfidencePerson',
        {},
        BOUND,
      ),
    ).toEqual({})
  })

  it('stores a diff: a field equal to the layers below is not kept', () => {
    const below = {
      a: 1,
      minConfidencePerson: 0.65,
      minConfidencePersonModelId: 'yolo',
      list: ['x'],
    }
    expect(
      diffStepSettings(
        { a: 1, b: 2, minConfidencePerson: 0.65, minConfidencePersonModelId: 'yolo', list: ['x'] },
        below,
        BOUND,
      ),
    ).toEqual({ b: 2 })
    // Same value, different binding — the unit differs, and is kept whole.
    expect(
      diffStepSettings(
        { minConfidencePerson: 0.65, minConfidencePersonModelId: 'other' },
        below,
        BOUND,
      ),
    ).toEqual({ minConfidencePerson: 0.65, minConfidencePersonModelId: 'other' })
    expect(diffStepSettings({ a: 1 }, below, BOUND)).toBeUndefined()
    expect(diffStepSettings(undefined, below, BOUND)).toBeUndefined()
  })

  it('names the fields a legacy full copy pins at the value below', () => {
    const below = { a: 1, b: 2, list: ['x', 'y'] }
    expect(fieldsPinnedAtValueBelow({ b: 2, a: 1, list: ['x', 'y'], c: 9 }, below, [])).toEqual([
      'a',
      'b',
      'list',
    ])
    expect(fieldsPinnedAtValueBelow(undefined, below, [])).toEqual([])
  })
})
