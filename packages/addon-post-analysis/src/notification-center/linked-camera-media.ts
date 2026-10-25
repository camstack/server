/**
 * Which linked-camera shelf owners one RULE's outbox row names (ADR 0632).
 *
 * Pure: the shelf (`linked-stills.ts`) mints the owners once per sensor event;
 * every rule that fires on it picks its own view of them here, from its own
 * media policy.
 */
import type { NcLinkedCameraMode, NcMediaPolicy } from '@camstack/types'
import type { NcLinkedStills } from './linked-stills.js'
import type { NcLinkedCameraStill } from './outbox.js'

/** ADR 0632: absent = mosaic, applied HERE and never as a Zod default. */
export function linkedCameraMode(media: NcMediaPolicy): NcLinkedCameraMode {
  return media.linkedCameras ?? 'mosaic'
}

export interface NcLinkedMediaOwners {
  /** The still the notification ships (the attachment ladder reads `trackId`). */
  readonly trackId: string
  /** Further stills, in camera order, for a target that takes several — each
   *  with the camera the shelf photographed (its position in `cameraIds`). */
  readonly extraStills: readonly NcLinkedCameraStill[]
  /** What the AI narration reads: always the raw per-camera tiles, each with
   *  its camera. */
  readonly analysisTiles: readonly NcLinkedCameraStill[]
}

/** Which shelf owners one RULE's row names. The model always gets the raw tiles
 *  (like the digest, D154) — a composite is a worse input than its parts. */
export function linkedMediaOwners(
  stills: NcLinkedStills,
  mode: NcLinkedCameraMode,
): NcLinkedMediaOwners {
  // The shelf's OWN pairing: `cameraOwnerIds[i]` was minted for `cameraIds[i]`
  // in one `captureSet`, so this is the camera it photographed.
  const tiles = stills.cameraOwnerIds.flatMap((ownerId, i) => {
    const cameraId = stills.cameraIds[i]
    return cameraId === undefined ? [] : [{ ownerId, cameraId }]
  })
  const [primary] = stills.cameraOwnerIds
  if (mode === 'each' && primary !== undefined) {
    return {
      trackId: primary,
      extraStills: tiles.slice(1),
      analysisTiles: tiles,
    }
  }
  return {
    trackId: stills.mosaicOwnerId,
    extraStills: [],
    analysisTiles: tiles,
  }
}
