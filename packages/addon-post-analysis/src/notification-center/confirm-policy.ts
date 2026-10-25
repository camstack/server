/**
 * What the AI confirm gate is FROZEN with at enqueue — the rule's `confirm`
 * block reduced to the durable policy the dispatcher will act on minutes (or,
 * after a restart, hours) later.
 *
 * Frozen rather than re-read for the same reason `ruleName` is: the row must
 * be judged by the rule that fired it, not by whatever the rule says when the
 * outbox finally drains.
 *
 * Pure. No clock, no store, no logger — so the derivation below is testable as
 * arithmetic rather than through a dispatch.
 */
import type { NcConfirmExpect, NcOccupancyCondition, NcRule } from '@camstack/types'
import { NC_CONFIRM_DEFAULT_MAX_IMAGE_PX, NC_CONFIRM_DEFAULT_TIMEOUT_MS } from '@camstack/types'
import type { NcOutboxConfirmPolicy } from './outbox.js'

/**
 * The count expectation implied by an OCCUPANCY condition.
 *
 * An occupancy rule already states a number and a comparison — asking the
 * operator to restate them inside `confirm.expect` is asking him to keep two
 * thresholds in agreement, and this repo has shipped two knobs that disagreed
 * before. So the condition IS the expectation unless he overrides it.
 *
 *  - `became-occupied` fires when the zone reaches its count ⇒ `>= count`
 *  - `became-free` fires when it drops back below ⇒ `< count`
 *  - `>=` / `<=` carry straight over
 */
export function confirmExpectFromOccupancy(
  occupancy: NcOccupancyCondition,
): NcConfirmExpect | undefined {
  const count = occupancy.count
  switch (occupancy.op) {
    case 'became-occupied':
      return { op: '>=', count: Math.max(1, count) }
    case 'became-free':
      return { op: '<', count: Math.max(1, count) }
    case '>=':
      return { op: '>=', count }
    case '<=':
      return { op: '<=', count }
    default:
      return undefined
  }
}

/**
 * May a suppressed delivery hand back the cooldown window it consumed?
 *
 * ONLY if the window is still the one it opened. The map is keyed per rule and
 * scope, and minutes pass between the enqueue and the model's verdict — long
 * enough for a LATER subject to fire the same key. Releasing then would give
 * that fire's window away too, so the next event arrives as though nothing had
 * ever fired: the rollback would defeat the cooldown instead of undoing one.
 */
export function shouldReleaseCooldown(currentAt: number | undefined, firedAt: number): boolean {
  return currentAt === firedAt
}

/**
 * The policy to freeze on this rule's rows, or `undefined` for no gate.
 *
 * `undefined` covers three cases that must all behave identically to the day
 * before the gate existed: no `confirm` block, `enabled:false`, and a SYSTEM
 * event — which has no camera, no frame and therefore nothing a vision model
 * could possibly be asked about.
 *
 * Only knobs the operator actually set are carried. An absent knob reads as
 * the gate's own fallback, which is what makes a row enqueued today still
 * correct after a knob's default changes tomorrow.
 */
export function frozenConfirmPolicy(
  rule: NcRule,
  isSystemEvent: boolean,
): NcOutboxConfirmPolicy | undefined {
  const confirm = rule.confirm
  if (confirm === undefined || confirm.enabled !== true || isSystemEvent) return undefined
  const expect =
    confirm.expect ??
    (rule.conditions.occupancy !== undefined
      ? confirmExpectFromOccupancy(rule.conditions.occupancy)
      : undefined)
  return {
    ...(confirm.profileId !== undefined ? { profileId: confirm.profileId } : {}),
    ...(confirm.prompt !== undefined ? { prompt: confirm.prompt } : {}),
    ...(expect !== undefined ? { expect } : {}),
    ...(confirm.timeoutMs !== undefined && confirm.timeoutMs !== NC_CONFIRM_DEFAULT_TIMEOUT_MS
      ? { timeoutMs: confirm.timeoutMs }
      : {}),
    ...(confirm.onTimeout !== undefined && confirm.onTimeout !== 'fire'
      ? { onTimeout: confirm.onTimeout }
      : {}),
    ...(confirm.maxImagePx !== undefined && confirm.maxImagePx !== NC_CONFIRM_DEFAULT_MAX_IMAGE_PX
      ? { maxImagePx: confirm.maxImagePx }
      : {}),
  }
}
