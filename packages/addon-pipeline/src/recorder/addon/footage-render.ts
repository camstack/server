/**
 * One-shot media render FROM RECORDED FOOTAGE (notification attachments).
 *
 * Shared core behind `renderGif` and `renderClip`: both cut the same window out
 * of the same `low` profile through the export machinery's per-render source
 * playlist (absolute segment URIs — the ONLY playlist shape ffmpeg can consume,
 * see export-source-playlist.ts), pipe it through ONE ffmpeg invocation, and
 * return the bytes. Everything is transient: playlist and output are deleted on
 * every outcome.
 *
 * Fail-closed by construction: no footage covering the window ⇒ it throws, and
 * the caller (a notification rule) simply ships no attachment. A camera that is
 * not recording therefore cannot produce a clip — which is exactly why the
 * frame-ring plane (roadmap Phase 5) still matters for cameras with no
 * recording. It is NOT a prerequisite for the cameras that do record.
 */

import type { ChildProcess } from 'node:child_process'
import type { PinnedFfmpegResolver } from '@camstack/types'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeExportSourcePlaylist } from './export-source-playlist.js'
import type { RecordingProviderDeps } from './recording-provider.js'

export interface FootageRenderDeps {
  readonly deps: RecordingProviderDeps
  readonly exportsDir: string
  readonly spawn: (cmd: string, args: readonly string[]) => ChildProcess
  /** The node's pinned ffmpeg (D540). A rejection fails the render, logged per
   *  camera — never a PATH lookup. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /** Injectable for tests. */
  readonly now?: () => number
}

/** The window + geometry every footage render shares. */
export interface FootageWindowInput {
  readonly deviceId: number
  readonly aroundMs: number
  readonly preRollSec: number
  readonly postRollSec: number
  readonly maxWidth: number
}

export interface GifRenderInput extends FootageWindowInput {
  readonly fps: number
}

export type ClipRenderInput = FootageWindowInput

const RENDER_TIMEOUT_MS = 30_000

/**
 * How far back a requested window may be dragged to land on finalized footage.
 * Beyond this the render fails instead: a notification carrying video from two
 * minutes before the event is a lie about what happened.
 */
export const MAX_WINDOW_SHIFT_MS = 90_000

/**
 * A notification clip must sit AROUND the moment it describes. Sliding the
 * window back to the last finalized segment made the attachment exist, but it
 * showed the seconds BEFORE the trigger — an operator watching it sees the
 * approach and not the event, which is worse than a short wait (operator,
 * 2026-07-30). The caller therefore asks for the window it wants and the
 * renderer refuses until the footage covering it exists; the DISPATCHER waits
 * (the outbox already retries with backoff) and gives up into a still-only
 * notification rather than delaying delivery indefinitely.
 */
export const FOOTAGE_NOT_READY = 'footage-not-yet-finalized'

/**
 * NOT used by the notification path any more (a notification clip must sit
 * AROUND its moment — see {@link FOOTAGE_NOT_READY}). Retained for callers that
 * legitimately want the newest available footage rather than a specific
 * instant.
 *
 * Slide `[fromMs, toMs)` back so it ends no later than `availableEndMs`,
 * preserving its DURATION. `null` when the shift needed exceeds
 * {@link MAX_WINDOW_SHIFT_MS} (or there is no footage at all).
 *
 * WHY THIS EXISTS: only FINALIZED segments are addressable, and the segment
 * covering "now" is still being written — measured 13.2 s behind on the live
 * hub. An `immediate` rule asks for `[event-2s, event+5s]`, i.e. a window
 * entirely inside that unfinalized tail, so a gif or clip OF THE EVENT is
 * impossible at fire time (2026-07-30). Sliding the window back yields the
 * seconds LEADING UP to the trigger — the approach — which is the informative
 * part, and it is the only way the attachment can exist at all on an immediate
 * rule.
 */
export function slideWindowToAvailable(
  fromMs: number,
  toMs: number,
  availableEndMs: number | null,
): { fromMs: number; toMs: number } | null {
  if (availableEndMs === null) return null
  if (toMs <= availableEndMs) return { fromMs, toMs }
  const shift = toMs - availableEndMs
  if (shift > MAX_WINDOW_SHIFT_MS) return null
  return { fromMs: fromMs - shift, toMs: toMs - shift }
}

/** What a render produced: the bytes plus the window they actually cover. */
interface RenderedFootage {
  readonly bytes: Buffer
  readonly fromMs: number
  readonly toMs: number
}

/**
 * GIF for the widest notifier reach (every backend that takes an image takes a
 * gif); `fps` decimates and lanczos downscales.
 */
export async function renderGif(
  renderDeps: FootageRenderDeps,
  input: GifRenderInput,
): Promise<{ gifBase64: string; fromMs: number; toMs: number }> {
  const out = await renderFootage(renderDeps, input, 'gif', (playlistPath, outPath) => [
    '-y',
    '-i',
    playlistPath,
    '-vf',
    `fps=${input.fps},scale=${input.maxWidth}:-2:flags=lanczos`,
    '-loop',
    '0',
    '-f',
    'gif',
    outPath,
  ])
  return { gifBase64: out.bytes.toString('base64'), fromMs: out.fromMs, toMs: out.toMs }
}

/**
 * MP4 clip — the "send a clip, not a gif" attachment. Re-encodes rather than
 * stream-copying: a concat of segments whose encoder parameters differ (a
 * profile switch, a broker redial) produces an mp4 no player will scrub, and a
 * notification attachment that will not play is worse than none. `faststart`
 * puts the moov up front so a chat client can play it without the whole file.
 */
export async function renderClip(
  renderDeps: FootageRenderDeps,
  input: ClipRenderInput,
): Promise<{ clipBase64: string; mime: string; fromMs: number; toMs: number; bytes: number }> {
  const out = await renderFootage(renderDeps, input, 'mp4', (playlistPath, outPath) => [
    '-y',
    '-i',
    playlistPath,
    '-vf',
    `scale=${input.maxWidth}:-2:flags=lanczos`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '28',
    '-profile:v',
    'main',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    // A notification clip is silent by contract: the audio track of a `low`
    // rendition is often absent, and a half-present track makes clients fail
    // the whole attachment.
    '-an',
    '-f',
    'mp4',
    outPath,
  ])
  return {
    clipBase64: out.bytes.toString('base64'),
    mime: 'video/mp4',
    fromMs: out.fromMs,
    toMs: out.toMs,
    bytes: out.bytes.byteLength,
  }
}

/** The shared playlist → ffmpeg → bytes pipeline. */
async function renderFootage(
  renderDeps: FootageRenderDeps,
  input: FootageWindowInput,
  ext: 'gif' | 'mp4',
  buildArgs: (playlistPath: string, outPath: string) => readonly string[],
): Promise<RenderedFootage> {
  const now = renderDeps.now ?? Date.now
  const fromMs = input.aroundMs - input.preRollSec * 1000
  const toMs = input.aroundMs + input.postRollSec * 1000
  // A non-finite window is a CALLER bug, not an absence of footage. Saying
  // "no footage covers [NaN, NaN)" sent a day of gif attachments to a
  // debug line that read like a legitimate fail-closed skip (2026-07-30).
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error(
      `invalid ${ext} window [${fromMs}, ${toMs}) for device ${input.deviceId} — ` +
        `aroundMs=${input.aroundMs} preRollSec=${input.preRollSec} postRollSec=${input.postRollSec}`,
    )
  }
  const renderId = `${ext}-${now()}-${Math.floor(Math.random() * 1e6)}`

  // The cheap question first: without the pinned binary there is no render,
  // so nothing is staged. Never a PATH `ffmpeg` (D540).
  let ffmpegPath: string
  try {
    ffmpegPath = await renderDeps.resolveFfmpeg()
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    renderDeps.deps.logger.error(`${ext} render refused — no pinned ffmpeg on this node (D540)`, {
      tags: { deviceId: input.deviceId },
      meta: { error: reason },
    })
    throw new Error(
      `${ext} render refused for device ${input.deviceId}: no pinned ffmpeg — ${reason}`,
      { cause: err },
    )
  }

  // CENTRED, never slid: the caller gets the window it asked for. When the
  // segment covering it is still being written the render fails with a
  // RECOGNISABLE reason, so the dispatcher can wait for it instead of shipping
  // footage from before the event.
  const availableEnd = latestFinalizedEnd(renderDeps, input.deviceId)
  if (availableEnd === null || availableEnd < toMs) {
    throw new Error(
      `${FOOTAGE_NOT_READY}: [${fromMs}, ${toMs}) for device ${input.deviceId} — ` +
        `finalized footage ends at ${availableEnd ?? 'never'}`,
    )
  }
  const window = { fromMs, toMs }

  const playlist = await writeExportSourcePlaylist({
    deps: renderDeps.deps,
    exportsDir: renderDeps.exportsDir,
    exportId: renderId,
    deviceId: input.deviceId,
    profile: 'low',
    fromMs: window.fromMs,
    toMs: window.toMs,
  })
  if (playlist === null) {
    throw new Error(
      `no footage covers [${window.fromMs}, ${window.toMs}) for device ${input.deviceId}`,
    )
  }
  const outPath = path.join(path.dirname(playlist.path), `${renderId}.${ext}`)

  try {
    await runFfmpeg(renderDeps, ffmpegPath, buildArgs(playlist.path, outPath), ext)
    const bytes = await fs.readFile(outPath)
    if (bytes.byteLength === 0) throw new Error(`${ext} render produced an empty file`)
    // Report the window actually RENDERED, not the one asked for.
    return { bytes, fromMs: window.fromMs, toMs: window.toMs }
  } finally {
    await fs.rm(playlist.path, { force: true }).catch(() => {})
    // The ffconcat twin is written alongside the m3u8 for every export id —
    // this render never reads it, but leaving it behind would leak one file
    // per gif/clip.
    await fs.rm(playlist.concatPath, { force: true }).catch(() => {})
    await fs.rm(outPath, { force: true }).catch(() => {})
  }
}

/**
 * The end of the newest FINALIZED `low` segment, or null when none exists.
 *
 * One scalar off the tail of the live sorted view — it used to COPY the
 * device's whole `low` archive to fold a maximum out of it, per render.
 */
function latestFinalizedEnd(renderDeps: FootageRenderDeps, deviceId: number): number | null {
  return renderDeps.deps.index.latestEnd(deviceId, 'low')
}

/**
 * Run one ffmpeg and GUARANTEE the child is gone before the promise settles.
 *
 * The previous shape leaked on two paths: a `spawn` error (`ENOENT`, a bad
 * path) rejected while a process could still be alive, and a `close` with a
 * non-zero code rejected without ever reaping stdio. These renders fire on
 * every notification with a gif or clip, so a leak here is a slow accumulation
 * of ffmpeg processes on the recording node — the kind that shows up days later
 * as "the hub got slow" (operator, 2026-07-30).
 *
 * `settle` is idempotent and always kills first: killing an already-exited pid
 * throws ESRCH, which is swallowed, so the cost of being wrong is nothing while
 * the cost of NOT killing is a zombie per render.
 */
function runFfmpeg(
  renderDeps: FootageRenderDeps,
  ffmpegPath: string,
  args: readonly string[],
  ext: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = renderDeps.spawn(ffmpegPath, args)
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const settle = (err: Error | null): void => {
      if (done) return
      done = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone — ESRCH */
        }
      }
      // Detach the pipes: an un-drained stderr keeps the handle (and the child)
      // referenced even after the process object is dropped.
      try {
        proc.stderr?.removeAllListeners()
        proc.stdout?.destroy()
        proc.stderr?.destroy()
      } catch {
        /* nothing readable to detach */
      }
      if (err === null) resolve()
      else reject(err)
    }

    timer = setTimeout(() => settle(new Error(`${ext} render timed out`)), RENDER_TIMEOUT_MS)
    let stderrTail = ''
    proc.stderr?.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString()).slice(-400)
    })
    proc.on('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
    proc.on('close', (code) => {
      settle(code === 0 ? null : new Error(`ffmpeg ${ext} render exited ${code}: ${stderrTail}`))
    })
  })
}
