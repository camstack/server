/**
 * FfmpegPushReader — shared ffmpeg → MPEG-TS → push ingress core.
 *
 * Spawns `ffmpeg ... -f mpegts pipe:1` (argv supplied by the caller) and
 * demuxes ffmpeg's MPEG-TS stdout back into per-access-unit `EncodedPacket`s
 * via {@link MpegTsDemux}, handing them straight to the broker's push ingress.
 * The class is agnostic to WHY ffmpeg is spawned: the two concrete readers
 * differ only in the argv they pass in —
 *   - {@link FfmpegSourceReader} (`rtsp/ffmpeg-source-reader.ts`) passes
 *     `-c copy` normalization args to re-mux a camera source without
 *     re-encoding, and
 *   - `DerivedStreamFeeder` (`derived/derived-stream-feeder.ts`) passes
 *     transcode args to produce a derived (re-encoded) profile.
 * Everything downstream of the argv — spawn, demux, audio-init, teardown,
 * kill discipline — is identical, so it lives here once.
 *
 * Callback contract mirrors `RtmpReader` EXACTLY so the broker can wire this
 * with the same `startRtmpReader`-style code: `connect()` / `destroy()`, media
 * out via `onEncodedPacket`, audio init via `onAudioInfo`, terminal failures via
 * `onError`, and a single `onTeardown` after the child exits. The reader does
 * NOT own the broker's reconnect/backoff loop — the broker re-instantiates a
 * fresh reader on reconnect.
 *
 * Audio: MPEG-TS AAC produced by ffmpeg is ADTS-framed, so the first audio
 * packet's 7-byte ADTS header carries the sample rate + channel config the
 * broker needs (see {@link parseAdtsAudioParams}). Non-AAC audio (ac3 / mp2) is
 * emitted best-effort with a zeroed rate/channels — AAC is the target.
 */

import {
  defaultFfmpegSpawn,
  type FfmpegSpawnFn,
  type SpawnedFfmpegProcess,
} from '@camstack/types/node'
import type { EncodedPacket, IScopedLogger, PushAudioInfo } from '@camstack/types'
import { NO_COST_CLAIM, type ChildCostClaimHandle } from '@camstack/types/node'
import { MpegTsDemux } from './mpegts-demux.js'

export interface FfmpegPushReaderCallbacks {
  /** Called when the video codec is first identified from the PMT. */
  onVideoCodec?: (codec: string) => void
  /** Called for every demuxed access unit (video) / audio PES. */
  onEncodedPacket: (packet: EncodedPacket) => void
  /** Called once, before the first audio packet is forwarded. */
  onAudioInfo: (info: PushAudioInfo) => void
  /** Called the first time real media is forwarded. */
  onPlaying?: () => void
  /** Called on any terminal failure (child exit / spawn error). */
  onError?: (error: Error) => void
  /** Called exactly once after the child exits or `destroy()` runs. */
  onTeardown?: () => void
}

export interface FfmpegPushReaderOptions {
  readonly ffmpegPath: string
  /** ffmpeg argv (the ONLY difference between the two concrete readers). */
  readonly args: string[]
  readonly logger?: IScopedLogger
  /** Injectable spawn for tests. Defaults to `node:child_process`'s `spawn`. */
  readonly spawnFn?: FfmpegSpawnFn
  /**
   * Claim this ingest's ffmpeg as the broker addon's cost, for THIS camera.
   *
   * This reader is one camera's source pull — the broker instantiates a fresh
   * one per reconnect — so the child it spawns is exactly one camera's cost.
   * The claim is taken at `connect()` and released once the child is gone, on
   * every terminal path (`exit`, `error`, `destroy`), which is why the release
   * hangs off {@link FfmpegPushReader.done} rather than off one listener.
   *
   * Optional: an unclaimed ffmpeg is still counted by the node's process
   * snapshot, in the unattributed bucket.
   */
  readonly claimCost?: (pid: number | undefined) => ChildCostClaimHandle
}

/** ADTS `sampling_frequency_index` → sample rate in Hz. Index 13–15 reserved. */
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
] as const

/** AAC-LC AudioObjectType for the 2-byte AudioSpecificConfig. */
const AAC_LC_OBJECT_TYPE = 2

/** Cap on retained stderr text used to annotate the terminal error message. */
const MAX_STDERR_TAIL = 4 * 1024

/** Grace before escalating SIGTERM → SIGKILL on a lingering child. */
const KILL_GRACE_MS = 500

export interface AdtsAudioParams {
  readonly sampleRate: number
  readonly channels: number
  /** 2-byte AAC AudioSpecificConfig (objectType=AAC-LC). */
  readonly extraData: Uint8Array
}

/**
 * Parse the 7-byte ADTS header of an AAC frame into the audio-init params the
 * broker's push ingress needs. Returns `null` when the buffer is too short or
 * lacks the ADTS syncword (0xFFFx) or carries a reserved sample-rate index.
 */
export function parseAdtsAudioParams(frame: Buffer): AdtsAudioParams | null {
  if (frame.length < 7) return null
  const b0 = frame[0]!
  const b1 = frame[1]!
  const b2 = frame[2]!
  const b3 = frame[3]!
  // Syncword: 0xFFF in the top 12 bits (byte0 = 0xFF, byte1 top nibble = 0xF).
  if (b0 !== 0xff || (b1 & 0xf0) !== 0xf0) return null

  const freqIdx = (b2 & 0x3c) >> 2
  if (freqIdx >= ADTS_SAMPLE_RATES.length) return null
  const sampleRate = ADTS_SAMPLE_RATES[freqIdx]!

  // channel_configuration spans the low bit of byte2 and the top two of byte3.
  const channelConfig = ((b2 & 0x01) << 2) | ((b3 & 0xc0) >> 6)
  const channels = channelConfig === 0 ? 1 : channelConfig

  // AudioSpecificConfig: objectType(5) | freqIdx(4) | channelConfig(4) | 000.
  const asc = (AAC_LC_OBJECT_TYPE << 11) | (freqIdx << 7) | (channelConfig << 3)
  const extraData = new Uint8Array([(asc >> 8) & 0xff, asc & 0xff])

  return { sampleRate, channels, extraData }
}

/**
 * Shared spawn → demux → push core for the ffmpeg-backed broker ingresses.
 * Concrete readers subclass this and pass a `logLabel` used to annotate log
 * lines and the terminal error message.
 */
export class FfmpegPushReader {
  private readonly ffmpegPath: string
  private readonly args: string[]
  private readonly logger: IScopedLogger | undefined
  private readonly spawnFn: FfmpegSpawnFn
  private readonly callbacks: FfmpegPushReaderCallbacks
  private readonly logLabel: string
  private readonly claimCost: ((pid: number | undefined) => ChildCostClaimHandle) | undefined
  /** The claim for the child currently running, if any. */
  private costClaim: ChildCostClaimHandle = NO_COST_CLAIM

  private child: SpawnedFfmpegProcess | null = null
  private demux: MpegTsDemux | null = null

  private audioCodec: string | undefined
  private audioInfoEmitted = false
  private firstMediaSeen = false
  private stderrTail = ''

  /** Set once the reader has terminated (exit / error / destroy). */
  private done = false
  /** Guards a single `onTeardown` firing. */
  private toreDown = false

  constructor(
    options: FfmpegPushReaderOptions,
    callbacks: FfmpegPushReaderCallbacks,
    logLabel: string,
  ) {
    this.ffmpegPath = options.ffmpegPath
    this.args = options.args
    this.logger = options.logger
    this.spawnFn = options.spawnFn ?? defaultFfmpegSpawn
    this.callbacks = callbacks
    this.logLabel = logLabel
    this.claimCost = options.claimCost
  }

  /** Spawn ffmpeg and pipe its MPEG-TS stdout into the demux. */
  connect(): void {
    if (this.done) return

    const demux = new MpegTsDemux({
      onPacket: (packet) => this.handlePacket(packet),
      onCodecs: (info) => {
        if (info.audio !== undefined) this.audioCodec = info.audio
        if (info.video !== undefined) this.callbacks.onVideoCodec?.(info.video)
      },
      logger: this.logger,
    })
    this.demux = demux

    let child: SpawnedFfmpegProcess
    try {
      child = this.spawnFn(this.ffmpegPath, this.args)
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)))
      return
    }
    this.child = child
    // Claim the generation. `connect()` is the only place a child is created,
    // so it is the only place a claim is taken.
    this.costClaim = this.claimCost?.(child.pid) ?? NO_COST_CLAIM

    child.stdin?.on('error', () => {
      // EPIPE when the child exits before we finish writing — swallow.
    })
    child.stdout?.on('data', (chunk: Buffer) => demux.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.appendStderr(chunk))
    child.on('error', (err: Error) => this.fail(err))
    child.on('exit', (code, signal) => this.handleExit(code, signal))
  }

  /** Kill the child, flush + reset the demux, and fire `onTeardown` once. */
  destroy(): void {
    if (this.done) {
      this.fireTeardown()
      return
    }
    this.done = true
    this.killChild()
    this.demux?.reset()
    this.demux = null
    this.fireTeardown()
  }

  private handlePacket(packet: EncodedPacket): void {
    if (packet.type === 'audio') {
      if (!this.audioInfoEmitted) {
        this.audioInfoEmitted = true
        this.emitAudioInfo(packet.data)
      }
      this.callbacks.onEncodedPacket(packet)
      this.markPlaying()
      return
    }
    this.callbacks.onEncodedPacket(packet)
    this.markPlaying()
  }

  private emitAudioInfo(firstFrame: Buffer): void {
    const codec = this.audioCodec ?? 'aac'
    if (codec !== 'aac') {
      this.logger?.warn(`${this.logLabel}: non-AAC audio — emitting best-effort info`, {
        meta: { codec },
      })
      this.callbacks.onAudioInfo({ codec, sampleRate: 0, channels: 0 })
      return
    }

    const parsed = parseAdtsAudioParams(firstFrame)
    if (parsed === null) {
      this.logger?.warn(`${this.logLabel}: AAC audio not ADTS-framed — emitting zeroed info`, {
        meta: { firstBytes: firstFrame.subarray(0, 4).toString('hex') },
      })
      this.callbacks.onAudioInfo({ codec: 'aac', sampleRate: 0, channels: 0 })
      return
    }

    this.callbacks.onAudioInfo({
      codec: 'aac',
      sampleRate: parsed.sampleRate,
      channels: parsed.channels,
      extraData: parsed.extraData,
    })
    this.logger?.info(`${this.logLabel}: AAC audio`, {
      meta: { sampleRate: parsed.sampleRate, channels: parsed.channels },
    })
  }

  private markPlaying(): void {
    if (this.firstMediaSeen) return
    this.firstMediaSeen = true
    this.callbacks.onPlaying?.()
  }

  private appendStderr(chunk: Buffer): void {
    this.stderrTail = (this.stderrTail + chunk.toString()).slice(-MAX_STDERR_TAIL)
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.done) return
    this.done = true
    this.demux?.flush()
    const tail = this.stderrTail.trim()
    const message = `${this.logLabel} exited (code=${code ?? 'null'}, signal=${
      signal ?? 'null'
    })${tail ? `: ${tail}` : ''}`
    this.callbacks.onError?.(new Error(message))
    this.fireTeardown()
  }

  private fail(error: Error): void {
    if (this.done) return
    this.done = true
    this.demux?.flush()
    this.killChild()
    const tail = this.stderrTail.trim()
    const message = tail ? `${error.message}: ${tail}` : error.message
    this.callbacks.onError?.(new Error(message))
    this.fireTeardown()
  }

  private fireTeardown(): void {
    if (this.toreDown) return
    this.toreDown = true
    // Released here and not in a listener: `fireTeardown` is on every terminal
    // path this class has — `handleExit` (the child died on its own, so
    // `killChild` never runs), `fail`, and `destroy` — and it is guarded to
    // run once. One release covers all three and none of them can forget.
    this.costClaim.release()
    this.costClaim = NO_COST_CLAIM
    this.callbacks.onTeardown?.()
  }

  /** SIGTERM, then SIGKILL if the child has not actually exited (gate on exit
   *  codes being null, NOT on `child.killed` which Node flips after any kill). */
  private killChild(): void {
    const child = this.child
    if (child === null) return
    this.child = null
    try {
      child.stdin?.end()
    } catch {
      // already closed
    }
    try {
      child.kill('SIGTERM')
    } catch {
      // already dead
    }
    const pid = child.pid
    setTimeout(() => {
      if (pid !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // already dead
        }
      }
    }, KILL_GRACE_MS).unref?.()
  }
}
