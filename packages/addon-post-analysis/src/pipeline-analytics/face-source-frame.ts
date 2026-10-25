/**
 * Keep the FULL frame every buffered face was detected on (D644).
 *
 * A detected gallery sample used to keep only its 112×112 template, so the
 * SCRFD fix of 2026-09-26 left 518 samples nobody could re-derive (D643). With
 * `keepSourceFrames` on, every face that ENTERS the faces buffer names the
 * frame it came from, with its box and five landmarks in that frame's pixels,
 * and enrolment moves the frame into the sample (`sourceMediaId`).
 *
 * ## When the frame is captured, and how it travels (D9/D18, D422)
 *
 * 1. **Park** — when a face becomes its track's held best, at most once per
 *    `FACE_SOURCE_PARK_MIN_INTERVAL_MS` per track, the hub orders the node that
 *    owns the handle to keep ONE JPEG of that frame (a runner-local encode;
 *    only the handle travels). If the track's own `keyFrame` parcel already
 *    shows that instant, nothing is parked: the track's stored keyFrame is
 *    referenced instead.
 * 2. **Take** — only when the face is BUFFERED is that parcel fetched once,
 *    compressed, by key, and stored as a `face`-owned `fullFrame`. A track
 *    whose face is dropped never moves a byte.
 *
 * The frame kept is the frame of the LAST PARK, which is the held best face or
 * one at most the interval older — its box is stored for that frame, so a
 * re-derivation finds the face on the pixels it names. A frame of another
 * instant than the park is refused.
 *
 * One frame per face: sharing a frame between faces of the same instant saved
 * 3 of 1 606 frames on the live hub and cost an ownership graph; it was
 * dropped (fix round 1).
 */
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import type { FaceSourceStats } from './face-source-stats.js'

/** A pixel-space rectangle. */
export interface FaceSourceBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A pixel-space point. */
export interface FaceSourcePoint {
  readonly x: number
  readonly y: number
}

/** Where the face was, in the DETECTION frame the tracker ran on. */
export interface HeldFaceGeometry {
  readonly timestamp: number
  readonly bbox: FaceSourceBox
  readonly landmarks?: readonly FaceSourcePoint[]
  readonly frameWidth: number
  readonly frameHeight: number
}

/** How a held face's frame is kept. */
export type FaceSourceMode = 'parked' | 'track-keyframe'

/** The frame a held face will be stored with — decided at park time. */
export interface HeldFaceSource {
  readonly geometry: HeldFaceGeometry
  readonly mode: FaceSourceMode
}

/** A park order for one held face. */
export interface FaceSourceParkOrder {
  readonly deviceId: number
  readonly trackId: string
  readonly frameHandle: FrameHandle
  readonly geometry: HeldFaceGeometry
}

/** The retrieved parcel. */
export interface FaceSourceParcel {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
  readonly timestamp: number
}

/** The track's own keyFrame parcel, as the hub mirrors it. */
export interface TrackKeyFrameParcel {
  readonly timestamp: number
  readonly width: number
  readonly height: number
}

/** The park/take/release surface over the runner's parcel store. */
export interface FaceSourceFramePort {
  /** Fire-and-forget; a refusal is logged by the port. */
  park(order: FaceSourceParkOrder): void
  /** The parcel for this track's face, after any park in flight landed; null = none. */
  take(deviceId: number, trackId: string): Promise<FaceSourceParcel | null>
  /** The track is done with its face parcel. */
  release(trackId: string): void
  /**
   * D683 review M3: `absorbedTrackId` is now part of `survivorTrackId`. The
   * survivor's face parcel reads resolve to the absorbed piece's when its face
   * won (`bestShotFrom`), and the survivor's release releases both.
   */
  adopt(
    survivorTrackId: string,
    absorbedTrackId: string,
    bestShotFrom: 'survivor' | 'absorbed',
  ): void
  /** The track's OWN keyFrame parcel, when the hub has one mirrored. */
  trackKeyFrame(trackId: string): TrackKeyFrameParcel | undefined
}

/** The track's stored keyFrame row. */
export interface StoredTrackKeyFrame {
  readonly mediaId: number
  readonly timestamp: number
}

/** The media surface the keeper writes through. */
export interface FaceSourceMedia {
  put(input: FaceSourceMediaPut): Promise<number>
  /** The track's stored keyFrame row, or null. */
  trackKeyFrame(trackId: string): Promise<StoredTrackKeyFrame | null>
}

export interface FaceSourceMediaPut {
  readonly deviceId: number
  readonly ownerKind: 'face'
  readonly ownerId: string
  readonly kind: 'fullFrame'
  readonly timestamp: number
  readonly data: Buffer
}

/** What a buffered face row records about its frame. */
export interface StoredFaceSource {
  readonly mediaId: number
  readonly bbox: FaceSourceBox
  readonly landmarks?: readonly FaceSourcePoint[]
}

export interface FaceSourceFrameKeeperDeps {
  readonly port: FaceSourceFramePort
  readonly media: FaceSourceMedia
  readonly stats: FaceSourceStats
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
}

/** The persist request. */
export interface FaceSourcePersistInput {
  readonly deviceId: number
  readonly trackId: string
  readonly faceId: string
  readonly source: HeldFaceSource
}

/** Scale the detection-frame geometry onto the stored frame's pixels. Pure. */
export function scaleGeometryTo(
  geometry: HeldFaceGeometry,
  width: number,
  height: number,
): Pick<StoredFaceSource, 'bbox' | 'landmarks'> {
  const sx = geometry.frameWidth > 0 ? width / geometry.frameWidth : 1
  const sy = geometry.frameHeight > 0 ? height / geometry.frameHeight : 1
  const b = geometry.bbox
  return {
    bbox: { x: b.x * sx, y: b.y * sy, w: b.w * sx, h: b.h * sy },
    ...(geometry.landmarks !== undefined
      ? { landmarks: geometry.landmarks.map((p) => ({ x: p.x * sx, y: p.y * sy })) }
      : {}),
  }
}

/** Should a new best face be parked now? Pure. */
export function shouldParkSource(
  lastParkAt: number | undefined,
  timestamp: number,
  minIntervalMs: number,
): boolean {
  return lastParkAt === undefined || timestamp - lastParkAt >= minIntervalMs
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class FaceSourceFrameKeeper {
  /** keyFrame dims mirrored at park time, per track — the mirror is gone at close. */
  private readonly keyFrameDims = new Map<string, TrackKeyFrameParcel>()

  constructor(private readonly deps: FaceSourceFrameKeeperDeps) {}

  /**
   * A new best face was ACCEPTED for parking: reuse the track keyFrame when it
   * shows the same instant, else park. Returns the frame the face will keep.
   */
  park(order: FaceSourceParkOrder): HeldFaceSource {
    this.deps.stats.notePark(order.deviceId, order.trackId)
    const keyFrame = this.deps.port.trackKeyFrame(order.trackId)
    if (keyFrame !== undefined && keyFrame.timestamp === order.geometry.timestamp) {
      this.keyFrameDims.set(order.trackId, keyFrame)
      this.deps.stats.noteKeyFrameReuse(order.deviceId)
      return { geometry: order.geometry, mode: 'track-keyframe' }
    }
    this.deps.port.park(order)
    return { geometry: order.geometry, mode: 'parked' }
  }

  /**
   * D683 review M3: the absorbed piece's face source follows the face
   * ranking's verdict — its reused-keyFrame dims move to the survivor when its
   * face won — and its parcel becomes the survivor's to read and release.
   */
  adopt(
    deviceId: number,
    survivorTrackId: string,
    absorbedTrackId: string,
    bestShotFrom: 'survivor' | 'absorbed',
  ): void {
    const dims = this.keyFrameDims.get(absorbedTrackId)
    this.keyFrameDims.delete(absorbedTrackId)
    if (bestShotFrom === 'absorbed' && dims !== undefined) {
      this.keyFrameDims.set(survivorTrackId, dims)
    }
    this.deps.stats.endTrack(deviceId, absorbedTrackId)
    this.deps.port.adopt(survivorTrackId, absorbedTrackId, bestShotFrom)
  }

  /** The track closed; its parcel is no longer wanted on the node. */
  release(deviceId: number, trackId: string): void {
    this.keyFrameDims.delete(trackId)
    this.deps.stats.endTrack(deviceId, trackId)
    this.deps.port.release(trackId)
  }

  /**
   * The face is being BUFFERED: store its frame and say where the face is on
   * it. `null` = no frame kept, already logged and counted.
   */
  async persist(input: FaceSourcePersistInput): Promise<StoredFaceSource | null> {
    return input.source.mode === 'track-keyframe'
      ? this.persistFromKeyFrame(input)
      : this.persistFromParcel(input)
  }

  private async persistFromKeyFrame(
    input: FaceSourcePersistInput,
  ): Promise<StoredFaceSource | null> {
    const dims = this.keyFrameDims.get(input.trackId)
    const row = await this.deps.media.trackKeyFrame(input.trackId).catch(() => null)
    if (dims === undefined || row === null) {
      return this.drop(
        input,
        'track-keyframe-missing',
        'the track keyFrame it reuses is not stored',
      )
    }
    if (row.timestamp !== input.source.geometry.timestamp) {
      return this.drop(
        input,
        'track-keyframe-moved',
        'the track keyFrame moved to another instant',
        {
          keyFrameTimestamp: row.timestamp,
        },
      )
    }
    this.deps.stats.noteStored(input.deviceId, 'track-keyframe')
    return {
      mediaId: row.mediaId,
      ...scaleGeometryTo(input.source.geometry, dims.width, dims.height),
    }
  }

  private async persistFromParcel(input: FaceSourcePersistInput): Promise<StoredFaceSource | null> {
    const g = input.source.geometry
    let parcel: FaceSourceParcel | null
    try {
      parcel = await this.deps.port.take(input.deviceId, input.trackId)
    } catch (err: unknown) {
      return this.drop(input, 'take-failed', 'the parcel could not be retrieved', {
        error: errorMessage(err),
      })
    }
    if (parcel === null) {
      return this.drop(input, 'no-parcel', 'no parcel on the node (refused, evicted or aged out)')
    }
    if (parcel.timestamp !== g.timestamp) {
      return this.drop(input, 'wrong-instant', 'the parcel shows another instant than the park', {
        parcelTimestamp: parcel.timestamp,
      })
    }
    let mediaId: number
    try {
      mediaId = await this.deps.media.put({
        deviceId: input.deviceId,
        ownerKind: 'face',
        ownerId: input.faceId,
        kind: 'fullFrame',
        timestamp: parcel.timestamp,
        data: parcel.jpeg,
      })
    } catch (err: unknown) {
      return this.drop(input, 'store-failed', 'the frame could not be stored', {
        error: errorMessage(err),
      })
    }
    this.deps.stats.noteStored(input.deviceId, 'parked', parcel.jpeg.length)
    this.deps.logger.info('face: source frame kept', {
      tags: { deviceId: input.deviceId },
      meta: {
        trackId: input.trackId,
        faceId: input.faceId,
        mediaId,
        width: parcel.width,
        height: parcel.height,
        bytes: parcel.jpeg.length,
      },
    })
    return { mediaId, ...scaleGeometryTo(g, parcel.width, parcel.height) }
  }

  /** A buffered face without its frame is a DROP of work: said, with the camera, and counted. */
  private drop(
    input: FaceSourcePersistInput,
    reason: string,
    why: string,
    extra: Record<string, unknown> = {},
  ): null {
    this.deps.stats.noteDropped(input.deviceId, reason)
    this.deps.logger.warn('face: buffered WITHOUT its source frame', {
      tags: { deviceId: input.deviceId },
      meta: {
        trackId: input.trackId,
        faceId: input.faceId,
        reason,
        why,
        heldAt: input.source.geometry.timestamp,
        ...extra,
      },
    })
    return null
  }
}
