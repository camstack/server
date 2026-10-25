/**
 * D692 Task 9a, review round 1 (reviewer opus): the notified set is not a 30-minute clock on a
 * track that is still in view (M-1), a window with nobody to tell says so (L-1), the
 * unreadable-owner path of the close is pinned (L-2, deviation 6 of the T9a report).
 */

import type { ObjectEvent } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { NcTargetRef } from '../dispatcher.js'
import {
  boot,
  CALLER,
  DEVICE,
  event,
  type Harness,
  makeHarness,
  outboxIds,
  rule,
  T0,
  track,
} from './grouped-harness.js'

const MINUTE = 60_000

function seen(h: Harness, ev: Partial<ObjectEvent>): void {
  h.center.onObjectEventPersisted(event(ev))
}

const OWNED_TARGETS: readonly NcTargetRef[] = [
  { id: 'tgt-1', addonId: 'notifiers', name: 'household', kind: 'ntfy', enabled: true },
  {
    id: 'tgt-2',
    addonId: 'notifiers',
    name: 'admin phone',
    kind: 'ntfy',
    enabled: true,
    ownerUserId: CALLER.userId,
  },
]

describe('grouped close — review T9a round 1', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('M-1: a notified track in view for 40 minutes is notified ONCE', async () => {
    h = makeHarness()
    await boot(h)
    h.outlooks.set('trk-1', { final: true })
    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 5_000)
    expect(outboxIds(h.world)).toHaveLength(1)

    for (let minute = 1; minute <= 40; minute += 1) {
      const at = T0 + minute * MINUTE
      h.setNow(at)
      seen(h, { trackId: 'trk-1', timestamp: at })
      await h.settle()
      await h.tick(at + 5_000)
    }

    expect(outboxIds(h.world)).toHaveLength(1)
    expect(h.linesOf('grouped window opened')).toHaveLength(1)
  })

  it('M-1: a judged stranger in view for 40 minutes opens ONE window and is said once', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['person'], identities: ['id-a'] } }))
    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 20_000)
    expect(h.linesOf('grouped member dropped — recognition-not-final')).toHaveLength(1)

    for (let minute = 1; minute <= 40; minute += 1) {
      const at = T0 + 20_000 + minute * MINUTE
      h.setNow(at)
      seen(h, { trackId: 'trk-1', timestamp: at })
      await h.settle()
      await h.tick(at + 1_000)
    }

    expect(h.linesOf('grouped window opened')).toHaveLength(1)
    expect(
      h.linesOf('grouped window: not re-opened — the track was judged unrecognised for this rule'),
    ).toHaveLength(1)
  })

  it('M-1: a track CLOSE ends the notified entry (the TTL is only the backstop)', async () => {
    h = makeHarness()
    await boot(h, rule({ throttle: { cooldownSec: 0, scope: 'rule-device' } }))
    h.outlooks.set('trk-1', { final: true })
    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 5_000)
    expect(outboxIds(h.world)).toHaveLength(1)

    // Still notified while the track lives.
    h.setNow(T0 + 6_000)
    seen(h, { trackId: 'trk-1', timestamp: T0 + 6_000 })
    await h.settle()
    expect(h.linesOf('grouped window opened')).toHaveLength(1)

    h.center.onTrackClosed(track({ trackId: 'trk-1', lastSeen: T0 + 6_500 }), [])
    await h.settle()
    h.setNow(T0 + 7_000)
    seen(h, { trackId: 'trk-1', timestamp: T0 + 7_000 })
    await h.settle()
    expect(h.linesOf('grouped window opened')).toHaveLength(2)
  })

  it('L-1: a window with NO target says so, and never claims the rows already existed', async () => {
    h = makeHarness()
    // Addressed to a user only, and the user fan-out is not wired here: no target resolves.
    await boot(h, rule({ targets: [], targetUsers: ['someone'] }))
    h.outlooks.set('trk-1', { final: true })
    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 5_000)

    expect(outboxIds(h.world)).toHaveLength(0)
    const none = h.linesOf('grouped window closed with NO notification')
    expect(none).toHaveLength(1)
    expect(none[0]?.meta['reason']).toBe('no-target')
    expect(none[0]?.tags['deviceId']).toBe(DEVICE)
    expect(typeof none[0]?.meta['windowKey']).toBe('string')
    expect(
      h.lines.filter((l) => l.msg.startsWith('grouped window closed — every row already existed')),
    ).toHaveLength(0)
  })

  describe('L-2: the owner of a target cannot be read (T9a deviation 6)', () => {
    let readable = true
    const build = (): Harness =>
      makeHarness({
        targets: OWNED_TARGETS,
        listTargets: async () => {
          if (!readable) throw new Error('catalog unreachable')
          return OWNED_TARGETS
        },
      })

    it('a PERSONAL snooze is left to the send gate: the rows are written, and the line names rule and window', async () => {
      readable = true
      h = build()
      const ruleId = await boot(
        h,
        rule({ targets: [{ targetId: 'tgt-1' }, { targetId: 'tgt-2' }] }),
      )
      seen(h, { trackId: 'trk-1' })
      await h.settle()
      await h.center.createSnooze(
        { scope: 'rule', ruleId, durationMinutes: 60, global: false, summary: false },
        CALLER,
      )
      readable = false
      await h.tick(T0 + 20_000)

      expect(outboxIds(h.world)).toHaveLength(2)
      const said = h.linesOf(
        'grouped close: target owner unreadable — personal snoozes left to the send gate',
      )
      expect(said.length).toBeGreaterThan(0)
      expect(said[0]?.tags['deviceId']).toBe(DEVICE)
      expect(said[0]?.meta['ruleId']).toBe(ruleId)
      expect(said[0]?.meta['rule']).toBe('persone su uscio')
      expect(typeof said[0]?.meta['windowKey']).toBe('string')
    })

    it('a GLOBAL snooze still covers: no row', async () => {
      readable = true
      h = build()
      const ruleId = await boot(
        h,
        rule({ targets: [{ targetId: 'tgt-1' }, { targetId: 'tgt-2' }] }),
      )
      seen(h, { trackId: 'trk-1' })
      await h.settle()
      await h.center.createSnooze(
        { scope: 'rule', ruleId, durationMinutes: 60, global: true, summary: false },
        CALLER,
      )
      readable = false
      await h.tick(T0 + 20_000)

      expect(outboxIds(h.world)).toHaveLength(0)
      const none = h.linesOf('grouped window closed with NO notification')
      expect(none).toHaveLength(1)
      expect(none[0]?.meta['reason']).toBe('rule-snoozed-at-close')
    })
  })
})
