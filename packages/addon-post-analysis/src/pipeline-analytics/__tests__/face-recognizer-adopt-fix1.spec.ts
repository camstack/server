/**
 * D683 Task 17 fix round 1 — a fused face row never mixes two identities.
 * Binding: extra ids are preferred over mix-ups; a named piece never hands
 * its face to a differently-named survivor; a disagreement is logged with
 * `tags: { deviceId }`.
 *
 * Disarms (each alone, restored):
 *  - drop the held-face restamp in `adoptTrack` (review H5): "a survivor's name
 *    stamps the absorbed face that won" and "an absorbed name stamps the survivor
 *    face that won" fail;
 *  - let a disagreeing absorbed face win (skip the drop before `bestTracker.adopt`):
 *    "probe P4" fails on the held score;
 *  - drop the alias routing in `processFrame` (review M1): "late frames under the absorbed id feed the survivor" fails;
 *  - drop `endAbsorbedIds` from `persistTrackFace` (review M1): "state a frame in
 *    flight re-created under the absorbed id is dropped when the survivor ends" fails;
 *  - drop the `faceSourceFrames.adopt` forward (review M3): "the face source parcel follows the adoption" fails.
 *
 * Two fix-round-1 tests pinned the D665 quarantine/stash a `sole-subject-
 * veto-lifted` re-attach set aside ("a quarantined survivor is not silently
 * renamed by the absorbed piece", "restoring a stash over a fused name is
 * never silent") — deleted with that mechanism (D683 Task 21): nothing can
 * quarantine a held face once tracker v2 never resurrects an id.
 */
import { describe, expect, it } from 'vitest'
import type { FaceRecognizerSourceFrames } from '../face-recognizer.js'
import {
  buildFaceRecognizerForTest,
  faceFrameInput,
  feedFaces,
} from './face-recognizer-test-helpers.js'

describe('FaceRecognizer.adoptTrack — fix round 1', () => {
  it('probe P4: two names disagree — the row carries the survivor’s name, its score and its face', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'bob', frames: 5, score: 0.6 })
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 5, score: 0.95 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    const warn = h.warnEntries().find((e) => e.message === 'face: fused tracks disagree')
    expect(warn?.extras).toMatchObject({ tags: { deviceId: 1 } })
    // The alice face (0.95) is never held under bob's name.
    expect(h.heldFaceScore('A')).toBe(0.6)
    await h.recognizer.onTrackEnd(1, 'A')
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0]?.recognizedIdentityId).toBe('bob')
    expect(h.inserted[0]?.bestMatchScore).toBeCloseTo(0.6, 5)
  })

  it('a survivor’s name stamps the absorbed face that won', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'bob', frames: 5, score: 0.6 })
    // B: the same person, never named (a stranger's axis, not enrolled) — but a better face.
    await feedFaces(h.recognizer, {
      trackId: 'B',
      identity: 'nobody-b',
      frames: 2,
      score: 0.95,
      enroll: false,
    })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.heldFaceScore('A')).toBe(0.95)
    await h.recognizer.onTrackEnd(1, 'A')
    expect(h.inserted[0]?.recognizedIdentityId).toBe('bob')
  })

  it('an absorbed name stamps the survivor face that won', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, {
      trackId: 'A',
      identity: 'nobody-a',
      frames: 2,
      score: 0.95,
      enroll: false,
    })
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 5, score: 0.6 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.heldFaceScore('A')).toBe(0.95)
    await h.recognizer.onTrackEnd(1, 'A')
    expect(h.inserted[0]?.recognizedIdentityId).toBe('alice')
  })

  it('same identity, different peaks: the merged match score is the max (L1)', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'alice', frames: 5, score: 0.6 })
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 5, score: 0.9 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.recognizer.bestLabelMatchConfidence('A')).toBeCloseTo(0.9, 5)
  })

  it('late frames under the absorbed id feed the survivor, never a ghost (M1)', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'alice', frames: 5, score: 0.6 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    await feedFaces(h.recognizer, {
      trackId: 'B',
      identity: 'alice',
      frames: 2,
      score: 0.9,
      startAt: 8000,
    })
    expect(h.identityOf('B')).toBeNull()
    expect(h.heldFaceScore('B')).toBeUndefined()
    expect(h.heldFaceScore('A')).toBe(0.9)
  })

  it('the face source parcel follows the adoption (M3)', async () => {
    const adopted: string[] = []
    const faceSourceFrames: FaceRecognizerSourceFrames = {
      park: (order) => ({ geometry: order.geometry, mode: 'parked' }),
      persist: async () => null,
      release: () => {},
      adopt: (deviceId, survivorId, absorbedId, from) => {
        adopted.push(`${deviceId}:${absorbedId}->${survivorId}:${from}`)
      },
    }
    const h = await buildFaceRecognizerForTest({ faceSourceFrames })
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'alice', frames: 2, score: 0.5 })
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 2, score: 0.9 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(adopted).toEqual(['1:B->A:absorbed'])
  })

  it('state a frame in flight re-created under the absorbed id is dropped when the survivor ends (M1)', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'alice', frames: 2, score: 0.6 })
    // B's own `captureCrop` await (the frame-sensitive pass) is the suspension
    // point: `processFrame` is in flight, still carrying trackId 'B' (routed
    // before the alias existed), when the fusion runs in that window.
    const inFlight = h.recognizer.processFrame(
      faceFrameInput({
        trackId: 'B',
        identity: 'alice',
        score: 0.9,
        timestamp: 3000,
        viaCaptureCrop: true,
      }),
    )
    h.recognizer.adoptTrack(1, 'A', 'B')
    await inFlight
    expect(h.heldFaceScore('B')).toBe(0.9) // the ghost the window re-created
    await h.recognizer.onTrackEnd(1, 'A')
    expect(h.heldFaceScore('B')).toBeUndefined()
    expect(h.infos()).toContain(
      "face: state re-created under an absorbed id dropped at the survivor's end",
    )
  })
})
