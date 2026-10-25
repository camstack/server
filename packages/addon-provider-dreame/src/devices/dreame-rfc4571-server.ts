/**
 * RFC 4571 (framed RTP over TCP) output for the robot camera — the shape
 * already proven on this robot: nodedreame's `DreameCameraStream` speaks the
 * LinkVisual relay
 * and emits H.264 access units + AAC (ADTS); nodelink's `Rfc4571Muxer` frames
 * them as RTP on a local TCP server the stream-broker dials as a
 * `pull-rfc4571` source, exactly like a Reolink Baichuan camera.
 *
 * Why this and not the relay url in the catalog: the relay is RTMP only in
 * name, and WE own the TCP socket — when the broker's reader detaches we know
 * the viewer is gone and release the monitor at once, instead of polling the
 * broker for consumers or waiting on a duration cap.
 *
 * And we own the FEED: the relay dies in three ways nodedreame reports and one
 * it cannot — the socket errors (`error`; with no listener an EventEmitter
 * throws, and on 2026-09-09 a `read ETIMEDOUT` took the whole provider down),
 * the relay closes and the stream stops itself (`stopped`), or the socket goes
 * silent for minutes before the kernel gives up (nothing at all: 16 min of a
 * broker dialling a port that accepted and sent nothing). The server reports
 * every one of them ONCE through `onFeedLost`, and never its own close, so the
 * device can put the lazy sentinel back and let the next dial be a wake (D424).
 */
import { Console } from 'node:console'
import net from 'node:net'
import { Writable } from 'node:stream'
import type { DreameCameraStreamEvents } from '@apocaliss92/nodedreame'
import {
  buildRfc4571Sdp,
  extractH264ParamSetsFromAccessUnit,
  parseAdtsHeader,
  Rfc4571Muxer,
} from '@apocaliss92/nodelink-js'
import type { IScopedLogger } from '@camstack/types'

const VIDEO_PT = 96
const AUDIO_PT = 97
/**
 * How long the feed may go without a video access unit before the relay is
 * declared dead. The broker gives a source 8 s (`RTP_ACTIVITY_TIMEOUT_MS`);
 * this sits just past it so a stall is judged by the side that can act on it.
 */
export const FEED_STALL_MS = 10_000
const FEED_STALL_SWEEP_MS = 1_000

export interface RobotVideoAccessUnit {
  readonly data: Buffer
  readonly isKeyframe: boolean
  readonly microseconds: number
}

/** Why the feed is gone: the relay socket errored, the stream stopped itself, or frames stopped coming. */
export type FeedLossReason = 'error' | 'stopped' | 'stalled'

export interface FeedLoss {
  readonly reason: FeedLossReason
  /** The socket's error for `error`; null otherwise. */
  readonly error: Error | null
}

/** What the server needs from `DreameCameraStream` — or a fake in a test. */
export interface RobotFrameFeed {
  on<K extends 'videoAccessUnit' | 'audioFrame' | 'error' | 'stopped'>(
    event: K,
    listener: (...args: DreameCameraStreamEvents[K]) => void,
  ): unknown
  /** Cold-start the monitor and connect to the relay; frames follow. */
  start(): Promise<unknown>
  /** Close the relay and release the monitor. */
  stop(): Promise<void>
}

export interface RfcServerInfo {
  readonly host: string
  readonly port: number
  readonly sdp: string
  readonly audio: {
    readonly codec: 'aac'
    readonly sampleRate: number
    readonly channels: number
  } | null
  /** Stop the muxer + TCP server (does NOT stop the feed; the caller owns that). */
  readonly close: () => Promise<void>
}

export interface StartRfcServerParams {
  /** A not-yet-started feed — this function starts it. */
  readonly stream: RobotFrameFeed
  readonly logger: IScopedLogger
  /** Called once when the LAST consumer disconnects (after a short grace). */
  readonly onConsumerDisconnect: () => void
  /**
   * Called ONCE when the feed is gone while the server is up — never for the
   * caller's own `close()`. A loss before the server is up fails the open.
   */
  readonly onFeedLost: (loss: FeedLoss) => void
  /** Address to bind; the advertised host is the caller's business. */
  readonly bindHost?: string
  /** Max wait for the first keyframe before failing. Default 20 s (cold wake). */
  readonly keyframeTimeoutMs?: number
  /** Extra wait for the first audio frame after the keyframe. Default 1.5 s. */
  readonly audioGraceMs?: number
  /** Grace after the last consumer leaves before tearing down (reader reconnects). Default 4 s. */
  readonly idleGraceMs?: number
  /** Silence (no video access unit) that declares the relay dead. Default {@link FEED_STALL_MS}. */
  readonly stallTimeoutMs?: number
}

function describeLoss(loss: FeedLoss): string {
  return loss.error === null ? loss.reason : `${loss.reason}: ${loss.error.message}`
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(message)), ms)
      t.unref?.()
    }),
  ])
}

/** nodelink's muxer wants a `Console`; give it one whose lines land in the scoped logger. */
function consoleInto(logger: IScopedLogger): Console {
  const sink = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const line = chunk.toString().trim()
      if (line.length > 0) logger.debug(line)
      callback()
    },
  })
  return new Console({ stdout: sink, stderr: sink })
}

interface AudioFacts {
  readonly sampleRate: number
  readonly channels: number
  readonly configHex: string
}

/**
 * Start the feed, wait for the first keyframe (and, briefly, audio), build the
 * SDP, mux frames into an RFC 4571 TCP server and return its address. The
 * server calls `onConsumerDisconnect` when the last reader detaches.
 */
export async function startRfc4571Server(params: StartRfcServerParams): Promise<RfcServerInfo> {
  const {
    stream,
    logger,
    onConsumerDisconnect,
    onFeedLost,
    bindHost = '0.0.0.0',
    keyframeTimeoutMs = 20_000,
    audioGraceMs = 1_500,
    idleGraceMs = 4_000,
    stallTimeoutMs = FEED_STALL_MS,
  } = params
  const videoRef: { current: { sps: Buffer; pps: Buffer; profileLevelId?: string } | null } = {
    current: null,
  }
  const audioRef: { current: AudioFacts | null } = { current: null }
  const firstKeyframe = deferred<void>()
  const firstAudio = deferred<void>()
  // The feed's death, observed from the first listener on: before the server
  // is up it fails the open, after it is up it is reported once. `toreDown`
  // is ours — the `stopped` our own `stop()` raises is not a loss.
  const firstLoss = deferred<FeedLoss>()
  let pendingLoss: FeedLoss | null = null
  let toreDown = false
  // Flow counters. Knowing the FIRST audio frame arrived says nothing about
  // the session: a stream that emits one frame and stops is indistinguishable
  // in the log from one that plays for ten minutes (D427).
  let audioFrames = 0
  let videoAccessUnits = 0
  let lastAudioAt = 0
  let audioStallReported = false
  let serving = false
  let lastVideoAt = 0
  const reportLoss = (loss: FeedLoss): void => {
    if (toreDown || pendingLoss !== null) return
    pendingLoss = loss
    firstLoss.resolve(loss)
    if (serving) onFeedLost(loss)
  }
  stream.on('error', (err) => reportLoss({ reason: 'error', error: err }))
  stream.on('stopped', () => reportLoss({ reason: 'stopped', error: null }))
  stream.on('videoAccessUnit', () => {
    lastVideoAt = Date.now()
  })
  stream.on('videoAccessUnit', (e) => {
    if (videoRef.current !== null) return
    const p = extractH264ParamSetsFromAccessUnit(e.data)
    if (p.sps && p.pps) {
      videoRef.current = {
        sps: p.sps,
        pps: p.pps,
        ...(p.profileLevelId ? { profileLevelId: p.profileLevelId } : {}),
      }
      firstKeyframe.resolve()
    }
  })
  stream.on('audioFrame', (adts) => {
    if (audioRef.current !== null) return
    const parsed = parseAdtsHeader(adts)
    if (parsed) {
      audioRef.current = {
        sampleRate: parsed.sampleRate,
        channels: parsed.channels,
        configHex: parsed.configHex,
      }
      firstAudio.resolve()
    }
  })
  await stream.start()
  const lostBeforeServing = firstLoss.promise.then((loss) => {
    throw new Error(`relay lost before the first keyframe (${describeLoss(loss)})`)
  })
  try {
    await Promise.race([
      withTimeout(
        firstKeyframe.promise,
        keyframeTimeoutMs,
        'timed out waiting for the first keyframe',
      ),
      lostBeforeServing,
    ])
  } catch (err) {
    await stream.stop().catch(() => undefined)
    throw err
  }
  // Best-effort: a short grace for audio; video-only if none arrives. The
  // OUTCOME is always reported — a session that goes mute used to do so in
  // total silence, and twelve hours of hub logs could not say whether a muted
  // robot had no microphone or simply a late first frame (D427).
  const graceStartedAt = Date.now()
  await Promise.race([
    firstAudio.promise,
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, audioGraceMs)
      t.unref?.()
    }),
  ])
  const waitedMs = Date.now() - graceStartedAt
  if (pendingLoss !== null) {
    await stream.stop().catch(() => undefined)
    throw new Error(`relay lost before the server was up (${describeLoss(pendingLoss)})`)
  }
  const paramSets = videoRef.current
  if (paramSets === null) throw new Error('no parameter sets after the first keyframe')
  const audioFacts = audioRef.current
  const sdp = buildRfc4571Sdp(
    { videoType: 'H264', payloadType: VIDEO_PT, h264: paramSets },
    audioFacts !== null
      ? {
          codec: 'aac',
          payloadType: AUDIO_PT,
          sampleRate: audioFacts.sampleRate,
          channels: audioFacts.channels,
          configHex: audioFacts.configHex,
        }
      : undefined,
  )
  const muxer = new Rfc4571Muxer(
    consoleInto(logger),
    VIDEO_PT,
    audioFacts !== null ? AUDIO_PT : undefined,
  )
  stream.on('videoAccessUnit', (e) => {
    videoAccessUnits += 1
    muxer.sendVideoAccessUnit('H264', e.data, e.isKeyframe, e.microseconds)
  })
  if (audioFacts !== null) {
    logger.info('rfc4571: serving audio', {
      meta: {
        codec: 'aac',
        sampleRate: audioFacts.sampleRate,
        channels: audioFacts.channels,
        waitedMs,
      },
    })
    lastAudioAt = Date.now()
    stream.on('audioFrame', (adts) => {
      audioFrames += 1
      lastAudioAt = Date.now()
      muxer.sendAudioAdtsFrame(adts)
    })
  } else {
    logger.info('rfc4571: no audio within the grace — serving video-only', {
      meta: { waitedMs, audioGraceMs },
    })
    // The SDP is negotiated once, so audio that shows up now cannot join this
    // session. Say so ONCE: this line is the difference between "the robot has
    // no microphone" and "the grace window is too short", which is the whole
    // question. Raising `audioGraceMs` is the fix when this line appears.
    let reportedLate = false
    stream.on('audioFrame', () => {
      if (reportedLate) return
      reportedLate = true
      logger.warn('rfc4571: audio arrived after the grace — this session stays video-only', {
        meta: { lateByMs: Date.now() - graceStartedAt - waitedMs, audioGraceMs },
      })
    })
  }

  let liveClients = 0
  let idleTimer: NodeJS.Timeout | null = null
  const server = net.createServer((socket) => {
    liveClients += 1
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
    logger.debug('rfc4571: consumer connected', { meta: { active: liveClients } })
    muxer.addClient(socket)
    socket.on('close', () => {
      liveClients = Math.max(0, liveClients - 1)
      logger.debug('rfc4571: consumer disconnected', { meta: { active: liveClients } })
      if (liveClients === 0 && !toreDown) {
        idleTimer = setTimeout(() => {
          if (liveClients === 0 && !toreDown) {
            toreDown = true
            onConsumerDisconnect()
          }
        }, idleGraceMs)
        idleTimer.unref?.()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, bindHost, () => resolve())
  })
  const addr = server.address()
  if (addr === null || typeof addr === 'string')
    throw new Error('failed to bind the RFC4571 server')
  // Allocation-free stall watch: the frame path stamps a clock, one sweep
  // reads it (the broker's own pattern for its RTP activity watchdog).
  const stallSweep = setInterval(
    () => {
      if (toreDown) return
      // Audio that dies while the video keeps going is NOT a lost relay — the
      // feed is healthy and the stream simply went mute. It is the shape an
      // operator reports as "no audio", and it used to produce no line at all.
      if (
        audioFacts !== null &&
        !audioStallReported &&
        Date.now() - lastAudioAt >= stallTimeoutMs
      ) {
        audioStallReported = true
        logger.warn('rfc4571: audio stopped while the video kept flowing', {
          meta: { audioFrames, videoAccessUnits, silentForMs: Date.now() - lastAudioAt },
        })
      }
      if (Date.now() - lastVideoAt < stallTimeoutMs) return
      reportLoss({ reason: 'stalled', error: null })
    },
    Math.max(5, Math.min(FEED_STALL_SWEEP_MS, Math.floor(stallTimeoutMs / 2))),
  )
  stallSweep.unref?.()
  serving = true
  return {
    host: bindHost,
    port: addr.port,
    sdp,
    audio:
      audioFacts !== null
        ? { codec: 'aac', sampleRate: audioFacts.sampleRate, channels: audioFacts.channels }
        : null,
    close: async () => {
      toreDown = true
      logger.info('rfc4571: session ended', {
        meta: {
          videoAccessUnits,
          audioFrames,
          declaredAudio: audioFacts !== null,
        },
      })
      clearInterval(stallSweep)
      if (idleTimer !== null) clearTimeout(idleTimer)
      try {
        muxer.close()
      } catch {
        // already closed
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
