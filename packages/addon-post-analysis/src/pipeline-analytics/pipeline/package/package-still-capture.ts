/**
 * The still of a parcel the dedicated stillness path promoted without a track.
 *
 * ## Why
 *
 * A raw-look box with no matching tracked package becomes a sighting with
 * neither a `trackId` nor a `keyFrameMediaId` (`package-look-sightings.ts`).
 * `PackageDropDetector` then writes `trackId = entry.id` — a uuid that owns NO
 * media — and no `mediaId`, so the notification centre's still ladder
 * (`track:<entry.id>`, `object:<eventId>`) finds nothing and the delivery ships
 * text-only (device 615, 2026-10-30, `dropped: ["still", "gif"]`).
 *
 * ## What
 *
 * Persist the CLEAN look frame as the entry's `keyFrame`, owned by
 * `track:<entry.id>` (the very id the event row names as its trackId) with the
 * parcel's box beside it (D510) — BEFORE `delivered` is emitted. The frame is
 * stored whole: the notification's picture mode (`crop`) cuts it at render, so
 * no crop rectangle is derived here and D52's `deriveDetailCropRect` is not in
 * play. A failure is never silent (D391/D400): one line per cause, tagged with
 * the device, and the entry is delivered exactly as before.
 */

import type { FrameHandle, IScopedLogger, NativeCropCapResult } from '@camstack/types'
import { errMsg, nodePin } from '@camstack/types'
import { encodeRgbCropToJpeg } from '../../../shared/frame/encode-crop.js'
import type { MediaSubjectBox } from '../../store/media-store.js'
import type { StationaryEntry } from '../stationary/stationary-types.js'
import type { PackageSceneNativeQuery } from './package-scene-fetch.js'

/** A held look frame older than this is not the parcel's picture any more. */
export const PACKAGE_LOOK_FRAME_MAX_AGE_MS = 15_000

/** The one media write this capture performs, structurally. */
export interface PackageStillWriter {
  putReplacing(input: {
    readonly deviceId: number
    readonly ownerKind: 'track'
    readonly ownerId: string
    readonly kind: 'keyFrame'
    readonly timestamp: number
    readonly data: Buffer
    readonly subjectBox: MediaSubjectBox
  }): Promise<number>
}

/** Why no still was stored — one cause per refused or failed capture. */
export type PackageStillMiss =
  | 'no-frame-handle'
  | 'no-media-store'
  | 'native-miss'
  | 'preview-only'
  | 'empty-frame'
  | 'write-failed'

export interface PackageStillCaptureInput {
  readonly entry: StationaryEntry
  /** The look frame the path already holds; `null` when there is none. */
  readonly handle: FrameHandle | null
  /** The frame's instant — what the media row is stamped with. */
  readonly timestamp: number
  readonly query: PackageSceneNativeQuery
  readonly writer: PackageStillWriter | null
  readonly logger: IScopedLogger
}

async function jpegOf(reply: NativeCropCapResult): Promise<Uint8Array | PackageStillMiss> {
  if (reply.tier === 'ram-fullframe') return 'preview-only'
  if (reply.jpegBytes !== undefined && reply.jpegBytes.byteLength > 0) return reply.jpegBytes
  if (reply.bytes !== undefined && reply.bytes.length === reply.width * reply.height * 3) {
    return encodeRgbCropToJpeg(reply.bytes, reply.width, reply.height)
  }
  return 'empty-frame'
}

/**
 * The entry carrying its still's `keyFrameMediaId`, or the entry unchanged when
 * it already had one or none could be stored (said, with the reason).
 */
export async function withParcelStill(input: PackageStillCaptureInput): Promise<StationaryEntry> {
  const { entry, logger } = input
  if (entry.keyFrameMediaId !== undefined) return entry
  const miss = (reason: PackageStillMiss, detail?: string): StationaryEntry => {
    logger.warn('package still NOT stored — the delivery ships without a picture of the parcel', {
      tags: { deviceId: entry.deviceId },
      meta: { entryId: entry.id, reason, ...(detail !== undefined ? { error: detail } : {}) },
    })
    return entry
  }
  if (input.handle === null) return miss('no-frame-handle')
  if (input.writer === null) return miss('no-media-store')
  try {
    const reply = await input.query({
      handle: input.handle,
      bbox: { x: 0, y: 0, w: entry.frameWidth, h: entry.frameHeight },
      acceptJpegBytes: true,
      encodeJpeg: true,
      pin: nodePin(input.handle.nodeId),
    })
    if (reply === null) return miss('native-miss')
    const jpeg = await jpegOf(reply)
    if (typeof jpeg === 'string') return miss(jpeg)
    const keyFrameMediaId = await input.writer.putReplacing({
      deviceId: entry.deviceId,
      ownerKind: 'track',
      ownerId: entry.id,
      kind: 'keyFrame',
      timestamp: input.timestamp,
      data: Buffer.from(jpeg),
      subjectBox: {
        x: entry.bbox.x,
        y: entry.bbox.y,
        w: entry.bbox.w,
        h: entry.bbox.h,
        frameWidth: entry.frameWidth,
        frameHeight: entry.frameHeight,
      },
    })
    return { ...entry, keyFrameMediaId }
  } catch (err) {
    return miss('write-failed', errMsg(err))
  }
}

/** What {@link promoteWithStill} hands the detector — structurally. */
export interface PackagePromotionSink {
  onStationaryChange(change: {
    readonly phase: 'appeared'
    readonly entry: StationaryEntry
    readonly timestamp: number
  }): Promise<void>
}

/**
 * One promotion, in the order that matters: the still is stored FIRST, then the
 * detector emits `delivered` — the notification centre reads the still when the
 * event arrives, so a picture written after it is a picture nobody sees.
 */
export async function promoteWithStill(
  input: PackageStillCaptureInput & { readonly detector: PackagePromotionSink },
): Promise<void> {
  const entry = await withParcelStill(input)
  await input.detector.onStationaryChange({
    phase: 'appeared',
    entry,
    timestamp: input.entry.becameStationaryAt,
  })
}
