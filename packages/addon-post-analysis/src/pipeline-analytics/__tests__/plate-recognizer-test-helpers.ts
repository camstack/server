/**
 * Shared fixtures for `PlateRecognizer` adopt specs (D683 Task 17) — a
 * recognizer wired like `plate-recognizer.spec.ts`'s `makeRecognizer`, plus a
 * `feedPlates` helper that feeds a track's OCR reads one frame at a time.
 */
import { type HeldPlateSnapshot, PlateRecognizer } from '../plate-recognizer.js'
import { makeTrackedDetectionOut } from './support/tracked-detection-out.js'
import { makeSilentLogger } from './test-helpers.js'

export interface PlateRecognizerTestHarness {
  readonly recognizer: PlateRecognizer
  readonly heldPlate: (trackId: string) => HeldPlateSnapshot | undefined
}

export async function buildPlateRecognizerForTest(): Promise<PlateRecognizerTestHarness> {
  const recognizer = new PlateRecognizer({
    plateStore: { insert: async () => {} },
    vehicleStore: { loadGallery: async () => [], listVehicles: async () => [] },
    mediaStore: { put: async () => 1 },
    captureCrop: async () => Buffer.from([1]),
    logger: makeSilentLogger(),
  })
  await recognizer.refreshGallery()
  return { recognizer, heldPlate: (trackId) => recognizer.heldPlate(trackId) }
}

/** Feed one OCR read per frame for `trackId`, in the given order, at
 *  increasing timestamps. */
export async function feedPlates(
  recognizer: PlateRecognizer,
  input: { readonly trackId: string; readonly reads: ReadonlyArray<readonly [string, number]> },
): Promise<void> {
  let timestamp = 1000
  for (const [text, score] of input.reads) {
    await recognizer.processFrame({
      deviceId: 9,
      timestamp,
      frameWidth: 640,
      frameHeight: 360,
      cropPadding: 0,
      tracked: [
        makeTrackedDetectionOut({
          trackId: input.trackId,
          className: 'car',
          plateText: text,
          plateScore: score,
          plateBbox: { x: 1, y: 2, w: 3, h: 4 },
        }),
      ],
    })
    timestamp += 1
  }
}
