import type { ZoneRuleStage } from '@camstack/types'

/**
 * Zone-rule stages whose gate ACTUALLY reads `rule.classFilter`.
 *
 * Only the DETECTION stage narrows by object class: the detection zone
 * engine (`addon-post-analysis` `zone-engine.filterDetections`) passes a
 * `getClassName` accessor, so a rule's `classFilter` selects which
 * detection classes it applies to.
 *
 * The other stages do NOT consume `classFilter`, so a class selector on
 * them is a control that changes nothing:
 *   - `motion`  — the motion gate calls the shared `evaluateZoneRules`
 *     WITHOUT a `getClassName` accessor (motion regions carry no class),
 *     so `classFilter` is a no-op (see `motion-wasm/zone-gate.ts`).
 *   - `package` — a package zone is always the `package` class; the
 *     crop-zone resolver and the package-drop detector read only
 *     `zoneIds`/`enabled`, never `classFilter`.
 */
const STAGES_WITH_CLASS_FILTER: ReadonlySet<ZoneRuleStage> = new Set<ZoneRuleStage>(['detection'])

/** Whether the rule editor should show the object-class selector for `stage`. */
export function stageHasClassFilter(stage: ZoneRuleStage): boolean {
  return STAGES_WITH_CLASS_FILTER.has(stage)
}
