/**
 * The hub's half of D897: a rule's picture is ONE mode (`media.image`) plus
 * `showTriggerZone`, and both are judged against the rule they are saved on.
 *
 *  - `showTriggerZone` draws the zone that FIRED the rule. A rule whose trigger
 *    is not a zone (no `zones` condition, no occupancy zone) has nothing to
 *    draw, so the flag is refused rather than stored as a knob that does
 *    nothing.
 *  - `image` must be a mode the rule's kind can honour
 *    (`imageModesForKind`): a sound owns no region of the frame, so it is never
 *    offered `crop`.
 *
 * The predicate is `ncMediaPolicyError` (`@camstack/types`), read by the admin
 * editor too. It runs on both save routes — the cap provider
 * (`notificationRules.createRule/updateRule`) and the rule bridge
 * (`nc.createRule/updateRule`) — beside the other guards.
 *
 * Only media the CALLER sent is judged: a create's `media`, an update's
 * `media`, against the MERGED delivery and conditions. A stored rule is never
 * judged on load — `normalizeNcMediaPolicy` drops a flag it cannot draw there,
 * because a refusal at load would cost the rule its notifications.
 *
 * Not in Zod for the reason `rule-family-guard.ts` gives: a refine would also
 * run when the store LOADS a rule.
 */
import {
  type NcConditions,
  type NcDelivery,
  type NcMediaPolicy,
  type NcRulePatch,
  ncMediaPolicyError,
} from '@camstack/types'
import type { NcRuleFamilyGuardContext } from './rule-family-guard.js'

export class NcMediaPolicyRefusal extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`rule refused: ${reason}`)
    this.name = 'NcMediaPolicyRefusal'
    this.reason = reason
  }
}

/** What the guard judges: the media and the rule fields it is judged against. */
export interface NcMediaGuardSubject {
  readonly delivery: NcDelivery
  readonly conditions: NcConditions
  readonly media?: NcMediaPolicy
}

export type NcMediaGuardPatch = Pick<NcRulePatch, 'delivery' | 'conditions' | 'media'>

function judge(subject: NcMediaGuardSubject, ctx: NcRuleFamilyGuardContext): void {
  if (subject.media === undefined) return
  const reason = ncMediaPolicyError(subject.media, subject)
  if (reason === null) return
  // A refusal is dropped work: logged before it is thrown.
  ctx.logger.warn('nc rule refused: media policy the rule cannot honour', {
    meta: { ...(ctx.ruleId !== undefined ? { ruleId: ctx.ruleId } : {}), by: ctx.by, reason },
  })
  throw new NcMediaPolicyRefusal(reason)
}

/** The create path of both routes. */
export function guardRuleMedia(rule: NcMediaGuardSubject, ctx: NcRuleFamilyGuardContext): void {
  judge(rule, ctx)
}

/** The update path of both routes: the patch's media on the MERGED rule. */
export function guardPatchMedia(
  existing: NcMediaGuardSubject | null,
  patch: NcMediaGuardPatch,
  ctx: NcRuleFamilyGuardContext,
): void {
  if (existing === null || patch.media === undefined) return
  judge(
    {
      delivery: patch.delivery ?? existing.delivery,
      conditions: patch.conditions ?? existing.conditions,
      media: patch.media,
    },
    ctx,
  )
}
