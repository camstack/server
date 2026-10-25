/**
 * Snooze — the decision half, as pure functions.
 *
 * A rule, a camera or a recipient's whole feed goes quiet for a chosen window
 * and comes back on its own. Operator decisions (2026-08-04):
 *
 *  - **Personal by default.** A snooze silences the person who set it. "I am
 *    asleep" is not "nobody needs to know", and a snooze that silenced the
 *    household by default would be an outage someone else caused.
 *  - **A per-rule setting can make it GLOBAL**, default OFF. That is the
 *    gardener-all-afternoon case: silencing the garden camera for everyone is
 *    legitimate and has to be deliberate, so it is opt-in per rule.
 *  - **What it silences is a CAMERA and a kind of thing**, not a rule. The key
 *    is `(deviceId, classes[])` and crosses every rule that matches it: an
 *    operator silencing the cat on the courtyard camera does not know, and
 *    should not have to know, which of their four rules produced the last
 *    notification. `ruleId` is still on the window as PROVENANCE — the scope
 *    the operator picked, and what the digest names.
 *  - **A summary of what was suppressed is delivered when the window ends**,
 *    default ON. Someone silencing a nuisance camera wants it off; someone
 *    silencing a SECURITY camera wants to know what they missed. Choosing one
 *    for everybody is how a snooze becomes an outage.
 *
 * Expiry is a COMPARISON, not a job: a snooze ends because the clock passed it,
 * not because a sweeper ran. A sweeper that fails leaves the operator silenced.
 */

import type { NcSnooze, NcSnoozeScope } from '@camstack/types'

/** What a snooze covers. Broader scopes win when several match. */
export type SnoozeScope = NcSnoozeScope

/**
 * A snooze window, as persisted. The SHAPE is the cap's (`NcSnoozeSchema`) —
 * this module is the decision half over it, and a second local declaration of
 * the same record is exactly the mirror drift that has emptied a rule editor
 * twice.
 */
export type SnoozeEntry = NcSnooze

export interface SnoozeQuery {
  readonly nowMs: number
  /**
   * The recipient the notification is bound for — the OWNER of the target it
   * is being delivered to.
   *
   * Absent for a shared target nobody owns (a household topic, an admin
   * webhook). Such a target has no "person who set it", so a PERSONAL snooze
   * can never silence it; only a global one can. Fail-closed here means
   * DELIVERING: the damaging failure of a snooze is silencing too much.
   */
  readonly userId?: string
  readonly ruleId: string
  readonly deviceId: number
  /**
   * The subject's class (`person`, `cat`, `car`, …), when it has one.
   *
   * What a snooze is actually ABOUT is a camera and a kind of thing —
   * "the cat, not the person" — which crosses rules: an operator silencing the
   * cat does not want to know which of their four rules matched it. So the
   * window's key is `(deviceId, classes[])` and the rule is provenance only.
   *
   * Absent for every subject that carries no class: a device event, an
   * occupancy edge, a system event. Such a subject never matches a CLASSED
   * window — see {@link covers}.
   */
  readonly className?: string
}

/**
 * How broad a scope is, for choosing between overlapping snoozes.
 *
 * Doubled so a CLASS narrowing can sit inside one step without ever crossing
 * it: a device window is broader than a rule window whether or not either
 * names classes.
 */
const BREADTH: Readonly<Record<SnoozeScope, number>> = { rule: 1, device: 2, all: 3 }

/**
 * How broad ONE window is.
 *
 * At equal scope the CLASSED window is narrower — it silences a subset of what
 * the unclassed one silences, so when both cover a delivery the unclassed one
 * is the window that owns the silence and therefore owns the digest. Picking
 * the classed one would leave the broader window's summary claiming a
 * suppression it did not perform.
 */
function breadthOf(entry: SnoozeEntry): number {
  const classed = entry.classes !== undefined && entry.classes.length > 0
  return BREADTH[entry.scope] * 2 + (classed ? 0 : 1)
}

/**
 * Does this window silence a subject of this class?
 *
 * Absent/empty `classes` = every class, which is what every window persisted
 * before the field meant and still means.
 *
 * A subject with NO class never matches a classed window. That is the
 * fail-toward-delivering direction this feature is built on: "silence the cat"
 * is a statement about detections, and reading it as also covering a doorbell
 * press, an occupancy edge or a node going offline would silence things the
 * operator never pointed at.
 */
function classMatches(entry: SnoozeEntry, q: SnoozeQuery): boolean {
  const classes = entry.classes
  if (classes === undefined || classes.length === 0) return true
  if (q.className === undefined) return false
  return classes.includes(q.className)
}

function covers(entry: SnoozeEntry, q: SnoozeQuery): boolean {
  if (q.nowMs < entry.startedAt) return false
  if (q.nowMs >= entry.expiresAt) return false
  if (!classMatches(entry, q)) return false
  // Personal unless the rule opted into silencing everyone. An UNOWNED target
  // (`q.userId` absent) therefore never matches a personal entry: there is
  // nobody whose silence it would be, and the safe failure is to deliver.
  if (!entry.global && entry.userId !== q.userId) return false
  switch (entry.scope) {
    case 'all':
      return true
    case 'rule':
      // A scoped row with no id must NOT degrade to "everything" — that would
      // silence the whole feed from a malformed record.
      return entry.ruleId !== undefined && entry.ruleId === q.ruleId
    case 'device':
      return entry.deviceId !== undefined && entry.deviceId === q.deviceId
  }
}

/**
 * The snooze that silences this notification, or null.
 *
 * The BROADEST match wins so one window produces one digest: an "all" snooze
 * overlapping a rule snooze should not leave the recipient two summaries for
 * the same silence.
 */
export function activeSnoozeFor(
  entries: readonly SnoozeEntry[],
  q: SnoozeQuery,
): SnoozeEntry | null {
  let best: SnoozeEntry | null = null
  for (const e of entries) {
    if (!covers(e, q)) continue
    if (best === null || breadthOf(e) > breadthOf(best)) best = e
  }
  return best
}

/** Whether this notification is silenced right now. */
export function isSnoozed(entries: readonly SnoozeEntry[], q: SnoozeQuery): boolean {
  return activeSnoozeFor(entries, q) !== null
}

/** What a caller must prove to open a GLOBAL window. */
export interface GlobalSnoozeRequest {
  readonly scope: SnoozeScope
  /** `snoozeAllowGlobal` on the rule being silenced. Absent = the rule is
   *  unknown, which is not permission. */
  readonly ruleAllowsGlobal?: boolean
  readonly isAdmin: boolean
}

/**
 * May this caller silence EVERYONE, not just themselves?
 *
 * Global is the only part of a snooze that can affect a person who did not ask
 * for it, so it is never reachable by accident:
 *
 *  - **rule scope** — the rule itself must opt in (`snoozeAllowGlobal`, default
 *    off). That is the gardener case: this rule is known to be noisy for
 *    everybody in a way that is legitimate to silence for everybody.
 *  - **device or whole-feed scope** — there is no rule to carry the opt-in, and
 *    "silence this camera for the household" is an administrative act. Admin
 *    only.
 *
 * A personal snooze needs no permission at all: it silences only its author.
 */
export function canSetGlobal(req: GlobalSnoozeRequest): boolean {
  if (req.isAdmin) return true
  if (req.scope !== 'rule') return false
  return req.ruleAllowsGlobal === true
}

/** Entries whose window has closed and whose digest has not been sent yet. */
export function dueSummaries(
  entries: readonly SnoozeEntry[],
  nowMs: number,
  alreadySent: ReadonlySet<string>,
): readonly SnoozeEntry[] {
  return entries.filter((e) => e.summary && nowMs >= e.expiresAt && !alreadySent.has(e.id))
}
