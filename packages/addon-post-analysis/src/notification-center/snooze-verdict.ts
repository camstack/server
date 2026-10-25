/**
 * THE snooze decision — one function, asked by every path that may silence a delivery.
 *
 * Two callers, and they must never disagree (D692 C4, operator ruling 2026-10-02):
 *
 *  - the dispatcher's send gate (`NotificationCenter.snoozeGate`, wired as the dispatcher's
 *    `snoozeGate` dep) — an instant row, per target, at send;
 *  - the grouped close (`NotificationCenter.closeGroupedWindow`) — "snoozed at close" means
 *    ANY snooze that would suppress the same rule's INSTANT notification, so the close asks
 *    this very function, per target, with the same owner the dispatcher passes.
 *
 * It decides; it neither logs nor records. Which window covers the delivery is
 * `activeSnoozeFor` (the broadest wins); an ALARM rule is exempt whatever window covers it
 * (`snooze-exempt.ts`, D697), and the exemption is a verdict of its own so each caller can
 * say so.
 */

import type { NcRuleAction, NcSnooze } from '@camstack/types'
import type { NcSnoozeGateInput } from './dispatcher.js'
import { isSnoozeExempt, type SnoozeExemptRule } from './snooze-exempt.js'
import type { SnoozeQuery } from './snooze-policy.js'

export interface NcSnoozeVerdictDeps {
  /** The covering window, or null (`NcSnoozeStore.activeFor`). */
  readonly activeFor: (query: SnoozeQuery) => NcSnooze | null
  /** The rule as it stands now — `null` when it is gone (never exempt then). */
  readonly ruleFor: (ruleId: string) => SnoozeExemptRule | null
  /** Resolve shared-sequence steps so a sequence-ref alarm actuation is exempt. */
  readonly sequenceActionsOf?: (sequenceId: string) => readonly NcRuleAction[] | undefined
}

/** No window covers the delivery. */
export interface NcSnoozeVerdictClear {
  readonly kind: 'clear'
}
/** A window covers it, but the rule is an alarm rule and is never silenced. */
export interface NcSnoozeVerdictExempt {
  readonly kind: 'exempt'
  readonly snooze: NcSnooze
}
/** The delivery is silenced by this window. */
export interface NcSnoozeVerdictSuppressed {
  readonly kind: 'suppressed'
  readonly snooze: NcSnooze
}
export type NcSnoozeVerdict =
  | NcSnoozeVerdictClear
  | NcSnoozeVerdictExempt
  | NcSnoozeVerdictSuppressed

export function snoozeVerdict(
  input: NcSnoozeGateInput,
  deps: NcSnoozeVerdictDeps,
): NcSnoozeVerdict {
  const active = deps.activeFor({
    nowMs: input.at,
    ...(input.ownerUserId !== undefined ? { userId: input.ownerUserId } : {}),
    ruleId: input.ruleId,
    deviceId: input.deviceId,
    ...(input.className !== undefined ? { className: input.className } : {}),
  })
  if (active === null) return { kind: 'clear' }
  const rule = deps.ruleFor(input.ruleId)
  if (rule !== null && isSnoozeExempt(rule, deps.sequenceActionsOf)) {
    return { kind: 'exempt', snooze: active }
  }
  return { kind: 'suppressed', snooze: active }
}

/** One class's suppression: the input it was asked on and the window that silenced it. */
export interface NcSnoozeClassSuppression {
  readonly input: NcSnoozeGateInput
  readonly verdict: NcSnoozeVerdictSuppressed
}

/**
 * A grouped message speaks for SEVERAL classes (D692 C4, review T9a M-2), and a class snooze
 * must never silence the dog it was not set for. So the delivery is covered only when EVERY
 * member class is suppressed — the close pass and the dispatcher's send gate both ask THIS
 * function, so the two cannot disagree about the same window.
 *
 * `decide` is the single-delivery decision (`snoozeVerdict`, plus whatever line the caller
 * owes an exemption). Returns the per-class suppressions when every class is silenced, and
 * `null` as soon as one class is clear or exempt (the direction of the doubt is DELIVERING).
 * Without `classNames` it is exactly one `decide(input)`.
 */
export function snoozeCoverage(
  input: NcSnoozeGateInput,
  decide: (single: NcSnoozeGateInput) => NcSnoozeVerdict,
): readonly NcSnoozeClassSuppression[] | null {
  const { classNames, ...base } = input
  const asks: readonly NcSnoozeGateInput[] =
    classNames !== undefined && classNames.length > 0
      ? classNames.map((className): NcSnoozeGateInput => ({ ...base, className }))
      : [base]
  const suppressed: NcSnoozeClassSuppression[] = []
  for (const ask of asks) {
    const verdict = decide(ask)
    if (verdict.kind !== 'suppressed') return null
    suppressed.push({ input: ask, verdict })
  }
  return suppressed
}
