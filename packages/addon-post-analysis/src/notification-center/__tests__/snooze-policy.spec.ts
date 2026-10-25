/**
 * Snooze — who it silences, for how long, and what happens to what it hides.
 *
 * Operator decisions, 2026-08-04:
 *  - PERSONAL by default: it silences the caller's own delivery, never anyone
 *    else's. "I am asleep" is not "nobody needs to know".
 *  - a per-rule setting can make a snooze GLOBAL for that whole rule, default
 *    OFF — the "the gardener is here all afternoon" case, which has to be
 *    deliberate because it silences other people.
 *  - a SUMMARY of what was suppressed is delivered when the window ends,
 *    default ON. Someone silencing a nuisance camera wants it off; someone
 *    silencing a SECURITY camera wants it on. Getting that backwards turns a
 *    snooze into an outage, which is why it is a setting.
 */
import { describe, expect, it } from 'vitest'
import {
  activeSnoozeFor,
  canSetGlobal,
  isSnoozed,
  type SnoozeEntry,
  type SnoozeQuery,
} from '../snooze-policy.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function entry(overrides: Partial<SnoozeEntry> = {}): SnoozeEntry {
  return {
    id: 's1',
    userId: 'alice',
    scope: 'rule',
    ruleId: 'r1',
    startedAt: NOW - HOUR,
    expiresAt: NOW + HOUR,
    global: false,
    summary: true,
    ...overrides,
  }
}

function query(overrides: Partial<SnoozeQuery> = {}): SnoozeQuery {
  return { nowMs: NOW, userId: 'alice', ruleId: 'r1', deviceId: 101, ...overrides }
}

describe('isSnoozed — personal by default', () => {
  it('silences the person who set it', () => {
    expect(isSnoozed([entry()], query())).toBe(true)
  })

  it('does NOT silence anyone else — that is the whole point of personal', () => {
    expect(isSnoozed([entry()], query({ userId: 'bob' }))).toBe(false)
  })

  it('silences EVERYONE when the rule opted into a global snooze', () => {
    expect(isSnoozed([entry({ global: true })], query({ userId: 'bob' }))).toBe(true)
  })
})

describe('isSnoozed — the window', () => {
  it('is over the moment it expires, without anything having to run', () => {
    // Expiry is a comparison, not a job. A snooze that needed a sweeper to end
    // would outlive the sweeper's next failure.
    expect(isSnoozed([entry({ expiresAt: NOW - 1 })], query())).toBe(false)
  })

  it('has not started yet is not snoozed', () => {
    expect(isSnoozed([entry({ startedAt: NOW + HOUR, expiresAt: NOW + 2 * HOUR })], query())).toBe(
      false,
    )
  })

  it('is inclusive at the start and exclusive at the end', () => {
    expect(isSnoozed([entry({ startedAt: NOW, expiresAt: NOW + 1 })], query())).toBe(true)
    expect(isSnoozed([entry({ startedAt: NOW - 1, expiresAt: NOW })], query())).toBe(false)
  })
})

describe('isSnoozed — scope', () => {
  it('a rule snooze silences only that rule', () => {
    expect(isSnoozed([entry({ scope: 'rule', ruleId: 'r1' })], query({ ruleId: 'r2' }))).toBe(false)
  })

  it('a device snooze silences every rule for that camera', () => {
    const e = entry({ scope: 'device', deviceId: 101 })
    expect(isSnoozed([e], query({ ruleId: 'any-rule' }))).toBe(true)
    expect(isSnoozed([e], query({ deviceId: 102 }))).toBe(false)
  })

  it('an "all" snooze silences the whole feed', () => {
    const e = entry({ scope: 'all' })
    expect(isSnoozed([e], query({ ruleId: 'anything', deviceId: 999 }))).toBe(true)
  })

  it('ignores an entry whose scope names something it has no id for', () => {
    // A device-scoped row with no deviceId cannot mean "every device" by
    // accident — that would silence the whole feed from a malformed row.
    const broken = entry({ scope: 'device' })
    delete (broken as { deviceId?: number }).deviceId
    expect(isSnoozed([broken], query())).toBe(false)
  })
})

describe('activeSnoozeFor — what the summary is built from', () => {
  it('returns the entry that silenced the notification, so the digest knows where to go', () => {
    const e = entry()
    expect(activeSnoozeFor([e], query())?.id).toBe('s1')
  })

  it('returns null when nothing silences it', () => {
    expect(activeSnoozeFor([entry()], query({ userId: 'bob' }))).toBeNull()
  })

  it('prefers the BROADEST match, so one digest covers the window', () => {
    // An "all" snooze and a rule snooze overlapping should not produce two
    // digests for the same silence.
    const all = entry({ id: 'all', scope: 'all' })
    const rule = entry({ id: 'rule', scope: 'rule' })
    expect(activeSnoozeFor([rule, all], query())?.id).toBe('all')
  })

  it('a summary:false entry still silences — it just leaves no digest behind', () => {
    const e = entry({ summary: false })
    expect(isSnoozed([e], query())).toBe(true)
    expect(activeSnoozeFor([e], query())?.summary).toBe(false)
  })
})

describe('isSnoozed — a target nobody owns', () => {
  // A shared destination (a household ntfy topic, an admin webhook) has no
  // owner, so there is no "person who set it" for a personal snooze to silence.
  // The safe failure of a snooze is DELIVERING, never silencing more.
  it('is not silenced by anyone personal snooze', () => {
    const unowned = query({})
    delete (unowned as { userId?: string }).userId
    expect(isSnoozed([entry()], unowned)).toBe(false)
  })

  it('IS silenced by a global one — that is what global means', () => {
    const unowned = query({})
    delete (unowned as { userId?: string }).userId
    expect(isSnoozed([entry({ global: true })], unowned)).toBe(true)
  })
})

describe('canSetGlobal — the only part that touches other people', () => {
  it('lets a rule that opted in be silenced for everyone', () => {
    expect(canSetGlobal({ scope: 'rule', ruleAllowsGlobal: true, isAdmin: false })).toBe(true)
  })

  it('refuses when the rule did not opt in — default OFF, deliberately', () => {
    expect(canSetGlobal({ scope: 'rule', ruleAllowsGlobal: false, isAdmin: false })).toBe(false)
  })

  it('refuses when the rule is UNKNOWN — an absent rule is not permission', () => {
    expect(canSetGlobal({ scope: 'rule', isAdmin: false })).toBe(false)
  })

  it('refuses a non-admin silencing a whole camera or the whole feed', () => {
    // No rule carries the opt-in for these scopes, and "silence this camera for
    // the household" is an administrative act.
    expect(canSetGlobal({ scope: 'device', ruleAllowsGlobal: true, isAdmin: false })).toBe(false)
    expect(canSetGlobal({ scope: 'all', ruleAllowsGlobal: true, isAdmin: false })).toBe(false)
  })

  it('lets an admin set any of them', () => {
    expect(canSetGlobal({ scope: 'all', isAdmin: true })).toBe(true)
    expect(canSetGlobal({ scope: 'device', isAdmin: true })).toBe(true)
  })
})
