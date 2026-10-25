/**
 * D692: the grouped window buffer — one window per (rule, camera), a deterministic key,
 * the 5 s floor and the deadline on the EVENT clock, bounds, fusion (spec §3.4), replay
 * windows kept apart from live ones (C5), early promotions (C15), the frozen first match
 * (C12) and retraction (C14).
 */
import { describe, expect, it } from 'vitest'
import type { NcRuleSubject } from '../../rule-engine.js'
import {
  NC_GROUPED_MAX_MEMBERS,
  NC_GROUPED_MAX_OPEN_WINDOWS,
  type NcGroupedAdmission,
  NcGroupedWindowBuffer,
  groupedWindowKey,
} from '../grouped-window-buffer.js'

const DEV = 101
const FLAGS = { bypassCooldown: false, bypassMute: false, closeImmediately: false }
const subj = (trackId: string, timestamp: number, className = 'person'): NcRuleSubject => ({
  kind: 'object-event',
  recordId: `ev-${trackId}-${timestamp}`,
  deviceId: DEV,
  timestamp,
  classNames: [className],
  zones: [],
  trackId,
})
const adm = (
  trackId: string,
  at: number,
  over: Partial<NcGroupedAdmission> = {},
): NcGroupedAdmission => ({
  ruleId: 'r1',
  deviceId: DEV,
  groupingSec: 20,
  trackId,
  className: 'person',
  subject: subj(trackId, at),
  matched: true,
  replaying: false,
  origin: 'pipeline',
  flags: FLAGS,
  ...over,
})
const PERSON_A = { label: 'Person A', identityId: 'id-a', labelKind: 'identity' } as const
const PERSON_B = { label: 'Person B', identityId: 'id-b', labelKind: 'identity' } as const

describe('NcGroupedWindowBuffer', () => {
  it('opens with a deterministic key, a 5 s floor and the deadline from the EVENT time', () => {
    const b = new NcGroupedWindowBuffer()
    const r = b.admit(adm('t1', 1_000))
    expect(r.kind).toBe('opened')
    if (r.kind !== 'opened') return
    expect(r.window.key).toBe(groupedWindowKey('r1', DEV, 't1', 1_000))
    expect(r.window.key).toBe('grp:r1:101:t1@1000')
    expect(r.window.floorAt).toBe(6_000)
    expect(r.window.deadlineAt).toBe(21_000)
  })
  it('a second subject JOINS the open window; the same track UPDATES it (never a second window)', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000))
    expect(b.admit(adm('t2', 2_000)).kind).toBe('joined')
    expect(b.admit(adm('t1', 3_000, { matched: false })).kind).toBe('updated')
    expect(b.all()).toHaveLength(1)
    expect(b.get('r1', DEV, false)?.members.map((m) => [m.trackId, m.matched])).toEqual([
      ['t1', false],
      ['t2', true],
    ])
  })
  it('two rules or two cameras never share a window', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000))
    expect(b.admit(adm('t1', 1_000, { ruleId: 'r2' })).kind).toBe('opened')
    expect(
      b.admit(adm('t9', 1_000, { deviceId: 102, subject: { ...subj('t9', 1_000), deviceId: 102 } }))
        .kind,
    ).toBe('opened')
  })
  it('refuses past the member bound and past the window bound', () => {
    const b = new NcGroupedWindowBuffer()
    for (let i = 0; i < NC_GROUPED_MAX_MEMBERS; i++) b.admit(adm(`t${i}`, 1_000 + i))
    expect(b.admit(adm('one-too-many', 9_000)).kind).toBe('window-full')
    const c = new NcGroupedWindowBuffer()
    for (let i = 0; i < NC_GROUPED_MAX_OPEN_WINDOWS; i++)
      c.admit(adm('t', 1_000, { ruleId: `r${i}` }))
    expect(c.admit(adm('t', 1_000, { ruleId: 'r-extra' })).kind).toBe('too-many-windows')
  })
  it('promote overlays the label; a later admission of the same track keeps it; closeTrack marks closed', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000, { matched: false }))
    const [p] = b.promote({ deviceId: DEV, trackId: 't1', label: PERSON_A, at: 2_000 })
    expect(p?.after.subject).toMatchObject(PERSON_A)
    // An event emitted before recognition reaches the NC after the promotion.
    b.admit(adm('t1', 3_000, { matched: false }))
    expect(b.get('r1', DEV, false)?.members[0]?.subject).toMatchObject(PERSON_A)
    b.closeTrack(DEV, 't1', { ...PERSON_A, labelConfidence: 0.8 })
    const m = b.get('r1', DEV, false)?.members[0]
    expect(m?.closed).toBe(true)
    expect(m?.subject.labelConfidence).toBe(0.8)
  })
  it('demote (a D665 retraction) removes the identity overlay', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000, { matched: false }))
    b.promote({ deviceId: DEV, trackId: 't1', label: PERSON_A, at: 2_000 })
    b.demote(DEV, 't1', {})
    const m = b.get('r1', DEV, false)?.members[0]
    expect(m?.subject.labelKind).toBeUndefined()
    expect(m?.subject.identityId).toBeUndefined()
  })
  it('a promotion BEFORE the admission is applied at the admission (C15)', () => {
    const b = new NcGroupedWindowBuffer()
    expect(b.promote({ deviceId: DEV, trackId: 't1', label: PERSON_A, at: 900 })).toEqual([])
    const r = b.admit(adm('t1', 1_000, { matched: false }))
    expect(r.kind === 'opened' && r.appliedEarlyPromotion).toBe(true)
    expect(b.get('r1', DEV, false)?.members[0]?.subject).toMatchObject(PERSON_A)
  })
  it('an early promotion older than the TTL is not applied', () => {
    const b = new NcGroupedWindowBuffer()
    b.promote({ deviceId: DEV, trackId: 't1', label: PERSON_A, at: 0 })
    b.admit(adm('t1', 61_000, { matched: false }))
    expect(b.get('r1', DEV, false)?.members[0]?.subject.labelKind).toBeUndefined()
  })
  it('firstMatchedSubject stays the FIRST match after later updates (C12)', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000, { matched: false }))
    b.admit(adm('t1', 2_000, { matched: true }))
    b.admit(adm('t1', 5_000, { matched: true }))
    const m = b.get('r1', DEV, false)?.members[0]
    expect(m?.firstMatchedAt).toBe(2_000)
    expect(m?.firstMatchedSubject?.timestamp).toBe(2_000)
    expect(m?.subject.timestamp).toBe(5_000)
  })
  it('setVerdict after a promotion freezes the promoted subject as the first match', () => {
    const b = new NcGroupedWindowBuffer()
    const r = b.admit(adm('t1', 1_000, { matched: false }))
    if (r.kind !== 'opened') throw new Error('expected opened')
    b.promote({ deviceId: DEV, trackId: 't1', label: PERSON_A, at: 2_000 })
    const m = b.setVerdict(r.window.key, 't1', true, ['identities'])
    expect(m?.firstMatchedSubject).toMatchObject(PERSON_A)
    expect(m?.matchedOn).toEqual(['identities'])
  })
  it('fusion: both members → ONE under the survivor, the specific label wins', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('S', 1_000))
    b.admit(adm('A', 2_000))
    b.promote({ deviceId: DEV, trackId: 'A', label: PERSON_A, at: 2_500 })
    const [e] = b.fuse(DEV, 'S', 'A', () => false)
    expect(e).toMatchObject({ kind: 'merged', membersBefore: 2, membersAfter: 1 })
    const only = b.get('r1', DEV, false)?.members[0]
    expect(only?.trackId).toBe('S')
    expect(only?.subject.labelKind).toBe('identity')
    expect(only?.absorbedIds).toEqual(['A'])
    expect(b.resolve(DEV, 'A')).toBe('S')
  })
  it("fusion: two DIFFERENT identities keep the survivor's", () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('S', 1_000))
    b.admit(adm('A', 2_000))
    b.promote({ deviceId: DEV, trackId: 'S', label: PERSON_A, at: 2_500 })
    b.promote({ deviceId: DEV, trackId: 'A', label: PERSON_B, at: 2_600 })
    b.fuse(DEV, 'S', 'A', () => false)
    expect(b.get('r1', DEV, false)?.members[0]?.subject.identityId).toBe('id-a')
  })
  it('fusion: only the absorbed is a member → re-keyed to the survivor', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('A', 1_000))
    const [e] = b.fuse(DEV, 'S', 'A', () => false)
    expect(e?.kind).toBe('rekeyed')
    expect(b.get('r1', DEV, false)?.members.map((m) => m.trackId)).toEqual(['S'])
  })
  it('fusion into an already-notified survivor drops the member; an EMPTIED window is removed (M-T6-2)', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('A', 1_000))
    const [e] = b.fuse(DEV, 'S', 'A', (ruleId, trackId) => ruleId === 'r1' && trackId === 'S')
    expect(e).toMatchObject({ kind: 'dropped-notified', membersAfter: 0, windowRemoved: true })
    expect(b.get('r1', DEV, false)).toBeUndefined()
    // A later subject opens a FRESH window with its own deadline, never the dead one's.
    const again = b.admit(adm('X', 9_000))
    expect(again.kind).toBe('opened')
  })
  it('a window that keeps members after a notified drop stays open', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('A', 1_000))
    b.admit(adm('B', 2_000))
    const [e] = b.fuse(DEV, 'S', 'A', (_r, trackId) => trackId === 'S')
    expect(e).toMatchObject({ kind: 'dropped-notified', membersAfter: 1, windowRemoved: false })
  })
  it("a re-keyed member's first match names the survivor (L-T6-3)", () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('A', 1_000))
    b.fuse(DEV, 'S', 'A', () => false)
    expect(b.get('r1', DEV, false)?.members[0]?.firstMatchedSubject?.trackId).toBe('S')
  })
  it('an early promotion under the absorbed id is found by the survivor (L-T6-2)', () => {
    const b = new NcGroupedWindowBuffer()
    b.promote({ deviceId: DEV, trackId: 'A', label: PERSON_A, at: 900 })
    b.fuse(DEV, 'S', 'A', () => false)
    b.admit(adm('S', 1_000, { matched: false }))
    expect(b.get('r1', DEV, false)?.members[0]?.subject).toMatchObject(PERSON_A)
  })
  it("a promotion is remembered even when it was applied, for another rule's later admission (L-T6-4)", () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000, { matched: false }))
    b.promote({ deviceId: DEV, trackId: 't1', label: PERSON_A, at: 2_000 })
    b.admit(adm('t1', 3_000, { ruleId: 'r2', matched: false }))
    expect(b.get('r2', DEV, false)?.members[0]?.subject).toMatchObject(PERSON_A)
  })
  it('a replaying admission never joins a live window, and vice versa (C5)', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('live', 1_000))
    expect(b.admit(adm('replayed', 900, { replaying: true, origin: 'reconcile' })).kind).toBe(
      'opened',
    )
    expect(b.admit(adm('live2', 1_100)).kind).toBe('joined')
    expect(b.get('r1', DEV, false)?.members.map((m) => m.trackId)).toEqual(['live', 'live2'])
    expect(b.get('r1', DEV, true)?.members.map((m) => m.trackId)).toEqual(['replayed'])
  })
  it('due() skips replaying windows; replayDue() reaches them on the event clock', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000, { replaying: true, origin: 'reconcile' }))
    b.admit(adm('t2', 3_000, { ruleId: 'r2' }))
    expect(b.due(60_000).map((w) => w.ruleId)).toEqual(['r2'])
    expect(b.replayDue('r1', DEV, 20_999)).toHaveLength(0)
    expect(b.replayDue('r1', DEV, 21_000)).toHaveLength(1)
    expect(b.oldestHoldAt()).toBe(1_000)
  })
  it('releaseReplay(now): a due replay window is handed back; a lone one goes live; one beside a live window merges', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('old', 1_000, { ruleId: 'r0', replaying: true, origin: 'reconcile' }))
    b.admit(adm('t1', 30_000, { replaying: true, origin: 'reconcile' }))
    b.admit(adm('t9', 30_000, { ruleId: 'r2', replaying: true, origin: 'reconcile' }))
    b.admit(adm('t8', 40_000, { ruleId: 'r2' }))
    const released = b.releaseReplay(45_000)
    expect(released.map((r) => [r.kind, r.window.ruleId])).toEqual([
      ['due', 'r0'],
      ['released', 'r1'],
      ['merged', 'r2'],
    ])
    expect(b.get('r0', DEV, false)).toBeUndefined()
    expect(b.due(59_000).map((w) => w.ruleId)).toEqual(['r1'])
    expect(b.get('r2', DEV, false)?.members.map((m) => m.trackId)).toEqual(['t8', 't9'])
    expect(b.get('r2', DEV, true)).toBeUndefined()
  })
  it('a replay merge folds a track present in both like a fusion, and reports what did not fit (M-T6-1)', () => {
    const b = new NcGroupedWindowBuffer()
    // Replay window: t1 (first matched at 1 000) and 24 others.
    b.admit(adm('t1', 1_000, { replaying: true, origin: 'reconcile' }))
    for (let i = 0; i < NC_GROUPED_MAX_MEMBERS - 1; i++) {
      b.admit(adm(`r${i}`, 1_100 + i, { replaying: true, origin: 'reconcile' }))
    }
    // Live window: t1 again (seen later), plus filler up to the bound minus one.
    b.admit(adm('t1', 5_000))
    for (let i = 0; i < NC_GROUPED_MAX_MEMBERS - 2; i++) b.admit(adm(`l${i}`, 5_100 + i))
    const [merge] = b.releaseReplay(1_000)
    expect(merge?.kind).toBe('merged')
    const live = b.get('r1', DEV, false)
    const t1 = live?.members.find((m) => m.trackId === 't1')
    // The earlier replay facts win, as in a fusion.
    expect(t1?.firstSeenAt).toBe(1_000)
    expect(t1?.firstMatchedAt).toBe(1_000)
    expect(live?.members).toHaveLength(NC_GROUPED_MAX_MEMBERS)
    // 23 replay-only members, 1 free slot → 22 dropped, named for the caller's log (D391).
    expect(merge?.kind === 'merged' ? merge.dropped.map((m) => m.trackId) : []).toHaveLength(22)
  })
  it('take() removes the window; a later admission opens a NEW key', () => {
    const b = new NcGroupedWindowBuffer()
    const r = b.admit(adm('t1', 1_000))
    if (r.kind !== 'opened') throw new Error('expected opened')
    b.take(r.window.key)
    const again = b.admit(adm('t1', 30_000))
    expect(again.kind).toBe('opened')
    if (again.kind === 'opened') expect(again.window.key).not.toBe(r.window.key)
  })
  it('a returned snapshot cannot be mutated behind the buffer', () => {
    const b = new NcGroupedWindowBuffer()
    const r = b.admit(adm('t1', 1_000))
    if (r.kind !== 'opened') throw new Error('expected opened')
    expect(Object.isFrozen(r.window)).toBe(true)
    expect(Object.isFrozen(r.window.members)).toBe(true)
  })
})

describe("D706: an alarm intrusion window is the RULE's, across cameras", () => {
  const OTHER = 102
  const on = (deviceId: number, trackId: string, at: number): Partial<NcGroupedAdmission> => ({
    deviceId,
    subject: { ...subj(trackId, at), deviceId },
  })

  it('rule scope: two cameras share ONE window, filed under the camera that opened it', () => {
    const b = new NcGroupedWindowBuffer()
    expect(b.admit(adm('t1', 1_000, { scope: 'rule' })).kind).toBe('opened')
    expect(b.admit(adm('t2', 2_000, { ...on(OTHER, 't2', 2_000), scope: 'rule' })).kind).toBe(
      'joined',
    )
    expect(b.all()).toHaveLength(1)
    const w = b.get('r1', OTHER, false, 'rule')
    expect(w?.deviceId).toBe(DEV)
    expect(w?.scope).toBe('rule')
    expect(w?.members.map((m) => [m.trackId, m.subject.deviceId])).toEqual([
      ['t1', DEV],
      ['t2', OTHER],
    ])
  })

  it('camera scope is unchanged, and never mixes with the rule window of the same rule', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000))
    b.admit(adm('t2', 2_000, on(OTHER, 't2', 2_000)))
    b.admit(adm('t3', 3_000, { scope: 'rule' }))
    expect(b.all()).toHaveLength(3)
    expect(b.get('r1', DEV, false)?.members.map((m) => m.trackId)).toEqual(['t1'])
    expect(b.get('r1', DEV, false, 'rule')?.members.map((m) => m.trackId)).toEqual(['t3'])
  })

  it('a member of ANOTHER camera is found by its own camera — close, promotion, fusion', () => {
    const b = new NcGroupedWindowBuffer()
    b.admit(adm('t1', 1_000, { scope: 'rule' }))
    b.admit(adm('t2', 2_000, { ...on(OTHER, 't2', 2_000), scope: 'rule' }))
    b.admit(adm('t3', 2_500, { ...on(OTHER, 't3', 2_500), scope: 'rule' }))
    expect(b.closeTrack(OTHER, 't2', {})).toHaveLength(1)
    expect(b.promote({ deviceId: OTHER, trackId: 't3', label: PERSON_A, at: 3_000 })).toHaveLength(
      1,
    )
    // The same track id on the OPENING camera is a different subject: nothing matches.
    expect(b.closeTrack(DEV, 't2', {})).toHaveLength(0)
    const fused = b.fuse(OTHER, 't3', 't2', () => false)
    expect(fused.map((f) => f.kind)).toEqual(['merged'])
    expect(b.onDevice(OTHER)).toHaveLength(1)
    const w = b.get('r1', DEV, false, 'rule')
    expect(w?.members.map((m) => m.trackId)).toEqual(['t1', 't3'])
    expect(w?.members[1]?.subject.label).toBe('Person A')
  })

  it('taking a rule window frees the rule pair — the next intrusion opens a new one', () => {
    const b = new NcGroupedWindowBuffer()
    const r = b.admit(adm('t1', 1_000, { scope: 'rule' }))
    if (r.kind !== 'opened') throw new Error('not opened')
    b.take(r.window.key)
    expect(b.admit(adm('t2', 2_000, { ...on(OTHER, 't2', 2_000), scope: 'rule' })).kind).toBe(
      'opened',
    )
  })
})
