/**
 * One Hikvision RTSP REPLAY session: the socket, the handshake, and the media
 * it hands over.
 *
 * ## Why this provider owns an RTSP client at all
 *
 * The obvious alternative is `ffmpeg -i rtsp://user:pass@host/Streaming/tracks/…`
 * and it is refused for two reasons, one of them fatal:
 *
 * - **The credential would be an argv.** Every `ps` on the hub would carry
 *   this camera's password for the length of the clip. Nothing else in the
 *   clip path puts a secret there, and a media fetch is not the place to
 *   start.
 * - **It measured as unusable anyway.** Driven at the playback URI, ffmpeg
 *   produced no output at all on 1436 over three minutes (2026-09-22), while
 *   the same session opened by hand answered in under 300 ms. `Rate-Control`
 *   and `Range: clock=` — the headers the feasibility note measured — are not
 *   emittable by it at all, so anything past forward-only would need this
 *   client eventually.
 *
 * ## What this session does, and does not
 *
 * `OPTIONS`, `DESCRIBE`, one `SETUP` per track, one `PLAY`, `TEARDOWN`.
 * Forward-only, exactly the transport the contract declares: it never sends a
 * second `PLAY`, never a `Range: clock=`, never a `Scale` and never
 * `Rate-Control`. The feasibility note measured that those work and that
 * `Scale: 8.0` silently corrupts while answering 200 — none of it is reachable
 * from here, so none of it can be got wrong here.
 *
 * ## Two things that kill a session, both measured on this fleet
 *
 * - **`SETUP` on the session-level `a=control`** — the aggregate URL that sits
 *   before the first `m=` — answers **415** and the camera then closes the
 *   socket. `rtsp-sdp.ts` cannot return it.
 * - **This firmware serves ONE playback session at a time, and a session
 *   nobody tore down blocks every later one.** Measured the hard way on
 *   2026-09-22: an abandoned ffmpeg held an open replay on 1436 for three
 *   hours, and for those three hours every `SETUP` on that camera answered
 *   **500** while `ContentMgmt/search` kept answering normally. Killing the
 *   stray process restored it instantly. So a `SETUP` refusal is a statement
 *   about the CAMERA'S one slot, never about whether the clip exists — and it
 *   is never retried, because hammering an occupied slot is how one camera's
 *   fault becomes a fleet's load. It is also why {@link RtspReplaySession.close}
 *   sends `TEARDOWN` on every exit, and why no run may outlive its answer.
 */
import { connect, type Socket } from 'node:net'

import type { IScopedLogger } from '@camstack/types'

import { buildAuthHeader, type DigestState, parseChallenge } from '../../digest-auth.js'
import {
  createRtpVideoDepacketizer,
  parseRtpPacket,
  type VideoAccessUnit,
} from './rtp-depacketize.js'
import { parseRtspSdp, type RtspVideoTrack, resolveControlUrl } from './rtsp-sdp.js'
import { createRtspWireReader, encodeRtspRequest, type RtspResponse } from './rtsp-wire.js'

/** RTSP's own port. The ISAPI port is a different, unrelated number. */
export const RTSP_PORT = 554

/**
 * How long the handshake may take before the session is abandoned.
 *
 * The measured handshake is 300 ms on a working camera. Ten seconds is a
 * camera that is not going to answer, and waiting longer only holds the
 * caller's request open behind it.
 */
export const RTSP_HANDSHAKE_TIMEOUT_MS = 10_000

/**
 * How long a session may deliver NOTHING AT ALL before it is abandoned.
 *
 * This is the gap before the first access unit. Past it the camera accepted a
 * PLAY and is sending nothing, which is a failure with somewhere to put its
 * reason.
 */
export const RTSP_IDLE_TIMEOUT_MS = 15_000

/**
 * How long a quiet socket AFTER media means the segment has ENDED.
 *
 * **Measured, and it is the whole reason this constant exists.** A Hikvision
 * replay sends no end-of-stream marker, emits zero RTCP, and — this is the
 * part a unit suite cannot invent — **does not close the socket when the
 * segment is done.** On 3833, a 19 s segment delivered 246 access units and
 * 10.3 MB in 18.9 s, at 1x, and then the socket simply went quiet and stayed
 * open until the 60 s session timeout. A single idle rule therefore filed
 * every COMPLETE clip as a failure, which is the branch that accepts work and
 * then throws the result away (D391).
 *
 * Three seconds is an order of magnitude over the largest inter-packet gap
 * measured inside a delivery (the 2 s sampling above never saw a stall) and
 * well under the camera's own session timeout.
 */
export const RTSP_SEGMENT_QUIET_MS = 3_000

/**
 * How long the socket may take to put a queued `TEARDOWN` on the wire.
 *
 * **This is a bound on OUR socket, not a claim about the camera.** A
 * `TEARDOWN` is two hundred bytes on a LAN; two seconds is three orders of
 * magnitude over that, and it only ever elapses for a peer that is not reading
 * at all — which is a socket we want destroyed anyway.
 *
 * It exists because `socket.destroy()` DISCARDS whatever `write()` queued.
 * The old `close()` wrote `TEARDOWN` and destroyed the socket in the next
 * statement, and the ordinary end of a segment — a quiet socket, which is how
 * every complete Hikvision replay ends — never wrote one at all. This firmware
 * serves ONE playback session and frees it on `TEARDOWN` or on its own 60 s
 * timeout, so a fetch that skipped the `TEARDOWN` left the next clip an
 * operator tapped to meet `SETUP … 500` for up to a minute. Measured on 1436,
 * 2026-09-23 09:25:07: a stream cut at 09:25:00 and the replay seven seconds
 * later was refused 500 while `ContentMgmt/search` kept answering.
 */
export const RTSP_TEARDOWN_FLUSH_MS = 2_000

export interface RtspReplayTarget {
  readonly host: string
  /**
   * RTSP's own port. Absent means {@link RTSP_PORT}, which is what every
   * camera on this fleet serves and is independent of the ISAPI port.
   *
   * Named rather than assumed so a session can be pointed somewhere else —
   * which is what the spec does, against a listener that speaks this
   * firmware's RTSP and then goes quiet without closing.
   */
  readonly port?: number
  readonly username: string
  readonly password: string
  /**
   * Path AND query of the camera's own `playbackURI`, verbatim.
   *
   * Opaque on purpose: it carries `starttime`, `endtime`, the file `name` and
   * its `size`, the `name` counter rolls, and nothing outside the catalog has
   * any business composing one. A handle is a handle.
   */
  readonly playbackPath: string
}

export interface RtspReplayHandlers {
  /** One access unit, Annex-B, parameter sets on the first. */
  onVideo(unit: VideoAccessUnit): void
  /** One µ-law payload, in arrival order. Absent handler ⇒ not followed. */
  onAudio?: (payload: Buffer, timestamp: number) => void
}

export type RtspReplayEnd =
  /**
   * The camera played the segment out.
   *
   * It is either a socket the camera closed or — the measured case on this
   * fleet — a socket that went QUIET after delivering media and stayed open.
   * `deliveredMs` is the span of the media that actually arrived, from its own
   * RTP timestamps, so a caller can judge it against what the catalog said the
   * segment was. `null` when fewer than two access units arrived: a span
   * nothing measured is not zero (D393).
   */
  | { readonly kind: 'complete'; readonly deliveredMs: number | null }
  /** The caller asked to stop. */
  | { readonly kind: 'closed' }
  | { readonly kind: 'failed'; readonly code: RtspReplayFailure; readonly detail: string }

/** Why a replay could not be had. Every one is logged where it was decided. */
export type RtspReplayFailure =
  /** The socket never came up, or died mid-handshake. */
  | 'transport'
  /** The camera answered a refusal to one of the handshake verbs. */
  | 'camera-refused'
  /** The SDP described nothing this provider can carry. */
  | 'no-media'
  /** Nothing arrived inside the idle bound. */
  | 'idle'

export interface RtspReplaySession {
  /** Resolves when the session ENDS, however it ends. */
  readonly ended: Promise<RtspReplayEnd>
  /** The video track the SDP described — available once `open` resolved. */
  readonly video: RtspVideoTrack
  /** The SDP named an audio track this provider can carry. */
  readonly hasAudio: boolean
  /**
   * Stop now, and resolve when this provider NO LONGER HOLDS the camera's one
   * replay slot: the `TEARDOWN` has left the socket and the socket is closed.
   *
   * Idempotent, and awaitable after the session has already ended on its own —
   * a caller that serialises replays per camera (`replay-lane.ts`) needs one
   * answer to "is the slot free", and "the run returned" is not that answer.
   */
  close(): Promise<void>
}

export interface RtspReplayDeps {
  readonly logger: IScopedLogger
  readonly deviceId: number
  readonly handshakeTimeoutMs?: number
  readonly idleTimeoutMs?: number
  readonly segmentQuietMs?: number
  /** Seam for the spec. {@link RTSP_TEARDOWN_FLUSH_MS} otherwise. */
  readonly teardownFlushMs?: number
}

interface PendingRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly settle: (response: RtspResponse) => void
  readonly fail: (error: Error) => void
  retried: boolean
}

/**
 * Open a replay and start delivering.
 *
 * Rejects when the session could not be OPENED — the handshake is where a
 * refusal has somewhere to go. Once it resolves, every later outcome travels
 * on {@link RtspReplaySession.ended}, because by then bytes may already be at
 * the peer and a throw would have nowhere to be caught.
 */
export async function openRtspReplay(
  target: RtspReplayTarget,
  handlers: RtspReplayHandlers,
  deps: RtspReplayDeps,
): Promise<RtspReplaySession> {
  const tags = { deviceId: deps.deviceId }
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? RTSP_HANDSHAKE_TIMEOUT_MS
  const idleTimeoutMs = deps.idleTimeoutMs ?? RTSP_IDLE_TIMEOUT_MS
  const segmentQuietMs = deps.segmentQuietMs ?? RTSP_SEGMENT_QUIET_MS
  const port = target.port ?? RTSP_PORT
  const sessionUrl =
    port === RTSP_PORT
      ? `rtsp://${target.host}${target.playbackPath}`
      : `rtsp://${target.host}:${String(port)}${target.playbackPath}`
  const digest: DigestState = { nc: 0 }
  const reader = createRtspWireReader()

  let socket: Socket | null = null
  let cseq = 0
  let rtspSession: string | null = null
  let pending: PendingRequest | null = null
  let settled = false
  let endResolve: ((end: RtspReplayEnd) => void) | null = null
  const ended = new Promise<RtspReplayEnd>((resolve) => {
    endResolve = resolve
  })
  const teardownFlushMs = deps.teardownFlushMs ?? RTSP_TEARDOWN_FLUSH_MS
  /** Resolves when this provider no longer holds the camera's replay slot. */
  let slotResolve: (() => void) | null = null
  const slotFreed = new Promise<void>((resolve) => {
    slotResolve = resolve
  })
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null
  let videoChannel = -1
  let audioChannel = -1
  let depacketizer: ReturnType<typeof createRtpVideoDepacketizer> | null = null
  let videoTrack: RtspVideoTrack | null = null
  let videoUnits = 0
  let audioPackets = 0
  let firstTimestamp: number | null = null
  let lastTimestamp: number | null = null

  /** The span of the media that really arrived, from its own clock. */
  const deliveredMs = (): number | null => {
    if (firstTimestamp === null || lastTimestamp === null || videoUnits < 2) return null
    const ticks = lastTimestamp - firstTimestamp
    if (ticks <= 0) return null
    return Math.round((ticks / (videoTrack?.clockRate ?? 90_000)) * 1_000)
  }

  /**
   * Give the socket back, and say whether the camera's slot went with it.
   *
   * `flush` is true exactly when a `TEARDOWN` was queued: the socket is then
   * `end()`ed so the kernel puts it on the wire, and only destroyed if it has
   * not closed inside {@link RTSP_TEARDOWN_FLUSH_MS}. `destroy()` on a socket
   * with a queued write throws that write away, which is how the slot came to
   * be held past the end of a fetch nobody thought had failed.
   */
  const releaseSocket = (flush: boolean): void => {
    const live = socket
    socket = null
    if (live === null) {
      slotResolve?.()
      slotResolve = null
      return
    }
    live.once('close', () => {
      slotResolve?.()
      slotResolve = null
    })
    if (!flush) {
      live.destroy()
      return
    }
    const timer = setTimeout(() => live.destroy(), teardownFlushMs)
    timer.unref?.()
    live.once('close', () => clearTimeout(timer))
    live.end()
  }

  const finish = (end: RtspReplayEnd): void => {
    if (settled) return
    settled = true
    if (idleTimer !== null) clearTimeout(idleTimer)
    if (handshakeTimer !== null) clearTimeout(handshakeTimer)
    idleTimer = null
    handshakeTimer = null
    const tail = depacketizer?.flush() ?? null
    if (tail !== null) {
      videoUnits += 1
      handlers.onVideo(tail)
    }
    // A `TEARDOWN` on EVERY exit that has a session to tear down, not only on
    // an explicit `close()`. The ordinary end of a Hikvision segment is a
    // QUIET socket the camera leaves open, so `complete` — the commonest exit
    // of all — used to walk away holding the camera's one slot until its own
    // 60 s timeout. A branch that releases nothing is the branch that accepts
    // work and produces nothing (D391), and here it is charged to the NEXT
    // clip the operator taps.
    let teardown: 'sent' | 'no-session' | 'no-socket' = 'no-session'
    if (socket === null || socket.destroyed) teardown = 'no-socket'
    else if (rtspSession !== null) {
      try {
        write('TEARDOWN', sessionUrl, {})
        teardown = 'sent'
      } catch {
        teardown = 'no-socket'
      }
    }
    deps.logger.info('videoclips: a replay session ended', {
      tags,
      meta: {
        outcome: end.kind,
        ...(end.kind === 'failed' ? { code: end.code, reason: end.detail } : {}),
        ...(end.kind === 'complete' ? { deliveredMs: end.deliveredMs } : {}),
        videoUnits,
        audioPackets,
        droppedPayloads: depacketizer?.dropped ?? 0,
        teardown,
      },
    })
    releaseSocket(teardown === 'sent')
    endResolve?.(end)
  }

  /**
   * Re-arm the quiet timer.
   *
   * Which timer it is depends on whether ANY media has arrived, and that is
   * the whole point: quiet BEFORE the first access unit is a camera that took
   * a PLAY and is sending nothing, quiet AFTER one is the end of the segment.
   * This firmware gives no other signal — no marker, no RTCP, no close.
   */
  const armIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    const seenMedia = videoUnits > 0 || audioPackets > 0
    idleTimer = setTimeout(
      () => {
        if (seenMedia) {
          finish({ kind: 'complete', deliveredMs: deliveredMs() })
          return
        }
        finish({
          kind: 'failed',
          code: 'idle',
          detail: `the camera delivered nothing for ${String(idleTimeoutMs)} ms`,
        })
      },
      seenMedia ? segmentQuietMs : idleTimeoutMs,
    )
  }

  const send = (
    method: string,
    url: string,
    headers: Record<string, string> = {},
  ): Promise<RtspResponse> =>
    new Promise<RtspResponse>((settle, fail) => {
      if (socket === null) {
        fail(new Error('the replay socket is closed'))
        return
      }
      pending = { method, url, headers, settle, fail, retried: false }
      write(method, url, headers)
    })

  const write = (method: string, url: string, headers: Record<string, string>): void => {
    cseq += 1
    const authorization = buildAuthHeader({
      state: digest,
      method,
      uri: url,
      username: target.username,
      password: target.password,
    })
    socket?.write(
      encodeRtspRequest({
        method,
        url,
        cseq,
        headers: {
          'User-Agent': 'CamStack',
          ...(authorization !== null ? { Authorization: authorization } : {}),
          ...(rtspSession !== null ? { Session: rtspSession } : {}),
          ...headers,
        },
      }),
    )
  }

  const onResponse = (response: RtspResponse): void => {
    const request = pending
    if (request === null) return
    if (response.headers['session'] !== undefined) {
      rtspSession = (response.headers['session'] ?? '').split(';')[0] ?? null
    }
    if (response.status === 401 && !request.retried) {
      const challenge = parseChallenge(response.headers['www-authenticate'] ?? null)
      if (challenge !== null) {
        digest.challenge = challenge
        digest.nc = 0
        request.retried = true
        write(request.method, request.url, request.headers)
        return
      }
    }
    pending = null
    request.settle(response)
  }

  const onMedia = (channel: number, packet: Buffer): void => {
    const parsed = parseRtpPacket(packet)
    // An RTCP report on the odd channel is not media and must not re-arm the
    // segment-quiet timer: a keepalive that kept the session "alive" would
    // hold a finished clip open for the camera's whole session timeout.
    if (parsed === null) return
    armIdle()
    if (channel === videoChannel && depacketizer !== null) {
      if (firstTimestamp === null) firstTimestamp = parsed.timestamp
      lastTimestamp = parsed.timestamp
      const unit = depacketizer.push(parsed)
      if (unit !== null) {
        videoUnits += 1
        handlers.onVideo(unit)
      }
      return
    }
    if (channel === audioChannel && handlers.onAudio !== undefined) {
      audioPackets += 1
      handlers.onAudio(parsed.payload, parsed.timestamp)
    }
  }

  socket = connect({ host: target.host, port })
  socket.setNoDelay(true)
  socket.on('data', (chunk: Buffer) => {
    for (const event of reader.push(chunk)) {
      if (event.kind === 'interleaved') {
        onMedia(event.channel, event.payload)
        continue
      }
      if (event.kind === 'response') {
        onResponse(event)
        continue
      }
      finish({ kind: 'failed', code: 'transport', detail: event.reason })
      return
    }
  })
  socket.on('error', (err: Error) => {
    pending?.fail(err)
    pending = null
    finish({ kind: 'failed', code: 'transport', detail: err.message })
  })
  socket.on('close', () => {
    // A close is ONE of the two ways a replay ends — and, measured on this
    // fleet, the rarer one: the camera normally just goes quiet and leaves the
    // socket open, which `armIdle` is what catches. Before PLAY this is a
    // failure, and `finish` has already been called by the branch that decided
    // that, so this call is a no-op there.
    finish({ kind: 'complete', deliveredMs: deliveredMs() })
  })

  handshakeTimer = setTimeout(() => {
    finish({
      kind: 'failed',
      code: 'transport',
      detail: `the handshake did not complete inside ${String(handshakeTimeoutMs)} ms`,
    })
  }, handshakeTimeoutMs)

  const failOpen = (code: RtspReplayFailure, detail: string): never => {
    deps.logger.warn('videoclips: a replay session could not be opened', {
      tags,
      meta: { branch: code, reason: detail },
    })
    finish({ kind: 'failed', code, detail })
    throw new Error(detail)
  }

  await new Promise<void>((resolve, reject) => {
    socket?.once('connect', resolve)
    socket?.once('error', reject)
  }).catch((err: unknown) =>
    failOpen('transport', err instanceof Error ? err.message : String(err)),
  )

  // A refusal to any handshake verb is the camera's, verbatim.
  const describe = await send('DESCRIBE', sessionUrl, { Accept: 'application/sdp' })
  if (describe.status !== 200) {
    return failOpen('camera-refused', `DESCRIBE answered ${String(describe.status)}`)
  }
  const description = parseRtspSdp(describe.body)
  const video = description.tracks.find((track): track is RtspVideoTrack => track.kind === 'video')
  if (video === undefined) {
    return failOpen(
      'no-media',
      `the camera described no video track this provider can carry (${describe.body.length} bytes of SDP)`,
    )
  }
  if (description.unsupported.length > 0) {
    // A branch that drops a track says so, or a silent clip has no cause.
    deps.logger.info('videoclips: a replay described media this provider does not follow', {
      tags,
      meta: { unsupported: description.unsupported },
    })
  }
  const audio =
    handlers.onAudio === undefined
      ? undefined
      : description.tracks.find((track) => track.kind === 'audio')

  videoTrack = video
  depacketizer = createRtpVideoDepacketizer({
    codec: video.codec,
    parameterSets: video.parameterSets,
  })

  let channel = 0
  for (const track of [video, ...(audio === undefined ? [] : [audio])]) {
    const url = resolveControlUrl(sessionUrl, track.control)
    const setup = await send('SETUP', url, {
      Transport: `RTP/AVP/TCP;unicast;interleaved=${String(channel)}-${String(channel + 1)}`,
    })
    if (setup.status !== 200) {
      return failOpen(
        'camera-refused',
        `SETUP of the ${track.kind} track answered ${String(setup.status)} — ` +
          'the camera refused this replay, and nothing a retry changes',
      )
    }
    if (track.kind === 'video') videoChannel = channel
    else audioChannel = channel
    channel += 2
  }

  const play = await send('PLAY', sessionUrl, { Range: 'npt=0.000-' })
  if (play.status !== 200) {
    return failOpen('camera-refused', `PLAY answered ${String(play.status)}`)
  }
  if (handshakeTimer !== null) clearTimeout(handshakeTimer)
  handshakeTimer = null
  armIdle()
  deps.logger.info('videoclips: a replay session is playing', {
    tags,
    meta: {
      codec: video.codec,
      clockRate: video.clockRate,
      audio: audio !== undefined,
      // Never the URL: it carries no credential, but it is long and the file
      // handle inside it is what identifies the clip anyway.
      parameterSets: video.parameterSets.length,
    },
  })

  return {
    ended,
    video,
    hasAudio: audio !== undefined,
    close: async () => {
      // `finish` sends the TEARDOWN and waits for the socket to go; calling it
      // twice is a no-op, which is what makes this awaitable after the session
      // has already ended on its own.
      finish({ kind: 'closed' })
      await slotFreed
    },
  }
}
