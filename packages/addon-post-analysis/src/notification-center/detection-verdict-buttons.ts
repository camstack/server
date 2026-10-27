/**
 * The "Correct" / "Wrong" buttons on a DETECTION notification (#243).
 *
 * Pure. The rule decides (`askVerdict`), the row decides which track, and the
 * channel decides how many buttons fit; this file is the one place those three
 * meet. Like the update buttons, the interesting rules are refusals, and each
 * is returned by name so the caller can LOG the drop (a branch that silently
 * produces nothing reads as "never happened").
 *
 *  - **Only when the rule asked.** `askVerdict` is off by default: a button on
 *    every detection notification would be the operator's phone asking a
 *    question they never chose to be asked.
 *  - **Only for a track.** The mark is a retrain mark on a TRACK; a sensor or
 *    a system event has none.
 *  - **Only for an OWNED target.** "Who" is the owner of the delivery frozen at
 *    mint (a tap identifies nobody, D47), so a shared destination has nobody to
 *    record. Same reasoning as the snooze and update buttons.
 *
 * Channels. A kind declares how many buttons it can carry
 * (`TargetKindCaps.actions`). `0` (mail, chat webhooks without callbacks,
 * Pushover, Gotify, WhatsApp) cannot show a button at all, so the same two
 * choices travel as LINKS in the body. A kind with room for a fourth button
 * also offers "Wrong: it is <class>" for up to two classes the subject might
 * really have been.
 */

import type { NotificationAction } from '@camstack/types'

export const VERDICT_CORRECT_ID = 'detection-verdict-correct'
export const VERDICT_WRONG_ID = 'detection-verdict-wrong'
/** `detection-verdict-wrong:<class>` — Wrong, and what it really was. */
export const VERDICT_WRONG_AS_PREFIX = 'detection-verdict-wrong:'

/** The macro classes offered as "it was really…". Short on purpose. */
export const VERDICT_CLASS_CHOICES: readonly string[] = ['person', 'vehicle', 'animal']
/** At most this many class buttons, and only when the channel has room. */
export const VERDICT_MAX_CLASS_CHOICES = 2

export type VerdictButtonRefusal = 'rule-off' | 'no-track' | 'unowned-target'

export interface VerdictButtonSubject {
  readonly askVerdict: boolean
  readonly trackId?: string
  readonly className?: string
  readonly ownerUserId?: string
}

export function verdictButtonRefusal(subject: VerdictButtonSubject): VerdictButtonRefusal | null {
  if (!subject.askVerdict) return 'rule-off'
  if (subject.trackId === undefined) return 'no-track'
  if (subject.ownerUserId === undefined) return 'unowned-target'
  return null
}

/** One button to mint: what it records, and the id it travels under. */
export interface VerdictButtonSpec {
  readonly actionId: string
  readonly verdict: 'correct' | 'wrong'
  readonly suggestedClass?: string
}

/** The classes worth offering for a subject of `className`. */
export function verdictClassChoices(className: string | undefined): readonly string[] {
  return VERDICT_CLASS_CHOICES.filter((c) => c !== className).slice(0, VERDICT_MAX_CLASS_CHOICES)
}

/**
 * Which buttons a channel with `maxActions` slots gets. `maxActions` absent
 * (the kind catalog did not answer) is treated as the common floor of three:
 * the two plain choices, never the class ones. The class choices appear only
 * when the channel declared room for a fourth button.
 */
export function verdictButtonSpecs(input: {
  readonly className: string | undefined
  readonly maxActions: number | undefined
}): readonly VerdictButtonSpec[] {
  const base: readonly VerdictButtonSpec[] = [
    { actionId: VERDICT_CORRECT_ID, verdict: 'correct' },
    { actionId: VERDICT_WRONG_ID, verdict: 'wrong' },
  ]
  if (input.maxActions === undefined || input.maxActions <= 3) return base
  const room = input.maxActions - base.length
  const extra = verdictClassChoices(input.className)
    .slice(0, room)
    .map(
      (suggestedClass): VerdictButtonSpec => ({
        actionId: `${VERDICT_WRONG_AS_PREFIX}${suggestedClass}`,
        verdict: 'wrong',
        suggestedClass,
      }),
    )
  return [...base, ...extra]
}

/** Is this one of our buttons (so a link-only channel can lift it into the body)? */
export function isVerdictAction(action: { readonly id: string }): boolean {
  return action.id === VERDICT_CORRECT_ID || action.id.startsWith(VERDICT_WRONG_ID)
}

/**
 * The body lines that carry the verdict choices on a channel with no buttons.
 * A bare URL per line: every chat and mail client linkifies it.
 */
export function verdictLinkLines(actions: readonly NotificationAction[]): string {
  return actions
    .filter(isVerdictAction)
    .map((a) => `${a.label}: ${a.url ?? ''}`)
    .join('\n')
}
