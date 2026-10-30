/**
 * One clip's STILL, cut with ffmpeg from a position inside the clip itself.
 *
 * ## Why it is cut from the archived FILE and not from the camera
 *
 * Reolink mints a clip still from a single Baichuan `CoverPreview` command,
 * about 200 ms of one camera socket. **Hikvision's ISAPI has no such thing.**
 * Its only picture endpoint is `Streaming/channels/<id>/picture`, which is the
 * LIVE view — a picture of now, for a clip from yesterday, which is worse than
 * no picture at all.
 *
 * The recording itself is the only place a still of that moment exists, and
 * this provider already holds one copy of it: `prepareClipFile` muxes a
 * `+faststart` MP4 into the scratch for the player's URL, the export and the
 * byte offer, and D605 § 7 / D558 make that ONE fetch serve every ask. A still
 * is the cheapest ask of them all — `-ss` on a faststart MP4 decodes a single
 * frame in about a tenth of a second and touches no camera.
 *
 * So a still costs nothing for a clip whose media is held, and for one that is
 * not held it costs exactly the fetch the operator's next tap would have paid
 * anyway. What it must never do is pay that fetch twice, or pay it while the
 * camera's one replay slot is serving somebody's playback — which is why the
 * mint goes through the same `replay-lane` as everything else here.
 *
 * ## The position
 *
 * A MIDPOINT, which is the operator's own instruction and is also the right
 * answer: the first frame of a motion segment is the moment BEFORE the subject
 * arrived, which is precisely the picture that says nothing. `-ss` before
 * `-i` is an input seek, so it lands on the keyframe at or before the target —
 * on 1436 the GOP is 4 s, so a 9 s midpoint decodes the keyframe at 6.32 s.
 * Near the middle, and it costs one frame of decode rather than eighteen
 * seconds of it.
 *
 * ## And what it never does
 *
 * It never invents. A clip whose file cannot be read, or whose seek lands past
 * the end, produces NO still and says which (D315: absence stays absence). The
 * one thing that must not happen is a black frame or a poster from another
 * clip standing in for a picture that does not exist.
 */
import type { ChildProcess } from 'node:child_process'

import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { type PinnedFfmpegSpawnAnswer, resolvePinnedFfmpegSpawner } from '@camstack/types/node'

import { CLIP_MUX_PROBE_BYTES } from './clip-stream-mux.js'
import type { VideoAccessUnit } from './rtsp/rtp-depacketize.js'
import type { RtspVideoCodec } from './rtsp/rtsp-sdp.js'

/**
 * The long edge of a still.
 *
 * The source is a 4K main copy — there is no sub twin on this camera
 * (`clip-twins.ts`) — and a tile is a few hundred pixels. 640 is two of those
 * on a retina screen and about 30 KB at {@link CLIP_STILL_QUALITY}, which is
 * what makes the 2 000-file bound affordable.
 */
export const CLIP_STILL_WIDTH = 640

/** ffmpeg's `-q:v` for MJPEG: 2 is visually lossless, 31 is the floor. */
export const CLIP_STILL_QUALITY = 4

/**
 * How long one frame of decode may take before the mint is abandoned.
 *
 * A single 4K HEVC frame off a local file measures well under a second. Ten is
 * an ffmpeg that is not going to answer, and waiting longer only holds the
 * tile's request open behind it.
 */
export const CLIP_STILL_TIMEOUT_MS = 10_000

/** Why a still could not be cut. Both map onto the cap's own vocabulary. */
export type ClipStillCutFailure =
  /** ffmpeg read the file and produced no frame: the seek landed past its end,
   *  or the file holds no decodable picture. */
  | 'no-keyframe'
  /** ffmpeg failed, or could not be spawned at all. */
  | 'decode-failed'

export type ClipStillCut =
  | { readonly kind: 'ok'; readonly bytes: Buffer }
  | { readonly kind: 'refused'; readonly code: ClipStillCutFailure; readonly detail: string }

export interface ClipStillCutInput {
  /** The archived `+faststart` MP4 in this addon's own scratch. */
  readonly path: string
  /**
   * How long the clip really is, from the media's own clock — or the catalog
   * row's span when nothing has measured it.
   *
   * `null` is not allowed: an unstated position is not zero (D382), and a
   * midpoint of an unknown length is a guess. A caller with no length asks for
   * the row's, which is the number it already showed the operator.
   */
  readonly durationMs: number
}

export interface ClipStillCutDeps {
  readonly logger: IScopedLogger
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /** Seam for the spec: the real spawn otherwise. */
  readonly spawnStill?: (args: readonly string[]) => ChildProcess
  readonly timeoutMs?: number
}

/** Where inside a clip the still is cut, in seconds. Exported to be proved. */
export function clipStillSeekSeconds(durationMs: number): number {
  // Never negative, and never past the end: a zero-length row would otherwise
  // ask ffmpeg for a frame before the file starts.
  return Math.max(0, durationMs / 2_000)
}

/** What ffmpeg is told. Pure, so the arguments can be proved without a spawn. */
export function buildClipStillArgs(input: ClipStillCutInput): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    // BEFORE `-i`: an input seek, which jumps by the index to the keyframe at
    // or before the target instead of decoding everything up to it.
    '-ss',
    clipStillSeekSeconds(input.durationMs).toFixed(3),
    '-i',
    input.path,
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

/**
 * What ffmpeg is told to cut a still out of RAW ACCESS UNITS.
 *
 * The other half of the same job. A clip whose bytes are not on this disk is
 * never FETCHED — that costs the camera its playback session for the clip's
 * whole duration — so its FIRST frame is taken off the camera in about half a
 * second (`clip-first-frame.ts`) and decoded here, from an elementary stream
 * on stdin rather than from a file.
 *
 * No `-ss`: the units ARE the head, and there is no seek inside a Hikvision
 * replay to reach anything else. No `-r`: one frame carries no rate, which is
 * the single case `clip-replay-rate.ts`'s rule does not reach.
 */
export function buildFirstFrameStillArgs(codec: RtspVideoCodec): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    // Nothing is being discovered: the demuxer is named from the SDP's own
    // `a=rtpmap`, and the default 5 MB / 5 s probe would read this whole input
    // and then wait for more that is never coming.
    '-analyzeduration',
    '0',
    '-probesize',
    String(CLIP_MUX_PROBE_BYTES),
    '-f',
    codec === 'h265' ? 'hevc' : 'h264',
    '-i',
    'pipe:0',
    '-frames:v',
    '1',
    '-vf',
    `scale=${String(CLIP_STILL_WIDTH)}:-2:flags=bicubic`,
    '-q:v',
    String(CLIP_STILL_QUALITY),
    '-f',
    'mjpeg',
    'pipe:1',
  ]
}

/** The first frame the camera handed over, as a JPEG. Never throws. */
export async function cutStillFromAccessUnits(
  units: readonly VideoAccessUnit[],
  codec: RtspVideoCodec,
  deps: ClipStillCutDeps,
): Promise<ClipStillCut> {
  return await runStillFfmpeg(
    buildFirstFrameStillArgs(codec),
    Buffer.concat(units.map((unit) => Buffer.from(unit.bytes))),
    deps,
    'the camera’s first access units',
  )
}

/**
 * Cut one still. Never throws: every dead end is a named refusal.
 */
export async function cutClipStill(
  input: ClipStillCutInput,
  deps: ClipStillCutDeps,
): Promise<ClipStillCut> {
  return await runStillFfmpeg(
    buildClipStillArgs(input),
    null,
    deps,
    `${clipStillSeekSeconds(input.durationMs).toFixed(3)} s into the held file`,
  )
}

/**
 * One bounded ffmpeg that answers with a JPEG or a named refusal.
 *
 * `stdin` carries the elementary stream when the source is the camera, and is
 * `null` when the source is a path. Shared, so the two cannot drift apart on
 * the timeout, the kill, or what an empty answer means.
 */
async function runStillFfmpeg(
  args: readonly string[],
  stdin: Buffer | null,
  deps: ClipStillCutDeps,
  where: string,
): Promise<ClipStillCut> {
  // An injected seam spawns SYNCHRONOUSLY, as before; only the real spawn
  // waits for the resolver.
  const still: PinnedFfmpegSpawnAnswer =
    deps.spawnStill !== undefined
      ? { kind: 'ready', spawn: deps.spawnStill }
      : await resolvePinnedFfmpegSpawner(undefined, deps.resolveFfmpeg, {
          stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        })
  if (still.kind === 'refused') {
    return { kind: 'refused', code: 'decode-failed', detail: still.detail }
  }
  const spawnStill = still.spawn
  let child: ChildProcess
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
    stderr += chunk.toString('utf8')
  })
  if (stdin !== null) {
    // A pipe whose peer has gone emits `error`, and an unhandled one on a
    // stream THROWS out of the event loop. ffmpeg taking its one frame and
    // exiting before the write drains is the ORDINARY case here, not a fault.
    child.stdin?.on('error', () => {})
    child.stdin?.end(stdin)
  }
  const timeoutMs = deps.timeoutMs ?? CLIP_STILL_TIMEOUT_MS
  const exit = await new Promise<number | null | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  if (exit === 'timeout') {
    child.kill('SIGKILL')
    return {
      kind: 'refused',
      code: 'decode-failed',
      detail: `ffmpeg did not answer inside ${String(timeoutMs)} ms`,
    }
  }
  const bytes = Buffer.concat(chunks)
  // Bytes FIRST. ffmpeg exits non-zero on a truncated elementary stream it has
  // nonetheless decoded a whole frame out of — which is exactly what two
  // access units are. A picture in hand is a picture.
  if (bytes.byteLength > 0) return { kind: 'ok', bytes }
  if (exit !== 0) {
    return {
      kind: 'refused',
      code: 'decode-failed',
      detail: `ffmpeg exited ${String(exit)}: ${stderr.trim().slice(0, 300)}`,
    }
  }
  // A branch that accepted work and produced nothing is the same branch as one
  // that dropped it (D391) — and it is NEVER a black frame invented to fill
  // the tile (D315).
  return {
    kind: 'refused',
    code: 'no-keyframe',
    detail: `ffmpeg read ${where} and produced no frame`,
  }
}
