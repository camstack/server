/**
 * ONE episode reducer for both alert families — battery band and device
 * liveness — because they differ in nothing the operator can name.
 *
 * The four properties pinned here:
 *
 *  1. **A repeat is not news.** The same state observed again says nothing, and
 *     the `battery` slice is written far more often than it changes: the
 *     runtime-state census quoted in `battery.cap.ts` measured **526 writes in
 *     25 minutes with 0 value changes**. A reducer keyed on the reading would
 *     have re-fired on every one; keyed on the BAND it discards all of them.
 *
 *  2. **The reminder is the same episode said again**, so it carries a
 *     DIFFERENT record id. The outbox dedup id is
 *     `${ruleId}:${dedupRef}:${targetId}` and `dedupRef` falls back to the
 *     subject's `recordId` — so two reminders sharing one id would be
 *     swallowed by the exact guarantee that makes the first push exactly-once.
 *     `<subject>:<since>:r<n>` moves the dedup key and nothing else — the same
 *     escape a grouped window makes with its `windowKey`, one level up.
 *
 *  3. **The recovery is configurable and defaults on** (the operator's D-4),
 *     and it fires on the LEDGERED band transition — never on a raw value
 *     crossing. That is the whole reason the band is the stored fact.
 *
 *  4. **A first observation of the GOOD state seeds silently.** A hub restart
 *     re-announces every slice (D130's flood was made entirely of "online"),
 *     so a cold row must not turn into 1013 notifications. A first observation
 *     of the BAD state does notify — that is D141's rule: a camera whose first
 *     observation ever is its own death must not have it thrown away, and the
 *     same is true of a device adopted with a flat battery.
 */
import { describe, expect, it } from 'vitest'
import { alertRecordId, decideAlert, type NcAlertRow, nextAlertRow } from '../alert-episode.js'

const MIN = 60_000
const SUBJECT = 'battery:3602'

function row(patch: Partial<NcAlertRow> = {}): NcAlertRow {
  return {
    subject: SUBJECT,
    alerting: true,
    since: 1_000,
    lastNotifiedAt: 1_000,
    reminders: 0,
    ...patch,
  }
}

describe('decideAlert — the first observation', () => {
  it('seeds silently when the first thing we ever see is the GOOD state', () => {
    expect(
      decideAlert({
        previous: undefined,
        alerting: false,
        nowMs: 5_000,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'seeded' })
  })

  it('RAISES when the first thing we ever see is the bad state', () => {
    expect(
      decideAlert({
        previous: undefined,
        alerting: true,
        nowMs: 5_000,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'raise' })
  })
})

describe('decideAlert — a repeat of the held state is silence', () => {
  it('says nothing when the band has not moved and no reminder is due', () => {
    expect(
      decideAlert({
        previous: row({ lastNotifiedAt: 1_000 }),
        alerting: true,
        nowMs: 1_000 + 5 * MIN,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'silent' })
  })

  it('says nothing on a repeat of the good state', () => {
    expect(
      decideAlert({
        previous: row({ alerting: false }),
        alerting: false,
        nowMs: 9_000_000,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'silent' })
  })
})

describe('decideAlert — the reminder', () => {
  it('reminds once the interval has elapsed, numbering the reminder', () => {
    expect(
      decideAlert({
        previous: row({ lastNotifiedAt: 1_000, reminders: 0 }),
        alerting: true,
        nowMs: 1_000 + 60 * MIN,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'remind', reminderIndex: 1 })
  })

  it('numbers consecutive reminders 1, 2, 3 — never repeating one', () => {
    expect(
      decideAlert({
        previous: row({ lastNotifiedAt: 1_000, reminders: 2 }),
        alerting: true,
        nowMs: 1_000 + 60 * MIN,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'remind', reminderIndex: 3 })
  })

  it('never reminds when the interval is 0 — the operator switched it off', () => {
    expect(
      decideAlert({
        previous: row({ lastNotifiedAt: 1_000 }),
        alerting: true,
        nowMs: 1_000 + 400 * MIN,
        renotifyMs: 0,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'silent' })
  })

  it('never reminds about a state that is no longer alerting', () => {
    expect(
      decideAlert({
        previous: row({ alerting: false, lastNotifiedAt: 1_000 }),
        alerting: false,
        nowMs: 1_000 + 400 * MIN,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'silent' })
  })
})

describe('decideAlert — the recovery honours its flag', () => {
  it('recovers when the flag is on', () => {
    expect(
      decideAlert({
        previous: row({ alerting: true }),
        alerting: false,
        nowMs: 500_000,
        renotifyMs: 60 * MIN,
        notifyRecovery: true,
      }),
    ).toEqual({ kind: 'recover' })
  })

  it('is SILENT when the flag is off — but the state still moves', () => {
    const verdict = decideAlert({
      previous: row({ alerting: true }),
      alerting: false,
      nowMs: 500_000,
      renotifyMs: 60 * MIN,
      notifyRecovery: false,
    })
    expect(verdict).toEqual({ kind: 'silent' })
    // The row must still flip, or the next fall below the threshold would be a
    // repeat of a state we never left and would never be announced.
    expect(nextAlertRow(SUBJECT, row({ alerting: true }), false, verdict, 500_000)).toMatchObject({
      alerting: false,
      reminders: 0,
    })
  })
})

describe('nextAlertRow — the row that survives the verdict', () => {
  it('opens a new episode on a raise, resetting the reminder count', () => {
    const next = nextAlertRow(
      SUBJECT,
      row({ alerting: false, reminders: 4 }),
      true,
      {
        kind: 'raise',
      },
      900_000,
    )
    expect(next).toEqual({
      subject: SUBJECT,
      alerting: true,
      since: 900_000,
      lastNotifiedAt: 900_000,
      reminders: 0,
    })
  })

  it('advances lastNotifiedAt and the counter on a reminder, keeping `since`', () => {
    const next = nextAlertRow(
      SUBJECT,
      row({ since: 1_000, lastNotifiedAt: 1_000, reminders: 0 }),
      true,
      { kind: 'remind', reminderIndex: 1 },
      1_000 + 60 * MIN,
    )
    expect(next).toEqual({
      subject: SUBJECT,
      alerting: true,
      since: 1_000,
      lastNotifiedAt: 1_000 + 60 * MIN,
      reminders: 1,
    })
  })

  it('does NOT advance lastNotifiedAt on a silent repeat', () => {
    const previous = row({ lastNotifiedAt: 1_000 })
    const next = nextAlertRow(SUBJECT, previous, true, { kind: 'silent' }, 999_000)
    expect(next.lastNotifiedAt).toBe(1_000)
  })

  it('seeds a cold row without claiming it was notified', () => {
    const next = nextAlertRow(SUBJECT, undefined, false, { kind: 'seeded' }, 7_000)
    expect(next).toEqual({
      subject: SUBJECT,
      alerting: false,
      since: 7_000,
      lastNotifiedAt: 0,
      reminders: 0,
    })
  })
})

describe('alertRecordId — two reminders are never one outbox row', () => {
  it('gives the opening notification an id scoped to the episode', () => {
    expect(alertRecordId(SUBJECT, 1_000, 0)).toBe('battery:3602:1000')
  })

  it('gives every reminder a DIFFERENT id', () => {
    const first = alertRecordId(SUBJECT, 1_000, 1)
    const second = alertRecordId(SUBJECT, 1_000, 2)
    expect(first).not.toBe(second)
    expect(first).not.toBe(alertRecordId(SUBJECT, 1_000, 0))
  })

  it('separates two episodes of the same subject', () => {
    expect(alertRecordId(SUBJECT, 1_000, 0)).not.toBe(alertRecordId(SUBJECT, 2_000, 0))
  })
})
