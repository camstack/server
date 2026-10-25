/**
 * The hub's half of D637: a NEW or UPDATED system-event rule answers ONE family
 * (device events, system, alarm) and carries only that family's filters.
 *
 * THE authority for the invariant. The cap-provider route
 * (`notificationRules.createRule/updateRule`, index.ts) and the rule bridge
 * (`nc.createRule/updateRule`, nc-actions.ts) both call it through
 * `guardRuleFamily` (create) and `guardPatchFamily` (update), so the two save
 * paths cannot drift. This is the same
 * arrangement as `assertRuleHasAddressee`.
 *
 * Not in Zod: a cross-field refine on `NcConditionsSchema` would also reject the
 * STORED mixed rules at load (NcRuleSchema.parse in the store), and those must
 * keep firing until the operator recreates them. The engine is untouched, and
 * so is the device-prune runner: removing a deleted device id from a stored
 * rule is not authoring.
 */
import {
  describeSystemEventFamilyProblem,
  type IScopedLogger,
  isSystemDelivery,
  type NcConditions,
  NcConditionsSchema,
  type NcDelivery,
  type NcRulePatch,
  type NcSystemEventCondition,
  type NcSystemEventFamilyProblem,
  systemEventFamilyProblems,
} from '@camstack/types'
import { canonicalHash } from '@camstack/types/node'

export interface NcRuleFamilySubject {
  readonly delivery: NcDelivery
  readonly conditions: NcConditions
}

export type NcRuleFamilyPatch = Pick<NcRulePatch, 'delivery' | 'conditions'>

/** Who is saving, and where a refusal is logged. `ruleId` is set on an update. */
export interface NcRuleFamilyGuardContext {
  readonly logger: IScopedLogger
  /** The caller's userId — the person whose save was refused. */
  readonly by: string
  readonly ruleId?: string
}

export class NcRuleFamilyRefusal extends Error {
  readonly problems: readonly NcSystemEventFamilyProblem[]
  /** The rule that was judged: the input on a create, the MERGED rule on an update. */
  readonly rule: NcRuleFamilySubject
  constructor(problems: readonly NcSystemEventFamilyProblem[], rule: NcRuleFamilySubject) {
    super(`system-event rule refused: ${problems.map(describeSystemEventFamilyProblem).join('; ')}`)
    this.name = 'NcRuleFamilyRefusal'
    this.problems = problems
    this.rule = rule
  }
}

export function assertRuleFamily(rule: NcRuleFamilySubject): void {
  if (!isSystemDelivery(rule.delivery)) return
  const problems = systemEventFamilyProblems(rule.conditions.systemEvent)
  if (problems.length > 0) throw new NcRuleFamilyRefusal(problems, rule)
}

const byValue = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const byNumber = (a: number, b: number): number => a - b

/**
 * A system-event condition with every list sorted. The engine reads `kinds` and
 * the id-list filters as SETS (membership only), so an editor that re-sorts
 * them — the admin's `toggleSystemEventKind` puts kinds in option order — has
 * not changed the rule. Copies; the input is never touched.
 */
function sortedSystemEvent(condition: NcSystemEventCondition): NcSystemEventCondition {
  const { kinds, deviceIds, excludeDeviceIds, deviceTypes, nodeIds, packageNames } = condition
  return {
    ...condition,
    kinds: kinds.toSorted(byValue),
    ...(deviceIds !== undefined ? { deviceIds: deviceIds.toSorted(byNumber) } : {}),
    ...(excludeDeviceIds !== undefined
      ? { excludeDeviceIds: excludeDeviceIds.toSorted(byNumber) }
      : {}),
    ...(deviceTypes !== undefined ? { deviceTypes: deviceTypes.toSorted(byValue) } : {}),
    ...(nodeIds !== undefined ? { nodeIds: nodeIds.toSorted(byValue) } : {}),
    ...(packageNames !== undefined ? { packageNames: packageNames.toSorted(byValue) } : {}),
  }
}

/**
 * `zones` with its redundant quantifier dropped: `match: 'any'` says exactly
 * what an absent `match` says (D690 — the editors write `{ ids }`, the store
 * still holds `match: 'any'` on every rule written before). `'all'` is kept:
 * it IS a different rule.
 */
function canonicalZones(conditions: NcConditions): NcConditions {
  const zones = conditions.zones
  if (zones?.match !== 'any') return conditions
  return { ...conditions, zones: { ids: zones.ids } }
}

/** The canonical form two conditions are compared in. */
function conditionsFingerprint(conditions: NcConditions): string {
  const canonical = canonicalZones(conditions)
  const { systemEvent } = canonical
  return canonicalHash(
    systemEvent === undefined
      ? canonical
      : { ...canonical, systemEvent: sortedSystemEvent(systemEvent) },
  )
}

/**
 * Do two conditions say the same thing? Both go through `NcConditionsSchema`
 * (the normalisation the store applies on every write) and are compared
 * canonically: key order is irrelevant, an `undefined` key equals an absent
 * one, and the system-event `kinds` and id-list filters are compared as SETS.
 * Every other array keeps its order, and `zones.match: 'any'` equals an absent
 * `match`. A side that does not parse is treated as
 * a change, so it is judged rather than waved through.
 */
function sameConditions(a: NcConditions, b: NcConditions): boolean {
  const left = NcConditionsSchema.safeParse(a)
  const right = NcConditionsSchema.safeParse(b)
  if (!left.success || !right.success) return false
  return conditionsFingerprint(left.data) === conditionsFingerprint(right.data)
}

/**
 * The rule a patch WOULD produce, as far as the family is concerned — merged
 * the way the store merges it: `delivery` and `conditions` replace whole.
 *
 * `null` when the patch CHANGES neither. Both editors send the whole rule on
 * every save, so "the patch carries `conditions`" is not "the patch changes
 * them": an unchanged full-form save of a stored mixed rule (a rename, a
 * retarget) must pass, and only a save that alters the delivery or the
 * conditions is judged.
 */
export function mergedFamilySubject(
  existing: NcRuleFamilySubject,
  patch: NcRuleFamilyPatch,
): NcRuleFamilySubject | null {
  const deliveryChanged = patch.delivery !== undefined && patch.delivery !== existing.delivery
  const conditionsChanged =
    patch.conditions !== undefined && !sameConditions(patch.conditions, existing.conditions)
  if (!deliveryChanged && !conditionsChanged) return null
  return {
    delivery: patch.delivery ?? existing.delivery,
    conditions: patch.conditions ?? existing.conditions,
  }
}

/**
 * On update, the MERGED rule is judged. A patch that changes neither `delivery`
 * nor `conditions` (absent, or equal to what is stored) leaves the kinds as
 * they are, so a stored mixed rule can still be switched off, renamed or
 * retargeted before the operator recreates it.
 */
export function assertPatchKeepsFamily(
  existing: NcRuleFamilySubject | null,
  patch: NcRuleFamilyPatch,
): void {
  if (existing === null) return
  const merged = mergedFamilySubject(existing, patch)
  if (merged !== null) assertRuleFamily(merged)
}

/**
 * Run a family check and LOG a refusal: who tried to save, the rule that was
 * judged (its delivery and kinds) and every problem in words (the families,
 * the offending kind or filter). Then rethrow. A refused save is dropped work,
 * and dropped work is never silent. Any other error passes through unlogged.
 */
function logRefusal(check: () => void, ctx: NcRuleFamilyGuardContext): void {
  try {
    check()
  } catch (err) {
    if (err instanceof NcRuleFamilyRefusal) {
      ctx.logger.warn('nc rule refused: outside one family', {
        meta: {
          ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
          by: ctx.by,
          delivery: err.rule.delivery,
          kinds: err.rule.conditions.systemEvent?.kinds ?? [],
          problems: err.problems.map(describeSystemEventFamilyProblem),
        },
      })
    }
    throw err
  }
}

/** {@link assertRuleFamily}, logged. The create path of both routes. */
export function guardRuleFamily(rule: NcRuleFamilySubject, ctx: NcRuleFamilyGuardContext): void {
  logRefusal(() => assertRuleFamily(rule), ctx)
}

/** {@link assertPatchKeepsFamily}, logged. The update path of both routes. */
export function guardPatchFamily(
  existing: NcRuleFamilySubject | null,
  patch: NcRuleFamilyPatch,
  ctx: NcRuleFamilyGuardContext,
): void {
  logRefusal(() => assertPatchKeepsFamily(existing, patch), ctx)
}
