/**
 * L2 (§4). Real geometry where the analysis measured it: 102 28/09
 * 08:47:32.214Z (×9.5) and 101 29/09 06:58:05.350Z (×3.6).
 *
 * Disarms (each alone, restored; each named test must turn RED):
 *  - restore the pre-review rule (arcs only from ENDED pieces, and `new` on the
 *    first step without a candidate): "a re-appearance while the first piece still coasts links";
 *  - drop the `+ maxMissedMs` delay before `new`: "a piece with no candidate is decided new only after maxMissedMs";
 *  - drop the `now >= from.lastSeenAt + LINK_MAX_GAP_MS` readiness term: "commits only when every competitor is known";
 *  - evaluate refusals before commits with the old `B.start + 10 s` deadline: "a sparse step never refuses a ready arc";
 *  - drop the `!from.confirmed` check: "an unconfirmed flicker never takes the link";
 *  - drop the ambiguity check: "two equal predecessors are refused, never guessed";
 *  - drop `identitiesConflict`: "two recognised people never fuse";
 *  - drop the recognition wait from `ready`: "face-bearing pieces wait for recognition" fails;
 *  - hold only to the ordinary deadline (drop the `FACE_SETTLE_HOLD_MS` term): the same test fails at 13 001;
 *  - leave the face hold out of the refusal deadline: "a face wait moves the refusal deadline" fails;
 *  - drop the area bar: "a box ×3.6 the size of the lost person" fails — on its
 *    concentric variant and on the `area` label. Task 7 ran it: the real 101 scene
 *    ALONE stayed green, because without the bar its size term takes it to cost
 *    1.13 > LINK_MAX_COST (the 102 car test does not fail either — its reach
 *    refuses it, 1 133 px against 562 px; review 2 L2);
 *  - drop the vehicle flat reach: "a vehicle keeps the flat reach" fails. (The
 *    brief named the 102 car test here; run for real it stays green — its ×9.5
 *    is refused by the area bar, and by the cost cap behind that. The car test
 *    is a real-scene pin guarded three times, not one gate's test.);
 *  - always report `reason: 'ambiguous'`: "a predecessor that never ends is refused as predecessor-live" fails;
 *  - drop the contested line: "a contested piece never links on geometry alone".
 *
 * Task 7 additions — each RED on the brief's implementation, then (disarm) RED again
 * when its fix alone is removed:
 *  - commit without re-checking the arc against the chains an earlier commit of the
 *    SAME step built: "a sparse step never fuses two recognised people through a faceless piece";
 *  - judge ambiguity only against arcs into UNDECIDED pieces (no refused competitor):
 *    "a predecessor's second successor never inherits it after the first is refused";
 *  - prune a piece on its own end time instead of its chain's: "pruning never forgets
 *    a chain's identity while a member is recent";
 *  - apply the contested rule to the later piece only: "a contested predecessor never
 *    links on geometry alone";
 *  - drop the root-undecided term from `isTailFinal`: "a tail is not final while its
 *    own chain may still be absorbed";
 *  - drop `candidates` from a refusal / a `new`: "every decision names its candidates…".
 *
 * Fix round 1 (task-7 review) — each new test RED on 46ed8cb5e, then each disarm alone RED:
 *  - never return `face-unmatched` (commit on geometry once the hold expires with one
 *    side named): "face-bearing pieces wait … one named side … is refused" (and the tombstone test);
 *  - drop the `faceless-live` rule: "a chain with a face never absorbs a live piece
 *    that has shown no face yet" (review H1);
 *  - never emit `disagreed`: "a chain that gains a second name after its commit is reported" (H2);
 *  - drop the `to.endReason === 'dropped'` line in `weigh`: "a dropped piece is never absorbed" (M2);
 *  - drop the re-send guard in `accept`: "a piece re-sent after prune is ignored…" (M3);
 *  - read only the CURRENT name in `chainIdentities`: "a retracted name still counts…" (L1).
 * Task 8 fix round 1 (review M3): `FACE_SETTLE_HOLD_MS` → 40_000: "the latest refusal still finds
 * its predecessor…" fails (A is pruned at 66 s, before the refusal at 70.9 s, and B is decided
 * `new / no-candidate`). `LINK_WINDOW_MS` → 50_000 stays green HERE (the refusal step runs before
 * that step's prune); the formula in `constants.spec.ts` is the conservative guard.
 * The face-hold test's old ending ("then commit on the rest" with one side named) is
 * superseded by the ruling; its stranger case (neither side named) still commits at 23 001.
 * The prune test was rebuilt: its long LIVE faceless continuation can no longer join a
 * face-bearing chain (H1), so the chain is six short faceless pieces that each ended.
 */
import type { BoundingBox } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  confirmedPredecessorRejections,
  DeferredLinker,
  type LinkerConfig,
  type LinkPiece,
} from '../linker.js'
import type { LinkDecisionFacts, TrackFusion } from '../types.js'

const CFG: LinkerConfig = { maxMissedMs: 4000, appearanceResolvesAmbiguity: false }
const b = (x: number, y = 100, w = 100, h = 200): BoundingBox => ({ x, y, w, h })

function piece(id: string, over: Partial<LinkPiece>): LinkPiece {
  return {
    id,
    klass: 'person',
    startedAt: 0,
    lastSeenAt: 0,
    endedAt: null,
    endReason: null,
    confirmed: true,
    contested: false,
    faceBearing: false,
    firstFaceAt: null,
    identity: null,
    firstBox: b(100),
    lastBox: b(100),
    appearance: null,
    lineage: { kind: 'birth' },
    ...over,
  }
}

const ended = (
  id: string,
  last: number,
  box: BoundingBox,
  over: Partial<LinkPiece> = {},
): LinkPiece =>
  piece(id, {
    startedAt: 0,
    lastSeenAt: last,
    endedAt: last,
    endReason: 'missed',
    lastBox: box,
    firstBox: box,
    ...over,
  })

/** A piece as a step at `t` sees it: absent before it starts, live until it ends. */
function seenAt(full: LinkPiece, t: number): readonly LinkPiece[] {
  if (t < full.startedAt) return []
  if (full.endedAt !== null && t >= full.endedAt) return [full]
  return [{ ...full, lastSeenAt: Math.min(t, full.lastSeenAt), endedAt: null, endReason: null }]
}

describe('DeferredLinker', () => {
  it('a re-appearance while the first piece still coasts links (104, gap 1.9 s — review C1)', () => {
    const l = new DeferredLinker(CFG)
    const coasting = piece('a', { lastSeenAt: 1000, lastBox: b(100), firstBox: b(100) })
    const next = piece('b', {
      startedAt: 2900,
      lastSeenAt: 4000,
      firstBox: b(130),
      lastBox: b(130),
    })
    expect(l.step(3000, [coasting, next])).toEqual([])
    expect(l.outcome('b')).toBe('pending')
    // a ends `missed` at its last sighting once the coast budget is spent.
    const aEnded = { ...coasting, endedAt: 1000, endReason: 'missed' as const }
    const fused = l.step(11_000, [aEnded, next])
    expect(fused.map((f) => [f.survivorId, f.absorbedId])).toEqual([['a', 'b']])
  })

  it('commits only when every competitor is known, and the survivor is the earliest id', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const bb = piece('b', { startedAt: 3000, lastSeenAt: 3500, firstBox: b(130), lastBox: b(130) })
    expect(l.step(3500, [a, bb])).toEqual([])
    expect(l.step(10_999, [a, bb])).toEqual([])
    expect(l.step(11_000, [a, bb]).map((f) => [f.survivorId, f.absorbedId, f.members])).toEqual([
      ['a', 'b', ['b']],
    ])
    expect(l.rootOf('b')).toBe('a')
  })

  it('a sparse step never refuses a ready arc (review H1)', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const bb = piece('b', { startedAt: 3000, lastSeenAt: 3500, firstBox: b(130), lastBox: b(130) })
    expect(l.step(10_000, [a, bb])).toEqual([])
    expect(l.step(15_000, [a, bb])).toHaveLength(1)
  })

  it('an unconfirmed flicker never takes the link (review H2)', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const flicker = ended('f', 2200, b(110), { startedAt: 2000, confirmed: false })
    const bb = piece('b', { startedAt: 3000, lastSeenAt: 3500, firstBox: b(120), lastBox: b(120) })
    expect(l.step(20_000, [a, flicker, bb]).map((f) => [f.survivorId, f.absorbedId])).toEqual([
      ['a', 'b'],
    ])
  })

  it('an unconfirmed later piece commits only once confirmed', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const young = piece('b', {
      startedAt: 3000,
      lastSeenAt: 3200,
      firstBox: b(130),
      confirmed: false,
    })
    expect(l.step(11_000, [a, young])).toEqual([])
    expect(l.step(11_130, [a, { ...young, confirmed: true }])).toHaveLength(1)
  })

  it('two equal predecessors are refused, never guessed', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const pieces = [
      ended('a1', 1000, b(100)),
      ended('a2', 1000, b(160)),
      piece('b', { startedAt: 3000, lastSeenAt: 3000, firstBox: b(130) }),
    ]
    expect(l.step(11_000, pieces)).toEqual([])
    expect(l.outcome('b')).toBe('pending')
    // deadline = max(3000 + 10 000, 1000 + 10 000) + 5 000 = 18 000
    expect(l.step(18_001, pieces)).toEqual([])
    expect(l.outcome('b')).toBe('ambiguous')
    expect(facts.at(-1)).toMatchObject({ kind: 'refused', to: 'b', reason: 'ambiguous' })
  })

  it('a piece with no candidate is decided new only after maxMissedMs, and says so', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const lone = piece('n', { startedAt: 1000, lastSeenAt: 1000 })
    l.step(1000, [lone])
    expect(l.outcome('n')).toBe('pending')
    l.step(5001, [lone])
    expect(l.outcome('n')).toBe('new')
    expect(facts).toContainEqual(expect.objectContaining({ kind: 'new', to: 'n' }))
  })

  it('two recognised people never fuse (review C3: the recognizer verdict, per track)', () => {
    const a = ended('a', 1000, b(100), { faceBearing: true, identity: 'bob' })
    const other = piece('b', {
      startedAt: 2000,
      lastSeenAt: 2500,
      firstBox: b(110),
      faceBearing: true,
      identity: 'alice',
    })
    expect(new DeferredLinker(CFG).step(20_000, [a, other])).toEqual([])
    const same = piece('c', {
      startedAt: 2000,
      lastSeenAt: 2500,
      firstBox: b(110),
      faceBearing: true,
      identity: 'bob',
    })
    expect(new DeferredLinker(CFG).step(20_000, [a, same])).toHaveLength(1)
  })

  it('face-bearing pieces wait for recognition from the first face, up to FACE_SETTLE_HOLD_MS; one named side against an unmatched face is refused (fix round 1)', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const a = ended('a', 1000, b(100), { faceBearing: true, firstFaceAt: 200, identity: 'bob' })
    const bb = piece('b', {
      startedAt: 3000,
      lastSeenAt: 4000,
      firstBox: b(130),
      faceBearing: true,
      firstFaceAt: 3000,
    })
    // Ready by every other rule at 11 000, but b's identity has not settled.
    expect(l.step(11_000, [a, bb])).toEqual([])
    // Past the ordinary hold (13 000) it still waits: b's first face + 20 000 = 23 000.
    expect(l.step(13_001, [a, bb])).toEqual([])
    // Past the hold: a named person against a face recognition did not match to
    // her in 20 s is evidence of a second person — never committed, refused at 28 000.
    const fused = []
    for (let t = 23_001; t <= 40_000; t += 500) fused.push(...l.step(t, [a, bb]))
    expect(fused).toEqual([])
    expect(l.outcome('b')).toBe('ambiguous')
    expect(facts).toContainEqual(
      expect.objectContaining({ kind: 'refused', to: 'b', reason: 'face-unmatched' }),
    )
    // Named at +16 s, equal: commits then, not at the cap.
    const m = new DeferredLinker(CFG)
    expect(m.step(13_001, [a, bb])).toEqual([])
    expect(m.step(16_000, [a, { ...bb, identity: 'bob' }])).toHaveLength(1)
    // Named inside the refusal margin (23 000 → 28 000), equal: still commits.
    const late = new DeferredLinker(CFG)
    expect(late.step(23_001, [a, bb])).toEqual([])
    expect(late.step(25_000, [a, { ...bb, identity: 'bob' }])).toHaveLength(1)
    // Strangers — neither side named: the hold runs out and geometry decides (§4.4).
    const s: LinkDecisionFacts[] = []
    const strangers = new DeferredLinker(CFG, (f) => s.push(f))
    const anon = { ...a, identity: null }
    expect(strangers.step(23_000, [anon, bb])).toEqual([])
    expect(strangers.step(23_001, [anon, bb])).toHaveLength(1)
    expect(s).toContainEqual(
      expect.objectContaining({ kind: 'committed', recognition: 'waited-unsettled' }),
    )
  })

  it('a chain with a face never absorbs a live piece that has shown no face yet (review H1)', () => {
    // Bob leaves at 1 s. b walks in at 3 s with its back turned, shows its face
    // at 15 s and is named Alice at 27 s. On geometry alone a→b was ready at 11 s.
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100), { faceBearing: true, firstFaceAt: 0, identity: 'bob' })
    const bAt = (t: number): LinkPiece =>
      piece('b', {
        startedAt: 3000,
        lastSeenAt: Math.min(t, 40_000),
        endedAt: t >= 40_000 ? 40_000 : null,
        endReason: t >= 40_000 ? 'missed' : null,
        firstBox: b(130),
        faceBearing: t >= 15_000,
        firstFaceAt: t >= 15_000 ? 15_000 : null,
        identity: t >= 27_000 ? 'alice' : null,
      })
    const fused = []
    for (let t = 3000; t <= 60_000; t += 100) fused.push(...l.step(t, [a, bAt(t)]))
    expect(fused).toEqual([])
    expect(l.rootOf('b')).toBe('b')
    // A faceless piece that has ENDED is complete evidence: it links on geometry.
    const done = new DeferredLinker(CFG)
    const short = ended('s', 6000, b(130), { startedAt: 3000 })
    expect(done.step(11_000, [a, short])).toHaveLength(1)
    // A faceless piece still live past its deadline is refused, and says why.
    const facts: LinkDecisionFacts[] = []
    const still = new DeferredLinker(CFG, (f) => facts.push(f))
    const walker = piece('w', { startedAt: 3000, lastSeenAt: 30_000, firstBox: b(130) })
    for (let t = 3000; t <= 20_000; t += 500) still.step(t, [a, walker])
    expect(facts).toContainEqual(
      expect.objectContaining({ kind: 'refused', to: 'w', reason: 'faceless-live' }),
    )
  })

  it('a chain that gains a second name after its commit is reported (review H2)', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const a = ended('a', 1000, b(100), { faceBearing: true, firstFaceAt: 0 })
    const bb = ended('b', 9000, b(120), { startedAt: 3000, faceBearing: true, firstFaceAt: 3000 })
    // Strangers at the commit: geometry decides after the hold.
    expect(l.step(23_001, [a, bb])).toHaveLength(1)
    l.step(30_000, [{ ...a, identity: 'bob' }, bb])
    expect(facts.filter((f) => f.kind === 'disagreed')).toEqual([])
    const named = [
      { ...a, identity: 'bob' },
      { ...bb, identity: 'alice' },
    ]
    l.step(35_000, named)
    l.step(36_000, named)
    expect(facts.filter((f) => f.kind === 'disagreed')).toEqual([
      {
        t: 35_000,
        kind: 'disagreed',
        from: 'a',
        to: 'b',
        root: 'a',
        members: ['a', 'b'],
        identities: ['alice', 'bob'],
        recognition: 'waited-unsettled',
      },
    ])
  })

  it('a dropped piece is never absorbed as a successor (review M2)', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const a = ended('a', 1000, b(100))
    const d = ended('d', 5000, b(120), { startedAt: 3000, endReason: 'dropped' })
    expect(l.step(20_000, [a, d])).toEqual([])
    expect(l.outcome('d')).toBe('new')
    expect(facts).toContainEqual(
      expect.objectContaining({ kind: 'new', to: 'd', reason: 'dropped' }),
    )
  })

  it('a piece re-sent after prune is ignored and logged, never linked again (review M3)', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const a = ended('a', 1000, b(100))
    const bb = ended('b', 5000, b(120), { startedAt: 3000 })
    expect(l.step(11_000, [a, bb])).toHaveLength(1)
    l.prune(70_000)
    expect(l.step(70_100, [a, bb])).toEqual([])
    expect(l.step(80_100, [a, bb])).toEqual([])
    expect(facts).toContainEqual({ t: 70_100, kind: 'ignored', to: 'a', reason: 'pruned' })
    expect(facts).toContainEqual({ t: 70_100, kind: 'ignored', to: 'b', reason: 'pruned' })
  })

  it('a retracted name still counts for the cannot-link (review L1: a tombstone)', () => {
    // Bob, retracted at 9 s (the recognizer doubted it). c's face is never matched
    // inside the hold; without the tombstone both sides read "never named" and geometry
    // would fuse them — then a restore names one chain twice.
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const named = ended('a', 1000, b(100), {
      faceBearing: true,
      firstFaceAt: 0,
      identity: 'bob',
    })
    const retracted = { ...named, identity: null }
    const c = ended('c', 9000, b(120), { startedAt: 3000, faceBearing: true, firstFaceAt: 3000 })
    l.step(5000, [named, c])
    const fused = []
    for (let t = 9000; t <= 40_000; t += 500) fused.push(...l.step(t, [retracted, c]))
    expect(fused).toEqual([])
    expect(facts).toContainEqual(
      expect.objectContaining({ kind: 'refused', to: 'c', reason: 'face-unmatched' }),
    )
  })

  it('a face wait moves the refusal deadline', () => {
    // Two equal predecessors would be refused at max(13 000, 11 000) + 5 000 = 18 000 —
    // but b is face-bearing and unnamed, so nothing is refused before 23 000 + 5 000.
    const l = new DeferredLinker(CFG)
    const a1 = ended('a1', 1000, b(100), { faceBearing: true, firstFaceAt: 0, identity: 'bob' })
    const a2 = ended('a2', 1000, b(160), {
      faceBearing: true,
      firstFaceAt: 0,
      identity: 'alice',
    })
    const bb = piece('b', {
      startedAt: 3000,
      lastSeenAt: 4000,
      firstBox: b(130),
      faceBearing: true,
      firstFaceAt: 3000,
    })
    l.step(18_001, [a1, a2, bb])
    expect(l.outcome('b')).toBe('pending')
    l.step(21_000, [a1, a2, { ...bb, identity: 'alice' }])
    expect(l.rootOf('b')).toBe('a2')
  })

  it('a predecessor that never ends is refused as predecessor-live, not as ambiguous (review 2 L3)', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const live = piece('p', { startedAt: 0, lastSeenAt: 1000, confirmed: true })
    const bb = piece('b', { startedAt: 3000, lastSeenAt: 4000, firstBox: b(130) })
    l.step(18_001, [live, bb])
    expect(facts).toContainEqual(
      expect.objectContaining({ kind: 'refused', to: 'b', reason: 'predecessor-live' }),
    )
  })

  it('102 28/09 08:47:32Z: an arriving car does not inherit the leaving car (×9.5)', () => {
    const gone = ended('car1', 0, { x: 2748, y: 582, w: 409, h: 628 }, { klass: 'vehicle' })
    const arriving = piece('car2', {
      klass: 'vehicle',
      startedAt: 9850,
      lastSeenAt: 12_000,
      firstBox: { x: 2070, y: 2, w: 235, h: 115 },
    })
    expect(new DeferredLinker(CFG).step(30_000, [gone, arriving])).toEqual([])
  })

  it('101 29/09 06:58:05Z: a box ×3.6 the size of the lost person is not that person', () => {
    const facts: LinkDecisionFacts[] = []
    const lost = ended('p1', 0, { x: 3005, y: 86, w: 379, h: 252 })
    const next = piece('p2', {
      startedAt: 4500,
      lastSeenAt: 6000,
      firstBox: { x: 2435, y: 0, w: 641, h: 538 },
    })
    expect(new DeferredLinker(CFG, (f) => facts.push(f)).step(30_000, [lost, next])).toEqual([])
    // Measured: 443 px inside a 512 px reach — the area bar is what refuses the real scene.
    expect(facts).toContainEqual(
      expect.objectContaining({
        to: 'p2',
        candidates: [expect.objectContaining({ from: 'p1', rejected: 'area' })],
      }),
    )
    // The real scene would ALSO exceed LINK_MAX_COST without the bar (1.13), so it
    // cannot pin the bar alone: the same ×3.6 box on the lost person's centre, 1 s
    // later, costs 0.71 — only the bar refuses it.
    const c = { x: 3005 + 379 / 2, y: 86 + 252 / 2 }
    const concentric = piece('p3', {
      startedAt: 1000,
      lastSeenAt: 6000,
      firstBox: { x: c.x - 641 / 2, y: c.y - 538 / 2, w: 641, h: 538 },
    })
    expect(new DeferredLinker(CFG).step(30_000, [lost, concentric])).toEqual([])
  })

  it('a vehicle keeps the flat reach; a person at the same distance links', () => {
    const box = b(1000, 300, 300, 400)
    const far = { ...box, x: 1000 + 1.2 * 500 }
    expect(
      new DeferredLinker(CFG).step(30_000, [
        ended('v1', 0, box, { klass: 'vehicle' }),
        piece('v2', { klass: 'vehicle', startedAt: 6000, lastSeenAt: 8000, firstBox: far }),
      ]),
    ).toEqual([])
    expect(
      new DeferredLinker(CFG).step(30_000, [
        ended('h1', 0, box),
        piece('h2', { startedAt: 6000, lastSeenAt: 8000, firstBox: far }),
      ]),
    ).toHaveLength(1)
  })

  it('re-roots a chain: a later piece of the absorbed chain resolves to the survivor', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const bb = piece('b', {
      startedAt: 3000,
      lastSeenAt: 4000,
      endedAt: 4000,
      endReason: 'missed',
      firstBox: b(120),
      lastBox: b(140),
    })
    l.step(11_000, [a, bb])
    const c = piece('c', { startedAt: 5000, lastSeenAt: 9000, firstBox: b(150) })
    expect(l.step(14_000, [a, bb, c]).map((f) => [f.survivorId, f.absorbedId])).toEqual([
      ['a', 'c'],
    ])
    expect(l.membersOf('a')).toEqual(['a', 'b', 'c'])
  })

  it('a tail is final only when its gap has passed and nothing is pending', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const notLive = (): boolean => false
    l.step(5000, [a])
    expect(l.isTailFinal('a', 5000, notLive)).toBe(false)
    expect(l.isTailFinal('a', 11_000, notLive)).toBe(true)
    l.step(11_000, [a, piece('b', { startedAt: 9000, lastSeenAt: 9500, firstBox: b(110) })])
    expect(l.isTailFinal('a', 11_000, notLive)).toBe(false)
  })

  it('a contested piece never links on geometry alone', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const x = piece('x', {
      startedAt: 1100,
      lastSeenAt: 2000,
      firstBox: b(102),
      contested: true,
      lineage: { kind: 'split', from: ['a'] },
    })
    expect(l.step(20_000, [a, x])).toEqual([])
    expect(l.outcome('x')).toBe('new')
  })

  // ── Task 7 additions ─────────────────────────────────────────────────────

  it('a contested predecessor never links on geometry alone', () => {
    // Its last boxes may be the other subject's: a doubt it ended in is not resolved by L2.
    const l = new DeferredLinker(CFG)
    const x = ended('x', 1000, b(100), { contested: true, lineage: { kind: 'split', from: ['p'] } })
    const next = piece('n', { startedAt: 3000, lastSeenAt: 4000, firstBox: b(120) })
    expect(l.step(20_000, [x, next])).toEqual([])
    expect(l.outcome('n')).toBe('new')
  })

  it('a sparse step never fuses two recognised people through a faceless piece (adversarial)', () => {
    // Bob leaves; a faceless piece (back turned) walks 2–4 s; Alice 6–9 s.
    // x→a and a→y are each feasible (a names nobody) and both ready at 14 000.
    // Dense steps commit x→a at 11 000 and then a→y is a two-identity chain,
    // refused. One sparse step (the 5 s sweep, `finish`) must decide the same.
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const x = ended('x', 1000, b(100), { faceBearing: true, firstFaceAt: 0, identity: 'bob' })
    const a = piece('a', {
      startedAt: 3000,
      lastSeenAt: 4000,
      endedAt: 4000,
      endReason: 'missed',
      firstBox: b(120),
      lastBox: b(120),
    })
    const y = piece('y', {
      startedAt: 6000,
      lastSeenAt: 9000,
      firstBox: b(140),
      faceBearing: true,
      firstFaceAt: 6000,
      identity: 'alice',
    })
    const fused = l.step(14_000, [x, a, y])
    expect(fused.map((f) => [f.survivorId, f.absorbedId])).toEqual([['x', 'a']])
    expect(l.rootOf('y')).toBe('y')
    expect(l.outcome('y')).toBe('new')
    expect(facts).toContainEqual(
      expect.objectContaining({
        kind: 'new',
        to: 'y',
        candidates: expect.arrayContaining([
          expect.objectContaining({ from: 'a', rejected: 'identity-conflict' }),
        ]),
      }),
    )
  })

  it("a predecessor's second successor never inherits it after the first is refused (adversarial)", () => {
    // One person leaves at x=100; two DIFFERENT people (concurrent) appear 30 px either
    // side, at 3 s and at 5 s. Either could be the first; the refusal of the first
    // (deadline 18 000) must not hand the predecessor to the second (deadline 20 000).
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const a = ended('a', 1000, b(100))
    const b1 = piece('b1', { startedAt: 3000, lastSeenAt: 9000, firstBox: b(130) })
    const b2 = piece('b2', { startedAt: 5000, lastSeenAt: 9000, firstBox: b(70) })
    const all: TrackFusion[] = []
    for (let t = 11_000; t <= 25_000; t += 100) all.push(...l.step(t, [a, b1, b2]))
    expect(all).toEqual([])
    expect(l.outcome('b1')).toBe('ambiguous')
    expect(l.outcome('b2')).toBe('ambiguous')
    expect(facts.filter((f) => f.kind === 'refused').map((f) => [f.to, f.reason])).toEqual([
      ['b1', 'ambiguous'],
      ['b2', 'ambiguous'],
    ])
    // b2's refusal names the refused rival that kept it ambiguous (D391).
    const b2Refusal = facts.find((f) => f.kind === 'refused' && f.to === 'b2')
    expect(b2Refusal?.candidates?.map((c) => [c.from, c.to])).toEqual([
      ['a', 'b2'],
      ['a', 'b1'],
    ])
  })

  it('two people leave and two come back between them: nothing is guessed (adversarial)', () => {
    const l = new DeferredLinker(CFG)
    const pieces = [
      ended('a1', 1000, b(100)),
      ended('a2', 1000, b(300)),
      piece('b1', { startedAt: 3000, lastSeenAt: 9000, firstBox: b(190) }),
      piece('b2', { startedAt: 3000, lastSeenAt: 9000, firstBox: b(210) }),
    ]
    const fused = []
    for (let t = 3000; t <= 25_000; t += 500) fused.push(...l.step(t, pieces))
    expect(fused).toEqual([])
    expect([l.outcome('b1'), l.outcome('b2')]).toEqual(['ambiguous', 'ambiguous'])
  })

  it('a look-alike at the same spot: a different name refuses it; no face and no appearance cannot (pinned limit)', () => {
    // Bob leaves; someone else steps into her spot 2 s later.
    const bob = ended('r', 1000, b(100), {
      faceBearing: true,
      firstFaceAt: 0,
      identity: 'bob',
    })
    const other = piece('o', {
      startedAt: 3000,
      lastSeenAt: 8000,
      firstBox: b(110),
      faceBearing: true,
      firstFaceAt: 4000,
    })
    const named = new DeferredLinker(CFG)
    for (let t = 3000; t < 18_000; t += 500) expect(named.step(t, [bob, other])).toEqual([])
    named.step(18_000, [bob, { ...other, identity: 'alice' }])
    for (let t = 18_000; t <= 40_000; t += 500)
      expect(named.step(t, [bob, { ...other, identity: 'alice' }])).toEqual([])
    expect(named.outcome('o')).toBe('new')
    // Without a face on either side and with appearance uncalibrated (Task 23), geometry
    // is all L2 has: the look-alike IS fused. Pinned so a change of this is deliberate.
    const faceless = new DeferredLinker(CFG)
    const fused = faceless.step(14_000, [
      ended('r', 1000, b(100)),
      piece('o', { startedAt: 3000, lastSeenAt: 8000, firstBox: b(110) }),
    ])
    expect(fused.map((f) => [f.survivorId, f.absorbedId])).toEqual([['r', 'o']])
  })

  it("pruning never forgets a chain's identity while a member is recent", () => {
    // Fix round 1: a face-bearing chain no longer absorbs a LIVE faceless piece, so the
    // chain is built from short faceless pieces that each ENDED before they joined.
    // Bob (0–1 s), then six faceless 8 s pieces to 61 s; r alone is older than
    // LINK_WINDOW_MS from 61 001. Alice appears at 63 s beside the last one.
    const l = new DeferredLinker(CFG)
    const r = ended('r', 1000, b(100), { faceBearing: true, firstFaceAt: 0, identity: 'bob' })
    const walk = [3000, 13_000, 23_000, 33_000, 43_000, 53_000].map((start, i) =>
      ended(`b${i + 1}`, start + 8000, b(110 + 10 * i), { startedAt: start }),
    )
    const g = piece('g', {
      startedAt: 63_000,
      lastSeenAt: 90_000,
      firstBox: b(170),
      faceBearing: true,
      firstFaceAt: 63_000,
      identity: 'alice',
    })
    const all = [r, ...walk, g]
    const fused = []
    for (let t = 0; t <= 100_000; t += 500) {
      fused.push(
        ...l.step(
          t,
          all.flatMap((p) => seenAt(p, t)),
        ),
      )
      l.prune(t)
      if (t === 62_000) expect(l.membersOf('r')).toEqual(['r', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
    }
    expect(fused.map((f) => f.absorbedId)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
    expect(l.rootOf('g')).toBe('g')
    expect(l.outcome('g')).toBe('new')
  })

  it('a tail is not final while its own chain may still be absorbed', () => {
    const l = new DeferredLinker(CFG)
    const a = ended('a', 1000, b(100))
    const bb = ended('b', 4000, b(130), { startedAt: 3000 })
    const notLive = (): boolean => false
    // a's arc into b is held by a later competitor for a: b is undecided at 14 000.
    const rival = piece('c', { startedAt: 3500, lastSeenAt: 4500, firstBox: b(70) })
    l.step(14_000, [a, bb, rival])
    expect(l.outcome('b')).toBe('pending')
    // b's own gap has passed and nothing follows b — but b may still become a's.
    expect(l.isTailFinal('b', 14_000, notLive)).toBe(false)
  })

  it('every decision names its candidates, with their costs or why they were rejected (D391)', () => {
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const pieces = [
      ended('a1', 1000, b(100)),
      ended('a2', 1000, b(160)),
      piece('b', { startedAt: 3000, lastSeenAt: 3000, firstBox: b(130) }),
    ]
    l.step(18_001, pieces)
    const refused = facts.find((f) => f.kind === 'refused')
    expect(refused?.candidates?.map((c) => c.from).sort()).toEqual(['a1', 'a2'])
    expect(refused?.candidates?.every((c) => typeof c.cost === 'number')).toBe(true)
    // A lost person ×3.6 smaller: `new`, and the rejected predecessor says why.
    const m: LinkDecisionFacts[] = []
    new DeferredLinker(CFG, (f) => m.push(f)).step(30_000, [
      ended('p1', 0, { x: 3005, y: 86, w: 379, h: 252 }),
      piece('p2', {
        startedAt: 4500,
        lastSeenAt: 6000,
        firstBox: { x: 2435, y: 0, w: 641, h: 538 },
      }),
    ])
    expect(m).toContainEqual(
      expect.objectContaining({
        kind: 'new',
        to: 'p2',
        reason: 'no-candidate',
        candidates: [expect.objectContaining({ from: 'p1', rejected: 'area' })],
      }),
    )
    // A commit carries its cost, and the rivals it beat.
    const c: LinkDecisionFacts[] = []
    new DeferredLinker(CFG, (f) => c.push(f)).step(20_000, [
      ended('a', 1000, b(100)),
      piece('bb', { startedAt: 3000, lastSeenAt: 3500, firstBox: b(120) }),
    ])
    expect(c).toContainEqual(
      expect.objectContaining({
        kind: 'committed',
        from: 'a',
        to: 'bb',
        gapMs: 2000,
        recognition: 'none',
      }),
    )
  })

  it('the latest refusal still finds its predecessor: a face at B.start + 14.9 s, never settled, a step every 5 s (review M3)', () => {
    // The worst case `constants.spec.ts` bounds, run: A (named) last seen at
    // 1 s; B starts at the far end of the gap (11 s), shows its first face just
    // before the faceless refusal (25.9 s) and is never named. The wait runs to
    // 45.9 s and the refusal to 50.9 s — A, pruned at 61 s, is still there.
    const facts: LinkDecisionFacts[] = []
    const l = new DeferredLinker(CFG, (f) => facts.push(f))
    const a = ended('a', 1000, b(100), { faceBearing: true, firstFaceAt: 0, identity: 'bob' })
    const firstFace = 11_000 + 14_900
    for (let t = 11_000; t <= 80_000; t += 5000) {
      const face = t >= firstFace
      const bb = piece('b', {
        startedAt: 11_000,
        lastSeenAt: t,
        firstBox: b(130),
        lastBox: b(130),
        faceBearing: face,
        firstFaceAt: face ? firstFace : null,
      })
      l.step(t, [a, bb])
      l.prune(t)
    }
    expect(facts.filter((f) => f.to === 'b').map((f) => [f.t, f.kind, f.reason])).toEqual([
      [51_000, 'refused', 'face-unmatched'],
    ])
  })
})

describe('confirmedPredecessorRejections (follow-up 102, F5)', () => {
  it('names the confirmed predecessors a decision rejected, and why', () => {
    expect(
      confirmedPredecessorRejections([
        { from: 'a', to: 'n', gapMs: 400, rejected: 'reach' },
        { from: 'b', to: 'n', gapMs: 300, rejected: 'unconfirmed' },
        { from: 'c', to: 'n', gapMs: 200, rejected: 'has-successor' },
        { from: 'd', to: 'n', gapMs: 100, rejected: 'contested' },
        { from: 'e', to: 'n', gapMs: 50, cost: 0.4 },
      ]),
    ).toEqual([
      { from: 'a', rejected: 'reach', gapMs: 400 },
      { from: 'd', rejected: 'contested', gapMs: 100 },
    ])
    expect(confirmedPredecessorRejections(undefined)).toEqual([])
  })

  // Fix round 1 (MEDIUM-1): only the rejections that mean "geometry or
  // appearance said no to a plausible continuation" are a break. The others
  // are the normal case of two subjects (concurrent, identity-conflict), an
  // operator delete or a refused chain (dropped), or a predecessor continued
  // elsewhere (has-successor) — they stay on the sampled line.
  it.each([
    'reach',
    'area',
    'appearance',
    'contested',
    'cost',
  ] as const)('a confirmed predecessor rejected by %s is a break', (rejected) => {
    expect(confirmedPredecessorRejections([{ from: 'a', to: 'n', gapMs: 400, rejected }])).toEqual([
      { from: 'a', rejected, gapMs: 400 },
    ])
  })

  it.each([
    'unconfirmed',
    'has-successor',
    'concurrent',
    'dropped',
    'identity-conflict',
  ] as const)('a predecessor rejected as %s is not a break', (rejected) => {
    expect(confirmedPredecessorRejections([{ from: 'a', to: 'n', gapMs: 400, rejected }])).toEqual(
      [],
    )
  })

  it('a real `new` decision after a confirmed car was out of reach carries that rejection', () => {
    const facts: LinkDecisionFacts[] = []
    const gone = ended('car1', 0, b(1000, 300, 200, 120), { klass: 'vehicle' })
    const far = piece('car2', {
      klass: 'vehicle',
      startedAt: 500,
      lastSeenAt: 6000,
      firstBox: b(2500, 300, 200, 120),
    })
    new DeferredLinker(CFG, (f) => facts.push(f)).step(30_000, [gone, far])
    const decided = facts.find((f) => f.kind === 'new' && f.to === 'car2')
    expect(confirmedPredecessorRejections(decided?.candidates)).toEqual([
      { from: 'car1', rejected: 'reach', gapMs: 500 },
    ])
  })
})
