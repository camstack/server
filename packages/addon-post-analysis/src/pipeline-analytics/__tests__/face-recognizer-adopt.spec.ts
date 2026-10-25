/**
 * Spec §6.3: the face state of a fused track is the union of both pieces'
 * evidence, field by field (review H4: the real maps — `aggregates`,
 * `stashedIdentity`, `bestFace` via `bestTracker`, `lastSourceParkAt`,
 * `bestMatchScore`, `bestSuggestion`). Two different ASSIGNED identities are a
 * linker defect: reported, and the survivor's is kept.
 *
 * Disarms (each alone, restored):
 *  - make `adoptTrack` drop the absorbed aggregate: "the survivor inherits the absorbed identity" fails;
 *  - let the absorbed identity win a disagreement: "two different assigned identities are reported, the survivor's kept" fails;
 *  - skip the `bestTracker.adopt` call: "the better face is the one held" fails.
 */
import { describe, expect, it } from 'vitest'
import { buildFaceRecognizerForTest, feedFaces } from './face-recognizer-test-helpers.js'

describe('FaceRecognizer.adoptTrack', () => {
  it('the survivor inherits the absorbed identity, its confirmations and its match score', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 5, score: 0.8 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.identityOf('A')).toBe('alice')
    expect(h.recognizer.bestLabelMatchConfidence('A')).toBeGreaterThan(0)
    expect(h.identityOf('B')).toBeNull()
  })

  it('two different assigned identities are reported, the survivor’s kept', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'bob', frames: 5, score: 0.8 })
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 5, score: 0.8 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.warnings()).toContain('face: fused tracks disagree')
    expect(h.identityOf('A')).toBe('bob')
  })

  it('the better face is the one held', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'alice', frames: 5, score: 0.55 })
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 5, score: 0.92 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.heldFaceScore('A')).toBe(0.92)
  })

  it('a fused survivor does not switch identity without the WARN (Task 7 review H2)', async () => {
    const h = await buildFaceRecognizerForTest()
    await feedFaces(h.recognizer, { trackId: 'B', identity: 'alice', frames: 5, score: 0.8 })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.identityOf('A')).toBe('alice')
    await feedFaces(h.recognizer, { trackId: 'A', identity: 'bob', frames: 5, score: 0.8 })
    expect(h.identityOf('A')).toBe('bob')
    expect(h.warnings()).toContain('face: fused tracks disagree')
  })
})
