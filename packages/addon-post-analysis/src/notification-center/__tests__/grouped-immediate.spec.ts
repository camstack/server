/**
 * D692 Task 9a — the grouped CLOSE PASS on the real centre: the final verdict per member,
 * ONE outbox row per target with `dedupRef = windowKey`, the cooldown stamped per class at
 * close, the notified set (once per track per rule), the judged set (C10, operator ruling
 * 2026-10-02), the mute re-check, and "snoozed at close" judged with the instant path's own
 * `snoozeVerdict`, per target (C4, controller ruling 2026-10-02 for several targets).
 *
 * Spec §11 center tests 1–7, 9 and 12–16; test 8 of §11 (restart) is Task 10's, tests 10
 * and 11 (shutdown, record) are Task 9b's.
 */

import type { NcRuleInput, ObjectEvent } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import type { NcTargetRef } from '../dispatcher.js'
import { isGroupV2 } from '../grouped/grouped-payload.js'
import { type NcOutboxPayload } from '../outbox.js'
import { makeNcRecords, ncTable, withNcFaults } from './support/nc-test-deps.js'
import {
  boot,
  CALLER,
  DEVICE,
  event,
  type Harness,
  makeHarness,
  outboxIds,
  payloads,
  rule,
  T0,
  track,
} from './grouped-harness.js'

const PERSON_A_META = { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-a' } as const
const IDENTITY_RULE = { classes: ['person'], identities: ['id-a'] }
const PERSON_A_LABEL = { label: 'Person A', labelKind: 'identity', identityId: 'id-a' } as const
const PERSON_B_LABEL = { label: 'Person B', labelKind: 'identity', identityId: 'id-b' } as const

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

type SnoozeInput = Parameters<Harness['center']['createSnooze']>[0]

/** One "snoozed at close" kind (C4): the window it opens and the scope it reports. */
interface SnoozeCase {
  readonly name: string
  readonly input: (ruleId: string) => SnoozeInput
  readonly scope: string
}

function groupOf(payload: NcOutboxPayload | undefined) {
  const group = payload?.group
  if (group === undefined || !isGroupV2(group)) throw new Error('no v2 group on the row')
  return group
}

function accept(h: Harness, trackId: string, label: typeof PERSON_A_LABEL | typeof PERSON_B_LABEL) {
  h.center.onTrackLabelChanged({ deviceId: DEVICE, trackId, change: 'accepted', label })
}

function seen(h: Harness, ev: Partial<ObjectEvent>): void {
  h.center.onObjectEventPersisted(event(ev))
}

async function snooze(h: Harness, input: SnoozeInput): Promise<string> {
  const created = await h.center.createSnooze(input, CALLER)
  return created.id
}

describe('grouped close pass (D692 Task 9a)', () => {
  let h: Harness
  afterEach(async () => {
    await h.center.stop()
  })

  it('1. the operator scenario: ONE row naming Person A and the stranger, closed all-final', async () => {
    h = makeHarness()
    await boot(h, rule({ groupingSec: 30 }))
    await h.center.textCatalogEditor.setLanguage('it')

    seen(h, { trackId: 'trk-1', timestamp: T0 })
    h.outlooks.set('trk-2', { final: false, awaiting: 'face' })
    h.setNow(T0 + 2_000)
    seen(h, { trackId: 'trk-2', timestamp: T0 + 2_000 })
    await h.settle()

    h.setNow(T0 + 11_000)
    accept(h, 'trk-1', PERSON_A_LABEL)
    await h.settle()
    expect(outboxIds(h.world)).toHaveLength(0)

    h.outlooks.set('trk-2', { final: true })
    await h.tick(T0 + 23_000)
    await h.tick(T0 + 23_500)

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    const group = groupOf(rows[0])
    expect(group.closeReason).toBe('all-final')
    expect(group.key).toBe(`grp:${group.key.split(':')[1]}:${DEVICE}:trk-1@${T0}`)
    expect(group.members.map((m) => m.label ?? m.className)).toEqual(['Person A', 'person'])
    expect(rows[0]?.subject.trackId).toBe('trk-1')
    expect(h.sends).toHaveLength(1)
    expect(h.sends[0]?.notification.body).toContain('Person A e 1 altra persona')
    const closed = h.linesOf('grouped window closed')
    expect(closed).toHaveLength(1)
    expect(closed[0]?.tags['deviceId']).toBe(DEVICE)
    expect(closed[0]?.meta['sent']).toBe(2)
  })

  it('1b. the row id is D694 outboxEntryId over dedupRef = windowKey (never spelled here)', async () => {
    h = makeHarness()
    const ruleId = await boot(h, rule({ conditions: { classes: ['dog'] } }))
    h.outlooks.set('trk-d', { final: true })
    seen(h, { trackId: 'trk-d', className: 'dog' })
    await h.settle()
    await h.tick(T0 + 5_000)

    expect(outboxIds(h.world)).toEqual([`${ruleId}:grp:${ruleId}:${DEVICE}:trk-d@${T0}:tgt-1`])
  })

  it('2. identity rule, never recognised: NO row, the member dropped as recognition-not-final', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: IDENTITY_RULE }))

    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 20_000)

    expect(outboxIds(h.world)).toHaveLength(0)
    const none = h.linesOf('grouped window closed with NO notification')
    expect(none).toHaveLength(1)
    expect(none[0]?.meta['reason']).toBe('every-member-dropped')
    expect(none[0]?.tags['deviceId']).toBe(DEVICE)
    const dropped = h.linesOf('grouped member dropped — recognition-not-final')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.meta['trackId']).toBe('trk-1')
    expect(dropped[0]?.meta['awaiting']).toBe('face-unseen')
    expect(dropped[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('3. operator decision 2: an identity rule names ONLY Person A, never the stranger', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: IDENTITY_RULE }))

    seen(h, { trackId: 'trk-1', subLabel: 'Person A', subLabelMeta: PERSON_A_META })
    seen(h, { trackId: 'trk-2', timestamp: T0 + 1_000 })
    await h.settle()
    await h.tick(T0 + 20_000)
    await h.tick(T0 + 20_500)

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    expect(groupOf(rows[0]).members.map((m) => m.trackId)).toEqual(['trk-1'])
    const body = h.sends[0]?.notification.body ?? ''
    expect(body).toContain('Person A')
    expect(body).not.toContain('altra')
  })

  it('4. identitiesExclude: a member later recognised as the excluded identity is dropped out of scope', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['person'], identitiesExclude: ['id-a'] } }))

    seen(h, { trackId: 'trk-1' })
    seen(h, { trackId: 'trk-2', timestamp: T0 + 1_000 })
    await h.settle()
    h.setNow(T0 + 3_000)
    accept(h, 'trk-1', PERSON_A_LABEL)
    await h.settle()
    await h.tick(T0 + 20_000)

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    expect(groupOf(rows[0]).members.map((m) => m.trackId)).toEqual(['trk-2'])
    const out = h.linesOf('grouped member dropped — recognised-out-of-scope')
    expect(out).toHaveLength(1)
    expect(out[0]?.meta['trackId']).toBe('trk-1')
  })

  it('5. a dog-only window is enqueued at the 5 s floor, not at the deadline', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: { classes: ['dog'] } }))
    h.outlooks.set('trk-d', { final: true })

    seen(h, { trackId: 'trk-d', className: 'dog' })
    await h.settle()
    await h.tick(T0 + 4_000)
    expect(outboxIds(h.world)).toHaveLength(0)
    await h.tick(T0 + 5_000)
    expect(outboxIds(h.world)).toHaveLength(1)
    expect(groupOf(payloads(h.world)[0]).closeReason).toBe('all-final')
  })

  it('6. a fusion in the window is one member; a fusion after the send changes nothing and is said', async () => {
    h = makeHarness()
    await boot(h)

    seen(h, { trackId: 'trk-1' })
    seen(h, { trackId: 'trk-2', timestamp: T0 + 500 })
    await h.settle()
    h.center.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-1', absorbedId: 'trk-2' })
    await h.settle()
    await h.tick(T0 + 20_000)

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    expect(groupOf(rows[0]).members).toHaveLength(1)

    h.center.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-1', absorbedId: 'trk-9' })
    await h.settle()
    const after = h.linesOf('grouped notification: a member was fused after the message left')
    expect(after).toHaveLength(1)
    expect(after[0]?.tags['deviceId']).toBe(DEVICE)
    expect(outboxIds(h.world)).toHaveLength(1)
  })

  it('7. once per track: a later window never re-admits a notified track', async () => {
    h = makeHarness()
    await boot(h, rule({ throttle: { cooldownSec: 1, scope: 'rule-device' } }))

    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 20_000)
    expect(outboxIds(h.world)).toHaveLength(1)

    h.setNow(T0 + 60_000)
    seen(h, { trackId: 'trk-1', timestamp: T0 + 60_000 })
    await h.settle()
    await h.tick(T0 + 80_000)

    expect(outboxIds(h.world)).toHaveLength(1)
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    const refused = h.linesOf('grouped window: track already notified by this rule')
    expect(refused).toHaveLength(1)
    expect(refused[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('8a. the close stamps EVERY class the message carries, at closedAt', async () => {
    h = makeHarness()
    await boot(
      h,
      rule({
        conditions: { classes: ['person', 'dog'] },
        throttle: { cooldownSec: 600, scope: 'rule-device' },
      }),
    )
    for (const id of ['trk-1', 'trk-d', 'trk-3', 'trk-e']) h.outlooks.set(id, { final: true })

    seen(h, { trackId: 'trk-1' })
    seen(h, { trackId: 'trk-d', className: 'dog', timestamp: T0 + 500 })
    await h.settle()
    await h.tick(T0 + 5_000)
    expect(outboxIds(h.world)).toHaveLength(1)

    h.setNow(T0 + 30_000)
    seen(h, { trackId: 'trk-3', timestamp: T0 + 30_000 })
    await h.settle()
    h.setNow(T0 + 40_000)
    seen(h, { trackId: 'trk-e', className: 'dog', timestamp: T0 + 40_000 })
    await h.settle()

    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    const cooling = h.linesOf('rule matched but is cooling down')
    expect(cooling.map((l) => l.meta['trackId'])).toEqual(['trk-3', 'trk-e'])
  })

  it('8b. a cooling class cannot OPEN a window, but it can JOIN one another class opened', async () => {
    h = makeHarness()
    await boot(
      h,
      rule({
        conditions: { classes: ['person', 'dog'] },
        throttle: { cooldownSec: 600, scope: 'rule-device' },
      }),
    )
    for (const id of ['trk-1', 'trk-2', 'trk-3', 'trk-d']) h.outlooks.set(id, { final: true })

    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 5_000)
    expect(outboxIds(h.world)).toHaveLength(1)

    h.setNow(T0 + 30_000)
    seen(h, { trackId: 'trk-2', timestamp: T0 + 30_000 })
    await h.settle()
    expect(h.center.groupedOpenWindows()).toHaveLength(0)

    seen(h, { trackId: 'trk-d', className: 'dog', timestamp: T0 + 30_000 })
    seen(h, { trackId: 'trk-3', timestamp: T0 + 31_000 })
    await h.settle()
    const windows = h.center.groupedOpenWindows()
    expect(windows).toHaveLength(1)
    expect(windows[0]?.members.map((m) => m.trackId)).toEqual(['trk-d', 'trk-3'])
  })

  it('8c. a window that closes with no message stamps nothing', async () => {
    h = makeHarness()
    await boot(
      h,
      rule({ conditions: IDENTITY_RULE, throttle: { cooldownSec: 600, scope: 'rule-device' } }),
    )

    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 20_000)
    expect(outboxIds(h.world)).toHaveLength(0)

    h.setNow(T0 + 30_000)
    seen(h, {
      trackId: 'trk-2',
      timestamp: T0 + 30_000,
      subLabel: 'Person A',
      subLabelMeta: PERSON_A_META,
    })
    await h.settle()
    expect(h.linesOf('rule matched but is cooling down')).toHaveLength(0)
    expect(h.center.groupedOpenWindows()).toHaveLength(1)
  })

  it('9. a MUTE set mid-window: no row, said with reason muted', async () => {
    h = makeHarness()
    await boot(h)

    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.center.buildProvider().setDeviceMuted({ deviceId: DEVICE, muted: true })
    await h.tick(T0 + 20_000)

    expect(outboxIds(h.world)).toHaveLength(0)
    const none = h.linesOf('grouped window closed with NO notification')
    expect(none).toHaveLength(1)
    expect(none[0]?.meta['reason']).toBe('muted')
    expect(none[0]?.tags['deviceId']).toBe(DEVICE)
  })

  describe('9. snoozed at close — the instant path verdict, per target (C4)', () => {
    const cases: readonly SnoozeCase[] = [
      {
        name: 'a rule snooze',
        input: (ruleId) => ({
          scope: 'rule',
          ruleId,
          durationMinutes: 60,
          global: true,
          summary: true,
        }),
        scope: 'rule',
      },
      {
        name: 'a camera snooze',
        input: () => ({
          scope: 'device',
          deviceId: DEVICE,
          durationMinutes: 60,
          global: true,
          summary: false,
        }),
        scope: 'device',
      },
      {
        name: 'a global snooze',
        input: () => ({ scope: 'all', durationMinutes: 60, global: true, summary: false }),
        scope: 'all',
      },
      {
        name: 'a class snooze covering every member class',
        input: () => ({
          scope: 'device',
          deviceId: DEVICE,
          classes: ['person', 'dog'],
          durationMinutes: 60,
          global: true,
          summary: false,
        }),
        scope: 'device',
      },
    ]
    for (const c of cases) {
      it(`${c.name} set mid-window → NO row, reason rule-snoozed-at-close with the snooze`, async () => {
        h = makeHarness()
        const ruleId = await boot(h, rule({ conditions: { classes: ['person', 'dog'] } }))

        seen(h, { trackId: 'trk-1' })
        seen(h, { trackId: 'trk-d', className: 'dog', timestamp: T0 + 500 })
        await h.settle()
        const snoozeId = await snooze(h, c.input(ruleId))
        await h.tick(T0 + 20_000)

        expect(outboxIds(h.world)).toHaveLength(0)
        const none = h.linesOf('grouped window closed with NO notification')
        expect(none).toHaveLength(1)
        expect(none[0]?.meta['reason']).toBe('rule-snoozed-at-close')
        expect(none[0]?.meta['ruleId']).toBe(ruleId)
        expect(none[0]?.meta['snoozeIds']).toEqual([snoozeId])
        expect(none[0]?.meta['snoozeScopes']).toEqual([c.scope])
        expect(none[0]?.tags['deviceId']).toBe(DEVICE)
        // Nothing stamped: the next subject opens a window at once.
        h.setNow(T0 + 30_000)
        seen(h, { trackId: 'trk-5', timestamp: T0 + 30_000 })
        await h.settle()
        expect(h.center.groupedOpenWindows()).toHaveLength(1)
      })
    }

    it('a rule snooze with a summary records the suppression the digest counts', async () => {
      h = makeHarness()
      const ruleId = await boot(h)

      seen(h, { trackId: 'trk-1' })
      await h.settle()
      const snoozeId = await snooze(h, {
        scope: 'rule',
        ruleId,
        durationMinutes: 60,
        global: true,
        summary: true,
      })
      await h.tick(T0 + 20_000)

      const suppressed = await h.center.snoozeStore.suppressedFor(snoozeId)
      expect(suppressed.map((r) => r.targetId)).toEqual(['tgt-1'])
    })

    it('a class snooze covering only ONE of two member classes → the row is written', async () => {
      h = makeHarness()
      await boot(h, rule({ conditions: { classes: ['person', 'dog'] } }))

      seen(h, { trackId: 'trk-1' })
      seen(h, { trackId: 'trk-d', className: 'dog', timestamp: T0 + 500 })
      await h.settle()
      await snooze(h, {
        scope: 'device',
        deviceId: DEVICE,
        classes: ['dog'],
        durationMinutes: 60,
        global: true,
        summary: false,
      })
      await h.tick(T0 + 20_000)

      expect(outboxIds(h.world)).toHaveLength(1)
      expect(h.linesOf('grouped window closed with NO notification')).toHaveLength(0)
    })

    it('a per-USER snooze covering one of two targets → ONE row, for the other target', async () => {
      h = makeHarness({ targets: OWNED_TARGETS })
      const ruleId = await boot(
        h,
        rule({ targets: [{ targetId: 'tgt-1' }, { targetId: 'tgt-2' }] }),
      )

      seen(h, { trackId: 'trk-1' })
      await h.settle()
      const snoozeId = await snooze(h, {
        scope: 'rule',
        ruleId,
        durationMinutes: 60,
        global: false,
        summary: false,
      })
      await h.tick(T0 + 20_000)

      const rows = [...ncTable(h.world, 'outbox').values()]
      expect(rows.map((r) => r['targetId'])).toEqual(['tgt-1'])
      expect(h.linesOf('grouped window closed with NO notification')).toHaveLength(0)
      const target = h.linesOf('grouped notification: target snoozed at close — no row for it')
      expect(target).toHaveLength(1)
      expect(target[0]?.meta['targetId']).toBe('tgt-2')
      expect(target[0]?.meta['snoozeIds']).toEqual([snoozeId])
      expect(target[0]?.tags['deviceId']).toBe(DEVICE)
    })

    it('EVERY target covered → zero rows and the rule-snoozed-at-close line', async () => {
      h = makeHarness({ targets: OWNED_TARGETS })
      const ruleId = await boot(
        h,
        rule({ targets: [{ targetId: 'tgt-1' }, { targetId: 'tgt-2' }] }),
      )

      seen(h, { trackId: 'trk-1' })
      await h.settle()
      const personal = await snooze(h, {
        scope: 'rule',
        ruleId,
        durationMinutes: 60,
        global: false,
        summary: false,
      })
      const household = await snooze(h, {
        scope: 'device',
        deviceId: DEVICE,
        durationMinutes: 60,
        global: true,
        summary: false,
      })
      await h.tick(T0 + 20_000)

      expect(outboxIds(h.world)).toHaveLength(0)
      const none = h.linesOf('grouped window closed with NO notification')
      expect(none).toHaveLength(1)
      expect(none[0]?.meta['reason']).toBe('rule-snoozed-at-close')
      // The broadest window owns each target's silence (`activeSnoozeFor`).
      expect(none[0]?.meta['snoozeIds']).toEqual([household])
      expect(personal).not.toBe(household)
    })

    it('an ALARM rule is never silenced at close either (D697)', async () => {
      h = makeHarness()
      await boot(
        h,
        rule({
          actions: {
            onTrigger: [
              {
                kind: 'do',
                action: { kind: 'cap', deviceId: 7, cap: 'alarm-panel', method: 'trigger' },
              },
            ],
          },
        }),
      )

      seen(h, { trackId: 'trk-1' })
      await h.settle()
      await snooze(h, { scope: 'all', durationMinutes: 60, global: true, summary: false })
      await h.tick(T0 + 20_000)

      expect(outboxIds(h.world)).toHaveLength(1)
      const exempt = h.linesOf('snooze does not apply — alarm rules are never silenced')
      expect(exempt.length).toBeGreaterThan(0)
      expect(exempt[0]?.tags['deviceId']).toBe(DEVICE)
    })
  })

  it('12. a close in flight is serialized: an event of its member waits on the chain (C13)', async () => {
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
    seen(h, { trackId: 'trk-1' })
    await h.settle()

    stalled = true

    h.setNow(T0 + 5_000)
    const ticking = h.center.runDrainTickForTest()
    await new Promise((r) => setTimeout(r, 10))
    seen(h, { trackId: 'trk-1', timestamp: T0 + 5_000 })
    await new Promise((r) => setTimeout(r, 10))
    release()
    await ticking
    await h.settle()
    expect(outboxIds(h.world)).toHaveLength(1)
    expect(h.center.groupedOpenWindows()).toHaveLength(0)
    expect(h.linesOf('grouped window: track already notified by this rule')).toHaveLength(1)
    expect(h.linesOf('grouped window: track is in a window being closed')).toHaveLength(0)
  })

  it('13. assigned but unlabelled is NOT final: the window waits for the label', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: IDENTITY_RULE }))
    h.outlooks.set('trk-1', { final: false, awaiting: 'face' })

    seen(h, { trackId: 'trk-1' })
    await h.settle()
    await h.tick(T0 + 5_000)
    expect(outboxIds(h.world)).toHaveLength(0)
    expect(h.center.groupedOpenWindows()).toHaveLength(1)

    h.setNow(T0 + 6_000)
    accept(h, 'trk-1', PERSON_A_LABEL)
    await h.settle()

    const rows = payloads(h.world)
    expect(rows).toHaveLength(1)
    expect(groupOf(rows[0]).members[0]?.label).toBe('Person A')
    expect(groupOf(rows[0]).closeReason).toBe('all-final')
  })

  describe('14. a judged member (C10, operator ruling 2026-10-02)', () => {
    async function judgedStranger(input: NcRuleInput = rule({ conditions: IDENTITY_RULE })) {
      h = makeHarness()
      const ruleId = await boot(h, input)
      seen(h, { trackId: 'trk-2' })
      await h.settle()
      await h.tick(T0 + 20_000)
      expect(h.linesOf('grouped member dropped — recognition-not-final')).toHaveLength(1)
      return ruleId
    }

    it('(a) a stranger stays silent: no window every groupingSec, ONE line, no churn', async () => {
      await judgedStranger()
      const opened = h.linesOf('grouped window opened').length
      const closed = h.linesOf('grouped window closed with NO notification').length

      for (let s = 21; s <= 140; s += 1) {
        h.setNow(T0 + s * 1_000)
        seen(h, { trackId: 'trk-2', timestamp: T0 + s * 1_000 })
        if (s % 2 === 0) await h.tick(T0 + s * 1_000)
      }
      await h.settle()

      expect(outboxIds(h.world)).toHaveLength(0)
      expect(h.center.groupedOpenWindows()).toHaveLength(0)
      const judged = h.linesOf(
        'grouped window: not re-opened — the track was judged unrecognised for this rule',
      )
      expect(judged).toHaveLength(1)
      expect(judged[0]?.tags['deviceId']).toBe(DEVICE)
      expect(judged[0]?.meta['trackId']).toBe('trk-2')
      expect(h.linesOf('grouped window opened')).toHaveLength(opened)
      expect(h.linesOf('grouped window closed with NO notification')).toHaveLength(closed)
    })

    it('(b) recognised later: a fresh window, exactly ONE row naming Person A', async () => {
      await judgedStranger()
      for (let s = 21; s <= 89; s += 1) {
        h.setNow(T0 + s * 1_000)
        seen(h, { trackId: 'trk-2', timestamp: T0 + s * 1_000 })
      }
      await h.settle()
      h.setNow(T0 + 90_000)
      accept(h, 'trk-2', PERSON_A_LABEL)
      await h.settle()
      // Review T8 H-1: opened at the recognition instant — its own key, the 5 s floor kept.
      const reopened = h.center.groupedOpenWindows()
      expect(reopened).toHaveLength(1)
      expect(reopened[0]?.key.endsWith(`trk-2@${T0 + 90_000}`)).toBe(true)
      await h.tick(T0 + 94_000)
      expect(outboxIds(h.world)).toHaveLength(0)
      await h.tick(T0 + 96_000)

      const rows = payloads(h.world)
      expect(rows).toHaveLength(1)
      expect(groupOf(rows[0]).members.map((m) => m.label)).toEqual(['Person A'])

      for (let s = 97; s <= 140; s += 1) {
        h.setNow(T0 + s * 1_000)
        seen(h, {
          trackId: 'trk-2',
          timestamp: T0 + s * 1_000,
          subLabel: 'Person A',
          subLabelMeta: PERSON_A_META,
        })
        if (s % 5 === 0) await h.tick(T0 + s * 1_000)
      }
      await h.settle()
      expect(outboxIds(h.world)).toHaveLength(1)
    })

    it('(b2) recognised by a later EVENT (not the hook): fires once', async () => {
      await judgedStranger()
      h.setNow(T0 + 40_000)
      seen(h, {
        trackId: 'trk-2',
        timestamp: T0 + 40_000,
        subLabel: 'Person A',
        subLabelMeta: PERSON_A_META,
      })
      await h.settle()
      await h.tick(T0 + 46_000)
      expect(outboxIds(h.world)).toHaveLength(1)
    })

    it('(c) recognised OUT of scope: judged, and silent', async () => {
      h = makeHarness()
      await boot(h, rule({ conditions: IDENTITY_RULE }))
      seen(h, { trackId: 'trk-2' })
      await h.settle()
      h.setNow(T0 + 3_000)
      accept(h, 'trk-2', PERSON_B_LABEL)
      await h.settle()
      await h.tick(T0 + 20_000)
      expect(h.linesOf('grouped member dropped — recognised-out-of-scope')).toHaveLength(1)

      for (let s = 21; s <= 60; s += 1) {
        h.setNow(T0 + s * 1_000)
        seen(h, { trackId: 'trk-2', timestamp: T0 + s * 1_000 })
      }
      await h.settle()
      await h.tick(T0 + 61_000)
      expect(outboxIds(h.world)).toHaveLength(0)
      expect(h.linesOf('grouped window opened')).toHaveLength(1)
    })

    it('(d) the judgement ends with its track', async () => {
      await judgedStranger()
      h.setNow(T0 + 30_000)
      h.center.onTrackClosed(track({ trackId: 'trk-2', firstSeen: T0, lastSeen: T0 + 30_000 }), [])
      await h.settle()
      // The same id seen again (a tracker id is never reused in practice — this proves the
      // entry left the set, not a behaviour anyone relies on).
      h.setNow(T0 + 31_000)
      seen(h, { trackId: 'trk-2', timestamp: T0 + 31_000 })
      await h.settle()
      expect(h.center.groupedOpenWindows()).toHaveLength(1)
    })
  })

  it('15. a retracted identity is never delivered: dropped recognition-not-final', async () => {
    h = makeHarness()
    await boot(h, rule({ conditions: IDENTITY_RULE }))

    seen(h, { trackId: 'trk-1' })
    await h.settle()
    h.setNow(T0 + 2_000)
    accept(h, 'trk-1', PERSON_A_LABEL)
    h.center.onTrackLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-1',
      change: 'cleared',
      label: {},
    })
    await h.settle()
    await h.tick(T0 + 20_000)

    expect(outboxIds(h.world)).toHaveLength(0)
    expect(h.linesOf('grouped member dropped — recognition-not-final')).toHaveLength(1)
  })

  it('16. every member carries ITS first-matched event identity, eventAt as the event stored it', async () => {
    h = makeHarness()
    await boot(h)

    seen(h, { id: 77, trackId: 'trk-1', timestamp: T0 })
    h.setNow(T0 + 1_500)
    seen(h, { id: 77, trackId: 'trk-2', timestamp: T0 + 1_234 })
    // A later event of trk-1 never moves its frozen moment.
    h.setNow(T0 + 3_000)
    seen(h, { id: 78, trackId: 'trk-1', timestamp: T0 + 3_000 })
    await h.settle()
    await h.tick(T0 + 20_000)

    const row = payloads(h.world)[0]
    const members = groupOf(row).members
    expect(members.map((m) => [m.trackId, m.eventId, m.eventDeviceId, m.eventAt])).toEqual([
      ['trk-1', '77', DEVICE, T0],
      ['trk-2', '77', DEVICE, T0 + 1_234],
    ])
    expect(row?.subject.eventId).toBe('77')
    expect(row?.subject.timestamp).toBe(T0)
  })
})
