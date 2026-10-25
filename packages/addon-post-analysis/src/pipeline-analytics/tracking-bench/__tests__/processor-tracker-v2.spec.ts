/**
 * The CASE_TRACKER slot replays v2 (spec §2, §10.B): the processor's fusions
 * arrive as finalisations (stamped no later than the frame that produced
 * them), `confirmed` is the tracklet's own birth gate (D681 as built), and
 * tails still open at the end of the tape are flushed by `finish`.
 *
 * A committed case replays the same identity cannot-link the live tracker
 * applied: D681's `identity` records (the recognizer's verdicts, pseudonymised)
 * reach the processor through `control`, joined to the replay's own ids ON THE
 * FRAME THEY BELONG TO (review 2 NH2): D681 writes detection ids as per-frame
 * ordinals (`FrameIdMap`: `d0`, `d1`, … reset every frame), so a join across
 * frames can hand one subject's name to another. The fixtures use those
 * ordinals — never globally unique ids production does not write.
 *
 * Disarms (each alone, restored):
 *  - in `ProcessorTracker.step`, return `finalised: []`: "reports a fusion as a finalisation" fails;
 *  - in `ProcessorTracker.finish`, return `[]`: "flushes a tail still open at the end" fails;
 *  - in `ProcessorTracker.control`, ignore `identity` records: "replays the identity
 *    cannot-link" fails (without the names both arcs are feasible within the
 *    ambiguity margin and the newcomer is refused — it keeps its own id);
 *  - in `replayTape`, drop the `identity` case: the same test fails;
 *  - join across frames (one `recordedDetOf` / `replayIdOfDet` for the whole
 *    tape — the pre-review-2 code): "an identity record whose track did not
 *    bind on its frame is never attached elsewhere" fails (Bob's name
 *    lands on Alice through the reused ordinal `d0`);
 *  - keep the frame maps for the last 8 FRAMES instead of `LINK_WINDOW_MS`:
 *    "a verdict recorded 20 frames after its frame still resolves" fails (review 3 R3-H1);
 *  - hard-code `confirmed: true` (the pre-D683 code): STAYS GREEN, by
 *    construction — L1 emits only tracklets past their birth gate, so every
 *    emission's `confirmed` is `true` and the constant is indistinguishable on
 *    any tape. What makes `true` correct is the L1 invariant "TrackletTracker
 *    never emits an unconfirmed tracklet", pinned where it lives
 *    (`tracklet-tracker.spec.ts`, "emits a tracklet only once it is confirmed
 *    at minHits"): deleting `if (!tr.confirmed) continue` in
 *    `TrackletTracker.emissions` turns that spec AND this test RED. An
 *    inversion (`!tracked.confirmed`) turns this test RED too;
 *  - in `ProcessorTracker.step`, emit the recorded `trk` of the output's
 *    detection as its `liveId` (a tracker that copies the old tracker's ids
 *    out of `live[]`): "the identity join reads live[] for nothing else" fails.
 *  - (D683 Task 12, M4) in `ProcessorTracker.control`, pass the recorded
 *    `drop.trk` to `dropTrack` untranslated (the pre-Task-12 code): "a
 *    recorded drop ends the chain in replay as it did live" fails;
 *  - (M4) in `applyDrop`, do not count an unresolved record: "a drop whose
 *    track did not bind on its frame is counted" fails;
 *  - (D683 Task 14 fix round 1, H2) in `applyDrop`, call `dropTrack(replayId)`
 *    without `record.reason`: "a recorded 'stationary' drop leaves the chain
 *    linkable" fails (the default `'dropped'` never links);
 *  - (M4) in `live-independence.ts`, leave `drop.trk` un-renamed: "the drop
 *    join reads live[] for nothing else" fails (the renamed live[] no longer
 *    resolves the drop, and the hash moves).
 * (Round 4: the presence-output tests are gone with presence; a still person
 *  is an ordinary `bound` output while seen.)
 */
import { describe, expect, it } from 'vitest'
import { finalIdResolver, type ReplayResult, replayTape } from '../replay.js'
import { decodeTapeText } from '../tape-codec.js'
import { isLiveIndependent } from '../testing/live-independence.js'
import { CASE_TRACKER } from '../trackers/case-tracker.js'
import { ProcessorTracker } from '../trackers/processor-tracker.js'
import { sampleEnd, sampleHeader, type TapeOfFrame, tapeOf } from './tape-fixtures.js'

type Box = readonly [number, number, number, number]
const lerp = (a: Box, b: Box, f: number): Box => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
  a[3] + (b[3] - a[3]) * f,
]
// The 101 scene at a real detection-frame size (1280×720, the stored boxes / 3).
const BOB_FROM: Box = [630, 223, 472, 319]
const BOB_LAST: Box = [680, 531, 497, 176]
const ALICE_FROM: Box = [472, 67, 447, 322]
const ALICE_ON_HER: Box = [104, 470, 601, 240]

interface TapePerson {
  readonly trk: string
  readonly box: Box
}

/** One frame line exactly as D681's recorder writes it: per-frame ordinals
 *  (`d0` person, `d1` its face, `d2` the next person, …), the face with no
 *  `fid` (the `embedding:512d` marker is not a declared face label), and the
 *  RECORDED live binding `trk → det`. */
function frameLine(t: number, people: readonly TapePerson[]): string {
  const dets = people.flatMap((p, k) => [
    { id: `d${2 * k}`, k: 'first-level', cls: 'person', s: 0.86, b: [...p.box], src: 'frame' },
    {
      id: `d${2 * k + 1}`,
      k: 'detail',
      cls: 'face',
      s: 0.9,
      b: [p.box[0] + p.box[2] * 0.4, p.box[1] + 3, 20, 24],
      src: 'frame',
      pid: `d${2 * k}`,
    },
  ])
  const live = people.map((p, k) => ({ trk: p.trk, det: `d${2 * k}`, m: true, st: 'moving' }))
  return JSON.stringify({
    kind: 'frame',
    t,
    plane: 'pipeline',
    w: 1280,
    h: 720,
    dets,
    disc: [],
    inj: [],
    live,
  })
}
const identityLine = (t: number, trk: string, fid: string): string =>
  JSON.stringify({ kind: 'identity', t, trk, fid })

const walk = (t0: number, n: number, x: number): TapeOfFrame[] =>
  Array.from({ length: n }, (_, i) => ({
    t: t0 + i * 130,
    dets: [{ id: 'd0', cls: 'person', s: 0.9, b: [x, 100, 100, 200] as const }],
  }))

/** The final ids of the outputs bound to ordinal `det` on frames in [from, to]. */
function finalIn(replay: ReplayResult, from: number, to: number, det: string): ReadonlySet<string> {
  const resolve = finalIdResolver(replay)
  return new Set(
    replay.frames
      .filter((f) => f.t >= from && f.t <= to)
      .flatMap((f) => f.outputs.filter((o) => o.detectionId === det).map((o) => resolve(o.liveId))),
  )
}

type ExtraLines = (t: number) => readonly string[]

function scene615(extra: ExtraLines = () => []): string[] {
  const lines: string[] = [JSON.stringify(sampleHeader({ deviceId: 101 }))]
  let n = 0
  for (let t = 0; t <= 5250; t += 150, n++) {
    const f = t / 5250
    lines.push(
      frameLine(t, [
        { trk: 'R', box: lerp(BOB_FROM, BOB_LAST, f) },
        { trk: 'G', box: lerp(ALICE_FROM, ALICE_ON_HER, f) },
      ]),
    )
    if (t === 3000) lines.push(identityLine(t, 'R', 'p1'), identityLine(t, 'G', 'p2'))
    lines.push(...extra(t))
  }
  // Only Alice now: HIS box is ordinal `d0`, which was Bob's until +5.25 s.
  for (let t = 5400; t <= 6950; t += 150, n++) {
    lines.push(frameLine(t, [{ trk: 'G', box: ALICE_ON_HER }]))
    lines.push(...extra(t))
  }
  for (let t = 11_200; t <= 30_000; t += 150, n++) {
    lines.push(frameLine(t, [{ trk: 'N', box: BOB_LAST }]))
    if (t === 14_050) lines.push(identityLine(t, 'N', 'p2'))
  }
  lines.push(JSON.stringify(sampleEnd({ durationMs: 30_000, frames: n })))
  return lines
}

/** A walks five frames and is dropped on the last (a registry promotion,
 *  recorded after its frame like live); B walks from +2.42 s at x=230. */
function dropScene(reason: 'dropped' | 'stationary' = 'dropped'): string[] {
  const walker = (t: number, x: number, trk: string): string =>
    JSON.stringify({
      kind: 'frame',
      t,
      plane: 'pipeline',
      w: 1920,
      h: 1080,
      dets: [
        { id: 'd0', k: 'first-level', cls: 'person', s: 0.9, b: [x, 100, 100, 200], src: 'frame' },
      ],
      disc: [],
      inj: [],
      live: [{ trk, det: 'd0', m: true, st: 'moving' }],
    })
  const lines = [JSON.stringify(sampleHeader())]
  for (let i = 0; i < 5; i += 1) lines.push(walker(i * 130, 100, 'A'))
  lines.push(
    JSON.stringify({
      kind: 'drop',
      t: 520,
      plane: 'pipeline',
      trk: 'A',
      reason,
    }),
  )
  let n = 5
  for (let t = 2420; t < 2420 + 80 * 130; t += 130, n++) lines.push(walker(t, 230, 'B'))
  lines.push(JSON.stringify(sampleEnd({ durationMs: 2420 + 80 * 130, frames: n })))
  return lines
}

describe('ProcessorTracker on v2', () => {
  it('reports a fusion as a finalisation to the survivor', () => {
    const replay = replayTape(
      tapeOf([...walk(0, 5, 100), ...walk(2420, 80, 230)]),
      new ProcessorTracker(),
      'pipeline',
    )
    const resolve = finalIdResolver(replay)
    const ids = new Set(
      replay.frames.flatMap((f) =>
        f.outputs.filter((o) => o.detectionId !== undefined).map((o) => resolve(o.liveId)),
      ),
    )
    expect([...ids]).toEqual(['t1'])
    for (const f of replay.finalisations) {
      expect(f.t).toBeLessThanOrEqual(replay.frames.at(-1)?.t ?? 0)
    }
  })

  it('flushes a tail still open at the end of the tape', () => {
    // The second piece ends 1.2 s after it starts, and the tape ends right after.
    const replay = replayTape(
      tapeOf([...walk(0, 5, 100), ...walk(2420, 10, 230)]),
      new ProcessorTracker(),
      'pipeline',
    )
    expect(replay.finalisations.map((f) => [f.provisionalId, f.finalId])).toContainEqual([
      't2',
      't1',
    ])
  })

  it('replays the identity cannot-link the live tracker applied (the 101 scene, from a tape)', () => {
    const replay = replayTape(
      decodeTapeText(scene615().join('\n')),
      new ProcessorTracker(),
      'pipeline',
    )
    const [bob] = [...finalIn(replay, 0, 5250, 'd0')]
    const [alice] = [...finalIn(replay, 0, 5250, 'd2')]
    expect(bob).not.toBe(alice)
    expect([...finalIn(replay, 11_200, 30_000, 'd0')]).toEqual([alice])
  })

  it('an identity record whose track did not bind on its frame is never attached elsewhere', () => {
    // A late verdict for Bob, written after a frame where only Alice
    // (now ordinal d0) is present: it resolves to nothing and is counted.
    const tracker = new ProcessorTracker()
    replayTape(
      decodeTapeText(scene615((t) => (t === 6000 ? [identityLine(t, 'R', 'p1')] : [])).join('\n')),
      tracker,
      'pipeline',
    )
    expect(tracker.unresolvedIdentityRecords).toBe(1)
  })

  it('a verdict recorded 20 frames after its frame still resolves (review 3 R3-H1)', () => {
    // Live: the recognizer's second pass settles on frame t=3000 but is observed
    // (and recorded, stamped t=3000) only after the frames up to 6000 went by.
    const late = scene615().filter(
      (l) => !l.includes('"kind":"identity"') || l.includes('"trk":"N"'),
    )
    const at = late.findIndex((l) => l.includes('"t":6000,'))
    late.splice(at + 1, 0, identityLine(3000, 'R', 'p1'), identityLine(3000, 'G', 'p2'))
    const tracker = new ProcessorTracker()
    const replay = replayTape(decodeTapeText(late.join('\n')), tracker, 'pipeline')
    expect(tracker.unresolvedIdentityRecords).toBe(0)
    const [alice] = [...finalIn(replay, 0, 5250, 'd2')]
    expect([...finalIn(replay, 11_200, 30_000, 'd0')]).toEqual([alice])
  })

  it('the identity join reads live[] for nothing else (isLiveIndependent, the 101 identity tape)', () => {
    // No committed case exists yet (`tracking-bench/cases` is empty), so the
    // D681 guard is run here on a tape that carries identity records: every
    // `trk` renamed through one bijection, unnamed `live[]` entries dropped.
    const tape = decodeTapeText(scene615().join('\n'))
    expect(isLiveIndependent(tape, 'pipeline', CASE_TRACKER)).toBe(true)
  })

  it('a recorded drop ends the chain in replay as it did live — never linked (D683 Task 12, M4)', () => {
    // Live: A walked five frames, the registry promoted it and the processor
    // dropped it (`dropped`, never linked); a subject then walks nearby. The
    // replay must not link across the drop — the untranslated live id `A`
    // used to reach `dropTrack` and do nothing, so A coasted, ended `missed`
    // and was fused with B.
    const tracker = new ProcessorTracker()
    const replay = replayTape(decodeTapeText(dropScene().join('\n')), tracker, 'pipeline')
    expect(tracker.unresolvedDropRecords).toBe(0)
    const [a] = [...finalIn(replay, 0, 520, 'd0')]
    const [b] = [...finalIn(replay, 2420, 12_690, 'd0')]
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(b).not.toBe(a)
  })

  it('without the drop the same scene links — the premise of the drop test', () => {
    const lines = dropScene().filter((l) => !l.includes('"kind":"drop"'))
    const replay = replayTape(decodeTapeText(lines.join('\n')), new ProcessorTracker(), 'pipeline')
    expect([...finalIn(replay, 2420, 12_690, 'd0')]).toEqual([...finalIn(replay, 0, 520, 'd0')])
  })

  it("a recorded 'stationary' drop leaves the chain linkable, as live (D683 Task 14)", () => {
    // Live: the registry promoted A after it MOVED, so A closed `stationary`
    // at its last sighting and the later piece may still be linked. Same
    // scene as above; only the reason differs, and so must the outcome.
    const tracker = new ProcessorTracker()
    const replay = replayTape(
      decodeTapeText(dropScene('stationary').join('\n')),
      tracker,
      'pipeline',
    )
    expect(tracker.unresolvedDropRecords).toBe(0)
    const [a] = [...finalIn(replay, 0, 520, 'd0')]
    expect(a).toBeDefined()
    expect([...finalIn(replay, 2420, 12_690, 'd0')]).toEqual([a])
  })

  it('a drop whose track did not bind on its frame is counted and never applied elsewhere (M4)', () => {
    const lines = dropScene().map((l) =>
      l.includes('"kind":"drop"') ? l.replace('"trk":"A"', '"trk":"nobody"') : l,
    )
    const tracker = new ProcessorTracker()
    replayTape(decodeTapeText(lines.join('\n')), tracker, 'pipeline')
    expect(tracker.unresolvedDropRecords).toBe(1)
  })

  it('the drop join reads live[] for nothing else (isLiveIndependent, the drop tape)', () => {
    expect(
      isLiveIndependent(decodeTapeText(dropScene().join('\n')), 'pipeline', CASE_TRACKER),
    ).toBe(true)
  })

  it("an output's confirmed is the tracklet's own birth gate (D681 as built)", () => {
    // Two frames of a person: below minHits, nothing is emitted; from the
    // third on, every output is confirmed (L1 emits nothing before its birth gate).
    const replay = replayTape(tapeOf(walk(0, 6, 100)), new ProcessorTracker(), 'pipeline')
    const confirmedAt = replay.frames.map((f) => f.outputs.map((o) => o.confirmed))
    expect(confirmedAt.slice(0, 2)).toEqual([[], []])
    expect(confirmedAt.slice(2).every((c) => c.length === 1 && c[0] === true)).toBe(true)
  })
})
