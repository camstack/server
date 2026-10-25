/**
 * Spec §10.A: v2 on the operator's real cases. The linker-level cases (102
 * car ×9.5, 101 person ×3.6) are pinned in `linker.spec.ts`; Bob/Alice
 * through the real processor path, runner-shaped frames, is Task 11 — here
 * the same four stored ENDPOINT boxes run through the facade (`faceBearing`,
 * `noteIdentity`), with SYNTHETIC frames between them and a hypothetical
 * newcomer whose truth is the injected verdict (review M1).
 *
 * Disarms (each alone, restored; each named test turned RED — Task 8 ran them):
 *  - `LINK_MAX_GAP_MS` → 5000: "102 parked pair on its own" (parked-2's recorded 6.9 s gap is no longer linked);
 *  - end a tracklet 8 s after it first stood still (the old sustain cap, D665),
 *    as a LINKABLE end (`missed`): "103 seated" fails on its fusions — L2 would
 *    heal every cut, so the id count alone could not see it — and "102 parked
 *    pair on its own" fails the same way; ended `dropped`, both fail on the id count;
 *  - `LINK_MAX_GAP_MS` → 30_000: "103 seated" fails the other way (sessions
 *    18–28 s apart are linked into fewer than five ids — the registry, not L2,
 *    owns a subject that sat through a long silence). The brief's 120_000 stays
 *    GREEN here: `LINK_WINDOW_MS` (60 s) prunes the predecessor before an arc
 *    that long could ever be ready (`lastSeen + gap`);
 *  - in `associate`, run the assignment on coasting tracklets first and give
 *    active ones only the leftovers (the D678 F1 stand-on order): "102 walking
 *    pair" fails on the walker's last sighting — the coasting z9 takes tg's box
 *    at +6.47 s, the competitor test (a coasting owner wins by no margin, Task 6
 *    H2) splits both, and tg's last three boxes become a piece that never
 *    confirms. No id is mixed: the order costs the walker its track, not z9's;
 *  - pass `appearanceResolvesAmbiguity: false` to the distinct-crossing scene:
 *    "a crossing with distinct appearance keeps both ids";
 *  - in `associate`, on a swap doubt keep the CROSSED pairs as pairs instead of
 *    a group: "a crossing with no appearance never swaps";
 *  - `LINK_MAX_GAP_MS` → 1000: "104 pose change links";
 *  - "102 parked pair with the passing car" is a tripwire (review L1) with no single-change disarm: the
 *    recorded passing car never overlaps a parked box above IoU 0.16, under the
 *    0.3 gate, and even at a 0.05 gate with every doubt ignored the solver keeps
 *    each subject's own box. It turns RED only when the active cost is inverted
 *    in `geometricCost` (`best` for `1 − best`) AND the scene runs at
 *    `iouThreshold: 0.15` — a geometry tripwire, not a gate's test;
 *  - in the linker, drop `identitiesConflict`: both 101 Bob/Alice tests.
 *    The first goes RED on an EXTRA id (both arcs into the newcomer are within
 *    the ambiguity margin, and he is refused); the M2 variant goes RED on a MIX
 *    (he is fused into Bob at 0.458). In `toPiece`, send `identity: null`:
 *    the same two tests, the same way (the M2 variant commits into Bob
 *    `waited-unsettled` at the final advance);
 *  - in `toPiece`, send `faceBearing: false`: "101 a face-bearing return" (the
 *    arc commits at +13.25 s, before the verdict).
 */
import { describe, expect, it } from 'vitest'
import {
  crossingPair,
  faceReturn101,
  parkedPair102,
  poseChange590,
  bobAlice101,
  bobAliceApart101,
  seated584,
  walkingPair102,
} from './scenes/recorded-scenes.js'
import { runScene, type SceneOutcome } from './scenes/run-scene.js'

function noIdSpansTwoSubjects(o: SceneOutcome): void {
  for (const [id, truths] of o.truthsByFinalId)
    expect([id, [...truths]]).toEqual([id, [...truths].slice(0, 1)])
}

function oneIdPerSubject(o: SceneOutcome, truths: readonly string[]): void {
  for (const truth of truths)
    expect([truth, o.finalIdsByTruth.get(truth)?.size]).toEqual([truth, 1])
}

describe('recorded scenes (D683 §10.A)', () => {
  it('102 parked pair on its own: each car one id while seen, the recorded 6.7 s gap linked', () => {
    // Before the registry promotes them (then its gate removes their boxes from L1).
    const o = runScene(parkedPair102({ passing: false }))
    noIdSpansTwoSubjects(o)
    oneIdPerSubject(o, ['parked-1', 'parked-2'])
    // One tracklet per car while it is seen: the only fusion is parked-2's recorded gap.
    expect(o.fusions.map((f) => f.gapMs >= 6700)).toEqual([true])
  })

  it('102 parked pair with the passing car: never a mix — extra ids allowed (Q3, round 4)', () => {
    // No presence protects a parked car in L1 any more: a passing car crossing
    // an unpromoted parked car is judged by the ordinary doubt tests. The
    // contract is the operator's: extra ids rather than a mix-up.
    // A TRIPWIRE, not a gate's test (review L1): the recorded passing car never
    // overlaps a parked box above IoU 0.16, so this holds vacuously at every
    // sane gate and does not count toward acceptance. The real gates are the
    // registry's continuation-only scene (Task 14) and D681's `102-parked-cars` case (Task 23).
    noIdSpansTwoSubjects(runScene(parkedPair102()))
  })

  it("103 seated: one id per sitting session — no stillness cap, and a silence past the max link gap is the registry's (round 4)", () => {
    for (const gap of ['sub-floor', 'silence'] as const) {
      const o = runScene(seated584(gap))
      noIdSpansTwoSubjects(o)
      // Seven recorded sessions, 18–68 s apart; two are a single detection
      // (167 373 and 316 767) and never confirm. Five ids, each session whole —
      // ONE tracklet, so nothing for L2 to heal.
      expect([gap, o.finalIdsByTruth.get('operator')?.size, o.fusions]).toEqual([gap, 5, []])
    }
  })

  it('102 walking pair: two people, two ids, never merged — through the trample window', () => {
    const o = runScene(walkingPair102())
    noIdSpansTwoSubjects(o)
    oneIdPerSubject(o, ['z9fx', 'tg9f'])
    // The walker is still its own track on its last recorded box (+6.715 s),
    // which lies on the coasting z9's last box (IoU 0.48): z9 never took it.
    const tg = o.lastSightingByTruth.get('tg9f')
    expect(tg?.t).toBe(6715)
    expect(o.finalIdsByTruth.get('tg9f')).toEqual(new Set([tg?.finalId]))
    expect(o.lastSightingByTruth.get('z9fx')?.t).toBe(4205)
  })

  it('a crossing with distinct appearance keeps both ids (appearance calibrated)', () => {
    const o = runScene(crossingPair('distinct'), { config: { appearanceResolvesAmbiguity: true } })
    noIdSpansTwoSubjects(o)
    oneIdPerSubject(o, ['left-to-right', 'right-to-left'])
  })

  it('a crossing with no appearance never swaps: no id covers both people', () => {
    noIdSpansTwoSubjects(runScene(crossingPair('none')))
  })

  it('104 pose change links into one id', () => {
    oneIdPerSubject(runScene(poseChange590()), ['child'])
  })

  it('101 (synthetic): Bob and Alice are never one id; a newcomer on her last box is fused only because he is named Alice', () => {
    // Truth by the injected verdict (+14.05 s). Both arcs into him are within
    // the ambiguity margin, so without a name he is refused — an extra id. What
    // stops a fusion into BOB is proved by the next test.
    const o = runScene(bobAlice101())
    noIdSpansTwoSubjects(o)
    oneIdPerSubject(o, ['bob', 'alice'])
  })

  it('101 (synthetic, review M2): named Alice, a newcomer on her last box never joins Bob even when her arc is clearly the best', () => {
    // Bob's arc costs 0.458, Alice's 0.848: beyond the 0.15 margin, so
    // only the identity cannot-link keeps him out of her id.
    const o = runScene(bobAliceApart101())
    noIdSpansTwoSubjects(o)
    oneIdPerSubject(o, ['bob', 'alice'])
  })

  it('101 (synthetic) a face-bearing return is not fused before its verdict', () => {
    // Ready by every other rule at +13 s; the verdict lands at +16.1 s.
    const o = runScene(faceReturn101())
    oneIdPerSubject(o, ['alice'])
    expect(o.fusions.map((f) => f.t >= 16_100)).toEqual([true])
  })
})
