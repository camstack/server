/**
 * The facade (§2, §6.1): emitted ids are chain roots, fusions surface once, a
 * chain is live while any member is, and a SILENT camera — no frame at all
 * after the last detection, which is what the motion gate does (D438) —
 * still ends its tracklets and commits its fusions through `advance`.
 *
 * Disarms (each alone, restored):
 *  - in `emit`, use `tr.id` instead of `this.l2.rootOf(tr.id)`: "the
 *    continuing tracklet emits the survivor id" fails;
 *  - in `link`, hand L2 only the ENDED tracklets (the linker's contract is
 *    every live piece, with a current `lastSeenAt`): the same test fails — the
 *    arc into a still-live piece never exists;
 *  - remove `this.l1.expire(now)` from `advance`: "a silent camera ends its
 *    tracklets and commits the fusion through advance" fails;
 *  - in `toPiece`, drop `&& !tr.suppressed`: "a birth the confirmation gate
 *    suppressed never becomes a link end" fails;
 *  - make `dropTrack` ignore its reason (always `dropped`): "a registry
 *    promotion (`stationary`) may still be linked" fails;
 *  - remove `this.l2.prune(now)` from `link`: "both layers are pruned…" fails
 *    (the absorbed id still resolves to its survivor a minute after the chain ended);
 *  - remove `this.l1.prune(now)` from `link`: the same test fails — L1 keeps
 *    re-sending ended tracklets L2 already forgot, and L2 reports each `ignored`;
 *  - in `heldThisFrame`, read the tracklet's sticky flag alone (drop
 *    `assocAt === t`): "heldByLowScore is per frame" fails on the coast after
 *    the hold (Task 6 note: the flag stays `true` until the next confident box);
 *  - (fix round 1, review L2) in `update`, link at the frame's `t` instead of
 *    `this.lastT`: "a frame older than the last advance never runs L2 backwards" fails;
 *  - in `TrackletTracker.emissions`, drop `if (!tr.confirmed) continue`: "confirmed
 *    is the tracklet own birth gate" fails (two emissions before `minHits`, each
 *    `confirmed: false`). A constant `confirmed: true` alone cannot fail while L1
 *    emits confirmed tracklets only — the pin is on what is emitted.
 */
import type { BoundingBox, SpatialDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sequentialTrackIdMinter } from '../../track-id.js'
import { LINK_WINDOW_MS } from '../constants.js'
import { TrackerV2 } from '../tracker-v2.js'
import { DEFAULT_TRACKER_V2_CONFIG, type LinkDecisionFacts } from '../types.js'

const CTX = { frameWidth: 3840, frameHeight: 2160 }
const box = (x: number): BoundingBox => ({ x, y: 100, w: 100, h: 200 })
const det = (x: number, score = 0.9): SpatialDetection => ({
  class: 'person',
  originalClass: 'person',
  score,
  bbox: box(x),
})

function tracker(links: LinkDecisionFacts[] = []): TrackerV2 {
  return new TrackerV2(DEFAULT_TRACKER_V2_CONFIG, {
    mintTrackId: sequentialTrackIdMinter(),
    observers: { link: (f) => links.push(f) },
  })
}

/**
 * A (t1) walks 0–520 ms; 1.9 s later B (t2) appears 110 px from A's last box —
 * no overlap, so A's coasting gate cannot take it (104's "near, IoU < 0.3") —
 * and walks on until `until`.
 */
function reappearance(tr: TrackerV2, until: number): number {
  let t = 0
  for (let i = 0; i < 5; i++, t += 130) tr.update([det(100 + i * 5)], t, CTX)
  for (t = 2420; t <= until; t += 130)
    tr.update([det(230 + Math.min(10, (t - 2420) / 130))], t, CTX)
  return t - 130
}

describe('TrackerV2', () => {
  it('the continuing tracklet emits the survivor id, and the fusion surfaces once', () => {
    const tr = tracker()
    const last = reappearance(tr, 11_000)
    const out = tr.update([det(240)], last + 130, CTX)
    expect(out[0]?.trackId).toBe('t1')
    expect(tr.drainFusions().map((f) => [f.survivorId, f.absorbedId])).toEqual([['t1', 't2']])
    expect(tr.drainFusions()).toEqual([])
    expect([tr.isLive('t1'), tr.isLive('t2')]).toEqual([true, true])
  })

  it('a silent camera ends its tracklets and commits the fusion through advance', () => {
    const tr = tracker()
    const last = reappearance(tr, 3700)
    // No frame after `last`: only the sweep's advance runs.
    tr.advance(9000)
    expect(tr.isLive('t1')).toBe(false)
    expect(tr.isLive('t2')).toBe(false)
    expect(tr.drainFusions()).toEqual([])
    tr.advance(10_600)
    expect(tr.drainFusions().map((f) => [f.survivorId, f.absorbedId])).toEqual([['t1', 't2']])
    expect(tr.isTailFinal('t1', 10_600)).toBe(false)
    expect(tr.isTailFinal('t1', last + 10_001)).toBe(true)
  })

  it('dropTrack ends every live member of the chain and they are never linked', () => {
    const tr = tracker()
    let t = 0
    for (let i = 0; i < 5; i++, t += 130) tr.update([det(100 + i * 5)], t, CTX)
    tr.dropTrack('t1')
    expect(tr.isLive('t1')).toBe(false)
    for (let i = 0; i < 5; i++, t += 130) tr.update([det(125 + i * 5)], t + 200, CTX)
    tr.advance(t + 30_000)
    expect(tr.drainFusions()).toEqual([])
  })

  it('a registry promotion (`stationary`) may still be linked when the subject moves again (round 4)', () => {
    const tr = tracker()
    let t = 0
    for (let i = 0; i < 5; i++, t += 130) tr.update([det(100 + i * 5)], t, CTX)
    tr.dropTrack('t1', 'stationary')
    // It moves again 2 s later, 30 px away: a new piece, and L2 links it.
    for (let i = 0; i < 25; i++, t += 130) tr.update([det(150 + i * 5)], t + 2000, CTX)
    tr.advance(t + 30_000)
    expect(tr.drainFusions().map((f) => [f.absorbedId, f.survivorId])).toEqual([['t2', 't1']])
  })

  it('a birth the confirmation gate suppressed never becomes a link end', () => {
    const tr = tracker()
    let t = 0
    for (let i = 0; i < 5; i++, t += 130) tr.update([det(100 + i * 5)], t, CTX)
    tr.markSuppressed('t1')
    for (t = 2420; t <= 3700; t += 130) tr.update([det(230)], t, CTX)
    tr.advance(30_000)
    expect(tr.drainFusions()).toEqual([])
  })

  it('confirmed is the tracklet own birth gate: nothing is emitted before minHits, then confirmed', () => {
    const tr = tracker()
    const counts: number[] = []
    const flags: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const out = tr.update([det(100 + i * 5)], i * 130, CTX)
      counts.push(out.length)
      flags.push(...out.map((e) => e.confirmed))
    }
    expect(counts).toEqual([0, 0, 1, 1])
    expect(flags).toEqual([true, true])
  })

  it('heldByLowScore is per frame: the coast after a sub-floor hold does not report it', () => {
    const tr = tracker()
    let t = 0
    for (let i = 0; i < 3; i++, t += 130) tr.update([det(100 + i * 10)], t, CTX)
    // A sub-floor box on the prediction holds it…
    const held = tr.update([], t, { ...CTX, lowScore: [det(130, 0.4)] })
    expect(held.map((e) => [e.trackId, e.matchedThisFrame, e.heldByLowScore])).toEqual([
      ['t1', false, true],
    ])
    // …the next frame has no sub-floor box: an ordinary coast.
    const coast = tr.update([], t + 130, CTX)
    expect(coast.map((e) => [e.trackId, e.matchedThisFrame, e.heldByLowScore])).toEqual([
      ['t1', false, undefined],
    ])
    // A confident sighting never reports it either.
    const seen = tr.update([det(150)], t + 260, CTX)
    expect(seen.map((e) => [e.matchedThisFrame, e.heldByLowScore])).toEqual([[true, undefined]])
  })

  it('both layers are pruned as frames run: a chain ended past the window is forgotten, never re-sent', () => {
    const links: LinkDecisionFacts[] = []
    const tr = tracker(links)
    const last = reappearance(tr, 3700)
    tr.advance(10_600)
    expect(tr.drainFusions().map((f) => f.absorbedId)).toEqual(['t2'])
    expect(tr.rootOf('t2')).toBe('t1')
    // A minute and more later, frames of an unrelated subject keep the step running.
    for (let t = last + LINK_WINDOW_MS + 5000; t < last + LINK_WINDOW_MS + 6000; t += 130)
      tr.update([det(2000)], t, CTX)
    // L2 forgot the chain, and L1 no longer hands it the ended pieces.
    expect(tr.rootOf('t2')).toBe('t2')
    expect(links.filter((l) => l.kind === 'ignored')).toEqual([])
  })

  it('a frame older than the last advance never runs L2 backwards (review L2)', () => {
    const links: LinkDecisionFacts[] = []
    const tr = tracker(links)
    tr.advance(20_000)
    // A frame stamped before the sweep's `now`: L2 steps at the latest time seen,
    // so a birth past `maxMissedMs` of that clock is decided at once.
    tr.update([det(2000)], 5000, CTX)
    expect(links.map((l) => [l.kind, l.to, l.t])).toEqual([['new', 't1', 20_000]])
  })
})
