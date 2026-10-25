/**
 * One clip's STILL, taken off the camera's own `/cam/playback` replay.
 *
 * ## Why the replay, and not the archived file
 *
 * This addon already holds a whole-file path (`clip-file.ts`,
 * `RPC_Loadfile` + one `+faststart` pass) and it is the WRONG tool for a
 * thumbnail: measured on 3836 the same day, one clip's file took **74 475 ms**
 * to pull at 0.5–1.1 MB/s while the camera was also serving its live streams,
 * and a 20-tile screen would be twenty of those. A still does not need the
 * clip. It needs one frame.
 *
 * ## The position: this camera really does seek, and that is NOT Hikvision's
 *   answer
 *
 * the private session log recorded it as explicitly unmeasured — *"whether
 * the position `/cam/playback` SAYS it seeked to is the position it
 * DELIVERS"*. **Measured on 3836, 2026-09-23, by DECODING the frame and
 * reading the burned-in OSD against the catalog row, never by the absence of
 * an error:**
 *
 * | row | asked (camera wall clock) | OSD delivered |
 * | --- | --- | --- |
 * | `19:04:59 → 19:08:24` (205 s) | head `19:04:59` | `19:04:59` |
 * | same row | mid `19:06:41` | `19:06:39` |
 * | `19:29:11 → 19:32:10` (179 s) | mid `19:30:40` | `19:30:40` |
 *
 * So the ask is honoured to within one GOP (the keyframe at or before the
 * target — 2 s on the one row that moved, 4 s GOP). **Hikvision cannot do
 * this**: there a narrowed `ContentMgmt/search` is accepted with 200 and
 * silently served from the segment head, which is why that provider mints the
 * FIRST frame and says so (`clip-first-frame.ts`). Here the midpoint is
 * reachable, and the midpoint is the better picture: the first frame of a
 * motion segment is the moment BEFORE the subject arrived. On the 205 s row
 * above the head frame is an empty room and the midpoint frame has the dog in
 * it — which is the whole complaint.
 *
 * ## What one mint costs the camera
 *
 * Measured on 3836 with the exact argv below, 6 clips × 2 reps: **1 388–
 * 2 313 ms, median 1 721 ms**, 22.7–35.5 KB of JPEG at 640 px. **Independent
 * of clip length** — a 205 s clip and a 107 s clip cost the same, because the
 * replay is closed the instant one frame is out. Byte-identical across reps.
 *
 * Re-measured end to end through the SHIPPED `mintClipStill`, same camera,
 * five runs on one 205 s clip: `slotMs` 4 370 / 1 606 / 1 772 / 2 132 /
 * 1 817, each answering the same 23 180 bytes. The 4 370 is the shape to
 * expect, not an anomaly — the budget is shared with whatever else is dialling
 * the camera (D617) — and it is why {@link CLIP_STILL_TIMEOUT_MS} is a bound
 * on a hang rather than a budget.
 *
 * That is real, and it is spent on the camera's SCARCE resource: the replay
 * budget a playback also draws on (8–9 concurrent, varying — D617). So every
 * mint goes through `replay-lane.ts`, a mint is SUBORDINATE to a playback
 * (`'still'` yields the slot the moment a `'stream'` asks), and a mint refused
 * for the lane says `queue-full` by name rather than looking like a camera
 * with no picture.
 *
 * ## And what it never does
 *
 * It never invents. A replay that will not open, or one that delivers no
 * decodable frame, produces NO still and says which (D315: absence stays
 * absence). A black frame or another clip's poster standing in for a picture
 * that does not exist is the one outcome that must be impossible.
 */
import type { ChildProcess } from 'node:child_process'

import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { type PinnedFfmpegSpawnAnswer, resolvePinnedFfmpegSpawner } from '@camstack/types/node'

import { classifyMuxFailure, describeCameraRefusal } from './clip-stream.js'
import { CLIP_MUX_PROBE_BYTES } from './clip-stream-mux.js'
import type { AmcrestClipRow } from './clip-search.js'

/**
 * The long edge of a still.
 *
 * The source is the 2560×1440 main copy — there is no sub twin in this
 * camera's archive — and a tile is a few hundred pixels. 106 is two of those
 * on a retina screen and measured 22.7–35.5 KB at {@link CLIP_STILL_QUALITY},
 * which is what makes the file bound affordable.
 */
export const CLIP_STILL_WIDTH = 640

/** ffmpeg's `-q:v` for MJPEG: 2 is visually lossless, 31 is the floor. */
export const CLIP_STILL_QUALITY = 4

/**
 * How long one mint may hold the camera before it is abandoned.
 *
 * Measured worst case is 2 313 ms (4 370 ms once, with the budget shared).
 * It was ten seconds, and on 2026-09-25 every mint on 3836 ran the whole ten
 * and produced nothing: a replay that has shown no frame in five seconds is
 * not going to, and every extra second is a camera session held next to the
 * live streams.
 */
export const CLIP_STILL_TIMEOUT_MS = 5_000

/** Why a still could not be cut. All map onto the cap's own vocabulary. */
export type ClipStillCutFailure =
  /** The camera refused the replay, or delivered nothing inside the bound. */
  | 'camera-refused'
  /** The replay ran and produced no decodable picture. */
  | 'no-keyframe'
  /** OUR ffmpeg failed, or could not be spawned at all. */
  | 'decode-failed'
  /** An operator's playback wanted the slot. Speculative work, abandoned. */
  | 'yielded'

export type ClipStillCut =
  | {
      readonly kind: 'ok'
      readonly bytes: Buffer
      /** How long the camera's slot was held, spawn to child gone. */
      readonly slotMs: number
    }
  | {
      readonly kind: 'refused'
      readonly code: ClipStillCutFailure
      readonly detail: string
    }

export interface ClipStillWindow {
  readonly startMs: number
  readonly endMs: number
}

export interface ClipStillCutInput {
  /** The credentialled `/cam/playback` URL for {@link clipStillWindow}'s
   *  window. Never logged (`describeReplayUrl`). */
  readonly url: string
}

export interface ClipStillCutDeps {
  readonly logger: IScopedLogger
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /** Seam for the spec: the real spawn otherwise. */
  readonly spawnStill?: (args: readonly string[]) => ChildProcess
  /** Abandon now and give the slot back — the lane's yield. */
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/**
 * Which slice of the clip the camera is asked for.
 *
 * The MIDPOINT of the row's own window, running to the row's end so the
 * camera has the rest of the clip to answer from. `null` for a row that spans
 * nothing: an unstated position is not zero (D382), and a midpoint of a
 * zero-length window is a guess, not a picture.
 */
export function clipStillWindow(row: AmcrestClipRow): ClipStillWindow | null {
  const spanMs = row.endMs - row.startMs
  if (spanMs <= 0) return null
  return { startMs: row.startMs + Math.floor(spanMs / 2), endMs: row.endMs }
}

/**
 * What ffmpeg is told. Pure, so the arguments can be proved without a spawn.
 *
 * There is deliberately **no `-ss`**: `/cam/playback` is addressed by a time
 * window and nothing else (`clip-replay-url.ts`), so the seek IS the URL's
 * `starttime`. An `-ss` here would seek inside a realtime replay and pay its
 * offset in wall clock.
 */
export function buildClipStillArgs(input: ClipStillCutInput): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    // TCP, never UDP: the camera interleaves on the control socket, which is
    // what makes an abandoned session free its slot the moment the socket
    // dies rather than on an RTCP timeout.
    '-rtsp_transport',
    'tcp',
    // Nothing is being discovered — the SDP names the codec and carries the
    // parameter sets — and ffmpeg's 5 s / 5 MB defaults are paid in WALL CLOCK
    // by a realtime source (D616). These are input options and apply only to
    // the input that follows them.
    '-analyzeduration',
    '0',
    '-probesize',
    String(CLIP_MUX_PROBE_BYTES),
    '-i',
    input.url,
    '-frames:v',
    '1',
    // `-2` rather than `-1`: an odd height is not encodable by every JPEG
    // path and costs nothing to avoid.
    '-vf',
    `scale=${String(CLIP_STILL_WIDTH)}:-2:flags=bicubic`,
    '-q:v',
    String(CLIP_STILL_QUALITY),
    // Stated explicitly: ffmpeg picks a muxer from the extension and there is
    // no extension on `pipe:1`.
    '-f',
    'mjpeg',
    'pipe:1',
  ]
}

/** A signal read fresh — the await above may have flipped it. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/**
 * Cut one still off the camera. Never throws: every dead end is a named
 * refusal, and the camera's socket is closed on every one of them.
 */
export async function cutClipStill(
  input: ClipStillCutInput,
  deps: ClipStillCutDeps,
): Promise<ClipStillCut> {
  const startedAt = Date.now()
  if (deps.signal?.aborted === true) {
    // The cheapest question of all: never dial a camera whose slot has already
    // been claimed by the thing this work is subordinate to.
    return {
      kind: 'refused',
      code: 'yielded',
      detail: 'the slot was wanted before the dial',
    }
  }

  // An injected seam spawns SYNCHRONOUSLY, as before; only the real spawn
  // waits for the resolver.
  const still: PinnedFfmpegSpawnAnswer =
    deps.spawnStill !== undefined
      ? { kind: 'ready', spawn: deps.spawnStill }
      : await resolvePinnedFfmpegSpawner(undefined, deps.resolveFfmpeg, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
  if (still.kind === 'refused') {
    return { kind: 'refused', code: 'decode-failed', detail: still.detail }
  }
  const spawnStill = still.spawn
  // Asked again AFTER the resolve and BEFORE the spawn: spawning is dialling,
  // and a slot claimed during the await must not cost the camera a dial.
  // (Through a call: TypeScript narrowed `aborted` at the first check and
  // cannot see that the await may have flipped it.)
  if (isAborted(deps.signal)) {
    return {
      kind: 'refused',
      code: 'yielded',
      detail: 'the slot was wanted while the pinned ffmpeg was being resolved',
    }
  }
  let child: ChildProcess
  const args = buildClipStillArgs(input)
  try {
    child = spawnStill(args)
  } catch (err: unknown) {
    return {
      kind: 'refused',
      code: 'decode-failed',
      detail: `ffmpeg could not be spawned: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const chunks: Buffer[] = []
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000)
  })

  const timeoutMs = deps.timeoutMs ?? CLIP_STILL_TIMEOUT_MS
  let yielded = false
  const exit = await new Promise<number | null | 'timeout' | 'yielded'>((resolve) => {
    const onAbort = (): void => {
      yielded = true
      resolve('yielded')
    }
    // Asked BEFORE listening: the pinned-binary lookup above is an await, and
    // a slot claimed during it fired its `abort` with nobody listening yet.
    if (deps.signal?.aborted === true) {
      onAbort()
      return
    }
    deps.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
    const done = (value: number | null): void => {
      clearTimeout(timer)
      deps.signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    child.once('error', () => {
      done(null)
    })
    child.once('close', (code) => {
      done(code)
    })
  })

  // The socket goes back on EVERY exit, including the ones that answer with a
  // picture: a mint that reported a yield and left ffmpeg running would hold
  // the camera's slot anyway, which is the one thing the lane exists to stop.
  if (exit === 'yielded' || exit === 'timeout') child.kill('SIGKILL')
  const slotMs = Date.now() - startedAt

  if (yielded) {
    return {
      kind: 'refused',
      code: 'yielded',
      detail: `a playback wanted the slot after ${String(slotMs)} ms`,
    }
  }
  if (exit === 'timeout') {
    return {
      kind: 'refused',
      code: 'camera-refused',
      detail:
        `the camera produced no frame within ${String(timeoutMs)} ms: ` +
        (stderr.trim().slice(-200) || 'ffmpeg said nothing'),
    }
  }

  const bytes = Buffer.concat(chunks)
  // Bytes FIRST. ffmpeg can exit non-zero on a replay it has nonetheless
  // decoded a whole frame out of, and a picture in hand is a picture.
  if (bytes.byteLength > 0) return { kind: 'ok', bytes, slotMs }

  if (exit !== 0) {
    // WHOSE failure this is, decided by the same two rules the stream uses —
    // one authority for what ffmpeg's words mean, and for the fact that this
    // firmware's 404 covers three different things and only one of them is
    // "the clip is gone" (D611/D315).
    const code = classifyMuxFailure(stderr)
    return code === 'camera-refused'
      ? {
          kind: 'refused',
          code: 'camera-refused',
          detail: describeCameraRefusal(stderr),
        }
      : {
          kind: 'refused',
          code: 'decode-failed',
          detail: `ffmpeg exited ${String(exit)}: ${stderr.trim().slice(-300)}`,
        }
  }

  // A branch that accepted work and produced nothing is the same branch as one
  // that dropped it (D391) — and it is NEVER a black frame invented to fill
  // the tile (D315).
  return {
    kind: 'refused',
    code: 'no-keyframe',
    detail: `the replay ran for ${String(slotMs)} ms and produced no decodable frame`,
  }
}
