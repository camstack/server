/**
 * THE list of the three first-level macros lives in `@camstack/types`
 * (`FIRST_LEVEL_MACRO_CLASSES`, `types/labels.ts`) and has three consumers: the union
 * `FirstLevelMacro`, the recording trigger
 * (`RecordingTriggers.objectClasses`) and the OFFER of the `object-detection` step.
 *
 * The offer is still hand-written in `step-definitions.ts` — as of 2026-08-27
 * that file belongs to another session and must not be modified — so the
 * derivation the plan called for there is replaced by this GUARD: if
 * the offer and the list diverge, the operator's trigger and the detector
 * would offer two different vocabularies, which is exactly the mistake a
 * single list exists to prevent. Whoever touches one must touch the other, or
 * derive it (`options: FIRST_LEVEL_MACRO_CLASSES.map(…)`) and delete this
 * test.
 */
import { describe, expect, it } from 'vitest'
import { FIRST_LEVEL_MACRO_CLASSES } from '@camstack/types'
import { getStep } from '../detection-pipeline/registry/step-definitions.js'

const OBJECT_DETECTION_STEP_ID = 'object-detection'
const ENABLED_MACRO_CLASSES_KEY = 'enabledMacroClasses'

describe('the enabledMacroClasses offer does not diverge from FIRST_LEVEL_MACRO_CLASSES', () => {
  const raw = getStep(OBJECT_DETECTION_STEP_ID)
    .getConfigSchema()
    .find((f) => f.key === ENABLED_MACRO_CLASSES_KEY)
  if (raw === undefined || raw.type !== 'multiselect') {
    throw new Error(`${ENABLED_MACRO_CLASSES_KEY} multiselect missing`)
  }
  const field = raw

  it('the step offers exactly the first-level macros', () => {
    expect(field.options.map((o) => o.value)).toEqual([...FIRST_LEVEL_MACRO_CLASSES])
  })

  it('and enables them all by default', () => {
    expect(field.default).toEqual([...FIRST_LEVEL_MACRO_CLASSES])
  })
})
