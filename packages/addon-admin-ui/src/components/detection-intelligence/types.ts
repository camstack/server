/**
 * Local mirrors of the `face-gallery` capability schema, shared across the
 * detection-intelligence components. Kept local (not imported from
 * `@camstack/types`) to match the existing convention in this folder and to
 * keep the admin bundle free of a cross-package type import.
 */

export interface Identity {
  readonly id: string
  readonly name: string
  readonly sampleCount: number
  readonly coverMediaId?: number
}

/**
 * A face bounding box expressed in NORMALIZED coordinates (0‥1) relative to the
 * frame it was detected in. Origin is the top-left of the frame.
 */
export interface NormalizedBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A face bounding box in PIXEL coordinates on its native key frame, matching
 *  the backend `BoundingBoxSchema` shape (`face-gallery.cap.ts`). */
export interface PixelBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface FaceInfo {
  readonly faceId: string
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly recognizedIdentityId?: string
  readonly identityName?: string
  readonly assigned: boolean
  /** The crop inline. Prefer `cropUrl`; this is the fallback. */
  readonly base64?: string
  /**
   * The crop as a data-plane URL for `<img src>` — `access: 'authenticated'`,
   * so the `camstack_session` cookie the auth context establishes carries it
   * and no Bearer header (hence no fetch+blob dance) is needed.
   *
   * Preferred over `base64`: 500 inline crops are ~2.87 MiB re-sent on every
   * refetch, where URLs let the browser cache and ETag each tile.
   */
  readonly cropUrl?: string
  /**
   * Media row id (D482) of the track's native-resolution key frame. Fetch
   * the native JPEG via the admin-gated event-media data-plane route
   * (`mediaIdPath` → `/addon/pipeline-analytics/event-media/m/<id>`) — see
   * the keyFrame adapter in `FaceDetailPanel` for the fetch+normalize
   * wiring. Absent when the track produced no key frame (e.g. native/onboard
   * source); the detail view falls back to the `getFaceMedia` crop.
   */
  readonly keyFrameMediaId?: number
  /**
   * The face's bounding box on `keyFrameMediaId`, in PIXEL coordinates.
   * `FaceDetailPanel`'s adapter normalizes this (via `normalizeFaceBbox`,
   * see `face-bbox.ts`) against the loaded key frame's natural dimensions
   * into the relative `NormalizedBox` the overlay renders. Only meaningful
   * when `keyFrameMediaId` is present.
   */
  readonly faceBbox?: PixelBox
}

export interface FaceCluster {
  readonly faceIds: readonly string[]
  readonly representativeFaceId: string
  readonly size: number
  readonly cohesion: number
}

/** A selectable camera in the multi-select filter. */
export interface CameraOption {
  readonly id: number
  readonly name: string
}
