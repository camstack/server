/**
 * One JPEG from a saved teed clip.
 *
 * ## Where the frame comes from
 *
 * The clip's head is the PREBUFFER — up to two fragment lengths of video from
 * before the trigger — so frame zero is a picture of the moment nothing was
 * happening. The seek is therefore the trigger instant
 * (`prebufferSpanMs`), clamped to zero, which is the only instant in a HomeKit
 * clip that anybody asked for.
 *
 * An INPUT seek, unlike `recorded-still.ts`'s output seek: that one reads a
 * ~200 KB fragment off a pipe, where an input seek is unreliable; this one
 * reads a real seekable file that may be tens of megabytes, where an output
 * seek would decode every frame up to the mark.
 *
 * ## Why the runner is injected and the minter never throws
 *
 * The caller is `HksvClipStore`, which VOUCHES: it stats the JPEG and believes
 * the file, not this verdict. What this layer owes it is a NAME for each way of
 * failing — a timeout, a missing binary and a corrupt clip are three different
 * operator actions, and collapsing them into "no thumbnail" is the blank tile
 * D549 decision 5 refuses.
 */
import type { spawn as nodeSpawn } from 'node:child_process'
import type { PinnedFfmpegResolver } from '@camstack/types'

import type { ClipFfmpegRun, ClipFfmpegRunner } from './clip-ffmpeg-run.js'
import { createBoundedFfmpegRunner } from './clip-ffmpeg-run.js'
import type { ClipThumbnailMinter, ClipThumbnailMintResult } from './clip-store.js'

/** The still's width. Enough for a list tile, small enough to be free. */
export const CLIP_THUMBNAIL_MAX_WIDTH = 640

/** A decode that has not finished by here is not going to. */
export const CLIP_THUMBNAIL_TIMEOUT_MS = 10_000

export interface ClipThumbnailArgsInput {
  readonly clipPath: string
  readonly jpegPath: string
  /** The trigger instant inside the clip, in seconds. Clamped at zero. */
  readonly seekSec: number
  readonly maxWidth: number
}

/**
 * How the still's ffmpeg ended. The bound and the kill are
 * {@link createBoundedFfmpegRunner}'s, shared with the faststart pass — one
 * deadline mechanism, two budgets.
 */
export type ClipThumbnailRun = ClipFfmpegRun
export type ClipThumbnailRunner = ClipFfmpegRunner

export function buildClipThumbnailArgs(input: ClipThumbnailArgsInput): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    '-ss',
    String(Math.max(0, Math.floor(input.seekSec))),
    '-i',
    input.clipPath,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${input.maxWidth},iw)':-2`,
    '-f',
    'image2',
    '-vcodec',
    'mjpeg',
    input.jpegPath,
  ]
}

export interface ClipThumbnailMinterInput {
  readonly runner: ClipThumbnailRunner
  readonly maxWidth?: number
}

export function createClipThumbnailMinter(input: ClipThumbnailMinterInput): ClipThumbnailMinter {
  return async ({ clipPath, jpegPath, triggerOffsetSec }): Promise<ClipThumbnailMintResult> => {
    const args = buildClipThumbnailArgs({
      clipPath,
      jpegPath,
      seekSec: triggerOffsetSec,
      maxWidth: input.maxWidth ?? CLIP_THUMBNAIL_MAX_WIDTH,
    })
    let run: ClipThumbnailRun
    try {
      run = await input.runner(args)
    } catch {
      return { ok: false, reason: 'decode-failed' }
    }
    if (run.spawnFailed) return { ok: false, reason: 'ffmpeg-missing' }
    if (run.timedOut) return { ok: false, reason: 'timed-out' }
    if (run.code !== 0) return { ok: false, reason: 'decode-failed' }
    return { ok: true }
  }
}

export interface FfmpegClipThumbnailRunnerInput {
  /** The node's pinned ffmpeg (D540) — never a name looked up on PATH. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly spawnFn: typeof nodeSpawn
  readonly timeoutMs?: number
}

/**
 * The production runner: one bounded ffmpeg, killed at the deadline.
 *
 * Kept as a named entry point because the BUDGET is this module's business —
 * a still that has not decoded in ten seconds is not going to — while the
 * bounding itself belongs to {@link createBoundedFfmpegRunner}, shared with
 * the faststart pass so there is one place a deadline can be forgotten.
 */
export function createFfmpegClipThumbnailRunner(
  input: FfmpegClipThumbnailRunnerInput,
): ClipThumbnailRunner {
  return createBoundedFfmpegRunner({
    resolveFfmpeg: input.resolveFfmpeg,
    spawnFn: input.spawnFn,
    timeoutMs: input.timeoutMs ?? CLIP_THUMBNAIL_TIMEOUT_MS,
  })
}
