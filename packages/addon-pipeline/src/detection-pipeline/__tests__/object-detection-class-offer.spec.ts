/**
 * The ROOT detector must not OFFER a class a dedicated step owns.
 *
 * `object-detection` maps COCO into macro classes and, as an interim vector,
 * still routes suitcase/backpack/handbag → `package` (`COCO_TO_MACRO`). That
 * interim mapping leaked into the operator surface: `Enabled Classes` listed
 * **Package** beside Person/Vehicle/Animal, so the settings offered two ways to
 * ask for parcels — the COCO proxy on the root step and the real
 * `package-detection` step — that disagree about what a package is (a suitcase
 * is not a delivery) and about how enablement works (`package-detection` is
 * zone-driven, never a checkbox). An operator ticking the root box got the
 * proxy, silently, and the dedicated detector stayed off.
 *
 * The removal is on the OFFER, not on the model and not on the mapping: the
 * label map and `COCO_TO_MACRO` stay as they are, and the dedicated step is
 * untouched. This file pins both halves.
 */
import { describe, it, expect } from 'vitest'
import type { ConfigField, ConfigMultiSelectField } from '@camstack/types'

import { getStep } from '../registry/step-definitions.js'

const ROOT_STEP_ID = 'object-detection'
const PACKAGE_STEP_ID = 'package-detection'

function multiSelect(
  fields: readonly ConfigField[],
  key: string,
): ConfigMultiSelectField | undefined {
  return fields.find(
    (f): f is ConfigMultiSelectField => 'type' in f && f.type === 'multiselect' && f.key === key,
  )
}

describe('object-detection — the class offer', () => {
  const root = getStep(ROOT_STEP_ID)
  const schema = root.getConfigSchema()

  it('offers exactly the macro classes no dedicated step owns', () => {
    const field = multiSelect(schema, 'enabledMacroClasses')
    expect(field, 'expected an enabledMacroClasses multiselect').toBeDefined()
    // Derived, not spelled out: whatever the dedicated parcel detector declares
    // as its output is ITS class, and must not be re-offered here. Rename or
    // re-scope either side and this fails.
    const dedicated = new Set(getStep(PACKAGE_STEP_ID).definition.outputClasses)
    const offered = field!.options.map((o) => o.value)
    expect(offered.filter((v) => dedicated.has(v))).toEqual([])
    expect(offered).toEqual(['person', 'vehicle', 'animal'])
  })

  it('leaves no control gated on a class it no longer offers', () => {
    const offered = new Set(multiSelect(schema, 'enabledMacroClasses')!.options.map((o) => o.value))
    for (const field of schema) {
      const gate = 'showWhen' in field ? field.showWhen : undefined
      if (gate === undefined || gate.field !== 'enabledMacroClasses') continue
      const includes = 'includes' in gate ? gate.includes : undefined
      if (typeof includes !== 'string') continue
      expect(
        offered.has(includes),
        `${'key' in field ? field.key : '?'} gates on ${includes}`,
      ).toBe(true)
    }
  })

  it('the default selection is the whole offer', () => {
    const field = multiSelect(schema, 'enabledMacroClasses')!
    expect(field.default).toEqual(field.options.map((o) => o.value))
  })
})

describe('package-detection — untouched by the root offer change', () => {
  it('still owns `package` as its output class', () => {
    expect(getStep(PACKAGE_STEP_ID).definition.outputClasses).toEqual(['package'])
  })

  it('still exposes its own package confidence slider', () => {
    const keys = getStep(PACKAGE_STEP_ID)
      .getConfigSchema()
      .map((f) => ('key' in f ? f.key : ''))
    expect(keys).toContain('minConfidencePackage')
  })
})
