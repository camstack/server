import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { writeHeld } from '../stream-broker/held-write.js'
import type { RestreamClientFacts } from '../live-viewers.js'
import {
  isLiveEdgeOnlyDial,
  NO_DECLARATION,
  type RestreamDeclaration,
  type RestreamIntent,
} from './restream-intent.js'
import {
  INTERLEAVED_MAGIC,
  MAX_MISSED_KEYFRAMES,
  MAX_WRITE_BUFFER,
  RTSP_METHODS,
  type RtpPacket,
  type RtspRequest,
  type TrackSetup,
} from './rtsp-types.js'

/**
 * What happened to an attempted RTP write.
 *
 * Returned rather than swallowed so the RESTREAMER — which owns the logger and
 * the stream identity — can count and report every dropped packet. Every one of
 * these branches used to be silent: a non-muted client could be closed on
 * backlog without a log line at any level, and the drop-until-keyframe latch
 * discarded whole GOPs invisibly. Silence reads as "never happened".
 */
export type RtpWriteOutcome =
  /** Handed to the socket. */
  | 'written'
  /** Session not in PLAY, closed, or without a SETUP track — nothing to do. */
  | 'not-playing'
  /** Dropped while latched, waiting for the next clean GOP boundary. */
  | 'dropped-latched'
  /** Dropped because the socket's write backlog is over `MAX_WRITE_BUFFER`. */
  | 'dropped-backlog'
  /** Unwritable at `MAX_MISSED_KEYFRAMES` CONSECUTIVE keyframe AUs — the
   *  session is treated as a peer that vanished and closed. Never a verdict on
   *  one packet, and never on who the consumer is. */
  | 'closed-backlog'

/**
 * Handles one RTSP client connection.
 * Parses requests, responds to OPTIONS/DESCRIBE/SETUP/PLAY/TEARDOWN,
 * and sends RTP data via TCP interleaved framing.
 */
export class RtspSession {
  private readonly sessionId: string
  private readonly tracks: TrackSetup[] = []
  private playing = false
  private buffer = ''
  private closed = false
  private readonly sdp: string
  private readonly onClose?: () => void
  /** Epoch ms when the TCP connection was accepted. Used by listClients. */
  private readonly connectedAt: number = Date.now()
  /** Epoch ms of the last RTP packet sent successfully. 0 if none yet. */
  private lastRtpAt = 0
  /** Total video RTP bytes written to the socket. */
  private bytesSent = 0
  /**
   * The socket is corked for the access unit in progress — see
   * {@link writeInterleaved}. Cleared by the packet that ends the picture (RTP
   * marker, or any audio packet) or by the next-tick safety net, whichever
   * comes first.
   */
  private accessUnitCorked = false

  /** Flush the access unit in progress. Idempotent: the marker and the safety net both call it. */
  private readonly uncorkAccessUnit = (): void => {
    if (!this.accessUnitCorked) return
    this.accessUnitCorked = false
    this.socket.uncork()
  }
  /** Client `User-Agent` (from the first request that carries one). Lets the
   *  broker panel identify a consumer by purpose — e.g. the recorder sets
   *  `-user_agent recorder` on its RTSP pull — instead of a bare address. */
  private userAgent: string | null = null

  /** When true, this session receives video-only (no audio RTP). */
  private readonly muted: boolean

  /**
   * What this session DECLARED on its dial path (see `restream-intent.ts`): its
   * consumer purpose, and how many ms of retained history it asked for.
   * {@link NO_DECLARATION} when it declared nothing — which is every consumer
   * except the per-session detection decode and the recorder's writer.
   *
   * Kept separate from {@link muted} deliberately: the two say different things
   * and, since D525, they no longer coincide — a `/sentry` dial declares an
   * intent and is NOT muted, while the join rule that used to read `isMuted()`
   * now reads {@link isLiveEdgeOnly} and keeps every older population's
   * behaviour byte-for-byte.
   *
   * One field and not two, because the purpose and the amount are one
   * statement (D382): a session that names a purpose without naming an amount
   * is asking for nothing, and that has to be as unmistakable here as it is on
   * the wire.
   */
  private readonly declaration: RestreamDeclaration

  /**
   * Epoch ms at which this session reached PLAY, or `0` before it does.
   *
   * The clock the join is measured against. `connectedAt` is the TCP accept,
   * which includes DESCRIBE/SETUP and, for a cold broker, the whole upstream
   * dial — so it answers "how slow was the camera", not "what did the burst
   * cost this session". Time to the live edge is measured from PLAY, because
   * PLAY is the first instant at which the restreamer owes this session bytes.
   */
  private playAt = 0

  /**
   * Latch for ANY session that has started dropping video packets on socket
   * backlog — it was written for the `muted` decoder loopback, which was the
   * only consumer allowed to survive backpressure; since 2026-09-01 every
   * session takes this path. While set, every non-keyframe
   * packet is dropped — even after the backlog clears — until the next keyframe
   * access unit, so the decoder always resumes on a clean GOP boundary instead
   * of mid-GOP with reference-broken (missing P-frame) packets.
   */
  private droppingUntilKeyframe = false
  /** Consecutive keyframe AUs at which this session was still unwritable.
   *  Reset by any successful write — the bound is CONSECUTIVE misses. */
  private missedKeyframes = 0

  constructor(
    private readonly socket: Socket,
    sdp: string,
    onClose?: () => void,
    muted?: boolean,
    declaration?: RestreamDeclaration,
  ) {
    this.sdp = sdp
    this.onClose = onClose
    this.muted = muted ?? false
    this.declaration = declaration ?? NO_DECLARATION
    this.sessionId = randomUUID().replace(/-/g, '').slice(0, 16)

    socket.on('data', (chunk: Buffer) => {
      if (this.closed) return
      this.buffer += chunk.toString('ascii')
      this.processBuffer()
    })

    socket.on('close', () => {
      this.closed = true
      this.onClose?.()
    })
    socket.on('error', () => {
      this.closed = true
      this.onClose?.()
    })
  }

  /** Bytes the socket has accepted but not yet flushed (corked bytes included). */
  getWriteQueueBytes(): number {
    return this.socket.writableLength
  }

  getSessionId(): string {
    return this.sessionId
  }
  isPlaying(): boolean {
    return this.playing && !this.closed
  }
  isMuted(): boolean {
    return this.muted
  }

  /**
   * Whether this session is a RE-CLOCKING leg that may only join at the live
   * edge — the second question `isMuted()` used to answer.
   *
   * Derived from the one authority (`isLiveEdgeOnlyDial`) rather than stored,
   * so the rule cannot drift between the parser and the session. Unchanged for
   * every population that existed before the sentry gained audio.
   */
  isLiveEdgeOnly(): boolean {
    return isLiveEdgeOnlyDial({ muted: this.muted, declaration: this.declaration })
  }
  /**
   * The `User-Agent` this client put on its first request, or `null`.
   *
   * The ONLY identity that crosses from a consumer process into this session.
   * The restreamer prints it beside the pre-roll window it serves, which is how
   * a burst the broker measured can be tied to the file the consumer wrote —
   * `sessionId` is minted here and appears in no consumer's logs.
   */
  getUserAgent(): string | null {
    return this.userAgent
  }

  /**
   * What the live-viewer count needs to classify this client (see
   * `live-viewers.ts`). `playing` is `isPlaying()`, which is false once the
   * socket closed or errored — so an abruptly dropped client stops counting at
   * the same instant, before the restreamer's own `removeSession` reconcile.
   */
  getViewerFacts(): RestreamClientFacts {
    return {
      playing: this.isPlaying(),
      userAgent: this.userAgent,
      remoteAddr: `${this.socket.remoteAddress ?? 'unknown'}:${String(this.socket.remotePort ?? 0)}`,
      muted: this.muted,
      intent: this.declaration.intent,
    }
  }
  /**
   * True only for a session that dialed the DETECTION path
   * (`DETECTION_MUTED_PATH_SUFFIX`). Read by
   * `RtspRestreamer.servePendingSessionsRtp` to exempt this session from the
   * live-edge join withhold — a detection decode has decode headroom by
   * construction and drains the burst instead of accumulating it.
   */
  isDetectionIntent(): boolean {
    return this.declaration.intent === 'detection'
  }

  /**
   * Whether this dial asked for the STREAM without asking for the CAMERA.
   *
   * The one question the demand split turns on: a sentry session is FED but
   * is not INTENT, so it never dials a sleeping camera. See
   * `SENTRY_PATH_SUFFIX`.
   */
  isPrestreamIntent(): boolean {
    return this.declaration.intent === 'sentry'
  }

  /**
   * Ms of retained history this session ASKED for on its dial. `0` = none.
   *
   * Read by `RtspRestreamer.servePendingSessionsRtp`, which serves the smaller
   * of this and what the ring holds. A session that declared an intent and no
   * amount takes the ordinary current-GOP burst — the intent still buys it
   * whatever else the intent buys (for detection, the live-edge exemption), and
   * nothing more.
   */
  preRollRequestMs(): number {
    return this.declaration.preRollRequestMs
  }

  /** Epoch ms at which this session reached PLAY; `0` if it has not. */
  getPlayAt(): number {
    return this.playAt
  }

  /**
   * Does this session get the PRE-ROLL window instead of the current GOP?
   *
   * Both declared intents do, for the same reason: they attach after the edge
   * they need to see. Separate from {@link isDetectionIntent} because that one
   * also lifts the live-edge withhold, which is a MUTED-consumer rule and must
   * not be lifted for anyone else.
   */
  wantsPreRoll(): boolean {
    return this.preRollIntent() !== null
  }

  /**
   * WHICH pre-roll window this session gets, or `null` when it declared no
   * intent and takes the ordinary current-GOP join burst.
   *
   * There is ONE window now (D381) and one ASK per session (D382), so what the
   * restreamer still needs from this is WHO joined — the identity it prints
   * beside the window it served, and the reason a recorder and a detector are
   * distinguishable on a line that reports one number.
   */
  preRollIntent(): RestreamIntent | null {
    const intent = this.declaration.intent
    return intent === 'detection' || intent === 'recording' ? intent : null
  }

  /**
   * Diagnostic snapshot consumed by `StreamBroker.listClients` (Phase 10).
   * Gives operators the information needed to identify a specific RTSP
   * session: where it's coming from, whether it's active, when it
   * connected, and the last RTP activity timestamp.
   */
  getInfo(): {
    readonly sessionId: string
    readonly remoteAddr: string
    readonly userAgent: string | null
    readonly playing: boolean
    readonly muted: boolean
    readonly connectedAt: number
    readonly lastRtpAt: number
    readonly bytesSent: number
  } {
    const remoteIp = this.socket.remoteAddress ?? 'unknown'
    const remotePort = this.socket.remotePort ?? 0
    return {
      sessionId: this.sessionId,
      remoteAddr: `${remoteIp}:${remotePort}`,
      userAgent: this.userAgent,
      playing: this.isPlaying(),
      muted: this.muted,
      connectedAt: this.connectedAt,
      lastRtpAt: this.lastRtpAt,
      bytesSent: this.bytesSent,
    }
  }

  /**
   * Send a video RTP packet via TCP interleaved framing.
   *
   * `prime` marks a packet from the current-GOP catch-up burst replayed on
   * join. A prime burst starts at a keyframe by construction, so it clears the
   * `droppingUntilKeyframe` latch.
   *
   * **Prime is NOT exempt from backpressure.** It used to be — written
   * unconditionally, on the theory that the burst was a bounded one-shot. It is
   * not bounded: the restreamer replays the broker's whole retained RTP ring,
   * capped only at `RTP_RING_MAX_BYTES` (24 MB), so one join could queue up to
   * 24 MB into a socket the live path a few lines below refuses at 2 MB.
   * The burst is now PACED (`PacedRtpReplay` in the restreamer) precisely so
   * the socket drains between chunks, which makes honouring the gate cheap.
   *
   * On backlog the BURST is abandoned, never the client — closing a viewer
   * because our own catch-up outran its socket would be self-inflicted. The
   * latch then holds the session until the next keyframe AU, so it never
   * decodes from a half-delivered GOP. The live path keeps its existing, harder
   * rule: a non-muted client that cannot keep up with the LIVE rate is closed.
   *
   * `isKeyframe` marks a packet that begins a keyframe access unit — the clean
   * GOP boundary at which a latched session resumes sending.
   */
  sendRtp(packet: RtpPacket, prime = false, isKeyframe = false): RtpWriteOutcome {
    if (!this.playing || this.closed) return 'not-playing'
    if (this.tracks.length === 0) return 'not-playing'

    if (prime) {
      if (this.socket.writableLength > MAX_WRITE_BUFFER) {
        this.droppingUntilKeyframe = true
        return 'dropped-backlog'
      }
      this.droppingUntilKeyframe = false
    } else {
      if (this.droppingUntilKeyframe) {
        // Still dropping after an earlier backlog hit: resume only when the next
        // keyframe AU arrives, so the decoder never resumes mid-GOP.
        if (!isKeyframe) return 'dropped-latched'
        this.droppingUntilKeyframe = false
      }

      if (this.socket.writableLength > MAX_WRITE_BUFFER) {
        // Backpressure measures LIVENESS, not identity. NOBODY is closed for
        // being momentarily behind: drop this packet and latch until the next
        // keyframe, so we resume on a clean GOP boundary with no
        // reference-broken decode.
        //
        // This used to ask WHO the session was — the `muted` decoder loopback
        // was spared, every other client was closed on its FIRST backlogged
        // packet. That question is wrong. A recorder 2 MiB behind for forty
        // milliseconds is coming back; a phone that left the wifi is not. On
        // the live hub 2026-09-01 it cost 899 recorder deaths in 24 h (898 of
        // them ffmpeg `exitCode=0` — a clean EOF, because WE closed its input)
        // and the duplicate-at-respawn: each reconnect was served a pre-roll
        // that replayed footage already on disk.
        //
        // `isKeyframe` is the only honest heartbeat we have. A session that
        // still cannot be written at a keyframe AU missed its clean resume
        // point; one that misses MAX_MISSED_KEYFRAMES in a row is not behind,
        // it is gone. Closing is how we notice — nothing else reclaims it.
        if (isKeyframe) {
          this.missedKeyframes += 1
          if (this.missedKeyframes >= MAX_MISSED_KEYFRAMES) {
            this.close()
            return 'closed-backlog'
          }
        }
        this.droppingUntilKeyframe = true
        return 'dropped-backlog'
      }
    }

    this.writeInterleaved(this.tracks[0]!.rtpChannel, packet.data, packet.marker)
    // Proof of life: the budget is CONSECUTIVE misses, so a session that
    // recovers once per GOP must not accumulate its way to a close — that is
    // precisely the recorder's pattern under load.
    this.missedKeyframes = 0
    return 'written'
  }

  /** Send an audio RTP packet via TCP interleaved framing on the audio track channel. */
  sendAudioRtp(packet: RtpPacket): RtpWriteOutcome {
    if (!this.playing || this.closed || this.muted) return 'not-playing'
    if (this.tracks.length < 2) return 'not-playing' // no audio track set up

    // Audio carries no keyframes, so it cannot tell "behind" from "gone" — it
    // may only drop. Video owns the liveness verdict; closing here would
    // reintroduce the first-packet kill through the back door.
    if (this.socket.writableLength > MAX_WRITE_BUFFER) return 'dropped-backlog'

    // An audio packet is an access unit of its own: it ends the cork at once.
    this.writeInterleaved(this.tracks[1]!.rtpChannel, packet.data, true)
    return 'written'
  }

  /**
   * Write ONE interleaved frame as a 4-byte header plus the caller's payload,
   * **shared by reference** — the payload is never copied.
   *
   * ## Why this is the whole point
   *
   * This used to be `Buffer.allocUnsafe(4 + payload.length)` + `payload.copy()`:
   * a FULL copy of every packet, once per connected session, to prepend four
   * constant bytes. At ~3 000 pps ingest and 2–3 sessions per broker (detection
   * dial, recording dial, egress legs) that is ~6 000–9 000 full-packet
   * allocations per second, and `stream-broker` was measured at 95.5 % of a core
   * with **68 % of it in GC**. The same fundamental ring design can write the
   * header and the shared payload as two writes and do exactly one allocation
   * per packet, total, for every consumer. This closes that gap. N connected clients now cause ONE payload allocation (the ingest
   * copy), not N.
   *
   * ## Why sharing the payload is safe, and what would make it unsafe
   *
   * The payload is a view of the broker's packet slab (`slab-pool.ts`, D868),
   * never of the reader's socket buffer, which advances on the next read.
   * Nothing in the broker writes into a captured packet: every mutation in this
   * path targets a freshly allocated buffer. A slab is RECYCLED once the
   * broker's rings let go of it, and a queued socket write outlives that: Node
   * keeps the chunk behind a full kernel buffer for as long as the peer takes to
   * drain (seconds, for a recorder or a LAN decoder), and libuv reads the bytes
   * only when it writes. So the payload goes out through `writeHeld`, which
   * holds its slab until Node's write callback (success, error or destroy). A
   * write that skipped the hold would send a header promising N bytes followed
   * by zeros.
   *
   * The rule to keep: **`socket.write` forbids MUTATION before the write
   * completes, not retention.** So the header, which IS built per call, must
   * stay a fresh allocation — a reused 4-byte scratch buffer would be rewritten
   * under an in-flight write and corrupt the frame length of a packet already
   * queued. Four bytes from the Buffer pool is a pointer bump; the copy this
   * replaces was ~1.4 KB.
   *
   * ## One cork per ACCESS UNIT, not per packet
   *
   * The pair used to be corked and uncorked on its own: one `writev` per RTP
   * packet per session, so a 4K keyframe fragmented into a hundred packets and
   * fanned out to three sessions was three hundred syscalls for one picture no
   * decoder can use before it is whole. The socket is corked on the first write
   * of an access unit and uncorked by the packet that ENDS it
   * (`endOfAccessUnit`: the RTP marker on video, every audio packet), so the
   * picture leaves in one `writev`. A `process.nextTick` safety net uncorks
   * whatever is still open before the tick yields to I/O — a marker-less camera
   * or a lost marker degrades to one `writev` per tick, never to a socket held
   * corked across a read.
   *
   * Backpressure sees through the cork: `writableLength` counts corked bytes,
   * so the `MAX_WRITE_BUFFER` gate, the latch and the missed-keyframe close
   * (D447) judge exactly what they judged per packet.
   */
  private writeInterleaved(channel: number, payload: Buffer, endOfAccessUnit: boolean): void {
    const header = Buffer.allocUnsafe(4)
    header[0] = INTERLEAVED_MAGIC
    header[1] = channel
    header.writeUInt16BE(payload.length, 2)

    if (!this.accessUnitCorked) {
      this.accessUnitCorked = true
      this.socket.cork()
      process.nextTick(this.uncorkAccessUnit)
    }
    this.socket.write(header)
    writeHeld(this.socket, payload)
    if (endOfAccessUnit) this.uncorkAccessUnit()

    this.lastRtpAt = Date.now()
    this.bytesSent += 4 + payload.length
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.playing = false
    try {
      this.socket.destroy()
    } catch {
      /* already closed */
    }
    this.onClose?.()
  }

  private processBuffer(): void {
    while (true) {
      // Skip any interleaved data from client (starts with $)
      if (this.buffer.length > 0 && this.buffer.charCodeAt(0) === INTERLEAVED_MAGIC) {
        if (this.buffer.length < 4) return
        const len = (this.buffer.charCodeAt(2) << 8) | this.buffer.charCodeAt(3)
        if (this.buffer.length < 4 + len) return
        this.buffer = this.buffer.slice(4 + len)
        continue
      }

      const endIdx = this.buffer.indexOf('\r\n\r\n')
      if (endIdx < 0) return

      const requestText = this.buffer.slice(0, endIdx)
      this.buffer = this.buffer.slice(endIdx + 4)

      const request = this.parseRequest(requestText)
      if (request) {
        if (this.userAgent === null) this.userAgent = request.headers.get('user-agent') ?? null
        this.handleRequest(request)
      }
    }
  }

  private parseRequest(text: string): RtspRequest | null {
    const lines = text.split('\r\n')
    const firstLine = lines[0]
    if (!firstLine) return null

    const parts = firstLine.split(' ')
    if (parts.length < 3) return null

    const headers = new Map<string, string>()
    for (let i = 1; i < lines.length; i++) {
      const colonIdx = lines[i]!.indexOf(':')
      if (colonIdx < 0) continue
      const key = lines[i]!.slice(0, colonIdx).trim().toLowerCase()
      const value = lines[i]!.slice(colonIdx + 1).trim()
      headers.set(key, value)
    }

    return {
      method: parts[0]!,
      uri: parts[1]!,
      cseq: parseInt(headers.get('cseq') ?? '0', 10),
      headers,
    }
  }

  private handleRequest(req: RtspRequest): void {
    switch (req.method) {
      case 'OPTIONS':
        return this.handleOptions(req)
      case 'DESCRIBE':
        return this.handleDescribe(req)
      case 'SETUP':
        return this.handleSetup(req)
      case 'PLAY':
        return this.handlePlay(req)
      case 'TEARDOWN':
        return this.handleTeardown(req)
      case 'GET_PARAMETER':
        return this.respond(req, 200, 'OK')
      default:
        return this.respond(req, 405, 'Method Not Allowed')
    }
  }

  private handleOptions(req: RtspRequest): void {
    this.respond(req, 200, 'OK', {
      Public: RTSP_METHODS.join(', '),
    })
  }

  private handleDescribe(req: RtspRequest): void {
    this.respond(
      req,
      200,
      'OK',
      {
        'Content-Type': 'application/sdp',
        'Content-Length': String(Buffer.byteLength(this.sdp)),
      },
      this.sdp,
    )
  }

  private handleSetup(req: RtspRequest): void {
    const transport = req.headers.get('transport') ?? ''
    const interleavedMatch = transport.match(/interleaved=(\d+)-(\d+)/)
    const rtpChannel = interleavedMatch ? parseInt(interleavedMatch[1]!, 10) : 0
    const rtcpChannel = interleavedMatch ? parseInt(interleavedMatch[2]!, 10) : 1

    this.tracks.push({ trackId: this.tracks.length, rtpChannel, rtcpChannel })

    this.respond(req, 200, 'OK', {
      Transport: `RTP/AVP/TCP;unicast;interleaved=${rtpChannel}-${rtcpChannel}`,
      Session: this.sessionId,
    })
  }

  private handlePlay(req: RtspRequest): void {
    this.playing = true
    // Stamped on the FIRST PLAY only: a client that re-issues PLAY (a seek, a
    // keep-alive that some stacks send as PLAY) must not reset the clock the
    // join is measured against, or a slow start would read as a fast one.
    if (this.playAt === 0) this.playAt = Date.now()
    this.respond(req, 200, 'OK', {
      Session: this.sessionId,
      Range: 'npt=0.000-',
    })
  }

  private handleTeardown(req: RtspRequest): void {
    this.respond(req, 200, 'OK')
    this.close()
  }

  private respond(
    req: RtspRequest,
    code: number,
    reason: string,
    headers?: Record<string, string>,
    body?: string,
  ): void {
    if (this.closed) return

    let response = `RTSP/1.0 ${code} ${reason}\r\nCSeq: ${req.cseq}\r\n`
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        response += `${k}: ${v}\r\n`
      }
    }
    response += '\r\n'
    if (body) response += body

    this.socket.write(response)
  }
}
