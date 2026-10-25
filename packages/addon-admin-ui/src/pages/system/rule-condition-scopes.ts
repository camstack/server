/**
 * Faces, zones and labels as ONE include-or-exclude field each (R8, D690) —
 * the control the object classes and the devices already use (D641):
 * "All | Only these | All except these" over one picker, never the two stored
 * lists side by side, and no "any of / all of".
 *
 * The rule keeps its wire keys:
 *
 * | axis | Only these | All except these |
 * | --- | --- | --- |
 * | zones | `zones.ids` | `zonesExclude` |
 * | identities | `identities` | `identitiesExclude` |
 * | labels | `labelEquals` | — (no exclusion exists) |
 *
 * The draft and its rules are `rule-scope-model.ts`'s. Two differences, both
 * in the WIRE, never in the model:
 *
 *  - `zones` is written with no quantifier. "All of" asked one detection to
 *    stand in every listed zone at once on an immediate rule; the editors no
 *    longer author it, and a stored `match` is not carried forward.
 *  - `identities` has a THIRD state: `[]` is "only known faces" (any identity
 *    in the gallery). "Only these" with nobody picked writes exactly that, so
 *    the empty include is kept where the model would drop it.
 *
 * Pure: the conditions in, new conditions out.
 */
import type { NcConditions } from '@camstack/types'
import {
  projectRuleScope,
  type RuleScopeDraft,
  ruleScopeDraftOf,
  ruleScopeLegacyExclusions,
} from './rule-scope-model'

/** The list conditions that edit as one scope field. */
export type ConditionScopeAxis = 'zones' | 'identities' | 'labels'

/** The draft a rule's conditions open as, for one axis. */
export function conditionScopeDraftOf(
  axis: ConditionScopeAxis,
  conditions: NcConditions,
): RuleScopeDraft<string> {
  switch (axis) {
    case 'zones':
      return ruleScopeDraftOf(conditions.zones?.ids, conditions.zonesExclude)
    case 'labels':
      return ruleScopeDraftOf(conditions.labelEquals, undefined)
    case 'identities':
      return identityDraftOf(conditions)
  }
}

/** PRESENT `identities` is Only — empty included (any known face). */
function identityDraftOf(conditions: NcConditions): RuleScopeDraft<string> {
  const include = conditions.identities
  const exclude = [...(conditions.identitiesExclude ?? [])]
  if (include === undefined) return ruleScopeDraftOf<string>(undefined, exclude)
  return { mode: 'only', include: [...include], exclude, legacyBoth: exclude.length > 0 }
}

/** The conditions with one axis replaced by what the draft writes. */
export function applyConditionScope(
  axis: ConditionScopeAxis,
  conditions: NcConditions,
  draft: RuleScopeDraft<string>,
): NcConditions {
  switch (axis) {
    case 'zones':
      return applyZones(conditions, draft)
    case 'labels':
      return applyLabels(conditions, draft)
    case 'identities':
      return applyIdentities(conditions, draft)
  }
}

function applyZones(conditions: NcConditions, draft: RuleScopeDraft<string>): NcConditions {
  const { zones: _zones, zonesExclude: _zonesExclude, ...rest } = conditions
  const saved = projectRuleScope(draft)
  return {
    ...rest,
    ...(saved.include !== undefined ? { zones: { ids: [...saved.include] } } : {}),
    ...(saved.exclude !== undefined ? { zonesExclude: [...saved.exclude] } : {}),
  }
}

function applyLabels(conditions: NcConditions, draft: RuleScopeDraft<string>): NcConditions {
  const { labelEquals: _labelEquals, ...rest } = conditions
  const saved = projectRuleScope(draft)
  return { ...rest, ...(saved.include !== undefined ? { labelEquals: [...saved.include] } : {}) }
}

function applyIdentities(conditions: NcConditions, draft: RuleScopeDraft<string>): NcConditions {
  const { identities: _identities, identitiesExclude: _identitiesExclude, ...rest } = conditions
  if (draft.mode === 'only') {
    const legacy = ruleScopeLegacyExclusions(draft)
    return {
      ...rest,
      identities: [...draft.include],
      ...(legacy.length > 0 ? { identitiesExclude: [...legacy] } : {}),
    }
  }
  const saved = projectRuleScope(draft)
  return {
    ...rest,
    ...(saved.exclude !== undefined ? { identitiesExclude: [...saved.exclude] } : {}),
  }
}
