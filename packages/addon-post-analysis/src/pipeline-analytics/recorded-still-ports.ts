/**
 * The production wiring for {@link RecordedStillService} — the recorder's READ
 * surface plus one bounded ffmpeg.
 *
 * Kept apart from `recorded-still.ts` so the policy (what counts as a refusal,
 * what the concurrency bound is, where the seek lands) stays testable with no
 * cap client, no recorder and no ffmpeg on the machine running the suite. This
 * file is the only place that knows the cap method names.
 *
 * **Read-side only.** `getDeviceConfig`, `locateSegment` and `readGopBytes` —
 * nothing here writes, evicts, prunes or relocates. That is deliberate and it
 * is a boundary, not an accident: the recorder's write path is the one thing a
 * background maintenance pass must never be able to perturb.
 */
import { execFile } from 'node:child_process'
import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { buildRecordedStillArgs, type RecordedStillPorts } from './recorded-still.js'

/**
 * Hard bound on one still decode. Generous because the work is background and a
 * stuck ffmpeg costs a slot rather than a delivery; tight enough that two stuck
 * ones cannot wedge the service for a whole pass.
 */
const RECORDED_STILL_TIMEOUT_MS = 15_000

/** A native JPEG is worth having at full size; this is headroom, not a budget. */
const RUN_MAX_BUFFER = 32 * 1024 * 1024

/** The minimal recording cap surface this needs. Structural, so a wider client satisfies it. */
export interface RecordingReadApi {
  getDeviceConfig: { query(input: { deviceId: number }): Promise<{ enabled?: boolean }> }
  locateSegment: {
    query(input: { deviceId: number; profile: string; epochMs: number }): Promise<{
      kind: string
      startMs?: number
    }>
  }
  readGopBytes: {
    query(input: {
      deviceId: number
      profile: string
      startMs: number
      epochMs: number
    }): Promise<{ data: Uint8Array; gopStartMs: number; gopDurMs: number }>
  }
}

/**
 * The profile a recovered still is read from.
 *
 * `high` and not the low rendition, because the whole reason to re-decode is
 * that the model wants NATIVE pixels — a still cut from the scrub-grade copy
 * would be a worse version of the ≤640 fallback the design already has.
 */
const RECORDED_STILL_PROFILE = 'high'

/**
 * Width cap for a recovered key frame.
 *
 * The same 1920 the live native `keyFrame` capture uses, so a vector rebuilt
 * from recovered pixels and one rebuilt from a captured key frame are cut from
 * rasters of the same scale. Different scales would not be wrong — the runner
 * derives the rectangle from normalised coordinates either way — but they would
 * make two populations in one index differ by resampling, and this index has
 * already had two feature spaces in it once ([D52](../../../../docs/decisions/adr-0052.md)).
 */
export const RECOVERED_KEY_FRAME_MAX_WIDTH = 1920

/**
 * Width cap for a still added to the retrain dataset from the recording.
 *
 * Effectively none: a training frame is wanted at the camera's own resolution
 * (the same pixels a native key frame has), so the bound is only a ceiling
 * against a pathological stream, far above any camera on the fleet.
 */
export const RETRAIN_STILL_MAX_WIDTH = 7680

export interface RecordedStillPortsInput {
  readonly api: RecordingReadApi
  readonly logger: IScopedLogger
  /**
   * The node's pinned ffmpeg (D540). Required, with no default: the optional
   * path this replaced fell back to `'ffmpeg'` on PATH, and production never
   * passed one — every recovered still ran the host's binary.
   */
  readonly resolveFfmpeg: PinnedFfmpegResolver
}

/**
 * Build the production ports.
 *
 * Every port swallows its own failure into the `null` the policy expects: a
 * maintenance pass that walks thousands of tracks must not end because one
 * device's config read timed out, and the outcome the caller reports is already
 * the honest one.
 */
export function buildRecordedStillPorts(input: RecordedStillPortsInput): RecordedStillPorts {
  return {
    logger: input.logger,
    resolveProfile: async (deviceId) => {
      try {
        const config = await input.api.getDeviceConfig.query({ deviceId })
        return config.enabled === false ? null : RECORDED_STILL_PROFILE
      } catch {
        return null
      }
    },
    locate: async (deviceId, profile, epochMs) => {
      try {
        const located = await input.api.locateSegment.query({ deviceId, profile, epochMs })
        // `kind` is `'segment'` when footage covers the instant and `'gap'`
        // otherwise; a gap carries a nearest edge this caller has no use for —
        // a frame from a different moment is not the frame that was asked for.
        if (located.kind !== 'segment' || typeof located.startMs !== 'number') return null
        return { startMs: located.startMs }
      } catch {
        return null
      }
    },
    readGop: async (deviceId, profile, startMs, epochMs) => {
      try {
        return await input.api.readGopBytes.query({ deviceId, profile, startMs, epochMs })
      } catch {
        return null
      }
    },
    // A binary that cannot be resolved REJECTS here, and the service turns that
    // into a per-camera `recorded still failed` line — never a PATH lookup.
    decodeStill: async (gop, atSec, maxWidth) => {
      const ffmpeg = await input.resolveFfmpeg()
      return await new Promise<Buffer | null>((resolve) => {
        const child = execFile(
          ffmpeg,
          [...buildRecordedStillArgs(atSec, maxWidth)],
          { encoding: 'buffer', maxBuffer: RUN_MAX_BUFFER, timeout: RECORDED_STILL_TIMEOUT_MS },
          (err, stdout) => resolve(err !== null ? null : stdout),
        )
        // The fragment goes in on stdin and never touches disk: it is ~200 KB,
        // and staging it would add an fs round trip plus a temp file to clean
        // up on every one of thousands of tracks.
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(Buffer.from(gop))
      })
    },
  }
}
