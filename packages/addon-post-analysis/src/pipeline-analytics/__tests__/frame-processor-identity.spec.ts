/**
 * 101, 24/09 11:10:20–11:10:28Z (Bob `d9fmegw11j`, Alice `tp2a3b0074`):
 * two people walking out of the bottom edge side by side; Bob's last box
 * is [2039,1592 1490×527] in the stored 3840×2160 positions, and Alice
 * walks onto it ([1769,1410 1804×721], IoU 0.60 with hers). Review 2 NH1:
 * the frames are at a REAL detection-frame size — 1280×720, the boxes scaled
 * by 1/3 (every gate here is a ratio, so the geometry is unchanged) — with a
 * 20×24 face, inside this hub's measured 16.5–28.2 px detection-frame faces
 * (`face-size-score.ts`), never an 80 px face on a 4K frame. Each person
 * carries a `face` detail whose label is the runner's opaque `embedding:512d`
 * marker (`result-assembler.ts:365`) — never a name. Names reach the
 * processor the way production delivers them: the FaceRecognizer's settled
 * verdict, via `noteTrackIdentity` (the same verdict D681 records on the tape).
 *
 * Disarms (each alone, restored):
 *  - in the linker, drop `identitiesConflict`: "the newcomer joins Alice,
 *    never Bob" fails (both arcs stay feasible, within the ambiguity
 *    margin — 0.458 vs 0.589 — and the piece is refused at 26 200);
 *  - in `process`, never add to `faceBearing`: "a face-bearing return waits
 *    for the verdict" fails (the arc commits at +13 s, before the verdict);
 *  - remove the `expire(t)` at the top of `TrackletTracker.step` (review 2
 *    NC1): both tests fail — Bob's stale tracklet takes the newcomer at
 *    +11.2 s, and the first piece re-binds the return at +8 s.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor, type FrameProcessorResult } from '../pipeline/frame-processor.js'
import { sequentialTrackIdMinter } from '../pipeline/track-id.js'

type Box = readonly [number, number, number, number]

function lerp(a: Box, b: Box, f: number): Box {
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
    a[3] + (b[3] - a[3]) * f,
  ]
}

/** A person box plus the runner's face detail inside it (20×24 in a 1280×720 detection frame, `embedding:512d`). */
function personWithFace(id: string, b: Box): readonly ObjectDetection[] {
  return [
    {
      id,
      kind: 'first-level',
      macroClass: 'person',
      score: 0.86,
      labels: [],
      bbox: { x: b[0], y: b[1], width: b[2], height: b[3] },
    },
    {
      id: `${id}-face`,
      kind: 'detail',
      macroClass: 'face',
      parentId: id,
      score: 0.9,
      labels: [{ label: 'embedding:512d', score: 1 }],
      bbox: { x: b[0] + b[2] * 0.4, y: b[1] + 3, width: 20, height: 24 },
      nativeFaceShortSidePx: 60,
      embedding: new Array<number>(512).fill(0.044),
      embeddingModelId: 'arcface-r100',
    },
  ]
}

const frame = (t: number, dets: readonly ObjectDetection[]): FrameResult => ({
  kind: 'frame',
  frameId: `f${t}`,
  deviceId: 101,
  timestamp: t,
  width: 1280,
  height: 720,
  detections: dets,
})
const proc = (): FrameProcessor =>
  new FrameProcessor(101, {}, {}, {}, 'pipeline', {
    mintTrackId: sequentialTrackIdMinter(),
    wallClock: () => 0,
  })

// The stored 4K boxes, scaled by 1/3 to the 1280×720 detection frame.
const BOB_FROM: Box = [630, 223, 472, 319]
const BOB_LAST: Box = [680, 531, 497, 176]
const ALICE_FROM: Box = [472, 67, 447, 322]
const ALICE_ON_HER: Box = [104, 470, 601, 240]

function idOf(out: FrameProcessorResult, det: string): string | undefined {
  return out.tracked.find((x) => x.sourceDetectionId === det)?.trackId
}

describe('identity cannot-link through the processor (101, 24/09 13:10 CEST)', () => {
  it('two recognised people are never one id; the newcomer joins Alice, never Bob', () => {
    const p = proc()
    let bob = ''
    let alice = ''
    let t = 0
    // Both walk down for 5.25 s; the recognizer settles both at +3 s.
    for (; t <= 5250; t += 150) {
      const f = t / 5250
      const out = p.process({
        timestamp: t,
        frame: frame(t, [
          ...personWithFace('r', lerp(BOB_FROM, BOB_LAST, f)),
          ...personWithFace('g', lerp(ALICE_FROM, ALICE_ON_HER, f)),
        ]),
      })
      bob = idOf(out, 'r') ?? bob
      alice = idOf(out, 'g') ?? alice
      if (t === 3000) {
        p.noteTrackIdentity(bob, 'bob')
        p.noteTrackIdentity(alice, 'alice')
      }
    }
    expect(bob).not.toBe(alice)
    // Bob has left (she still COASTS in `tracked`, unmatched — review 2 M5a);
    // Alice stays on her last box until +6.95 s, then leaves. No box is hers.
    for (; t <= 6950; t += 150) {
      const out = p.process({ timestamp: t, frame: frame(t, personWithFace('g', ALICE_ON_HER)) })
      expect(out.tracked.filter((x) => x.matchedThisFrame).map((x) => x.trackId)).not.toContain(bob)
    }
    // +11.2 s (both coast budgets ran out, with no frame in between — the
    // tracker expires them before it associates, review 2 NC1): someone appears
    // on Bob's last box; named Alice at +14.05 s.
    let newcomer = ''
    const fusions: string[] = []
    for (t = 11_200; t <= 30_000; t += 150) {
      const out = p.process({ timestamp: t, frame: frame(t, personWithFace('n', BOB_LAST)) })
      newcomer = newcomer === '' ? (idOf(out, 'n') ?? '') : newcomer
      for (const f of out.fusions) fusions.push(`${f.absorbedId}->${f.survivorId}`)
      if (t === 14_050) p.noteTrackIdentity(newcomer, 'alice')
    }
    expect(newcomer).not.toBe(bob)
    expect(fusions).toEqual([`${newcomer}->${alice}`])
  })

  it('a face-bearing return waits for the verdict before it is fused', () => {
    const p = proc()
    let first = ''
    // He walks onto the spot, last seen at +3 s.
    for (let t = 0; t <= 3000; t += 150) {
      const out = p.process({
        timestamp: t,
        frame: frame(t, personWithFace('g', lerp(ALICE_FROM, ALICE_ON_HER, t / 3000))),
      })
      first = idOf(out, 'g') ?? first
      if (t === 1500) p.noteTrackIdentity(first, 'alice')
    }
    // He returns to the same spot 5 s after his last sighting; the recognizer names him at +16 s.
    let back = ''
    let fusedAt: number | null = null
    for (let t = 8000; t <= 30_000; t += 150) {
      const out = p.process({
        timestamp: t,
        frame: frame(t, personWithFace('g2', ALICE_ON_HER)),
      })
      back = back === '' ? (idOf(out, 'g2') ?? '') : back
      if (fusedAt === null && out.fusions.length > 0) fusedAt = t
      if (t === 16_100) p.noteTrackIdentity(back, 'alice')
    }
    // Ready by every other rule at +13 s (last sighting + 10 s); held for the
    // verdict (the hold would last to 8 000 + FACE_SETTLE_HOLD_MS = 28 000).
    expect(back).not.toBe(first)
    expect(fusedAt).not.toBeNull()
    expect(fusedAt ?? 0).toBeGreaterThanOrEqual(16_100)
  })
})
