/**
 * D692 Task 8 — the orchestrator on fake deps: the refusals on a ledger the test sets
 * directly (notified, judged — the real sets are `grouped-immediate.spec.ts`'s), the
 * `closing` reservation (C13),
 * the logged buffer results that drop something (an emptied window, a replay overflow), the
 * synthetic group of one (C11), the no-track plain route (C17) and the alias read order.
 */

import { type NcRule, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type LoggedLine, makeLogRecorder } from '../../__tests__/grouped-harness.js'
import { evaluateRule, NC_RECOGNITION_CONDITIONS, type NcRuleSubject } from '../../rule-engine.js'
import {
  NcGroupedDelivery,
  type NcGroupedDeliveryDeps,
  type NcGroupedJudgedEntry,
} from '../grouped-delivery.js'
import type { NcRecognitionOutlook } from '../grouped-inputs.js'
import {
  NC_GROUPED_MAX_MEMBERS,
  type NcGroupedCloseReason,
  type NcGroupedWindow,
} from '../grouped-window-buffer.js'

const DEVICE = 7
const T0 = 1_000_000

function makeRule(conditions: Record<string, unknown> = { classes: ['person'] }): NcRule {
  return NcRuleSchema.parse({
    id: 'r1',
    name: 'door',
    delivery: 'immediate',
    targets: [{ targetId: 't' }],
    conditions,
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    groupingSec: 20,
    media: { attach: 'none' },
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
  })
}

function subject(trackId: string, at = T0, extra: Partial<NcRuleSubject> = {}): NcRuleSubject {
  return {
    kind: 'object-event',
    recordId: `ev-${trackId}-${String(at)}`,
    deviceId: DEVICE,
    timestamp: at,
    classNames: ['person'],
    zones: [],
    trackId,
    source: 'pipeline',
    ...extra,
  }
}

interface Fixture {
  readonly delivery: NcGroupedDelivery
  readonly lines: LoggedLine[]
  readonly closes: { window: NcGroupedWindow; reason: NcGroupedCloseReason }[]
  /** The windows the record dep was handed (spec §5: at OPEN). */
  readonly recorded: NcGroupedWindow[]
  readonly notified: Set<string>
  readonly judged: Map<string, NcGroupedJudgedEntry>
  readonly unjudged: string[]
  /** `ledger.touch` calls, as `rule|track` (the sliding TTL, review T9a M-1). */
  readonly touched: string[]
  readonly actions: string[]
  readonly outlooks: Map<string, NcRecognitionOutlook>
  setNow(at: number): void
  linesOf(msg: string): LoggedLine[]
}

function fixture(rule: NcRule, overrides: Partial<NcGroupedDeliveryDeps> = {}): Fixture {
  const { logger, lines } = makeLogRecorder()
  let now = T0
  const closes: Fixture['closes'] = []
  const recorded: NcGroupedWindow[] = []
  const notified = new Set<string>()
  const judged = new Map<string, NcGroupedJudgedEntry>()
  const unjudged: string[] = []
  const touched: string[] = []
  const actions: string[] = []
  const outlooks = new Map<string, NcRecognitionOutlook>()
  const delivery = new NcGroupedDelivery({
    logger,
    now: () => now,
    evaluate: (r, s, relax) =>
      evaluateRule(
        r,
        s,
        undefined,
        undefined,
        undefined,
        relax ? { relax: NC_RECOGNITION_CONDITIONS } : undefined,
      ),
    outlook: ({ trackId, labelKind }) =>
      labelKind !== undefined
        ? { final: true }
        : (outlooks.get(trackId) ?? { final: false, awaiting: 'face-unseen' }),
    getRule: (id) => (id === rule.id ? rule : null),
    runActions: (_r, s) => {
      actions.push(s.trackId ?? '?')
    },
    cooldown: () => ({ key: 'k', cooling: false }),
    ledger: {
      notified: (ruleId, trackId) => notified.has(`${ruleId}|${trackId}`),
      notifiedRulesFor: (trackId) =>
        [...notified].filter((k) => k.endsWith(`|${trackId}`)).map((k) => k.split('|')[0] ?? ''),
      judged: (ruleId, trackId) => judged.has(`${ruleId}|${trackId}`),
      judgedFor: (_deviceId, trackId) =>
        [...judged.entries()].filter(([k]) => k.endsWith(`|${trackId}`)).map(([, e]) => e),
      touch: (ruleId, trackId) => {
        touched.push(`${ruleId}|${trackId}`)
      },
      unjudge: (ruleId, trackId) => {
        judged.delete(`${ruleId}|${trackId}`)
        unjudged.push(trackId)
      },
      trackClosed: (_deviceId, trackId) => {
        for (const key of [...judged.keys()]) if (key.endsWith(`|${trackId}`)) judged.delete(key)
      },
    },
    close: async (window, reason) => {
      closes.push({ window, reason })
      return 1
    },
    record: (window) => {
      recorded.push(window)
    },
    ...overrides,
  })
  return {
    delivery,
    lines,
    closes,
    recorded,
    notified,
    judged,
    unjudged,
    touched,
    actions,
    outlooks,
    setNow(at) {
      now = at
    },
    linesOf(msg) {
      return lines.filter((l) => l.msg === msg)
    },
  }
}

const IDENTITY_RULE = { classes: ['person'], identities: ['id-a'] }
const PERSON_A = { label: 'Person A', labelKind: 'identity', identityId: 'id-a' } as const

describe('NcGroupedDelivery (D692 Task 8)', () => {
  it('an already-notified track is refused after its actions ran (fresh review M-1)', async () => {
    const f = fixture(makeRule())
    f.notified.add('r1|trk-1')
    const out = await f.delivery.admit(makeRule(), subject('trk-1'), {}, 'pipeline')
    expect(out).toMatchObject({ kind: 'refused', why: 'already-notified', matched: true })
    expect(f.actions).toEqual(['trk-1'])
    expect(f.delivery.openWindows()).toHaveLength(0)
  })

  it('a JUDGED track: the first refused re-open says so ONCE, repeats say nothing (C10)', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    for (let i = 0; i < 5; i += 1) {
      const out = await f.delivery.admit(rule, subject('trk-2', T0 + i * 1_000), {}, 'pipeline')
      expect(out).toMatchObject({ kind: 'refused', why: 'already-judged' })
    }
    const said = f.linesOf(
      'grouped window: not re-opened — the track was judged unrecognised for this rule',
    )
    expect(said).toHaveLength(1)
    expect(said[0]?.level).toBe('info')
    expect(said[0]?.tags['deviceId']).toBe(DEVICE)
    expect(said[0]?.meta['trackId']).toBe('trk-2')
    // Nothing else about it at any level.
    expect(f.lines.filter((l) => l.meta['trackId'] === 'trk-2')).toHaveLength(1)
    expect(f.delivery.openWindows()).toHaveLength(0)
  })

  it('T9a review M-1: a refusal on a notified or judged track SLIDES its TTL (touch)', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    f.notified.add('r1|trk-1')
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    await f.delivery.admit(rule, subject('trk-1', T0, PERSON_A), {}, 'pipeline')
    await f.delivery.admit(rule, subject('trk-2'), {}, 'pipeline')
    expect(f.touched).toEqual(['r1|trk-1', 'r1|trk-2'])
  })

  it('T9a review L-4: a re-judged track is SAID again after a full match un-judged it', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    const said = () =>
      f.linesOf('grouped window: not re-opened — the track was judged unrecognised for this rule')
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    await f.delivery.admit(rule, subject('trk-2'), {}, 'pipeline')
    expect(said()).toHaveLength(1)
    await f.delivery.admit(rule, subject('trk-2', T0 + 1_000, PERSON_A), {}, 'pipeline')
    expect(f.unjudged).toEqual(['trk-2'])
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    await f.delivery.admit(rule, subject('trk-2', T0 + 2_000), {}, 'pipeline')
    expect(said()).toHaveLength(2)
  })

  it('T9a review L-4: a track close clears the said-once memo too', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    const said = () =>
      f.linesOf('grouped window: not re-opened — the track was judged unrecognised for this rule')
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    await f.delivery.admit(rule, subject('trk-2'), {}, 'pipeline')
    await f.delivery.onTrackClosed(subject('trk-2', T0 + 1_000))
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    await f.delivery.admit(rule, subject('trk-2', T0 + 2_000), {}, 'pipeline')
    expect(said()).toHaveLength(2)
  })

  it('a judged track whose FULL evaluation matches opens a fresh window and leaves the judged set', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    const out = await f.delivery.admit(
      rule,
      subject('trk-2', T0, { label: 'Person A', labelKind: 'identity', identityId: 'id-a' }),
      {},
      'pipeline',
    )
    expect(out).toMatchObject({ kind: 'opened', matched: true })
    expect(f.unjudged).toEqual(['trk-2'])
  })

  it('a late recognition of a judged track in no window re-opens it, once (C10)', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    await f.delivery.onLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-2',
      change: 'accepted',
      label: PERSON_A,
    })
    const reopened = f.linesOf('grouped window: reopened by a late recognition')
    expect(reopened).toHaveLength(1)
    expect(reopened[0]?.tags['deviceId']).toBe(DEVICE)
    expect(f.delivery.openWindows()).toHaveLength(1)
    expect(f.delivery.openWindows()[0]?.members[0]?.matched).toBe(true)
    expect(f.actions).toEqual(['trk-2'])
    expect(f.judged.size).toBe(0)
  })

  it('a late NON-matching label of a judged track opens nothing', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
    await f.delivery.onLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-2',
      change: 'accepted',
      label: { label: 'Person B', labelKind: 'identity', identityId: 'id-b' },
    })
    expect(f.delivery.openWindows()).toHaveLength(0)
    expect(f.judged.size).toBe(1)
  })

  it('a member of a window being closed is refused while the close is in flight (C13)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule, {
      close: async () => {
        await gate
        return 1
      },
    })
    await f.delivery.admit(rule, subject('trk-1'), {}, 'pipeline')
    f.setNow(T0 + 20_000)
    const sweeping = f.delivery.sweep(T0 + 20_000)
    // The close is awaiting its (slow) enqueue: a new event of the same track.
    const out = await f.delivery.admit(rule, subject('trk-1', T0 + 20_000), {}, 'pipeline')
    expect(out).toMatchObject({ kind: 'refused', why: 'closing' })
    release()
    await sweeping
    // Released: the track can be admitted again.
    const after = await f.delivery.admit(rule, subject('trk-1', T0 + 21_000), {}, 'pipeline')
    expect(after.kind).toBe('opened')
  })

  it('T9b: a window is RECORDED once, when it opens — a join or an update never re-records', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    await f.delivery.admit(rule, subject('trk-1'), {}, 'pipeline')
    expect(f.recorded.map((w) => w.members.map((m) => m.trackId))).toEqual([['trk-1']])
    await f.delivery.admit(rule, subject('trk-2', T0 + 1_000), {}, 'pipeline')
    await f.delivery.admit(rule, subject('trk-1', T0 + 2_000), {}, 'pipeline')
    expect(f.recorded).toHaveLength(1)
  })

  it('a fusion into a notified survivor that EMPTIES the window is said, and never reaches the close pass (M-T6-2)', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    const opened = await f.delivery.admit(rule, subject('trk-2'), {}, 'pipeline')
    expect(opened.kind).toBe('opened')
    f.notified.add('r1|trk-1')
    await f.delivery.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-1', absorbedId: 'trk-2' })

    const none = f.linesOf('grouped window closed with NO notification')
    expect(none).toHaveLength(1)
    expect(none[0]?.tags['deviceId']).toBe(DEVICE)
    expect(none[0]?.meta['reason']).toBe('fused-into-notified')
    expect(none[0]?.meta['ruleId']).toBe('r1')
    expect(typeof none[0]?.meta['windowKey']).toBe('string')
    expect(f.linesOf('grouped member dropped — fused-into-notified')).toHaveLength(1)
    expect(f.closes).toHaveLength(0)
    expect(f.delivery.openWindows()).toHaveLength(0)
  })

  it('a fusion with no open window, of a track a rule already notified, is measured (§3.4)', async () => {
    const f = fixture(makeRule())
    f.notified.add('r1|trk-1')
    await f.delivery.onTracksFused({ deviceId: DEVICE, survivorId: 'trk-1', absorbedId: 'trk-9' })
    const after = f.linesOf('grouped notification: a member was fused after the message left')
    expect(after).toHaveLength(1)
    expect(after[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('a replay merge says every member that did not fit the live window (M-T6-1, D391)', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    for (let i = 0; i < NC_GROUPED_MAX_MEMBERS; i += 1) {
      await f.delivery.admit(rule, subject(`live-${String(i)}`), {}, 'pipeline')
    }
    await f.delivery.admit(rule, subject('replayed-1', T0 - 1_000), {}, 'reconcile')
    await f.delivery.releaseReplay()
    expect(f.linesOf('grouped window: replay merged into the live window')).toHaveLength(1)
    const dropped = f.linesOf('grouped window is full — replayed subject not added')
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.tags['deviceId']).toBe(DEVICE)
    expect(dropped[0]?.meta['trackId']).toBe('replayed-1')
    expect(dropped[0]?.meta['ruleId']).toBe('r1')
  })

  it('a replay window past its deadline at release closes as `replayed`', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    await f.delivery.admit(rule, subject('trk-r', T0 - 30_000), {}, 'reconcile')
    await f.delivery.releaseReplay()
    expect(f.closes.map((c) => c.reason)).toEqual(['replayed'])
  })

  it('a synthetic subject never touches the shared buffer: a group of one, closed as `test` (C11)', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    await f.delivery.admit(rule, subject('trk-1'), {}, 'pipeline')
    const out = await f.delivery.admit(
      rule,
      subject('trk-syn'),
      { bypassMute: true, closeWindowImmediately: true },
      'synthetic',
    )
    expect(out.kind).toBe('tested')
    expect(f.closes).toHaveLength(1)
    expect(f.closes[0]?.reason).toBe('test')
    expect(f.closes[0]?.window.members.map((m) => m.trackId)).toEqual(['trk-syn'])
    expect(f.closes[0]?.window.flags.bypassMute).toBe(true)
    const live = f.delivery.openWindows()
    expect(live).toHaveLength(1)
    expect(live[0]?.members.map((m) => m.trackId)).toEqual(['trk-1'])
    expect(live[0]?.flags.bypassMute).toBe(false)
  })

  it('the close flag on a LIVE admission is refused with a WARN: no live producer may set it (C11)', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    const out = await f.delivery.admit(
      rule,
      subject('trk-1'),
      { closeWindowImmediately: true },
      'pipeline',
    )
    expect(out).toMatchObject({ kind: 'refused', why: 'test-flag-mismatch' })
    expect(f.delivery.openWindows()).toHaveLength(0)
    expect(f.closes).toHaveLength(0)
    const warns = f.linesOf('grouped window: close-at-once flag refused')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.level).toBe('warn')
    expect(warns[0]?.tags['deviceId']).toBe(DEVICE)
  })

  it('a synthetic admission WITHOUT the flag never reaches the shared buffer either (C11)', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    const out = await f.delivery.admit(rule, subject('trk-syn'), {}, 'synthetic')
    expect(out).toMatchObject({ kind: 'refused', why: 'test-flag-mismatch' })
    expect(f.delivery.openWindows()).toHaveLength(0)
    expect(f.linesOf('grouped window: close-at-once flag refused')).toHaveLength(1)
  })

  it('an event without a track is routed to the plain path, said once per rule (C17)', async () => {
    const rule = makeRule()
    const f = fixture(rule)
    const { trackId: _t, ...noTrack } = subject('x')
    expect(await f.delivery.admit(rule, noTrack, {}, 'pipeline')).toEqual({
      kind: 'plain',
      reason: 'no-track',
    })
    await f.delivery.admit(rule, noTrack, {}, 'pipeline')
    expect(
      f.linesOf('grouped rule: event without a track — delivered as plain immediate'),
    ).toHaveLength(1)
  })

  it('alias read order: the RAM alias before the durable one; a durable failure reads the id as asked, said once', async () => {
    const rule = makeRule()
    const durable: string[] = []
    const f = fixture(rule, {
      resolveTrackAliasSync: (id) => (id === 'abs-1' ? 'srv-1' : undefined),
      resolveTrackAlias: async (id) => {
        durable.push(id)
        throw new Error('store down')
      },
    })
    await f.delivery.admit(rule, subject('abs-1'), {}, 'pipeline')
    expect(f.delivery.openWindows()[0]?.members[0]?.trackId).toBe('srv-1')
    expect(durable).toEqual([])
    await f.delivery.admit(rule, subject('trk-x'), {}, 'pipeline')
    await f.delivery.admit(rule, subject('trk-x', T0 + 1), {}, 'pipeline')
    expect(durable).toEqual(['trk-x', 'trk-x'])
    const failed = f.linesOf(
      'grouped window: track alias resolution failed — reading the id as asked (D315)',
    )
    expect(failed).toHaveLength(1)
    expect(failed[0]?.tags['deviceId']).toBe(DEVICE)
    expect(f.delivery.openWindows()[0]?.members.map((m) => m.trackId)).toEqual(['srv-1', 'trk-x'])
  })

  it('a retraction demotes the member: no longer matched (C14)', async () => {
    const rule = makeRule(IDENTITY_RULE)
    const f = fixture(rule)
    await f.delivery.admit(rule, subject('trk-1'), {}, 'pipeline')
    await f.delivery.onLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-1',
      change: 'accepted',
      label: PERSON_A,
    })
    expect(f.delivery.openWindows()[0]?.members[0]?.matched).toBe(true)
    await f.delivery.onLabelChanged({
      deviceId: DEVICE,
      trackId: 'trk-1',
      change: 'cleared',
      label: {},
    })
    const member = f.delivery.openWindows()[0]?.members[0]
    expect(member?.matched).toBe(false)
    expect(member?.subject.identityId).toBeUndefined()
    expect(
      f.linesOf('grouped window: subject demoted — the recognition was taken back'),
    ).toHaveLength(1)
  })

  it('a closed track is final: the window closes at the floor (spec §4)', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    await f.delivery.admit(rule, subject('trk-1'), {}, 'pipeline')
    f.setNow(T0 + 6_000)
    await f.delivery.sweep(T0 + 6_000)
    expect(f.closes).toHaveLength(0)
    await f.delivery.onTrackClosed({ ...subject('trk-1', T0 + 6_000), kind: 'track-end' })
    expect(f.closes.map((c) => c.reason)).toEqual(['all-final'])
  })

  it('an unknown outlook waits the full window, said once per camera per 10 min', async () => {
    const rule = makeRule({ classes: ['person'] })
    const f = fixture(rule)
    f.outlooks.set('trk-1', { final: false, awaiting: 'unknown', reason: 'no-detail-announce' })
    await f.delivery.admit(rule, subject('trk-1'), {}, 'pipeline')
    for (const at of [T0 + 6_000, T0 + 8_000, T0 + 10_000]) {
      f.setNow(at)
      await f.delivery.sweep(at)
    }
    const unknown = f.linesOf(
      'grouped window: recognition outlook unknown — waiting the full window',
    )
    expect(unknown).toHaveLength(1)
    expect(unknown[0]?.meta['reason']).toBe('no-detail-announce')
    expect(f.closes).toHaveLength(0)
  })

  describe('review T8 round 1', () => {
    it('H-1: a late recognition re-opens at the RECOGNITION instant — its own key, the 5 s floor kept', async () => {
      const rule = makeRule(IDENTITY_RULE)
      const f = fixture(rule)
      const judgingKey = `grp:r1:${String(DEVICE)}:trk-2@${String(T0)}`
      f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2', T0) })
      f.setNow(T0 + 90_000)
      await f.delivery.onLabelChanged({
        deviceId: DEVICE,
        trackId: 'trk-2',
        change: 'accepted',
        label: PERSON_A,
      })

      // Never closed at once: the recognised member is final, but the floor is from NOW.
      expect(f.closes).toHaveLength(0)
      const window = f.delivery.openWindows()[0]
      expect(window?.openedAt).toBe(T0 + 90_000)
      expect(window?.floorAt).toBe(T0 + 95_000)
      expect(window?.key).not.toBe(judgingKey)
      // The member still freezes the event it was judged on (C12, D694).
      expect(window?.members[0]?.firstMatchedSubject?.recordId).toBe(`ev-trk-2-${String(T0)}`)

      f.setNow(T0 + 95_000)
      await f.delivery.sweep(T0 + 95_000)
      expect(f.closes.map((c) => c.reason)).toEqual(['all-final'])
    })

    it('M-4: a judged track whose full match is COOLING stays judged', async () => {
      const rule = makeRule(IDENTITY_RULE)
      const f = fixture(rule, { cooldown: () => ({ key: 'k', cooling: true }) })
      f.judged.set('r1|trk-2', { ruleId: 'r1', subject: subject('trk-2') })
      const out = await f.delivery.admit(
        rule,
        subject('trk-2', T0, { label: 'Person A', labelKind: 'identity', identityId: 'id-a' }),
        {},
        'pipeline',
      )
      expect(out.kind).toBe('cooling-down')
      await f.delivery.onLabelChanged({
        deviceId: DEVICE,
        trackId: 'trk-2',
        change: 'accepted',
        label: PERSON_A,
      })
      expect(f.unjudged).toEqual([])
      expect(f.judged.size).toBe(1)
    })

    it('M-2: a close that THROWS loses only its own window, and says so', async () => {
      const rule = makeRule({ classes: ['person'] })
      let calls = 0
      const closed: string[] = []
      const f = fixture(rule, {
        close: async (window) => {
          calls += 1
          if (calls === 1) throw new Error('enqueue exploded')
          closed.push(window.key)
          return 1
        },
      })
      await f.delivery.admit(rule, subject('trk-1'), {}, 'pipeline')
      await f.delivery.admit(rule, subject('trk-9', T0, { deviceId: DEVICE + 1 }), {}, 'pipeline')
      f.setNow(T0 + 20_000)
      await f.delivery.sweep(T0 + 20_000)

      expect(calls).toBe(2)
      expect(closed).toHaveLength(1)
      const lost = f.linesOf('grouped window close failed — window lost')
      expect(lost).toHaveLength(1)
      expect(lost[0]?.level).toBe('warn')
      expect(lost[0]?.tags['deviceId']).toBe(DEVICE)
      expect(lost[0]?.meta['members']).toEqual(['trk-1'])
      expect(f.delivery.openWindows()).toHaveLength(0)
    })
  })
})
