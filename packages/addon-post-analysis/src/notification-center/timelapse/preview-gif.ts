/**
 * The ANIMATED timelapse preview: a dozen frames of the finished render, each
 * given the same blurred-background + centred-title treatment as the still.
 *
 * The operator's ask, verbatim: *"inviato come gif o video (come per le altre
 * rule)"* [sent as a gif or video (as for the other rules)] — the other rules already offer an animated preview, and a ten-hour
 * night reads better as three seconds of motion than as one frame of it.
 *
 * Three decisions worth the words:
 *
 *  - **Frames come from a dozen cheap INPUT SEEKS, not from one filtered
 *    pass.** `-vf select=…` writing concatenated MJPEG to stdout would have to
 *    be split on SOI/EOI markers by hand, and writing to `out-%03d.jpg` would
 *    need a temp DIRECTORY port this module does not have. A seek per frame
 *    reuses {@link buildPreviewFrameArgs} — the argv already proven on the live
 *    hub — and each one is a keyframe seek that decodes nothing before it. Runs
 *    once per window per camera, sequentially, so a loaded hub never sees a
 *    dozen concurrent ffmpegs.
 *
 *  - **Assembly is sharp, not ffmpeg `palettegen`/`paletteuse`.** The hub
 *    carries two ffmpeg builds that already disagree about `drawtext`
 *    (D118), so betting the animation on a second optional filter chain would
 *    reproduce exactly that per-node coin flip. sharp is already this package's
 *    image dependency, already draws the titles, and writes animated GIFs
 *    natively (`join: { animated: true }` + `.gif()`).
 *
 *  - **EVERY frame is titled.** A title on frame 0 alone flickers, and a
 *    notification card may freeze the animation on any frame — including the
 *    poster frame a client picks for itself. The title costs one blur per frame
 *    at 480 px, which is cheap at twelve.
 *
 * NOTHING here throws. Every failure answers `null`, and the caller degrades to
 * the still image rather than to no picture at all.
 */
import { Buffer } from 'node:buffer'
import type { IScopedLogger } from '@camstack/types'
import sharp from 'sharp'
import {
  buildPreviewFrameArgs,
  drawPreviewTitle,
  previewDurationSec,
  resolvePreviewFfmpeg,
  type TimelapsePreviewPorts,
  type TimelapsePreviewRequest,
} from './preview-frame.js'

/** How many frames the animation carries. Twelve at ~3 fps is four seconds of
 *  motion — enough to read a night, small enough to attach. */
export const PREVIEW_GIF_FRAMES = 12
/** Frames are scaled to this width. A dozen 960 px frames is not an
 *  attachment; 480 px is a notification card at 2× density. */
export const PREVIEW_GIF_MAX_WIDTH = 480
/**
 * Per-frame hold, milliseconds (~3 fps).
 *
 * A MULTIPLE OF 10 on purpose: a GIF stores delays in centiseconds, so 333 ms
 * would be written as 33 cs and read back as 330 — a round-trip that makes any
 * assertion about the value look like a bug in the assertion.
 */
export const PREVIEW_GIF_FRAME_DELAY_MS = 330
/**
 * Attachment ceiling for the animation.
 *
 * Notifier backends fetch this URL themselves and the degrade engine's image
 * budget is the binding constraint at the far end; 3 MB is comfortably under
 * every target's cap and still generous for twelve 480 px frames (a real night
 * lands around 300–600 KB). Over budget, the animation is thinned and then
 * abandoned — never sent oversized to be silently dropped by a notifier.
 */
export const PREVIEW_GIF_MAX_BYTES = 3 * 1024 * 1024

/**
 * Which offsets to sample, in seconds.
 *
 * CELL CENTRES, `(i + 0.5) / n`, not `i / n`: frame 0 of a timelapse is the
 * instant the window opened (the least representative frame in it — the same
 * reason the still is the middle frame) and the final instant is often past the
 * last keyframe ffmpeg can land on.
 *
 * The count shrinks with the video: sampling a three-second render twelve times
 * seeks the same keyframe repeatedly and produces a "moving" image that does
 * not move.
 */
export function previewGifSeekSeconds(
  durationSec: number,
  frames = PREVIEW_GIF_FRAMES,
): readonly number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0]
  const n = Math.max(1, Math.min(frames, Math.floor(durationSec)))
  return Array.from({ length: n }, (_v, i) => Math.round(((i + 0.5) / n) * durationSec * 100) / 100)
}

/** GIF bytes for these frames, or null. `delay` is an ARRAY: sharp applies a
 *  scalar to frame 0 only, and the rest would run at the GIF default. */
async function encodeGif(frames: readonly Buffer[]): Promise<Buffer> {
  return await sharp([...frames], { join: { animated: true } })
    .gif({ delay: frames.map(() => PREVIEW_GIF_FRAME_DELAY_MS), loop: 0 })
    .toBuffer()
}

/**
 * Titled frames → one animated GIF.
 *
 * @returns the GIF; `null` when there are no frames, when sharp cannot read
 *          them, or when even a thinned animation exceeds
 *          {@link PREVIEW_GIF_MAX_BYTES} — each logged, never thrown.
 */
export async function assemblePreviewGif(
  frames: readonly Buffer[],
  logger: IScopedLogger,
  tags?: { readonly deviceId: number },
): Promise<Buffer | null> {
  const tagPart = tags !== undefined ? { tags } : {}
  if (frames.length === 0) {
    logger.warn('timelapse gif skipped: no frames to assemble', tagPart)
    return null
  }
  try {
    const first = await encodeGif(frames)
    if (first.byteLength <= PREVIEW_GIF_MAX_BYTES) return first
    // Thinned rather than re-encoded at lower quality: dropping every other
    // frame halves the bytes and keeps the full time span, where a coarser
    // palette keeps the span AND makes every frame worse.
    const thinned = frames.filter((_f, i) => i % 2 === 0)
    const second = await encodeGif(thinned)
    if (second.byteLength <= PREVIEW_GIF_MAX_BYTES) {
      logger.warn('timelapse gif thinned to fit the attachment budget', {
        ...tagPart,
        meta: { firstBytes: first.byteLength, bytes: second.byteLength, frames: thinned.length },
      })
      return second
    }
    logger.warn('timelapse gif abandoned: over the attachment budget even thinned', {
      ...tagPart,
      meta: { bytes: second.byteLength, maxBytes: PREVIEW_GIF_MAX_BYTES },
    })
    return null
  } catch (err: unknown) {
    logger.warn('timelapse gif assembly failed — degrading to the still', {
      ...tagPart,
      meta: { error: String(err) },
    })
    return null
  }
}

/**
 * Finished mp4 → animated, titled GIF.
 *
 * Same ports and same request as {@link renderTimelapsePreview}, so a caller
 * chooses between them on the rule's `previewMode` and nothing else changes.
 * Never throws, never leaves the temp file behind, and every `null` has a log
 * line naming which step declined — per camera, because "the notification had
 * no picture" is asked about ONE camera.
 */
export async function renderTimelapseGif(
  ports: TimelapsePreviewPorts,
  request: TimelapsePreviewRequest,
): Promise<Buffer | null> {
  const tags = { deviceId: request.deviceId }
  const ffmpeg = await resolvePreviewFfmpeg(ports, tags, 'timelapse gif')
  if (ffmpeg === null) return null
  let path: string
  try {
    path = await ports.writeTemp(request.mp4)
  } catch (err: unknown) {
    ports.logger.warn('timelapse gif skipped: could not stage the video', {
      tags,
      meta: { error: String(err) },
    })
    return null
  }
  try {
    const durationSec = previewDurationSec(request.mp4)
    if (durationSec === 0) {
      ports.logger.debug(
        'timelapse gif: the video carries no duration — one frame from the start',
        {
          tags,
        },
      )
    }
    const seeks = previewGifSeekSeconds(durationSec)
    const titled: Buffer[] = []
    // Sequential on purpose: a dozen concurrent ffmpegs on a hub already at
    // ~80% RAM is how a preview turns into a pipeline stall.
    for (const atSec of seeks) {
      const frame = await ports.run(
        ffmpeg,
        buildPreviewFrameArgs({ inputPath: path, atSec, maxWidth: PREVIEW_GIF_MAX_WIDTH }),
      )
      if (frame === null || frame.byteLength === 0) continue
      const drawn = await drawPreviewTitle(frame, request.text, ports.logger, tags)
      titled.push(drawn ?? frame)
    }
    if (titled.length === 0) {
      ports.logger.warn('timelapse gif skipped: no frame could be extracted', {
        tags,
        meta: { seeks: seeks.length, durationSec },
      })
      return null
    }
    if (titled.length < seeks.length) {
      // A gap here is a shorter animation, not a missing one — but silence
      // would read as "it was always twelve frames".
      ports.logger.debug('timelapse gif: some frames could not be extracted', {
        tags,
        meta: { got: titled.length, asked: seeks.length },
      })
    }
    return await assemblePreviewGif(titled, ports.logger, tags)
  } finally {
    await ports.removeTemp(path).catch(() => {})
  }
}
