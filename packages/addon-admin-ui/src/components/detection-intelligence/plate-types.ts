/**
 * Local mirrors of the `plate-gallery` capability schema, shared across the
 * plates/vehicles detection-intelligence components. Kept local (not imported
 * from `@camstack/types`) to match the existing face-gallery convention in this
 * folder and to keep the admin bundle free of a cross-package type import.
 */
import type { PixelBox } from './face-bbox.js'

/**
 * A recognized vehicle identity — the text-vicinity analogue of a face
 * `Identity`. A vehicle groups plate reads that share (near-)identical OCR text.
 */
export interface Vehicle {
  readonly id: string
  readonly name: string
  readonly sampleCount: number
  readonly coverMediaId?: number
  /** Inline base64 of the cover sample's plate crop, resolved server-side. */
  readonly coverBase64?: string
}

/** One enrolled plate sample under a vehicle identity. */
export interface VehicleSampleInfo {
  readonly id: string
  /** The plate text this sample enrolled (self-labeling — no embedding). */
  readonly text: string
  /** OCR confidence of the enrolled read (0..1). */
  readonly score: number
  readonly addedAt: number
  readonly deviceId?: number
  readonly base64?: string
}

/** A single recognized license-plate read. */
export interface PlateInfo {
  readonly plateId: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  /** Normalized OCR text (upper, no separators), or the human-corrected value. */
  readonly text: string
  /** OCR confidence of the stored read (0..1); 1 when manually corrected. */
  readonly score: number
  /** True when the text was manually corrected (exempt from retention). */
  readonly corrected: boolean
  /** Recognized vehicle id when a matcher lookup named this read. */
  readonly recognizedVehicleId?: string
  /** Resolved vehicle name for `recognizedVehicleId` (UI convenience). */
  readonly vehicleName?: string
  /** True once the read was assigned to a vehicle (enrolled as a sample). */
  readonly assigned: boolean
  /** keyFrame parity: the plate bbox (pixel space) on the native key frame. */
  readonly plateBbox?: PixelBox
  /** keyFrame parity: media row id (D482) of the track's native-resolution
   *  key frame. Resolve via `mediaIdPath` — see the keyFrame adapter in
   *  `PlateDetailPanel`. */
  readonly keyFrameMediaId?: number
  /** Inline base64 of the plate crop image. */
  readonly base64?: string
}

/**
 * A media entry returned by `getPlateMedia`.
 *
 * `key` is still a MediaStore key here, NOT a D482 row id: `plate-gallery
 * .cap.ts`'s `MediaFileLiteSchema` has not made that move (unlike
 * `pipeline-analytics.cap.ts`'s track/event media). The row's own `url` is
 * server-minted regardless, so `PlateDetailPanel.pickBestMedia` reads that
 * and never the key.
 */
export interface PlateMediaFileLite {
  /** The media row's own id (D482) — the address, never a composite key. */
  readonly mediaId: number
  readonly kind: string
  /** Event-media plane path for this crop. No bytes travel with the row. */
  readonly url: string
  readonly sizeBytes: number
  readonly timestamp: number
}
