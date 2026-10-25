/**
 * Per-session accounting for the HomeKit live-view path.
 *
 * A year of investigation into the ~31 s teardown had to reconstruct each
 * session by hand-correlating timestamps, because the delegate logged that a
 * stream started and that ffmpeg exited, and nothing in between. Three facts
 * were repeatedly ASSUMED and never observable:
 *
 *   - what parameters were actually negotiated (width/height/fps/bitrate/PT/SSRC);
 *   - whether the controller ever sent us anything on the return ports;
 *   - which of the many early returns on the packet path ate the media.
 *
 * This module owns the third and the shape of the summary line that carries
 * all three. Everything here is pure so the summary can be asserted in a unit
 * test instead of being trusted.
 *
 * The second of those was settled on 2026-08-06 — the controller DOES send us
 * RTCP on the video leg — which promoted a fourth question to the one that
 * matters: not whether it spoke, but what it SAID. `rtcp-receiver-report.ts`
 * reads that, and `lossVerdict` below turns it into the one field to read
 * first.
 *
 * Immutability is deliberate: `recordDrop` returns a new record. A shared
 * mutable tally is how a "zero drops" reading survives a live bug.
 */
import type { RtcpGateResolution } from './rtcp-gate.js'
import { formatRtcpGate } from './rtcp-gate.js'
import type { ReceiverReportTally } from './rtcp-receiver-report.js'
import type { CopyReason, TranscodeReason } from './stream-bitrate.js'
import type { ProfileFpsSource } from './stream-fps.js'

/** Why the selected slot is passed through or re-encoded. */
export type StreamFitReason = CopyReason | TranscodeReason

/**
 * Every branch on the streaming path that discards work, and its starting
 * count. This object is the single source of the reason set: the union below
 * is its `keyof`, so adding a silent `return` without adding a reason here is
 * a compile error rather than an invisible hole.
 */
const ZERO_DROP_COUNTERS = {
  /** Outbound: the leg has no SRTP session (prepareStream init failed). */
  'no-srtp-session': 0,
  /** Outbound: the leg has no return-path gate — forwarding was never armed. */
  'no-gate': 0,
  /** Outbound: werift refused to encrypt the packet. */
  'srtp-encrypt-failed': 0,
  /** Outbound: the UDP send itself errored. */
  'srtp-send-failed': 0,
  /** Outbound RTCP: the leg has no SRTCP context, so no Sender Report can go out. */
  'rtcp-no-srtcp': 0,
  /** Outbound RTCP: building or encrypting the Sender Report failed. */
  'rtcp-encrypt-failed': 0,
  /** Inbound RTCP: the leg has no SRTCP context, so the controller's report is unreadable. */
  'inbound-rtcp-no-srtcp': 0,
  /** Inbound RTCP: SRTCP decryption of a controller packet failed. */
  'inbound-rtcp-decrypt-failed': 0,
  /** Inbound RTCP: the decrypted bytes did not parse as RTCP. */
  'inbound-rtcp-parse-failed': 0,
  /** Upstream: packet shorter than an RTP header. */
  'upstream-short-packet': 0,
  /** Upstream: no inbound SRTP context (init failed at prepareStream). */
  'upstream-no-srtp': 0,
  /** Upstream: SRTP authentication/decrypt failed. */
  'upstream-decrypt-failed': 0,
  /** Upstream: decrypted bytes did not parse as RTP. */
  'upstream-parse-failed': 0,
  /** Upstream: audio arrived before `handleStreamRequest('start')` settled. */
  'upstream-before-start': 0,
  /** Upstream: payload type is not the negotiated audio PT (RTCP / keepalive). */
  'upstream-pt-mismatch': 0,
  /** Upstream: RTP carried a zero-length payload. */
  'upstream-empty-payload': 0,
  /** Upstream: no camera-side talk session, so the frame has nowhere to go. */
  'upstream-no-talk-session': 0,
  /** Upstream: the camera-side `pushTalkAudio` rejected the frame. */
  'upstream-push-failed': 0,
  /** Snapshot: the `snapshot` cap returned nothing. */
  'snapshot-unavailable': 0,
}

export type StreamDropReason = keyof typeof ZERO_DROP_COUNTERS

export type DropCounters = Readonly<Record<StreamDropReason, number>>

export function emptyDropCounters(): DropCounters {
  return { ...ZERO_DROP_COUNTERS }
}

/** Immutable increment — returns a new record, never touches the input. */
export function recordDrop(counters: DropCounters, reason: StreamDropReason): DropCounters {
  return { ...counters, [reason]: counters[reason] + 1 }
}

/** Only the reasons that actually fired, so a clean session logs `{}`. */
export function nonZeroDrops(counters: DropCounters): Readonly<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [reason, count] of Object.entries(counters)) {
    if (count > 0) out[reason] = count
  }
  return out
}

/** What arrived on a return port. */
export type InboundPacketKind = 'rtp' | 'rtcp' | 'malformed'

/**
 * Classify a packet received on one of our advertised return ports.
 *
 * RTP and RTCP arrive on the same symmetric port here. RTCP packet types are
 * 200..207, which sit inside the 192..223 band RFC 5761 §4 reserves precisely
 * so the two can be told apart on a shared socket (an RTP packet's marker bit
 * plus payload type can never land there for any payload type we negotiate).
 * The payloads are SRTP/SRTCP-encrypted, but both keep the first two bytes in
 * the clear.
 */
export function classifyInboundPacket(packet: Buffer): InboundPacketKind {
  if (packet.length < 2) return 'malformed'
  const version = (packet[0]! >> 6) & 0x03
  if (version !== 2) return 'malformed'
  const typeByte = packet[1]!
  if (typeByte >= 192 && typeByte <= 223) return 'rtcp'
  return 'rtp'
}

export interface NegotiatedStreamParams {
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly maxBitrateKbps: number
  readonly mtu: number
  readonly videoPt: number
  readonly videoSsrc: number
  readonly videoRtcpIntervalMs: number
  readonly audioPt: number
  readonly audioSsrc: number
  readonly audioSampleRateKhz: number
  readonly audioPacketTimeMs: number
  readonly audioRtcpIntervalMs: number
  readonly audioMaxBitrateKbps: number
}

export interface SelectedSlotInfo {
  readonly profile: string | null
  readonly brokerId: string
  readonly width: number | null
  readonly height: number | null
  /** Rate we told the controller this slot delivers. */
  readonly advertisedFps: number
  readonly advertisedFpsSource: ProfileFpsSource
  /** Rate we will actually put on the wire — `-r` when transcoding. */
  readonly deliveredFps: number
  readonly codec: string
  readonly transcode: boolean
  /**
   * Why this slot is copied or re-encoded (R5). `over-budget` is the reading
   * that says the 421-vs-299 overshoot was recognised rather than repeated.
   */
  readonly fitReason: StreamFitReason
  /** Camera's CONFIGURED rate for the slot, kbps. `null` = unknown. */
  readonly publishedKbps: number | null
  /** Broker's MEASURED flow for the slot, kbps — a lower bound. */
  readonly measuredKbps: number | null
  /** The rate the encoder is aimed at. `null` = no cap applied. */
  readonly budgetKbps: number | null
  /** Every candidate slot's verdict, so the line can say why none fitted. */
  readonly fitNotes: readonly string[]
}

export interface FfmpegExitInfo {
  readonly code: number | null
  readonly signal: string | null
}

/**
 * What one loopback socket — the port ffmpeg writes plain RTP into — was given
 * by the kernel, and what the kernel threw away.
 *
 * Both halves are needed and neither is inferable from the other. The buffer
 * SIZE says whether a 4K key-frame burst could have fitted; the DROP counter
 * says whether it did. See `stream-socket-buffer.ts` for why this loss is
 * invisible in every other counter on the session.
 */
export interface LoopbackLegTelemetry {
  readonly rcvbufRequestedBytes: number | null
  /** `getsockopt(SO_RCVBUF)`. `null` ⇒ unknowable on this platform. */
  readonly rcvbufEffectiveBytes: number | null
  /** The kernel granted LESS than we asked for (`net.core.rmem_max`). */
  readonly rcvbufClamped: boolean
  /** `/proc/net/udp` per-socket drops. `null` ⇒ we could not look. */
  readonly kernelDrops: number | null
}

export interface SessionTelemetrySnapshot {
  readonly sessionId: string
  readonly startedAtMs: number | null
  readonly endedAtMs: number | null
  readonly negotiated: NegotiatedStreamParams | null
  readonly selectedSlot: SelectedSlotInfo | null
  readonly videoPacketsForwarded: number
  readonly audioPacketsForwarded: number
  /** Key frames seen on the forwarded video leg, and their arrival timing. */
  readonly videoKeyframes: number
  readonly firstKeyframeAtMs: number | null
  readonly maxKeyframeGapMs: number
  readonly videoRtcpSrSent: number
  readonly audioRtcpSrSent: number
  readonly videoRtcpReceived: number
  readonly audioRtcpReceived: number
  readonly videoRtpReceived: number
  readonly audioRtpReceived: number
  readonly videoGate: RtcpGateResolution | null
  readonly audioGate: RtcpGateResolution | null
  /** What the controller told us it received, per leg. */
  readonly videoReceiverReports: ReceiverReportTally
  readonly audioReceiverReports: ReceiverReportTally
  readonly drops: DropCounters
  readonly ffmpegExit: FfmpegExitInfo | null
  /** True when the teardown came from the controller's `stop` request. */
  readonly stopRequestedByController: boolean
  readonly videoLoopback: LoopbackLegTelemetry
  readonly audioLoopback: LoopbackLegTelemetry
}

export interface SessionSummaryMeta {
  readonly sessionId: string
  readonly durationMs: number | null
  readonly stopRequestedByController: boolean
  readonly ffmpegExitCode: number | null
  readonly ffmpegExitSignal: string | null
  readonly negotiatedResolution: string | null
  readonly negotiatedFps: number | null
  readonly negotiatedMaxBitrateKbps: number | null
  readonly selectedProfile: string | null
  readonly selectedBrokerId: string | null
  readonly advertisedFps: number | null
  readonly advertisedFpsSource: ProfileFpsSource | null
  readonly deliveredFps: number | null
  readonly transcode: boolean | null
  /** R5 — the copy/transcode decision, and the numbers it was taken on. */
  readonly fitReason: StreamFitReason | null
  readonly slotPublishedKbps: number | null
  readonly slotMeasuredKbps: number | null
  readonly encodeBudgetKbps: number | null
  readonly fitNotes: readonly string[]
  readonly videoPacketsForwarded: number
  /**
   * How long the controller waited with nothing to decode.
   *
   * A pass-through session forwards the key frames the camera decides to emit
   * and cannot request one, so this is the field that separates "the stream is
   * broken" from "the next IDR is twenty seconds away" — two states every
   * other counter here reports identically: packets forwarded, zero loss, a
   * loader on screen. `null` means no key frame was forwarded at all.
   */
  readonly msToFirstKeyframe: number | null
  readonly videoKeyframes: number
  /** Longest observed spacing between forwarded key frames. */
  readonly maxKeyframeGapMs: number
  readonly audioPacketsForwarded: number
  readonly videoRtcpSrSent: number
  readonly audioRtcpSrSent: number
  readonly videoRtcpReceived: number
  readonly audioRtcpReceived: number
  readonly videoRtpReceived: number
  readonly audioRtpReceived: number
  readonly videoGate: string
  readonly audioGate: string
  /** Roll-up of every Receiver Report the controller sent on each leg. */
  readonly videoReceiverReports: ReceiverReportTally
  readonly audioReceiverReports: ReceiverReportTally
  /** Which family of causes the video leg's reports point at. See `lossVerdict`. */
  readonly videoLossVerdict: LossVerdict
  readonly audioLossVerdict: LossVerdict
  /** True when the session forwarded no video at all — never inferred from absence. */
  readonly mediaStarved: boolean
  /**
   * The loopback receive buffer, flat so one Loki query can read it.
   *
   * Read these WITH `videoPacketsForwarded`. A low forwarded count next to
   * `videoLoopKernelDropped=true` is the kernel discarding a key-frame burst
   * that overran `SO_RCVBUF`; the same low count next to
   * `videoLoopKernelDropped=false` on an unclamped buffer means ffmpeg really
   * did not write the packets, and the cause is upstream of this socket.
   */
  readonly videoLoopRcvbufRequestedBytes: number | null
  readonly videoLoopRcvbufBytes: number | null
  readonly videoLoopRcvbufClamped: boolean
  readonly videoLoopKernelDrops: number | null
  /** `true` only on POSITIVE evidence — an unreadable counter is not "no drops". */
  readonly videoLoopKernelDropped: boolean
  readonly audioLoopRcvbufBytes: number | null
  readonly audioLoopKernelDrops: number | null
  readonly audioLoopKernelDropped: boolean
  readonly drops: Readonly<Record<string, number>>
}

/**
 * The two disjoint families the remaining HomeKit failure can fall into, plus
 * the case where we still cannot tell.
 *
 *  - `no-reports`      — the controller sent nothing readable. Says nothing
 *                        about the media; do NOT read it as "no loss".
 *  - `transmit-suspect`— the controller reports real loss. The packets arrive
 *                        damaged or unusable: SRTP, packetisation, MTU,
 *                        sequencing. Everything past the wire is irrelevant.
 *  - `decode-suspect`  — the controller reports it received the stream intact
 *                        and still renders nothing: parameter sets,
 *                        profile/level, timestamps, RTP marker/timestamp pacing.
 */
export type LossVerdict = 'no-reports' | 'transmit-suspect' | 'decode-suspect'

/**
 * Loss at or above this is not a start-up transient.
 *
 * A stream whose first key frame is slow reliably produces one report in the
 * low single digits; a transmit-side defect produces tens of percent, because
 * whatever makes a packet unusable makes most packets unusable. The threshold
 * sits between those two regimes rather than at any measured boundary — it is
 * a reading aid, and the raw `worstFractionLostPct` is always in the line
 * beside it.
 */
const TRANSMIT_SUSPECT_FRACTION_LOST_PCT = 5

export function lossVerdict(tally: ReceiverReportTally): LossVerdict {
  if (tally.blocksParsed === 0 || tally.worstFractionLostPct === null) return 'no-reports'
  return tally.worstFractionLostPct >= TRANSMIT_SUSPECT_FRACTION_LOST_PCT
    ? 'transmit-suspect'
    : 'decode-suspect'
}

/**
 * Build the meta for `export-hap: stream session summary` — the single line a
 * future session greps to answer "why did this session die".
 */
export function summariseSession(snapshot: SessionTelemetrySnapshot): SessionSummaryMeta {
  const durationMs =
    snapshot.startedAtMs !== null && snapshot.endedAtMs !== null
      ? snapshot.endedAtMs - snapshot.startedAtMs
      : null
  const negotiated = snapshot.negotiated
  const slot = snapshot.selectedSlot
  return {
    sessionId: snapshot.sessionId,
    durationMs,
    stopRequestedByController: snapshot.stopRequestedByController,
    ffmpegExitCode: snapshot.ffmpegExit?.code ?? null,
    ffmpegExitSignal: snapshot.ffmpegExit?.signal ?? null,
    negotiatedResolution: negotiated ? `${negotiated.width}x${negotiated.height}` : null,
    negotiatedFps: negotiated?.fps ?? null,
    negotiatedMaxBitrateKbps: negotiated?.maxBitrateKbps ?? null,
    selectedProfile: slot?.profile ?? null,
    selectedBrokerId: slot?.brokerId ?? null,
    advertisedFps: slot?.advertisedFps ?? null,
    advertisedFpsSource: slot?.advertisedFpsSource ?? null,
    deliveredFps: slot?.deliveredFps ?? null,
    transcode: slot?.transcode ?? null,
    fitReason: slot?.fitReason ?? null,
    slotPublishedKbps: slot?.publishedKbps ?? null,
    slotMeasuredKbps: slot?.measuredKbps ?? null,
    encodeBudgetKbps: slot?.budgetKbps ?? null,
    fitNotes: slot?.fitNotes ?? [],
    videoPacketsForwarded: snapshot.videoPacketsForwarded,
    msToFirstKeyframe:
      snapshot.firstKeyframeAtMs === null || snapshot.startedAtMs === null
        ? null
        : snapshot.firstKeyframeAtMs - snapshot.startedAtMs,
    videoKeyframes: snapshot.videoKeyframes,
    maxKeyframeGapMs: snapshot.maxKeyframeGapMs,
    audioPacketsForwarded: snapshot.audioPacketsForwarded,
    videoRtcpSrSent: snapshot.videoRtcpSrSent,
    audioRtcpSrSent: snapshot.audioRtcpSrSent,
    videoRtcpReceived: snapshot.videoRtcpReceived,
    audioRtcpReceived: snapshot.audioRtcpReceived,
    videoRtpReceived: snapshot.videoRtpReceived,
    audioRtpReceived: snapshot.audioRtpReceived,
    videoGate: formatRtcpGate(snapshot.videoGate),
    audioGate: formatRtcpGate(snapshot.audioGate),
    videoReceiverReports: snapshot.videoReceiverReports,
    audioReceiverReports: snapshot.audioReceiverReports,
    videoLossVerdict: lossVerdict(snapshot.videoReceiverReports),
    audioLossVerdict: lossVerdict(snapshot.audioReceiverReports),
    mediaStarved: snapshot.videoPacketsForwarded === 0,
    videoLoopRcvbufRequestedBytes: snapshot.videoLoopback.rcvbufRequestedBytes,
    videoLoopRcvbufBytes: snapshot.videoLoopback.rcvbufEffectiveBytes,
    videoLoopRcvbufClamped: snapshot.videoLoopback.rcvbufClamped,
    videoLoopKernelDrops: snapshot.videoLoopback.kernelDrops,
    videoLoopKernelDropped: (snapshot.videoLoopback.kernelDrops ?? 0) > 0,
    audioLoopRcvbufBytes: snapshot.audioLoopback.rcvbufEffectiveBytes,
    audioLoopKernelDrops: snapshot.audioLoopback.kernelDrops,
    audioLoopKernelDropped: (snapshot.audioLoopback.kernelDrops ?? 0) > 0,
    drops: nonZeroDrops(snapshot.drops),
  }
}
