/**
 * The caps a drafted composition may BUILD on a new device, with the fields
 * each one requires — read from the real capability definitions, so the prompt
 * can never name a field the validator would refuse.
 */
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import {
  describeTopLevelStateFields,
  requiredTopLevelKeys,
} from '../../composition/state-fields.js'
import type { CompositionTargetCap } from './draft-types.js'

/** The drafter builds the common derived readouts; the rest stays with the composer UI. */
export const COMPOSITION_TARGET_CAP_NAMES: readonly string[] = [
  'temperature-sensor',
  'humidity-sensor',
  'binary',
]

export function compositionTargetCaps(): readonly CompositionTargetCap[] {
  return COMPOSITION_TARGET_CAP_NAMES.flatMap((name) => {
    const def = ALL_CAPABILITY_DEFINITIONS.find((d) => d.name === name)
    if (def?.runtimeState === undefined) return []
    const fields = [...describeTopLevelStateFields(def.runtimeState).keys()]
    return [{ cap: name, required: requiredTopLevelKeys(def.runtimeState), fields }]
  })
}
