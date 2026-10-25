/**
 * What the AI narration pass is FROZEN with at enqueue — the rule's `ai`
 * section reduced to the durable policy the dispatcher will act on minutes (or,
 * after a restart, hours) later.
 *
 * The sibling of `confirm-policy.ts`, deliberately: same contract, same reason.
 * The row must be narrated by the rule that fired it, not by whatever the rule
 * says when the outbox finally drains.
 *
 * Pure. No clock, no store, no logger — so the derivation below is testable as
 * arithmetic rather than through a dispatch.
 */

import type { NcOutboxAiPolicy, NcOutboxPayload } from './outbox.js'
import type { NcRuleAi, NcRuleAiShape } from './rule-ai.js'

/**
 * The shape this row's question takes.
 *
 * Derived from the ROW and never from the rule, so a row can only ever be
 * narrated as what it actually descends from. See {@link NcRuleAiShape} for the
 * three and for why the detection split is the one the engine already draws.
 */
export function ruleAiShapeOf(payload: NcOutboxPayload): NcRuleAiShape {
  if (payload.subject.occupancy !== undefined) return 'occupancy'
  return payload.delivery === 'track-end' ? 'detection-track' : 'detection-immediate'
}

/**
 * The policy to freeze on this rule's rows, or `undefined` for no pass.
 *
 * `undefined` covers three cases that must all behave exactly like the day
 * before this feature existed: no `ai` section, `enabled: false`, and a SYSTEM
 * event — which has no camera, no frame and therefore nothing a vision model
 * could be asked about. The same three `frozenConfirmPolicy` refuses.
 *
 * Only knobs the operator actually set are carried. An absent knob reads as the
 * analyst's own fallback, which is what keeps a row enqueued today correct
 * after a fallback changes tomorrow. `maxWords` is deliberately NOT resolved
 * here: one row fans out to several targets, and the default belongs to the
 * TARGET, which is only known at send time.
 */
export function frozenRuleAiPolicy(
  ai: NcRuleAi | undefined,
  payload: NcOutboxPayload,
  isSystemEvent: boolean,
): NcOutboxAiPolicy | undefined {
  if (ai === undefined || ai.enabled !== true || isSystemEvent) return undefined
  const occupancy = payload.subject.occupancy
  return {
    shape: ruleAiShapeOf(payload),
    ...(ai.profileId !== undefined ? { profileId: ai.profileId } : {}),
    ...(ai.prompt !== undefined ? { prompt: ai.prompt } : {}),
    ...(ai.language !== undefined ? { language: ai.language } : {}),
    ...(ai.maxWords !== undefined ? { maxWords: ai.maxWords } : {}),
    ...(ai.maxImagePx !== undefined ? { maxImagePx: ai.maxImagePx } : {}),
    ...(ai.timeoutMs !== undefined ? { timeoutMs: ai.timeoutMs } : {}),
    // The number the notification CLAIMS, frozen from the edge — it is the
    // whole question an occupancy pass asks, and re-deriving it at send time
    // would validate a count the row never made.
    ...(occupancy !== undefined ? { claimedCount: occupancy.count } : {}),
    ...(occupancy?.zone !== undefined ? { zone: occupancy.zone } : {}),
  }
}
