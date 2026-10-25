/**
 * Spec §6.3: a fused vehicle's plate reads vote together; the crop anchor is
 * the higher-scoring read.
 *
 * Disarm: keep only the survivor's reads: "both pieces' reads vote" fails.
 */
import { describe, expect, it } from 'vitest'
import { buildPlateRecognizerForTest, feedPlates } from './plate-recognizer-test-helpers.js'

describe('PlateRecognizer.adoptTrack', () => {
  it('both pieces’ reads vote, anchored on the higher score', async () => {
    const h = await buildPlateRecognizerForTest()
    await feedPlates(h.recognizer, { trackId: 'A', reads: [['AB123CD', 0.6]] })
    await feedPlates(h.recognizer, {
      trackId: 'B',
      reads: [
        ['AB123CD', 0.9],
        ['AB123CO', 0.5],
      ],
    })
    h.recognizer.adoptTrack(1, 'A', 'B')
    expect(h.heldPlate('A')).toMatchObject({ score: 0.9, readCount: 3 })
    expect(h.heldPlate('B')).toBeUndefined()
  })
})
