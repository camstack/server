/**
 * ONE episode reducer for every alert that is a SUSTAINED STATE rather than a
 * moment — a battery below the operator's threshold, a first-level device that
 * is not answering.
 *
 * Everything the Notification Center delivered before this was an EDGE: a
 * detection happened, a doorbell was pressed, a node went away. An edge is
 * announced once and it is over. A sustained state is different in exactly one
 * way, and it is the way the operator asked for: **it is still true tomorrow,
 * and they want to be told again.**
 *
 * ## Why the reducer is pure and the row is durable
 *
 * The verdict is a reading of a stored row against a clock and two settings, so
 * storing the verdict would create a second authority that goes stale the
 * moment nobody rewrites it — the shape D62 forbids for per-camera switches and
 * `battery-presence.ts` refuses for the presence verdict. The ROW is the fact
 * (which band, since when, when we last spoke, how many times); everything else
 * is derived here, by one function, with the clock passed in.
 *
 * ## The four rules
 *
 * 1. **A repeat of the held state is silence.** The `battery` slice was
 *    measured writing 526 times in 25 minutes with zero value changes; keyed on
 *    the band, all 526 are discarded before any rule is consulted.
 *
 * 2. **The first observation of the GOOD state seeds silently; the first
 *    observation of the BAD state notifies.** This is not a compromise between
 *    D130 and D141, it is both of them. The 2026-08-13 flood that D130's rule
 *    exists to stop was made ENTIRELY of `device.online` — every camera
 *    re-announcing itself after a container recreate — and a cold row that
 *    notified on the good state would rebuild it exactly, at 1013 devices. But
 *    D141 is the other half: a camera whose first observation ever is its own
 *    death had that death thrown away, twice, and a device adopted with a flat
 *    battery is the same subject. A bad first observation can only ever be as
 *    numerous as the things that are actually broken.
 *
 * 3. **The recovery is the operator's choice and defaults on**, and it fires on
 *    the LEDGERED transition — never on a raw value crossing. That is the whole
 *    reason `battery-band.ts` stores a band. When the flag is off the
 *    notification is suppressed but **the row still moves**: a state we never
 *    recorded leaving is a state we can never announce entering again.
 *
 * 4. **A reminder is the same episode said again, under a different outbox
 *    id.** The outbox dedup id is `${ruleId}:${dedupRef}:${targetId}` and
 *    `dedupRef` falls back to the subject's `recordId`, so two reminders
 *    sharing one id would be swallowed by the exact guarantee that makes the
 *    first push exactly-once. `<subject>:<since>:r<n>` moves the dedup key and
 *    nothing else — the same escape a grouped window makes with
 *    its `windowKey`, one level up.
 *
 * Pure: the clock is always an argument.
 */

/** The durable row. One per subject; the subject names its own family. */
export interface NcAlertRow {
  /** `battery:<deviceId>` or `offline:<deviceId>` — never bare `device:<id>`,
   *  which liveness already owns (D141's split, one level over). */
  readonly subject: string
  /** Is the subject in the state worth notifying about, right now? */
  readonly alerting: boolean
  /** When the CURRENT episode opened. Part of the record id, so it separates
   *  two episodes of one subject in the outbox. */
  readonly since: number
  /** When we last actually sent something. 0 = never (a silent seed). */
  readonly lastNotifiedAt: number
  /** How many REMINDERS this episode has produced. Reset by every transition. */
  readonly reminders: number
  /**
   * What the open episode IS, where the subject alone cannot say: a provider
   * consumable band plus form (`low:product`, `full:bin`). Bare `low` / `full`
   * are rows written before the form was stored. Durable, so a state summary
   * after a restart words the item by what it was raised as (D647 review M6).
   * Absent when closed.
   */
  readonly detail?: string
}

/** The row with `detail` set (or removed). Unchanged rows are returned as is. */
export function withAlertDetail(row: NcAlertRow, detail: string | undefined): NcAlertRow {
  if (row.detail === detail) return row
  const { subject, alerting, since, lastNotifiedAt, reminders } = row
  return {
    subject,
    alerting,
    since,
    lastNotifiedAt,
    reminders,
    ...(detail !== undefined ? { detail } : {}),
  }
}

/**
 * What to do about one observation.
 *
 * `seeded` and `silent` are two different nothings and both are named: `seeded`
 * is "we had never heard of this subject", `silent` is "we had, and nothing
 * changed". An empty verdict would read as a decision that failed.
 */
export type NcAlertVerdict =
  | { readonly kind: 'seeded' }
  | { readonly kind: 'silent' }
  | { readonly kind: 'raise' }
  | { readonly kind: 'recover' }
  | { readonly kind: 'remind'; readonly reminderIndex: number }

export interface NcAlertDecision {
  /** The row the ledger holds, or `undefined` for a subject never seen. */
  readonly previous: NcAlertRow | undefined
  /** What we observe NOW. */
  readonly alerting: boolean
  readonly nowMs: number
  /** How long before the same still-true state is said again. **0 = never.** */
  readonly renotifyMs: number
  /** The operator's cluster flag (D-4). */
  readonly notifyRecovery: boolean
}

export function decideAlert(input: NcAlertDecision): NcAlertVerdict {
  const previous = input.previous
  if (previous === undefined) {
    // Rule 2. A cold row is not evidence that anything changed — but a cold row
    // observing a FAULT is the only notice that fault will ever generate.
    return input.alerting ? { kind: 'raise' } : { kind: 'seeded' }
  }
  if (previous.alerting !== input.alerting) {
    if (input.alerting) return { kind: 'raise' }
    // A PENDING episode (raised, never heard by any rule — D636) that ends has
    // nothing to recover from: "back to normal" of an alert nobody received
    // is noise. The row still moves (rule 3).
    if (previous.lastNotifiedAt <= 0) return { kind: 'silent' }
    return input.notifyRecovery ? { kind: 'recover' } : { kind: 'silent' }
  }
  // Rule 1: the held state, observed again.
  if (!input.alerting) return { kind: 'silent' }
  if (input.renotifyMs <= 0) return { kind: 'silent' }
  // `lastNotifiedAt` of 0 on an ALERTING row is a PENDING raise — one no rule
  // matched (D636). It has nothing to remind of, and a slice write must not
  // re-raise it: `NcDeviceAlerts.retryPending` re-offers it, on the tick, only
  // when the rules changed.
  if (previous.lastNotifiedAt <= 0) return { kind: 'silent' }
  if (input.nowMs - previous.lastNotifiedAt < input.renotifyMs) return { kind: 'silent' }
  return { kind: 'remind', reminderIndex: previous.reminders + 1 }
}

/**
 * The row that survives a verdict.
 *
 * Split from {@link decideAlert} rather than returned with it because the
 * caller must be able to persist a row for a verdict it did NOT deliver — the
 * suppressed recovery is the whole reason (rule 3), and so is the silent seed.
 */
export function nextAlertRow(
  subject: string,
  previous: NcAlertRow | undefined,
  alerting: boolean,
  verdict: NcAlertVerdict,
  nowMs: number,
): NcAlertRow {
  switch (verdict.kind) {
    case 'seeded':
      return { subject, alerting, since: nowMs, lastNotifiedAt: 0, reminders: 0 }
    case 'raise':
    case 'recover':
      return { subject, alerting, since: nowMs, lastNotifiedAt: nowMs, reminders: 0 }
    case 'remind':
      return {
        subject,
        alerting,
        since: previous?.since ?? nowMs,
        lastNotifiedAt: nowMs,
        reminders: verdict.reminderIndex,
      }
    case 'silent':
      // A SUPPRESSED transition still moves the state (rule 3); a repeat moves
      // nothing at all, and in particular does not touch `lastNotifiedAt` —
      // advancing it on a repeat would push the reminder away forever.
      if (previous === undefined) {
        return { subject, alerting, since: nowMs, lastNotifiedAt: 0, reminders: 0 }
      }
      if (previous.alerting !== alerting) {
        return {
          subject,
          alerting,
          since: nowMs,
          lastNotifiedAt: previous.lastNotifiedAt,
          reminders: 0,
        }
      }
      return previous
  }
}

/**
 * The `recordId` a notification for this episode carries — and therefore, via
 * the outbox's fallback, its `dedupRef`.
 *
 * `reminderIndex: 0` is the opening notification (and the recovery, which
 * opens the `normal` episode). Every reminder appends `:r<n>`, which is what
 * stops the 7-day outbox dedup swallowing it.
 */
export function alertRecordId(subject: string, since: number, reminderIndex: number): string {
  const base = `${subject}:${since}`
  return reminderIndex > 0 ? `${base}:r${reminderIndex}` : base
}

/**
 * The device a subject is about: `battery:3602` → 3602, and
 * `consumable:4385:sensor` → 4385. The id is the SECOND segment, never the
 * last — reading the last one turned every consumable subject into "no
 * device", which lost the `deviceId` tag on its log lines and the indexed
 * column on its durable row. `undefined` for a subject that names no device.
 */
export function alertSubjectDeviceId(subject: string): number | undefined {
  const raw = subject.split(':')[1]
  if (raw === undefined || raw === '') return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) ? parsed : undefined
}
