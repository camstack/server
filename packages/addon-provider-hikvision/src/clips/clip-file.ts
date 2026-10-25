/**
 * One clip as a FINISHED file — the player's URL and the export's bytes.
 *
 * The same replay, the same depacketizer and the same mux constants as the
 * stream; what differs is the container and the ending. `+faststart` is a
 * second pass that moves `moov` to the front, so the output must be SEEKABLE:
 * this path writes to the scratch and never to a pipe. That is what makes the
 * admin UI's `<video>` element show a duration and seek, and it is why
 * `getClipPlayback` points here while the broker dials the stream.
 *
 * ## One fetch path, not two
 *
 * `getClipPlayback` and `readClipBytes` both land on {@link prepareClipFile},
 * so there is exactly one place that opens a replay for a whole segment, one
 * completion rule and one mux — the second authority D558 refuses to create.
 * The file is cached in the per-device scratch, so the player's URL and the
 * export's bytes cost one fetch between them.
 *
 * ## The bound is on the FETCH, not only on the answer
 *
 * A Hikvision segment is the 4K main copy and the worst one measured in 24 h
 * was 42.7 MB — 81 % of `VIDEOCLIPS_MAX_READ_BYTES`. A motion event 20 %
 * longer exceeds it. So the catalog's own `size` is checked before anything is
 * opened (the cheap question first, D54), and the accumulating fetch is
 * checked again against a hard ceiling, because the listed size and the
 * delivered size are not the same number and half a video is worse than an
 * honest refusal.
 */
import type { ChildProcess } from 'node:child_process'
import { rm, stat } from 'node:fs/promises'

import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { type PinnedFfmpegSpawnAnswer, resolvePinnedFfmpegSpawner } from '@camstack/types/node'

import { estimateReplayFps } from './clip-replay-rate.js'
import type { ClipArtifactStore } from './clip-artifact-store.js'
import type { HikvisionClipRow } from './clip-catalog.js'
import { buildClipFileMuxArgs, CLIP_STREAM_AUDIO_FD, writableStdio } from './clip-stream-mux.js'
import type { ClipStreamCamera } from './clip-stream.js'
import { openRtspReplay } from './rtsp/rtsp-replay-session.js'
import type { VideoAccessUnit } from './rtsp/rtp-depacketize.js'

/**
 * A ceiling on the RAW media one file fetch may accumulate.
 *
 * Not the same number as the cap's inline-read bound: this is what may be
 * pulled off the camera at all, and it is deliberately a little above the
 * inline bound so a clip that is too big to send INLINE is still playable from
 * its URL — which is exactly what the cap's own refusal tells the operator to
 * do.
 */
export const CLIP_FILE_MAX_FETCH_BYTES = 128 * 1024 * 1024

export type ClipFileFailure = 'camera-refused' | 'fetch-failed' | 'too-large-to-transfer'

export type ClipFileOutcome =
  | {
      readonly kind: 'ok'
      readonly path: string
      readonly bytes: number
      /** MEASURED on this pass — never derived from the catalog row (D393). */
      readonly durationMs: number | null
    }
  | { readonly kind: 'refused'; readonly code: ClipFileFailure; readonly detail: string }

export interface PrepareClipFileInput {
  readonly camera: ClipStreamCamera
  readonly row: HikvisionClipRow
  /** `false` mutes the file — the export's default is sound, like the app's. */
  readonly audio: boolean
}

export interface ClipFileDeps {
  readonly logger: IScopedLogger
  readonly store: ClipArtifactStore
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly spawnMux?: (args: readonly string[]) => ChildProcess
  readonly openReplay?: typeof openRtspReplay
  readonly maxFetchBytes?: number
}

/**
 * Fetch a whole segment and mux it, or answer the cached file.
 *
 * Never throws for a gated branch: a refusal carries its code and its prose so
 * the caller can turn it into the cap's own vocabulary.
 */
export async function prepareClipFile(
  input: PrepareClipFileInput,
  deps: ClipFileDeps,
): Promise<ClipFileOutcome> {
  const tags = { deviceId: input.camera.deviceId }
  const meta = { clipKey: input.row.clipKey }
  const cached = await deps.store.pathIfPresent(input.camera.deviceId, input.row.clipKey)
  if (cached !== null) {
    const info = await stat(cached)
    deps.logger.debug('videoclips: served a clip file from the scratch', {
      tags,
      meta: { ...meta, bytes: info.size },
    })
    return { kind: 'ok', path: cached, bytes: info.size, durationMs: null }
  }

  // The cheap question before the replay: without the pinned binary there is
  // no mux, so the camera is not dialled for it.
  const mux: PinnedFfmpegSpawnAnswer =
    deps.spawnMux !== undefined
      ? { kind: 'ready', spawn: deps.spawnMux }
      : await resolvePinnedFfmpegSpawner(undefined, deps.resolveFfmpeg, {
          stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
        })
  if (mux.kind === 'refused') {
    deps.logger.error('videoclips: clip mux refused — no pinned ffmpeg on this node (D540)', {
      tags,
      meta: { ...meta, detail: mux.detail },
    })
    return { kind: 'refused', code: 'fetch-failed', detail: mux.detail }
  }
  const spawnMux = mux.spawn

  const maxFetchBytes = deps.maxFetchBytes ?? CLIP_FILE_MAX_FETCH_BYTES
  const openReplay = deps.openReplay ?? openRtspReplay
  const units: VideoAccessUnit[] = []
  const audioPayloads: Buffer[] = []
  /**
   * What arrived, IN THE ORDER IT ARRIVED.
   *
   * ffmpeg reads whichever input has the lowest next dts, so feeding it all
   * the video and then all the sound makes it hold one pipe open while the
   * other drains — and on a real 19 s clip it exits before the audio is
   * written and the next `write()` is an EPIPE. A replay delivers its two
   * tracks interleaved in media order already, so remembering that order is
   * both the cheapest fix and the correct one.
   */
  const arrival: ('video' | 'audio')[] = []
  let fetched = 0
  let overflowed = false
  const startedAt = Date.now()

  let session: Awaited<ReturnType<typeof openRtspReplay>>
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
          fetched += unit.bytes.byteLength
          if (fetched > maxFetchBytes) {
            overflowed = true
            return
          }
          units.push(unit)
          arrival.push('video')
        },
        ...(input.audio
          ? {
              onAudio: (payload: Buffer) => {
                audioPayloads.push(payload)
                arrival.push('audio')
              },
            }
          : {}),
      },
      { logger: deps.logger, deviceId: input.camera.deviceId },
    )
  } catch (err: unknown) {
    return {
      kind: 'refused',
      code: 'camera-refused',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const end = await session.ended
  // The slot, given back before anything else is decided. `ended` resolving is
  // not the same fact as "this camera is free": the ordinary end of a segment
  // is a QUIET socket, so without this the fetch walked away holding the
  // camera's one playback session until its own 60 s timeout, and the next
  // clip the operator tapped met `SETUP … 500`.
  await session.close()
  if (end.kind === 'failed') {
    return { kind: 'refused', code: 'camera-refused', detail: end.detail }
  }
  const rowMs = input.row.endMs - input.row.startMs
  const deliveredMs = end.kind === 'complete' ? end.deliveredMs : null
  if (deliveredMs !== null && rowMs > 0 && deliveredMs < rowMs - 1_000) {
    // Served and NAMED, never silently. The file is whole as far as it goes
    // and a player can use it; what it is not is the span the catalog claimed,
    // and an operator comparing the two deserves the line rather than the
    // discovery (D568's rule, reached from a different wire).
    deps.logger.warn('videoclips: a clip file came up short of its catalog row', {
      tags,
      meta: { ...meta, branch: 'file-short', deliveredMs, rowMs },
    })
  }
  if (overflowed) {
    return {
      kind: 'refused',
      code: 'too-large-to-transfer',
      detail:
        `the replay of clip "${input.row.fileName}" passed the ${String(maxFetchBytes)}-byte ` +
        'fetch ceiling before the camera finished it',
    }
  }
  if (units.length === 0) {
    // A branch that accepted work and produced nothing is the same branch as
    // one that dropped it (D391): it is named, not silently answered empty.
    return {
      kind: 'refused',
      code: 'fetch-failed',
      detail: 'the camera played the replay out and delivered no access unit',
    }
  }

  const rate = estimateReplayFps(
    units.map((unit) => unit.timestamp),
    session.video.clockRate,
  )
  if (rate.fps === null) {
    return {
      kind: 'refused',
      code: 'fetch-failed',
      detail:
        `rate-unmeasured: ${String(units.length)} access units and the replay's own timestamps ` +
        "cannot say this clip's frame rate",
    }
  }

  const temp = await deps.store.reserve(input.camera.deviceId, input.row.clipKey)
  // µ-law goes in the FILE too, and in the FILE it must be transcoded: the
  // player is a browser `<video>`, which decodes AAC and not `ulaw`. Opus in
  // MP4 is what both Safari and Chromium take, and it is the codec the stream
  // path already encodes to, so the two paths sound alike.
  const withAudio = input.audio && audioPayloads.length > 0
  const args = buildClipFileMuxArgs(
    { videoCodec: session.video.codec, fps: rate.fps, audio: withAudio ? 'opus' : null },
    temp,
  )
  const child = spawnMux(args)
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-2000)
  })
  const audioPipe = withAudio ? writableStdio(child.stdio[CLIP_STREAM_AUDIO_FD]) : null
  // A pipe whose peer has gone emits `error`, and an unhandled one on a
  // stream THROWS out of the event loop. ffmpeg exiting early is a refusal
  // this function answers, never a crash.
  child.stdin?.on('error', () => {})
  audioPipe?.on('error', () => {})
  let videoAt = 0
  let audioAt = 0
  for (const which of arrival) {
    if (which === 'video') {
      const unit = units[videoAt]
      videoAt += 1
      if (unit !== undefined) child.stdin?.write(unit.bytes)
      continue
    }
    const payload = audioPayloads[audioAt]
    audioAt += 1
    if (payload !== undefined && audioPipe !== null) audioPipe.write(payload)
  }
  child.stdin?.end()
  audioPipe?.end()
  const exit = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })
  if (exit !== 0) {
    await rm(temp, { force: true })
    return {
      kind: 'refused',
      code: 'fetch-failed',
      detail: `ffmpeg exited ${String(exit)}: ${stderr.trim().slice(0, 300)}`,
    }
  }

  const path = await deps.store.publish(input.camera.deviceId, input.row.clipKey, temp)
  const info = await stat(path)
  const durationMs = Math.round(((units.length - 1) / rate.fps) * 1000)
  deps.logger.info('videoclips: muxed a clip file', {
    tags,
    meta: {
      ...meta,
      accessUnits: units.length,
      audioPayloads: audioPayloads.length,
      withAudio,
      fps: rate.fps,
      fetchedBytes: fetched,
      bytes: info.size,
      durationMs,
      listedBytes: input.row.sizeBytes ?? null,
      elapsedMs: Date.now() - startedAt,
    },
  })
  return {
    kind: 'ok',
    path,
    bytes: info.size,
    // Never zero, which would say the file is empty.
    durationMs: durationMs > 0 ? durationMs : null,
  }
}
