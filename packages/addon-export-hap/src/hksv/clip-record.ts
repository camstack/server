/**
 * What ONE teed HomeKit clip is, on disk.
 *
 * ## Why a sidecar at all
 *
 * HomeKit Secure Video is a SINK. HAP's `dataSend` is `hello/whoami/open/data/
 * ack/close` and `CameraRecordingDelegate` is push-only, so a clip "recorded by
 * HomeKit" can only ever be ours if we kept our own copy of what we SENT.
 * There is no read-back to reconcile against later, and there never will be.
 * Everything a later reader can know about a teed clip therefore has to be
 * written down at the moment it was written — by the only process that ever saw
 * it — or it is lost with the session.
 *
 * ## The two coverage limits, stated on the record rather than discovered
 *
 * - **Only some cameras record at all.** `pickRecordingSource` refuses anything
 *   without an H.264 slot, `MAX_RECORDING_HEIGHT` prefers ≤ 1080p, and
 *   `deriveFragmentLengthMs` refuses a GOP longer than 8 s. A camera the tee
 *   never writes for is not a gap in this store, it is a camera HKSV never
 *   recorded; {@link HksvClipRecord} exists only for the ones it did.
 * - **The duration is whatever iOS PULLED.** Not a window CamStack chose, and
 *   a short clip is not a truncated one — {@link HksvClipRecord.truncated} is
 *   the only thing that says truncated. Since D578 it is READ FROM THE FILE
 *   (`mvhd`, after the faststart pass), because the tee's own wall clock is
 *   wrong in a specific direction: the clock starts when the tee does, and the
 *   first fragments it writes are the PREBUFFER — footage older than the tee
 *   itself. Measured on 101: 12.0 s claimed against 19.99 s held. The wall
 *   clock remains the fallback for a file that could not be measured.
 *
 * ## `thumbnailFile` is VOUCHED
 *
 * It is written only after the JPEG has been stat'd on disk at non-zero size.
 * A minter that reports success and produced nothing leaves
 * {@link HksvClipRecord.thumbnailUnavailable} instead — the whole point of
 * vouching is that the promise and the file are not the same claim.
 */
import { CamProfileSchema } from '@camstack/types'
import { z } from 'zod'

/** The `videoclips` source id a later provider will list these under. */
export const HKSV_CLIP_SOURCE = 'hksv'

/** Why no still could be minted from the saved fMP4. Named, never blank. */
export const HksvThumbnailUnavailableReasonSchema = z.enum([
  /** ffmpeg ran and produced no readable JPEG — including "said ok, wrote nothing". */
  'decode-failed',
  /** ffmpeg exceeded its bound and was killed. */
  'timed-out',
  /** The binary could not be spawned at all. */
  'ffmpeg-missing',
  /** The clip holds no init segment, so nothing in it is decodable. */
  'no-init-segment',
  /** No minter was wired — stated, so absence never reads as a decode failure. */
  'not-attempted',
])
export type HksvThumbnailUnavailableReason = z.infer<typeof HksvThumbnailUnavailableReasonSchema>

/**
 * Why a teed clip could not be made seekable. Named, never blank — a missing
 * binary, a deadline and a file ffmpeg blessed but did not fix are three
 * different operator actions, and "it does not seek" is none of them.
 */
export const HksvRemuxUnavailableReasonSchema = z.enum([
  /** ffmpeg ran and produced no usable output — including "said ok, wrote nothing". */
  'remux-failed',
  /** ffmpeg exceeded its bound and was killed. */
  'timed-out',
  /** The binary could not be spawned at all. */
  'ffmpeg-missing',
  /** It exited 0 and the output is still not a front-loaded progressive MP4. */
  'not-seekable',
  /** No remuxer was wired — stated, so absence never reads as a failed pass. */
  'not-attempted',
])
export type HksvRemuxUnavailableReason = z.infer<typeof HksvRemuxUnavailableReasonSchema>

/** Why a clip stopped short of the stream that fed it. */
export const HksvClipTruncationSchema = z.enum([
  /** The per-clip byte ceiling was reached — an iOS session that never closed. */
  'size-cap',
  /** The plane closed the tee for falling behind (D80: closed, never gapped). */
  'slow-consumer',
  /** A disk write failed. The HKSV recording itself was untouched. */
  'write-failed',
])
export type HksvClipTruncation = z.infer<typeof HksvClipTruncationSchema>

export const HksvClipRecordSchema = z.object({
  /** Bumped when a field's MEANING changes; a reader refuses what it cannot read. */
  schemaVersion: z.literal(1),
  /** `hksv:<deviceId>:<startedAtMs>-<streamId>` — self-contained, so a later
   *  provider addresses bytes and stills without re-listing. */
  clipId: z.string().min(1),
  source: z.literal(HKSV_CLIP_SOURCE),
  deviceId: z.number().int(),
  /** The HDS stream this clip was teed from — the join to the delegate's logs. */
  streamId: z.number().int(),
  startedAtMs: z.number().int(),
  endedAtMs: z.number().int(),
  /**
   * What iOS pulled, never a window we chose — measured from the file's own
   * `mvhd` where the faststart pass could read it, and `endedAtMs -
   * startedAtMs` otherwise. See the docblock: the two differ by the prebuffer.
   */
  durationMs: z.number().int().nonnegative(),
  /** How much of the clip's head came from the prebuffer ring, by ARRIVAL age. */
  prebufferSpanMs: z.number().int().nonnegative(),
  /**
   * The size of {@link HksvClipRecord.file} AS IT NOW STANDS on disk — so on a
   * clip the faststart pass rewrote, the post-remux size, re-stat'd and never
   * carried over from the tee's own count. The pass costs about +0.7 %, and a
   * record stating the pre-remux figure would be wrong by exactly that for
   * ever, on the one field a `Range` reader and the disk accounting both use.
   */
  bytes: z.number().int().nonnegative(),
  fragments: z.number().int().nonnegative(),
  /** Basenames, relative to the clip's own device directory. */
  file: z.string().min(1),
  thumbnailFile: z.string().min(1).optional(),
  thumbnailUnavailable: z.object({ reason: HksvThumbnailUnavailableReasonSchema }).optional(),
  /**
   * The faststart pass ran and its output was VOUCHED: `moov` ahead of the
   * media, progressive, read back off the produced file. Present only when
   * that is true of {@link HksvClipRecord.file}.
   *
   * Three states, not two, and the third is the reason this is optional rather
   * than a boolean: `true` means it seeks, {@link
   * HksvClipRecord.remuxUnavailable} means it does not and says why, and
   * NEITHER means unknown — a sidecar written before this field existed cannot
   * be given one after the fact, and a reader must not read that silence as
   * "does not seek" (D393).
   */
  seekable: z.literal(true).optional(),
  remuxUnavailable: z.object({ reason: HksvRemuxUnavailableReasonSchema }).optional(),
  truncated: HksvClipTruncationSchema.optional(),
  /** iOS sent `ack` for this stream: HomeKit itself kept the clip. */
  acknowledgedByHomeKit: z.boolean(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * WHICH broker slot HomeKit recorded from, on the one quality scale the
   * system has (`high | mid | low`).
   *
   * Written by the tee from `pickRecordingSource`'s choice, because it is the
   * only thing that knows: the pixels do not say which profile produced them,
   * and a consumer that needs `served` (`getClipPlayback`, `readClipBytes`)
   * must never derive it from the resolution. Optional because a sidecar
   * written before this field existed cannot be given one after the fact — a
   * reader REFUSES to name a twin it was never told (D393), rather than
   * guessing one.
   */
  profile: CamProfileSchema.optional(),
  /** The advertised fragment length the source was cutting at. */
  fragmentMs: z.number().int().positive(),
})
export type HksvClipRecord = z.infer<typeof HksvClipRecordSchema>

/** The three files one clip owns, inside its device directory. */
export interface HksvClipFileNames {
  readonly clip: string
  readonly thumbnail: string
  readonly record: string
}

/**
 * One stem per clip, three extensions. Derived from the id and from nothing
 * else, so a pruner deleting a clip never has to guess which JPEG was its.
 */
export function clipFileNames(clipId: string): HksvClipFileNames {
  return clipFileNamesForStem(clipStem(clipId))
}

/**
 * The same three names, from a stem a URL already carries.
 *
 * A data-plane route is handed the stem, not the id — `:` is legal on ext4 and
 * hostile in a path everywhere else, which is why {@link clipStem} exists — and
 * it must not re-derive the layout. One place mints these names, for both
 * callers.
 */
export function clipFileNamesForStem(stem: string): HksvClipFileNames {
  return { clip: `${stem}.mp4`, thumbnail: `${stem}.jpg`, record: `${stem}.json` }
}

/** The stem a clip's three files share. Exported so a route can validate one. */
export function clipStemFor(clipId: string): string {
  return clipStem(clipId)
}

export function clipIdFor(deviceId: number, startedAtMs: number, streamId: number): string {
  return `${HKSV_CLIP_SOURCE}:${deviceId}:${startedAtMs}-${streamId}`
}

/** The filesystem-safe tail of an id. `:` is legal on ext4 and hostile everywhere else. */
function clipStem(clipId: string): string {
  return clipId.replace(/[^A-Za-z0-9_-]/g, '_')
}
