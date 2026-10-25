/**
 * The hub's half of D692 §2.2: `groupingSec` belongs to an `immediate` DETECTION
 * rule, and nowhere else. A track-end rule fires at close and already carries
 * the name; a parcel, a sound, a sensor, an occupancy rule and a system rule
 * have no subject to promote and no tile per subject. {@link ruleGroupingApplies}
 * (`@camstack/types`) is the one predicate the editors and this guard read.
 *
 * A NEW or UPDATED rule that carries `groupingSec` without it is refused,
 * loudly, on both save routes — the cap provider
 * (`notificationRules.createRule/updateRule`, index.ts) and the rule bridge
 * (`nc.createRule/updateRule`, nc-actions.ts) — beside the D690 guard, so the
 * two paths cannot drift.
 *
 * A STORED rule is never judged on load: a rule that carries `groupingSec` and
 * cannot group is inert (only an `object-event` subject routes into a window).
 * The legacy audio-class rule (`immediate`, `classes: ['audio-*']`, no
 * `conditions.audio`) is kind `detection` and therefore accepted — harmless,
 * for the same reason.
 *
 * On an update the MERGED rule is judged (`clear` removes the stored key first,
 * then the patch applies, D628) and only when the patch touched `delivery`,
 * `conditions` or `groupingSec` — the same "a save that leaves them as stored
 * is never re-judged" rule the D690 guard uses, so an inert stored rule stays
 * renameable and switchable. "Touched" means CHANGED: the editors send the
 * whole rule on every save.
 *
 * A second refusal rides the same guard (T13 fix round, D692): a grouped rule's
 * AI confirm judges each tile on its own, and a tile shows ONE subject. An
 * `expect` that a count of 1 does not meet (`>= 2`, `== 2`, `> 1`, `== 0` …)
 * therefore suppresses every message of the rule, so it is refused on a rule
 * that is grouped (`groupingSec` set and {@link ruleGroupingApplies}) and whose
 * confirm gate is enabled. Same merged-rule judgement, same touch gate, same
 * two routes.
 *
 * Not in Zod, for the reason `rule-family-guard.ts` gives: a refine would also
 * run when the store LOADS a rule.
 */
import {
  type NcConfirmExpect,
  type NcRuleClearableKey,
  type NcRuleKind,
  type NcRulePatch,
  ruleGroupingApplies,
  ruleKindOf,
} from '@camstack/types'
import { satisfies } from './confirm-gate.js'
import {
  mergedFamilySubject,
  type NcRuleFamilyGuardContext,
  type NcRuleFamilySubject,
} from './rule-family-guard.js'

export class NcGroupingRefusal extends Error {
  readonly kind: NcRuleKind
  readonly delivery: string
  constructor(kind: NcRuleKind, delivery: string) {
    super(
      `rule refused: a ${kind} rule on ${delivery} delivery cannot be grouped (groupingSec) — only an immediate detection rule can; turn grouping off in an editor that shows it (clear groupingSec)`,
    )
    this.name = 'NcGroupingRefusal'
    this.kind = kind
    this.delivery = delivery
  }
}

/** The subject the guard judges: the family subject plus the one field. */
export interface NcGroupingSubject extends NcRuleFamilySubject {
  readonly groupingSec?: number
  readonly confirm?: NcGroupingConfirm
}

/** The part of the AI confirm block the guard reads. */
export interface NcGroupingConfirm {
  readonly enabled?: boolean
  readonly expect?: NcConfirmExpect
}

export type NcGroupingPatch = Pick<
  NcRulePatch,
  'delivery' | 'conditions' | 'groupingSec' | 'confirm'
>

export class NcGroupedConfirmRefusal extends Error {
  readonly expect: NcConfirmExpect
  constructor(expect: NcConfirmExpect) {
    super(
      `rule refused: a grouped rule's AI confirm judges each tile (one subject) on its own, so an expectation of ${expect.op} ${expect.count} would suppress every message — remove the expectation, or turn grouping off`,
    )
    this.name = 'NcGroupedConfirmRefusal'
    this.expect = expect
  }
}

export function assertGroupingApplies(rule: NcGroupingSubject): void {
  if (rule.groupingSec === undefined) return
  if (!ruleGroupingApplies(rule)) throw new NcGroupingRefusal(ruleKindOf(rule), rule.delivery)
  assertGroupedConfirm(rule.confirm)
}

/** A grouped tile shows ONE subject: an expectation a count of 1 cannot meet silences the rule. */
function assertGroupedConfirm(confirm: NcGroupingConfirm | undefined): void {
  if (confirm?.enabled !== true || confirm.expect === undefined) return
  if (!satisfies(1, confirm.expect)) throw new NcGroupedConfirmRefusal(confirm.expect)
}

/** Run the check; a refusal is dropped work, so it is logged before it is rethrown. */
function logRefusal(check: () => void, ctx: NcRuleFamilyGuardContext): void {
  try {
    check()
  } catch (err) {
    if (err instanceof NcGroupingRefusal) {
      ctx.logger.warn('nc rule refused: groupingSec on a rule that cannot group', {
        meta: {
          ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
          by: ctx.by,
          kind: err.kind,
          delivery: err.delivery,
        },
      })
    }
    if (err instanceof NcGroupedConfirmRefusal) {
      ctx.logger.warn(
        'nc rule refused: a grouped rule cannot confirm an expectation a single subject cannot meet',
        {
          meta: {
            ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
            by: ctx.by,
            expect: `${err.expect.op} ${err.expect.count}`,
          },
        },
      )
    }
    throw err
  }
}

/** The create path of both routes. */
export function guardRuleGrouping(rule: NcGroupingSubject, ctx: NcRuleFamilyGuardContext): void {
  logRefusal(() => assertGroupingApplies(rule), ctx)
}

/**
 * The update path of both routes: the MERGED rule. `groupingSec` and `confirm` are the
 * patch's if present, else absent if `clear` names them, else the stored ones.
 */
export function guardPatchGrouping(
  existing: NcGroupingSubject | null,
  patch: NcGroupingPatch,
  clear: readonly NcRuleClearableKey[],
  ctx: NcRuleFamilyGuardContext,
): void {
  if (existing === null) return
  const groupingSec = mergedGroupingSec(existing, patch, clear)
  if (groupingSec === undefined) return
  const confirm = mergedConfirm(existing, patch, clear)
  const groupingTouched =
    patch.groupingSec !== undefined && patch.groupingSec !== existing.groupingSec
  const confirmTouched = !sameConfirm(confirm, existing.confirm)
  const shape = mergedFamilySubject(existing, patch)
  if (shape === null && !groupingTouched) {
    // Only the confirm moved: the stored shape is not re-judged, so a stored rule that
    // cannot group (inert) is never refused for a grouping it does not run. A rule that
    // does group is judged on its confirm alone.
    if (confirmTouched && ruleGroupingApplies(existing)) {
      logRefusal(() => assertGroupedConfirm(confirm), ctx)
    }
    return
  }
  logRefusal(
    () =>
      assertGroupingApplies({
        ...(shape ?? existing),
        groupingSec,
        ...(confirm !== undefined ? { confirm } : {}),
      }),
    ctx,
  )
}

function mergedGroupingSec(
  existing: NcGroupingSubject,
  patch: NcGroupingPatch,
  clear: readonly NcRuleClearableKey[],
): number | undefined {
  if (patch.groupingSec !== undefined) return patch.groupingSec
  if (clear.includes('groupingSec')) return undefined
  return existing.groupingSec
}

function mergedConfirm(
  existing: NcGroupingSubject,
  patch: NcGroupingPatch,
  clear: readonly NcRuleClearableKey[],
): NcGroupingConfirm | undefined {
  if (patch.confirm !== undefined) return patch.confirm
  if (clear.includes('confirm')) return undefined
  return existing.confirm
}

/** Do two confirm blocks say the same thing about what the guard reads? */
function sameConfirm(a: NcGroupingConfirm | undefined, b: NcGroupingConfirm | undefined): boolean {
  return (
    (a?.enabled === true) === (b?.enabled === true) &&
    a?.expect?.op === b?.expect?.op &&
    a?.expect?.count === b?.expect?.count
  )
}
