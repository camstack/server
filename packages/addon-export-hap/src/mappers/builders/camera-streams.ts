/**
 * Camera streams builder — implements a `CameraStreamingDelegate` that
 * bridges camstack's RTSP restream output to HomeKit's SRTP transport
 * via a per-session ffmpeg child process.
 *
 * Audio model:
 *  - Downstream (cam → iPhone): ffmpeg pulls the RTSP source and emits
 *    Opus over the HAP-negotiated audio SRTP socket. A single ffmpeg
 *    child handles video + audio via two `-f rtp` output URLs. The
 *    JS-side `forwardEncryptedRtp` loopback handler SRTP-encrypts each
 *    ffmpeg-emitted packet, re-stamps the audio RTP timestamp/SSRC/PT
 *    to match what we advertised in `prepareStream`, and emits the
 *    periodic RTCP Sender Report iOS needs to anchor its AV clock.
 *    Sender Reports go out on BOTH legs, each at its own negotiated
 *    `rtcp_interval` — see `sendRtcpSr`.
 *  - Upstream (iPhone → cam, press-to-talk): inbound iOS-mic Opus
 *    arrives over SRTP on our advertised audio port, we decrypt, and
 *    forward the raw Opus frame straight to the `intercom` cap via
 *    `pushTalkAudio({codec:'opus', sampleRate, sequenceNumber, ...})`.
 *    The provider owns decode + resample + camera-side encode — this
 *    builder is decode-agnostic (does NOT open a codec session itself).
 *
 * Delegate surface (`CameraStreamingDelegate`):
 *  - Snapshot: routes to the camstack `snapshot` cap. Returns the JPEG
 *    buffer untouched.
 *  - prepareStream: allocates UDP sockets for video + audio (iOS-facing
 *    + loopback for ffmpeg), generates per-leg SRTP sessions from the
 *    HAP-negotiated key/salt pair, allocates the SSRCs we'll advertise
 *    back to iOS, and echoes them in the PrepareStreamResponse.
 *  - handleStreamRequest:
 *      - `start`: picks the operator-preferred RTSP entry, spawns
 *        ffmpeg with `-c:v copy` for H.264 sources (transcode for
 *        H.265 since iOS Home only renders H.264 over the SRTP path),
 *        and `libopus -application lowdelay` for audio.
 *      - `stop`: SIGTERM ffmpeg, then SIGKILL after 2 s; closes all
 *        sockets and the camera-side intercom talk session.
 *      - `reconfigure`: stop → start with merged params.
 *
 * The factory builds the `CameraStreamingDelegate` AND the
 * `CameraStreamingOptions` blob (codec / resolution / SRTP suite
 * caps) the controller needs at construction time. The orchestrator
 * passes both into `new CameraController({...})`.
 */
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { buildFfmpegArgs } from '@camstack/types'
import {
  AudioBitrate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  type CameraStreamingDelegate,
  type CameraStreamingOptions,
  H264Level,
  H264Profile,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
  type PrepareStreamResponse,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  type SourceResponse,
  SRTPCryptoSuites,
  type StreamingRequest,
  type StreamRequestCallback,
} from '@homebridge/hap-nodejs'
import {
  ProtectionProfileAes128CmHmacSha1_80,
  RtcpSenderInfo,
  RtcpSrPacket,
  RtpPacket,
  SrtcpSession,
  SrtpSession,
} from 'werift-rtp'

import type { BuilderContext } from '../types.js'
import { makeRtcpGate, type RtcpGateResolution } from './rtcp-gate.js'
import {
  type ControllerReceiverReport,
  emptyReceiverReportTally,
  ingestDecryptedRtcp,
  type ReceiverReportTally,
  recordUnreadableRtcp,
} from './rtcp-receiver-report.js'
import {
  buildVideoPlan,
  formatFitNotes,
  encodeBudgetKbps,
  selectStreamForBudget,
  withSlotCodecs,
} from './stream-bitrate.js'
import { probeProfileBitrates } from './stream-bitrate-probe.js'
import { passthroughRequest } from './passthrough-request.js'
import { classifyConnection } from './stream-connection.js'
import { buildSessionInvocation, OPUS_BITRATE_KBPS } from './stream-ffmpeg-args.js'
import { type ProfileFpsSource, toHapResolutions } from './stream-fps.js'
import { type KeyframeCodec, rtpPacketCarriesKeyframe } from './h264-idr.js'
import { probe, type AdvertisedVideoProfile } from './stream-fps-probe.js'
import {
  type HwDecodeDecision,
  selectHwDecode,
  shouldRetryInSoftware,
  software,
} from './stream-hwaccel.js'
import { withDeadline } from './deadline.js'
import { decoderInfoSourceFromContext, probeDecoderHwaccel } from './stream-hwaccel-probe.js'
import {
  applyReceiveBuffer,
  AUDIO_LOOPBACK_RCVBUF_BYTES,
  mergeDropSample,
  readUdpSocketDrops,
  type ReceiveBufferOutcome,
  VIDEO_LOOPBACK_RCVBUF_BYTES,
} from './stream-socket-buffer.js'

/** A decoder that is slow to describe itself costs hardware decode, not the session. */
const HWACCEL_PROBE_BUDGET_MS = 1_000
import {
  classifyInboundPacket,
  type DropCounters,
  emptyDropCounters,
  type FfmpegExitInfo,
  type NegotiatedStreamParams,
  recordDrop,
  type SelectedSlotInfo,
  type StreamDropReason,
  summariseSession,
} from './stream-telemetry.js'

const SRTP_KEY_LEN = 16
const SRTP_SALT_LEN = 14

/**
 * Cadence of the per-session heartbeat log.
 *
 * This timer LOGS ONLY. It never kills ffmpeg, never closes a socket and never
 * ends a session. That distinction matters: the two mainstream open-source
 * HomeKit camera stacks arm an idle watchdog that tears the stream down at
 * exactly 30 000 ms, and the ~31 s teardown here was misdiagnosed as one for a
 * long time before it was proven that this accessory has no such timer. Do not
 * make this one act.
 */
const SESSION_HEARTBEAT_MS = 5_000

/**
 * Floor between two `export-hap: controller receiver report` lines on one leg.
 *
 * The controller sends several Receiver Reports a second — 21 and 34 in two
 * ~10 s sessions on 2026-08-06 — and every one of them at `info` would drown
 * the very line it is meant to make findable. The FIRST report on each leg is
 * always logged, in full and under its own message; after that this throttles
 * to the heartbeat's cadence so a session still produces a running record of
 * what the controller thinks without becoming one.
 */
const RECEIVER_REPORT_LOG_INTERVAL_MS = 5_000

/** HAP's profile/level enums are numeric; ffmpeg wants their names. */
const HAP_PROFILE_NAMES: Readonly<Record<number, 'baseline' | 'main' | 'high'>> = {
  0: 'baseline',
  1: 'main',
  2: 'high',
}
const HAP_LEVEL_NAMES: Readonly<Record<number, '3.1' | '3.2' | '4.0'>> = {
  0: '3.1',
  1: '3.2',
  2: '4.0',
}

interface StartParams {
  readonly pt: number
  readonly mtu: number
  readonly audioPt: number
  readonly audioSsrc: number
  /** The H.264 profile and level the controller SELECTED, kept for the
   *  reconfigure path — that message carries size, rate and ceiling only. */
  readonly profile: H264Profile
  readonly level: H264Level
  /**
   * HAP-negotiated audio sample-rate enum value (AudioStreamingSamplerate:
   * 0 = 8 kHz, 1 = 16 kHz, 2 = 24 kHz). Drives the RTP timestamp scale we
   * impose on each outgoing audio packet — iOS requires monotonic Opus
   * timestamps anchored to the negotiated rate, not whatever ffmpeg
   * derives from the source clock.
   */
  readonly audioSampleRateEnum: number
  /**
   * Packet time in milliseconds. iOS picks 20 on LAN and may pick 30 / 40
   * / 60 on LTE. We pass this straight to ffmpeg's `-frame_duration` and
   * use it in the timestamp formula.
   */
  readonly audioPacketTimeMs: number
}

interface SessionState {
  readonly sessionId: string
  /**
   * The local interface address the iOS-facing sockets were bound to.
   *
   * Kept here because `prepareStream` is the only place that decides it
   * (`pickLocalInterfaceIp`, matched to the controller's subnet) and the new
   * service's `Setup Endpoints` response has to report it. A second caller
   * recomputing the same thing would be a second authority for one fact — and
   * an address that disagrees with the socket is a stream that never arrives.
   *
   * The classic path does not read this: hap-nodejs fills the address in from
   * the HAP connection, and changing that is a behaviour change on a working
   * path for no measured reason.
   */
  readonly localAddress: string
  /**
   * Which service negotiated this session.
   *
   * It decides what may be passed through: the classic HAP SRTP path renders
   * H.264 only, while Apple's multi-tier RTP service advertises H.265 in its
   * tiers. The same camera serves both, so the permission cannot live on the
   * camera — it belongs to the session, and this is where it is recorded.
   */
  readonly negotiatedVia: 'classic' | 'multi-tier'
  /**
   * What we are really putting ON THE WIRE, for the key-frame counter.
   *
   * Not the source's codec and not the tier's: a transcode always emits H.264
   * whatever it read. Set at `start`, because before one nothing is flowing.
   */
  wireCodec: KeyframeCodec
  // ── Telemetry ──────────────────────────────────────────────────────
  // Everything below exists so ONE log line can answer "why did this
  // session die". Before it, a session produced `stream started` and
  // `ffmpeg exited` and nothing else, so the negotiated parameters, the
  // controller's return traffic and every dropped packet had to be guessed.
  /** `Date.now()` of the first successful `handleStreamRequest('start')`. */
  startedAtMs: number | null
  /** `Date.now()` of the controller's `stop` (or of dispose). */
  endedAtMs: number | null
  /** Parameters the controller actually agreed to at `start`. */
  negotiated: NegotiatedStreamParams | null
  /** Slot the picker chose, and the rate we had advertised for it. */
  selectedSlot: SelectedSlotInfo | null
  ffmpegExit: FfmpegExitInfo | null
  /** Set when the teardown came from the controller rather than from us. */
  stopRequestedByController: boolean
  /**
   * Why the session is being torn down, set BEFORE `killFfmpeg` so the
   * asynchronous ffmpeg `exit` handler — the only place the exit code is
   * known — can name the trigger correctly. Null while the session is live;
   * an exit with it still null is ffmpeg dying on its own.
   */
  teardownTrigger: string | null
  /** Named tally of every branch that discarded work. */
  drops: DropCounters
  videoPacketsForwarded: number
  audioPacketsForwarded: number
  /**
   * Key-frame arrival on the FORWARDED video leg. A pass-through session can
   * only relay the IDR the camera chooses to emit, so the wait for the first
   * one is the difference between a broken stream and a slow one.
   */
  videoKeyframes: number
  firstKeyframeAtMs: number | null
  lastKeyframeAtMs: number | null
  maxKeyframeGapMs: number
  videoRtcpSrSent: number
  audioRtcpSrSent: number
  /** RTCP the CONTROLLER sent us on the video return port. */
  videoRtcpReceived: number
  audioRtcpReceived: number
  videoRtpReceived: number
  audioRtpReceived: number
  /**
   * What the controller SAID, per leg, not merely that it spoke.
   *
   * Counting inbound RTCP settled "does iOS probe us" (it does, on the video
   * leg). It cannot settle the next question, which is whether iOS is
   * receiving our packets intact — and that answer lives inside the Receiver
   * Reports these tallies fold up.
   */
  videoReceiverReports: ReceiverReportTally
  audioReceiverReports: ReceiverReportTally
  /** `Date.now()` of the last receiver-report line emitted for each leg. */
  videoRrLoggedAt: number
  audioRrLoggedAt: number
  /** Resolved gate outcome per leg — `packet` or `timeout`, never merged. */
  videoGate: RtcpGateResolution | null
  audioGate: RtcpGateResolution | null
  heartbeat: NodeJS.Timeout | null
  // Video leg
  readonly hapVideoPort: number
  readonly hapAddress: string
  readonly videoSrtpKey: Buffer
  readonly videoSrtpSalt: Buffer
  /**
   * Socket we advertise to iOS as the return port. Bound to a real
   * local interface IP (not 0.0.0.0) so iOS's RTCP packets land here
   * — they validate the SRTP path before iOS commits to displaying
   * the stream. We also USE this same socket to send encrypted SRTP
   * to (hapAddress, hapVideoPort) — symmetric port keeps iOS happy.
   */
  readonly videoUdp: UdpSocket
  /**
   * Loopback socket on 127.0.0.1 where ffmpeg writes plain RTP. We
   * read each packet, SRTP-encrypt via `videoOutSrtp`, then send via
   * `videoUdp` to iOS. ffmpeg's own `-srtp_out_params` would create a
   * separate (unowned) socket with no return path for iOS RTCP.
   */
  readonly videoLoopUdp: UdpSocket
  /** Outbound video SRTP session (encrypt direction). */
  videoOutSrtp: SrtpSession | null
  /**
   * SRTCP session that encrypts Sender Reports for the VIDEO leg.
   *
   * HAP negotiates a minimum RTCP interval PER LEG — `MIN_RTCP_INTERVAL`
   * appears in the video RTP-parameter TLV exactly as it does in the audio
   * one, and surfaces as `request.video.rtcp_interval`. A controller does
   * not negotiate an interval for a leg it expects nothing on: without a
   * Sender Report the controller has no (NTP, RTP) pair to anchor the video
   * clock against, and the receiver reports it sends back carry loss and
   * jitter figures that reference nothing.
   */
  videoOutSrtcp: SrtcpSession | null
  /**
   * SRTCP context that DECRYPTS the controller's Receiver Reports on the video
   * leg. Deliberately a second object rather than the outbound one: werift
   * keeps a replay window and a rollover counter per direction, and a single
   * session shared by both would make an inbound fault look like an outbound
   * one. HAP wraps both directions of a leg in the same master key/salt, which
   * is why the key material is identical.
   */
  videoInSrtcp: SrtcpSession | null
  /** Cumulative video packet count for the RTCP SR payload. */
  videoOutPacketCount: number
  /** Cumulative video octet count for the RTCP SR payload. */
  videoOutOctetCount: number
  /** Last RTP timestamp emitted on the video leg, for the SR's
   *  `rtpTimestamp` field. Passed through from ffmpeg unchanged — the
   *  90 kHz source clock is already what the controller expects. */
  videoOutLastRtpTimestamp: number
  /** `Date.now()` of the last video RTCP SR transmission. */
  videoOutLastRtcpAt: number
  /** `video.rtcp_interval` from the HAP request, in milliseconds. */
  videoRtcpIntervalMs: number
  /** Video SSRC we advertise to iOS in `prepareStream`'s response —
   *  ffmpeg's `-ssrc` argument MUST match so iOS recognises the
   *  packets as the stream it asked for. */
  readonly videoSsrc: number
  /** Promise that resolves once we've seen the first packet on
   *  `videoUdp` (iOS's RTCP probe) OR a 1 s timeout fires. Read by the
   *  loopback handler before flushing the encrypted RTP — iOS 15.5+
   *  silently drops a stream that starts before the gate releases.
   *  Resolves with WHICH of the two happened; see `rtcp-gate.ts`. */
  videoSendGate: Promise<RtcpGateResolution> | null
  // Audio leg (downstream — ffmpeg sends to controller)
  readonly hapAudioPort: number
  readonly audioSrtpKey: Buffer
  readonly audioSrtpSalt: Buffer
  readonly audioUdp: UdpSocket
  /** Loopback socket for ffmpeg's audio RTP — same role as
   *  `videoLoopUdp`. */
  readonly audioLoopUdp: UdpSocket
  /** Outbound audio SRTP session (encrypt direction). */
  audioOutSrtp: SrtpSession | null
  /**
   * SRTCP session that encrypts Sender Reports for the audio leg. iOS
   * Home will silently mute the camera speaker if it never receives an
   * RTCP Sender Report carrying the current `rtpTimestamp` against an
   * `ntpTimestamp` it can use to align playback — the SRTP audio
   * packets alone aren't enough.
   */
  audioOutSrtcp: SrtcpSession | null
  /** Inbound SRTCP context for the audio leg — see `videoInSrtcp`. */
  audioInSrtcp: SrtcpSession | null
  /** RTCP gate on the audio path. */
  audioSendGate: Promise<RtcpGateResolution> | null
  // Common
  readonly ipVersion: 'ipv4' | 'ipv6'
  /**
   * What the kernel granted each loopback socket, and what it discarded.
   *
   * These are the two facts the 93-video-packets-vs-1497-audio measurement
   * could not be settled without: a datagram dropped for a full `SO_RCVBUF`
   * never reaches a `message` handler, so it lowers `videoPacketsForwarded`
   * exactly like a packet ffmpeg never wrote. See `stream-socket-buffer.ts`.
   */
  readonly videoLoopRcvbuf: ReceiveBufferOutcome
  readonly audioLoopRcvbuf: ReceiveBufferOutcome
  /** Local port of each loopback socket — the key into `/proc/net/udp`. */
  readonly videoLoopPort: number
  readonly audioLoopPort: number
  /** Last sampled kernel drop count. `null` = we could not look. */
  videoLoopKernelDrops: number | null
  audioLoopKernelDrops: number | null
  ffmpeg: ChildProcess | null
  lastStartParams: StartParams | null
  // Upstream audio (talk-back) — raw Opus frames forwarded to the
  // camera via the `intercom` cap (`startTalkSession`/`pushTalkAudio`/
  // `endTalkSession`). The provider owns decode + resample + camera-side
  // encode; export-hap is decode-agnostic.
  /**
   * SRTP session used to DECRYPT inbound iPhone-mic audio packets. The
   * HAP `prepareStream` callback hands us the master key/salt the iOS
   * controller will use to encrypt its outbound RTP. We build the
   * session once on `prepareStream` and call `decrypt` on each inbound
   * UDP packet before parsing the Opus payload. werift's
   * `SrtpSession.decrypt` uses the "remote" key — same as our local key
   * since iOS Home shares one master key per direction.
   */
  upstreamAudioSrtp: SrtpSession | null
  /** Set once `intercom.startTalkSession` resolves. Null when the
   *  device doesn't expose the `intercom` cap (downstream-only audio). */
  intercomTalkSessionId: string | null
  /** Monotonic counter shipped with every `pushTalkAudio` so the
   *  provider can reject out-of-order frames. Bumped per Opus frame
   *  forwarded. */
  intercomPcmSequence: number
  upstreamRtpPacketsReceived: number
  upstreamRtpPacketsDecrypted: number
  upstreamRtpDecryptFailures: number
  upstreamPcmFramesDecoded: number
  /** Anchored to the first RTP timestamp for monotonic PTS deltas. */
  firstUpstreamRtpTimestamp: number | null
  /**
   * First RTP timestamp ffmpeg ever emitted on the audio leg. Subsequent
   * outgoing packets are re-stamped as `firstAudioTimestamp + packetCount
   * * 160 * audioIntervalScale`, the formula iOS expects from an HAP
   * Opus stream. Without this, ffmpeg's encoder-clock timestamps survive
   * to the wire and iOS silently mutes the speaker.
   */
  firstAudioOutTimestamp: number | null
  /** Monotonic counter of audio packets we have emitted to iOS. */
  audioOutPacketCount: number
  /**
   * Pre-computed `(sampleRateMultiplier × packetTime / 20)` so the per-
   * packet timestamp update is a single multiply-add. Set on the first
   * `handleStreamRequest('start')` once we know the negotiated rate and
   * packet time.
   */
  audioIntervalScale: number
  /**
   * SSRC iOS Home expects on every audio RTP packet AND every audio
   * RTCP Sender Report — generated once at `prepareStream` and ADVERTISED
   * to iOS in the `PrepareStreamResponse.audio.ssrc` field. iOS keys its
   * inbound jitter buffer on this value; sending audio with any other
   * SSRC is silently dropped on the iOS side (the speaker stays mute
   * even though SRTP decrypts cleanly). NOT to be confused with
   * `request.audio.ssrc`, which is the SSRC iOS uses for its OWN
   * outbound (mic talk-back) leg. We override the SSRC the parsed RTP
   * packet carries because the ffmpeg-generated value drifts with
   * encoder reinit; forcing it at forward time keeps every packet
   * pinned to the advertised value.
   */
  audioOutSsrc: number
  /** Cumulative audio packet count for the RTCP SR payload. */
  audioOutOctetCount: number
  /** Last RTP timestamp we emitted, for the RTCP SR `rtpTimestamp` field. */
  audioOutLastRtpTimestamp: number
  /** `Date.now()` of the last RTCP SR transmission. */
  audioOutLastRtcpAt: number
  /** `audio.rtcp_interval` from the HAP request, in milliseconds. */
  audioRtcpIntervalMs: number
}

/** What `Setup Endpoints` has to report back on the new service. */
export interface PreparedEndpoint {
  /** The interface the sockets are really bound to — see `SessionState`. */
  readonly localAddress: string
  readonly videoPort: number
  readonly audioPort: number
  readonly videoSsrc: number
  readonly audioSsrc: number
}

/**
 * The streaming engine, reachable without a `CameraController`.
 *
 * Apple's multi-tier RTP service owns its OWN `Setup Endpoints` and
 * `RTP Streaming Control` characteristics, so the classic controller does not
 * negotiate for it — but the sockets, SRTP contexts, ffmpeg pipeline and
 * teardown are all the same, and duplicating them would be two engines to keep
 * in agreement. hap-nodejs's own handlers are all `private`, so the LIBRARY's
 * engine cannot be reused; ours can, and this is the seam.
 *
 * Both entry points drive the same `sessions` map as the delegate, so a session
 * negotiated on either service is torn down by the same `dispose`.
 */
export interface StreamNegotiator {
  prepare(request: PrepareStreamRequest): Promise<PreparedEndpoint>
  control(request: StreamingRequest): Promise<void>
  /** Whether a session with this id is currently prepared. */
  has(sessionId: string): boolean
}

export interface CameraStreamsBuild {
  readonly delegate: CameraStreamingDelegate
  readonly streamingOptions: CameraStreamingOptions
  readonly negotiator: StreamNegotiator
  readonly dispose: () => Promise<void>
}

export function buildCameraStreamingDelegate(
  bctx: BuilderContext,
  advertised: AdvertisedVideoProfile,
): CameraStreamsBuild {
  const { ctx, numericDeviceId } = bctx
  const log = ctx.logger.withTags({ deviceId: numericDeviceId })
  const sessions = new Map<string, SessionState>()

  const delegate: CameraStreamingDelegate = {
    handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
      handleSnapshot(bctx, request)
        .then((buf) => callback(undefined, buf))
        .catch((err: unknown) => {
          log.warn('export-hap: snapshot failed', {
            meta: { error: errMsg(err) },
          })
          callback(err instanceof Error ? err : new Error(errMsg(err)))
        })
    },

    prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
      prepareStream(request, sessions, bctx, 'classic')
        .then((resp) => callback(undefined, resp))
        .catch((err: unknown) => {
          log.warn('export-hap: prepareStream failed', {
            meta: { error: errMsg(err) },
          })
          callback(err instanceof Error ? err : new Error(errMsg(err)))
        })
    },

    handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
      handleStreamRequest(request, sessions, bctx, advertised)
        .then(() => callback())
        .catch((err: unknown) => {
          log.warn('export-hap: handleStreamRequest failed', {
            meta: { error: errMsg(err) },
          })
          callback(err instanceof Error ? err : new Error(errMsg(err)))
        })
    },
  }

  const negotiator: StreamNegotiator = {
    async prepare(request: PrepareStreamRequest): Promise<PreparedEndpoint> {
      const response = await prepareStream(request, sessions, bctx, 'multi-tier')
      const session = sessions.get(request.sessionID)
      if (session === undefined) {
        // prepareStream registers the session before it returns; if it is gone
        // the engine changed under us and reporting an address we cannot prove
        // would send the controller's RTP into a hole.
        throw new Error('export-hap: prepareStream returned without registering a session')
      }
      const video = response.video
      const audio = response.audio
      if (!('port' in video) || audio === undefined || !('port' in audio)) {
        throw new Error('export-hap: the multi-tier path does not support a proxied source')
      }
      return {
        localAddress: session.localAddress,
        videoPort: video.port,
        audioPort: audio.port,
        videoSsrc: video.ssrc,
        audioSsrc: audio.ssrc,
      }
    },
    async control(request: StreamingRequest): Promise<void> {
      await handleStreamRequest(request, sessions, bctx, advertised)
    },
    has(sessionId: string): boolean {
      return sessions.has(sessionId)
    },
  }

  const streamingOptions: CameraStreamingOptions = {
    supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
    video: {
      codec: {
        profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
        levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
      },
      // R2 — derived, not invented. Each triple carries the frame rate the
      // slot that WILL serve that resolution actually runs at (measured by
      // the broker, else published by the device provider, else assumed).
      // This list used to hard-code 30 fps for every entry while the picker
      // steered a 1280×720 request onto a slot delivering 10.
      // See `stream-fps.ts`.
      resolutions: toHapResolutions(advertised.resolutions),
    },
    audio: {
      // Opus is the HAP audio codec of choice for camera accessories —
      // it round-trips well through libopus on the encode side and is
      // the only HAP-supported codec the iOS controller currently
      // advertises as a sensible negotiate-down-from default. We pin
      // 24 kHz to match the encoder's `-ar 24000` (resampling on the
      // controller side adds latency we don't need).
      codecs: [
        {
          type: AudioStreamingCodecType.OPUS,
          samplerate: AudioStreamingSamplerate.KHZ_24,
          // Some iOS versions silently drop the audio descriptor — and
          // with it the Microphone / Speaker services that gate the
          // talk-back button — when bitrate + audioChannels are absent
          // from the codec advertisement. VARIABLE matches libopus's
          // default `-application voip` profile we feed via ffmpeg.
          audioChannels: 1,
          bitrate: AudioBitrate.VARIABLE,
        },
      ],
      // `twoWayAudio: true` is set by the intercom builder when the
      // device exposes the `intercom` cap. Keeping it default-false here
      // means non-intercom cameras advertise downstream-only audio
      // (mic-on-the-controller-side is grey'd out in iOS Home).
      twoWayAudio: false,
      // Comfort-noise is meant for plain voice calls; cameras send live
      // ambient audio that already covers the silence floor — leaving
      // this off keeps the iOS receiver in pure-stream mode.
      comfort_noise: false,
    },
  }

  return {
    delegate,
    streamingOptions,
    negotiator,
    dispose: async () => {
      for (const session of sessions.values()) {
        // Accessory teardown, not a controller `stop` — the summary says so
        // explicitly so it is never mistaken for an iOS-initiated teardown.
        session.teardownTrigger = 'accessory-dispose'
        const hadFfmpeg = session.ffmpeg !== null
        killFfmpeg(session, ctx, numericDeviceId)
        stopHeartbeat(session)
        // Last look before the sockets close — see the controller-stop path.
        sampleLoopbackDrops(session)
        if (!hadFfmpeg) logSessionSummary(session, log, 'accessory-dispose-no-ffmpeg')
        await closeIntercomTalkSession(session, bctx).catch(() => undefined)
        closeSocket(session.videoUdp)
        closeSocket(session.audioUdp)
        closeSocket(session.videoLoopUdp)
        closeSocket(session.audioLoopUdp)
      }
      sessions.clear()
    },
  }
}

// ── Snapshot ─────────────────────────────────────────────────────────

async function handleSnapshot(bctx: BuilderContext, request: SnapshotRequest): Promise<Buffer> {
  const { proxy, ctx, numericDeviceId } = bctx
  // The cap doesn't take width/height — the snapshot orchestrator
  // returns the camera's native resolution. iOS Home re-scales server-
  // side, so we forward the JPEG untouched. The `request.width`/
  // `request.height` are reserved for a future thumbnail-resize hop.
  void request
  const result = await proxy.snapshot?.getSnapshot({})
  if (!result || typeof result.base64 !== 'string') {
    // A dropped snapshot is what the operator sees as a black camera tile in
    // the Home app grid. It was logged at `debug`, which Loki does not carry.
    ctx.logger.withTags({ deviceId: numericDeviceId }).info('export-hap: snapshot dropped', {
      meta: {
        reason: 'snapshot-unavailable',
        capBound: proxy.snapshot !== undefined,
      },
    })
    throw new Error('snapshot unavailable')
  }
  return Buffer.from(result.base64, 'base64')
}

// ── prepareStream ────────────────────────────────────────────────────

async function prepareStream(
  request: PrepareStreamRequest,
  sessions: Map<string, SessionState>,
  bctx: BuilderContext,
  negotiatedVia: 'classic' | 'multi-tier',
): Promise<PrepareStreamResponse> {
  const ipVersion: 'ipv4' | 'ipv6' = request.addressVersion
  // Bind iOS-facing sockets to the local interface IP whose subnet
  // matches iOS's `targetAddress`. Binding to 0.0.0.0 lets the OS pick
  // a source IP per-send and breaks the symmetric-port handshake iOS
  // needs to validate the SRTP return path (iOS would send its RTCP
  // probe to an interface we don't own → gate never opens → stream
  // times out at 30 s with no frames).
  const localIp = pickLocalInterfaceIp(request.targetAddress, ipVersion)
  const videoUdp = await bindUdp(ipVersion, localIp)
  const audioUdp = await bindUdp(ipVersion, localIp)
  // Loopback sockets for the ffmpeg → JS encrypt pipeline. ffmpeg
  // writes plain RTP to these; the read handler SRTP-encrypts and
  // forwards via `videoUdp` / `audioUdp` so iOS sees a single
  // source port for both RTP and RTCP.
  const videoLoop = await bindLoopback(ipVersion, VIDEO_LOOPBACK_RCVBUF_BYTES)
  const audioLoop = await bindLoopback(ipVersion, AUDIO_LOOPBACK_RCVBUF_BYTES)
  const videoLoopUdp = videoLoop.socket
  const audioLoopUdp = audioLoop.socket
  const localVideoPort = videoUdp.address().port
  const localAudioPort = audioUdp.address().port

  // Sanity: SRTP keys/salts MUST match the AES_CM_128_HMAC_SHA1_80 layout
  // — otherwise the negotiation will fail downstream with an obscure
  // decryption error. We only declare this crypto suite, so HAP-NodeJS
  // should always satisfy it; the check guards against future suite
  // additions silently breaking the assumption.
  if (
    request.video.srtp_key.length !== SRTP_KEY_LEN ||
    request.video.srtp_salt.length !== SRTP_SALT_LEN ||
    request.audio.srtp_key.length !== SRTP_KEY_LEN ||
    request.audio.srtp_salt.length !== SRTP_SALT_LEN
  ) {
    closeSocket(videoUdp)
    closeSocket(audioUdp)
    closeSocket(videoLoopUdp)
    closeSocket(audioLoopUdp)
    throw new Error(
      `export-hap: unexpected SRTP key/salt size (video=${request.video.srtp_key.length}/${request.video.srtp_salt.length}, audio=${request.audio.srtp_key.length}/${request.audio.srtp_salt.length})`,
    )
  }

  // Outbound SRTP sessions — one each for video and audio. werift
  // tracks ROC + index internally per direction; the same master key
  // wraps both directions in HAP, so we feed the same key/salt to both
  // halves of the config (mirrors the existing inbound-audio init).
  const makeOutSrtp = (key: Buffer, salt: Buffer): SrtpSession =>
    new SrtpSession({
      keys: {
        localMasterKey: key,
        localMasterSalt: salt,
        remoteMasterKey: key,
        remoteMasterSalt: salt,
      },
      profile: ProtectionProfileAes128CmHmacSha1_80,
    })
  const makeSrtcp = (key: Buffer, salt: Buffer): SrtcpSession =>
    new SrtcpSession({
      keys: {
        localMasterKey: key,
        localMasterSalt: salt,
        remoteMasterKey: key,
        remoteMasterSalt: salt,
      },
      profile: ProtectionProfileAes128CmHmacSha1_80,
    })
  let videoOutSrtp: SrtpSession
  let videoOutSrtcp: SrtcpSession
  let videoInSrtcp: SrtcpSession
  let audioOutSrtp: SrtpSession
  let audioOutSrtcp: SrtcpSession
  let audioInSrtcp: SrtcpSession
  try {
    videoOutSrtp = makeOutSrtp(request.video.srtp_key, request.video.srtp_salt)
    videoOutSrtcp = makeSrtcp(request.video.srtp_key, request.video.srtp_salt)
    // Separate contexts for the inbound direction — see `videoInSrtcp`.
    videoInSrtcp = makeSrtcp(request.video.srtp_key, request.video.srtp_salt)
    audioOutSrtp = makeOutSrtp(request.audio.srtp_key, request.audio.srtp_salt)
    audioOutSrtcp = makeSrtcp(request.audio.srtp_key, request.audio.srtp_salt)
    audioInSrtcp = makeSrtcp(request.audio.srtp_key, request.audio.srtp_salt)
  } catch (err) {
    closeSocket(videoUdp)
    closeSocket(audioUdp)
    closeSocket(videoLoopUdp)
    closeSocket(audioLoopUdp)
    throw new Error(`export-hap: outbound SrtpSession init failed: ${errMsg(err)}`, { cause: err })
  }

  // Build the inbound-audio SRTP decrypt session up-front so the UDP
  // message handler can decrypt every packet straight away. `werift-rtp`
  // expects the master key + salt directly — the same 16-byte key /
  // 14-byte salt HAP-NodeJS already validated above for the
  // AES_CM_128_HMAC_SHA1_80 suite. We feed the same key to both halves
  // of the Session config because we only ever call `decrypt()` here
  // (encrypt for outbound audio is handled by the JS-side
  // `forwardEncryptedRtp` loopback path).
  let upstreamAudioSrtp: SrtpSession | null = null
  try {
    upstreamAudioSrtp = new SrtpSession({
      keys: {
        localMasterKey: request.audio.srtp_key,
        localMasterSalt: request.audio.srtp_salt,
        remoteMasterKey: request.audio.srtp_key,
        remoteMasterSalt: request.audio.srtp_salt,
      },
      profile: ProtectionProfileAes128CmHmacSha1_80,
    })
  } catch (err) {
    // Should not happen for AES_CM_128_HMAC_SHA1_80 with validated key
    // lengths above — log + continue so the downstream path still works.
    bctx.ctx.logger
      .withTags({ deviceId: bctx.numericDeviceId })
      .warn('export-hap: SrtpSession init failed (upstream audio decrypt disabled)', {
        meta: { error: errMsg(err) },
      })
  }

  const videoSsrc = randomSsrc()
  const audioSsrc = randomSsrc()
  const session: SessionState = {
    sessionId: request.sessionID,
    localAddress: localIp,
    negotiatedVia,
    // H.264 until a start says otherwise: it is what every transcode emits and
    // what the classic service can ever carry.
    wireCodec: 'h264',
    startedAtMs: null,
    endedAtMs: null,
    negotiated: null,
    selectedSlot: null,
    ffmpegExit: null,
    stopRequestedByController: false,
    teardownTrigger: null,
    drops: emptyDropCounters(),
    videoPacketsForwarded: 0,
    audioPacketsForwarded: 0,
    videoKeyframes: 0,
    firstKeyframeAtMs: null,
    lastKeyframeAtMs: null,
    maxKeyframeGapMs: 0,
    videoRtcpSrSent: 0,
    audioRtcpSrSent: 0,
    videoRtcpReceived: 0,
    audioRtcpReceived: 0,
    videoRtpReceived: 0,
    audioRtpReceived: 0,
    videoReceiverReports: emptyReceiverReportTally(),
    audioReceiverReports: emptyReceiverReportTally(),
    videoRrLoggedAt: 0,
    audioRrLoggedAt: 0,
    videoGate: null,
    audioGate: null,
    heartbeat: null,
    hapVideoPort: request.video.port,
    hapAddress: request.targetAddress,
    videoSrtpKey: request.video.srtp_key,
    videoSrtpSalt: request.video.srtp_salt,
    videoUdp,
    videoLoopUdp,
    videoOutSrtp,
    videoOutSrtcp,
    videoInSrtcp,
    videoOutPacketCount: 0,
    videoOutOctetCount: 0,
    videoOutLastRtpTimestamp: 0,
    videoOutLastRtcpAt: 0,
    videoRtcpIntervalMs: 5000,
    videoSendGate: null,
    videoSsrc,
    hapAudioPort: request.audio.port,
    audioSrtpKey: request.audio.srtp_key,
    audioSrtpSalt: request.audio.srtp_salt,
    audioUdp,
    audioLoopUdp,
    audioOutSrtp,
    audioOutSrtcp,
    audioInSrtcp,
    audioSendGate: null,
    ipVersion,
    videoLoopRcvbuf: videoLoop.buffer,
    audioLoopRcvbuf: audioLoop.buffer,
    videoLoopPort: videoLoopUdp.address().port,
    audioLoopPort: audioLoopUdp.address().port,
    videoLoopKernelDrops: null,
    audioLoopKernelDrops: null,
    ffmpeg: null,
    lastStartParams: null,
    upstreamAudioSrtp,
    intercomTalkSessionId: null,
    intercomPcmSequence: 0,
    upstreamRtpPacketsReceived: 0,
    upstreamRtpPacketsDecrypted: 0,
    upstreamRtpDecryptFailures: 0,
    upstreamPcmFramesDecoded: 0,
    firstUpstreamRtpTimestamp: null,
    firstAudioOutTimestamp: null,
    audioOutPacketCount: 0,
    audioIntervalScale: 2,
    audioOutSsrc: audioSsrc,
    audioOutOctetCount: 0,
    audioOutLastRtpTimestamp: 0,
    audioOutLastRtcpAt: 0,
    audioRtcpIntervalMs: 5000,
  }
  sessions.set(request.sessionID, session)

  const tagLog = bctx.ctx.logger.withTags({ deviceId: bctx.numericDeviceId })

  // RTCP gates — one per leg. iOS 15.5+ won't display a stream whose
  // return path it hasn't validated with at least one RTCP probe; we
  // resolve the gate on the first packet that hits the bound socket
  // (RTP, RTCP, anything), with a 1 s timeout fallback so older iOS
  // versions that don't probe aren't blocked. The loopback reader
  // awaits the gate before forwarding the first SRTP packet so iOS
  // sees a proper handshake.
  //
  // The gate now REPORTS which of the two happened. They mean opposite
  // things — `packet` says the controller found our port, `timeout` says
  // nothing ever arrived on it — and the logs used to record neither, which
  // is why "does iOS's RTCP reach our video return port at all?" stayed an
  // open question for a year.
  session.videoSendGate = makeRtcpGate(videoUdp, 1000)
  session.audioSendGate = makeRtcpGate(audioUdp, 1000)
  void session.videoSendGate.then((resolution) => {
    session.videoGate = resolution
    logGateResolved(session, 'video', resolution, tagLog)
  })
  void session.audioSendGate.then((resolution) => {
    session.audioGate = resolution
    logGateResolved(session, 'audio', resolution, tagLog)
  })

  // Return-path observers. `iOS never sent us RTCP` was an ASSUMPTION nobody
  // could check: the only listener on these sockets was the one-shot gate
  // (video) or the talk-back handler (audio), so inbound traffic after the
  // first packet was invisible. These count and classify everything that
  // arrives, for the whole session.
  videoUdp.on('message', (packet) => {
    countInbound(session, 'video', packet, tagLog)
  })
  audioUdp.on('message', (packet) => {
    countInbound(session, 'audio', packet, tagLog)
  })

  // Loopback readers — ffmpeg writes plain RTP to {videoLoop, audioLoop}
  // and we SRTP-encrypt + send to iOS via the iOS-facing sockets. Each
  // read is gated on the corresponding RTCP probe. Per-leg packet
  // counters surface once-every-N to confirm the path is alive without
  // flooding the log.
  videoLoopUdp.on('message', (rtpPacket) => {
    session.videoPacketsForwarded += 1
    if (rtpPacketCarriesKeyframe(rtpPacket, session.wireCodec)) recordKeyframe(session)
    if (session.videoPacketsForwarded === 1) {
      tagLog.info('export-hap: first video packet from ffmpeg', {
        meta: { sessionId: session.sessionId, bytes: rtpPacket.length },
      })
    }
    forwardEncryptedRtp(session, rtpPacket, 'video', tagLog)
  })
  audioLoopUdp.on('message', (rtpPacket) => {
    session.audioPacketsForwarded += 1
    forwardEncryptedRtp(session, rtpPacket, 'audio', tagLog)
  })

  // Wire the upstream-audio receive handler. We attach it here (not on
  // `start`) because HAP can begin sending iPhone-mic Opus packets as
  // soon as the controller side negotiates the talk-back — there's no
  // separate "audio start" event in the protocol, just the existing
  // video `start` request. Dropping packets silently before `start` is
  // safe because the audio-codec session isn't open yet (we lazy-init
  // it on first RTP packet to avoid opening a session iOS never feeds).
  audioUdp.on('message', (packet, rinfo) => {
    handleIncomingAudioRtp(session, packet, rinfo.address, bctx).catch((err: unknown) => {
      bctx.ctx.logger
        .withTags({ deviceId: bctx.numericDeviceId })
        .debug('export-hap: incoming-audio handler error (dropped)', {
          meta: { error: errMsg(err) },
        })
    })
  })

  // What the kernel actually GAVE us to receive ffmpeg's RTP into. Said out
  // loud, and at `warn` when it is not enough, because `SO_RCVBUF` is clamped
  // at `net.core.rmem_max` — on a stock host that is 212 992 B, the same value
  // as the default, so the fix would look applied and change nothing. Raising
  // it is a HOST sysctl, not a code change.
  logLoopbackBuffer(tagLog, request.sessionID, 'video', videoLoop.buffer)
  logLoopbackBuffer(tagLog, request.sessionID, 'audio', audioLoop.buffer)

  tagLog.info('export-hap: stream prepared', {
    meta: {
      sessionId: request.sessionID,
      controllerAddress: request.targetAddress,
      addressVersion: ipVersion,
      localIp,
      // The four ports every "iOS is not receiving us" investigation needs and
      // none of which was recorded: what we advertised, and where we send.
      advertisedVideoPort: localVideoPort,
      advertisedAudioPort: localAudioPort,
      controllerVideoPort: request.video.port,
      controllerAudioPort: request.audio.port,
      videoSsrc,
      audioSsrc,
      upstreamAudioDecrypt: upstreamAudioSrtp !== null,
    },
  })

  const videoResp: SourceResponse = {
    port: localVideoPort,
    ssrc: videoSsrc,
    srtp_key: request.video.srtp_key,
    srtp_salt: request.video.srtp_salt,
  }
  const audioResp: SourceResponse = {
    port: localAudioPort,
    ssrc: audioSsrc,
    srtp_key: request.audio.srtp_key,
    srtp_salt: request.audio.srtp_salt,
  }

  return {
    video: videoResp,
    audio: audioResp,
  }
}

async function bindUdp(ipVersion: 'ipv4' | 'ipv6', address?: string): Promise<UdpSocket> {
  const udp = createSocket(ipVersion === 'ipv6' ? 'udp6' : 'udp4')
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject)
    const onBound = (): void => {
      udp.removeListener('error', reject)
      resolve()
    }
    if (address !== undefined) udp.bind(0, address, onBound)
    else udp.bind(0, onBound)
  })
  return udp
}

/**
 * Pick the local interface IP whose subnet matches `targetAddress`
 * (iOS's reported address). Required so the SRTP socket we bind has a
 * routable source IP for the symmetric port — without this, iOS sends
 * its RTCP probe to an interface we don't own and the gate never opens.
 *
 * Falls back to `127.0.0.1` (or `::1`) when no match is found — that
 * lets a same-host test still resolve, even if the obvious LAN-routing
 * cases (cross-subnet client) won't be reachable.
 */
function pickLocalInterfaceIp(targetAddress: string, ipVersion: 'ipv4' | 'ipv6'): string {
  const family = ipVersion === 'ipv6' ? 'IPv6' : 'IPv4'
  const ifaces = networkInterfaces()
  const candidates: Array<{
    readonly address: string
    readonly netmask: string
  }> = []
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (entry.internal) continue
      if (entry.family !== family) continue
      candidates.push({ address: entry.address, netmask: entry.netmask })
    }
  }
  // Pick the candidate in the same subnet as targetAddress.
  const target = targetAddress.replace(/^::ffff:/, '')
  for (const cand of candidates) {
    if (sameIpv4Subnet(cand.address, cand.netmask, target)) return cand.address
  }
  // No subnet match — return the first non-internal interface so we at
  // least bind to a real IP; iOS may still route via gateway.
  if (candidates.length > 0) return candidates[0]!.address
  return ipVersion === 'ipv6' ? '::1' : '127.0.0.1'
}

function sameIpv4Subnet(a: string, mask: string, b: string): boolean {
  const aOctets = a.split('.').map(Number)
  const mOctets = mask.split('.').map(Number)
  const bOctets = b.split('.').map(Number)
  if (aOctets.length !== 4 || mOctets.length !== 4 || bOctets.length !== 4) return false
  for (let i = 0; i < 4; i++) {
    if ((aOctets[i]! & mOctets[i]!) !== (bOctets[i]! & mOctets[i]!)) return false
  }
  return true
}

/**
 * Report one loopback socket's receive buffer.
 *
 * `warn` when the video leg cannot hold a 4K key-frame burst: that is the state
 * in which this addon silently drops most of a key frame and the tile stays
 * black, and it was invisible for the whole life of this code path.
 */
function logLoopbackBuffer(
  log: IScopedLogger,
  sessionId: string,
  leg: 'video' | 'audio',
  outcome: ReceiveBufferOutcome,
): void {
  const meta = {
    sessionId,
    leg,
    requestedBytes: outcome.requestedBytes,
    effectiveBytes: outcome.effectiveBytes,
    clamped: outcome.clamped,
    sufficientForKeyframeBurst: outcome.sufficientForKeyframeBurst,
    error: outcome.error,
  }
  if (leg === 'video' && !outcome.sufficientForKeyframeBurst) {
    log.warn(
      'export-hap: loopback receive buffer is TOO SMALL for a key-frame burst — raise net.core.rmem_max on the host',
      { meta },
    )
    return
  }
  log.info('export-hap: loopback receive buffer', { meta })
}

/** A bound loopback socket and what the kernel gave it to receive into. */
interface LoopbackBinding {
  readonly socket: UdpSocket
  readonly buffer: ReceiveBufferOutcome
}

/**
 * Resolve once-per-session: the local IP we bind iOS-facing sockets to
 * AND its mate on `127.0.0.1` for the ffmpeg loopback path. Both go
 * through the bounded-wait `dgram.bind` pattern.
 *
 * `SO_RCVBUF` is set AFTER the bind and read back, never assumed. Until
 * 2026-08-07 nothing set it at all, so these sockets ran on
 * `net.core.rmem_default` (212 992 B on this hub) — about a fifth of one 4K
 * key frame, which arrives as ~750 datagrams in one burst. See
 * `stream-socket-buffer.ts` for the measurement.
 */
async function bindLoopback(
  ipVersion: 'ipv4' | 'ipv6',
  requestedRcvbufBytes: number,
): Promise<LoopbackBinding> {
  const socket = await bindUdp(ipVersion, ipVersion === 'ipv6' ? '::1' : '127.0.0.1')
  return { socket, buffer: applyReceiveBuffer(socket, requestedRcvbufBytes) }
}

// ── Telemetry ────────────────────────────────────────────────────────

/** Book a named drop. Every silent `return` on the streaming path routes here. */
function drop(session: SessionState, reason: StreamDropReason): void {
  session.drops = recordDrop(session.drops, reason)
}

/**
 * Report a gate resolution. `timeout` is the interesting one: it means we are
 * about to stream into a port the controller never touched, and it was
 * indistinguishable from a successful probe until now.
 */
function logGateResolved(
  session: SessionState,
  leg: 'video' | 'audio',
  resolution: RtcpGateResolution,
  log: IScopedLogger,
): void {
  const meta = {
    sessionId: session.sessionId,
    leg,
    reason: resolution.reason,
    waitedMs: resolution.waitedMs,
  }
  if (resolution.reason === 'packet') {
    log.info('export-hap: RTCP gate opened on a REAL controller packet', {
      meta,
    })
  } else {
    log.warn('export-hap: RTCP gate opened on the 1s FALLBACK — controller never probed', { meta })
  }
}

/** Count and classify one packet the controller sent to a return port. */
function countInbound(
  session: SessionState,
  leg: 'video' | 'audio',
  packet: Buffer,
  log: IScopedLogger,
): void {
  const kind = classifyInboundPacket(packet)
  const firstRtcp =
    kind === 'rtcp' &&
    (leg === 'video' ? session.videoRtcpReceived : session.audioRtcpReceived) === 0
  if (leg === 'video') {
    if (kind === 'rtcp') session.videoRtcpReceived += 1
    else if (kind === 'rtp') session.videoRtpReceived += 1
  } else {
    if (kind === 'rtcp') session.audioRtcpReceived += 1
    else if (kind === 'rtp') session.audioRtpReceived += 1
  }
  if (firstRtcp) {
    log.info('export-hap: first inbound RTCP from controller', {
      meta: { sessionId: session.sessionId, leg, bytes: packet.length },
    })
  }
  if (kind === 'rtcp') readControllerRtcp(session, leg, packet, log)
}

/** Fold a decrypted RTCP datagram into the leg's tally. Immutable, per `ReceiverReportTally`. */
function storeReceiverReports(
  session: SessionState,
  leg: 'video' | 'audio',
  tally: ReceiverReportTally,
): void {
  if (leg === 'video') session.videoReceiverReports = tally
  else session.audioReceiverReports = tally
}

/**
 * Decrypt one inbound RTCP datagram and read the controller's Receiver Report.
 *
 * This is the datum the 2026-08-06 telemetry left missing. That round proved
 * iOS DOES send us RTCP on the video leg — 21 and 34 packets across two
 * sessions, the gate opening on a real controller packet at ~550 ms — which
 * killed the long-standing "iOS never probes us" belief. But counting packets
 * says only that the controller spoke; a Receiver Report says WHAT it said,
 * and that splits the remaining causes into two disjoint families that nothing
 * else in this system can tell apart. See `LossVerdict`.
 *
 * Runs on a UDP `message` handler, so nothing here may throw: a controller
 * that sends one deformed datagram must not take the session with it. Every
 * failure books a named drop and increments `unreadable`, because a report we
 * could not read and a report that never came must never look alike.
 */
function readControllerRtcp(
  session: SessionState,
  leg: 'video' | 'audio',
  packet: Buffer,
  log: IScopedLogger,
): void {
  const srtcp = leg === 'video' ? session.videoInSrtcp : session.audioInSrtcp
  const tally = leg === 'video' ? session.videoReceiverReports : session.audioReceiverReports
  if (!srtcp) {
    drop(session, 'inbound-rtcp-no-srtcp')
    storeReceiverReports(session, leg, recordUnreadableRtcp(tally))
    logUnreadableRtcp(session, leg, 'no-srtcp-context', log)
    return
  }

  let plaintext: Buffer
  try {
    plaintext = srtcp.decrypt(packet)
  } catch (err) {
    drop(session, 'inbound-rtcp-decrypt-failed')
    storeReceiverReports(session, leg, recordUnreadableRtcp(tally))
    logUnreadableRtcp(session, leg, `decrypt: ${errMsg(err)}`, log)
    return
  }

  const outcome = ingestDecryptedRtcp(plaintext, tally)
  storeReceiverReports(session, leg, outcome.tally)
  if (outcome.failure !== null) {
    drop(session, 'inbound-rtcp-parse-failed')
    logUnreadableRtcp(session, leg, `parse: ${outcome.failure}`, log)
    return
  }
  // "First" is a property of the transition, not of a count: a single compound
  // datagram can carry two block-bearing reports, and a `reportsParsed === 1`
  // test would then skip the one line this whole round exists to emit.
  const isFirst = tally.reportsParsed === 0 && outcome.tally.reportsParsed > 0
  logReceiverReports(session, leg, outcome.reports, isFirst, log)
}

/** Throttled per leg — a controller sending nothing but garbage must not become the log. */
function logUnreadableRtcp(
  session: SessionState,
  leg: 'video' | 'audio',
  reason: string,
  log: IScopedLogger,
): void {
  const tally = leg === 'video' ? session.videoReceiverReports : session.audioReceiverReports
  if (!shouldLogReceiverReport(session, leg)) return
  log.warn('export-hap: inbound RTCP could not be read', {
    meta: {
      sessionId: session.sessionId,
      leg,
      reason,
      unreadable: tally.unreadable,
    },
  })
}

/**
 * True at most once per `RECEIVER_REPORT_LOG_INTERVAL_MS` per leg. Stamps the
 * leg on the way out so the caller cannot forget to.
 */
function shouldLogReceiverReport(session: SessionState, leg: 'video' | 'audio'): boolean {
  const now = Date.now()
  const lastAt = leg === 'video' ? session.videoRrLoggedAt : session.audioRrLoggedAt
  if (now < lastAt + RECEIVER_REPORT_LOG_INTERVAL_MS) return false
  if (leg === 'video') session.videoRrLoggedAt = now
  else session.audioRrLoggedAt = now
  return true
}

/**
 * Emit the controller's own numbers.
 *
 * The FIRST report on a leg gets its own message: that one arriving at all is
 * the proof iOS is engaged with the stream, and it was worth a year of
 * argument. Everything after it is throttled to the heartbeat's cadence.
 */
function logReceiverReports(
  session: SessionState,
  leg: 'video' | 'audio',
  reports: readonly ControllerReceiverReport[],
  isFirst: boolean,
  log: IScopedLogger,
): void {
  const tally = leg === 'video' ? session.videoReceiverReports : session.audioReceiverReports
  const block = reports.flatMap((report) => report.blocks).at(-1)
  if (!block) return
  const reporter = reports.find((report) => report.blocks.length > 0)
  const meta = {
    sessionId: session.sessionId,
    leg,
    reporterSsrc: reporter?.reporterSsrc ?? null,
    aboutSsrc: block.aboutSsrc,
    fractionLostPct: block.fractionLostPct,
    cumulativePacketsLost: block.cumulativePacketsLost,
    extendedHighestSequence: block.extendedHighestSequence,
    jitter: block.jitter,
    delaySinceLastSrMs: block.delaySinceLastSrMs,
    reportsParsed: tally.reportsParsed,
    worstFractionLostPct: tally.worstFractionLostPct,
  }
  if (isFirst) {
    // Mark the leg as just-logged so the throttle counts from here.
    shouldLogReceiverReport(session, leg)
    log.info(
      'export-hap: FIRST RTCP Receiver Report from controller — iOS is receiving and reporting',
      { meta },
    )
    return
  }
  if (!shouldLogReceiverReport(session, leg)) return
  log.info('export-hap: controller receiver report', { meta })
}

/**
 * Record a forwarded key frame. Kept separate from the packet counter because
 * the interesting quantity is TIMING, not a tally: the first arrival dates the
 * moment the controller could begin decoding, and the widest gap says how long
 * a mid-GOP join can be expected to stare at a loader.
 */
function recordKeyframe(session: SessionState): void {
  const now = Date.now()
  session.videoKeyframes += 1
  if (session.firstKeyframeAtMs === null) {
    session.firstKeyframeAtMs = now
  } else if (session.lastKeyframeAtMs !== null) {
    session.maxKeyframeGapMs = Math.max(session.maxKeyframeGapMs, now - session.lastKeyframeAtMs)
  }
  session.lastKeyframeAtMs = now
}

/**
 * Refresh the kernel's per-socket drop counters.
 *
 * Called immediately before every line that reports them, because a stale
 * sample on the summary would answer the experiment's central question with
 * data from five seconds earlier. Cheap: `/proc/net/udp` is memory-backed.
 */
function sampleLoopbackDrops(session: SessionState): void {
  // Never CLOBBER a known reading. A closed socket is gone from
  // `/proc/net/udp`, and the summary is emitted from ffmpeg's `exit` handler —
  // by which time the teardown path has already closed both sockets.
  session.videoLoopKernelDrops = mergeDropSample(
    session.videoLoopKernelDrops,
    readUdpSocketDrops(session.videoLoopPort, session.ipVersion),
  )
  session.audioLoopKernelDrops = mergeDropSample(
    session.audioLoopKernelDrops,
    readUdpSocketDrops(session.audioLoopPort, session.ipVersion),
  )
}

/** Snapshot every counter into the summary meta. */
function sessionSummaryMeta(session: SessionState): ReturnType<typeof summariseSession> {
  return summariseSession({
    sessionId: session.sessionId,
    startedAtMs: session.startedAtMs,
    endedAtMs: session.endedAtMs,
    negotiated: session.negotiated,
    selectedSlot: session.selectedSlot,
    videoPacketsForwarded: session.videoPacketsForwarded,
    audioPacketsForwarded: session.audioPacketsForwarded,
    videoKeyframes: session.videoKeyframes,
    firstKeyframeAtMs: session.firstKeyframeAtMs,
    maxKeyframeGapMs: session.maxKeyframeGapMs,
    videoRtcpSrSent: session.videoRtcpSrSent,
    audioRtcpSrSent: session.audioRtcpSrSent,
    videoRtcpReceived: session.videoRtcpReceived,
    audioRtcpReceived: session.audioRtcpReceived,
    videoRtpReceived: session.videoRtpReceived,
    audioRtpReceived: session.audioRtpReceived,
    videoGate: session.videoGate,
    audioGate: session.audioGate,
    videoReceiverReports: session.videoReceiverReports,
    audioReceiverReports: session.audioReceiverReports,
    drops: session.drops,
    ffmpegExit: session.ffmpegExit,
    stopRequestedByController: session.stopRequestedByController,
    videoLoopback: {
      rcvbufRequestedBytes: session.videoLoopRcvbuf.requestedBytes,
      rcvbufEffectiveBytes: session.videoLoopRcvbuf.effectiveBytes,
      rcvbufClamped: session.videoLoopRcvbuf.clamped,
      kernelDrops: session.videoLoopKernelDrops,
    },
    audioLoopback: {
      rcvbufRequestedBytes: session.audioLoopRcvbuf.requestedBytes,
      rcvbufEffectiveBytes: session.audioLoopRcvbuf.effectiveBytes,
      rcvbufClamped: session.audioLoopRcvbuf.clamped,
      kernelDrops: session.audioLoopKernelDrops,
    },
  })
}

/**
 * Arm the per-session heartbeat. LOGS ONLY — see `SESSION_HEARTBEAT_MS`. It
 * exists so a session that stops producing media says so while it is still
 * alive, instead of being reconstructed after the fact from its final line.
 */
function armHeartbeat(session: SessionState, log: IScopedLogger): void {
  if (session.heartbeat) clearInterval(session.heartbeat)
  let lastVideo = session.videoPacketsForwarded
  const timer = setInterval(() => {
    const forwarded = session.videoPacketsForwarded - lastVideo
    lastVideo = session.videoPacketsForwarded
    sampleLoopbackDrops(session)
    log.info('export-hap: stream heartbeat', {
      meta: {
        ...sessionSummaryMeta(session),
        videoPacketsSinceLastBeat: forwarded,
        // A live session with a stalled video leg is the shape that reads as
        // "the camera froze" in the Home app.
        videoStalled: forwarded === 0,
      },
    })
  }, SESSION_HEARTBEAT_MS)
  timer.unref()
  session.heartbeat = timer
}

function stopHeartbeat(session: SessionState): void {
  if (!session.heartbeat) return
  clearInterval(session.heartbeat)
  session.heartbeat = null
}

/**
 * **`export-hap: stream session summary` is the line to grep** when asking why
 * a HomeKit session died. It carries the negotiated parameters, the slot we
 * dialled and the rate we had promised for it, packet counts in both
 * directions on both legs, each leg's gate outcome, ffmpeg's exit, who asked
 * for the teardown, every named drop — and, since 2026-08-06, what the
 * controller itself reported receiving.
 *
 * Read `videoLossVerdict` first. `transmit-suspect` says the controller is not
 * getting our packets intact and nothing past the wire matters;
 * `decode-suspect` says it got them and rendered nothing anyway;
 * `no-reports` says we still cannot tell, and `videoReceiverReports.unreadable`
 * then distinguishes "the controller said nothing" from "we could not read what
 * it said".
 *
 * Emitted from the ffmpeg `exit` handler — the only place the exit code is
 * known — and directly from the teardown paths when there is no ffmpeg to wait
 * for. It deliberately does NOT touch the heartbeat: iOS restarts a session
 * in place when it is not getting a picture (one on record was started three
 * times in 16 s), and stopping the heartbeat on the superseded process's exit
 * would silence the replacement.
 */
function logSessionSummary(session: SessionState, log: IScopedLogger, trigger: string): void {
  session.endedAtMs = Date.now()
  sampleLoopbackDrops(session)
  log.info('export-hap: stream session summary', {
    meta: { ...sessionSummaryMeta(session), trigger },
  })
}

/**
 * Build the NTP timestamp expected in an RTCP Sender Report.
 *
 * NTP timestamps are 64-bit: upper 32 bits = seconds since 1900-01-01,
 * lower 32 bits = fractional seconds (multiply seconds × 2^32). The
 * 2208988800 s offset bridges the NTP epoch (1900) to the UNIX epoch
 * (1970). iOS uses the NTP↔RTP pairing in the SR to derive the wall-
 * clock anchor it needs to play the speaker audio in sync with the
 * source — without a fresh SR every few seconds iOS silently mutes.
 */
function ntpTime(): bigint {
  const NTP_EPOCH_OFFSET_S = 2208988800n
  const nowMs = BigInt(Date.now())
  const secs = nowMs / 1000n + NTP_EPOCH_OFFSET_S
  const fracMs = nowMs % 1000n
  const frac = (fracMs << 32n) / 1000n
  return (secs << 32n) | frac
}

/**
 * Emit one RTCP Sender Report for a downstream leg. Carries the cumulative
 * packet + octet counts plus the (NTP, RTP) timestamp pair the controller
 * needs to anchor that leg against wall-clock time. Encrypted via the leg's
 * SRTCP context (same master key/salt pair as its SRTP session) and sent to
 * the same `(hapAddress, port)` the SRTP packets go to.
 *
 * BOTH legs need this, not just audio. HAP negotiates `rtcp_interval`
 * separately for video and audio, and a Sender Report is the only thing that
 * pairs an NTP instant with an RTP timestamp — without it the controller
 * cannot place the stream on a clock. The audio leg alone was covered for a
 * year (the speaker went mute without it, which made the omission visible);
 * the video leg has the same requirement and no equally loud symptom.
 */
function sendRtcpSr(session: SessionState, kind: 'video' | 'audio', log: IScopedLogger): void {
  const srtcp = kind === 'video' ? session.videoOutSrtcp : session.audioOutSrtcp
  if (!srtcp) {
    drop(session, 'rtcp-no-srtcp')
    return
  }
  const sink = kind === 'video' ? session.videoUdp : session.audioUdp
  const port = kind === 'video' ? session.hapVideoPort : session.hapAudioPort
  try {
    const sr = new RtcpSrPacket({
      ssrc: kind === 'video' ? session.videoSsrc : session.audioOutSsrc,
      senderInfo: new RtcpSenderInfo({
        ntpTimestamp: ntpTime(),
        rtpTimestamp:
          kind === 'video' ? session.videoOutLastRtpTimestamp : session.audioOutLastRtpTimestamp,
        packetCount: kind === 'video' ? session.videoOutPacketCount : session.audioOutPacketCount,
        octetCount: kind === 'video' ? session.videoOutOctetCount : session.audioOutOctetCount,
      }),
    })
    const encrypted = srtcp.encrypt(sr.serialize())
    sink.send(encrypted, port, session.hapAddress, (err) => {
      if (err) {
        drop(session, 'srtp-send-failed')
        log.warn('export-hap: RTCP send error', {
          meta: { sessionId: session.sessionId, kind, error: err.message },
        })
      }
    })
    if (kind === 'video') {
      session.videoOutLastRtcpAt = Date.now()
      session.videoRtcpSrSent += 1
      if (session.videoRtcpSrSent === 1) {
        // R1 shipped in 1.2.10 and did NOT stop the teardown. Proving the SR
        // actually leaves the process — rather than assuming it, as the R1
        // write-up had to — is the point of this line.
        log.info('export-hap: first VIDEO RTCP Sender Report sent', {
          meta: {
            sessionId: session.sessionId,
            rtpTimestamp: session.videoOutLastRtpTimestamp,
            intervalMs: session.videoRtcpIntervalMs,
          },
        })
      }
    } else {
      session.audioOutLastRtcpAt = Date.now()
      session.audioRtcpSrSent += 1
    }
  } catch (err) {
    drop(session, 'rtcp-encrypt-failed')
    log.warn('export-hap: RTCP SR build/encrypt failed', {
      meta: {
        sessionId: session.sessionId,
        kind,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
}

/**
 * Loopback-to-iOS bridge: encrypt the plain RTP packet ffmpeg just
 * wrote on the loopback socket and send it via the iOS-facing socket
 * (which iOS knows the address+port of — we advertised it as the
 * return port in `prepareStream`). Waits on the RTCP gate before the
 * first send so iOS validates the path before frames arrive.
 *
 * Failures here are swallowed at debug: a single packet drop is
 * harmless for a live stream and the rate-of-fail signal is more
 * useful than per-packet noise.
 */
function forwardEncryptedRtp(
  session: SessionState,
  rtpPacket: Buffer,
  kind: 'video' | 'audio',
  log: IScopedLogger,
): void {
  const srtp = kind === 'video' ? session.videoOutSrtp : session.audioOutSrtp
  const sink = kind === 'video' ? session.videoUdp : session.audioUdp
  const port = kind === 'video' ? session.hapVideoPort : session.hapAudioPort
  const gate = kind === 'video' ? session.videoSendGate : session.audioSendGate
  if (!srtp) {
    drop(session, 'no-srtp-session')
    return
  }
  if (!gate) {
    drop(session, 'no-gate')
    return
  }
  void gate.then(() => {
    try {
      // werift's encrypt expects (payload, header) not the raw packet —
      // parse first to peel off the RTP header it'll re-serialise with
      // the SRTP-derived authentication tag.
      const parsed = RtpPacket.deSerialize(rtpPacket)
      let firstAudio = false
      let firstVideo = false
      if (kind === 'video') {
        // Video timestamps pass through untouched — ffmpeg's 90 kHz clock
        // is already what the controller expects. We only OBSERVE them, to
        // populate the Sender Report below.
        if (session.videoOutPacketCount === 0) firstVideo = true
        session.videoOutPacketCount += 1
        session.videoOutOctetCount += parsed.payload.length
        session.videoOutLastRtpTimestamp = parsed.header.timestamp
      }
      if (kind === 'audio') {
        // Re-stamp the Opus RTP timestamp against the HAP-negotiated
        // sample-rate clock + force the HAP-advertised SSRC + payload
        // type. iOS Home demands `timestamp = firstTimestamp +
        // packetCount * 160 * audioIntervalScale`, anchored to the
        // first packet's wire timestamp; the speaker stays silent if
        // ffmpeg's encoder-clock timestamps reach iOS unchanged.
        const originalTimestamp = parsed.header.timestamp
        if (session.firstAudioOutTimestamp === null) {
          session.firstAudioOutTimestamp = originalTimestamp
          firstAudio = true
          log.info('export-hap: first audio packet from ffmpeg', {
            meta: {
              originalTimestamp,
              audioIntervalScale: session.audioIntervalScale,
              payloadType: parsed.header.payloadType,
              payloadLen: parsed.payload.length,
              sequenceNumber: parsed.header.sequenceNumber,
            },
          })
        }
        const stepped =
          (session.firstAudioOutTimestamp +
            session.audioOutPacketCount * 160 * session.audioIntervalScale) >>>
          0
        parsed.header.timestamp = stepped
        parsed.header.ssrc = session.audioOutSsrc
        if (session.lastStartParams) {
          parsed.header.payloadType = session.lastStartParams.audioPt
        }
        parsed.header.padding = false
        session.audioOutPacketCount += 1
        session.audioOutOctetCount += parsed.payload.length
        session.audioOutLastRtpTimestamp = stepped
      }
      const encrypted = srtp.encrypt(parsed.payload, parsed.header)
      sink.send(encrypted, port, session.hapAddress, (err) => {
        if (err) {
          drop(session, 'srtp-send-failed')
          log.debug('export-hap: SRTP send error', {
            meta: { sessionId: session.sessionId, kind, error: err.message },
          })
        }
      })
      // RTCP Sender Report cadence, per leg: one immediately on that leg's
      // first packet, then every negotiated `rtcp_interval` thereafter.
      // Without periodic SRs on the AUDIO leg the controller silently mutes
      // the speaker after ~5 s even though SRTP keeps arriving; the VIDEO
      // leg has the same anchoring requirement.
      const now = Date.now()
      if (kind === 'video') {
        if (firstVideo || now > session.videoOutLastRtcpAt + session.videoRtcpIntervalMs) {
          sendRtcpSr(session, 'video', log)
        }
      } else if (firstAudio || now > session.audioOutLastRtcpAt + session.audioRtcpIntervalMs) {
        sendRtcpSr(session, 'audio', log)
      }
    } catch (err) {
      drop(session, 'srtp-encrypt-failed')
      log.debug('export-hap: SRTP encrypt failed', {
        meta: {
          sessionId: session.sessionId,
          kind,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  })
}

/** What {@link requireSessionFfmpeg} needs to ask, and to name a refusal. */
export interface SessionFfmpegAsk {
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly log: IScopedLogger
  readonly sessionId: string
  readonly deviceId: number
}

/**
 * The pinned ffmpeg for one HomeKit session, or a THROW after an ERROR naming
 * the camera. Never a PATH `ffmpeg` (D540) — this spawn was a bare `'ffmpeg'`
 * by design, the HOST's binary, while the broker next to it ran ours.
 */
export async function requireSessionFfmpeg(ask: SessionFfmpegAsk): Promise<string> {
  try {
    return await ask.resolveFfmpeg()
  } catch (err: unknown) {
    ask.log.error('export-hap: stream start REFUSED — no pinned ffmpeg on this node (D540)', {
      tags: { deviceId: ask.deviceId },
      meta: { sessionId: ask.sessionId, error: err instanceof Error ? err.message : String(err) },
    })
    throw new Error(`export-hap: no pinned ffmpeg for device ${ask.deviceId}`, { cause: err })
  }
}

// ── handleStreamRequest ──────────────────────────────────────────────

async function handleStreamRequest(
  request: StreamingRequest,
  sessions: Map<string, SessionState>,
  bctx: BuilderContext,
  advertised: AdvertisedVideoProfile,
): Promise<void> {
  const log = bctx.ctx.logger.withTags({ deviceId: bctx.numericDeviceId })
  const session = sessions.get(request.sessionID)
  if (!session) {
    log.warn('export-hap: stream request for unknown session', {
      meta: { sessionID: request.sessionID, type: request.type },
    })
    return
  }

  if (request.type === 'stop') {
    // The controller asked. Our own `killFfmpeg` is the ONLY thing that
    // SIGTERMs ffmpeg, and it runs only from here and from dispose — which is
    // how `code=255 signal=null` was traced back to an iOS-initiated teardown
    // rather than an ffmpeg failure.
    session.stopRequestedByController = true
    session.teardownTrigger = 'controller-stop'
    const hadFfmpeg = session.ffmpeg !== null
    killFfmpeg(session, bctx.ctx, bctx.numericDeviceId)
    stopHeartbeat(session)
    // The LAST look while the sockets still exist. The summary is emitted from
    // ffmpeg's `exit` handler, which runs after the `closeSocket` calls below,
    // and a closed socket has no row in `/proc/net/udp`. Without this a session
    // shorter than one heartbeat reports the drop counter it was built to carry
    // as "could not look".
    sampleLoopbackDrops(session)
    // When ffmpeg is running, its `exit` handler emits the summary — it is the
    // only place `ffmpegExit` is known, and emitting here would always report
    // a null exit code. A `stop` with no ffmpeg (the controller gave up before
    // `start`, or `start` threw) would otherwise produce NO closing line at
    // all, which is the exact "silence reads as never happened" shape.
    if (!hadFfmpeg) logSessionSummary(session, log, 'controller-stop-no-ffmpeg')
    await closeIntercomTalkSession(session, bctx).catch(() => undefined)
    closeSocket(session.videoUdp)
    closeSocket(session.audioUdp)
    closeSocket(session.videoLoopUdp)
    closeSocket(session.audioLoopUdp)
    sessions.delete(request.sessionID)
    return
  }

  if (request.type === 'start') {
    if (session.ffmpeg) {
      killFfmpeg(session, bctx.ctx, bctx.numericDeviceId)
    }
    // Persist payload-type + mtu for later reconfigure cycles (the
    // reconfigure request carries width/height/fps/bitrate only).
    // HAP's `AudioStreamingSamplerate` enum is keyed by the rate in kHz
    // (8 / 16 / 24). The reference RTP cadence is 8 kHz / 50 packets per
    // second = 160 samples per 20 ms packet; for 16 / 24 kHz the
    // multiplier scales by 2 / 3 respectively. Packet time defaults to
    // 20 ms but iOS LTE has been observed to negotiate 60.
    const sampleRateKhz: number = request.audio.sample_rate
    const sampleRateMultiplier = sampleRateKhz === 24 ? 3 : sampleRateKhz === 16 ? 2 : 1
    const packetTimeMs = request.audio.packet_time > 0 ? request.audio.packet_time : 20
    session.audioIntervalScale = sampleRateMultiplier * (packetTimeMs / 20)
    // session.audioOutSsrc was allocated at prepareStream (the SSRC we
    // advertised back to iOS in `PrepareStreamResponse.audio.ssrc`).
    // iOS keys its inbound jitter buffer on that value; using
    // `request.audio.ssrc` here would be wrong — that's the SSRC iOS
    // uses for its OWN mic→camera leg, not our camera→iOS leg.
    // Reset the per-session re-stamping anchors so a reconfigure or a
    // re-start does not inherit a stale `firstAudioOutTimestamp`.
    session.firstAudioOutTimestamp = null
    session.audioOutPacketCount = 0
    session.audioOutOctetCount = 0
    session.audioOutLastRtpTimestamp = 0
    session.audioOutLastRtcpAt = 0
    // HAP carries `rtcp_interval` in seconds, negotiated PER LEG. Default to
    // 5 s when the request omits it — matches the value iOS picks on LAN.
    session.audioRtcpIntervalMs =
      (request.audio.rtcp_interval > 0 ? request.audio.rtcp_interval : 5) * 1000
    session.videoRtcpIntervalMs =
      (request.video.rtcp_interval > 0 ? request.video.rtcp_interval : 5) * 1000
    // Reset the video Sender-Report counters so a re-start does not report
    // cumulative figures from the previous ffmpeg process against a fresh
    // RTP timestamp base.
    session.videoOutPacketCount = 0
    session.videoOutOctetCount = 0
    session.videoOutLastRtpTimestamp = 0
    session.videoOutLastRtcpAt = 0
    // ── The negotiated parameters ────────────────────────────────────
    // Recorded and logged at `info` because NOTHING in a year of sessions
    // recorded what the controller actually agreed to. Every diagnosis of the
    // 31 s teardown had to infer the resolution from which slot ffmpeg dialled
    // and had no way at all to see the frame rate, bitrate, payload types or
    // RTCP intervals.
    session.negotiated = {
      width: request.video.width,
      height: request.video.height,
      fps: request.video.fps,
      maxBitrateKbps: request.video.max_bit_rate,
      mtu: request.video.mtu,
      videoPt: request.video.pt,
      videoSsrc: session.videoSsrc,
      videoRtcpIntervalMs: session.videoRtcpIntervalMs,
      audioPt: request.audio.pt,
      audioSsrc: session.audioOutSsrc,
      audioSampleRateKhz: request.audio.sample_rate,
      audioPacketTimeMs: packetTimeMs,
      audioRtcpIntervalMs: session.audioRtcpIntervalMs,
      audioMaxBitrateKbps: request.audio.max_bit_rate,
    }
    session.startedAtMs = Date.now()
    log.info('export-hap: stream negotiated', {
      meta: { sessionId: request.sessionID, ...session.negotiated },
    })
    session.lastStartParams = {
      pt: request.video.pt,
      mtu: request.video.mtu,
      audioPt: request.audio.pt,
      audioSsrc: session.audioOutSsrc,
      audioSampleRateEnum: request.audio.sample_rate,
      audioPacketTimeMs: packetTimeMs,
      // Kept for the RECONFIGURE path, which does not carry them.
      profile: request.video.profile,
      level: request.video.level,
    }
    const startParams: StartFfmpegVideoParams = {
      width: request.video.width,
      height: request.video.height,
      fps: request.video.fps,
      max_bit_rate: request.video.max_bit_rate,
      mtu: request.video.mtu,
      pt: request.video.pt,
      profile: request.video.profile,
      level: request.video.level,
      audio_pt: request.audio.pt,
      audio_ssrc: session.audioOutSsrc,
      sample_rate: request.audio.sample_rate,
      packet_time: packetTimeMs,
    }
    await startFfmpegForSession(bctx, session, request.sessionID, startParams, advertised)
    armHeartbeat(session, log)
    return
  }

  if (request.type === 'reconfigure') {
    if (!session.lastStartParams) {
      log.warn('export-hap: reconfigure before start — ignoring', {
        meta: { sessionID: request.sessionID },
      })
      return
    }
    if (session.ffmpeg) {
      killFfmpeg(session, bctx.ctx, bctx.numericDeviceId)
    }
    // Reconfigure reuses the audio parameters captured at start time;
    // HAP never renegotiates the audio leg through a reconfigure event.
    // We still wipe the per-session timestamp anchors so the recycled
    // ffmpeg process starts a fresh re-stamping cycle.
    session.firstAudioOutTimestamp = null
    session.audioOutPacketCount = 0
    session.videoOutPacketCount = 0
    session.videoOutOctetCount = 0
    session.videoOutLastRtpTimestamp = 0
    session.videoOutLastRtcpAt = 0
    const startParams: StartFfmpegVideoParams = {
      width: request.video.width,
      height: request.video.height,
      fps: request.video.fps,
      max_bit_rate: request.video.max_bit_rate,
      mtu: session.lastStartParams.mtu,
      pt: session.lastStartParams.pt,
      audio_pt: session.lastStartParams.audioPt,
      audio_ssrc: session.lastStartParams.audioSsrc,
      sample_rate: session.lastStartParams.audioSampleRateEnum,
      packet_time: session.lastStartParams.audioPacketTimeMs,
      // From the SESSION, not the request: a reconfigure carries only size,
      // rate and ceiling — the profile and level were settled once, at
      // negotiation, and asking the reconfigure for them would read undefined.
      profile: session.lastStartParams.profile,
      level: session.lastStartParams.level,
    }
    log.info('export-hap: stream reconfigured', {
      meta: {
        sessionId: request.sessionID,
        width: request.video.width,
        height: request.video.height,
        fps: request.video.fps,
        maxBitrateKbps: request.video.max_bit_rate,
      },
    })
    await startFfmpegForSession(bctx, session, request.sessionID, startParams, advertised)
    armHeartbeat(session, log)
  }
}

interface StartFfmpegVideoParams {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly max_bit_rate: number
  readonly mtu: number
  readonly pt: number
  readonly audio_pt: number
  readonly audio_ssrc: number
  /** Negotiated audio sample rate (8/16/24 kHz as the HAP enum value). */
  readonly sample_rate: number
  /** Negotiated audio packet time in ms (20/30/40/60). */
  readonly packet_time: number
  /**
   * The H.264 profile and level the CONTROLLER selected, from `VideoInfo`.
   *
   * We advertise baseline, main and high — and then encoded baseline 3.1
   * regardless of the answer, which is an advertisement we did not honour.
   * Pass-through never had the problem: it forwards the camera's own stream,
   * whatever profile that is, and those cameras work.
   */
  readonly profile: H264Profile
  readonly level: H264Level
}

async function startFfmpegForSession(
  bctx: BuilderContext,
  session: SessionState,
  sessionId: string,
  video: StartFfmpegVideoParams,
  advertised: AdvertisedVideoProfile,
): Promise<void> {
  const { ctx, proxy, numericDeviceId, options } = bctx
  // Profile-keyed restream entries (Auto/High/Mid/Low) — never raw
  // camStream variants. Both HAP and WebRTC dial the SAME profile
  // restream, so the broker pulls the camera once and fans out (no
  // second physical pull → no Reolink concurrent-session 400/430).
  const startLog = ctx.logger.withTags({ deviceId: numericDeviceId })
  // The node's PINNED ffmpeg (D540), asked FIRST — before a single broker
  // round trip — because without it there is no session to set up. This spawn
  // was a bare `'ffmpeg'`: the HOST's binary, off PATH, while the broker next
  // to it ran ours. A node that cannot be given the pinned build refuses.
  const ffmpegBinaryPath = await requireSessionFfmpeg({
    resolveFfmpeg: options.resolveFfmpeg,
    log: startLog,
    sessionId,
    deviceId: numericDeviceId,
  })
  // Independent reads, issued TOGETHER. They used to await in sequence, and on
  // this path every await crosses into a stream-broker that freezes for
  // seconds at a time — so their latencies added inside a HomeKit write
  // handler that tears the session down when it is slow to respond.
  const [entries, brokerStreams] = await Promise.all([
    (async () => (await proxy.cameraStreams?.getProfileRtspEntries({})) ?? [])(),
    (async () => (await proxy.cameraStreams?.getBrokerStreams({})) ?? [])(),
  ])
  if (entries.length === 0) {
    startLog.warn('export-hap: stream start DROPPED — device publishes no profile RTSP entries', {
      meta: { sessionId, capBound: proxy.cameraStreams !== undefined },
    })
    throw new Error(`export-hap: no profile RTSP entries for device ${numericDeviceId}`)
  }
  // Resolve the operator's `streamPreference` (auto | high | mid | low)
  // against the broker's RTSP entries. With `pref === 'auto'` we drive
  // the shared picker with the iOS-negotiated target resolution
  // (`request.video.width × request.video.height`) — iOS already tells
  // us what its viewer can handle, so honouring it avoids handing a
  // 4 K main stream to a phone tile that wants 720p / 1080p (the cam
  // emits ~6 Mbps at 4 K, well past HomeKit's typical bandwidth
  // envelope and the iPhone buffer drains in bursts → user sees
  // freeze/recover cycles even though the server-side pipeline is
  // healthy). The picker prefers ≥ target so consumer downscales,
  // and falls back to the LARGEST ≤ target when nothing reaches it
  // (e.g. only a 360 p sub-stream is available).
  //
  // R5 narrows the candidate set BEFORE that picker runs: a slot whose
  // rate does not fit the negotiated `max_bit_rate` is not passed
  // through. A 19.27 s session on 101/mid forwarded ~421 kbps against a
  // negotiated 299 and the controller reported losing 61 % of it — with
  // `-c:v copy` there was no lever at all. See `stream-bitrate.ts`.
  const pref = options.hapDeviceSettings.streamPreference
  // WHICH slot is the shared picker's question, not ours.
  //
  // `cameraStreams.pickStream` is the one surface every broker consumer scores
  // through and HomeKit was the only one that never called it — it ranked RTSP
  // entries with a second helper and then grew a private resolution rule on
  // top. The cap answers with a profile AND the url to dial it, so nothing here
  // translates anything.
  //
  // Only for `auto`: an operator pin is an instruction about which slot to
  // serve, and a picker must not overrule it.
  //
  // A `null` answer is not a failure. It means nothing can be forwarded
  // untouched — an HEVC-only camera on the classic service, say — and the
  // existing path then transcodes, naming its own reason.
  const capPick =
    pref === 'auto'
      ? await probe(
          () =>
            proxy.cameraStreams?.pickStream(
              passthroughRequest({
                negotiatedHeight: video.height,
                multiTier: session.negotiatedVia === 'multi-tier',
              }),
            ),
          'cameraStreams.pickStream',
          startLog,
        )
      : null
  if (capPick?.profile !== undefined) {
    startLog.info('export-hap: the shared picker chose the slot', {
      meta: {
        sessionId,
        profile: capPick.profile,
        camStreamId: capPick.camStreamId,
        codec: capPick.codec ?? 'unknown',
        fps: capPick.fps ?? null,
        fpsSource: capPick.fpsSource ?? null,
        negotiated: `${video.width}x${video.height}`,
        reason: capPick.reason,
      },
    })
  }
  /** The picker's slot when it found one, otherwise the operator's setting. */
  const effectivePref: 'auto' | string = capPick?.profile ?? pref
  const bitrates = await probeProfileBitrates({
    bctx,
    slots: brokerStreams,
    log: startLog,
  })
  // How this controller is connected decides the slot when the operator has
  // not pinned one. The signal is the AUDIO packet time — Opus negotiates
  // 20 ms locally, 60 ms through a relay — and it is the only remote-ness cue
  // HAP exposes. Every blank-screen session on this hub logged 20 while the
  // picker matched 1280x720 to a 10 fps slot.
  const connection = classifyConnection({
    negotiatedWidth: video.width,
    audioPacketTimeMs: session.negotiated?.audioPacketTimeMs ?? 20,
    // Not inferable from HAP. The reference keeps its own record of the last
    // known hub; until we do, a session that is not remote is treated as local.
    viaHomeHub: false,
  })
  const fit = selectStreamForBudget({
    entries: withSlotCodecs(entries, brokerStreams),
    deviceId: numericDeviceId,
    pref: effectivePref,
    connection,
    targetResolution: { width: video.width, height: video.height },
    negotiatedMaxBitrateKbps: video.max_bit_rate,
    bitrates,
    // Only the new service can carry HEVC. See `canPassThrough`.
    allowHevcPassthrough: session.negotiatedVia === 'multi-tier',
  })
  if (fit === null) {
    startLog.warn('export-hap: stream start DROPPED — no ENABLED profile RTSP entry', {
      meta: {
        sessionId,
        streamPreference: pref,
        targetResolution: `${video.width}x${video.height}`,
        entries: entries.map((e) => `${e.profile}:${e.enabled ? 'enabled' : 'disabled'}`),
      },
    })
    throw new Error(`export-hap: no enabled RTSP entries for device ${numericDeviceId}`)
  }
  // The operator's spend switch. HAP has already NEGOTIATED a resolution with
  // the controller by now, so a refusal here ends the session — which is the
  // honest outcome: an operator who switched transcoding off asked for exactly
  // that, and a refusal they chose must be reported as a refusal and not as a
  // fault (D62). Absent means allowed, like every switch whose field postdates
  // the entries it governs.
  if (fit.kind === 'transcode' && bctx.options.hapDeviceSettings?.allowTranscode === false) {
    startLog.warn('export-hap: stream start REFUSED — transcoding is switched off', {
      tags: { deviceId: numericDeviceId },
      meta: {
        sessionId,
        streamPreference: pref,
        negotiated: `${video.width}x${video.height}`,
        pickedProfile: fit.profile,
        // Named so the operator can see WHAT would have had to be re-encoded,
        // and decide whether to switch it back on or pin a different slot.
        pickedCodec: fit.picked.codec ?? 'unknown',
      },
    })
    throw new Error(
      `export-hap: device ${numericDeviceId} needs a transcode and transcoding is switched off`,
    )
  }

  const picked = fit.picked
  const rtspUrl = picked.url
  // Match the broker slot on its PROFILE, not on `brokerId`. The two ids are
  // different strings: a profile restream entry is keyed `101/mid` while the
  // slot the broker returns is keyed by its source (`101/native:slot-3`), so
  // the id comparison this replaced never matched and the codec fallback it
  // guarded had never once fired.
  const slot = brokerStreams.find((s) => s.profile === fit.profile)
  const codec = (picked.codec ?? slot?.codec ?? '').toLowerCase()
  const needsTranscode = fit.kind === 'transcode'
  // What the ENCODER may aim at, which is not the same question as which slot
  // fits. A copy has no encoder and keeps `fit.budgetKbps` for the log; a
  // transcode gets the guide's normative target for the resolution it
  // delivers, with the negotiated budget as a floor. See `encodeBudgetKbps`:
  // the same controller on the same link already tolerates 8192 kbps of
  // passed-through video, so holding its re-encoded sibling to 269 was giving
  // up picture for a ceiling nobody enforces.
  const encodeBudget = needsTranscode
    ? encodeBudgetKbps({ negotiatedBudgetKbps: fit.budgetKbps, width: video.width })
    : fit.budgetKbps
  // A transcode emits H.264 whatever it read; a copy forwards the source's own
  // codec. The counter reads this, and a counter reading the wrong parser is a
  // working stream reporting zero key frames.
  session.wireCodec =
    !needsTranscode && (codec.includes('h265') || codec.includes('hevc')) ? 'h265' : 'h264'

  // ── What we picked, against what we promised (R2) ─────────────────
  // The picker resolves the operator's preference against the resolution the
  // CONTROLLER negotiated, so a 1280×720 request lands on whichever slot is
  // closest — historically Mid, which on 101 runs at 10 fps while the
  // advertisement claimed 30. The advertised list is now derived from the same
  // picker, so these two should agree; when they do not, that divergence is
  // the first thing worth seeing.
  const pickedProfile = toKnownProfile(picked.profileId)
  const resolvedFps =
    pickedProfile === null ? undefined : advertised.fpsByProfile.get(pickedProfile)
  const advertisedFps = resolvedFps?.fps ?? video.fps
  const advertisedFpsSource: ProfileFpsSource = resolvedFps?.source ?? 'assumed'
  // What we will actually put on the wire. Under `-c:v copy` that is the
  // slot's own cadence — we cannot change it.
  //
  // Under a transcode we CAN, and we now match the negotiated rate rather than
  // the slot's. This reverses an earlier choice to cap at the slot rate on the
  // grounds that `-r` above the source makes ffmpeg duplicate frames and spend
  // the budget on nothing. The saving is largely imaginary — a duplicated frame
  // encodes to a handful of bits as a skipped P-frame — and the price was a
  // stream that contradicts its own negotiation: iOS asked for 30 and received
  // 9, which our own log has warned about on every session while nothing acted
  // on it. Delivering what was negotiated is the rule this repo already holds
  // (D67): a stream that does not match its advertisement is the defect class
  // that kept HomeKit black for a year.
  const deliveredFps = needsTranscode ? video.fps : advertisedFps
  const slotEvidence = pickedProfile === null ? undefined : bitrates.get(pickedProfile)
  const fitNotes = formatFitNotes(fit.notes)
  session.selectedSlot = {
    profile: pickedProfile,
    brokerId: picked.brokerId,
    width: picked.resolution?.width ?? null,
    height: picked.resolution?.height ?? null,
    advertisedFps,
    advertisedFpsSource,
    deliveredFps,
    codec: codec.length > 0 ? codec : 'unknown',
    transcode: needsTranscode,
    fitReason: fit.reason,
    publishedKbps: slotEvidence?.publishedKbps ?? null,
    measuredKbps: slotEvidence?.measuredKbps ?? null,
    budgetKbps: encodeBudget,
    fitNotes,
  }
  // The R5 decision, on its own line, ALWAYS — a session that silently kept
  // passing an over-budget stream through is the state this ends, and silence
  // reads as "it fitted".
  startLog.info('export-hap: stream bitrate fit resolved', {
    meta: {
      sessionId,
      decision: fit.kind,
      reason: fit.reason,
      negotiatedMaxBitrateKbps: video.max_bit_rate,
      encodeBudgetKbps: encodeBudget,
      profile: pickedProfile,
      brokerId: picked.brokerId,
      slotPublishedKbps: slotEvidence?.publishedKbps ?? null,
      slotMeasuredKbps: slotEvidence?.measuredKbps ?? null,
      candidates: fitNotes,
    },
  })
  if (deliveredFps !== video.fps) {
    startLog.warn('export-hap: negotiated fps does NOT match the rate we are about to deliver', {
      meta: {
        sessionId,
        negotiatedFps: video.fps,
        slotFps: advertisedFps,
        slotFpsSource: advertisedFpsSource,
        deliveredFps,
        profile: pickedProfile,
        brokerId: picked.brokerId,
        // `-c:v copy` forwards the source's own cadence untouched: we cannot
        // honour a rate we do not receive, only advertise honestly (D51). A
        // transcode CAN slow down, never speed up.
        transcode: needsTranscode,
      },
    })
  }

  // ffmpeg writes PLAIN RTP to our loopback sockets — the JS-side
  // SRTP encrypt happens in `forwardEncryptedRtp` (the loopback `on`
  // handler in `prepareStream`). This is the key architectural shift:
  // ffmpeg's `-srtp_out_*` flags would have ffmpeg own the iOS-facing
  // socket, which means iOS's RTCP probe would land on a source port
  // we don't observe — the 1 s gate would never release and iOS would
  // silently drop the stream after 30 s.
  const videoLoopPort = session.videoLoopUdp.address().port
  const audioLoopPort = session.audioLoopUdp.address().port
  const videoTarget = `rtp://127.0.0.1:${videoLoopPort}?pkt_size=${video.mtu}`
  // Apple Home tolerates fairly small audio MTUs; we reuse the video MTU
  // for simplicity. libopus respects `-pkt_size` and fragments accordingly.
  const audioTarget = `rtp://127.0.0.1:${audioLoopPort}?pkt_size=${video.mtu}`

  // Pass-through (`-c:v copy -bsf:v dump_extra`) or a rate-capped re-encode.
  // The whole cap lives in `buildVideoEncodeArgs` so the flags that bound the
  // wire are assertable in a unit test rather than trusted — the previous
  // inline vector used `-bufsize` at TWICE the rate, a two-second VBV window
  // that permits exactly the burst the controller reported losing.
  // The controller's OWN choice. We advertise three profiles and used to
  // encode one regardless of the answer — an advertisement we never honoured,
  // and no line anywhere said so.
  const selectedProfile = HAP_PROFILE_NAMES[video.profile] ?? 'baseline'
  const selectedLevel = HAP_LEVEL_NAMES[video.level] ?? '3.1'
  ctx.logger.info('export-hap: encoder profile', {
    tags: { deviceId: numericDeviceId },
    meta: {
      selectedByController: `${selectedProfile}/${selectedLevel}`,
      transcode: needsTranscode,
    },
  })
  const videoPlan = buildVideoPlan({
    transcode: needsTranscode,
    width: video.width,
    height: video.height,
    fps: deliveredFps,
    budgetKbps: encodeBudget,
    profile: selectedProfile,
    level: selectedLevel,
  })

  // ── Hardware DECODE, when the node has it (see `stream-hwaccel.ts`) ──
  // Only the transcode branch decodes at all. The backend is never chosen
  // here: it comes from the decoder addon's per-node probe, and an unreadable
  // or unprobed node stays in software rather than guessing a device that may
  // not exist — a wrong `-hwaccel` kills ffmpeg at spawn, which reads exactly
  // like the year-long failure this path just escaped.
  // Bounded for the same reason as the rate evidence: a decoder that does not
  // answer promptly costs hardware decode, never the session. Falling back to
  // software is already the documented behaviour when the decoder cannot
  // answer — this makes "cannot answer IN TIME" reach the same place.
  const decoderReading = needsTranscode
    ? await withDeadline(
        probeDecoderHwaccel({
          source: decoderInfoSourceFromContext(ctx),
          log: startLog,
          memo: options.decodeMemos.reading,
        }),
        HWACCEL_PROBE_BUDGET_MS,
        null,
        () =>
          startLog.warn(
            'export-hap: hwaccel probe ABANDONED on its budget — decoding in SOFTWARE',
            {
              meta: { budgetMs: HWACCEL_PROBE_BUDGET_MS },
            },
          ),
      )
    : null
  const hwDecode = selectHwDecode({
    transcode: needsTranscode,
    reading: decoderReading,
    platform: process.platform,
    // A backend that died at init in THIS process minutes ago is not tried
    // again until the memo expires. Without this, HomeKit's own software retry
    // saved the session that hit it and told nobody, so the next session paid
    // the same two-second death — the gap the broker closed for its own
    // children in 26a522cd5.
    recentlyFailedBackend: options.decodeMemos.failedBackend.read() ?? null,
  })
  logDecodePath(startLog, sessionId, hwDecode, needsTranscode)

  // Two-output ffmpeg invocation. The single input is the RTSP source;
  // we split into a video output (SRTP to video port) and an audio
  // output (SRTP to audio port). ffmpeg-internal stream selection (-vn
  // / -an + per-output codec args) keeps the bytes flowing through one
  // process — same lifetime, same kill signal.
  // ffmpeg parses `-ssrc` as int32 SIGNED — any value > 2^31-1 is
  // rejected with "out of range" + immediate exit. iOS hands us
  // `video.audio_ssrc` as a uint32, half of which falls above 2^31;
  // we coerce via `| 0` which mangles the JS number to a signed
  // int32 with the SAME bit pattern. ffmpeg then writes those bits
  // into the RTP header unchanged — iOS sees the original SSRC.
  const videoSsrcSigned = session.videoSsrc | 0
  const audioSsrcSigned = video.audio_ssrc | 0

  // Built as a function of the decode DECISION so the software retry below is
  // the SAME vector minus `-hwaccel`, rather than a second hand-maintained copy
  // that drifts from this one. Every argument comes from the shared builder —
  // this addon describes the session, it does not spell it (D67).
  const buildArgs = (decode: HwDecodeDecision): readonly string[] =>
    buildFfmpegArgs(
      buildSessionInvocation({
        decode,
        rtspUrl,
        video: videoPlan,
        videoTarget,
        audioTarget,
        videoPayloadType: video.pt,
        videoSsrcSigned,
        audioPayloadType: video.audio_pt,
        audioSsrcSigned,
        audioPacketTimeMs: video.packet_time ?? 20,
        audioSampleRateKhz: video.sample_rate ?? 16,
      }),
    )

  const log = ctx.logger.withTags({ deviceId: numericDeviceId })
  // The iOS 15.5+ first-RTCP gate is enforced PER-PACKET by the
  // loopback forwarder (`forwardEncryptedRtp` awaits
  // `session.videoSendGate` / `session.audioSendGate` before sending
  // the first SRTP packet). No pre-spawn delay needed — ffmpeg can
  // start emitting RTP straight away; packets are encrypted and held
  // until iOS's RTCP probe arrives (or the 1 s fallback fires).

  // One respawn budget for the whole session. `shouldRetryInSoftware` reads
  // it, and it is only ever set — never cleared — so a node whose hardware is
  // broken pays the failed init once per session, not once per exit.
  let hardwareAlreadyFailed = false

  const spawnFfmpeg = (decision: HwDecodeDecision): void => {
    const spawnedAtMs = Date.now()
    const usedHardware = decision.kind === 'hardware'
    const proc = spawn(ffmpegBinaryPath, buildArgs(decision), {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    session.ffmpeg = proc
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim()
      if (!line) return
      log.info('export-hap: ffmpeg', { meta: { sessionId, line } })
    })
    proc.once('exit', (code, signal) => {
      // A hardware context that cannot be created takes ffmpeg down within
      // milliseconds, having produced nothing. Left alone, the tile stays
      // blank and the session looks exactly like the failure this path just
      // escaped — so the same vector is respawned WITHOUT `-hwaccel`, once.
      if (
        shouldRetryInSoftware({
          usedHardware,
          hardwareAlreadyFailed,
          stopRequestedByController: session.stopRequestedByController,
          videoPacketsForwarded: session.videoPacketsForwarded,
          runtimeMs: Date.now() - spawnedAtMs,
        })
      ) {
        hardwareAlreadyFailed = true
        // Tell the PROCESS, not just this session. Until now the retry rescued
        // the session in front of it and left the next one to rediscover the
        // same dead device — across cameras too, since every mapper shares
        // these memos.
        if (decision.kind === 'hardware') options.decodeMemos.failedBackend.write(decision.backend)
        log.warn('export-hap: hardware decode FAILED at init — respawning ffmpeg in software', {
          meta: {
            sessionId,
            backend: decision.kind === 'hardware' ? decision.backend : null,
            backendSource: decision.kind === 'hardware' ? decision.source : null,
            code,
            signal,
            runtimeMs: Date.now() - spawnedAtMs,
          },
        })
        if (session.ffmpeg === proc) session.ffmpeg = null
        spawnFfmpeg(software('hardware-attempt-failed'))
        return
      }
      onFfmpegExit(proc, code, signal)
    })
    proc.once('error', (err) => {
      log.warn('export-hap: ffmpeg spawn failed', {
        meta: { sessionId, error: err.message },
      })
    })
  }

  const onFfmpegExit = (
    proc: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    session.ffmpegExit = { code, signal }
    // `code=255 signal=null` is ffmpeg TRAPPING our own SIGTERM from
    // `killFfmpeg` — i.e. a teardown we asked for, on behalf of the
    // controller's `stop`. The old line read `ffmpeg exited abnormally` for
    // that case and sent more than one investigation looking for an ffmpeg
    // fault that was not there. `stopRequestedByController` disambiguates.
    const ok = code === 0 && signal === null
    const meta = {
      sessionId,
      code,
      signal,
      stopRequestedByController: session.stopRequestedByController,
      videoPacketsForwarded: session.videoPacketsForwarded,
    }
    if (ok || session.stopRequestedByController) {
      log.info('export-hap: ffmpeg exited', { meta })
    } else {
      log.warn('export-hap: ffmpeg exited without a controller stop', { meta })
    }
    if (session.ffmpeg === proc) session.ffmpeg = null
    // The closing line. Also fires on the mid-session restarts iOS performs
    // when it is not getting a picture (one session was started three times
    // in 16 s), so each attempt gets its own accounting.
    logSessionSummary(session, log, session.teardownTrigger ?? 'ffmpeg-exit')
  }

  spawnFfmpeg(hwDecode)

  log.info('export-hap: stream started', {
    meta: {
      sessionId,
      transcode: needsTranscode,
      brokerId: picked.brokerId,
      profile: pickedProfile,
      sourceResolution:
        picked.resolution === undefined
          ? null
          : `${picked.resolution.width}x${picked.resolution.height}`,
      sourceCodec: codec.length > 0 ? codec : 'unknown',
      // Both halves of the R2 question in one place: what the controller asked
      // for, and what the slot we dialled actually delivers.
      negotiated: `${video.width}x${video.height}@${video.fps} ${video.max_bit_rate}kbps`,
      slotFps: advertisedFps,
      slotFpsSource: advertisedFpsSource,
      // What we will actually send, against that (R5).
      deliveredFps,
      fitReason: fit.reason,
      encodeBudgetKbps: encodeBudget,
      audioCodec: 'opus',
      audioBitrateKbps: OPUS_BITRATE_KBPS,
      // Which decode path this session actually dialled. Without it, a hub
      // that quietly stopped using its iGPU and one that never had it look
      // identical in a CPU graph.
      videoDecode: hwDecode.kind === 'hardware' ? hwDecode.backend : 'software',
    },
  })
}

/**
 * Say which decode path was resolved, and WHY, once per session.
 *
 * At `info` on purpose — Loki carries `info+`, and "did this session use the
 * GPU" is the first question anyone asks of a transcoding hub. The software
 * branch is the one that must never be silent: it is a real cost being paid,
 * and every reason it can be reached is a different fix.
 */
function logDecodePath(
  log: IScopedLogger,
  sessionId: string,
  decision: HwDecodeDecision,
  transcode: boolean,
): void {
  if (decision.kind === 'hardware') {
    log.info('export-hap: video decode path resolved — HARDWARE', {
      meta: {
        sessionId,
        backend: decision.backend,
        backendSource: decision.source,
        decodeArgs: decision.args,
      },
    })
    return
  }
  // Pass-through decodes nothing, so "software" there is not a cost.
  const level = transcode ? 'warn' : 'info'
  const message =
    level === 'warn'
      ? 'export-hap: video decode path resolved — SOFTWARE, this transcode costs a core'
      : 'export-hap: video decode path resolved — none needed'
  log[level](message, {
    meta: { sessionId, reason: decision.reason, transcode },
  })
}

/**
 * `PickedStream.profileId` is the brokerId suffix; for a profile-keyed entry
 * that IS the profile name. Anything else addresses a raw cam-stream and must
 * not be coerced into a profile.
 */
function toKnownProfile(profileId: string): 'high' | 'mid' | 'low' | null {
  if (profileId === 'high' || profileId === 'mid' || profileId === 'low') return profileId
  return null
}

// ── Upstream audio (iPhone → cam, "press-to-talk") ───────────────────

/**
 * Handle one incoming SRTP audio packet from iOS Home.
 *
 * End-to-end flow:
 *  1. SRTP-decrypt via `werift-rtp` using the master key/salt HAP
 *     negotiated in `prepareStream`. Returns the plaintext RTP packet.
 *  2. Parse the RTP header; reject anything whose PT doesn't match the
 *     HAP-negotiated audio PT (iOS multiplexes RTCP + keepalives on the
 *     same UDP socket, and pre-`start` traffic would prematurely open
 *     the camera-side talk channel).
 *  3. Lazy-init the `intercom.startTalkSession` on first packet, with
 *     a sync sentinel BEFORE the first await — the listener fires
 *     ~50×/s and concurrent invocations would otherwise each spawn a
 *     parallel camera-side PUT.
 *  4. Forward the raw Opus payload to the camera via
 *     `intercom.pushTalkAudio({ codec: 'opus', sampleRate, ... })`. We
 *     do NOT decode here — the provider owns decode + resample +
 *     camera-side encode and knows its native rate; the entrypoint
 *     stays codec-agnostic.
 */
async function handleIncomingAudioRtp(
  session: SessionState,
  packet: Buffer,
  sourceAddress: string,
  bctx: BuilderContext,
): Promise<void> {
  void sourceAddress
  // Drop obviously-malformed packets early — RTP header is 12 bytes
  // minimum, anything smaller is either keepalive noise or junk.
  if (packet.length < 12) {
    drop(session, 'upstream-short-packet')
    return
  }

  const log = bctx.ctx.logger.withTags({ deviceId: bctx.numericDeviceId })
  session.upstreamRtpPacketsReceived += 1

  // ── SRTP decrypt (werift-rtp) ─────────────────────────────────────
  // The HAP-negotiated master key/salt is fed straight into the suite's
  // AES-CM + HMAC-SHA1 session at `prepareStream` time. `decrypt`
  // validates the HMAC tag and returns the plaintext RTP packet
  // (header + payload). We then re-parse the header to peel off the
  // Opus payload and read the RTP timestamp.
  if (!session.upstreamAudioSrtp) {
    // Init failed earlier (warned then). Counted here so the session summary
    // shows talk-back was structurally impossible rather than merely unused.
    drop(session, 'upstream-no-srtp')
    return
  }
  let decryptedPacket: Buffer
  try {
    decryptedPacket = session.upstreamAudioSrtp.decrypt(packet)
    session.upstreamRtpPacketsDecrypted += 1
  } catch (err) {
    drop(session, 'upstream-decrypt-failed')
    session.upstreamRtpDecryptFailures += 1
    if (session.upstreamRtpDecryptFailures % 100 === 1) {
      log.debug('export-hap: SRTP decrypt failed (rate-limited)', {
        meta: {
          failures: session.upstreamRtpDecryptFailures,
          error: errMsg(err),
        },
      })
    }
    return
  }
  let decryptedPayload: Buffer
  let rtpTimestamp: number
  let rtpPayloadType: number
  try {
    const parsedRtp = RtpPacket.deSerialize(decryptedPacket)
    decryptedPayload = parsedRtp.payload
    rtpTimestamp = parsedRtp.header.timestamp
    rtpPayloadType = parsedRtp.header.payloadType
  } catch (err) {
    // Parse failure on a successfully-decrypted packet is exotic —
    // log once per session class.
    drop(session, 'upstream-parse-failed')
    log.debug('export-hap: RTP parse failed after decrypt', {
      meta: { error: errMsg(err) },
    })
    return
  }

  // Drop everything that arrives before `handleStreamRequest('start')`
  // has settled — without that, iOS's RTCP probe (sent during
  // `prepareStream`) reads as an "audio" packet and prematurely opens
  // the camera-side talk channel; the operator then sees the mic
  // button vanish and the iOS speaker stay muted while the camera-side
  // PUT idle-times out after ~9 s.
  const negotiatedAudioPt = session.lastStartParams?.audioPt
  if (negotiatedAudioPt === undefined) {
    drop(session, 'upstream-before-start')
    return
  }
  // Drop non-audio packets: iOS multiplexes RTCP and occasional
  // keepalives on the same UDP socket, and a mismatched payload type
  // can also prematurely open the talk channel.
  if (rtpPayloadType !== negotiatedAudioPt) {
    drop(session, 'upstream-pt-mismatch')
    return
  }

  if (session.firstUpstreamRtpTimestamp === null) {
    session.firstUpstreamRtpTimestamp = rtpTimestamp
    log.info('export-hap: first upstream RTP packet received')
  }

  const payload = decryptedPayload
  if (payload.length === 0) {
    drop(session, 'upstream-empty-payload')
    return
  }

  // Lazy-init intercom talk session. We open it BEFORE the first frame
  // is forwarded so the camera-side handshake (Reolink: dedicated
  // Baichuan talk channel; Hikvision: ISAPI sticky PUT) is complete by
  // the time we start feeding audio. Failure here is non-fatal — we
  // log + drop until `endTalkSession` clears the state so the operator
  // can retry by stopping/starting in iOS Home.
  //
  // CRITICAL: the UDP listener feeding this function fires ~50×/s
  // (one Opus frame per 20 ms). We MUST set a sentinel BEFORE the
  // first await yields the event loop, otherwise every concurrently
  // arriving packet enters this branch with `intercomTalkSessionId
  // === null` and spawns its own parallel talk session — each opens
  // its own camera-side PUT, all of which the camera tears down
  // simultaneously when the first one goes idle, producing a cascade
  // of "audioData PUT closed by camera" log entries.
  if (session.intercomTalkSessionId === null) {
    session.intercomTalkSessionId = ''
    const opened = await openIntercomTalkSession(bctx).catch((err: unknown) => {
      log.warn('export-hap: intercom.startTalkSession failed', {
        meta: { error: errMsg(err) },
      })
      return null
    })
    if (opened) {
      session.intercomTalkSessionId = opened.sessionId
      log.info('export-hap: intercom talk session opened', {
        meta: { sessionId: opened.sessionId },
      })
    }
    // On failure leave the `''` sentinel in place; the next frame
    // will see it as falsy and skip pushTalkAudio. A pushTalkAudio
    // failure later clears it back to `null` to retry, and
    // `handleStreamRequest('stop')` resets via closeIntercomTalkSession.
  }

  // Ship the Opus frame straight to the provider — it owns the decode
  // + resample + camera-encode chain. We do NOT decode here; doing
  // so would require us to know the camera-native rate (Hikvision
  // 8 kHz, Reolink 16 kHz, …) which is a provider concern by
  // design. The HAP audio leg is Opus on the wire; `sampleRate` is
  // the encoder clock iOS negotiated (8/16/24 kHz; transmitted via
  // `request.audio.sample_rate * 1000`).
  if (!session.intercomTalkSessionId) {
    // The `''` sentinel: the talk session failed to open. Every mic frame the
    // operator speaks is discarded here, and the only prior evidence was a
    // single warn at open time.
    drop(session, 'upstream-no-talk-session')
    return
  }
  const opusSampleRateHz = (session.lastStartParams?.audioSampleRateEnum ?? 16) * 1000
  session.intercomPcmSequence += 1
  session.upstreamPcmFramesDecoded += 1
  try {
    await bctx.proxy.intercom?.pushTalkAudio({
      audioBase64: payload.toString('base64'),
      codec: 'opus',
      sampleRate: opusSampleRateHz,
      channels: 1,
      sequenceNumber: session.intercomPcmSequence,
    })
  } catch (err) {
    // The camera-side talk channel can close mid-stream (Hikvision's
    // ISAPI PUT times out after a few seconds of zero traffic and
    // returns `socket hang up` on the next write). Clear the cached
    // session id so the next chunk re-opens — without this, every
    // subsequent push hits a dead handle and the operator never sees
    // talkback recover until the iOS stream is restarted.
    drop(session, 'upstream-push-failed')
    log.debug('export-hap: intercom.pushTalkAudio failed (will re-open on next frame)', {
      meta: {
        sequenceNumber: session.intercomPcmSequence,
        error: errMsg(err),
      },
    })
    session.intercomTalkSessionId = null
  }
  // Heartbeat log every ~5 s of forwarded audio so the operator can
  // confirm packets are flowing without spamming on every frame.
  if (session.upstreamPcmFramesDecoded % 250 === 0) {
    log.info('export-hap: upstream audio forwarded to camera', {
      meta: {
        rtpPackets: session.upstreamRtpPacketsReceived,
        rtpDecrypted: session.upstreamRtpPacketsDecrypted,
        rtpDecryptFailures: session.upstreamRtpDecryptFailures,
        pcmFrames: session.upstreamPcmFramesDecoded,
        pcmSequence: session.intercomPcmSequence,
        talkSessionId: session.intercomTalkSessionId || null,
      },
    })
  }
}

async function openIntercomTalkSession(
  bctx: BuilderContext,
): Promise<{ sessionId: string } | null> {
  const intercom = bctx.proxy.intercom
  if (!intercom) {
    bctx.ctx.logger
      .withTags({ deviceId: bctx.numericDeviceId })
      .debug('export-hap: intercom cap not exposed by device — skipping talk-back')
    return null
  }
  return intercom.startTalkSession({})
}

async function closeIntercomTalkSession(
  session: SessionState,
  bctx: BuilderContext,
): Promise<void> {
  const sessionId = session.intercomTalkSessionId
  session.intercomTalkSessionId = null
  if (!sessionId) return
  const log = bctx.ctx.logger.withTags({ deviceId: bctx.numericDeviceId })
  try {
    await bctx.proxy.intercom?.endTalkSession({})
    log.info('export-hap: intercom talk session closed', {
      meta: { sessionId },
    })
  } catch (err) {
    log.debug('export-hap: intercom.endTalkSession failed (continuing)', {
      meta: { sessionId, error: errMsg(err) },
    })
  }
}

// ── ffmpeg + socket cleanup ──────────────────────────────────────────

function killFfmpeg(session: SessionState, _ctx: BuilderContext['ctx'], _deviceId: number): void {
  const proc = session.ffmpeg
  if (!proc) return
  session.ffmpeg = null
  try {
    proc.kill('SIGTERM')
  } catch {
    /* process gone */
  }
  const fallback = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* process gone */
    }
  }, 2_000)
  // Unref so the timer doesn't keep the event loop alive.
  fallback.unref()
}

function closeSocket(udp: UdpSocket): void {
  try {
    udp.close()
  } catch {
    /* socket already closed */
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function randomSsrc(): number {
  // 31-bit positive int avoids signed-vs-unsigned interop issues with
  // HAP's serialization; >0 because some controllers reject ssrc=0.
  return (Math.floor(Math.random() * 0x7ffffffe) + 1) | 0
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
