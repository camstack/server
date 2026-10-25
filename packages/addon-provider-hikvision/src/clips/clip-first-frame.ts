/**
 * The FIRST frame of a clip, taken off the camera and nothing more.
 *
 * ## Why the first frame, and not the middle
 *
 * The operator asked for the midpoint, and the midpoint is the better picture:
 * the first frame of a motion segment is the moment BEFORE the subject
 * arrived. **It is not reachable.** Measured on 1436, 2026-09-23, three long
 * clips: `ContentMgmt/search` narrowed to `[mid, mid+4s]` returns a row and a
 * `playbackURI`, the replay opens `200`, delivers media — and the burned-in
 * OSD of the first frame reads the SEGMENT HEAD every time (`12:30:19` where
 * `12:31:34` was asked, `12:34:57` for `12:35:59`, `12:33:17` for `12:34:07`).
 * The window is accepted and silently ignored. There is no seek inside a
 * Hikvision replay, and a narrowed ask does not make one.
 *
 * So the first frame is not a compromise, it is the only frame this transport
 * offers — and it turns out to be cheap and exact:
 *
 * | | measured on 1436 |
 * | --- | --- |
 * | handshake (`DESCRIBE`/`SETUP`×2/`PLAY`) | 185–195 ms |
 * | first access unit, and it IS a keyframe | 309–390 ms from open |
 * | `TEARDOWN` + socket closed | 40–82 ms |
 * | **whole slot occupancy** | **433–528 ms** |
 *
 * Independent of clip length: a 150 s clip costs the same as a 6 s one, where
 * a whole-clip fetch costs the clip's own duration at 1× (20–150 s).
 *
 * **And it really is the clip's own moment.** The four stills this was proved
 * on carry OSDs matching their catalog rows to the second — `17:03:42`,
 * `17:55:36`, `18:56:30`, `20:07:10`. Verified by DECODING what arrived, never
 * by the absence of an error, because this firmware answers 200 and does what
 * it likes (see above).
 *
 * ## What this module will not do
 *
 * It does not decode, mux, cache or judge. It opens a replay, keeps access
 * units until it has a decodable head, tears the session down and hands the
 * bytes back. The slot is released before anything is decoded, because
 * decoding a 4K frame takes longer than the whole replay did and there is no
 * reason to hold a camera for it.
 */
import type { IScopedLogger } from '@camstack/types'

import type { HikvisionClipRow } from './clip-catalog.js'
import type { ClipStreamCamera } from './clip-stream.js'
import { openRtspReplay } from './rtsp/rtsp-replay-session.js'
import type { RtspVideoCodec } from './rtsp/rtsp-sdp.js'
import type { VideoAccessUnit } from './rtsp/rtp-depacketize.js'

/**
 * How many access units are kept before the session is torn down.
 *
 * Two. The first is the keyframe — measured, on every clip tried — and the
 * second is what lets the decoder close the first one out without waiting for
 * a flush. A third buys nothing and costs another 80 ms of the camera's only
 * playback session.
 */
export const FIRST_FRAME_ACCESS_UNITS = 2

/**
 * How long the whole thing may take before it is abandoned.
 *
 * Measured worst case is 528 ms. Five seconds is an order of magnitude over
 * it and still short enough that a tile's request does not outlive the
 * operator's patience — and the lane can evict it before then anyway.
 */
export const FIRST_FRAME_TIMEOUT_MS = 5_000

export type FirstFrameFailure =
  /** The camera refused the replay, or never delivered an access unit. */
  | 'camera-refused'
  /** An operator's playback wanted the slot. Speculative work, abandoned. */
  | 'yielded'

export type FirstFrameOutcome =
  | {
      readonly kind: 'ok'
      /** Annex-B, parameter sets on the first. Ready for `-f hevc -i pipe:0`. */
      readonly units: readonly VideoAccessUnit[]
      readonly codec: RtspVideoCodec
      /** How long the camera's slot was held, start to socket closed. */
      readonly slotMs: number
    }
  | { readonly kind: 'refused'; readonly code: FirstFrameFailure; readonly detail: string }

export interface FirstFrameInput {
  readonly camera: ClipStreamCamera
  readonly row: HikvisionClipRow
}

export interface FirstFrameDeps {
  readonly logger: IScopedLogger
  readonly openReplay?: typeof openRtspReplay
  /** Abandon now and give the slot back — the lane's yield. */
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly accessUnits?: number
}

/** Never throws: every dead end is a named refusal. */
export async function fetchFirstFrame(
  input: FirstFrameInput,
  deps: FirstFrameDeps,
): Promise<FirstFrameOutcome> {
  const openReplay = deps.openReplay ?? openRtspReplay
  const want = deps.accessUnits ?? FIRST_FRAME_ACCESS_UNITS
  const timeoutMs = deps.timeoutMs ?? FIRST_FRAME_TIMEOUT_MS
  const startedAt = Date.now()
  if (deps.signal?.aborted === true) {
    return { kind: 'refused', code: 'yielded', detail: 'the slot was wanted before the open' }
  }

  const units: VideoAccessUnit[] = []
  let enough: (() => void) | null = null
  const gotEnough = new Promise<void>((resolve) => {
    enough = resolve
  })

  let session
  try {
    session = await openReplay(
      {
        host: input.camera.host,
        username: input.camera.username,
        password: input.camera.password,
        playbackPath: input.row.playbackPath,
      },
      {
        onVideo: (unit) => {
          if (units.length >= want) return
          units.push(unit)
          if (units.length >= want) enough?.()
        },
      },
      { logger: deps.logger, deviceId: input.camera.deviceId },
    )
  } catch (err: unknown) {
    // The replay logged its own branch. A `SETUP … 500` here is the camera's
    // one playback slot, never a statement about the clip (D605).
    return {
      kind: 'refused',
      code: 'camera-refused',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  let yielded = false
  const onAbort = (): void => {
    yielded = true
    enough?.()
  }
  deps.signal?.addEventListener('abort', onAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null
    enough?.()
  }, timeoutMs)
  // The session ending on its own — a refusal after PLAY, or a segment shorter
  // than two access units — must not leave this waiting for the timeout.
  void session.ended.then(() => enough?.())
  await gotEnough
  if (timer !== null) clearTimeout(timer)
  deps.signal?.removeEventListener('abort', onAbort)
  // The slot goes back BEFORE anything is decoded: a 4K frame takes longer to
  // decode than this whole replay took, and no camera should wait for it.
  await session.close()
  const slotMs = Date.now() - startedAt

  if (yielded) {
    return {
      kind: 'refused',
      code: 'yielded',
      detail: `a playback wanted the slot after ${String(slotMs)} ms`,
    }
  }
  if (units.length === 0) {
    // A branch that accepted work and produced nothing is the same branch as
    // one that dropped it (D391).
    return {
      kind: 'refused',
      code: 'camera-refused',
      detail: `the replay delivered no access unit inside ${String(timeoutMs)} ms`,
    }
  }
  deps.logger.debug('videoclips: took a clip’s first frame off the camera', {
    tags: { deviceId: input.camera.deviceId },
    meta: {
      clipKey: input.row.clipKey,
      units: units.length,
      bytes: units.reduce((sum, unit) => sum + unit.bytes.byteLength, 0),
      codec: session.video.codec,
      slotMs,
    },
  })
  return { kind: 'ok', units, codec: session.video.codec, slotMs }
}
