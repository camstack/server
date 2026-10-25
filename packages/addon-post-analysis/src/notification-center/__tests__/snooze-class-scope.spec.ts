/**
 * A snooze is about a CAMERA and a KIND OF THING — not about a rule.
 *
 * "Silence the cat on the courtyard camera" is the sentence an operator
 * actually says, and it crosses every rule that matches a cat: they do not
 * know, and should not have to know, which of their four rules produced the
 * notification they are dismissing. So the window's key is
 * `(deviceId, classes[])` and `ruleId` is provenance.
 *
 * Every assertion below has a CONTROL that must still be silenced (or still
 * delivered), so "the gate is off" can never make the file pass.
 */

import type { NcSnooze } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { activeSnoozeFor, isSnoozed, type SnoozeQuery } from '../snooze-policy.js'

const T0 = 1_800_000_000_000

function window(over: Partial<NcSnooze> = {}): NcSnooze {
  return {
    id: 'w1',
    userId: 'bob',
    scope: 'device',
    deviceId: 102,
    startedAt: T0,
    expiresAt: T0 + 3_600_000,
    global: false,
    summary: true,
    ...over,
  }
}

function query(over: Partial<SnoozeQuery> = {}): SnoozeQuery {
  return { nowMs: T0 + 60_000, userId: 'bob', ruleId: 'rule-1', deviceId: 102, ...over }
}

describe('a classed window silences only that class', () => {
  it('silences the class it names', () => {
    expect(isSnoozed([window({ classes: ['cat'] })], query({ className: 'cat' }))).toBe(true)
  })

  it('does NOT silence another class on the same camera', () => {
    expect(isSnoozed([window({ classes: ['cat'] })], query({ className: 'person' }))).toBe(false)
  })

  it('matches ANY of several named classes', () => {
    const w = [window({ classes: ['cat', 'dog'] })]
    expect(isSnoozed(w, query({ className: 'dog' }))).toBe(true)
    expect(isSnoozed(w, query({ className: 'bird' }))).toBe(false)
  })

  it('silences a class REGARDLESS of which rule matched it', () => {
    // The whole point of keying on (device, class): the window was opened from
    // one rule's notification and covers the other rule too.
    const w = [window({ classes: ['cat'], ruleId: 'rule-1' })]
    expect(isSnoozed(w, query({ ruleId: 'rule-9', className: 'cat' }))).toBe(true)
  })
})

describe('a window with no classes is what it always was', () => {
  it('silences every class — the retro-compatible reading of an absent field', () => {
    const w = [window()]
    expect(isSnoozed(w, query({ className: 'cat' }))).toBe(true)
    expect(isSnoozed(w, query({ className: 'person' }))).toBe(true)
    expect(isSnoozed(w, query())).toBe(true)
  })

  it('treats an EMPTY list as absent, never as "matches nothing"', () => {
    expect(isSnoozed([window({ classes: [] })], query({ className: 'cat' }))).toBe(true)
  })
})

describe('a subject with no class fails toward DELIVERING', () => {
  it('a classed window never silences a subject that carries no class', () => {
    // A doorbell press, an occupancy edge, a node going offline. "Silence the
    // cat" is a statement about detections; reading it as covering those would
    // silence things the operator never pointed at.
    expect(isSnoozed([window({ classes: ['cat'] })], query())).toBe(false)
  })

  it('CONTROL — the same subject IS silenced by an unclassed window', () => {
    expect(isSnoozed([window()], query())).toBe(true)
  })
})

describe('breadth — a classed window is narrower at equal scope', () => {
  it('the UNCLASSED window owns the silence when both cover it', () => {
    // The broad window would have hidden this notification anyway; letting the
    // narrow one claim it would leave the broad window's digest reporting a
    // suppression it did not perform.
    const narrow = window({ id: 'narrow', classes: ['cat'] })
    const broad = window({ id: 'broad' })
    expect(activeSnoozeFor([narrow, broad], query({ className: 'cat' }))?.id).toBe('broad')
    expect(activeSnoozeFor([broad, narrow], query({ className: 'cat' }))?.id).toBe('broad')
  })

  it('a broader SCOPE still wins over a narrower one, classed or not', () => {
    const ruleClassed = window({ id: 'rule', scope: 'rule', ruleId: 'rule-1', classes: ['cat'] })
    const deviceClassed = window({ id: 'device', classes: ['cat'] })
    expect(activeSnoozeFor([ruleClassed, deviceClassed], query({ className: 'cat' }))?.id).toBe(
      'device',
    )
    const all = window({ id: 'all', scope: 'all', classes: ['cat'] })
    expect(activeSnoozeFor([deviceClassed, all], query({ className: 'cat' }))?.id).toBe('all')
  })

  it('the classed window is used when it is the ONLY one covering', () => {
    const narrow = window({ id: 'narrow', classes: ['cat'] })
    const otherClass = window({ id: 'other', classes: ['person'] })
    expect(activeSnoozeFor([narrow, otherClass], query({ className: 'cat' }))?.id).toBe('narrow')
  })
})
