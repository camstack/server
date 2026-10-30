/**
 * One clip STREAM: `/cam/playback` → ffmpeg → peer, with a cut on every hop.
 *
 * The forward-only fMP4 D597 defined, produced from an Amcrest RTSP replay.
 * The broker dials this, demuxes it and paces it with code that must not know
 * which vendor is behind the socket, so what is the same is deliberate; what
 * differs is measured, and each difference is named where it lands.
 *
 * ## Why this is the playback path at all
 *
 * The FILE path is not slow because of anything this process does. Measured on
 * the live hub, 2026-09-23, camera 3836:
 *
 * | leg | 42.5 MB clip | 38.2 MB clip |
 * | --- | --- | --- |
 * | `RPC_Loadfile` pull | **74 475 ms** | **67 729 ms** |
 * | `-c copy -movflags +faststart` re-index | 121 ms | 110 ms |
 *
 * A bare `curl` of the same file from inside the hub container took 81.5 s, so
 * there is no overhead to remove: the camera serves the hub at 0.5–1.1 MB/s
 * while it is also serving its own live streams, and a 51-second clip costs 75
 * seconds before its first frame. The same clip's first byte over
 * `/cam/playback`, muxed by this module's own argument list, arrived at
 * **1 352 ms**.
 *
 * ## The run, in order
 *
 * 1. **Take the lane.** One replay per camera from this node
 *    (`replay-lane.ts`), refused by name rather than dialled.
 * 2. **Spawn.** ffmpeg opens the RTSP session itself — one input, no rate
 *    probe, no second pipe: see `clip-stream-mux.ts` for why none of
 *    Hikvision's machinery transfers.
 * 3. **Hold the first chunk.** Nothing is written to the peer until ffmpeg has
 *    produced a byte, so a camera that refuses is a CLEAN refusal with a
 *    status and a reason rather than an empty 200 (D391).
 * 4. **Stream, with a drain gate.** A peer that stops taking bytes is cut by
 *    name and the camera's socket is given back — never held for the length of
 *    a clip nobody is watching (D447).
 * 5. **End, and JUDGE it.** ffmpeg's exit ends the peer; the lease is released
 *    when the child is really gone, because "the run returned" is a different
 *    fact from "the camera is free". The exit code decides nothing about
 *    completeness — **this camera exits 0 after hanging up a third of the way
 *    through a clip** — so what was delivered is measured off `-progress` and
 *    judged against the row (`clip-truncation.ts`). A short or empty serve is
 *    named on its own log line and told to the peer in the response's
 *    trailers, and it is never retried. (D623)
 *
 * ## A `DESCRIBE 404` is the camera's refusal, never this clip's absence
 *
 * The camera answers `404` for a bogus path, for an evicted clip AND for a
 * session it has no budget for — measured 8–9 concurrent sessions on 3836,
 * varying with whatever else is dialling it. So a 404 out of ffmpeg is
 * reported as `camera-refused` with the whole sentence, and the surface is
 * told the camera refused rather than that the clip is gone.
 */
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

import {
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
  clipReasonHeaderValue,
  type IScopedLogger,
  type PinnedFfmpegResolver,
} from '@camstack/types'
import { resolvePinnedFfmpegSpawner } from '@camstack/types/node'

import { describeReplayUrl } from './clip-replay-url.js'
import {
  buildClipStreamMuxArgs,
  CLIP_STREAM_PROGRESS_FD,
  type ClipStreamAudioAsk,
  type ClipStreamProgress,
  clipStreamContentTypeFor,
  parseClipStreamProgress,
} from './clip-stream-mux.js'
import {
  type ClipDurationVerdict,
  describeTruncation,
  judgeClipDuration,
  truncationReasonCode,
} from './clip-truncation.js'
import type { ReplayLane } from './replay-lane.js'

/**
 * How long a hop may sit on a `write()` that returned `false` before the
 * stream is cut (D447). The same bound the other two providers use: two orders
 * of magnitude over any inter-fragment gap, and short enough that a peer that
 * walked away does not hold the camera's session for the length of the clip.
 */
export const CLIP_STREAM_DRAIN_TIMEOUT_MS = 10_000

/**
 * How long a spawn may produce nothing before it is refused.
 *
 * Measured first byte is 1 352 ms on an idle camera and 16 950 ms when a
 * whole-file pull was saturating the same camera, so this is a bound on a
 * hang, not a budget. Past it the run is refused BY NAME and the lane is
 * released — a spawn that produces nothing for ever would otherwise hold the
 * camera against every later ask.
 */
export const CLIP_STREAM_FIRST_BYTE_TIMEOUT_MS = 30_000

/** Why a stream did not happen. A SUBSET of the clip-export vocabulary. */
export type ClipStreamRefusalCode = 'camera-refused' | 'fetch-failed' | 'replay-busy'

export type ClipStreamOutcome =
  /**
   * The stream ran to ffmpeg's own end. **That is not the same as whole**: the
   * verdict says whether the media that arrived is the clip the row describes,
   * and it is the reason `served` stopped being a bare marker (D623).
   */
  | { readonly kind: 'served'; readonly verdict: ClipDurationVerdict }
  /** Bytes had reached the peer; the sink is already destroyed. */
  | { readonly kind: 'cut'; readonly branch: string }
  | { readonly kind: 'refused'; readonly code: ClipStreamRefusalCode; readonly detail: string }

/**
 * What a finished stream tells its peer ABOUT ITSELF, after the last byte.
 *
 * The status line is spent on the first fragment — long before anybody knows
 * whether the camera will hang up a third of the way through — so a short
 * serve has no code to come back as. HTTP trailers are the one channel that
 * is still open at that point, and this response is already chunked (no
 * `content-length` on a forward-only stream), which is what makes them legal.
 * The names are the refusal vocabulary the same route already speaks, so a
 * consumer reads one pair of names whether it was told before the body or
 * after it.
 */
export type ClipStreamTrailers = Readonly<Record<string, string>>

/** The peer, as the producer sees it. */
export interface ClipStreamSink {
  begin(contentType: string): void
  write(chunk: Buffer): boolean
  onceDrain(listener: () => void): void
  onceClose(listener: () => void): void
  /** Close the body. Trailers are ALWAYS passed — an empty object is the
   *  statement that a whole stream had nothing to add, not a caller that
   *  forgot. */
  end(trailers: ClipStreamTrailers): void
  destroy(): void
}

export interface ClipStreamRequest {
  readonly deviceId: number
  readonly clipKey: string
  /** The credentialled `/cam/playback` URL. Never logged. */
  readonly url: string
  readonly audio: ClipStreamAudioAsk
  /**
   * The catalog row's own window, `endMs − startMs`.
   *
   * **Required, and required all the way down.** The producer cannot tell a
   * truncated serve from a short recording without it, and an optional field
   * would let every future caller re-create exactly the blind spot D623 is
   * about: for one release this path knew nothing but ffmpeg's exit code, and
   * this camera exits 0 on a replay it cut. There is no second authority on
   * how long a clip is — the row is it, resolved by the service that already
   * resolves it for every other method.
   */
  readonly expectedMs: number
  readonly sink: ClipStreamSink
}

export interface ClipStreamProducerDeps {
  readonly logger: IScopedLogger
  readonly lane: ReplayLane
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  /** Seam for the spec: the real spawn otherwise. */
  readonly spawnMux?: (args: readonly string[]) => ChildProcess
  readonly drainTimeoutMs?: number
  readonly firstByteTimeoutMs?: number
  readonly now?: () => number
}

export interface ClipStreamProducer {
  run(request: ClipStreamRequest): Promise<ClipStreamOutcome>
}

/**
 * What ffmpeg's own words mean.
 *
 * Only two answers, because only two are actionable and a third would be a
 * guess: anything naming a status the camera returned, a refused RTSP method
 * or a connection it would not make is the CAMERA's; everything else is ours.
 * The whole stderr travels either way, so the classification never hides the
 * sentence it was made from.
 */
export function classifyMuxFailure(stderr: string): ClipStreamRefusalCode {
  return /404|401|403|453|455|Not Found|Unauthorized|method not supported|Connection refused|Connection timed out|Server returned/i.test(
    stderr,
  )
    ? 'camera-refused'
    : 'fetch-failed'
}

/** The sentence a `404` earns, because a `404` from this camera means three
 *  different things and only one of them is "the clip is gone". */
export function describeCameraRefusal(stderr: string): string {
  const said = stderr.trim().slice(-300)
  if (!/404|Not Found/i.test(said)) {
    return `the camera refused this replay: ${said}`
  }
  return (
    'the camera answered 404 to the replay DESCRIBE. On this firmware that one status ' +
    'covers a path it does not serve, a recording it no longer holds AND a session it has ' +
    'no budget for (8–9 concurrent were granted on this camera, varying with its live ' +
    `streams) — so it is not a claim that this clip is gone: ${said}`
  )
}

/** The progress fd, narrowed — `null` when the spawn did not open one. The
 *  same shape as the Hikvision mux's `writableStdio`, mirrored. */
export function readableStdio(stream: Readable | Writable | null | undefined): Readable | null {
  if (stream === null || stream === undefined) return null
  return 'read' in stream ? stream : null
}

/**
 * What a finished stream adds after its last byte, in the names the refusal
 * path already uses. Empty for a stream that landed whole — a consumer reads
 * the absence as "nothing to say", which is exactly what it means.
 */
export function clipStreamTrailersFor(verdict: ClipDurationVerdict): ClipStreamTrailers {
  const code = truncationReasonCode(verdict)
  const reason = describeTruncation(verdict)
  if (code === null || reason === null) return {}
  return {
    [CLIP_STILL_REASON_CODE_HEADER]: code,
    // Prose with an em dash in it is a Latin-1 fault on a header value, and a
    // trailer is a header: the same sanitiser the refusal path learnt to use
    // (D611) applies here, or `addTrailers` throws after the body is spent.
    [CLIP_STILL_REASON_HEADER]: clipReasonHeaderValue(reason),
  }
}

export function createClipStreamProducer(deps: ClipStreamProducerDeps): ClipStreamProducer {
  const now = deps.now ?? ((): number => Date.now())
  const drainTimeoutMs = deps.drainTimeoutMs ?? CLIP_STREAM_DRAIN_TIMEOUT_MS
  const firstByteTimeoutMs = deps.firstByteTimeoutMs ?? CLIP_STREAM_FIRST_BYTE_TIMEOUT_MS

  return {
    run: async (request) => {
      const tags = { deviceId: request.deviceId }
      const meta = {
        clipKey: request.clipKey,
        audio: request.audio,
        expectedMs: request.expectedMs,
      }
      // The cheap question before the replay slot: no pinned binary, no mux.
      const mux = await resolvePinnedFfmpegSpawner(deps.spawnMux, deps.resolveFfmpeg, {
        // The fourth pipe is `-progress`. Without it ffmpeg writes its
        // progress to a descriptor that does not exist and the only thing
        // this producer can say about a finished stream is the exit code —
        // which this camera sets to 0 on a replay it truncated (D623).
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      })
      if (mux.kind === 'refused') {
        deps.logger.error(
          'videoclips: clip stream refused — no pinned ffmpeg on this node (D540)',
          { tags, meta: { ...meta, detail: mux.detail } },
        )
        return { kind: 'refused', code: 'fetch-failed', detail: mux.detail }
      }
      const spawnMux = mux.spawn
      const lease = await deps.lane.acquire(request.deviceId, 'stream')
      if (lease.kind === 'busy') {
        return { kind: 'refused', code: 'replay-busy', detail: lease.detail }
      }
      if (lease.kind === 'abandoned') {
        // Unreachable today (a playback passes no signal), and named anyway
        // rather than dialled.
        return {
          kind: 'refused',
          code: 'replay-busy',
          detail: 'the playback was abandoned before this camera’s replay came free',
        }
      }

      const args = buildClipStreamMuxArgs({ url: request.url, audio: request.audio })
      const child = spawnMux(args)

      const startedAt = now()
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-4000)
      })
      // Kept whole, unlike stderr: it is ffmpeg's own key=value text, it is a
      // few hundred bytes a minute, and the LAST readable value of each key is
      // the measurement — a window that evicted the tail would throw away the
      // only number this file exists to read.
      let progressText = ''
      readableStdio(child.stdio[CLIP_STREAM_PROGRESS_FD])?.on('data', (chunk: Buffer) => {
        progressText = `${progressText}${chunk.toString()}`
      })
      /** Read ONCE, where the stream ends, and read by the log line too. */
      let measured: ClipStreamProgress | null = null
      /** ffmpeg's own exit code. Kept beside the verdict rather than standing
       *  in for it: on this camera a truncated replay exits 0 (D623). */
      let muxExit: number | null = null

      let answered = false
      let began = false
      let bytesOut = 0
      let firstByteAtMs: number | null = null
      let drainTimer: ReturnType<typeof setTimeout> | null = null
      let released = false
      const releaseLane = (): void => {
        if (released) return
        released = true
        lease.release()
      }

      return await new Promise<ClipStreamOutcome>((resolve) => {
        const settle = (outcome: ClipStreamOutcome, branch: string): void => {
          if (answered) return
          answered = true
          if (drainTimer !== null) clearTimeout(drainTimer)
          drainTimer = null
          clearTimeout(firstByteTimer)
          if (!child.killed && child.exitCode === null) child.kill('SIGKILL')
          releaseLane()
          const elapsedMs = now() - startedAt
          if (outcome.kind === 'served') {
            const verdict = outcome.verdict
            const served = {
              tags,
              meta: {
                ...meta,
                branch,
                bytesOut,
                elapsedMs,
                firstByteMs: firstByteAtMs === null ? null : firstByteAtMs - startedAt,
                deliveredSeconds:
                  verdict.kind === 'complete' || verdict.kind === 'short'
                    ? verdict.deliveredSeconds
                    : null,
                frames: measured?.frames ?? null,
                muxExit,
                url: describeReplayUrl(request.url),
              },
            }
            // The same three sentences the sibling providers already speak,
            // so a fleet-wide grep for a truncated replay finds all three
            // vendors. Reolink's spelling is the one copied (D623).
            if (verdict.kind === 'short') {
              deps.logger.warn('videoclips: a clip stream came up short against its row', {
                tags: served.tags,
                meta: {
                  ...served.meta,
                  shortfallSeconds: verdict.shortfallSeconds,
                  retried: false,
                },
              })
            } else if (verdict.kind === 'empty') {
              // NOT a 100 % shortfall. The camera granted the session and sent
              // no picture down it: that is diagnosed at the camera, and it
              // must never wear the branch a dropped session wears (D391).
              deps.logger.warn('videoclips: a clip stream carried no media at all', served)
            } else if (verdict.kind === 'unknown') {
              deps.logger.warn('videoclips: a clip stream could not be checked for truncation', {
                tags: served.tags,
                meta: { ...served.meta, reason: verdict.reason },
              })
            } else {
              deps.logger.info('videoclips: a clip stream was served', served)
            }
          } else {
            // A branch that produced nothing says so, whether it refused or
            // accepted and then stopped (D391).
            deps.logger.warn('videoclips: a clip stream did not complete', {
              tags,
              meta: {
                ...meta,
                branch,
                code: outcome.kind === 'refused' ? outcome.code : 'cut',
                bytesOut,
                elapsedMs,
                firstByteMs: firstByteAtMs === null ? null : firstByteAtMs - startedAt,
                url: describeReplayUrl(request.url),
                stderr: stderr.trim().slice(-300),
              },
            })
          }
          resolve(outcome)
        }

        const firstByteTimer = setTimeout(() => {
          settle(
            {
              kind: 'refused',
              code: 'camera-refused',
              detail:
                `the camera produced no media for this clip within ${String(firstByteTimeoutMs)} ms: ` +
                (stderr.trim().slice(-200) || 'ffmpeg said nothing'),
            },
            'no-first-byte',
          )
        }, firstByteTimeoutMs)

        request.sink.onceClose(() => {
          if (!began) {
            settle({ kind: 'refused', code: 'fetch-failed', detail: 'the peer left' }, 'peer-left')
            return
          }
          settle({ kind: 'cut', branch: 'peer-closed' }, 'peer-closed')
        })

        child.stdout?.on('data', (chunk: Buffer) => {
          if (answered) return
          if (!began) {
            began = true
            firstByteAtMs = now()
            clearTimeout(firstByteTimer)
            request.sink.begin(
              clipStreamContentTypeFor(request.audio === 'none' ? null : request.audio),
            )
          }
          bytesOut += chunk.byteLength
          // A raw HTTP stream reads no chunk the socket has not taken (D447):
          // honour `write()`'s return, await `drain`, cut the peer that never
          // drains, log every exit.
          if (request.sink.write(chunk)) return
          child.stdout?.pause()
          if (drainTimer !== null) return
          drainTimer = setTimeout(() => {
            drainTimer = null
            settle({ kind: 'cut', branch: 'peer-stalled' }, 'peer-stalled')
          }, drainTimeoutMs)
          request.sink.onceDrain(() => {
            if (drainTimer !== null) clearTimeout(drainTimer)
            drainTimer = null
            child.stdout?.resume()
          })
        })

        child.on('error', (err) => {
          settle(
            {
              kind: 'refused',
              code: 'fetch-failed',
              detail: `the mux could not be started: ${err.message}`,
            },
            'spawn-failed',
          )
        })

        child.on('close', (code) => {
          if (answered) return
          muxExit = code
          if (began) {
            // THE fix. `code === 0` is what this camera returns after hanging
            // up a third of the way through a clip, so the exit code decides
            // nothing about completeness any more: the MEASUREMENT does, and
            // the exit code travels beside it as `muxExit` (D623).
            measured = parseClipStreamProgress(progressText)
            const verdict = judgeClipDuration({
              expectedMs: request.expectedMs,
              deliveredSeconds: measured.deliveredSeconds,
              frames: measured.frames,
            })
            // Trailers BEFORE `end()`, because `end()` sends them: a peer that
            // has half a clip learns so on the same response that carried it.
            request.sink.end(clipStreamTrailersFor(verdict))
            settle({ kind: 'served', verdict }, truncationReasonCode(verdict) ?? 'stream-served')
            return
          }
          // Accepted the work and produced nothing. Named, with the camera's
          // own words, and never an empty 200.
          const refusal = classifyMuxFailure(stderr)
          settle(
            {
              kind: 'refused',
              code: refusal,
              detail:
                refusal === 'camera-refused'
                  ? describeCameraRefusal(stderr)
                  : `the mux exited ${String(code)} before any media: ${stderr.trim().slice(-300)}`,
            },
            'no-media',
          )
        })
      })
    },
  }
}
