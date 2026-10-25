/** The picture a reviewer looks at for one track, size-bounded. */
import type { MediaKind, ReviewHub } from './hub-api.js'
import { extractFeatures, type TriageFeatures } from './triage.js'

export const DEFAULT_IMAGE_MAX_BYTES = 1_500_000
export const HARD_IMAGE_MAX_BYTES = 4_000_000

/**
 * Clean whole-scene kinds first (the small key frame is the cheapest), so the
 * trajectory envelope lines up with the pixels. The track's own tile is a
 * CROP of unknown rectangle: it comes last, only when no whole scene fits.
 */
const SCENE_PREFERENCE: readonly MediaKind[] = [
  'keyFrameSmall',
  'keyFrame',
  'fullFrame',
  'snapshot',
  'firstFrame',
]
const CROP_PREFERENCE: readonly MediaKind[] = ['thumbnail']
const PREFERENCE: readonly MediaKind[] = [...SCENE_PREFERENCE, ...CROP_PREFERENCE]

/** What the returned pixels show: the whole frame, or a crop of it. */
export type ImageSpace = 'full-frame' | 'crop'

export interface FrameImage {
  readonly base64: string
  readonly mimeType: 'image/jpeg'
  readonly kind: MediaKind
  readonly sizeBytes: number
}

export interface TrackFrame {
  readonly found: boolean
  readonly features?: TriageFeatures
  /** Trajectory box, normalised 0..1 of the FULL frame. Withheld when the image is a crop. */
  readonly envelope?: {
    minX: number
    minY: number
    maxX: number
    maxY: number
  }
  /** Coordinate space every box in this answer is expressed in. */
  readonly coordinateSpace: 'full-frame'
  readonly imageSpace?: ImageSpace
  readonly image?: FrameImage
  readonly warning?: string
  readonly note: string
}

export function clampImageBytes(maxBytes: number | undefined): number {
  if (maxBytes === undefined || !Number.isFinite(maxBytes) || maxBytes <= 0) {
    return DEFAULT_IMAGE_MAX_BYTES
  }
  return Math.min(maxBytes, HARD_IMAGE_MAX_BYTES)
}

export async function fetchTrackFrame(
  hub: ReviewHub,
  deviceId: number,
  trackId: string,
  maxBytes: number,
): Promise<TrackFrame> {
  const track = await hub.getTrack(deviceId, trackId)
  if (track === null) {
    return {
      found: false,
      coordinateSpace: 'full-frame',
      note: 'no such track (evicted or wrong deviceId)',
    }
  }
  const base = {
    found: true,
    features: extractFeatures(track),
    coordinateSpace: 'full-frame' as const,
  }
  const envelope = track.envelope ? { envelope: track.envelope } : {}
  const media = await hub.listTrackMedia(deviceId, trackId)
  const pick = PREFERENCE.map((kind) =>
    media.find((m) => m.kind === kind && m.sizeBytes <= maxBytes),
  ).find((m) => m !== undefined)
  if (pick === undefined) {
    const kinds = media.map((m) => `${m.kind}:${m.sizeBytes}`).join(', ') || 'none'
    return {
      ...base,
      ...envelope,
      note: `no image within ${maxBytes} bytes (media: ${kinds})`,
    }
  }
  const files = await hub.getTrackMedia(deviceId, trackId, [pick.kind])
  const file = files.find((f) => f.mediaId === pick.mediaId) ?? files[0]
  if (file === undefined || file.base64 === '') {
    return {
      ...base,
      ...envelope,
      note: `the ${pick.kind} bytes are gone (evicted)`,
    }
  }
  const image: FrameImage = {
    base64: file.base64,
    mimeType: 'image/jpeg',
    kind: pick.kind,
    sizeBytes: file.sizeBytes,
  }
  if (CROP_PREFERENCE.includes(pick.kind)) {
    // The tile's crop rectangle is not on the wire, so the envelope cannot be
    // transformed into it. Say so rather than hand over boxes that look right
    // and are not.
    return {
      ...base,
      imageSpace: 'crop',
      image,
      warning: `no whole-scene frame fits within ${maxBytes} bytes, so this is the track's ${pick.kind} CROP. Its rectangle is unknown: the trajectory envelope (full-frame coordinates) is withheld and must not be drawn on it. Raise maxBytes to get the full frame.`,
      note: `${pick.kind} crop; boxes are in full-frame coordinates and are NOT given because they do not map onto this image`,
    }
  }
  return {
    ...base,
    ...envelope,
    imageSpace: 'full-frame',
    image,
    note: `${pick.kind} whole-scene frame; the envelope is the subject's trajectory box (normalised 0..1 of this image)`,
  }
}
