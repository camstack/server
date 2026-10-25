/**
 * D692 Task 8 — the grouped branch of the REAL centre: admission (match or candidate),
 * the cooldown at OPEN only, promotion through the label hook, fusion, the 5 s floor of the
 * early close and the deadline. The close pass itself (the final verdict, the one enqueue)
 * is `grouped-immediate.spec.ts` (Task 9a): here a close is observed through its
 * `grouped window closed` line.
 */

import { makeNcRecords, withNcFaults } from './support/nc-test-deps.js'
import { ncRecordKinds } from '../record-kinds.js'
import type { ObjectEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { incomingFromObjectEvent } from '../event-intake.js'
import { NcGroupedDelivery } from '../grouped/grouped-delivery.js'
import { NcRuleStore } from '../rule-store.js'
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

const IDENTITY_B = { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-b' } as const

function withoutTrack(ev: ObjectEvent): ObjectEvent {
  const { trackId: _dropped, ...rest } = ev
  return rest
}

describe('grouped admission (D692 Task 8)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('1. an unrecognised person opens a window as a CANDIDATE of an identity rule', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['person'], identities: ['id-a'] } }))

    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()

    expect(outboxIds(h.world)).toHaveLength(0)
    const opened = h.linesOf('grouped window opened')
    expect(opened).toHaveLength(1)
    expect(opened[0]?.tags['deviceId']).toBe(DEVICE)
    expect(opened[0]?.meta['matched']).toBe(false)
    expect(opened[0]?.meta['awaiting']).toBe('face-unseen')
    expect(opened[0]?.meta['trackId']).toBe('trk-1')
    const windows = h.center.groupedOpenWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.members).toHaveLength(1)
    expect(windows[0]?.members[0]?.matched).toBe(false)
  })

  it('2. a FINAL unrecognised person is not a candidate — the plain non-match report', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['person'], identities: ['id-a'] } }))
    h.outlooks.set('trk-1', { final: true })

    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()

    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    expect(h.linesOf('grouped window opened')).toHaveLength(0)
    const miss = h.linesOf('rule did not match')
    expect(miss).toHaveLength(1)
    expect(miss[0]?.meta['failed']).toBe('identities')
  })

  it('2b. a person recognised as SOMEONE ELSE is final: no window, failedCondition identities', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['person'], identities: ['id-a'] } }))

    h.center.onObjectEventPersisted(
      event({ trackId: 'trk-1', subLabel: 'Person B', subLabelMeta: IDENTITY_B }),
    )
    await h.settle()

    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    const miss = h.linesOf('rule did not match')
    expect(miss).toHaveLength(1)
    expect(miss[0]?.meta['failed']).toBe('identities')
  })

  it('3. a second subject JOINS without a cooldown check', async () => {
    h = makeHarness()
    await boot(h, rule({ throttle: { cooldownSec: 600, scope: 'rule-device' } }))

    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()
    // The person key is stamped AFTER the window opened (review T8 M-3): an event without
    // a track takes the plain path (C17) and consumes the rule's person window.
    h.setNow(T0 + 1_000)
    h.center.onObjectEventPersisted(withoutTrack(event({ timestamp: T0 + 1_000 })))
    await h.settle()
    expect(outboxIds(h.world)).toHaveLength(1)

    h.setNow(T0 + 2_000)
    h.center.onObjectEventPersisted(event({ trackId: 'trk-2', timestamp: T0 + 2_000 }))
    await h.settle()
    expect(h.linesOf('rule matched but is cooling down')).toHaveLength(0)

    const windows = h.center.groupedOpenWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.members.map((m) => m.trackId)).toEqual(['trk-1', 'trk-2'])
    expect(h.linesOf('grouped window: subject joined')).toHaveLength(1)
  })

  it('4. a cooling class cannot OPEN a window', async () => {
    h = makeHarness()
    await boot(h, rule({ throttle: { cooldownSec: 600, scope: 'rule-device' } }))

    // An event WITHOUT a track takes the plain path (C17) — and stamps the rule's key.
    h.center.onObjectEventPersisted(withoutTrack(event()))
    await h.settle()
    expect(outboxIds(h.world)).toHaveLength(1)
    expect(
      h.linesOf('grouped rule: event without a track — delivered as plain immediate'),
    ).toHaveLength(1)

    h.setNow(T0 + 5_000)
    h.center.onObjectEventPersisted(event({ trackId: 'trk-1', timestamp: T0 + 5_000 }))
    await h.settle()

    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    const cooling = h.linesOf('rule matched but is cooling down')
    expect(cooling).toHaveLength(1)
    expect(cooling[0]?.meta['trackId']).toBe('trk-1')
  })

  it('5. a promotion re-evaluates the member and runs the actions ONCE, at the match', async () => {
    h = makeHarness()
    await boot(
      h,
      rule({
        conditions: { classes: ['person'], identities: ['id-a'] },
        actions: {
          onTrigger: [
            {
              kind: 'do',
              action: { kind: 'cap', deviceId: 42, cap: 'switch', method: 'turnOn' },
            },
          ],
        },
      }),
    )

    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()
    expect(h.actuations).toHaveLength(0)

    h.center.onTrackLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-1',
      change: 'accepted',
      label: { label: 'Person A', labelKind: 'identity', identityId: 'id-a' },
    })
    await h.settle()

    const promoted = h.linesOf('grouped window: subject promoted')
    expect(promoted).toHaveLength(1)
    expect(promoted[0]?.meta['nowMatched']).toBe(true)
    expect(promoted[0]?.meta['to']).toBe('Person A')
    expect(promoted[0]?.tags['deviceId']).toBe(DEVICE)
    await vi.waitFor(() => {
      expect(h.actuations).toEqual([{ deviceId: 42, method: 'turnOn' }])
    })
    // Another event of the now-matched member runs nothing more: it is an update.
    h.center.onObjectEventPersisted(
      event({ trackId: 'trk-1', timestamp: T0 + 1_000, subLabel: 'Person A' }),
    )
    await h.settle()
    await new Promise((r) => setTimeout(r, 20))
    expect(h.actuations).toHaveLength(1)
  })

  it('6. the hooks ride the serialized chain: a promotion and a fusion fired right after the events land on the window', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['person'], identities: ['id-a'] } }))

    // All synchronous: the events are still queued on the chain when the hooks fire.
    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    h.center.onObjectEventPersisted(event({ trackId: 'trk-2' }))
    h.center.onTrackLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-1',
      change: 'accepted',
      label: { label: 'Person A', labelKind: 'identity', identityId: 'id-a' },
    })
    h.center.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-1', absorbedId: 'trk-2' })
    await h.settle()

    // Applied to the MEMBER, after its admission — not to a window that did not exist.
    expect(h.linesOf('grouped window: subject promoted')).toHaveLength(1)
    expect(h.linesOf('grouped window: members fused')).toHaveLength(1)
    const windows = h.center.groupedOpenWindows()
    expect(windows[0]?.members).toHaveLength(1)
    expect(windows[0]?.members[0]?.subject.identityId).toBe('id-a')
  })

  it('7. a fusion merges two members into one', async () => {
    h = makeHarness()
    await boot(h)

    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    h.center.onObjectEventPersisted(event({ trackId: 'trk-2', timestamp: T0 + 500 }))
    await h.settle()
    expect(h.center.groupedOpenWindows()[0]?.members).toHaveLength(2)

    h.center.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-1', absorbedId: 'trk-2' })
    await h.settle()

    const fused = h.linesOf('grouped window: members fused')
    expect(fused).toHaveLength(1)
    expect(fused[0]?.meta['membersBefore']).toBe(2)
    expect(fused[0]?.meta['membersAfter']).toBe(1)
    expect(fused[0]?.tags['deviceId']).toBe(DEVICE)
    expect(h.center.groupedOpenWindows()[0]?.members).toHaveLength(1)
  })

  it('8. the early close waits for the 5 s floor (C3)', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['dog'] } }))
    h.outlooks.set('trk-d', { final: true })

    h.center.onObjectEventPersisted(event({ trackId: 'trk-d', className: 'dog' }))
    await h.settle()
    expect(h.linesOf('grouped window closed')).toHaveLength(0)

    await h.tick(T0 + 4_000)
    expect(h.linesOf('grouped window closed')).toHaveLength(0)
    expect(h.center.groupedOpenWindows()).toHaveLength(1)

    await h.tick(T0 + 5_000)
    const closed = h.linesOf('grouped window closed')
    expect(closed).toHaveLength(1)
    expect(closed[0]?.meta['closeReason']).toBe('all-final')
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
  })

  it('9. a window with a pending member closes at its deadline', async () => {
    h = makeHarness()
    await boot(h)

    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()

    await h.tick(T0 + 19_000)
    expect(h.linesOf('grouped window closed')).toHaveLength(0)

    await h.tick(T0 + 20_000)
    const closed = h.linesOf('grouped window closed')
    expect(closed).toHaveLength(1)
    expect(closed[0]?.meta['closeReason']).toBe('deadline')
    expect(closed[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('a track close makes its member FINAL: past the floor the window closes all-final (spec §4)', async () => {
    h = makeHarness()
    await boot(h)

    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()
    await h.tick(T0 + 6_000)
    expect(h.linesOf('grouped window closed')).toHaveLength(0)

    h.center.onTrackClosed(track({ trackId: 'trk-1', lastSeen: T0 + 6_000 }), [])
    await h.settle()
    const closed = h.linesOf('grouped window closed')
    expect(closed).toHaveLength(1)
    expect(closed[0]?.meta['closeReason']).toBe('all-final')
  })

  it('a rule WITHOUT groupingSec takes the plain path, unchanged', async () => {
    h = makeHarness()
    await boot(h, rule({ groupingSec: undefined }))
    h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
    await h.settle()
    expect(outboxIds(h.world)).toHaveLength(1)
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    expect(h.linesOf('grouped window opened')).toHaveLength(0)
  })

  describe('review T8 round 1', () => {
    it('M-2: a grouped admission that THROWS skips only its rule — a plain rule still fires', async () => {
      h = makeHarness()
      await boot(h)
      await h.center
        .buildProvider()
        .createRule({ rule: rule({ name: 'plain', groupingSec: undefined }), caller: CALLER })
      const spy = vi
        .spyOn(NcGroupedDelivery.prototype, 'admit')
        .mockRejectedValueOnce(new Error('boom'))

      h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
      await h.settle()
      spy.mockRestore()

      expect(outboxIds(h.world)).toHaveLength(1)
      const failed = h.linesOf('grouped admission failed — the rule is skipped for this event')
      expect(failed).toHaveLength(1)
      expect(failed[0]?.level).toBe('warn')
      expect(failed[0]?.tags['deviceId']).toBe(DEVICE)
    })

    it('M-2: a grouped track close that THROWS never stops the track-end rules', async () => {
      h = makeHarness()
      await boot(h, rule({ name: 'on leave', delivery: 'track-end', groupingSec: undefined }))
      const spy = vi
        .spyOn(NcGroupedDelivery.prototype, 'onTrackClosed')
        .mockRejectedValueOnce(new Error('boom'))

      h.center.onTrackClosed(track({ trackId: 'trk-1' }), [])
      await h.settle()
      spy.mockRestore()

      expect(outboxIds(h.world)).toHaveLength(1)
      const failed = h.linesOf('grouped track close failed — the track-end rules still run')
      expect(failed).toHaveLength(1)
      expect(failed[0]?.tags['deviceId']).toBe(DEVICE)
    })

    it('L-1: a CANDIDATE is reported as not matched, and pending', async () => {
      h = makeHarness()
      await boot(h, rule({ conditions: { classes: ['person'], identities: ['id-a'] } }))

      const report = await h.center.consumeEventAndReport(
        incomingFromObjectEvent(event({ trackId: 'trk-1' })),
      )
      expect(report.outcomes).toHaveLength(1)
      expect(report.outcomes[0]).toMatchObject({ matched: false, pending: true, grouped: 'opened' })
    })

    it('L-2: a stored grouped rule the grouping cannot apply to is said at rule LOAD', async () => {
      // A STORED rule, as one written before the save guard (D692 §2.2): the guard refuses
      // this shape on both save routes, and the store itself never judges it on load.
      const first = makeHarness()
      await new NcRuleStore({
        kind: first.world.records.kind(ncRecordKinds.rules),
        logger: makeSilentLogger(),
      }).create(rule({ name: 'on leave', delivery: 'track-end' }), 'admin')

      h = makeHarness({ world: first.world })
      await h.center.start({ evaluation: true })
      await h.center.whenHydrated()

      const inert = h.linesOf('grouped rule cannot group this kind — groupingSec ignored')
      expect(inert).toHaveLength(1)
      expect(inert[0]?.meta['rule']).toBe('on leave')
    })

    it('L-3: while the chain is stalled, drain ticks queue ONE sweep, not one each', async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let stalled = false
      h = makeHarness({
        world: withNcFaults(makeNcRecords(), {
          aroundWrite: async (kind) => {
            if (stalled && kind === 'outbox') await gate
          },
        }),
      })
      await boot(h)
      h.outlooks.set('trk-1', { final: true })
      h.center.onObjectEventPersisted(event({ trackId: 'trk-1' }))
      await h.settle()

      stalled = true
      const sweeps = vi.spyOn(NcGroupedDelivery.prototype, 'sweep')

      h.setNow(T0 + 5_000)
      await h.center.drainNow()
      await new Promise((r) => setTimeout(r, 10))
      await h.center.drainNow()
      await h.center.drainNow()
      await h.center.drainNow()
      release()
      await new Promise((r) => setTimeout(r, 20))

      // The first sweep (stalled on the enqueue) and ONE queued behind it.
      expect(sweeps).toHaveBeenCalledTimes(2)
      sweeps.mockRestore()
    })
  })
})
