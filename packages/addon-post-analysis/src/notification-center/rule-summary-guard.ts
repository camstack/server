/**
 * The hub's half of D647: `systemEventDelivery: { mode: 'summary' }` belongs to
 * a `device-events` or `system` rule, and nowhere else — the alarm stays
 * instant. Refused, loudly, on both save routes (the cap provider and the
 * `nc.*Rule` bridge), beside the D637 family guard.
 *
 * The rule is judged by `systemEventDeliveryProblems` (`@camstack/types`), the
 * one statement both editors read too. On an update it is the MERGED rule —
 * merged the way the store merges it, `clear` included — and only when the
 * patch changes something the verdict reads: a rename of a stored rule is
 * never refused for what it already was.
 *
 * Not in Zod, for the reason `rule-family-guard.ts` gives: a cross-field refine
 * would also run when the store LOADS a rule.
 */
import {
  describeSystemEventDeliveryProblem,
  type NcRuleClearableKey,
  type NcRulePatch,
  type NcSystemEventDeliveryProblem,
  type NcSystemEventDeliverySubject,
  systemEventDeliveryProblems,
} from '@camstack/types'
import { canonicalHash } from '@camstack/types/node'
import type { NcRuleFamilyGuardContext } from './rule-family-guard.js'

export class NcSystemEventDeliveryRefusal extends Error {
  readonly problems: readonly NcSystemEventDeliveryProblem[]
  constructor(problems: readonly NcSystemEventDeliveryProblem[]) {
    super(`rule refused: ${problems.map(describeSystemEventDeliveryProblem).join('; ')}`)
    this.name = 'NcSystemEventDeliveryRefusal'
    this.problems = problems
  }
}

function assertSystemEventDelivery(rule: NcSystemEventDeliverySubject): void {
  const problems = systemEventDeliveryProblems(rule)
  if (problems.length > 0) throw new NcSystemEventDeliveryRefusal(problems)
}

/** The fields of a patch the verdict reads. */
export type NcSystemEventDeliveryPatch = Pick<
  NcRulePatch,
  'delivery' | 'conditions' | 'systemEventDelivery' | 'schedule' | 'actions'
>

const JUDGED_KEYS = [
  'delivery',
  'conditions',
  'systemEventDelivery',
  'schedule',
  'actions',
] as const

/**
 * The rule the patch WOULD produce, or `null` when it changes nothing the
 * verdict reads. `clear` removes `schedule` / `actions` before the merge, as
 * the store does.
 */
function mergedDeliverySubject(
  existing: NcSystemEventDeliverySubject,
  patch: NcSystemEventDeliveryPatch,
  clear: readonly NcRuleClearableKey[],
): NcSystemEventDeliverySubject | null {
  const cleared: NcSystemEventDeliverySubject = {
    delivery: existing.delivery,
    conditions: existing.conditions,
    ...(existing.systemEventDelivery !== undefined
      ? { systemEventDelivery: existing.systemEventDelivery }
      : {}),
    ...(existing.schedule !== undefined && !clear.includes('schedule')
      ? { schedule: existing.schedule }
      : {}),
    ...(existing.actions !== undefined && !clear.includes('actions')
      ? { actions: existing.actions }
      : {}),
  }
  const merged: NcSystemEventDeliverySubject = {
    ...cleared,
    ...(patch.delivery !== undefined ? { delivery: patch.delivery } : {}),
    ...(patch.conditions !== undefined ? { conditions: patch.conditions } : {}),
    ...(patch.systemEventDelivery !== undefined
      ? { systemEventDelivery: patch.systemEventDelivery }
      : {}),
    ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
    ...(patch.actions !== undefined ? { actions: patch.actions } : {}),
  }
  const changed = JUDGED_KEYS.some(
    (key) => canonicalHash(merged[key] ?? null) !== canonicalHash(existing[key] ?? null),
  )
  return changed ? merged : null
}

function logRefusal(check: () => void, ctx: NcRuleFamilyGuardContext): void {
  try {
    check()
  } catch (err) {
    if (err instanceof NcSystemEventDeliveryRefusal) {
      ctx.logger.warn('nc rule refused: summary delivery not allowed here', {
        meta: {
          ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
          by: ctx.by,
          problems: err.problems.map(describeSystemEventDeliveryProblem),
        },
      })
    }
    throw err
  }
}

/** The create path of both routes. */
export function guardRuleSystemEventDelivery(
  rule: NcSystemEventDeliverySubject,
  ctx: NcRuleFamilyGuardContext,
): void {
  logRefusal(() => assertSystemEventDelivery(rule), ctx)
}

/** The update path of both routes: the MERGED rule, when the patch changes what is judged. */
export function guardPatchSystemEventDelivery(
  existing: NcSystemEventDeliverySubject | null,
  patch: NcSystemEventDeliveryPatch,
  clear: readonly NcRuleClearableKey[],
  ctx: NcRuleFamilyGuardContext,
): void {
  if (existing === null) return
  const merged = mergedDeliverySubject(existing, patch, clear)
  if (merged === null) return
  logRefusal(() => assertSystemEventDelivery(merged), ctx)
}
