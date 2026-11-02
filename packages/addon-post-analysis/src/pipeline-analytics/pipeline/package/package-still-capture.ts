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

/**
 * The runner's native lease on a look frame (holdFrames 8) is released about
 * 100 ms after inference, so a handle older than this answers `native-miss` or
 * `preview-only` — promotion runs seconds to minutes after the look (D60).
 */
export const PACKAGE_NATIVE_HANDLE_MAX_AGE_MS = 1_000
/** Total time a promotion may spend landing its still before it ships without (D60). */
export const PACKAGE_STILL_BOUND_MS = 6_000
/** One live-source attempt never takes longer than this (a sleeping camera). */
export const PACKAGE_STILL_ATTEMPT_TIMEOUT_MS = 3_000
/** Pause between two live attempts. */
export const PACKAGE_STILL_RETRY_PAUSE_MS = 750
export const PACKAGE_STILL_LIVE_ATTEMPTS = 3

/** A frame that exists NOW — the camera's own snapshot. `null` = it had none. */
export type PackageLiveFrameSource = () => Promise<Uint8Array | null>

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
  | 'live-unavailable'
  | 'bound-exhausted'

/** Where a stored still came from. */
export type PackageStillSource = 'native' | 'live'

export interface PackageStillCaptureInput {
  readonly entry: StationaryEntry
  /** The look frame the path already holds; `null` when there is none. */
  readonly handle: FrameHandle | null
  /** The frame's instant — what the media row is stamped with. */
  readonly timestamp: number
  readonly query: PackageSceneNativeQuery
  readonly writer: PackageStillWriter | null
  readonly logger: IScopedLogger
  /**
   * Source alive at promotion, used when the handle is gone or missed. The
   * parcel is at rest, so a frame taken now shows it where it was seen.
   */
  readonly live: PackageLiveFrameSource | null
  readonly now?: () => number
  readonly pause?: (ms: number) => Promise<void>
}

const realPause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function jpegOf(reply: NativeCropCapResult): Promise<Uint8Array | PackageStillMiss> {
  if (reply.tier === 'ram-fullframe') return 'preview-only'
  if (reply.jpegBytes !== undefined && reply.jpegBytes.byteLength > 0) return reply.jpegBytes
  if (reply.bytes !== undefined && reply.bytes.length === reply.width * reply.height * 3) {
    return encodeRgbCropToJpeg(reply.bytes, reply.width, reply.height)
  }
  return 'empty-frame'
}

interface LiveOutcome {
  readonly jpeg: Uint8Array | null
  readonly reason: PackageStillMiss
  readonly attempts: number
}

/** One live read, cut off after `limitMs` so a hung camera cannot hold the delivery. */
async function readLive(
  source: PackageLiveFrameSource,
  limitMs: number,
): Promise<Uint8Array | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), limitMs)
  })
  try {
    return await Promise.race([source(), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Retry the live source under {@link PACKAGE_STILL_BOUND_MS} until a frame lands (D60). */
async function liveStill(
  input: PackageStillCaptureInput,
  source: PackageLiveFrameSource,
): Promise<LiveOutcome> {
  const now = input.now ?? Date.now
  const pause = input.pause ?? realPause
  const deadline = now() + PACKAGE_STILL_BOUND_MS
  let reason: PackageStillMiss = 'live-unavailable'
  let attempts = 0
  while (attempts < PACKAGE_STILL_LIVE_ATTEMPTS) {
    const remaining = deadline - now()
    if (remaining <= 0) return { jpeg: null, reason: 'bound-exhausted', attempts }
    attempts += 1
    try {
      const jpeg = await readLive(source, Math.min(PACKAGE_STILL_ATTEMPT_TIMEOUT_MS, remaining))
      if (jpeg !== null && jpeg.byteLength > 0) return { jpeg, reason, attempts }
      reason = jpeg === null ? 'live-unavailable' : 'empty-frame'
    } catch {
      reason = 'live-unavailable'
    }
    if (attempts < PACKAGE_STILL_LIVE_ATTEMPTS) await pause(PACKAGE_STILL_RETRY_PAUSE_MS)
  }
  return { jpeg: null, reason, attempts }
}

/**
 * The entry carrying its still's `keyFrameMediaId`, or the entry unchanged when
 * it already had one or none could be stored (said, with the reason).
 *
 * Ladder: the native handle while its lease can still be alive, then a frame
 * that exists now (retried under a bound). Every landed still is logged next to
 * every miss (D400).
 */
export async function withParcelStill(input: PackageStillCaptureInput): Promise<StationaryEntry> {
  const { entry, logger } = input
  if (entry.keyFrameMediaId !== undefined) return entry
  const tags = { deviceId: entry.deviceId }
  const miss = (reason: PackageStillMiss, extra: Record<string, unknown> = {}): StationaryEntry => {
    logger.warn('package still NOT stored — the delivery ships without a picture of the parcel', {
      tags,
      meta: { entryId: entry.id, reason, ...extra },
    })
    return entry
  }
  if (input.writer === null) return miss('no-media-store')
  const now = input.now ?? Date.now
  let jpeg: Uint8Array | null = null
  let source: PackageStillSource = 'native'
  let stamp = input.timestamp
  let nativeMiss: PackageStillMiss = 'no-frame-handle'
  let liveReason: PackageStillMiss | null = null
  let attempts = 0
  try {
    if (input.handle !== null) {
      const reply = await input.query({
        handle: input.handle,
        bbox: { x: 0, y: 0, w: entry.frameWidth, h: entry.frameHeight },
        acceptJpegBytes: true,
        encodeJpeg: true,
        pin: nodePin(input.handle.nodeId),
      })
      if (reply === null) nativeMiss = 'native-miss'
      else {
        const out = await jpegOf(reply)
        if (typeof out === 'string') nativeMiss = out
        else jpeg = out
      }
    }
    if (jpeg === null && input.live !== null) {
      const live = await liveStill(input, input.live)
      attempts = live.attempts
      if (live.jpeg !== null) {
        jpeg = live.jpeg
        source = 'live'
        stamp = now()
      } else liveReason = live.reason
    }
    if (jpeg === null) {
      return miss(liveReason ?? nativeMiss, {
        ...(input.handle !== null ? { nativeMiss } : {}),
        ...(liveReason !== null ? { liveAttempts: attempts } : {}),
      })
    }
    const keyFrameMediaId = await input.writer.putReplacing({
      deviceId: entry.deviceId,
      ownerKind: 'track',
      ownerId: entry.id,
      kind: 'keyFrame',
      timestamp: stamp,
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
    logger.info('package still stored', {
      tags,
      meta: { entryId: entry.id, mediaId: keyFrameMediaId, source },
    })
    return { ...entry, keyFrameMediaId }
  } catch (err) {
    return miss('write-failed', { error: errMsg(err) })
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
