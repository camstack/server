/**
 * A subject that crossed a zone BEFORE it was a track keeps that zone.
 *
 * ## The cat, measured
 *
 * 2026-09-10 05:55, camera 101. Another system announced an animal at
 * **05:55:45.164**. Ours had already seen it — the full-frame pass missed it
 * and the native crop pass found it three times running:
 *
 * ```
 * 05:55:45  small-subject recovery → animal 0.586
 * 05:55:46  small-subject recovery → animal 0.620
 * 05:55:47  small-subject recovery → animal 0.829   ← track cf8adbcd born
 * ```
 *
 * The track was not missed, it was WITHHELD: a birth needs `minHits`
 * measurements, and at roughly one recovery detection per second those three
 * measurements cost **two seconds**. By the time the track existed the cat had
 * walked on — `occupancy changed` at 05:55:47 reads `Uscio: 1, Aiuola: 0`, and
 * the track's `zonesVisited` is `["Uscio"]` alone.
 *
 * So the rule "Animale su Aiuola" was evaluated against a track that, as far
 * as the system was concerned, was never in the flowerbed:
 * `rejectedBy=["Animale su Aiuola:zones", "Persona su Uscio:classes"]`. Both
 * conditions were right about the data they were given. The data was wrong.
 *
 * ## The rule this pins
 *
 * The confirmation gate decides WHEN a subject becomes a track. It does not
 * decide where the subject has been. A track is born with the zones its own
 * pre-confirmation measurements fell in — the tracker already carries them
 * (`InternalTrack.path`, emitted on every tracked detection as `path`), so
 * this is a history that was being thrown away, not one that has to be built.
 *
 * This is the fix that [D426](../../../../../../docs/decisions/adr-0426-a-refused-detection-is-observed-never-alerted-on.md)
 * declined to make by emitting refused detections as events. That produced
 * phantom alerts and a storm; this produces a real track, with real media, in
 * the zone the subject was actually in.
 */
import type { FrameResult, ObjectDetection, Zone } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FrameProcessor } from '../frame-processor.js'

const DEVICE = 101
const FRAME = { width: 3840, height: 2160 }

/** The operator's real zones, read from the hub on 2026-09-09. */
const AIUOLA: Zone = {
  id: 'fa03b60a-5669-4a8a-976b-bac422f5f530',
  name: 'Aiuola',
  kind: 'polygon',
  color: '#3b82f6',
  polygon: [
    { x: 0.05, y: 0.2 },
    { x: 0.25, y: 0.2 },
    { x: 0.25, y: 0.7 },
    { x: 0.05, y: 0.7 },
  ],
}
const USCIO: Zone = {
  id: 'cfeec78c-8d69-4678-9d25-937193eacb5d',
  name: 'Uscio',
  kind: 'polygon',
  color: '#ef4444',
  polygon: [
    { x: 0.26, y: 0.2 },
    { x: 0.9, y: 0.2 },
    { x: 0.9, y: 0.7 },
    { x: 0.26, y: 0.7 },
  ],
}

/**
 * The cat's box. 300 px wide, not the measured ~160 px (D683): tracker v2
 * associates on overlap alone — the old tracker's centroid rescue, which bound
 * two 160 px boxes 150 px apart (IoU 0.03), is retired — so the fixture keeps
 * the cat's pace and the zone geometry and widens the box until one step
 * overlaps the next at the association bar (150 / 450 = 0.33 ≥ 0.3).
 */
function animalAt(x: number, score: number): ObjectDetection {
  return {
    id: 'cat',
    kind: 'first-level',
    macroClass: 'animal',
    score,
    labels: [],
    bbox: { x, y: 900, width: 300, height: 150 },
    debug: { originalClass: 'cat' },
  }
}

function frame(detections: readonly ObjectDetection[], timestamp: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE,
    timestamp,
    width: FRAME.width,
    height: FRAME.height,
    detections,
  }
}

/**
 * The cat's real pace: three measurements a second apart, ~150 px of travel
 * between them (the measured track walked 458 px over 1.7 s). AIUOLA ends at
 * x=960 and USCIO starts at x=998, so the third box has left the flowerbed —
 * 10 px of it remain, 3% of its area, under the hub's own `minOverlap` of 0.1.
 */
function crossFlowerbedThenConfirmOnTheDoorstep(
  processor: FrameProcessor,
): ReturnType<FrameProcessor['process']>[] {
  return [
    processor.process({ timestamp: 1_000, frame: frame([animalAt(650, 0.586)], 1_000) }),
    processor.process({ timestamp: 2_000, frame: frame([animalAt(800, 0.62)], 2_000) }),
    processor.process({ timestamp: 3_000, frame: frame([animalAt(950, 0.829)], 3_000) }),
  ]
}

describe('a track born after it crossed a zone', () => {
  it('is born carrying the zone it crossed before it existed', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZoneMembershipMinOverlap(0.1)
    processor.setZones([AIUOLA, USCIO])

    const results = crossFlowerbedThenConfirmOnTheDoorstep(processor)
    const born = results.flatMap((r) => r.tracked).find((t) => t.className === 'animal')

    expect(born, 'no animal track was ever emitted').toBeDefined()
    expect(
      born?.zones ?? [],
      'the cat crossed the flowerbed and the track does not know it',
    ).toContain(AIUOLA.id)
  })

  it('still carries the zone it is in NOW', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZoneMembershipMinOverlap(0.1)
    processor.setZones([AIUOLA, USCIO])

    const born = crossFlowerbedThenConfirmOnTheDoorstep(processor)
      .flatMap((r) => r.tracked)
      .find((t) => t.className === 'animal')

    // Inheriting history must not replace the present: the doorstep rule has
    // to keep matching too.
    expect(born?.zones ?? []).toContain(USCIO.id)
  })

  it('adds nothing when the subject never left the zone it was born in', () => {
    const processor = new FrameProcessor(DEVICE, { minHits: 3 })
    processor.setZoneMembershipMinOverlap(0.1)
    processor.setZones([AIUOLA, USCIO])

    const still = 1500 // stays wholly inside USCIO throughout
    for (let i = 1; i <= 3; i++) {
      processor.process({
        timestamp: i * 1_000,
        frame: frame([animalAt(still, 0.8)], i * 1_000),
      })
    }
    const born = processor
      .process({ timestamp: 4_000, frame: frame([animalAt(still, 0.8)], 4_000) })
      .tracked.find((t) => t.className === 'animal')

    expect(born?.zones ?? []).toEqual([USCIO.id])
  })
})
