/**
 * D738 — a model-bound setting (the per-class confidence floors) is stored
 * together with the model it was set for, and applies only while that model
 * runs. A model change makes it inapplicable WITHOUT a write: the effective
 * value falls back to the running model's default, then to the field's global
 * default.
 */
import { describe, expect, it } from 'vitest'
import {
  applyModelBoundSettings,
  clearModelBoundOverrides,
  clearModelBoundSetting,
  collectModelBoundKeys,
  hasModelBoundOverrides,
  modelBindingKey,
  resolveModelBoundSetting,
  writeModelBoundSetting,
} from '../model-bound-settings.js'

const KEY = 'minConfidencePerson'
const BINDING = modelBindingKey(KEY)
const V9 = 'yolov9m-320-int8'
const Y26 = 'yolo26s-320-int8'

describe('resolveModelBoundSetting — the effective value of one model-bound field', () => {
  it('nothing stored: the running model default', () => {
    expect(resolveModelBoundSetting({}, KEY, Y26, 0.45, 0.65)).toEqual({
      value: 0.45,
      source: 'model-default',
    })
  })

  it('nothing stored, a model without its own default: the global default', () => {
    expect(
      resolveModelBoundSetting(undefined, KEY, 'my-plus-catalog-plus', undefined, 0.65),
    ).toEqual({
      value: 0.65,
      source: 'global-default',
    })
  })

  it('an override made for the running model applies', () => {
    const settings = { [KEY]: 0.4, [BINDING]: V9 }
    expect(resolveModelBoundSetting(settings, KEY, V9, 0.65, 0.65)).toEqual({
      value: 0.4,
      source: 'override',
      boundModelId: V9,
    })
  })

  it('after a model change the override is inapplicable: the NEW model default applies', () => {
    const settings = { [KEY]: 0.4, [BINDING]: V9 }
    expect(resolveModelBoundSetting(settings, KEY, Y26, 0.45, 0.65)).toEqual({
      value: 0.45,
      source: 'model-default',
      inapplicableOverride: { value: 0.4, modelId: V9 },
    })
  })

  it('after a change to a custom model with no defaults: the global default', () => {
    const settings = { [KEY]: 0.4, [BINDING]: V9 }
    expect(
      resolveModelBoundSetting(settings, KEY, 'my-plus-catalog-plus', undefined, 0.65),
    ).toEqual({
      value: 0.65,
      source: 'global-default',
      inapplicableOverride: { value: 0.4, modelId: V9 },
    })
  })

  it('a value stored before the binding existed (no model id) applies to whatever runs', () => {
    expect(resolveModelBoundSetting({ [KEY]: 0.3 }, KEY, Y26, 0.45, 0.65)).toEqual({
      value: 0.3,
      source: 'override',
    })
  })

  it('an unknown running model never matches a binding', () => {
    const settings = { [KEY]: 0.4, [BINDING]: V9 }
    expect(resolveModelBoundSetting(settings, KEY, undefined, undefined, 0.65).source).toBe(
      'global-default',
    )
  })
})

describe('applyModelBoundSettings — the operator layer a runner merges over the defaults', () => {
  it('keeps an override for the running model and strips the binding key', () => {
    const out = applyModelBoundSettings({ [KEY]: 0.4, [BINDING]: V9, other: 1 }, [KEY], V9)
    expect(out).toEqual({ [KEY]: 0.4, other: 1 })
  })

  it('drops an override made for another model, so the default underneath wins', () => {
    const out = applyModelBoundSettings({ [KEY]: 0.4, [BINDING]: V9, other: 1 }, [KEY], Y26)
    expect(out).toEqual({ other: 1 })
  })

  it('keeps an unbound (legacy / programmatic) value', () => {
    expect(applyModelBoundSettings({ [KEY]: 0.55 }, [KEY], Y26)).toEqual({ [KEY]: 0.55 })
  })

  it('never mutates its input', () => {
    const input = Object.freeze({ [KEY]: 0.4, [BINDING]: V9 })
    applyModelBoundSettings(input, [KEY], Y26)
    expect(input).toEqual({ [KEY]: 0.4, [BINDING]: V9 })
  })

  it('undefined settings stay undefined', () => {
    expect(applyModelBoundSettings(undefined, [KEY], V9)).toBeUndefined()
  })
})

describe('write / clear — the editor side', () => {
  it('a write stores the value together with the model it was made for', () => {
    expect(writeModelBoundSetting({ other: 1 }, KEY, 0.5, Y26)).toEqual({
      other: 1,
      [KEY]: 0.5,
      [BINDING]: Y26,
    })
  })

  it('a reset removes the value and its binding', () => {
    expect(clearModelBoundSetting({ [KEY]: 0.5, [BINDING]: Y26, other: 1 }, KEY)).toEqual({
      other: 1,
    })
  })
})

describe('clearModelBoundOverrides — "Reset thresholds to model defaults"', () => {
  const VEHICLE = 'minConfidenceVehicle'

  it('clears every override in force for the model, in one result', () => {
    const settings = {
      [KEY]: 0.4,
      [BINDING]: V9,
      [VEHICLE]: 0.6,
      other: 1,
    }
    expect(clearModelBoundOverrides(settings, [KEY, VEHICLE], V9)).toEqual({ other: 1 })
  })

  it('keeps an override stored for another model (it comes back with that model)', () => {
    const settings = { [KEY]: 0.4, [BINDING]: Y26, other: 1 }
    expect(clearModelBoundOverrides(settings, [KEY], V9)).toEqual(settings)
  })

  it('reports whether there is anything to reset', () => {
    expect(hasModelBoundOverrides({ [KEY]: 0.4, [BINDING]: V9 }, [KEY], V9)).toBe(true)
    expect(hasModelBoundOverrides({ [KEY]: 0.4, [BINDING]: Y26 }, [KEY], V9)).toBe(false)
    expect(hasModelBoundOverrides(undefined, [KEY], V9)).toBe(false)
  })
})

describe('collectModelBoundKeys — one definition for the runner and Auto tune (D745)', () => {
  it('collects every bindsToModel key, groups flattened', () => {
    expect(
      collectModelBoundKeys([
        {
          key: 'minConfidencePerson',
          label: 'P',
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
          bindsToModel: true,
        },
        {
          key: 'fullFrameGuardHardAreaRatio',
          label: 'G',
          type: 'slider',
          min: 0,
          max: 1,
          step: 0.05,
        },
        {
          type: 'group',
          key: 'more',
          label: 'More',
          fields: [
            {
              key: 'minConfidenceAnimal',
              label: 'A',
              type: 'slider',
              min: 0,
              max: 1,
              step: 0.05,
              bindsToModel: true,
            },
          ],
        },
      ]),
    ).toEqual(['minConfidencePerson', 'minConfidenceAnimal'])
  })
})
