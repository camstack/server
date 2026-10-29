/**
 * Minimal type declarations for the werift module shapes actually used.
 *
 * werift is dynamically imported (optional peer dependency) and has no
 * published type definitions. These types are just enough to eliminate
 * cascading `any` through the session files — they do NOT aim to be
 * exhaustive.
 */

// ---------------------------------------------------------------------------
// RTP primitives
// ---------------------------------------------------------------------------

export interface WeriftRtpHeader {
  payloadType: number
  timestamp: number
  marker: boolean
  sequenceNumber: number
  padding: boolean
  ssrc: number
}

export interface WeriftRtpPacket {
  header: WeriftRtpHeader
  payload: Buffer
  serialize(): Buffer
  clone(): WeriftRtpPacket
}

// ---------------------------------------------------------------------------
// Media / Codec
// ---------------------------------------------------------------------------

export interface WeriftMediaStreamTrack {
  kind: 'video' | 'audio'
  onReceiveRtp: { subscribe(cb: (pkt: WeriftRtpPacket) => void): void }
}

export interface WeriftRtpCodecParameters {
  mimeType: string
  clockRate: number
  payloadType: number
  channels?: number
  parameters?: string
}

// ---------------------------------------------------------------------------
// Transceiver / Sender
// ---------------------------------------------------------------------------

/**
 * A single ICE candidate as werift's `Candidate` class exposes it
 * (`werift/lib/ice/src/candidate.d.ts`). `type` is the candidate kind
 * (`host` | `srflx` | `prflx` | `relay`); `host`/`port` are the
 * transport address. Used by the nominated-pair diagnostic.
 */
export interface WeriftCandidateAddress {
  type: string
  host: string
  port: number
}

/**
 * The nominated (selected) candidate pair on a connected ICE
 * connection. werift's `CandidatePair` exposes `localCandidate` /
 * `remoteCandidate` getters returning `Candidate`. We only read the
 * three fields the diagnostic needs.
 */
export interface WeriftCandidatePairSelected {
  localCandidate: WeriftCandidateAddress
  remoteCandidate: WeriftCandidateAddress
}

/**
 * werift's ICE `Connection` (`IceConnection`). `nominated` is set once
 * ICE picks a working pair — undefined until the pair is nominated.
 */
export interface WeriftIceConnection {
  nominated?: WeriftCandidatePairSelected
}

/** werift's `RTCIceTransport` — carries the live ICE `connection`. */
export interface WeriftIceTransport {
  connection?: WeriftIceConnection
}

export interface WeriftRtpSender {
  sendRtp(pkt: WeriftRtpPacket | Buffer): void
  /**
   * Sync the sender's internal SSRC, sequence number, and timestamp
   * with those of an incoming RTP header. Must be called on the first
   * packet to align the sender's state with the packets we're crafting.
   * Without this the browser may ignore our packets.
   */
  replaceRTP(
    header: Pick<WeriftRtpHeader, 'sequenceNumber' | 'timestamp'>,
    discontinuity?: boolean,
  ): void
  replaceTrack(track: WeriftMediaStreamTrack): Promise<void>
  /**
   * werift's NACK history (`rtpCache`, `RTP_HISTORY_SIZE` slots, patched to
   * 4096). Declared `private` upstream; the memory probe only READS it.
   */
  readonly rtpCache?: readonly (WeriftRtpPacket | undefined)[]
  track: WeriftMediaStreamTrack | null
  /**
   * The DTLS transport carries the ICE transport, which holds the live
   * ICE `connection` (and its nominated candidate pair). Optional —
   * werift may not have wired it before DTLS connects.
   */
  dtlsTransport?: { state: string; iceTransport?: WeriftIceTransport }
  /**
   * The codec werift is sending packets with. Writable: assigning a
   * `WeriftRtpCodecParameters` entry (looked up from
   * `transceiver.codecs`) before `createAnswer` forces werift to tag
   * outgoing RTP with that PT. Required when the source is HEVC —
   * without it werift would settle the sender on the first browser-
   * preferred PT (H.264), and PT-mismatched RTP packets never decode in
   * Chrome's depacketizer.
   */
  codec?: WeriftRtpCodecParameters
  ssrc?: number
  lastReceiverReport?: WeriftReceiverReport
  rtcpReport?: WeriftReceiverReport
  /** RTCP feedback events (PLI, FIR, NACK). Werift emits these when the
   *  remote peer sends RTCP feedback packets. Not all werift versions
   *  expose this — callers must null-check. */
  onPictureLossIndication?: { subscribe(cb: () => void): void }
  onRtcpFeedback?: { subscribe(cb: (feedback: { type: string; parameter?: string }) => void): void }
  /** All received RTCP packets. Receiver Reports (and Sender Reports) carry a
   *  `reports[]` array with the remote receiver's fractionLost / packetsLost /
   *  jitter. werift parses but does NOT persist these (lastReceiverReport is
   *  never populated upstream), so we subscribe here and stash the latest RR
   *  for the media diagnostics. Optional — null-check. */
  onRtcp?: {
    subscribe(cb: (rtcp: { reports?: ReadonlyArray<WeriftReceiverReport> }) => void): void
  }
  /**
   * The peer's own estimate of how much we may send it, in bits per second —
   * REMB (`goog-remb`), which werift parses and STORES on the sender.
   *
   * We have advertised `goog-remb` in every SDP for as long as there has been
   * one, and never read it back. It matters because a consumer can be silent
   * on receiver reports and still send this: Alexa sent no RR at all across
   * 1483 packets (measured 2026-09-13), and whether it sends REMB is the
   * question that decides whether an adaptive ladder is buildable for it.
   *
   * `bigint`, because that is werift's type. Absent until a REMB arrives.
   */
  receiverEstimatedMaxBitrate?: bigint
}

export type WeriftTransceiverDirection = 'sendonly' | 'recvonly' | 'sendrecv' | 'inactive'

export interface WeriftTransceiver {
  mid: string
  sender: WeriftRtpSender
  receiver: { track: WeriftMediaStreamTrack | null }
  kind?: string
  /**
   * The codec list werift populated from intersecting the remote
   * description's m-line with our configured `pcOptions.codecs`. After
   * `setRemoteDescription` we look up the desired codec entry here
   * (e.g. `video/H265` when the source is HEVC) and assign it to
   * `sender.codec`, so outgoing RTP carries the right PT even when
   * werift's `createAnswer` would otherwise pick the first browser-
   * preferred (H.264) PT from the offer order. Optional — werift may
   * expose it only after `setRemoteDescription`.
   */
  codecs?: ReadonlyArray<WeriftRtpCodecParameters>
  /**
   * Set the transceiver's negotiated direction (RFC 8829 §4.2.4). The
   * `direction` property is getter-only in werift — this is the only way
   * to force a direction. Required on the client-offer answer path: a
   * browser offers `recvonly`, so the server transceiver must be set
   * `sendonly` or werift answers `inactive` (port 0) and empties the
   * BUNDLE group, which Chrome rejects.
   */
  setDirection(direction: WeriftTransceiverDirection): void
  onTrack: { subscribe(cb: (track: WeriftMediaStreamTrack) => void): void }
}

// ---------------------------------------------------------------------------
// RTCP stats
// ---------------------------------------------------------------------------

export interface WeriftReceiverReport {
  ssrc?: number
  fractionLost?: number
  packetsLost?: number
  cumulativeLost?: number
  /** Extended highest sequence number received — together with packetsLost
   *  drives the adaptive controller's per-interval loss-ratio computation
   *  (Δlost / Δseq). Present on werift's RtcpReceiverInfo. */
  highestSequence?: number
  jitter?: number
  roundTripTime?: number
  rtt?: number
}

// ---------------------------------------------------------------------------
// PeerConnection
// ---------------------------------------------------------------------------

export interface WeriftIceServer {
  urls: string
  username?: string
  credential?: string
}

export interface WeriftPcOptions {
  codecs?: {
    video?: WeriftRtpCodecParameters[]
    audio?: WeriftRtpCodecParameters[]
  }
  headerExtensions?: {
    video?: Array<{ uri: string }>
    audio?: Array<{ uri: string }>
  }
  iceServers?: WeriftIceServer[]
  icePortRange?: [number, number]
  iceAdditionalHostAddresses?: string[]
  /** Whether werift gathers IPv4 host candidates. Default true. */
  iceUseIpv4?: boolean
  /** Whether werift gathers IPv6 host candidates. Default true.
   *  Set `false` for peers that document IPv4-only ICE (Alexa Smart Home
   *  RTC: "you must use IPv4"); emitting unusable IPv6 candidates wastes
   *  the peer's per-SDP candidate budget. */
  iceUseIpv6?: boolean
  /** "relay" forces ICE to use only TURN relay candidates (drops host/srflx).
   *  Used for client-offer (Alexa) sessions whose peer is always a cloud
   *  media server unreachable via host/srflx behind NAT. */
  iceTransportPolicy?: 'all' | 'relay'
  /** Called per candidate pair werift evaluates; return false to skip it.
   *  Used for diagnostics (log which pairs are tried) and to ban/force
   *  candidate types. */
  iceFilterCandidatePair?: (pair: WeriftCandidatePair) => boolean
  /** Called once per inbound STUN binding request; return false to drop it.
   *  The inbound-check probe observes through it and always returns true. */
  iceFilterStunResponse?: (
    message: unknown,
    addr: readonly [string, number],
    protocol: unknown,
  ) => boolean
}

export interface WeriftIceCandidateInfo {
  type?: string
  host?: string
  port?: number
  relatedAddress?: string
}

export interface WeriftCandidatePair {
  localCandidate: WeriftIceCandidateInfo
  remoteCandidate: WeriftIceCandidateInfo
  protocol?: { type?: string }
}

export interface WeriftDataChannel {
  label: string
  readyState: string
  send(data: Buffer | string): void
  /** werift surfaces inbound data-channel payloads via `onMessage`
   *  (Event<[string | Buffer]>), NOT a `message` field. */
  onMessage: { subscribe(cb: (msg: string | Buffer) => void): void }
}

export interface WeriftSessionDescription {
  sdp: string
  type: string
}

/** A trickle ICE candidate surfaced by werift's `onIceCandidate`. */
export interface WeriftIceCandidate {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

export interface WeriftPeerConnection {
  iceConnectionState: string
  iceGatheringState: string
  connectionState: string
  localDescription: { sdp: string } | null

  iceConnectionStateChange: { subscribe(cb: (state: string) => void): void }
  iceGatheringStateChange: { subscribe(cb: (state: string) => void): void }
  /** Fires per gathered local ICE candidate (trickle); `undefined` signals
   *  gathering complete. Used to trickle the server's candidates to the client. */
  onIceCandidate: { subscribe(cb: (candidate: WeriftIceCandidate | undefined) => void): void }
  /** Fires when the remote peer opens a data channel (werift Event<[RTCDataChannel]>). */
  onDataChannel: { subscribe(cb: (channel: WeriftDataChannel) => void): void }

  createDataChannel(label: string, opts?: { ordered?: boolean }): WeriftDataChannel
  addTransceiver(track: WeriftMediaStreamTrack, opts?: { direction: string }): WeriftTransceiver
  getTransceivers(): WeriftTransceiver[]
  getSenders(): WeriftRtpSender[]

  createOffer(): Promise<WeriftSessionDescription>
  createAnswer(): Promise<WeriftSessionDescription>
  setLocalDescription(desc: WeriftSessionDescription): Promise<void>
  setRemoteDescription(desc: WeriftSessionDescription): Promise<void>
  addIceCandidate(candidate: unknown): Promise<void>

  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Module shape (the default export from `import("werift")`)
// ---------------------------------------------------------------------------

export interface WeriftModule {
  RTCPeerConnection: new (opts: WeriftPcOptions) => WeriftPeerConnection
  RTCRtpCodecParameters: new (opts: {
    mimeType: string
    clockRate: number
    payloadType: number
    channels?: number
    parameters?: string
    rtcpFeedback?: Array<{ type: string; parameter?: string }>
  }) => WeriftRtpCodecParameters
  MediaStreamTrack: new (opts: { kind: 'video' | 'audio' }) => WeriftMediaStreamTrack
  RTCSessionDescription: new (sdp: string, type: string) => WeriftSessionDescription
  RTCIceCandidate: new (candidate: unknown) => unknown
  RtpHeader: new () => WeriftRtpHeader
  RtpPacket: (new (
    header: WeriftRtpHeader,
    payload: Buffer,
  ) => WeriftRtpPacket) & {
    deSerialize(buf: Buffer): WeriftRtpPacket
  }
}
