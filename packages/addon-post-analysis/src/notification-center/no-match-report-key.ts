/**
 * The rate-limit bucket of the notification center's two "nothing happened to
 * this event" reports — `event matched NO rule` and `notifications muted for
 * this camera`.
 *
 * Both reports exist because a rule that stops matching is otherwise invisible
 * (the per-rule verdicts are `debug`, which does not reach the log pipeline),
 * and both are rate-limited so a busy camera prints one line rather than one
 * per event.
 *
 * The BUCKET is what makes the line trustworthy. Keyed on the device alone, a
 * camera that sees two subjects at once reports the first and silences the
 * second — and the silence is indistinguishable from "that subject was never
 * evaluated", which is the strongest wrong conclusion an operator can draw
 * from this log. It was drawn: 2026-09-07 18:29 on camera 101, a person's
 * rejection consumed the window and the cat's object-event 6 s later — stored,
 * dispatched, and rejected on its `zones` condition — printed nothing. Hours
 * went into looking for an event that already existed ([D390]).
 *
 * So the bucket carries the CLASSES of the subject as well: one line per
 * camera per subject kind per class set per window. That keeps the volume
 * bound the rate limit was added for (a stream of identical person events is
 * still one line) while making it impossible for one subject to answer for
 * another.
 */
import type { NcSubjectKind } from './rule-engine.js'

/** The slice of an `NcRuleSubject` the bucket is derived from. */
export interface NoMatchReportSubject {
  readonly deviceId: number
  readonly kind: NcSubjectKind
  /** Event: `[className]`; track: its class list. May legitimately be empty. */
  readonly classNames: readonly string[]
}

/**
 * Stand-in for "this subject named no class". A distinct token rather than an
 * empty string so a class-less subject occupies its own bucket instead of
 * sharing one with every other class-less kind by accident.
 */
const NO_CLASSES = '∅'

/**
 * The bucket key. Stable across calls, insensitive to class ORDER, DUPLICATES
 * and CASE — a detector that re-orders its class list, repeats one, or changes
 * its capitalisation must not fork the bucket and double the log volume.
 */
export function noMatchReportKey(subject: NoMatchReportSubject): string {
  const classes = [...new Set(subject.classNames.map((c) => c.toLowerCase()))].sort()
  return `${subject.deviceId}|${subject.kind}|${classes.length > 0 ? classes.join(',') : NO_CLASSES}`
}
