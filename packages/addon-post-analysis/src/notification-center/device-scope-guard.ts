/**
 * The hub's half of D641: `devicesExclude` ("every device except these") is
 * evaluated wherever `devices` is — detection, track-end, sensor and package
 * rules — and NOWHERE else. A `system-event` rule has an exclusion of its own,
 * `systemEvent.excludeDeviceIds` (D636), judged against the event's device
 * with its own family rules; the engine never reads `devicesExclude` for it.
 *
 * So a NEW or UPDATED system rule carrying it is refused, loudly, on both save
 * routes — the cap provider (`notificationRules.createRule/updateRule`,
 * index.ts) and the rule bridge (`nc.createRule/updateRule`, nc-actions.ts) —
 * beside the D637 family guard and the D640 edge guard, judged on the same
 * merged rule (`mergedFamilySubject`).
 *
 * Refused, not pruned: a hub that stripped the key would "save" an exclusion
 * the operator made and then never apply it. Both editors keep the two
 * exclusions apart; a payload that mixes them is a client bug worth hearing.
 *
 * Not in Zod, for the reason `rule-family-guard.ts` gives: a cross-field
 * refine on the conditions schema would also run at LOAD.
 */
import type { IScopedLogger, NcDelivery } from '@camstack/types'
import {
  mergedFamilySubject,
  type NcRuleFamilyGuardContext,
  type NcRuleFamilyPatch,
  type NcRuleFamilySubject,
} from './rule-family-guard.js'

/**
 * The deliveries whose evaluation reads the device scope — the `devices`
 * descriptor's `appliesTo`, restated as the one delivery that lacks it.
 */
const NO_DEVICE_SCOPE_DELIVERY: NcDelivery = 'system-event'

export class NcDevicesExcludeRefusal extends Error {
  readonly delivery: NcDelivery
  readonly devicesExclude: readonly number[]
  constructor(delivery: NcDelivery, devicesExclude: readonly number[]) {
    super(
      `rule refused: devicesExclude does not apply to a '${delivery}' rule — a system rule excludes devices with systemEvent.excludeDeviceIds`,
    )
    this.name = 'NcDevicesExcludeRefusal'
    this.delivery = delivery
    this.devicesExclude = devicesExclude
  }
}

export function assertDevicesExcludeDelivery(rule: NcRuleFamilySubject): void {
  const excluded = rule.conditions.devicesExclude
  if (excluded === undefined || rule.delivery !== NO_DEVICE_SCOPE_DELIVERY) return
  throw new NcDevicesExcludeRefusal(rule.delivery, excluded)
}

/** Run the check; a refusal is dropped work, so it is logged before it is rethrown. */
function logRefusal(check: () => void, ctx: NcRuleFamilyGuardContext): void {
  try {
    check()
  } catch (err) {
    if (err instanceof NcDevicesExcludeRefusal) warnRefusal(ctx.logger, err, ctx)
    throw err
  }
}

function warnRefusal(
  logger: IScopedLogger,
  err: NcDevicesExcludeRefusal,
  ctx: NcRuleFamilyGuardContext,
): void {
  logger.warn('nc rule refused: devicesExclude on a system rule', {
    meta: {
      ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}),
      by: ctx.by,
      delivery: err.delivery,
      devicesExclude: [...err.devicesExclude],
    },
  })
}

/** The create path of both routes. */
export function guardRuleDevicesExclude(
  rule: NcRuleFamilySubject,
  ctx: NcRuleFamilyGuardContext,
): void {
  logRefusal(() => assertDevicesExcludeDelivery(rule), ctx)
}

/**
 * The update path of both routes: the MERGED rule is judged, and only when the
 * patch changes `delivery` or `conditions`.
 */
export function guardPatchDevicesExclude(
  existing: NcRuleFamilySubject | null,
  patch: NcRuleFamilyPatch,
  ctx: NcRuleFamilyGuardContext,
): void {
  if (existing === null) return
  const merged = mergedFamilySubject(existing, patch)
  if (merged === null) return
  logRefusal(() => assertDevicesExcludeDelivery(merged), ctx)
}
