/**
 * The hub's half of D640: `sensorTransition` (fire on the raise, the clear, or
 * both) reads the edge of a boolean SENSOR, so it means something on a
 * `device-event` rule and nowhere else. A NEW or UPDATED rule that carries it
 * on another delivery is refused, loudly, on both save routes — the cap
 * provider (`notificationRules.createRule/updateRule`, index.ts) and the rule
 * bridge (`nc.createRule/updateRule`, nc-actions.ts) — beside the D637 family
 * guard, and judged on the same merged rule (`mergedFamilySubject`).
 *
 * Refused, not pruned: the engine would let such a rule through untouched (no
 * other subject carries a sensor edge), so a hub that stripped the key would
 * "save" a choice the operator made and then ignore it without a word. Both
 * editors already prune it before sending (`appliesTo` = device-event only);
 * a payload that still carries it is a client bug worth hearing about.
 *
 * Not in Zod, for the reason `rule-family-guard.ts` gives: a cross-field
 * refine on the conditions schema would also run at LOAD. The engine is
 * untouched.
 */
import type { IScopedLogger, NcDelivery, NcSensorTransition } from '@camstack/types'
import {
  mergedFamilySubject,
  type NcRuleFamilyGuardContext,
  type NcRuleFamilyPatch,
  type NcRuleFamilySubject,
} from './rule-family-guard.js'

/** The one delivery whose subject carries a sensor edge. */
const SENSOR_TRANSITION_DELIVERY: NcDelivery = 'device-event'

export class NcSensorTransitionRefusal extends Error {
  readonly delivery: NcDelivery
  readonly sensorTransition: NcSensorTransition
  constructor(delivery: NcDelivery, sensorTransition: NcSensorTransition) {
    super(
      `rule refused: sensorTransition '${sensorTransition}' applies only to a device-event rule, not '${delivery}'`,
    )
    this.name = 'NcSensorTransitionRefusal'
    this.delivery = delivery
    this.sensorTransition = sensorTransition
  }
}

export function assertSensorTransitionDelivery(rule: NcRuleFamilySubject): void {
  const transition = rule.conditions.sensorTransition
  if (transition === undefined || rule.delivery === SENSOR_TRANSITION_DELIVERY) return
  throw new NcSensorTransitionRefusal(rule.delivery, transition)
}

/** Run the check; a refusal is dropped work, so it is logged before it is rethrown. */
function logRefusal(check: () => void, ctx: NcRuleFamilyGuardContext): void {
  try {
    check()
  } catch (err) {
    if (err instanceof NcSensorTransitionRefusal) {
      warnRefusal(ctx.logger, err, ctx)
    }
    throw err
  }
}

function warnRefusal(
  logger: IScopedLogger,
  err: NcSensorTransitionRefusal,
  ctx: NcRuleFamilyGuardContext,
): void {
  logger.warn('nc rule refused: sensorTransition off a device-event rule', {
    meta: {
      ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
      by: ctx.by,
      delivery: err.delivery,
      sensorTransition: err.sensorTransition,
    },
  })
}

/** The create path of both routes. */
export function guardRuleSensorTransition(
  rule: NcRuleFamilySubject,
  ctx: NcRuleFamilyGuardContext,
): void {
  logRefusal(() => assertSensorTransitionDelivery(rule), ctx)
}

/**
 * The update path of both routes: the MERGED rule is judged, and only when the
 * patch changes `delivery` or `conditions` — an unchanged full-form save
 * (a rename, a retarget) is not re-judged.
 */
export function guardPatchSensorTransition(
  existing: NcRuleFamilySubject | null,
  patch: NcRuleFamilyPatch,
  ctx: NcRuleFamilyGuardContext,
): void {
  if (existing === null) return
  const merged = mergedFamilySubject(existing, patch)
  if (merged === null) return
  logRefusal(() => assertSensorTransitionDelivery(merged), ctx)
}
