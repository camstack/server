/**
 * Clip bytes: cmd 5 into a bounded scratch, then ONE bounded ffmpeg to MP4.
 *
 * ## Why not the broker, and why not RTMP
 *
 * The broker owns LIVE sessions; a stored file has none, and inventing one to
 * play yesterday's clip would hold a camera open for a file that is already on
 * a disk. RTMP is refused for two separate reasons: `getVodRtmpUrl` puts the
 * credentials in the query string, and asking for the URL ENABLES the RTMP
 * port on the camera as a side effect (D549 6).
 *
 * ## Why a retry loop at all
 *
 * Nothing on the wire marks the end of a cmd 5 download — no 201, no trailing
 * frame, no size that matches `sizeL` — so completion is an idle window, and a
 * transfer that ends early looks exactly like a short clip. The gate is
 * therefore "did bytes LAND", never "did the call return"; it retries under a
 * bound and names the last refusal when it gives up (D58).
 *
 * ## What the mux carries, and the two numbers it must not trust
 *
 * Since `@apocaliss92/nodelink-js@0.7.10` the demuxer returns the audio the
 * cmd 5 download has always carried, so this mux has a second input and the
 * clip has sound (D567). Two things on the wire LIE and are deliberately not
 * read here:
 *
 * - **the declared frame rate.** `InfoV1`/`InfoV2` carries the file's nominal
 *   rate and it is not the delivered one — a Home Hub child declares 30 and
 *   delivers 15.019 (661 access units over 43.943 s of timestamps). Muxing at
 *   the declared rate makes the video half as long as its own audio.
 *   `stats.fps` is the MEASURED rate and is what `-r` gets.
 * - **the BcMedia header's codec field.** It says H264 on every packet of a
 *   hub child whose payload is H.265. `videoType` is detected from the NALs
 *   and is what names the demuxer.
 *
 * `-movflags +faststart` is not decoration: it puts `moov` first, so the
 * player knows the duration before the bytes arrive and seeking works over
 * the Range route natively (D549 22).
 */
import type { spawn as nodeSpawn } from 'node:child_process'
import type { PinnedFfmpegResolver } from '@camstack/types'
import { NO_PINNED_FFMPEG_DETAIL } from '@camstack/types/node'

/** A clip that has not transferred by here is not going to. */
export const CLIP_MUX_TIMEOUT_MS = 60_000

/** Bound on the cmd 5 retry loop. A clip is a file; three honest attempts
 *  separate a flaky socket from a camera that will not serve it. */
export const CLIP_FETCH_MAX_ATTEMPTS = 3

/** First backoff between attempts; doubles. Small, because the one session is
 *  shared with every other read and a long sleep holds a lane. */
export const CLIP_FETCH_BACKOFF_MS = 500

export type ClipVideoType = 'H264' | 'H265' | null

/** The library's `RecordingAudioCodec`. */
export type ClipAudioCodec = 'Aac' | 'Adpcm'

/**
 * How the track's bytes are laid out — the library's `RecordingAudioFormat`.
 *
 * Only `adts` may be stream-copied. `adpcm` carries no sample rate or channel
 * count on the wire and would need a transcode; `unknown` means audio packets
 * arrived whose first one has no readable ADTS header. Neither exists on this
 * fleet, so neither gets a path nobody can test.
 */
export type ClipAudioFormat = 'adts' | 'adpcm' | 'unknown'

/** The library's `RecordingAudioTrack`, narrowed to what this file reads. */
export interface ClipAudioTrack {
  readonly codec: ClipAudioCodec
  readonly format: ClipAudioFormat
  /** The concatenated frames, exactly as the camera sent them. */
  readonly data: Buffer
  readonly frames: number
  readonly bytes: number
  readonly sampleRate: number | null
  readonly channels: number | null
  readonly durationSeconds: number | null
}

/**
 * Why a clip is served silent. Never a bare "no audio": an absent track and a
 * track we refuse to copy are different answers to the operator.
 */
export type ClipSilentReason = 'no-audio-track' | 'audio-not-copyable'

export type ClipAudioDecision =
  /** Carries the bytes so the caller cannot re-derive the gate and get it
   *  wrong: there is no shape here that says "copy" and leaves the track to
   *  be fetched again from a nullable field. */
  | { readonly kind: 'copy'; readonly format: 'adts'; readonly data: Buffer }
  | {
      readonly kind: 'silent'
      readonly reason: ClipSilentReason
      readonly format: ClipAudioFormat | null
    }

/**
 * Decide what to do with the track the download returned.
 *
 * The gate is `format === 'adts'` and NOT `audio !== null`: an `adpcm` or
 * `unknown` track stream-copied into MP4 produces a file whose audio track is
 * garbage, which is worse than a clip that is honestly silent. A track that
 * arrived with no frames is no track — counting it would promise sound the
 * file does not have.
 */
export function decideClipAudio(audio: ClipAudioTrack | null): ClipAudioDecision {
  if (audio === null) return { kind: 'silent', reason: 'no-audio-track', format: null }
  if (audio.frames === 0 || audio.bytes === 0) {
    return { kind: 'silent', reason: 'no-audio-track', format: audio.format }
  }
  if (audio.format !== 'adts') {
    return { kind: 'silent', reason: 'audio-not-copyable', format: audio.format }
  }
  return { kind: 'copy', format: 'adts', data: audio.data }
}

/**
 * A track this mux is willing to copy.
 *
 * The `format` is narrowed to the one literal on purpose: a caller holding an
 * `adpcm` path cannot type this, so the guard cannot be forgotten at the call
 * site the way a boolean flag would let it be.
 */
export interface CopyableClipAudio {
  readonly path: string
  readonly format: 'adts'
}

export interface ClipMuxArgsInput {
  /** The Annex-B elementary stream on disk. */
  readonly inputPath: string
  readonly outputPath: string
  readonly videoType?: ClipVideoType
  /**
   * The DELIVERED frame rate (`stats.fps`), never the declared one. `null`,
   * zero or a non-finite value means nothing on the wire measured a rate, and
   * `-r` is then omitted rather than filled in from the info header.
   */
  readonly fps?: number | null
  readonly audio?: CopyableClipAudio
}

function usableFps(fps: number | null | undefined): number | null {
  if (fps === null || fps === undefined) return null
  return Number.isFinite(fps) && fps > 0 ? fps : null
}

export function buildClipMuxArgs(input: ClipMuxArgsInput): readonly string[] {
  const demuxer = input.videoType === 'H265' ? 'hevc' : 'h264'
  const fps = usableFps(input.fps)
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    // INPUT options, strictly before their own `-i`. A headerless elementary
    // stream states neither its codec nor its rate, so we do both.
    ...(fps !== null ? ['-r', String(fps)] : []),
    '-f',
    demuxer,
    '-i',
    input.inputPath,
    // The second input: self-delimiting ADTS frames, declared as such.
    ...(input.audio !== undefined ? ['-f', 'aac', '-i', input.audio.path] : []),
    // OUTPUT options. Copy: the camera already encoded this, and re-encoding a
    // stored clip would cost a CPU minute per open for no visible gain.
    '-c:v',
    'copy',
    ...(input.audio !== undefined ? ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc'] : []),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    input.outputPath,
  ]
}

/** `DownloadRecordingDemuxedStats`, narrowed to what the mux reads. */
export interface ClipDownloadStats {
  readonly keyframes: number
  /** The MEASURED rate, or `null` when nothing on the wire said. */
  readonly fps: number | null
  /** Where {@link fps} came from, so a guess never looks like a measurement. */
  readonly fpsSource: 'timestamps' | 'infoFps' | 'unknown'
  /** The info header's nominal rate, which is NOT the delivered one. */
  readonly infoFps: number | null
  readonly durationSeconds: number | null
  readonly audioPackets: number
  readonly audioBytes: number
}

export interface ClipDownloadResult {
  readonly annexB: Buffer
  readonly videoType: ClipVideoType
  readonly audio: ClipAudioTrack | null
  readonly stats: ClipDownloadStats
}

export interface FetchClipBytesInput {
  download(): Promise<ClipDownloadResult>
  sleep(ms: number): Promise<void>
  readonly maxAttempts?: number
}

/**
 * Fetch until it LANDS, under a bound.
 *
 * An empty answer counts as a failed attempt: a zero-byte "clip" muxes into an
 * MP4 the player shows as broken, and "the call returned" is not evidence that
 * media arrived.
 */
export async function fetchClipBytes(input: FetchClipBytesInput): Promise<ClipDownloadResult> {
  const attempts = input.maxAttempts ?? CLIP_FETCH_MAX_ATTEMPTS
  let lastError: Error | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await input.sleep(CLIP_FETCH_BACKOFF_MS * 2 ** (attempt - 1))
    try {
      const result = await input.download()
      if (result.annexB.byteLength > 0) return result
      lastError = new Error('the camera answered the download with zero bytes')
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))
    }
  }
  throw new Error(
    `videoclips: clip bytes never landed after ${attempts} attempts — ${lastError?.message ?? 'no reason given'}`,
  )
}

export interface ClipMuxRun {
  readonly code: number | null
  readonly timedOut: boolean
  readonly spawnFailed: boolean
  readonly stderr: string
}

export type ClipMuxRunner = (args: readonly string[]) => Promise<ClipMuxRun>

export interface FfmpegClipMuxRunnerInput {
  /** The node's pinned ffmpeg (D540), asked per run so a later successful
   *  resolution is picked up. A rejection is `spawnFailed` — never PATH. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly spawnFn: typeof nodeSpawn
  readonly timeoutMs?: number
}

/**
 * The production runner: one bounded ffmpeg, killed at the deadline.
 *
 * Bounded and KILLED, not merely awaited — an ffmpeg that never exits on a
 * stream it cannot parse would otherwise hold a process per clip on a hub that
 * already runs a permanent prebuffer per recorded camera.
 */
export function createFfmpegClipMuxRunner(input: FfmpegClipMuxRunnerInput): ClipMuxRunner {
  const timeoutMs = input.timeoutMs ?? CLIP_MUX_TIMEOUT_MS
  return async (args) => {
    let ffmpegBinaryPath: string
    try {
      ffmpegBinaryPath = await input.resolveFfmpeg()
    } catch (err: unknown) {
      // `spawnFailed` is the callers' `ffmpeg-missing`: a named refusal, and no
      // child at all — in particular not a PATH `ffmpeg` (D540).
      return {
        code: null,
        timedOut: false,
        spawnFailed: true,
        stderr: `${NO_PINNED_FFMPEG_DETAIL}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    return await new Promise<ClipMuxRun>((resolve) => {
      let settled = false
      const finish = (run: ClipMuxRun): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(run)
      }
      const child = input.spawnFn(ffmpegBinaryPath, [...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 2_000) stderr += chunk.toString('utf8')
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ code: null, timedOut: true, spawnFailed: false, stderr })
      }, timeoutMs)
      timer.unref?.()
      child.on('error', (err: Error) => {
        finish({ code: null, timedOut: false, spawnFailed: true, stderr: err.message })
      })
      child.on('close', (code) => {
        finish({ code, timedOut: false, spawnFailed: false, stderr })
      })
    })
  }
}

/** Turn a runner outcome into a named refusal, never a bare "failed". */
export function describeMuxFailure(run: ClipMuxRun): string | null {
  if (run.spawnFailed) return `ffmpeg-missing: ${run.stderr}`
  if (run.timedOut) return `mux-timed-out after ${CLIP_MUX_TIMEOUT_MS} ms`
  if (run.code !== 0) return `mux-failed (exit ${String(run.code)}): ${run.stderr.slice(0, 300)}`
  return null
}
