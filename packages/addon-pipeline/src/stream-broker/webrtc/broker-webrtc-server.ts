/**
 * Broker-integrated WebRTC server.
 *
 * Unlike the old `addon-webrtc-adaptive` which spawned ffmpeg to re-encode
 * the broker's RTSP restream (Camera → Broker → RTSP → ffmpeg libx264 → RTP),
 * this server subscribes directly to `IStreamBroker.onEncodedData()` and
 * forward the raw H.264 packets to WebRTC sessions as-is — zero transcode,
 * zero extra RTSP connection, zero latency from re-encoding.
 *
 * Flow: Camera → RTSP → Broker → EncodedPacket → RTP packetization → WebRTC
 */

import crypto from 'node:crypto'
import type {
  EncodedPacket,
  EgressTranscode,
  EgressTranscodeRequest,
  IStreamBroker,
  IScopedLogger,
  Unsubscribe,
  EncodeProfile,
  BrokerConsumerAttribution,
  BrokerConsumerKind,
  WebrtcStreamTarget,
  CamProfile,
  WebrtcLadderDecision,
  WebrtcSessionDebug,
} from '@camstack/types'
import { isViewerConsumerKind, type ViewerCounts } from '../live-viewers.js'
import {
  CAM_PROFILE_ORDER,
  errMsg,
  makeSourceBrokerId,
  TRANSCODE_DOWN_MAX_BITRATE_KBPS,
  TRANSCODE_DOWN_MAX_HEIGHT,
} from '@camstack/types'
import { AdaptiveSession, type IceServerEntry, type IceCandidatePayload } from './session.js'
import { BrokerLingerRegistry } from './broker-linger-registry.js'
import {
  AdaptiveController,
  wireLadderCause,
  type LadderDecision,
  type Tier,
} from './adaptive-controller.js'
import { ADAPTIVE_CONFIG, ADAPTIVE_DELIVERY_CONFIG, ADAPTIVE_TICK_MS } from './adaptive-config.js'
import { DeliveryMeter, deliveryMeterStart, deliveryWindowMs } from './delivery-meter.js'
import { describeClimbHold, toWireClimbHold } from './climb-hold.js'
import { expectedRungKbps } from './rung-bitrate.js'
import { DeviceTryMemory, type TryClimbCarry } from './try-climb.js'
import {
  DeviceProbeMemory,
  PROBE_MEMORY_TTL_MS,
  isProbeFresh,
  probeFromHints,
  probeFromReport,
  type ProbeEvidence,
} from './probe-evidence.js'
import { buildStallSample } from './stall-tracker.js'
import { HoldLogGate } from './climb-hold.js'
import { projectSessionDebug, type SessionDebugLadder } from './session-debug.js'
import type { FrameSource, MediaFrame } from './types.js'
import {
  convertH264ToAnnexB,
  extractH264ParamSets,
  isBaselineProfileLevelId,
} from './h264-utils.js'
import { convertH265ToAnnexB } from './h265-utils.js'
import { WEBRTC_FALLBACK_PROFILE } from './webrtc-fallback-profile.js'
import { buildTranscodeEgressRequest, type TranscodeEgressLeg } from './transcode-egress-leg.js'
import {
  RecordedFeeder,
  type LocateResult,
  type FeederSink,
  type ReadGopFn,
} from '../recorded/recorded-feeder.js'
import {
  TimelineSession,
  type ClipPlaybackHandle,
  type MakeClipFeederArgs,
  type TimelineSessionClipFeeder,
} from '../recorded/timeline-session.js'
import { createClipFileSource } from '../recorded/clip-file-source.js'
import { chooseClipPath, createRefusedClipFeeder } from '../recorded/clip-path-choice.js'
import {
  createClipStreamFeeder,
  type ClipStreamAudioAsk,
  type ClipStreamDialAnswer,
} from '../recorded/clip-stream-feeder.js'
import type { Fmp4AudioCodec } from '../recorded/fmp4-stream-demux.js'
import { createHttpClipStreamOpener } from '../recorded/clip-stream-http.js'
import {
  demuxSegmentPreferJsOffThread,
  setDemuxWorkerLogger,
} from '../recorded/demux-off-thread.js'
import { FfmpegFallbackRefusedError, type AccessUnit } from '../recorded/segment-demux.js'
import type { FeederStateTransition } from '../recorded/recorded-feeder.js'
import { ScrubFragmentCache } from '../recorded/scrub-fragment-cache.js'
import {
  BackingTally,
  type SessionMemReading,
  sessionMemMeta,
} from '../stream-broker/session-mem.js'
import { DemuxPathTally } from '../recorded/demux-path-tally.js'
import { warmFragment } from '../recorded/warm-fragment.js'
import { demuxSegmentToPcmu } from '../recorded/segment-audio.js'
import { demuxSegmentAudioOpusPreferJs } from '../recorded/segment-audio-js.js'
import { parseControlMessage } from '../recorded/control-protocol.js'
import { preferLiveAdaptiveCandidates } from './prefer-live-adaptive-candidates.js'
import {
  IN_PLACE_SWITCH_KEYFRAME_WAIT_MS,
  bindPendingSource,
  judgeInPlaceSwitch,
  sessionCodecOf,
  type InPlaceRefusal,
  type InPlaceSessionShape,
  type InPlaceTargetShape,
} from './in-place-tier-switch.js'
import { TalkbackBridge, type TalkbackIntercomPort } from './talkback-bridge.js'
import { reportConsumerEvent } from '../stream-broker/broker-mem-probe.js'
import { pickAdaptiveTier, type AdaptivePickReason } from './adaptive-tier.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrokerWebrtcServerOptions {
  readonly logger: IScopedLogger
  /**
   * The device intercom's push-talk triple, for sessions opened with
   * `talkback: true` (D771). Absent ⇒ talk-back is refused (logged) and the
   * session is one-way like any other.
   */
  readonly talkbackIntercom?: TalkbackIntercomPort
  readonly getIceServers?: () => Promise<readonly IceServerEntry[]>
  readonly iceServers?: readonly IceServerEntry[]
  readonly icePortRange?: [number, number]
  readonly iceAdditionalHostAddresses?: readonly string[]
  /**
   * Optional injected async accessor for a device's LATEST client-reported
   * network conditions, or null when no client report exists.
   *
   * ONE accessor, not two, for the two facts the ladder needs off the same
   * record: the packet-loss percentage (0–100) it has always used, and the
   * client's measured inbound rate (`estimatedBandwidthKbps`) — the fact that
   * was sitting in `ClientNetworkStats` and being thrown away, and the only
   * one that can see a freeze. A second accessor reading the same row would
   * be a second authority on it.
   *
   * `lastUpdated` travels with them because AGE decides whether either means
   * anything: a stale record is unknown, and unknown is not zero (D393).
   *
   * Polled by the adaptive controller's tick so a downgrade can fire from
   * client telemetry (e.g. the benchmark "Network Simulation" presets) even
   * when no RTCP Receiver Report has arrived. The broker synthesizes a
   * monotonic {@link LossSample} from the percentage locally (see
   * `startAdaptive`). Only consulted for sessions created via the
   * `/adaptive` alias.
   */
  readonly clientNetworkStats?: (deviceId: number) => Promise<ClientNetworkSnapshot | null>
  /**
   * Optional accessors for recorded playback over WebRTC (the RecordedFeeder).
   * Injected from the recording cap (`recording.locateSegment` / `readSegmentBytes`)
   * by the addon that constructs the broker. When BOTH are present, each session
   * gets a TimelineSession + on-demand feeder; absent ⇒ recorded playback is
   * unavailable and control messages are ignored (live-only).
   */
  readonly locateRecordedSegment?: (args: {
    deviceId: number
    profile: string
    epochMs: number
  }) => Promise<LocateResult>
  readonly readRecordedSegmentBytes?: (args: {
    deviceId: number
    profile: string
    startMs: number
  }) => Promise<Uint8Array>
  /**
   * Optional GOP byte-range read (`recording.readGopBytes` — D31's letter on
   * the feeder path): ONE fragment covering an instant instead of the whole
   * segment. Feeds both the scrub tier and the timeline warm-up. Absent (an
   * older recording provider) ⇒ scrub degrades to whole-segment reads and
   * `warm` messages no-op.
   */
  readonly readRecordedGopBytes?: (args: {
    deviceId: number
    profile: string
    startMs: number
    /** The located segment's duration — lets a whole-segment fallback answer
     *  with a correct coverage window without a second locate. */
    segmentDurMs: number
    epochMs: number
  }) => Promise<{ data: Uint8Array; gopStartMs: number; gopDurMs: number }>
  /**
   * Read ONE clip file whole, by handle (`videoclips.readClipBytes` — D575).
   *
   * Present ⇒ a session can put its source pointer on a clip (`playClip`) and
   * play it through the SAME WebRTC track, feeder, demux and push sink as
   * recorded footage. Absent ⇒ `playClip` is refused by name and logged; a
   * clip never becomes a second player here.
   *
   * This is the ONLY byte crossing for a clip and it happens ONCE per clip:
   * the file arrives whole and already compressed, and every frame after that
   * is decoded in this process (D9/D18 — frames never cross a process boundary
   * at frame-rate).
   */
  readonly readClipBytes?: (args: {
    deviceId: number
    clipId: string
    /** The `addonId` holding the file — NAMED, never left to in-process
     *  resolution, which hands this addon its own sibling (D554's rule, one
     *  method over; measured on 3628, 2026-09-21). */
    provider: string
    profile: CamProfile | null
  }) => Promise<Uint8Array>
  /**
   * Where a clip's STREAM is dialled (`videoclips.dialClipStream` — D597).
   *
   * Present ⇒ every `playClip` plays FROM THE STREAM through
   * `clip-stream-feeder.ts` (D599): first frame at the first fragment,
   * forward-only. Absent ⇒ every clip takes the file path, and the choice is
   * logged as such. Never throws: a thrown cap error is classified into the
   * answer (`clip-stream-dial-answer.ts`) so a provider that predates the
   * method is a NAMED refusal, not a stack trace.
   *
   * `audio` is the codec THIS SESSION negotiated (D600), which the provider
   * transcodes to before it muxes. It travels on the dial because the mux is
   * spawned once, ahead of the first byte, and cannot gain a track later.
   */
  readonly dialClipStream?: (args: {
    deviceId: number
    clipId: string
    provider: string
    profile: CamProfile | null
    audio: ClipStreamAudioAsk
  }) => Promise<ClipStreamDialAnswer>
  /**
   * Resolve the ffmpeg binary path used by the recorded-playback demuxers
   * (`segment-demux` / `segment-audio` run one ffmpeg subprocess per fragment).
   * Read lazily per demux so a later `ffmpeg` config reload is honoured.
   * `null` (or no resolver) ⇒ the ffmpeg fallbacks REFUSE by name — never a
   * PATH `ffmpeg` (D540); the in-process JS demux still serves.
   */
  readonly resolveFfmpegPath?: () => string | null
}

/**
 * The client-reported slice of `ClientNetworkStats` the ladder consumes.
 * Structural, not the cap interface: the broker runs in its own runner and
 * reaches the hub-resident tracker over tRPC, so only these fields cross.
 */
export interface ClientNetworkSnapshot {
  /** 0–100, as the client derived it from `RTCInboundRtpStreamStats`. */
  readonly packetLossPercent: number
  /** Δ bytesReceived / Δ timestamp on the inbound video track, kbps. */
  readonly estimatedBandwidthKbps: number
  /** Wall clock of the report, ms. Age decides whether it means anything. */
  readonly lastUpdated: number
  /** Client-measured round-trip time, ms; absent/0 = unknown. A try-climb condition. */
  readonly rttMs?: number
  /** The viewer's latest downlink probe, Mbps, whatever it read; absent = unknown (I4). */
  readonly downlinkMbps?: number
  /** Age of that probe when the report was sent, ms. */
  readonly downlinkAgeMs?: number
}

/** A broker of the device, with the tier it is bound to — for rung lookups. */
interface RungCandidate {
  readonly brokerId: string
  readonly tier: CamProfile | null
  readonly broker: IStreamBroker
}

// ---------------------------------------------------------------------------
// Adaptive controller tuning
// ---------------------------------------------------------------------------

// Adaptive tuning (tick, ladder, delivery window) lives in `adaptive-config.ts`.

/**
 * The adaptive controller's desired tier, carried across a close-and-recreate
 * re-offer so the recreated session resolves to the chosen tier AND re-arms
 * its controller. `forceTranscodeDown` additionally pins the recreated
 * session to a reduced transcode profile (the transcode-down rung).
 */
interface AdaptiveIntent {
  readonly prefersTier: Tier
  readonly forceTranscodeDown: boolean
  /**
   * Per-tier count of MEASURED downgrades this viewer session has suffered so
   * far. The switch destroys the session AND its controller, so without
   * carrying this the rebuilt controller had no memory that the rung above
   * had just been proven unusable — it re-attempted it on the plain
   * hysteresis, and a link that cannot carry `high` oscillated
   * climb → stutter → downgrade → climb for the whole session.
   */
  readonly failures: ReadonlyMap<Tier, number>
  /** Successful promotions, used to ramp 4s → 12s → 30s across re-offers. */
  readonly upgradeCount: number
  /** Try-climb memory: is the next rung a trial, and the backoff after a failed try. */
  readonly tryClimb: TryClimbCarry
}

/**
 * A hold code that has been logged stays quiet this long before it may log
 * again (`HoldLogGate`). 60 000 ms: a hovering link changes code every 4–8 s.
 */
const HOLD_LOG_QUIET_MS = 60_000

/** A failing adaptive tick logs at most once per this long, per session. */
const TICK_FAILURE_LOG_QUIET_MS = 60_000

/** What the broker did with one session's downlink probe (D733). */
export interface DownlinkProbeOutcome {
  /** `switching`: the session is moving to `tier` (in place, or by re-offer when it cannot). */
  readonly outcome: 'switching' | 'held'
  /** The rung it is moving to, or the rung it stays on; null = unknown. */
  readonly tier: CamProfile | null
  /** The pick's reason when switching; why it held otherwise. */
  readonly reason: string
}

/** How an in-place tier switch ended (D733). */
type InPlaceOutcome =
  | { readonly kind: 'committed' }
  /** It cannot stay on the session: the caller falls back to the re-offer. */
  | { readonly kind: 'refused'; readonly reason: InPlaceRefusal }
  /** A newer switch or the session's end replaced it — nothing to fall back to. */
  | { readonly kind: 'abandoned' }

/** The commit of one in-place switch. */
interface CommitInPlace {
  readonly sessionId: string
  readonly tier: Tier
  readonly targetId: string
  readonly target: IStreamBroker
  readonly unsubRtp: Unsubscribe
  readonly waitedMs: number
  readonly cause: string
}

/** What one adaptive session's tick needs to feed its controller. */
interface AdaptiveFeed {
  readonly entry: SessionEntry
  readonly deviceId: number
  readonly controller: AdaptiveController
  readonly meter: DeliveryMeter
  readonly client: ClientNetworkSnapshot | null
  readonly serverSending: boolean
  readonly now: number
}

/**
 * The live Opus egress controls an in-process {@link StreamBroker} exposes for
 * per-session demand-gating. Kept OFF the shared `IStreamBroker` cap interface
 * (audio-plumbing internal to this addon) and reached via a structural type
 * guard, so a cross-node broker proxy that lacks them degrades cleanly to PCMU.
 */
interface OpusEgressControls {
  acquireOpusEgress(): void
  releaseOpusEgress(): void
  makeOpusSilenceFrame(channels: number): Promise<Buffer | null>
}

/**
 * True when `broker` is an in-process StreamBroker exposing the Opus egress
 * controls. Uses `in` narrowing + `typeof` checks (no cast) so the returned
 * type predicate is sound.
 */
function supportsOpusEgress(broker: IStreamBroker): broker is IStreamBroker & OpusEgressControls {
  return (
    'acquireOpusEgress' in broker &&
    typeof broker.acquireOpusEgress === 'function' &&
    'releaseOpusEgress' in broker &&
    typeof broker.releaseOpusEgress === 'function' &&
    'makeOpusSilenceFrame' in broker &&
    typeof broker.makeOpusSilenceFrame === 'function'
  )
}

interface SessionEntry {
  readonly session: AdaptiveSession
  /** Who this session is for (`webrtc-browser`, `alexa`, …) — what the
   *  live-viewer count classifies on. Fixed at setup; an in-place tier switch
   *  re-binds the broker, never the consumer. */
  readonly consumerKind: BrokerConsumerKind
  /** Ends this session's camera talk session, when it carries talk-back
   *  (D771). */
  readonly closeTalkback?: () => void
  /**
   * Current broker this session is fed from. An adaptive tier switch that can
   * stay on the session (D733) moves it — together with every subscription
   * below — at the commit of the switch; one that cannot is a
   * close-and-recreate re-offer, a NEW SessionEntry.
   */
  brokerId: string
  /** Unsubscribe from broker's onEncodedData. */
  unsubBroker: Unsubscribe
  /**
   * Unsubscribe from broker's `onVideoRtp` for sessions that forward
   * source RTP through the codec repacketizer (RTP-bearing sources, H.264
   * AND H.265). `null` for AnnexB-only push sessions (which use the
   * AnnexB feed-loop path). Rebound by an in-place tier switch (D733).
   */
  unsubRtp: Unsubscribe | null
  /**
   * Unsubscribe from broker's `onSdpParameterSets` for H.265 sessions
   * that need late delivery of VPS/SPS/PPS. Sessions created during a
   * battery-cam wake-up window register this so the repacketizer is
   * seeded as soon as the broker's first `onVideoTrack` fires —
   * without it the AP codec packet is never emitted and Chrome's HEVC
   * decoder never initialises. `null` for H.264 sessions and for H.265
   * sessions that found the SDP params already populated at create
   * time.
   */
  unsubSdpParams: Unsubscribe | null
  /**
   * Unsubscribe from broker's `onSourceRestart`. Present for EVERY session:
   * the broker keeps the same object across a re-dial, so a session is never
   * torn down by one — it simply starts receiving a stream whose RTP mapping
   * no longer matches the offsets it latched. This is what tells it to
   * re-latch. Without it the client freezes on the last frame and only
   * pause+play recovers (measured on 104, 2026-08-07).
   */
  unsubSourceRestart: Unsubscribe
  /** Close the push source. */
  readonly closeSource: () => void
  /** Visit the frames queued in the push source (probe time only). */
  readonly forEachQueuedFrame: (visit: (frame: MediaFrame) => void) => void
  /** This session's scrub fragment cache, once recorded playback is wired. */
  scrubCache?: ScrubFragmentCache
  /** Adaptive ladder controller — present only for sessions created via
   *  the `/adaptive` alias. Drives tier switches / MTU / transcode-down. */
  adaptiveController?: AdaptiveController
  /** Interval that polls client loss + ticks the adaptive controller.
   *  Cleared in `cleanupSession`. Present only for adaptive sessions. */
  adaptiveTimer?: ReturnType<typeof setInterval>
  /**
   * This session's recorded-playback coordinator (D42: live, recorded and
   * scrub are the same track with a moving source pointer). Present only when
   * the recording-cap accessors are wired. The adaptive ladder reads its mode
   * so it never acts while the track is off live.
   */
  timeline?: TimelineSession
  /**
   * Remote-address tagging is fire-at-most-once per session. The ICE
   * `connected` transition fires on the INITIAL connect AND on every
   * reconnect after a `disconnected`; without this latch each reconnect
   * would re-arm a fresh retry chain, leaving overlapping untracked
   * timers under ICE flap. Set true once the nominated pair is read +
   * tagged OR the retry budget is exhausted; subsequent `connected`
   * transitions are then no-ops.
   */
  attributionTagged?: boolean
  /** Pending retry-timer handle for the remote-address tagging chain.
   *  Cleared in `cleanupSession` so no timer fires after teardown. */
  attributionTimer?: ReturnType<typeof setTimeout>
  /**
   * Release hook for the broker's live Opus egress encoder. Set once when an
   * Opus-negotiated session acquires egress (demand gate); called from
   * `cleanupSession` so the encoder idles when the last Opus viewer leaves.
   * Idempotent-safe: cleared after firing.
   */
  releaseOpusEgress?: () => void
  /**
   * What an in-place tier switch (D733) needs to rebind this session onto
   * another broker — fixed at setup. Absent for a session that can never be
   * switched in place.
   */
  readonly rebind?: SessionRebind
  /** The in-place switch in flight, if any (one at a time; a newer one replaces it). */
  pendingSwitch?: { readonly tier: Tier; readonly cancel: () => void }
}

/** The setup-time facts an in-place tier switch rebinds a session with (D733). */
interface SessionRebind {
  readonly deviceId: number
  readonly sessionCodec: 'H264' | 'H265'
  readonly useRtpRepacketizer: boolean
  /** H.264 profile-level-ids the client OFFERED; undefined for a server offer. */
  readonly offeredProfileLevelIds: string[] | undefined
  /** The offer's hints — the viewport the probe placement respects. */
  readonly hints: ClientHints
  readonly sessionLogger: IScopedLogger
  readonly pushFrame: (mf: MediaFrame) => void
  readonly baseAttribution: BrokerConsumerAttribution
}

/** Where a broker's media is ingested — injected by the manager, which owns
 *  the ownership map. Every field null when unresolved: the local node is
 *  never assumed. */
export interface WebrtcStreamOrigin {
  readonly ingestNodeId: string | null
  readonly ingestIsRemote: boolean | null
}

// ---------------------------------------------------------------------------
// iOS Baseline transcode decision
// ---------------------------------------------------------------------------

/**
 * Whether a WebRTC session for this broker must re-encode the source to
 * Constrained Baseline H.264 so iOS (WebKit) can decode it. True only for
 * an H.264 source whose profile-level-id is known AND non-Baseline
 * (Main/High). Unknown profile (e.g. a battery cam before its first
 * keyframe) ⇒ passthrough — desktop still decodes, and a reconnect once the
 * profile is known gets it right. H.265 sources are driven by codec
 * negotiation (`resolveVideoTranscode`), never this flag.
 */
export function resolveBrokerTranscodeToBaseline(
  sessionCodec: 'H264' | 'H265',
  sourceProfileLevelId: string | undefined,
): boolean {
  if (sessionCodec !== 'H264') return false
  if (!sourceProfileLevelId) return false
  return !isBaselineProfileLevelId(sourceProfileLevelId)
}

/** profile_idc (first byte of a profile-level-id) as a number, e.g.
 *  `640c34` → 0x64 (100, High), `4d0033` → 0x4d (77, Main),
 *  `42e01f` → 0x42 (66, Constrained Baseline). 0 for malformed input. */
function h264ProfileIdc(profileLevelId: string): number {
  if (profileLevelId.length < 2) return 0
  const idc = Number.parseInt(profileLevelId.slice(0, 2), 16)
  return Number.isNaN(idc) ? 0 : idc
}

/** All H.264 `profile-level-id` values advertised in an SDP (offer or
 *  answer), lower-cased. Browsers list one fmtp line per offered H.264
 *  profile (e.g. Constrained Baseline + Main + High), so this is the set
 *  of profiles the client's decoder can handle. Empty when none is given —
 *  per RFC 6184 that implies Constrained Baseline. */
export function extractOfferedH264ProfileLevelIds(sdp: string): string[] {
  const ids: string[] = []
  const re = /profile-level-id=([0-9a-fA-F]{6})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sdp)) !== null) ids.push(m[1]!.toLowerCase())
  return ids
}

/**
 * Capability-driven transcode decision for the CLIENT-offer flow.
 *
 * Unlike the server-offer path — where the server can only assume iOS
 * decodes Constrained Baseline and so transcodes any Main/High source
 * (`resolveBrokerTranscodeToBaseline`) — a client offer carries the
 * browser's real decode capabilities. iOS 18 (WebKit) offers H.264 High,
 * so a 4K Main/High source passes through untouched (werift echoes the
 * client codec; the native decoder handles it). Only fall back to a
 * Baseline re-encode when the source is non-Baseline AND none of the
 * client's offered profiles can decode it (an older Baseline-only client,
 * or an offer that advertised no H.264 profile at all).
 *
 * "Can decode" uses profile_idc ordering: a decoder advertising High
 * (idc 100) decodes Main (77) and Baseline (66); Constrained Baseline
 * (66) decodes only Baseline. So passthrough iff `max(offered idc) >=
 * source idc`. Unknown source profile ⇒ passthrough (desktop still
 * decodes; a reconnect once the profile is known re-decides).
 */
export function resolveClientOfferTranscodeToBaseline(
  sessionCodec: 'H264' | 'H265',
  sourceProfileLevelId: string | undefined,
  offeredProfileLevelIds: readonly string[],
): boolean {
  if (sessionCodec !== 'H264') return false
  if (!sourceProfileLevelId) return false
  if (isBaselineProfileLevelId(sourceProfileLevelId)) return false
  // Capability-driven only: passthrough iff the client offered a
  // profile that decodes the source. Earlier we added a level ≥ 5.0
  // force-transcode (cam 127 main case) on the theory that broadcast
  // Wi-Fi sources lose packets too aggressively for passthrough; but
  // ffmpeg `ultrafast` at the `-maxrate` cap didn't actually shrink
  // the output volumetrically (it just dropped framerate), and the
  // re-encoded keyframes turned out larger and more loss-prone than
  // the source ones. The audio drift that originally appeared to be
  // a passthrough symptom was actually fix #25 (ms → µs broker-side
  // EncodedPacket.pts conversion). Reverted to capability-only.
  const sourceIdc = h264ProfileIdc(sourceProfileLevelId)
  const maxOfferedIdc = offeredProfileLevelIds.reduce(
    (max, plid) => Math.max(max, h264ProfileIdc(plid)),
    0,
  )
  return maxOfferedIdc < sourceIdc
}

/**
 * Best-effort extraction of the source H.264 profile-level-id (e.g.
 * `4d0033` Main 5.1, `42e01f` Constrained Baseline) from the camera's SPS.
 * Checks SDP-published parameter sets first (RTSP cameras publish the SPS
 * as a bare NAL in the SDP), then scans the pre-buffer (push/Baichuan
 * cameras emit the SPS inline in keyframes). Returns undefined when no SPS
 * is available yet (e.g. a battery cam before its first keyframe).
 */
export function deriveH264ProfileLevelId(
  sdpParameterSets: ReadonlyArray<Buffer> | null,
  preBuffer: readonly EncodedPacket[],
): string | undefined {
  if (sdpParameterSets) {
    for (const ps of sdpParameterSets) {
      // Bare NAL (no start code); H.264 SPS = type 7. profile_idc /
      // constraints / level_idc are the 3 bytes after the NAL header.
      if (ps.length >= 4 && (ps[0]! & 0x1f) === 7) {
        return Buffer.from([ps[1]!, ps[2]!, ps[3]!]).toString('hex')
      }
    }
  }
  for (const pkt of preBuffer) {
    if (pkt.type !== 'video') continue
    const { profileLevelId } = extractH264ParamSets(convertH264ToAnnexB(pkt.data))
    if (profileLevelId) return profileLevelId
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Adaptive source selection
// ---------------------------------------------------------------------------

function adaptivePickLogLine(reason: AdaptivePickReason): string {
  if (reason === 'prefers-tier') return 'Adaptive source selected (prefersTier exact)'
  if (reason === 'prefers-tier-fallback') {
    return 'Adaptive source selected (prefersTier fallback → smallest available)'
  }
  if (reason === 'default-low')
    return 'Adaptive source selected (no client hints — smallest available)'
  return 'Adaptive source selected'
}

/**
 * One broker audio packet onto a session's push source — the per-session codec
 * branch (mirrors the live/recorded split). The broker fans out BOTH a
 * PCMU/PCMA stream (always) and, when an Opus session is attached, a parallel
 * `codec:'opus'` stream. Forward only the stream matching THIS session's
 * negotiated codec; drop the other so a PCMU-fallback session never sees Opus
 * and vice-versa. Shared by the session's first broker and by every broker an
 * in-place tier switch moves it to (D733).
 */
function forwardBrokerAudio(
  packet: EncodedPacket,
  session: AdaptiveSession | undefined,
  pushFrame: (mf: MediaFrame) => void,
): void {
  const pktCodec = packet.codec?.toLowerCase()
  // Broker `EncodedPacket.pts` is wall-clock-relative MS; the frame contract is µs.
  if (session?.isOpusAudio === true) {
    if (pktCodec !== 'opus') return
    pushFrame({
      type: 'audio',
      frame: {
        data: packet.data,
        codec: 'Opus',
        sampleRate: 48000,
        channels: 2,
        timestampMicros: packet.pts * 1000,
      },
    })
    return
  }
  if (pktCodec === 'opus') return
  pushFrame({
    type: 'audio',
    frame: {
      data: packet.data,
      codec: pktCodec === 'pcma' ? 'Pcma' : 'Pcmu',
      sampleRate: 8000,
      channels: 1,
      timestampMicros: packet.pts * 1000,
    },
  })
}

/** What one source-RTP forwarder needs to know about its session. */
interface SourceRtpForwarderInput {
  readonly session: AdaptiveSession
  readonly sessionLogger: IScopedLogger
  readonly sessionId: string
  readonly deviceId: number
  readonly brokerId: string
  readonly sessionCodec: 'H264' | 'H265'
}

/**
 * The `onVideoRtp` callback of an RTP-passthrough session: source RTP through
 * the codec repacketizer, unless a transcode owns the wire or recorded playback
 * owns the track. One implementation for the session's first broker and for
 * every broker an in-place tier switch moves it to (D733).
 */
function makeSourceRtpForwarder(input: SourceRtpForwarderInput): (rtpData: Buffer) => void {
  const { session, sessionLogger, sessionId, deviceId, brokerId, sessionCodec } = input
  let firstRtpForwarded = false
  let gateDropLogged = false
  let forwardAfterGateLogged = false
  return (rtpData) => {
    // Transcode path owns the wire via ffmpeg (fed from the AnnexB
    // `FrameSource`). Forwarding the source RTP here would both duplicate the
    // egress AND send H.265 RTP under an H.264 negotiation
    // (`forwardSourceRtpVideo` reads `negotiatedCodec`). Drop it. Read lazily:
    // `needsTranscode` is final by the time RTP forwards (the method itself
    // gates on DTLS-connected, which is post-answer).
    if (session.needsTranscode) return
    if (session.isLiveFeedGated) {
      if (!gateDropLogged) {
        gateDropLogged = true
        forwardAfterGateLogged = false
        sessionLogger.info('recorded: live RTP GATED (dropping live video)', {
          tags: { deviceId },
          meta: { sessionId, deviceId },
        })
      }
      return // recorded playback owns the track
    }
    if (gateDropLogged && !forwardAfterGateLogged) {
      forwardAfterGateLogged = true
      gateDropLogged = false
      sessionLogger.info('recorded: live RTP UNGATED (forwarding live video again)', {
        tags: { deviceId },
        meta: { sessionId, deviceId },
      })
    }
    if (!firstRtpForwarded) {
      firstRtpForwarded = true
      sessionLogger.info('RTP session: first source RTP forwarded to repacketizer', {
        tags: { deviceId },
        meta: { sessionId, brokerId, codec: sessionCodec, bytes: rtpData.length },
      })
    }
    try {
      session.forwardSourceRtpVideo(rtpData)
    } catch (err) {
      sessionLogger.warn('forwardSourceRtpVideo threw', {
        tags: { deviceId },
        meta: { sessionId, codec: sessionCodec, error: errMsg(err) },
      })
    }
  }
}

/** Push-queue overflow purges are aggregated and reported at most this often. */
const FRAME_DROP_LOG_INTERVAL_MS = 30_000

/**
 * Derive a reduced transcode profile for the transcode-down rung. Caps the
 * egress to 360p (preserving aspect ratio when both source dims are known)
 * and the bitrate to the low ceiling, forcing an H.264 re-encode so the
 * reduced shape actually reaches the wire. Pure — returns a new profile,
 * never mutates `base`.
 *
 * The two ceilings come from `@camstack/types` and not from a pair of local
 * constants: D67 collapsed five sets of encode numbers in four packages
 * precisely because nobody could diff them, and this file held one of them.
 *
 * Exported because it is HALF the ladder's swap contract: the reduced profile
 * must hash to a different `egressTranscodeSharingKey` than the rung above it,
 * which is what makes a rung change a NEW handle rather than a mutation of a
 * shared one (D67 — there is no `reconfigure`).
 */
export function reduceProfileForTranscodeDown(base: EncodeProfile): EncodeProfile {
  const srcWidth = base.video.width
  const srcHeight = base.video.height
  let width = srcWidth
  let height = srcHeight
  if (srcWidth !== undefined && srcHeight !== undefined && srcHeight > TRANSCODE_DOWN_MAX_HEIGHT) {
    height = TRANSCODE_DOWN_MAX_HEIGHT
    // Preserve aspect ratio; force an even width for the encoder.
    const scaled = Math.round((srcWidth * TRANSCODE_DOWN_MAX_HEIGHT) / srcHeight)
    width = scaled % 2 === 0 ? scaled : scaled + 1
  } else if (srcHeight === undefined) {
    height = TRANSCODE_DOWN_MAX_HEIGHT
  }
  const bitrateKbps =
    base.video.bitrateKbps !== undefined
      ? Math.min(base.video.bitrateKbps, TRANSCODE_DOWN_MAX_BITRATE_KBPS)
      : TRANSCODE_DOWN_MAX_BITRATE_KBPS
  return {
    ...base,
    video: {
      ...base.video,
      // Force a real re-encode so the reduced shape reaches the wire.
      codec: base.video.codec === 'copy' ? 'h264' : base.video.codec,
      ...(width !== undefined ? { width } : {}),
      height,
      bitrateKbps,
    },
  }
}

interface ClientHints {
  readonly viewportWidth?: number
  readonly viewportHeight?: number
  readonly devicePixelRatio?: number
  readonly downlinkMbps?: number
  readonly prefersTier?: string
}

/**
 * Wall-clock split of `setupSessionForBroker` — the server half of the
 * client's `signalingRttMs`. Every field is 0 when its phase was skipped
 * (e.g. `warmUpMs` on an already-warm broker); wall-clock the named phases
 * do not cover shows up as the gap to `setupTotalMs`.
 */
/**
 * THE ffmpeg primitive, as this server consumes it — `acquire` /
 * `release` and nothing else. Typed structurally rather than against the
 * `StreamBrokerManager` class so the server keeps no reference to its owner,
 * and so a test can supply the pair without a broker.
 */
export interface EgressTranscodeProvider {
  acquire(request: EgressTranscodeRequest): Promise<EgressTranscode>
  release(input: { pipelineKey: string }): Promise<{ released: boolean; refcount: number }>
}

interface SetupPhaseTimings {
  readonly setupTotalMs: number
  readonly ensureTierMs: number
  readonly warmUpMs: number
  readonly iceResolveMs: number
}

// ---------------------------------------------------------------------------
// BrokerWebrtcServer
// ---------------------------------------------------------------------------

/**
 * How long a session setup waits for a broker that is on its way back.
 *
 * An addon respawn rebuilds every broker and re-registers it; the gap measured
 * on this hub is seconds, not tens of seconds. Five is enough to cover it and
 * short enough that a stream which really is gone still fails while the viewer
 * is looking at the player, with a message that says it waited.
 *
 * The alternative shipped for months: fail instantly and let the operator press
 * pause/play, which works only because the second attempt happens later.
 */
const BROKER_REAPPEAR_WAIT_MS = 5_000

export class BrokerWebrtcServer {
  private readonly logger: IScopedLogger
  private readonly getIceServersFn: BrokerWebrtcServerOptions['getIceServers']
  private readonly staticIceServers: readonly IceServerEntry[] | undefined
  private readonly icePortRange: [number, number] | undefined
  private readonly iceAdditionalHostAddresses: readonly string[] | undefined
  private readonly talkbackIntercom: TalkbackIntercomPort | undefined
  private readonly clientNetworkStats: BrokerWebrtcServerOptions['clientNetworkStats']
  private readonly locateRecordedSegment: BrokerWebrtcServerOptions['locateRecordedSegment']
  private readonly readRecordedSegmentBytes: BrokerWebrtcServerOptions['readRecordedSegmentBytes']
  private readonly readRecordedGopBytes: BrokerWebrtcServerOptions['readRecordedGopBytes']
  private readonly readClipBytes: BrokerWebrtcServerOptions['readClipBytes']
  private readonly dialClipStream: BrokerWebrtcServerOptions['dialClipStream']
  private readonly resolveFfmpegPath: BrokerWebrtcServerOptions['resolveFfmpegPath']
  /**
   * THE ffmpeg primitive, for the transcode leg. `null` until the manager wires
   * it — a session that then needs a transcode fails loudly rather than
   * spawning a second kind of ffmpeg.
   */
  private egressTranscodeProvider: EgressTranscodeProvider | null = null

  /** brokerId → IStreamBroker reference. Set by the broker manager on registration. */
  private readonly brokers = new Map<string, IStreamBroker>()

  /**
   * Post-session warmth: when the LAST WebRTC session on a broker closes, a
   * ghost subscription keeps the source dialed and its RTP ring warm for the
   * linger window, so the dominant remote pattern — reopen within minutes —
   * reconnects with an instant-start GOP replay instead of re-paying the
   * cold dial + next-IDR wait. `kind:'warmup'` reuses the existing consumer
   * attribution enum; the label answers "who keeps cam X warm?" in the
   * operator widget.
   */
  private readonly brokerLinger = new BrokerLingerRegistry({
    subscribe: (brokerId) => {
      const broker = this.brokers.get(brokerId)
      if (!broker) return null
      return broker.onEncodedData(
        () => {
          /* linger ghost — demand only */
        },
        { kind: 'warmup', label: 'webrtc-linger', media: 'both' },
      )
    },
  })
  /**
   * Resolves a brokerId to its current profile tier (`CamProfile`)
   * via the manager's `assignments` map, or `null` for brokers that
   * are only kept alive by a manual activation. Injected by the
   * StreamBrokerManager since this server doesn't own the assignment
   * map directly. Defaults to a no-op resolver — adaptive bitrate logic
   * still works (falls back to "mid" defaults) but tier-explicit
   * `prefersTier` requests always pick the first matching candidate.
   */
  private profileTierResolver: ((brokerId: string) => CamProfile | null) | null = null
  /**
   * Hook the manager injects to ensure the wanted tier's ADAPTIVE broker is
   * registered locally before `resolveBrokerId` runs — the manager wires it
   * to `ensureRemoteAdaptiveTierBroker` so a remote node's broker gets a
   * local registration in time for the resolve. No-ops on local-owned
   * devices (the manager's own gate), so an unset hook or a local-owner call
   * leaves adaptive resolution byte-identical to before this hook existed.
   */
  /** Callers parked on a broker that is being rebuilt, keyed by brokerId. */
  private readonly brokerWaiters = new Map<string, Array<() => void>>()
  private ensureAdaptiveTierBroker: ((deviceId: number, tier: CamProfile) => Promise<void>) | null =
    null
  /** sessionId → session entry. */
  private readonly sessions = new Map<string, SessionEntry>()
  /**
   * Carries the adaptive controller's desired tier (+ forced transcode-down)
   * across a close-and-recreate re-offer, so the recreated session resolves
   * to the chosen tier AND re-arms its controller. Written by
   * `switchSessionTier`, consumed once by `setupSessionForBroker`, cleared on
   * close.
   */
  private readonly adaptiveIntent = new Map<string, AdaptiveIntent>()
  /**
   * sessionId → the ladder's LAST move, and the numbers it rested on.
   *
   * Kept on the SERVER and not on the `SessionEntry` for the same reason
   * `adaptiveIntent` is: a tier switch is a close-and-recreate re-offer, so
   * the entry that made the decision is gone by the time anybody asks — which
   * is exactly the moment an operator opens the debug overlay. Cleared on
   * close, in `cleanupSession`.
   *
   * A snapshot, deliberately, not a re-read of the controller: the decision
   * was made on a window that has since moved on, and a recomputed "current"
   * loss ratio answers a different question than "what made it move".
   * Absent until the ladder actually moves — a ladder that has never moved
   * reports `null`, which is NOT the same fact as a `healthy` move with a
   * 0 loss ratio (D393).
   */
  private readonly lastLadderDecision = new Map<string, WebrtcLadderDecision>()
  /**
   * Try-climb memory per DEVICE (review I4): a new viewer session of a camera
   * whose next rung keeps failing inherits the backoff instead of starting at
   * try #1. Forgotten after the backoff cap without a refresh.
   */
  private readonly deviceTryMemory = new DeviceTryMemory(ADAPTIVE_CONFIG.tryBackoffMaxMs)
  /** The newest viewer probe per device, from offers and telemetry (`probe-evidence.ts`). */
  private readonly deviceProbe = new DeviceProbeMemory(PROBE_MEMORY_TTL_MS)
  /**
   * brokerId → where its media is ingested. Injected by the manager, which
   * owns the ownership map; unset (or a null answer) means UNRESOLVED, and
   * the overlay says so rather than naming the local node.
   */
  private streamOriginResolver: ((brokerId: string) => WebrtcStreamOrigin | null) | null = null
  private stopped = false

  constructor(options: BrokerWebrtcServerOptions) {
    this.logger = options.logger
    setDemuxWorkerLogger(options.logger.child('demux-worker'))
    this.getIceServersFn = options.getIceServers
    this.staticIceServers = options.iceServers
    this.icePortRange = options.icePortRange
    this.iceAdditionalHostAddresses = options.iceAdditionalHostAddresses
    this.talkbackIntercom = options.talkbackIntercom
    this.clientNetworkStats = options.clientNetworkStats
    this.locateRecordedSegment = options.locateRecordedSegment
    this.readRecordedSegmentBytes = options.readRecordedSegmentBytes
    this.readRecordedGopBytes = options.readRecordedGopBytes
    this.readClipBytes = options.readClipBytes
    this.dialClipStream = options.dialClipStream
    this.resolveFfmpegPath = options.resolveFfmpegPath
  }

  // ── Broker registration (called by StreamBrokerManager) ─────────────

  registerBroker(brokerId: string, broker: IStreamBroker): void {
    this.brokers.set(brokerId, broker)
    // Wake anything that asked for this broker while it was being rebuilt.
    const waiters = this.brokerWaiters.get(brokerId)
    if (waiters !== undefined) {
      this.brokerWaiters.delete(brokerId)
      for (const wake of waiters) wake()
    }
    const did = deviceIdFromBrokerId(brokerId)
    this.logger.info('WebRTC broker registered', {
      ...(did !== -1 ? { tags: { deviceId: did } } : {}),
      meta: { brokerId },
    })
  }

  /**
   * Wait, briefly, for a broker that is on its way back.
   *
   * An addon respawn — every deploy — tears the brokers down and rebuilds
   * them, re-registering each with {@link registerBroker}. A viewer
   * reconnecting inside that window used to get `No broker for stream`,
   * terminal and immediate, and the only cure was the operator pressing
   * pause/play: the second attempt is the SAME call, later, by which point the
   * broker exists. The difference was never the call, it was the time.
   *
   * Resolves `null` on the deadline rather than throwing, so the caller keeps
   * owning the error message — a stream that really is gone must still fail,
   * and say that it waited.
   */
  waitForBroker(brokerId: string, timeoutMs: number): Promise<IStreamBroker | null> {
    const existing = this.brokers.get(brokerId)
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value: IStreamBroker | null): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const wake = (): void => {
        finish(this.brokers.get(brokerId) ?? null)
      }
      const list = this.brokerWaiters.get(brokerId)
      if (list === undefined) this.brokerWaiters.set(brokerId, [wake])
      else list.push(wake)
      const timer = setTimeout(() => {
        const remaining = (this.brokerWaiters.get(brokerId) ?? []).filter((w) => w !== wake)
        if (remaining.length === 0) this.brokerWaiters.delete(brokerId)
        else this.brokerWaiters.set(brokerId, remaining)
        finish(null)
      }, timeoutMs)
      timer.unref?.()
    })
  }

  /**
   * Provide a resolver that maps brokerId → current profile tier. The
   * manager injects one wired to its `assignments` map. Without it the
   * server still serves brokers but can't honour client `prefersTier`
   * hints precisely (it falls through to the order-based pick).
   */
  setProfileTierResolver(resolver: (brokerId: string) => CamProfile | null): void {
    this.profileTierResolver = resolver
  }

  /**
   * Provide the broker's `acquireEgressTranscode` / `releaseEgressTranscode`
   * pair — THE ffmpeg primitive (D67) — for the transcode leg.
   *
   * The manager injects one calling its own methods directly. The call is
   * IN-PROCESS on purpose: `classifyCapRoute` would serve an unpinned cap call
   * hub-in-process anyway, and going out through tRPC would additionally depend
   * on the installed `@camstack/system` carrying the D67 method. Without this
   * wiring a session that needs a transcode says so and closes — it never falls
   * back to spawning an ffmpeg of its own.
   */
  setEgressTranscodeProvider(provider: EgressTranscodeProvider): void {
    this.egressTranscodeProvider = provider
  }

  /**
   * Acquire one session's transcode leg and hand back something it can ATTACH
   * to.
   *
   * The two properties this function exists to hold:
   *
   * **It attaches, it does not dial.** The primitive returns a url as well, and
   * dialling it republishes the egress as an RTP source — which routes the
   * session down the RTP-passthrough + repacketizer branch and renders black
   * (measured on Alexa, 2026-08-07, with every other link healthy). The push
   * cam stream the broker publishes for `publishLocally` is registered here
   * like any other, so the attach is a plain `onEncodedData` on a local broker.
   *
   * **A handle that cannot be attached to is released, not kept.** A published
   * stream with no broker, or a broker that declined to publish, would leave a
   * refcount held by a session that receives nothing — and there is no lease
   * TTL to reclaim it.
   */
  private async acquireSessionEgress(input: {
    deviceId: number
    camStreamId: string
    profile: EncodeProfile
    sessionId: string
  }): Promise<TranscodeEgressLeg> {
    const provider = this.egressTranscodeProvider
    if (provider === null) {
      throw new Error(
        'egress transcode: no provider wired into BrokerWebrtcServer — the transcode leg cannot start',
      )
    }
    const request = buildTranscodeEgressRequest(input)
    const handle = await provider.acquire(request)
    const release = async (): Promise<void> => {
      await provider.release({ pipelineKey: handle.pipelineKey })
    }

    const camStreamId = handle.camStreamId
    if (camStreamId === null) {
      await release().catch(() => undefined)
      throw new Error(
        'egress transcode: the broker declined to publish locally — a dialled egress renders black here',
      )
    }
    // The same derivation the manager registered it under — a second spelling
    // of a broker id is a lookup that misses for no visible reason.
    const egressBrokerId = makeSourceBrokerId(input.deviceId, camStreamId)
    const broker = this.brokers.get(egressBrokerId)
    if (broker === undefined) {
      await release().catch(() => undefined)
      throw new Error(`egress transcode: no broker registered for "${egressBrokerId}"`)
    }

    return {
      camStreamId,
      pipelineKey: handle.pipelineKey,
      encoder: handle.encoder,
      decodeHwAccel: handle.decodeHwAccel,
      attachVideo: (onPacket) => {
        const unsubscribe = broker.onEncodedData(
          (packet) => {
            if (packet.type === 'video') onPacket(packet)
          },
          {
            kind: 'webrtc-browser',
            label: 'egress-transcode',
            media: 'video',
            targetCodec: handle.videoCodec,
            transport: 'transcode',
            sessionId: input.sessionId,
          },
        )
        // Replayed SYNCHRONOUSLY, after the subscription and before any live
        // packet can interleave: the child's first packets went into the
        // broker's ring while the acquire was still resolving, and one of them
        // is the encoder's first IDR. Without this the viewer waits a whole GOP
        // for the next one.
        for (const packet of broker.getPreBuffer()) {
          if (packet.type === 'video') onPacket(packet)
        }
        return unsubscribe
      },
      release,
    }
  }

  /**
   * Provide a hook that ensures the wanted tier's remote adaptive broker
   * exists BEFORE `resolveBrokerId` runs, for ADAPTIVE streams only. The
   * manager injects one wired to `ensureRemoteAdaptiveTierBroker` (Task 3).
   * Without it (or on a local-owner call, which the hook itself no-ops on)
   * adaptive resolution behaves exactly as before this hook existed.
   */
  setEnsureAdaptiveTierBrokerHook(
    hook: (deviceId: number, tier: CamProfile) => Promise<void>,
  ): void {
    this.ensureAdaptiveTierBroker = hook
  }

  unregisterBroker(brokerId: string): void {
    this.brokers.delete(brokerId)
    // Close all sessions on this broker
    for (const [sid, entry] of this.sessions) {
      if (entry.brokerId === brokerId) {
        this.cleanupSession(sid)
        void entry.session.close().catch(() => {})
      }
    }
    const unregisterDid = deviceIdFromBrokerId(brokerId)
    this.logger.info('WebRTC broker unregistered', {
      ...(unregisterDid !== -1 ? { tags: { deviceId: unregisterDid } } : {}),
      meta: { brokerId },
    })
  }

  supportsStream(streamId: string): boolean {
    // streamId is brokerId (e.g. "6/high") or bare deviceKey
    // Accept if any registered broker matches
    if (this.brokers.has(streamId)) return true
    // Check for adaptive alias: "6/adaptive" → any broker for device "6"
    const slash = streamId.lastIndexOf('/')
    if (slash > 0) {
      const tail = streamId.slice(slash + 1)
      if (tail === 'adaptive') {
        const deviceKey = streamId.slice(0, slash)
        for (const bid of this.brokers.keys()) {
          if (bid.startsWith(`${deviceKey}/`)) return true
        }
      }
    }
    return false
  }

  // ── Session lifecycle ───────────────────────────────────────────────

  async createSession(
    streamId: string,
    hints: ClientHints = {},
    opts: {
      streamingDebug?: boolean
      relayOnly?: boolean
      transcodeProfile?: EncodeProfile
      consumerAttribution?: BrokerConsumerAttribution
    } = {},
  ): Promise<{ sessionId: string; sdpOffer: string }> {
    const setup = await this.setupSessionForBroker(streamId, hints, opts)
    try {
      // Force TURN-relay-only ICE for remote (non-LAN) viewers BEFORE
      // `createOffer()` builds the PeerConnection — the patched werift
      // emits a genuinely relay-only SDP under `iceTransportPolicy:'relay'`,
      // so a CGNAT client gets a clean relay↔relay path instead of
      // werift nominating a dead host/hairpin-srflx pair. LAN viewers
      // (`relayOnly` absent/false) keep the direct host/srflx path.
      if (opts.relayOnly === true) {
        setup.session.setForceRelayOnly(true)
      }
      const offer = await setup.session.createOffer()
      setup.sessionLogger.info('WebRTC session created', {
        meta: {
          sessionId: setup.sessionId,
          deviceId: setup.deviceId,
          brokerId: setup.brokerId,
          iceServers: setup.iceServerCount,
          codec: setup.sessionCodec,
          useRtpRepacketizer: setup.useRtpRepacketizer,
          relayOnly: opts.relayOnly === true,
          ...this.sessionMemMetaFor(setup.sessionId),
        },
      })
      return { sessionId: setup.sessionId, sdpOffer: offer.sdp }
    } catch (err) {
      this.cleanupSession(setup.sessionId)
      await setup.session.close().catch(() => {})
      throw err
    }
  }

  /**
   * WHEP-style client-offer signaling: caller has already constructed
   * an SDP offer (Alexa / WHEP / mobile clients that do
   * `createOffer()` locally) and posts it here. We build the same
   * broker subscription + AdaptiveSession plumbing as `createSession`,
   * then call `session.handleOffer(clientOffer)` to produce the
   * server's SDP answer.
   *
   * The session lifecycle is identical to `createSession` — broker
   * unsubscribe and `closeSession(sessionId)` still apply — so the
   * RTC controller / Alexa handler closes the session the same way.
   */
  async handleOffer(
    streamId: string,
    clientOfferSdp: string,
    hints: ClientHints = {},
    opts: {
      streamingDebug?: boolean
      sessionId?: string
      relayOnly?: boolean
      nonTrickle?: boolean
      disableTurn?: boolean
      disableIpv6?: boolean
      /** Relay the peer's audio to the device's intercom (D771). */
      talkback?: boolean
      transcodeProfile?: EncodeProfile
      consumerAttribution?: BrokerConsumerAttribution
    } = {},
  ): Promise<{ sessionId: string; sdpAnswer: string }> {
    // Pass the client's offer SDP into setup so the transcode decision is
    // capability-driven: the offered H.264 profiles decide passthrough vs
    // Baseline re-encode (iOS 18 offers High → 4K Main/High passes through).
    //
    // Phase brackets: the client-measured `signalingRttMs` (its offer→answer
    // round trip) spiked to 2.3–7.3 s on the first connect after idle with no
    // server-side line attributing the time. `setupMs` and `negotiateMs`
    // split that window server-side (the setup sub-phases are inside
    // `setupTimings`); a large client `signalingRttMs` with a small `totalMs`
    // here means the residue is transport / event-loop scheduling, not this
    // path.
    const offerStart = Date.now()
    const setup = await this.setupSessionForBroker(streamId, hints, { ...opts, clientOfferSdp })
    const setupMs = Date.now() - offerStart
    try {
      // Relay policy must be set BEFORE handleOffer builds the PeerConnection.
      // Cloud peers (Alexa) force TURN-relay-only; LAN/Tailscale browser
      // viewers (relayOnly absent/false) keep the direct host/srflx path.
      if (opts.relayOnly === true) {
        setup.session.setForceRelayOnly(true)
      }
      const negotiateStart = Date.now()
      const answer = await setup.session.handleOffer(
        { sdp: clientOfferSdp, type: 'offer' },
        { nonTrickle: opts.nonTrickle === true },
      )
      const negotiateMs = Date.now() - negotiateStart
      setup.sessionLogger.info('WebRTC session created (client-offer)', {
        meta: {
          sessionId: setup.sessionId,
          deviceId: setup.deviceId,
          brokerId: setup.brokerId,
          iceServers: setup.iceServerCount,
          codec: setup.sessionCodec,
          useRtpRepacketizer: setup.useRtpRepacketizer,
          relayOnly: opts.relayOnly === true,
          setupMs,
          negotiateMs,
          totalMs: Date.now() - offerStart,
          ...setup.setupTimings,
          ...this.sessionMemMetaFor(setup.sessionId),
        },
      })
      return { sessionId: setup.sessionId, sdpAnswer: answer.sdp }
    } catch (err) {
      this.cleanupSession(setup.sessionId)
      await setup.session.close().catch(() => {})
      throw err
    }
  }

  /**
   * Shared session bring-up: resolve broker → subscribe to encoded
   * data + RTP → flush pre-buffer → seed H.265 codec info → register
   * the SessionEntry. Returns the `AdaptiveSession` ready for SDP
   * negotiation (either `createOffer()` for the server-offer flow or
   * `handleOffer(clientOffer)` for the WHEP / Alexa flow).
   *
   * The returned session has its `onClosed` hook already wired to
   * cleanup, and the SessionEntry is already in `this.sessions` keyed
   * by `sessionId` — callers MUST cleanup + close on negotiation
   * failure (both `createSession` and `handleOffer` do this in their
   * catch blocks).
   */
  private async setupSessionForBroker(
    streamId: string,
    hints: ClientHints,
    opts: {
      streamingDebug?: boolean
      sessionId?: string
      relayOnly?: boolean
      disableTurn?: boolean
      disableIpv6?: boolean
      talkback?: boolean
      clientOfferSdp?: string
      transcodeProfile?: EncodeProfile
      consumerAttribution?: BrokerConsumerAttribution
    },
  ): Promise<{
    sessionId: string
    session: AdaptiveSession
    sessionLogger: IScopedLogger
    deviceId: number
    brokerId: string
    sessionCodec: 'H264' | 'H265'
    useRtpRepacketizer: boolean
    iceServerCount: number
    /** Per-phase wall-clock split of this setup — logged by the caller on the
     *  session-created line so a slow offer→answer names its phase. */
    setupTimings: SetupPhaseTimings
  }> {
    if (this.stopped) throw new Error('Server stopped')
    const setupStart = Date.now()
    // Awaited sub-phases of this setup, all 0 when skipped. Any wall-clock
    // spent here that the named phases do NOT cover shows up as the gap
    // between their sum and the caller's `setupMs`.
    let ensureTierMs = 0
    let warmUpMs = 0
    let iceResolveMs = 0

    // Adaptive re-offer: a close-and-recreate re-offer carries the same
    // sessionId, so an `adaptiveIntent` entry keyed by it pins the recreated
    // session to the controller's chosen tier (and applies the reduced
    // transcode profile when transcode-down was requested). Only adaptive
    // streams ever record an intent; non-adaptive (profile / cam-stream)
    // sessions never have one and resolve exactly as before.
    const isAdaptiveStream = streamId.endsWith('/adaptive')
    const intent =
      isAdaptiveStream && opts.sessionId !== undefined
        ? this.adaptiveIntent.get(opts.sessionId)
        : undefined
    // Honour the controller's chosen tier on the recreated broker resolution
    // so `startAdaptive` reads `initialTier` from that broker and resumes at
    // the right rung (BUG #1: upgrade-back was dead because the re-offer
    // landed on a raw cam-stream and never re-armed the controller).
    const resolveHints: ClientHints =
      intent !== undefined ? { ...hints, prefersTier: intent.prefersTier } : hints

    // Remote-adaptive tier ensure (Task 3/4 wiring): for ADAPTIVE streams
    // only, give the manager a chance to register the wanted tier's broker
    // BEFORE resolution looks it up — `resolveHints.prefersTier` already
    // carries the effective precedence (a recreated-session intent wins,
    // otherwise the client hint, defaulting to 'low'), so re-deriving it
    // here would just duplicate that fallback chain. A hook rejection is
    // wrapped so it surfaces as an ordinary setup failure (same as the "No
    // broker for stream" throw two lines down) instead of an unhandled
    // rejection.
    if (isAdaptiveStream) {
      const adaptiveDeviceId = deviceIdFromBrokerId(streamId)
      const desiredTier: CamProfile =
        resolveHints.prefersTier === 'high' ||
        resolveHints.prefersTier === 'mid' ||
        resolveHints.prefersTier === 'low'
          ? resolveHints.prefersTier
          : 'low'
      const ensureTierStart = Date.now()
      try {
        await this.ensureAdaptiveTierBroker?.(adaptiveDeviceId, desiredTier)
      } catch (err) {
        // Name what was attempted, not the tier. The tier is an INPUT to the
        // attempt; reading this message as "that tier is unavailable" sent an
        // investigation after profile slots when the real cause was the owner
        // node still coming back from a respawn (2026-09-18).
        throw new Error(
          `Could not prepare the owner node's broker for stream "${streamId}" ` +
            `(requested tier ${desiredTier}, ${String(Date.now() - ensureTierStart)}ms): ${errMsg(err)}`,
        )
      } finally {
        ensureTierMs = Date.now() - ensureTierStart
      }
    }

    const brokerId = this.resolveBrokerId(streamId, resolveHints)
    // A broker that is being REBUILT is not a stream that is gone. Every addon
    // respawn tears them down and re-registers them a few seconds later; a
    // viewer reconnecting inside that window used to fail terminally, and the
    // operator's only cure was pause/play — the same call, later. Wait for it.
    const broker =
      this.brokers.get(brokerId) ?? (await this.waitForBroker(brokerId, BROKER_REAPPEAR_WAIT_MS))
    if (!broker) {
      throw new Error(
        `No broker for stream "${streamId}" (resolved: "${brokerId}") after waiting ` +
          `${String(BROKER_REAPPEAR_WAIT_MS)}ms for one to register`,
      )
    }

    // Transcode-down rung (BUG #4): when the controller forced a transcode-down,
    // the recreated session re-encodes its egress to a reduced (≤360p, low
    // bitrate) profile derived from whatever transcode profile it would
    // otherwise use. The baked default is used when no profile was supplied.
    const baseTranscodeProfile = opts.transcodeProfile ?? WEBRTC_FALLBACK_PROFILE
    const effectiveTranscodeProfile =
      intent?.forceTranscodeDown === true
        ? reduceProfileForTranscodeDown(baseTranscodeProfile)
        : opts.transcodeProfile
    // Intent is single-use: the recreated session's fresh controller now owns
    // the tier state and writes a new intent on its next switch. Delete to
    // prevent leaks across subsequent re-offers.
    if (intent !== undefined && opts.sessionId !== undefined) {
      this.adaptiveIntent.delete(opts.sessionId)
    }

    // Parse the brokerId so every session log gets `deviceId` /
    // `camStreamId` tags. Without these tags, operator log filters
    // scoped to a single device (the common debugging shape) drop
    // every WebRTC session lifecycle line — and we end up flying
    // blind on whether the session was created, on which codec path,
    // and whether the H.265 SDP seed / first-RTP forward fired.
    const slashIdx = brokerId.indexOf('/')
    const deviceId = deviceIdFromBrokerId(brokerId)
    const deviceTags = {
      deviceId,
      camStreamId: slashIdx > 0 ? brokerId.slice(slashIdx + 1) : brokerId,
    }
    const sessionLogger = this.logger.withTags(deviceTags)

    // Wake the broker if it's still cold (RTSP on-demand pull hasn't dialed
    // the camera yet) and wait briefly for the camera SDP. Without this, an
    // on-demand session created against a cold broker reads
    // `getStats().codec === undefined`, defaults to H.264, and locks every
    // downstream decision (PT, codec offer list, repacketizer choice,
    // SDP-seed dispatch) into the wrong codec — every H.265 source then
    // goes black on the viewer (cam 99 freeze diagnosis 2026-05-28). The
    // warm-up `onEncodedData` subscription triggers `checkDemand`→dial and
    // stays alive until the real session subscribers attach below, so the
    // broker can't see zero consumers and teardown mid-wake. Timeout
    // bounded so we never block forever on an unreachable camera; on
    // timeout we fall back to the prior default-H.264 behaviour rather
    // than failing the session entirely.
    let warmUpUnsubscribe: Unsubscribe | null = null
    if (!broker.getStats().codec) {
      warmUpUnsubscribe = broker.onEncodedData(
        () => {
          /* warm-up no-op */
        },
        {
          kind: 'warmup',
          media: 'both',
        },
      )
      const warmUpStart = Date.now()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          sessionLogger.warn('broker SDP wait timed out — falling back to default codec', {
            meta: { brokerId, currentCodec: broker.getStats().codec ?? null, timeoutMs: 2500 },
          })
          resolve()
        }, 2500)
        const unsubSdp = broker.onSdpParameterSets(() => {
          clearTimeout(timer)
          unsubSdp()
          resolve()
        })
      })
      warmUpMs = Date.now() - warmUpStart
      sessionLogger.info('broker warm-up complete', {
        // `waitedMs` — the success case previously logged no duration, so a
        // 2-second cold-dial wait was indistinguishable from a 5 ms one.
        meta: { brokerId, detectedCodec: broker.getStats().codec ?? null, waitedMs: warmUpMs },
      })
    }

    const brokerCodec = broker.getStats().codec ?? 'h264'
    const isHevc = brokerCodec === 'h265' || brokerCodec === 'hevc'
    const sessionCodec = isHevc ? 'H265' : ('H264' as const)
    // RTP-bearing brokers expose source RTP via `onVideoRtp` — that's
    // RTSP (pull) and `push-rtp` (provider-synthesised RTP). AnnexB-
    // only push brokers (Reolink Baichuan today)
    // and the future RTMP path have no source RTP and fall back to
    // AnnexB → writeVideoNals even on H.265.
    const sourceType = broker.getSourceType()
    const isRtp = broker.isRtpSource()
    // Forward source RTP through the codec's repacketizer for ALL RTP-bearing
    // sources (RTSP), H.264 AND H.265 — instead of the AnnexB→writeVideoNals
    // synthesis path. iOS (WebKit) has a strict H.264 depacketizer (like its
    // HEVC one) that rejects the synthesized shape for Main/High passthrough;
    // the repacketizer preserves the native RTP layout. AnnexB-only push
    // brokers (Reolink Baichuan) stay on writeVideoNals.
    const useRtpRepacketizer = isRtp
    // Surface the codec/path resolution in the message itself so it
    // shows up in operator log filters that strip the structured meta
    // — without this, "WebRTC session created" alone makes it
    // impossible to tell whether a session went down the H.265 RTP
    // repacketizer path (where the late-seed fix matters) or the
    // AnnexB fallback (where it doesn't), which is the first
    // discriminator any wake-up debugging needs.
    sessionLogger.info(
      `WebRTC session: codec=${sessionCodec} brokerCodec=${brokerCodec} sourceType=${sourceType ?? 'null'} isRtp=${isRtp} repacketizer=${useRtpRepacketizer}`,
      { meta: { brokerId, sessionCodec, brokerCodec, sourceType, isRtp, useRtpRepacketizer } },
    )

    // Create push-based FrameSource from broker's encoded data. The overflow
    // purge is reported (throttled) — 61 dropped frames used to be invisible.
    let lastFrameDropLogMs = 0
    let framesDroppedSinceLog = 0
    let purgesSinceLog = 0
    let unalignedPurgesSinceLog = 0
    const {
      source,
      pushFrame,
      close: closeSource,
      forEachQueued: forEachQueuedFrame,
    } = createPushFrameSource((count, keyframeAligned) => {
      framesDroppedSinceLog += count
      purgesSinceLog += 1
      if (!keyframeAligned) unalignedPurgesSinceLog += 1
      const now = Date.now()
      if (now - lastFrameDropLogMs < FRAME_DROP_LOG_INTERVAL_MS) return
      lastFrameDropLogMs = now
      sessionLogger.warn('webrtc push queue overflow — encoded frames dropped', {
        meta: {
          brokerId,
          frames: framesDroppedSinceLog,
          purges: purgesSinceLog,
          // A purge that could not find a keyframe leaves the retained window
          // starting mid-GOP: the viewer sees nothing until the next IDR. That
          // is the one shape worth chasing, so it is counted separately.
          purgesWithoutKeyframe: unalignedPurgesSinceLog,
          windowMs: FRAME_DROP_LOG_INTERVAL_MS,
        },
      })
      framesDroppedSinceLog = 0
      purgesSinceLog = 0
      unalignedPurgesSinceLog = 0
    })

    // Subscribe to broker's encoded packets. Both H.264 and H.265 use
    // the same direct path — the session handles codec-specific RTP
    // packetization (FU-A for H.264, FU for H.265).
    //
    // Parameter-set NALs (SPS/PPS for H.264, VPS/SPS/PPS for H.265)
    // arrive as separate EncodedPackets from the broker. We buffer them
    // and prepend to the next VCL NAL so the decoder gets a complete
    // access unit.
    const pendingParamNals: Buffer[] = []
    /**
     * Sticky SDP-derived VPS/SPS/PPS Annex-B blob. Cameras that publish
     * parameter sets only in SDP (Reolink high-profile streams) emit
     * raw IDR access units on the wire — without this sticky prepend,
     * every keyframe after the first one would arrive at the WebRTC
     * session as a bare IDR and Chrome's HEVC decoder never advances
     * past zero.
     *
     * Captured the first time `pendingParamNals` is populated by a
     * paramSet packet (the synthetic SDP-replay emitted by
     * `StreamBroker.emitSdpParamSetsTo` when this subscriber registered).
     * After that, every keyframe missing inline VPS/SPS/PPS gets the
     * sticky blob prepended.
     */
    let stickyParamSets: Buffer | null = null
    /**
     * Whether we've seen a non-placeholder video packet on this
     * session yet. The placeholder pump emits a 1280×720 SPS/PPS+IDR
     * blob at 1Hz while the broker waits for real RTP. If those
     * param sets land in `stickyParamSets`, the camera's first real
     * keyframe (a different resolution) would get the placeholder
     * SPS prepended and Chrome's decoder would freeze on the last
     * placeholder frame until the session is recreated. Flipping
     * `seenRealPacket` on the first real video packet flushes the
     * placeholder-derived sticky state.
     */
    let seenRealPacket = false
    // The real consumer is now attached — release the warm-up ghost
    // subscription. `checkDemand` runs on add+remove; because we add
    // BEFORE removing, the broker never sees zero consumers and won't
    // teardown the dial mid-startup.
    //
    // Allow callers (WHEP / Alexa) to override the server-generated
    // sessionId so the protocol response can echo the directive's
    // sessionId verbatim. When the same sessionId arrives twice (Alexa
    // retries InitiateSessionWithOffer with the SAME sessionId when the
    // first Lambda relay didn't deliver the answer back to Echo in time),
    // tear down the stale session first so the retry creates a fresh
    // PeerConnection and Echo receives a usable answer instead of an
    // "already in use" error. Resolved BEFORE the subscriptions are
    // created so it can be stamped into the attribution — the
    // `onConnected` hook re-tags subscriptions by this sessionId once ICE
    // discovers the nominated remote address.
    const requestedSessionId = opts.sessionId
    if (requestedSessionId !== undefined && this.sessions.has(requestedSessionId)) {
      const stale = this.sessions.get(requestedSessionId)!
      sessionLogger.warn(
        'Session id reused by client retry — closing stale session before re-creating',
        {
          meta: { sessionId: requestedSessionId, brokerId: stale.brokerId },
        },
      )
      this.cleanupSession(requestedSessionId)
      await stale.session.close().catch(() => {})
    }
    const sessionId = requestedSessionId ?? crypto.randomUUID()
    const baseAttribution: BrokerConsumerAttribution = {
      ...(opts.consumerAttribution ?? { kind: 'webrtc-browser' }),
      sessionId,
    }
    // Audio path always rides AnnexB; downstream codec depends on the
    // source: when the broker codec is one Echo/HomeKit/browsers can
    // copy (PCMU, Opus) we passthrough, otherwise libav transcodes.
    // The session has the truthy view of the negotiated audio codec
    // in the `audio frame in` log line — we mirror it best-effort here
    // for the widget chip. Source audio codec is whatever the broker's
    // `audioTrackInfo` advertised.
    const sourceAudioCodec = broker.getStats().audio?.codec ?? null
    const targetAudioCodec: string =
      sourceAudioCodec === 'PCMU' || sourceAudioCodec === 'PCMA' || sourceAudioCodec === 'OPUS'
        ? sourceAudioCodec
        : 'Pcmu'
    const audioTranscoded =
      sourceAudioCodec !== null && targetAudioCodec.toLowerCase() !== sourceAudioCodec.toLowerCase()
    // The AnnexB subscription serves audio always; for RTP-bearing sources
    // (`useRtpRepacketizer === true`) the video branch early-returns and
    // the actual video runs over the source-RTP fan-out below. Tagging
    // each subscription with its consumed media keeps the widget honest:
    // operators see ONE row per channel ("audio" / "video"), not two
    // rows that look duplicated.
    const annexbAttribution: BrokerConsumerAttribution = {
      ...baseAttribution,
      media: useRtpRepacketizer ? 'audio' : 'both',
      // When media === 'both' (push-AnnexB source) the dominant channel
      // chip is video: report the video codec as targetCodec for the
      // widget. Audio detail is captured by the audio transport.
      targetCodec: useRtpRepacketizer ? targetAudioCodec : sessionCodec,
      transport: audioTranscoded ? 'transcode' : 'passthrough',
    }
    const rtpAttribution: BrokerConsumerAttribution = {
      ...baseAttribution,
      media: 'video',
      targetCodec: sessionCodec,
      // Source-RTP path through repacketizer preserves frames, only
      // rebuilds headers — that's `'repacketize'`. Baseline transcode
      // (set elsewhere when the cam ships Main/High to a Baseline-only
      // viewer) flips this to `'transcode'`.
      transport: effectiveTranscodeProfile !== undefined ? 'transcode' : 'repacketize',
    }
    // Forward-declared so the subscription closures below can read
    // `session.needsTranscode` LAZILY at frame-fire time. The session object
    // is created further down (after ICE/transcode resolution), but real
    // video frames only flow once the broker has dialed and the feed loop has
    // started — by then `session` is assigned and `negotiatedCodec` has
    // settled from the answer, so `needsTranscode` is final. Reading it at
    // subscription-wire time would be premature (negotiation hasn't happened).
    let session: AdaptiveSession | undefined
    const unsubBroker = broker.onEncodedData((packet: EncodedPacket) => {
      if (packet.type === 'video') {
        // Recorded playback owns the track while gated — drop live frames so
        // the feeder's AUs are the only thing on the wire. Audio is not gated
        // (recorded v1 is video-only).
        if (session?.isLiveFeedGated) return
        // RTSP+H.265 sessions forward source RTP directly through the
        // repacketizer — the AnnexB → writeVideoNals path is
        // bypassed entirely. The repacketizer is seeded at
        // session-create time with the camera's VPS/SPS/PPS via
        // `seedH265CodecInfoFromSdp`. Pushing placeholder frames
        // through writeVideoNals here would re-configure Chrome's
        // HEVC decoder with the placeholder's parameter sets
        // (1280×720) and the transition back to the camera's real
        // SPS through the repacketizer's AP codec packet doesn't
        // recover cleanly — the viewer ends up frozen on the
        // placeholder. So H.265 sessions show no labelled
        // placeholder during wake-up; H.264 paths still get them.
        //
        // A transcode session reads its video from the ACQUIRED egress (D67 —
        // `startTranscodeFeed`) and the direct path forwards source RTP through
        // the repacketizer; NEITHER reads video from this push `FrameSource`.
        // So skip the AnnexB video push for ANY RTP source (`useRtpRepacketizer`)
        // or any transcode session — only push-AnnexB DIRECT sources (Reolink
        // Baichuan) still feed `writeVideoNals` below.
        // `session.needsTranscode` is read lazily — final by the time real
        // frames flow.
        if (useRtpRepacketizer || session?.needsTranscode === true) return

        // First real packet after a placeholder window — drop any
        // sticky state captured from placeholder param sets. From
        // this point forward `pendingParamNals` / `stickyParamSets`
        // track the live camera's actual SPS/PPS only.
        if (!packet.isPlaceholder && !seenRealPacket) {
          seenRealPacket = true
          pendingParamNals.length = 0
          stickyParamSets = null
        }

        // Codec-correct AnnexB: an H.265 broker's length-prefixed packets
        // must go through the HEVC converter — feeding H.264-converted bytes
        // from an H.265 source would silently corrupt the transcode input.
        const annexB = isHevc ? convertH265ToAnnexB(packet.data) : convertH264ToAnnexB(packet.data)

        // Detect first NAL type
        const nalTypeInfo = detectFirstNalType(annexB, isHevc)
        if (nalTypeInfo.isParamSet) {
          // Placeholder packets are self-contained access units —
          // VPS+SPS+PPS+IDR concatenated in a single buffer. The
          // first NAL is a parameter set, but the buffer also
          // contains the IDR slice that produces the visible frame.
          // `detectFirstNalType` only inspects the leading NAL, so
          // the live-stream branch (which assumes "param sets arrive
          // separately, then a VCL") would discard the IDR portion
          // and the operator never sees the labelled placeholder.
          // Push the whole bundle as a keyframe and skip the sticky-
          // param caching (corrupts the camera's real keyframe later
          // — different resolution/profile).
          if (packet.isPlaceholder) {
            pushFrame({
              type: 'video',
              frame: {
                data: annexB,
                codec: sessionCodec,
                isKeyframe: true,
                // Broker `EncodedPacket.pts` is wall-clock-relative MS
                // by convention (see stream-broker.ts:2031 et al. and
                // rtsp-restreamer.ts:246 — `pts * 90` to convert to
                // 90kHz). Convert to µs for the frame contract.
                timestampMicros: packet.pts * 1000,
              },
            })
            return
          }
          pendingParamNals.push(Buffer.from(annexB))
          // Keep a sticky copy so future keyframes that ship without
          // inline param sets still get configured decoder.
          stickyParamSets = Buffer.concat(pendingParamNals)
          return
        }

        // VCL NAL — prepend any buffered parameter sets, or the sticky in-band
        // pair when the keyframe lacks them inline.
        let finalAnnexB = annexB
        if (pendingParamNals.length > 0) {
          pendingParamNals.push(annexB)
          finalAnnexB = Buffer.concat(pendingParamNals)
          pendingParamNals.length = 0
        } else if (nalTypeInfo.isKeyframe && stickyParamSets) {
          finalAnnexB = Buffer.concat([stickyParamSets, annexB])
        }

        pushFrame({
          type: 'video',
          frame: {
            data: finalAnnexB,
            codec: sessionCodec,
            isKeyframe: packet.keyframe || nalTypeInfo.isKeyframe,
            // Broker `EncodedPacket.pts` is MS-relative — convert to µs
            // for the frame contract. See the placeholder-branch above.
            timestampMicros: packet.pts * 1000,
          },
        })
      } else if (packet.type === 'audio') {
        forwardBrokerAudio(packet, session, pushFrame)
      }
    }, annexbAttribution)
    // Real consumer attached → release the warm-up ghost. The add-then-
    // remove ordering keeps `checkDemand` from ever seeing zero
    // subscribers, so the dial we just woke stays up.
    warmUpUnsubscribe?.()
    // Same ordering for the post-session linger: the real subscription is
    // attached, so a still-held linger ghost from a previous session on
    // this broker can hand over demand without a gap.
    this.brokerLinger.cancel(brokerId)

    // Flush pre-buffer. Seed `preParamNals` with the SDP-derived
    // VPS/SPS/PPS captured in the live callback's `stickyParamSets`
    // closure variable above. Without this seed, pre-buffer flush
    // starts with empty param sets and the first VCL flushed is a
    // bare IDR — Chrome's HEVC decoder fails on cameras that ship
    // param sets only via SDP (Reolink high-profile streams).
    const preBuffer = broker.getPreBuffer()
    const preParamNals: Buffer[] = stickyParamSets
      ? [Buffer.from(stickyParamSets)]
      : pendingParamNals.length > 0
        ? pendingParamNals.map((b) => Buffer.from(b))
        : []
    for (const pkt of preBuffer) {
      if (pkt.type === 'video') {
        // RTSP+H.265 pre-buffer holds AnnexB packets — feeding them
        // into the writeVideoNals path conflicts with the
        // repacketizer's outbound RTP stream. Skip pre-buffer for
        // video on the repacketizer path and rely on PLI to trigger
        // a fresh keyframe from the camera. Push-mode H.265 keeps
        // pre-buffer flush.
        if (useRtpRepacketizer) continue

        // Codec-correct AnnexB — mirror the live branch above. Reached by
        // push-mode H.265 sources (Reolink Baichuan), whose length-prefixed
        // packets need the HEVC converter, not the H.264 one.
        const annexB = isHevc ? convertH265ToAnnexB(pkt.data) : convertH264ToAnnexB(pkt.data)
        const nalTypeInfo = detectFirstNalType(annexB, isHevc)
        if (nalTypeInfo.isParamSet) {
          preParamNals.push(Buffer.from(annexB))
          continue
        }

        let finalAnnexB = annexB
        if (preParamNals.length > 0) {
          preParamNals.push(annexB)
          finalAnnexB = Buffer.concat(preParamNals)
          preParamNals.length = 0
        } else if (nalTypeInfo.isKeyframe && stickyParamSets) {
          finalAnnexB = Buffer.concat([stickyParamSets, annexB])
        }
        pushFrame({
          type: 'video',
          frame: {
            data: finalAnnexB,
            codec: sessionCodec,
            isKeyframe: pkt.keyframe || nalTypeInfo.isKeyframe,
            // Pre-buffer pkt.pts is the same MS convention as the
            // live `packet.pts` above — see the comment there.
            timestampMicros: pkt.pts * 1000,
          },
        })
      }
    }

    const iceResolveStart = Date.now()
    const allIceServers = await this.resolveIceServers()
    iceResolveMs = Date.now() - iceResolveStart
    // When the caller declares the peer is publicly reachable and TURN is
    // counterproductive (Alexa's cloud media gateway), strip relay entries
    // — keep only STUN. Filter URL-by-URL: a single IceServerEntry may
    // expand into both `stun:` and `turn:` URLs sharing one credential
    // record, and dropping the whole entry would discard the STUN URL too.
    const iceServers: typeof allIceServers =
      opts.disableTurn === true
        ? allIceServers
            .map((entry) => {
              const urls = Array.isArray(entry.urls) ? entry.urls : [entry.urls]
              const stunOnly = urls.filter((u) => !u.startsWith('turn:') && !u.startsWith('turns:'))
              if (stunOnly.length === 0) return null
              return { ...entry, urls: stunOnly.length === 1 ? stunOnly[0]! : stunOnly }
            })
            .filter((e): e is NonNullable<typeof e> => e !== null)
        : allIceServers

    // iOS fix: an H.264 source emitting Main/High can't be decoded by iOS
    // (WebKit) WebRTC, which negotiates Constrained Baseline and decodes
    // ONLY Baseline. Detect the source profile from the camera SPS (SDP
    // params first, then the pre-buffer) and re-encode the egress to
    // Baseline when it isn't already. Baseline H.264 and all H.265 stay
    // passthrough (zero re-encode). See
    // docs/superpowers/specs/2026-05-26-webrtc-ios-baseline-transcode-design.md
    const sourceProfileLevelId =
      sessionCodec === 'H264'
        ? deriveH264ProfileLevelId(broker.getSdpParameterSets(), broker.getPreBuffer())
        : undefined
    // Client-offer flow: decide from the browser's advertised decode caps
    // (iOS 18 offers H.264 High → 4K Main/High passes through). Server-offer
    // flow: no client offer yet, so fall back to the conservative
    // source-profile-only rule (transcode any Main/High to Baseline for iOS).
    const offeredProfileLevelIds = opts.clientOfferSdp
      ? extractOfferedH264ProfileLevelIds(opts.clientOfferSdp)
      : undefined
    const transcodeToBaseline = offeredProfileLevelIds
      ? resolveClientOfferTranscodeToBaseline(
          sessionCodec,
          sourceProfileLevelId,
          offeredProfileLevelIds,
        )
      : resolveBrokerTranscodeToBaseline(sessionCodec, sourceProfileLevelId)
    if (transcodeToBaseline) {
      sessionLogger.info(
        'WebRTC: source H.264 is non-Baseline and the client cannot decode it — re-encoding egress to Constrained Baseline',
        {
          meta: {
            brokerId,
            sessionId,
            sourceProfileLevelId,
            offeredProfileLevelIds,
            clientOffer: opts.clientOfferSdp !== undefined,
          },
        },
      )
    } else if (
      offeredProfileLevelIds &&
      sourceProfileLevelId &&
      !isBaselineProfileLevelId(sourceProfileLevelId)
    ) {
      sessionLogger.info(
        'WebRTC: client offered a profile that decodes the non-Baseline H.264 source — passthrough (no re-encode)',
        { meta: { brokerId, sessionId, sourceProfileLevelId, offeredProfileLevelIds } },
      )
    }

    // Talk-back (D771): a trusted caller asked for the peer's audio to reach
    // this device's speaker. Without an intercom port (no `ctx.api` yet) the
    // session is built exactly as for every other viewer, and says so.
    const talkback =
      opts.talkback === true && this.talkbackIntercom !== undefined
        ? new TalkbackBridge(deviceId, this.talkbackIntercom, sessionLogger)
        : undefined
    if (opts.talkback === true && talkback === undefined) {
      sessionLogger.warn(
        'talk-back requested but no intercom port is wired — audio stays one-way',
        {
          meta: { sessionId },
        },
      )
    }

    session = new AdaptiveSession({
      sessionId,
      source,
      ...(talkback !== undefined
        ? { intercom: { onAudioReceived: (data, format) => talkback.onAudio(data, format) } }
        : {}),
      sourceCodec: sessionCodec,
      transcodeToBaseline,
      transcodeProfile: effectiveTranscodeProfile,
      // THE ffmpeg primitive, bound to THIS session's source stream. Resolved
      // lazily at feed start — the acquire needs the source dialed, and it also
      // needs the negotiated codec, which is only known after the answer.
      acquireTranscodeEgress: (input) =>
        this.acquireSessionEgress({
          deviceId,
          camStreamId: deviceTags.camStreamId,
          profile: input.profile,
          sessionId: input.sessionId,
        }),
      iceConfig: {
        iceServers,
        portRange: this.icePortRange,
        additionalHostAddresses: this.iceAdditionalHostAddresses,
        disableIpv6: opts.disableIpv6 === true,
      },
      // Device-tagged logger so every WebRTC session lifecycle line
      // (ICE state, candidate pairs, nominated pair, feed progress)
      // carries `deviceId` — operator log filters scoped to one device
      // no longer drop session logs as `dev=?`.
      logger: sessionLogger,
      deviceId,
      // Source-RTP pre-buffer accessor for instant start on the repacketizer
      // path — the session replays the current GOP on its first forwarded
      // packet. Only meaningful for RTP sources (returns [] otherwise).
      rtpBootstrap: useRtpRepacketizer ? () => broker.getRtpPreBuffer() : undefined,
      debug: opts.streamingDebug === true,
      // Named on every loss line. "Which consumer is losing packets" is the
      // first question asked of it, and a sessionId does not answer it.
      consumerKind: baseAttribution.kind,
    })

    // For RTSP (RTP-bearing) sessions, H.264 AND H.265: subscribe to
    // source-RTP and forward through the codec's repacketizer in the
    // session. Also seed the repacketizer codec info from the SDP-derived
    // param sets (H.264 SPS/PPS, H.265 VPS/SPS/PPS) so the STAP-A/AP codec
    // packet can precede the first IDR even when the camera doesn't emit
    // param sets in-band. Push-mode brokers (Reolink Baichuan, etc.) skip
    // this and use the AnnexB feed path.
    const seedFromSdp = (ps: ReadonlyArray<Buffer>): void => {
      if (sessionCodec === 'H265') session.seedH265CodecInfoFromSdp(ps)
      else session.seedH264CodecInfoFromSdp(ps)
    }
    let unsubRtp: Unsubscribe | null = null
    let unsubSdpParams: Unsubscribe | null = null
    if (useRtpRepacketizer) {
      const sdpPs = broker.getSdpParameterSets()
      if (sdpPs && sdpPs.length > 0) {
        seedFromSdp(sdpPs)
        sessionLogger.info('RTP session seeded from SDP at create-time', {
          meta: { sessionId, brokerId, codec: sessionCodec, psCount: sdpPs.length },
        })
      } else {
        // Battery-cam wake-up: broker is still dialing rfc4571, so
        // `getSdpParameterSets()` is null at this point. Subscribe so
        // the seed lands the moment `onVideoTrack` fires — before
        // that, the repacketizer can't emit its codec packet, so the
        // browser receives RTP it can't initialise a decoder against.
        // `onSdpParameterSets` delivers synchronously when params are
        // already known (no-op for the wake-up case), and on every
        // future reader rebuild.
        sessionLogger.info(
          'RTP session deferred: SDP params not ready, subscribing for late delivery',
          {
            meta: { sessionId, brokerId, codec: sessionCodec },
          },
        )
        unsubSdpParams = broker.onSdpParameterSets((ps) => {
          try {
            seedFromSdp(ps)
            sessionLogger.info('RTP session seeded from SDP late delivery', {
              meta: { sessionId, brokerId, codec: sessionCodec, psCount: ps.length },
            })
          } catch (err) {
            sessionLogger.warn('seedCodecInfoFromSdp threw', {
              meta: { sessionId, codec: sessionCodec, error: errMsg(err) },
            })
          }
        })
      }
      unsubRtp = broker.onVideoRtp(
        makeSourceRtpForwarder({
          session,
          sessionLogger,
          sessionId,
          deviceId,
          brokerId,
          sessionCodec,
        }),
        rtpAttribution,
      )
    }

    // Recover in place when the broker re-dials this source. Subscribed for
    // every session shape, not just the RTP-passthrough one: the AnnexB and
    // transcode legs also hold parameter sets and a bootstrap latch belonging
    // to the connection that ended.
    const unsubSourceRestart = broker.onSourceRestart((reason: string) => {
      sessionLogger.info('broker re-dialed the source — re-syncing session', {
        meta: { sessionId, brokerId, deviceId, reason },
      })
      try {
        session.onSourceRestarted(reason)
      } catch (err) {
        sessionLogger.warn('onSourceRestarted threw', {
          meta: { sessionId, brokerId, error: errMsg(err) },
        })
      }
    })

    const entry: SessionEntry = {
      session,
      consumerKind: baseAttribution.kind,
      brokerId,
      unsubBroker,
      unsubRtp,
      unsubSdpParams,
      unsubSourceRestart,
      closeSource,
      forEachQueuedFrame,
      ...(talkback !== undefined ? { closeTalkback: () => void talkback.close() } : {}),
      rebind: {
        deviceId,
        sessionCodec,
        useRtpRepacketizer,
        offeredProfileLevelIds,
        hints,
        sessionLogger,
        pushFrame,
        baseAttribution,
      },
    }
    this.sessions.set(sessionId, entry)
    reportConsumerEvent(
      this.logger,
      'attach',
      `webrtc:${entry.consumerKind}`,
      entry.rebind?.deviceId,
      this.sessions.size,
    )

    session.onClosed = () => this.cleanupSession(sessionId)

    // Recorded playback over WebRTC: when the recording-cap accessors are wired,
    // give this session a TimelineSession + on-demand RecordedFeeder. The feeder
    // pulls segments via the cap, demuxes to Annex-B, and pushes to this session's
    // track while the live feed is gated. `timeline` is referenced by the feeder's
    // onState/onPosition callbacks, which only run after a control message arrives
    // (i.e. after assignment), so the forward reference is safe.
    const locateRecorded = this.locateRecordedSegment
    const readRecorded = this.readRecordedSegmentBytes
    // Resolve the ffmpeg binary lazily at each demux so a config reload lands.
    // No binary ⇒ the ffmpeg fallbacks REFUSE — never a PATH `ffmpeg` (D540) —
    // and the session says so ONCE, per camera, the first time one is needed.
    const resolveFfmpegPath = this.resolveFfmpegPath
    const resolveFfmpeg = (): string | null => resolveFfmpegPath?.() ?? null
    let noPinnedFfmpegLogged = false
    const reportNoPinnedFfmpeg = (what: 'video' | 'audio'): void => {
      if (noPinnedFfmpegLogged) return
      noPinnedFfmpegLogged = true
      sessionLogger.error(
        'recorded playback: ffmpeg fallback refused — no pinned ffmpeg on this node (D540)',
        { tags: { deviceId }, meta: { sessionId, what } },
      )
    }
    // WHICH video demux served each fragment, for this whole session: the
    // off-thread mp4box parse (worker_threads inside this runner) or the
    // ffmpeg subprocess. Counting BOTH is the point — the previous
    // once-per-session warn said a fallback happened and never how often, so
    // "is the ffmpeg fallback the real cost of a scrub?" could not be
    // answered. The feeder diffs this per drag; the throttled line below
    // carries the reason.
    const demuxTally = new DemuxPathTally()
    // Recorded-audio Opus JS→ffmpeg fallback (legacy pre-A1 AAC fragments only).
    let audioOpusFallbackLogged = false
    if (locateRecorded && readRecorded) {
      // Video demux, hoisted to SESSION scope: the warm-up path and every
      // feeder this session builds share one implementation, so a fragment
      // demuxed before the first drag is byte-identical to one demuxed during
      // it (the cache would otherwise be a second demux path in disguise).
      const demuxVideo = (b: Uint8Array): Promise<AccessUnit[]> =>
        demuxSegmentPreferJsOffThread(b, {
          ffmpegPath: resolveFfmpeg(),
          deviceId,
          onDemuxPath: (outcome) => {
            const report = demuxTally.record(outcome, Date.now())
            if (!report) return
            // Throttled, not once-per-session: a fallback RATE that changes
            // mid-session is exactly what a once/session line hides, and
            // `suppressed` says how many this line stands for.
            sessionLogger.warn(
              'recorded playback: JS full demux failed — ffmpeg subprocess fallback',
              {
                tags: { deviceId },
                meta: {
                  sessionId,
                  deviceId,
                  reason: report.reason,
                  ffmpegTotal: report.ffmpegTotal,
                  suppressed: report.suppressed,
                },
              },
            )
          },
        }).catch((err: unknown) => {
          if (err instanceof FfmpegFallbackRefusedError) reportNoPinnedFfmpeg('video')
          throw err
        })
      // ONE fragment cache per WebRTC session: the timeline warm-up fills it
      // before any feeder exists, and it survives the feeder rebuilds that
      // enterRecorded performs — which is the whole point of hoisting it.
      const scrubCache = new ScrubFragmentCache()
      const initialLiveProfile = this.profileTierResolver?.(brokerId) ?? null
      const readGopAccessor = this.readRecordedGopBytes
      const readGop: ReadGopFn | undefined = readGopAccessor
        ? async (args) => {
            const res = await readGopAccessor({
              deviceId: args.deviceId,
              profile: args.profile,
              startMs: args.segmentStartMs,
              segmentDurMs: args.segmentDurMs,
              epochMs: args.epochMs,
            })
            return { gopStartMs: res.gopStartMs, gopDurMs: res.gopDurMs, bytes: res.data }
          }
        : undefined
      const readClip = this.readClipBytes
      const dialClip = this.dialClipStream
      const openClipStream = createHttpClipStreamOpener()
      let timeline: TimelineSession
      /**
       * ONE feeder builder for BOTH sources (D575). `clip === null` is the
       * recorder's own footage; a clip swaps only the two byte closures —
       * everything else (demux, sink, audio codec branch, state/position/log
       * seams) is identical, which is the whole claim the clip path makes.
       *
       * Since D597 a clip has TWO paths, and which one it gets is decided
       * ONCE, here, by `chooseClipPath`, and logged with its reason: the
       * STREAM for the sub twin (forward-only, first frame at the first
       * fragment) whenever this broker can dial one, the FILE for `high` and
       * for a broker with no dial. Never an implicit fallthrough.
       */
      const buildFeeder = (
        profile: string,
        clip: ClipPlaybackHandle | null,
      ): TimelineSessionClipFeeder => {
        if (clip) {
          const choice = chooseClipPath({
            profile: clip.profile,
            streamDialWired: dialClip !== undefined,
            fileReadWired: readClip !== undefined,
          })
          sessionLogger.info('clip playback: path chosen', {
            tags: { deviceId: clip.deviceId },
            meta: {
              sessionId,
              clipId: clip.clipId,
              provider: clip.provider,
              profile: clip.profile,
              path: choice.path,
              reason: choice.reason,
            },
          })
          const clipLog = (msg: string, data: Record<string, unknown>): void =>
            sessionLogger.info(msg, {
              tags: { deviceId: clip.deviceId },
              meta: { sessionId, clipId: clip.clipId, ...data },
            })
          const onClipState = (t: FeederStateTransition): void => {
            sessionLogger.info('recorded: feeder state', {
              tags: { deviceId: clip.deviceId },
              meta: {
                sessionId,
                deviceId,
                profile,
                clipId: clip.clipId,
                path: choice.path,
                from: t.from,
                to: t.to,
                reason: t.reason,
                seekToken: t.seekToken,
              },
            })
            timeline._emitState(t.to)
          }
          if (choice.path === 'none') {
            return createRefusedClipFeeder({
              handle: clip,
              reason: choice.reason,
              onState: onClipState,
              onLog: clipLog,
            })
          }
          if (choice.path === 'stream' && dialClip !== undefined) {
            // Sound follows the session's negotiated codec, exactly as the
            // file path's does — the difference is WHERE the transcode runs.
            // The stored path transcodes here, per fragment; the stream is
            // transcoded by the provider before it muxes, because that is the
            // process holding the camera's AAC and it already runs an ffmpeg.
            // So the sink is the same pair of push functions and this feeder
            // only frames and paces (D600).
            const streamAudio: Fmp4AudioCodec = session.isOpusAudio ? 'opus' : 'pcmu'
            return createClipStreamFeeder({
              handle: clip,
              dial: (handle, audio) =>
                dialClip({
                  deviceId: handle.deviceId,
                  clipId: handle.clipId,
                  provider: handle.provider,
                  profile: handle.profile,
                  audio,
                }),
              open: openClipStream,
              audio: streamAudio,
              sink: session.isOpusAudio
                ? {
                    pushAccessUnit: (data, ts, codec) =>
                      session.pushRecordedAccessUnit(data, ts, codec),
                    pushAudioOpus: (opus, ts) =>
                      session.writeRecordedAudioOpus(Buffer.from(opus), ts),
                  }
                : {
                    pushAccessUnit: (data, ts, codec) =>
                      session.pushRecordedAccessUnit(data, ts, codec),
                    pushAudioPcmu: (pcmu, ts) => session.writeRecordedAudio(Buffer.from(pcmu), ts),
                  },
              onState: onClipState,
              onPosition: (epochMs) => timeline._emitPosition(epochMs),
              onLog: clipLog,
            })
          }
        }
        // Recorded audio follows the session's negotiated codec — the SAME
        // per-session branch as the live path. Opus session: in-process Opus
        // extraction (ffmpeg only for legacy AAC fragments) + 48 kHz clock +
        // `writeRecordedAudioOpus`. PCMU session (fallback / older clients):
        // the existing ffmpeg AAC/Opus→µ-law path + 8 kHz clock, untouched.
        const opusSession = session.isOpusAudio
        const audioSink: FeederSink = opusSession
          ? {
              pushAccessUnit: (data, ts, codec) => session.pushRecordedAccessUnit(data, ts, codec),
              pushAudioOpus: (opus, ts) => session.writeRecordedAudioOpus(Buffer.from(opus), ts),
            }
          : {
              pushAccessUnit: (data, ts, codec) => session.pushRecordedAccessUnit(data, ts, codec),
              pushAudioPcmu: (pcmu, ts) => session.writeRecordedAudio(Buffer.from(pcmu), ts),
            }
        const demuxAudio = opusSession
          ? async (b: Uint8Array) => {
              const ffmpegPath = resolveFfmpeg()
              const aus = await demuxSegmentAudioOpusPreferJs(b, {
                ffmpegPath,
                onFfmpegFallback: (reason) => {
                  if (ffmpegPath === null) reportNoPinnedFfmpeg('audio')
                  if (audioOpusFallbackLogged) return
                  audioOpusFallbackLogged = true
                  sessionLogger.warn(
                    'recorded audio: JS Opus demux missed — ffmpeg AAC→Opus fallback (once/session)',
                    { meta: { sessionId, deviceId, profile, reason } },
                  )
                },
              })
              return aus.map((au) => ({ data: au.data, ptsMs: au.ptsMs }))
            }
          : async (b: Uint8Array) => {
              // PCMU has no in-process path: every fragment needs ffmpeg.
              const ffmpegPath = resolveFfmpeg()
              if (ffmpegPath === null) {
                reportNoPinnedFfmpeg('audio')
                return []
              }
              return await demuxSegmentToPcmu(b, ffmpegPath)
            }
        // The ONE difference between a clip and recorded footage: where the
        // bytes come from. A clip source is built per feeder and fetches its
        // file ONCE, by handle, whole and compressed (D9/D18) — and it
        // offers no `readGop`, because a GOP-ranged slice of a progressive
        // MP4 is not standalone-demuxable without a remux and the resident
        // file already IS its byte range. It also gets its OWN fragment
        // cache (the session cache is keyed on the recorded axis, and a
        // file-relative epoch would collide with it).
        const clipSource =
          clip && readClip
            ? createClipFileSource({
                handle: clip,
                read: readClip,
                onLog: (msg, data) =>
                  sessionLogger.warn(msg, {
                    tags: { deviceId: clip.deviceId },
                    meta: { sessionId, ...data },
                  }),
              })
            : null
        const feeder = new RecordedFeeder({
          deviceId: clip ? clip.deviceId : deviceId,
          profile,
          locate: clipSource ? clipSource.locate : locateRecorded,
          readBytes: clipSource ? clipSource.readBytes : readRecorded,
          ...(clipSource ? {} : { readGop, fragmentCache: scrubCache }),
          demux: demuxVideo,
          demuxTally,
          demuxAudio,
          audioClockRateHz: opusSession ? 48000 : 8000,
          sink: audioSink,
          onState: (t) => {
            // `t` is the full transition — from/to/reason/seekToken/dragId —
            // not a naked string. Logging every field is the whole point of
            // C2: a state that gets stuck has to be explained from THIS line
            // alone, without ordering it against the app's own clock. The
            // wire protocol is unchanged: only `t.to` goes out to the viewer.
            sessionLogger.info('recorded: feeder state', {
              tags: { deviceId: clip ? clip.deviceId : deviceId },
              meta: {
                sessionId,
                deviceId,
                profile,
                clipId: clip?.clipId,
                from: t.from,
                to: t.to,
                reason: t.reason,
                seekToken: t.seekToken,
                dragId: t.dragId,
              },
            })
            timeline._emitState(t.to)
          },
          onPosition: (epochMs, pushSeq) => timeline._emitPosition(epochMs, pushSeq),
          // The scrub sub-mode used to be dark server-side — an incident was
          // reconstructed from an RTP-rebase side effect. The per-drag
          // aggregate, the sampled push and the pathological cases all come
          // out here. `tags.deviceId` is not optional: every tuning question
          // arrives as "why is 102 different from 101", and a line that
          // carries the id only inside `meta` cannot be grouped by camera.
          onLog: (msg, data) =>
            sessionLogger.info(msg, {
              tags: { deviceId: clip ? clip.deviceId : deviceId },
              meta: { sessionId, deviceId, profile, clipId: clip?.clipId, ...data },
            }),
        })
        // A clip feeder answers one more question than the recorder's: how
        // long the file is. The source has measured it from the MP4 index
        // since D575; the session asks after the first seek and tells the
        // viewer, so progress inside a clip is drawn against the file's own
        // length and not the catalog row's (frozen while a file grows).
        return clipSource
          ? Object.assign(feeder, { durationMs: () => clipSource.durationMs() })
          : feeder
      }
      timeline = new TimelineSession({
        session,
        deviceId,
        locate: locateRecorded,
        ...(initialLiveProfile !== null ? { initialLiveProfile } : {}),
        warm: readGop
          ? (profile, epochMs) => {
              void warmFragment(
                {
                  deviceId,
                  locate: locateRecorded,
                  readGop,
                  demux: demuxVideo,
                  cache: scrubCache,
                  onLog: (msg, data) =>
                    sessionLogger.info(msg, {
                      tags: { deviceId },
                      meta: { sessionId, deviceId, ...data },
                    }),
                },
                profile,
                epochMs,
              ).catch((err) => {
                // A failed warm costs nothing but the head start — but it LOGS:
                // a silent warm failure reads exactly like a warm that worked.
                sessionLogger.warn('recorded: warm failed', {
                  meta: { sessionId, deviceId, profile, epochMs, error: errMsg(err) },
                })
              })
            }
          : undefined,
        makeFeeder: (profile) => buildFeeder(profile, null),
        // A clip source is wired only when this broker can actually reach a
        // clip — by file or by stream. Absent ⇒ `playClip` is refused by name
        // in the session, never silently dropped and never a second player.
        ...(readClip || dialClip
          ? {
              makeClipFeeder: ({ handle }: MakeClipFeederArgs) =>
                buildFeeder(handle.profile ?? 'clip', handle),
            }
          : {}),
        onLog: (msg, data) =>
          sessionLogger.warn(msg, { tags: { deviceId }, meta: { sessionId, ...data } }),
      })
      // Expose the coordinator to the adaptive ladder so it can suspend itself
      // while the pointer is off live (see `startAdaptive`).
      entry.timeline = timeline
      entry.scrubCache = scrubCache
      sessionLogger.info('recorded: TimelineSession wired (control accessors present)', {
        meta: { sessionId, deviceId },
      })
      session.onControlMessage((raw) => {
        const msg = parseControlMessage(raw)
        if (msg) {
          void timeline.handleControl(msg).catch((err) => {
            sessionLogger.warn('timeline.handleControl threw', {
              meta: { sessionId, deviceId, t: msg.t, error: errMsg(err) },
            })
          })
        }
      })
      // Chain disposal onto the existing onClosed (cleanupSession), don't clobber it.
      const prevOnClosed = session.onClosed
      session.onClosed = () => {
        timeline.dispose()
        prevOnClosed?.()
      }
    }

    // Once ICE connects, read the nominated pair and tag this session's broker
    // subscriptions (audio + video) with the remote peer address so operators
    // can identify the viewer. Best-effort: werift may populate `nominated` up
    // to ~1s after the "connected" event, so retry briefly; any failure is
    // swallowed — this never affects the live session/ICE path. When the
    // selected pair is a relay/srflx candidate the displayed `@addr` is the
    // TURN/reflexive address (the relay's or the NAT-reflexive one), NOT the
    // viewer's real LAN IP — appending the type disambiguates for the operator.
    //
    // Fire-at-most-once: the ICE `connected` transition also fires on every
    // reconnect after a `disconnected`. The `attributionTagged` latch on the
    // session entry ensures a reconnect does NOT re-arm a new retry chain; the
    // pending `attributionTimer` is cleared on teardown (`cleanupSession`) so
    // no timer fires after the session is gone.
    session.onConnected = () => {
      // Live Opus egress (demand gate): once negotiation has settled (ICE
      // connected ⇒ the answer is applied and the audio sender's codec is
      // bound), spin up the broker's PCM→Opus encoder for Opus-negotiated
      // sessions and prime the sentry silence frame. Additive — PCMU
      // fallback sessions never touch the encoder. Idempotent across ICE
      // reconnects via the `releaseOpusEgress` latch; released in
      // `cleanupSession`. The controls exist only on in-process StreamBroker
      // instances (structural guard) — a proxy broker degrades to PCMU.
      if (!entry.releaseOpusEgress && session.isOpusAudio && supportsOpusEgress(broker)) {
        broker.acquireOpusEgress()
        entry.releaseOpusEgress = () => broker.releaseOpusEgress()
        void broker
          .makeOpusSilenceFrame(2)
          .then((frame) => {
            if (frame) session.setOpusSilenceFrame(frame)
          })
          .catch(() => {})
      }
      if (entry.attributionTagged) return
      let attempt = 0
      const tag = (): void => {
        // Bail if the session was torn down while a retry was pending — the
        // entry is removed from `this.sessions` in `cleanupSession`. Belt-and-
        // suspenders alongside the timer-clear there.
        if (this.sessions.get(sessionId) !== entry) return
        try {
          const pair = session.readNominatedPair()
          if (!pair) {
            if (attempt++ < 5) {
              entry.attributionTimer = setTimeout(tag, 200)
            } else {
              // Retry budget exhausted — latch so a later reconnect does not
              // re-arm a fresh chain for the same (likely unreadable) pair.
              entry.attributionTagged = true
            }
            return
          }
          const remoteAddr =
            pair.remoteType === 'host' ? pair.remoteAddr : `${pair.remoteAddr} (${pair.remoteType})`
          broker.updateConsumerAttributionBySession(sessionId, { remoteAddr })
          entry.attributionTagged = true
        } catch {
          /* best-effort — never break the session path */
        }
      }
      tag()
    }

    // Adaptive sessions (created via the `${deviceId}/adaptive` alias) get a
    // ladder controller that can switch the session to a different-tier broker
    // mid-stream. Non-adaptive sessions (pinned profile / cam-stream targets)
    // are left UNCHANGED — they keep the single broker they were created on.
    if (streamId.endsWith('/adaptive')) {
      const initialTier: Tier = this.profileTierResolver?.(brokerId) ?? 'high'
      // `intent` was consumed at the top of this setup; its failure memory is
      // the only record that survives the close-and-recreate re-offer.
      // The offer's probe (if any) joins the device's probe memory; newest wins.
      this.recordDeviceProbe(deviceId, probeFromHints(hints.downlinkMbps, Date.now()))
      this.startAdaptive(entry, deviceId, initialTier, sessionId, intent)
    }

    return {
      sessionId,
      session,
      sessionLogger,
      deviceId,
      brokerId,
      sessionCodec,
      useRtpRepacketizer,
      iceServerCount: iceServers.length,
      setupTimings: {
        setupTotalMs: Date.now() - setupStart,
        ensureTierMs,
        warmUpMs,
        iceResolveMs,
      },
    }
  }

  async handleAnswer(sessionId: string, sdpAnswer: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) throw new Error(`Session not found: ${sessionId}`)
    await entry.session.handleAnswer({ sdp: sdpAnswer, type: 'answer' })
  }

  /** Trickle ICE — add a remote (client) candidate to a live session. */
  async addIceCandidate(sessionId: string, candidate: IceCandidatePayload): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    await entry.session.addIceCandidate(candidate).catch((err) => {
      this.logger.warn('addIceCandidate threw', {
        tags: { deviceId: deviceIdFromBrokerId(entry.brokerId) },
        meta: { sessionId, error: errMsg(err) },
      })
    })
  }

  /** Trickle ICE — the server's gathered candidates for a session (poll). */
  getIceCandidates(sessionId: string): { candidates: IceCandidatePayload[]; done: boolean } {
    const entry = this.sessions.get(sessionId)
    if (!entry) return { candidates: [], done: true }
    return entry.session.getIceCandidatesSnapshot()
  }

  async closeSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.cleanupSession(sessionId)
    await entry.session.close().catch(() => {})
    this.logger.info('WebRTC session closed', {
      tags: { deviceId: deviceIdFromBrokerId(entry.brokerId) },
      meta: { sessionId, deviceId: deviceIdFromBrokerId(entry.brokerId) },
    })
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Release linger ghosts FIRST so shutdown never holds a broker's demand.
    this.brokerLinger.stop()
    const closes: Promise<void>[] = []
    for (const [sid, entry] of this.sessions) {
      this.cleanupSession(sid)
      closes.push(entry.session.close().catch(() => {}))
    }
    await Promise.all(closes)
    this.lastLadderDecision.clear()
    this.brokers.clear()
    this.logger.info('WebRTC server stopped')
  }

  getSessionCount(): number {
    return this.sessions.size
  }

  /**
   * One session's pinned-memory reading, by backing store (`session-mem.ts`).
   * Walks the session's NACK history, push queue, replay tail and scrub cache:
   * call at probe / lifecycle-line time only.
   */
  private readSessionMem(sessionId: string, entry: SessionEntry): SessionMemReading {
    const own = entry.session.readMemTotals()
    const push = new BackingTally()
    entry.forEachQueuedFrame((mf) => push.add(mf.frame.data))
    const scrub = new BackingTally()
    entry.scrubCache?.tallyBacking(scrub)
    return {
      sessionId,
      deviceId: deviceIdFromBrokerId(entry.brokerId),
      rtpCache: own.rtpCache,
      rtpReplay: own.rtpReplay,
      pushQueue: push.totals(),
      scrub: scrub.totals(),
    }
  }

  /** Every live session's reading, for the `[broker-mem]` line. */
  getSessionMemReadings(): SessionMemReading[] {
    const readings: SessionMemReading[] = []
    for (const [sessionId, entry] of this.sessions) {
      try {
        readings.push(this.readSessionMem(sessionId, entry))
      } catch (err) {
        // Observability must never break the probe; the miss is named.
        this.logger.warn('session memory reading failed', {
          tags: { deviceId: deviceIdFromBrokerId(entry.brokerId) },
          meta: { sessionId, error: errMsg(err) },
        })
      }
    }
    return readings
  }

  /** The counters a lifecycle line carries; empty when the session is gone. */
  private sessionMemMetaFor(sessionId: string): Record<string, number | boolean | string> {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return {}
    try {
      return sessionMemMeta(this.readSessionMem(sessionId, entry))
    } catch (err) {
      // A lifecycle line must survive a failed reading, and say it failed.
      return { memReadFailed: true, memReadError: errMsg(err) }
    }
  }

  /**
   * People watching LIVE through this server, per camera (`live-viewers.ts`):
   * sessions of a viewer kind whose track is on the live edge. A session on a
   * recorded playhead is not watching live; the system's own subscriptions
   * (warm-up, linger ghost, egress-transcode legs) are never a SESSION here, so
   * they cannot count.
   *
   * Derived from `this.sessions` at call time, the map `cleanupSession`
   * maintains for every teardown path (explicit close, ICE failure, the peer
   * vanishing — all end in `session.onClosed`), so there is no second counter
   * that could leak.
   */
  countLiveViewers(): ViewerCounts {
    const counts = new Map<number, number>()
    for (const entry of this.sessions.values()) {
      if (!isViewerConsumerKind(entry.consumerKind)) continue
      if ((entry.timeline?.currentMode ?? 'live') !== 'live') continue
      const deviceId = deviceIdFromBrokerId(entry.brokerId)
      if (deviceId === undefined) continue
      counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1)
    }
    return counts
  }

  /** Live signaling state for a session — used by the webrtc-session
   *  provider's getSessionState. Returns a null pending when unknown. */
  getSessionRenegotiationState(sessionId: string): {
    pendingRenegotiation: { target: WebrtcStreamTarget; epoch: number } | null
    alive: boolean
  } {
    const entry = this.sessions.get(sessionId)
    // A session id this server has never heard of and one that has ended give
    // the same answer, and that is correct: either way nothing is holding it
    // up, and a holder waiting for a teardown directive that will never come
    // needs to be told so. See the cap's docblock for the twenty minutes of
    // transcoding this absence cost.
    return {
      pendingRenegotiation: entry?.session.pendingRenegotiation ?? null,
      alive: entry !== undefined,
    }
  }

  /** Injected by the manager: brokerId → where its media is ingested. */
  setStreamOriginResolver(resolver: (brokerId: string) => WebrtcStreamOrigin | null): void {
    this.streamOriginResolver = resolver
  }

  /**
   * The SERVER half of the stream-debug overlay for one session — the rung
   * `auto` actually resolved to, why the ladder last moved, where the media
   * is ingested, and whether the egress leg copies or re-encodes.
   *
   * Read-only and allocation-light: polled at ~1 Hz by ONE overlay while it
   * is open. Shaping lives in the pure `projectSessionDebug`; this method
   * only gathers.
   */
  getSessionDebug(sessionId: string, now: number): WebrtcSessionDebug {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) {
      return projectSessionDebug({
        sessionId,
        observedAt: now,
        session: null,
        servedTier: null,
        origin: null,
        brokerStats: null,
        ladder: null,
      })
    }
    const controller = entry.adaptiveController
    const decision = this.lastLadderDecision.get(sessionId) ?? null
    // A ladder exists when a controller is running OR when one ran earlier in
    // this session (a tier switch rebuilds it, and the overlay is usually
    // opened AFTER the switch that prompted the question).
    const ladder: SessionDebugLadder | null =
      controller !== undefined
        ? {
            lastDecision: decision,
            failures: [...controller.failureCounts],
            upgradeCount: controller.successfulUpgradeCount,
            climbHold: controller.climbHold === null ? null : toWireClimbHold(controller.climbHold),
          }
        : decision !== null
          ? { lastDecision: decision, failures: [], upgradeCount: 0, climbHold: null }
          : null
    let brokerStats: ReturnType<IStreamBroker['getStats']> | null = null
    try {
      brokerStats = this.brokers.get(entry.brokerId)?.getStats() ?? null
    } catch {
      // A broker that cannot report is UNKNOWN, not zero. Never let a debug
      // read throw into the poll loop that feeds the overlay.
      brokerStats = null
    }
    return projectSessionDebug({
      sessionId,
      observedAt: now,
      session: {
        brokerId: entry.brokerId,
        adaptive: controller !== undefined,
        sourceCodec: entry.session.debugSourceCodec,
        negotiatedCodec: entry.session.debugNegotiatedCodec,
        needsTranscode: entry.session.needsTranscode,
        rtpPacketsSent: entry.session.rtpPacketsSentTotal,
        trackMode: entry.timeline?.currentMode ?? 'live',
      },
      servedTier: this.profileTierResolver?.(entry.brokerId) ?? null,
      origin: this.streamOriginResolver?.(entry.brokerId) ?? null,
      brokerStats,
      ladder,
    })
  }

  /**
   * Bound the ladder-decision memory. Entries survive a session teardown on
   * purpose (the re-offer keeps the id), so nothing else would ever evict the
   * one left behind by a client that disconnected mid-switch. Insertion order
   * is eviction order.
   */
  private pruneLadderDecisions(): void {
    const MAX_REMEMBERED_DECISIONS = 64
    while (this.lastLadderDecision.size > MAX_REMEMBERED_DECISIONS) {
      const oldest = this.lastLadderDecision.keys().next()
      if (oldest.done === true) break
      this.lastLadderDecision.delete(oldest.value)
    }
  }

  /** Snapshot the ladder's move so the overlay can name it later. */
  private recordLadderDecision(
    sessionId: string,
    decision: LadderDecision,
    tier: Tier | null,
    forcedTranscodeDown: boolean,
  ): void {
    this.lastLadderDecision.set(sessionId, {
      ...wireLadderCause(decision, ADAPTIVE_CONFIG.stallConfirmMs),
      tier,
      forcedTranscodeDown,
      lossRatio: decision.lossRatio,
      clientKbps: decision.stall.clientKbps,
      stalledForMs: decision.stall.stalledForMs,
      serverSending: decision.stall.serverSending,
      at: Date.now(),
    })
  }

  // ── Private ─────────────────────────────────────────────────────────

  /**
   * The IDR interval the broker feeding a session measured, or null when it
   * has measured none (a fresh broker reports 0). Sizes the delivery window.
   */
  private brokerIdrIntervalMs(brokerId: string): number | null {
    try {
      const idr = this.brokers.get(brokerId)?.getStats().idrIntervalMs ?? null
      return idr !== null && idr > 0 ? idr : null
    } catch {
      return null
    }
  }

  /**
   * The expected bitrate of `tier` for this device, from the broker serving
   * that rung — null when no such broker is registered here or it has
   * measured nothing. Unknown never vetoes a climb (D315/D393).
   */
  private expectedTierKbps(deviceId: number, tier: Tier): number | null {
    const prefix = `${String(deviceId)}/`
    const candidates: RungCandidate[] = []
    for (const [bid, broker] of this.brokers) {
      if (bid.startsWith(prefix)) {
        candidates.push({ brokerId: bid, tier: this.profileTierResolver?.(bid) ?? null, broker })
      }
    }
    // The same preference a re-offer's resolution applies: the rung a climb
    // would LAND on, not merely the first broker bound to the tier (m12).
    const match = preferLiveAdaptiveCandidates(candidates).find((c) => c.tier === tier)
    if (match === undefined) return null
    try {
      return expectedRungKbps(match.broker.getStats())
    } catch {
      return null
    }
  }

  /**
   * Wire an {@link AdaptiveController} to a freshly-created adaptive session.
   * The controller is fed loss from two sources — RTCP Receiver Reports
   * (`onReceiverReport`) and, when injected, the device's client-reported
   * packet-loss % polled every {@link ADAPTIVE_TICK_MS} — and drives the
   * ladder via the timer's `tick`. Side effects (tier switch / MTU reduce /
   * transcode-down) run through the controller's callbacks back into this
   * server.
   *
   * The client-loss % is turned into a monotonic {@link LossSample} LOCALLY:
   * per-controller cumulative sequence/loss counters advance for every
   * reported interval (including 0% loss), so a perfectly healthy LAN is real
   * evidence rather than silence, exactly like RTCP's cumulative fields.
   * Both paths feed the same controller; the tracker naturally honours
   * whichever produces the higher loss ratio across its window. The async
   * poll is guarded against overlapping ticks via `tickInFlight`.
   */
  private startAdaptive(
    entry: SessionEntry,
    deviceId: number,
    initialTier: Tier,
    sessionId: string,
    intent: AdaptiveIntent | undefined,
  ): void {
    const startedAt = Date.now()
    /** Rung bitrates, looked up at most once per tier per tick (review m12). */
    const rungKbps = new Map<Tier, number | null>()
    const controller = new AdaptiveController({
      initialTier,
      priorFailures: intent?.failures,
      priorUpgradeCount: intent?.upgradeCount,
      // A re-offer carries its own try state (incl. "this rung is a trial");
      // a brand-new session inherits the DEVICE's backoff, never a trial.
      tryClimb: intent?.tryClimb ?? this.deviceTryMemory.get(deviceId, startedAt) ?? undefined,
      config: ADAPTIVE_CONFIG,
      expectedTierKbps: (tier) => {
        if (!rungKbps.has(tier)) rungKbps.set(tier, this.expectedTierKbps(deviceId, tier))
        return rungKbps.get(tier) ?? null
      },
      onSwitchTier: (tier, decision) => {
        this.recordLadderDecision(sessionId, decision, tier, false)
        this.switchSessionTier(entry, deviceId, tier, sessionId, false, decision)
      },
      onReduceMtu: (decision) => {
        // A rung that changes no TIER still moved the ladder. Recording it
        // with `tier: null` is what keeps the overlay from claiming the
        // session was switched to a rung it was already on.
        this.recordLadderDecision(sessionId, decision, null, false)
        entry.session.setRepacketizerMtu(AdaptiveSession.ADAPTIVE_LOW_MTU)
        // A rung that produces no re-offer produced no log line either, so
        // the two cheapest recovery steps were invisible. A branch that acts
        // and says nothing reads as a branch that never ran.
        this.logger.info('adaptive: reducing repacketizer MTU', {
          tags: { deviceId },
          meta: {
            sessionId,
            deviceId,
            mtu: AdaptiveSession.ADAPTIVE_LOW_MTU,
            reason: decision.cause,
            lossRatio: Number(decision.lossRatio.toFixed(4)),
            clientKbps: decision.stall.clientKbps,
            sentKbps: decision.stall.sentKbps,
            deliveryRatio: decision.stall.deliveryRatio,
            deliveryWindowMs: decision.stall.deliveryWindowMs,
            stalledForMs: decision.stall.stalledForMs,
            serverSending: decision.stall.serverSending,
          },
        })
      },
      onTranscodeDown: (decision) => {
        this.recordLadderDecision(sessionId, decision, 'low', true)
        this.switchSessionTier(entry, deviceId, 'low', sessionId, true, decision)
      },
    })
    entry.session.onReceiverReport((s) => controller.onLoss(s, Date.now()))
    entry.adaptiveController = controller

    let clientHighestSequence = 0
    let clientPacketsLost = 0
    let tickInFlight = false
    /** RTP packets sent as of the previous evaluation — the "was the broker
     *  sending?" half of the stall verdict. */
    let lastRtpSent = entry.session.rtpPacketsSentTotal
    const CLIENT_LOSS_SPAN = 1000
    // Received vs sent over one GOP (D635). One meter per controller: the
    // client reports are DEVICE-scoped, so reports about time before this
    // session are refused — and a session a TIER CHANGE created also refuses
    // the change blackout, when the client still reads its old PC (I1).
    const meter = new DeliveryMeter(
      ADAPTIVE_DELIVERY_CONFIG,
      deliveryMeterStart(startedAt, intent !== undefined, ADAPTIVE_CONFIG.waitAfterChangeMs),
    )
    const holdLog = new HoldLogGate(HOLD_LOG_QUIET_MS)
    let lastTickFailureLogAt = Number.NEGATIVE_INFINITY
    const logHoldChange = (now: number): void => {
      const hold = controller.climbHold
      if (hold === null || !holdLog.shouldLog(hold.code, now)) return
      this.logger.info('adaptive: climb held', {
        tags: { deviceId },
        meta: {
          sessionId,
          deviceId,
          tier: controller.currentTier,
          nextTier: hold.nextTier,
          code: hold.code,
          summary: describeClimbHold(hold),
          deliveryRatio: hold.deliveryRatio,
          deliveryWindowMs: hold.deliveryWindowMs,
          capacityKbps: hold.capacityKbps,
          probeKbps: hold.probeKbps,
          nextTierKbps: hold.nextTierKbps,
        },
      })
    }
    entry.adaptiveTimer = setInterval(() => {
      if (tickInFlight) return
      tickInFlight = true
      void (async () => {
        try {
          rungKbps.clear()
          // D42: this session's track may currently be carrying the recorded
          // feeder, not the live source. The ladder must not act there — a
          // tier switch is a close-and-recreate re-offer, which disposes the
          // TimelineSession and drops the viewer back to live at the wrong
          // moment with nothing to restore the pointer.
          if (entry.timeline?.currentMode === 'recorded') {
            controller.suspend(Date.now())
            lastRtpSent = entry.session.rtpPacketsSentTotal
            logHoldChange(Date.now())
            return
          }
          const client = this.clientNetworkStats ? await this.clientNetworkStats(deviceId) : null
          const now = Date.now()

          // The TRANSPORT's own measurement, before anything derived from it.
          // `serverSending` is read here and not inside the tracker so the
          // counter advances exactly once per evaluation.
          const rtpSent = entry.session.rtpPacketsSentTotal
          const serverSending = rtpSent > lastRtpSent
          lastRtpSent = rtpSent
          this.feedAdaptive({ entry, deviceId, controller, meter, client, serverSending, now })

          const pct = client?.packetLossPercent ?? null
          if (pct !== null && pct !== undefined) {
            clientHighestSequence += CLIENT_LOSS_SPAN
            clientPacketsLost += Math.round(
              (Math.max(0, Math.min(100, pct)) / 100) * CLIENT_LOSS_SPAN,
            )
            controller.onLoss(
              {
                packetsLost: clientPacketsLost,
                highestSequence: clientHighestSequence,
              },
              now,
            )
          }
          controller.tick(now)
          this.deviceTryMemory.set(deviceId, controller.tryClimbCarry, now)
          logHoldChange(now)
        } catch (err) {
          // One bad evaluation must not become an unhandled rejection, nor
          // silence the ladder: the next tick runs as if this one had not.
          // Rate-limited — a dependency failing every 2 s is one line a minute.
          const now = Date.now()
          if (now - lastTickFailureLogAt >= TICK_FAILURE_LOG_QUIET_MS) {
            lastTickFailureLogAt = now
            this.logger.warn('adaptive: tick failed', {
              tags: { deviceId },
              meta: { sessionId, deviceId, error: errMsg(err) },
            })
          }
        } finally {
          tickInFlight = false
        }
      })()
    }, ADAPTIVE_TICK_MS)
  }

  /**
   * One evaluation's transport, capacity and RTT evidence into the controller.
   * The device-scoped client record is used as this session's own only when
   * this is the device's ONLY adaptive session here (review I2).
   */
  private feedAdaptive(feed: AdaptiveFeed): void {
    const { entry, deviceId, controller, meter, client, now } = feed
    const sessionsOnDevice = this.adaptiveSessionCount(deviceId)
    const shared = sessionsOnDevice > 1
    let rttMs: number | null = null
    if (client) {
      const reportAgeMs = Math.max(0, now - client.lastUpdated)
      meter.observe(client.estimatedBandwidthKbps, client.lastUpdated)
      if (!shared) {
        this.recordDeviceProbe(
          deviceId,
          probeFromReport(
            {
              downlinkMbps: client.downlinkMbps,
              downlinkAgeMs: client.downlinkAgeMs ?? 0,
              reportAgeMs,
            },
            now,
          ),
        )
        // A dead record must not read as a "stable" RTT (review m5).
        if (reportAgeMs <= ADAPTIVE_DELIVERY_CONFIG.maxClientSampleAgeMs)
          rttMs = client.rttMs ?? null
      }
    }
    const history = entry.session.sentVideoHistory
    controller.onThroughput(
      buildStallSample({
        delivery: meter.evaluate(
          history,
          deliveryWindowMs(this.brokerIdrIntervalMs(entry.brokerId), ADAPTIVE_DELIVERY_CONFIG),
          now,
        ),
        recent: meter.evaluateNewest(history, now),
        clientReporting: meter.isReporting(now),
        serverSending: feed.serverSending,
        adaptiveSessionsOnDevice: sessionsOnDevice,
      }),
      now,
    )
    const probe = this.deviceProbe.get(deviceId, now)
    controller.onCapacity({
      rembKbps: entry.session.receiverEstimateKbps(now),
      probeKbps: probe?.kbps ?? null,
      probeFresh: isProbeFresh(probe, now),
    })
    controller.onRtt(rttMs, now)
  }

  /**
   * The viewer's downlink probe for ONE session (D733) — the server half of the
   * probe climb. The player used to answer its own probe with a second session
   * (a make-before-break reconnect carrying `downlinkMbps`); it now hands the
   * measurement to the session it already has, and the broker places that
   * session on the rung the probe picks, in place when the codec allows.
   *
   * The client sends a MEASUREMENT, never a tier: the pick is the same
   * `pickAdaptiveTier` an offer's hints get, against the same viewport the
   * offer carried, so a tile still ceilings to `low`. A probe only ever
   * raises the rung — lowering it is the ladder's job, on delivery evidence.
   */
  applyDownlinkProbe(sessionId: string, downlinkMbps: number): DownlinkProbeOutcome {
    const entry = this.sessions.get(sessionId)
    if (entry === undefined) return { outcome: 'held', tier: null, reason: 'no-session' }
    const deviceId = deviceIdFromBrokerId(entry.brokerId)
    const served = this.profileTierResolver?.(entry.brokerId) ?? null
    const controller = entry.adaptiveController
    const rebind = entry.rebind
    const now = Date.now()
    const held = (reason: string): DownlinkProbeOutcome => {
      this.logger.info('adaptive: downlink probe holds the session where it is', {
        tags: { deviceId },
        meta: { sessionId, deviceId, downlinkMbps, tier: served, reason },
      })
      return { outcome: 'held', tier: served, reason }
    }
    if (controller === undefined || rebind === undefined) return held('not-adaptive')
    this.recordDeviceProbe(deviceId, probeFromHints(downlinkMbps, now))
    if (rebind.hints.prefersTier !== undefined) return held('pinned')
    if (entry.timeline?.currentMode === 'recorded') return held('recorded')
    const pick = pickAdaptiveTier({
      available: preferLiveAdaptiveCandidates(this.deviceBrokerCandidates(deviceId)).map(
        (c) => c.tier,
      ),
      downlinkMbps,
      viewportWidth: rebind.hints.viewportWidth,
      viewportHeight: rebind.hints.viewportHeight,
    })
    const current = entry.pendingSwitch?.tier ?? controller.currentTier
    if (CAM_PROFILE_ORDER.indexOf(pick.tier) >= CAM_PROFILE_ORDER.indexOf(current)) {
      return held(pick.tier === current ? 'already-there' : 'probe-below-current')
    }
    controller.settleOn(pick.tier, now)
    this.logger.info('adaptive: downlink probe places the session on a higher rung', {
      tags: { deviceId },
      meta: {
        sessionId,
        deviceId,
        downlinkMbps,
        from: current,
        tier: pick.tier,
        pick: pick.reason,
      },
    })
    this.switchSessionTier(entry, deviceId, pick.tier, sessionId)
    return { outcome: 'switching', tier: pick.tier, reason: pick.reason }
  }

  /** Every registered broker of `deviceId`, with the tier it currently serves. */
  private deviceBrokerCandidates(
    deviceId: number,
  ): { readonly brokerId: string; readonly tier: CamProfile | null }[] {
    const prefix = `${String(deviceId)}/`
    const out: { brokerId: string; tier: CamProfile | null }[] = []
    for (const bid of this.brokers.keys()) {
      if (bid.startsWith(prefix))
        out.push({ brokerId: bid, tier: this.profileTierResolver?.(bid) ?? null })
    }
    return out
  }

  /** Adaptive sessions of `deviceId` currently on this broker server. */
  private adaptiveSessionCount(deviceId: number): number {
    const prefix = `${String(deviceId)}/`
    let count = 0
    for (const s of this.sessions.values()) {
      if (s.adaptiveController !== undefined && s.brokerId.startsWith(prefix)) count += 1
    }
    return count
  }

  /** Keep the newest probe per device; an absent one changes nothing. */
  private recordDeviceProbe(deviceId: number, probe: ProbeEvidence | null): void {
    this.deviceProbe.record(deviceId, probe)
  }

  /**
   * Move an adaptive session to `tier` — ON THE SESSION when it can (D733),
   * by the close-and-recreate re-offer when it cannot, and the refusal that
   * forced the re-offer is logged by name.
   *
   * A newer switch replaces one still waiting for its keyframe: the ladder's
   * latest verdict is the one that must land, and an abandoned wait leaves the
   * old source on the track (nothing froze).
   */
  private switchSessionTier(
    entry: SessionEntry,
    deviceId: number,
    tier: Tier,
    sessionId: string,
    forceTranscodeDown = false,
    decision?: LadderDecision,
  ): void {
    entry.pendingSwitch?.cancel()
    entry.pendingSwitch = undefined
    const why = decision?.cause ?? 'probe'
    if (forceTranscodeDown) {
      this.logInPlaceFallback(entry, deviceId, tier, sessionId, 'transcode-down', why)
      this.scheduleTierReoffer(entry, deviceId, tier, sessionId, true, decision)
      return
    }
    void this.switchTierInPlace(entry, deviceId, tier, sessionId, why)
      .then((outcome) => {
        if (outcome.kind !== 'refused') return
        if (this.sessions.get(sessionId) !== entry) return
        this.logInPlaceFallback(entry, deviceId, tier, sessionId, outcome.reason, why)
        this.scheduleTierReoffer(entry, deviceId, tier, sessionId, false, decision)
      })
      .catch((err: unknown) => {
        // A switch that threw must still reach a picture of the wanted tier:
        // the re-offer is the path that always existed.
        this.logger.warn('adaptive: in-place tier switch threw — falling back to re-offer', {
          tags: { deviceId },
          meta: { sessionId, deviceId, tier, error: errMsg(err) },
        })
        if (this.sessions.get(sessionId) !== entry) return
        this.scheduleTierReoffer(entry, deviceId, tier, sessionId, false, decision)
      })
  }

  private logInPlaceFallback(
    entry: SessionEntry,
    deviceId: number,
    tier: Tier,
    sessionId: string,
    reason: InPlaceRefusal,
    why: string,
  ): void {
    this.logger.info('adaptive: tier switch needs a re-offer — cannot stay on the session', {
      tags: { deviceId },
      meta: { sessionId, deviceId, tier, fromBrokerId: entry.brokerId, reason, cause: why },
    })
  }

  /** What the session is now, for `judgeInPlaceSwitch`. */
  private inPlaceSessionShape(entry: SessionEntry, rebind: SessionRebind): InPlaceSessionShape {
    return {
      recorded: entry.timeline?.currentMode === 'recorded',
      forceTranscodeDown: false,
      useRtpRepacketizer: rebind.useRtpRepacketizer,
      needsTranscode: entry.session.needsTranscode,
      sessionCodec: rebind.sessionCodec,
      audioCodec: this.brokers.get(entry.brokerId)?.getStats().audio?.codec ?? null,
      usesOpusEgress: entry.releaseOpusEgress !== undefined,
    }
  }

  /** What the target rendition is, as far as it is known now. */
  private inPlaceTargetShape(
    rebind: SessionRebind,
    landed: Tier | null,
    target: IStreamBroker | undefined,
  ): InPlaceTargetShape {
    if (target === undefined) {
      return {
        tierMatches: false,
        isRtp: false,
        codec: null,
        needsBaselineTranscode: false,
        audioCodec: undefined,
        supportsOpusEgress: false,
      }
    }
    const stats = target.getStats()
    const codec = sessionCodecOf(stats.codec)
    let needsBaselineTranscode = false
    if (codec === 'H264') {
      const profile = deriveH264ProfileLevelId(target.getSdpParameterSets(), target.getPreBuffer())
      needsBaselineTranscode =
        rebind.offeredProfileLevelIds !== undefined
          ? resolveClientOfferTranscodeToBaseline('H264', profile, rebind.offeredProfileLevelIds)
          : resolveBrokerTranscodeToBaseline('H264', profile)
    }
    return {
      tierMatches: landed !== null,
      isRtp: target.isRtpSource(),
      codec,
      needsBaselineTranscode,
      // Unknown until the broker has its SDP: a cold broker's audio is judged at commit.
      audioCodec: codec === null ? undefined : (stats.audio?.codec ?? null),
      supportsOpusEgress: supportsOpusEgress(target),
    }
  }

  /**
   * The in-place half of a tier switch (D733): resolve the tier's broker,
   * judge whether the negotiated session carries it as is, subscribe it
   * make-before-break and commit on its first switchable keyframe.
   */
  private async switchTierInPlace(
    entry: SessionEntry,
    deviceId: number,
    tier: Tier,
    sessionId: string,
    why: string,
  ): Promise<InPlaceOutcome> {
    const rebind = entry.rebind
    if (rebind === undefined) return { kind: 'refused', reason: 'not-rtp-passthrough' }
    const early = judgeInPlaceSwitch(this.inPlaceSessionShape(entry, rebind), {
      tierMatches: true,
      isRtp: true,
      codec: null,
      needsBaselineTranscode: false,
      audioCodec: undefined,
      supportsOpusEgress: true,
    })
    if (early !== null) return { kind: 'refused', reason: early }
    try {
      await this.ensureAdaptiveTierBroker?.(deviceId, tier)
    } catch (err) {
      this.logger.warn('adaptive: could not prepare the tier broker for an in-place switch', {
        tags: { deviceId },
        meta: { sessionId, deviceId, tier, error: errMsg(err) },
      })
      return { kind: 'refused', reason: 'tier-unavailable' }
    }
    if (this.sessions.get(sessionId) !== entry) return { kind: 'abandoned' }
    const targetId = this.selectBestBroker(String(deviceId), { prefersTier: tier })
    const target = this.brokers.get(targetId)
    // The rung the wanted tier resolves to. A camera with two streams serves no
    // `mid`: the re-offer always landed such a move on the smallest rung and
    // rebuilt the controller there — `settleOn` is that rebuild, minus the
    // connection.
    const landed = this.profileTierResolver?.(targetId) ?? null
    if (target !== undefined && targetId === entry.brokerId) {
      if (landed !== null) entry.adaptiveController?.settleOn(landed, Date.now())
      rebind.sessionLogger.info(
        'adaptive: wanted tier is not served — the session stays on its rung',
        {
          tags: { deviceId },
          meta: { sessionId, deviceId, tier, landed, brokerId: targetId, cause: why },
        },
      )
      return { kind: 'committed' }
    }
    const judge = (): InPlaceRefusal | null =>
      judgeInPlaceSwitch(
        this.inPlaceSessionShape(entry, rebind),
        this.inPlaceTargetShape(rebind, landed, target),
      )
    const refusal = judge()
    if (refusal !== null || target === undefined) {
      return { kind: 'refused', reason: refusal ?? 'tier-unavailable' }
    }
    const fromBrokerId = entry.brokerId
    const startedAt = Date.now()
    rebind.sessionLogger.info(
      'adaptive: tier switch staying on the session — waiting for a keyframe',
      {
        tags: { deviceId },
        meta: { sessionId, deviceId, tier, fromBrokerId, toBrokerId: targetId, cause: why },
      },
    )
    return new Promise<InPlaceOutcome>((resolve) => {
      const forward = makeSourceRtpForwarder({
        session: entry.session,
        sessionLogger: rebind.sessionLogger,
        sessionId,
        deviceId,
        brokerId: targetId,
        sessionCodec: rebind.sessionCodec,
      })
      const pending = bindPendingSource({
        broker: target,
        attribution: {
          ...rebind.baseAttribution,
          media: 'video',
          targetCodec: rebind.sessionCodec,
          transport: 'repacketize',
        },
        timeoutMs: IN_PLACE_SWITCH_KEYFRAME_WAIT_MS,
        commit: () => {
          if (this.sessions.get(sessionId) !== entry || entry.pendingSwitch !== handle) {
            resolve({ kind: 'abandoned' })
            return false
          }
          entry.pendingSwitch = undefined
          const late = judge()
          if (late !== null) {
            resolve({ kind: 'refused', reason: late })
            return false
          }
          // The rung asked for may not be served (`mid` on a two-stream camera):
          // the ladder follows the rung the session actually landed on.
          if (landed !== null && landed !== tier) {
            entry.adaptiveController?.settleOn(landed, Date.now())
          }
          this.commitInPlaceSwitch(entry, rebind, {
            sessionId,
            tier: landed ?? tier,
            targetId,
            target,
            unsubRtp: pending.unsubscribe,
            waitedMs: Date.now() - startedAt,
            cause: why,
          })
          resolve({ kind: 'committed' })
          return true
        },
        forward,
        onTimeout: () => {
          if (entry.pendingSwitch === handle) entry.pendingSwitch = undefined
          resolve({ kind: 'refused', reason: 'target-no-keyframe' })
        },
      })
      const handle = {
        tier,
        cancel: () => {
          pending.unsubscribe()
          resolve({ kind: 'abandoned' })
        },
      }
      entry.pendingSwitch = handle
    })
  }

  /**
   * Swap every subscription of `entry` onto `target` in one synchronous step,
   * inside the delivery of the target's committing packet: nothing from the old
   * broker can reach the track after this returns, and the target's next
   * forward replays its GOP from the keyframe onto a rebased RTP stream.
   */
  private commitInPlaceSwitch(entry: SessionEntry, rebind: SessionRebind, sw: CommitInPlace): void {
    const { session } = entry
    const { deviceId, sessionLogger } = rebind
    const old = {
      brokerId: entry.brokerId,
      unsubBroker: entry.unsubBroker,
      unsubRtp: entry.unsubRtp,
      unsubSdpParams: entry.unsubSdpParams,
      unsubSourceRestart: entry.unsubSourceRestart,
      releaseOpusEgress: entry.releaseOpusEgress,
    }
    const target = sw.target
    // New consumers first, old ones after: the target never sees zero demand.
    entry.unsubBroker = target.onEncodedData(
      (packet: EncodedPacket) => {
        if (packet.type === 'audio') forwardBrokerAudio(packet, session, rebind.pushFrame)
      },
      { ...rebind.baseAttribution, media: 'audio', transport: 'passthrough' },
    )
    entry.unsubRtp = sw.unsubRtp
    if (old.releaseOpusEgress !== undefined && supportsOpusEgress(target)) {
      target.acquireOpusEgress()
      entry.releaseOpusEgress = () => target.releaseOpusEgress()
    } else {
      entry.releaseOpusEgress = undefined
    }
    const parameterSets = target.getSdpParameterSets()
    session.switchLiveSource({
      rtpBootstrap: () => target.getRtpPreBuffer(),
      parameterSets,
      reason: `tier ${sw.tier} (${sw.cause})`,
    })
    entry.unsubSdpParams =
      parameterSets !== null && parameterSets.length > 0
        ? null
        : target.onSdpParameterSets((ps) => {
            if (rebind.sessionCodec === 'H265') session.seedH265CodecInfoFromSdp(ps)
            else session.seedH264CodecInfoFromSdp(ps)
          })
    entry.unsubSourceRestart = target.onSourceRestart((reason: string) => {
      sessionLogger.info('broker re-dialed the source — re-syncing session', {
        tags: { deviceId },
        meta: { sessionId: sw.sessionId, brokerId: sw.targetId, deviceId, reason },
      })
      session.onSourceRestarted(reason)
    })
    entry.brokerId = sw.targetId
    old.unsubRtp?.()
    old.unsubBroker()
    old.unsubSdpParams?.()
    old.unsubSourceRestart()
    old.releaseOpusEgress?.()
    this.brokerLinger.cancel(sw.targetId)
    let oldStillServed = false
    for (const other of this.sessions.values()) {
      if (other.brokerId === old.brokerId) {
        oldStillServed = true
        break
      }
    }
    if (!oldStillServed && !this.stopped) this.brokerLinger.hold(old.brokerId)
    const pair = session.readNominatedPair()
    if (pair !== null) {
      const remoteAddr =
        pair.remoteType === 'host' ? pair.remoteAddr : `${pair.remoteAddr} (${pair.remoteType})`
      target.updateConsumerAttributionBySession(sw.sessionId, { remoteAddr })
    }
    entry.timeline?.setLiveProfile(sw.tier)
    sessionLogger.info('adaptive: tier switched in place — same session, same connection', {
      tags: { deviceId },
      meta: {
        sessionId: sw.sessionId,
        deviceId,
        tier: sw.tier,
        fromBrokerId: old.brokerId,
        toBrokerId: sw.targetId,
        codec: rebind.sessionCodec,
        waitedMs: sw.waitedMs,
        cause: sw.cause,
        replayPackets: target.getRtpPreBuffer().length,
      },
    })
  }

  /**
   * Schedule an adaptive tier switch via a close-and-recreate re-offer.
   *
   * Records the controller's desired tier (+ forced transcode-down) in
   * `adaptiveIntent`, then sets `pendingRenegotiation` with an ADAPTIVE
   * target so the client re-offers under the same sessionId. The re-offer
   * runs through `setupSessionForBroker`, which tears the old session down
   * completely and rebinds whichever feed type the session uses — so we no
   * longer do a live broker rebind here (that produced a dual-feed for the
   * AnnexB path and couldn't recreate the controller). `setupSessionForBroker`
   * consumes the recorded intent to pin the recreated session to `tier` and
   * apply the reduced transcode profile when `forceTranscodeDown` is set.
   */
  private scheduleTierReoffer(
    entry: SessionEntry,
    deviceId: number,
    tier: Tier,
    sessionId: string,
    forceTranscodeDown = false,
    decision?: LadderDecision,
  ): void {
    const prev = this.adaptiveIntent.get(sessionId)
    // Snapshot the ladder's failure memory so the session's NEXT controller
    // (the re-offer builds a fresh one) inherits it — see `AdaptiveIntent`.
    const failures = new Map<Tier, number>(
      entry.adaptiveController?.failureCounts ?? prev?.failures,
    )
    const upgradeCount = entry.adaptiveController?.successfulUpgradeCount ?? prev?.upgradeCount ?? 0
    const tryClimb = entry.adaptiveController?.tryClimbCarry ?? prev?.tryClimb
    this.adaptiveIntent.set(sessionId, {
      prefersTier: tier,
      forceTranscodeDown: forceTranscodeDown || (prev?.forceTranscodeDown ?? false),
      failures,
      upgradeCount,
      tryClimb: tryClimb ?? { failures: 0, notBefore: 0, lastRevert: null, trialFrom: null },
    })
    const epoch = (entry.session.pendingRenegotiation?.epoch ?? 0) + 1
    entry.session.pendingRenegotiation = { target: { kind: 'adaptive' }, epoch }
    this.logger.info('adaptive: scheduling renegotiation', {
      tags: { deviceId },
      meta: {
        sessionId,
        deviceId,
        tier,
        forceTranscodeDown,
        epoch,
        failures: Object.fromEntries(failures),
        upgradeCount,
        // WHY, and the numbers it rests on. `reason=downlink` in the source
        // pick names a client HINT; these name a measurement. A downgrade
        // whose evidence is not in the line cannot be argued with.
        reason: decision?.cause ?? 'unknown',
        trial: decision?.trial ?? false,
        lossRatio: decision ? Number(decision.lossRatio.toFixed(4)) : null,
        clientKbps: decision?.stall.clientKbps ?? null,
        sentKbps: decision?.stall.sentKbps ?? null,
        deliveryRatio: decision?.stall.deliveryRatio ?? null,
        deliveryWindowMs: decision?.stall.deliveryWindowMs ?? null,
        stalledForMs: decision?.stall.stalledForMs ?? null,
        serverSending: decision?.stall.serverSending ?? null,
      },
    })
  }

  private cleanupSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    // The ONE place every end of a session passes through (closeSession and
    // session.onClosed alike), and the entry is deleted just below, so the
    // counters are logged exactly once, before teardown releases the buffers.
    const deviceId = deviceIdFromBrokerId(entry.brokerId)
    this.logger.info('WebRTC session closing: pinned-memory counters', {
      tags: { deviceId },
      meta: { sessionId, deviceId, ...this.sessionMemMetaFor(sessionId) },
    })
    this.sessions.delete(sessionId)
    reportConsumerEvent(
      this.logger,
      'detach',
      `webrtc:${entry.consumerKind}`,
      entry.rebind?.deviceId,
      this.sessions.size,
    )
    entry.pendingSwitch?.cancel()
    entry.pendingSwitch = undefined
    // Last session on this broker gone → keep the source warm for the
    // linger window. The dominant remote access pattern is a reopen within
    // minutes; a warm broker turns that reconnect from "background re-dial
    // + empty ring + next-IDR wait" into an instant-start replay. The hold
    // self-expires; a new session cancels it after its real subscription
    // attaches (no demand gap either way).
    let brokerStillServed = false
    for (const other of this.sessions.values()) {
      if (other.brokerId === entry.brokerId) {
        brokerStillServed = true
        break
      }
    }
    if (!brokerStillServed && !this.stopped) {
      this.brokerLinger.hold(entry.brokerId)
    }
    // Clear any pending adaptive intent as a leak safety. On the close-and-
    // recreate re-offer the intent is already consumed (read + deleted at the
    // top of `setupSessionForBroker`) before this runs for the stale session,
    // so this is a no-op there; it only catches the permanent-teardown case
    // where a switch was scheduled but the client disconnected before
    // re-offering.
    this.adaptiveIntent.delete(sessionId)
    // The device's last adaptive session is gone: its probe describes a viewer
    // that left (review N1). The try backoff deliberately stays (TTL-bounded).
    if (entry.adaptiveController !== undefined) {
      const deviceId = deviceIdFromBrokerId(entry.brokerId)
      if (this.adaptiveSessionCount(deviceId) === 0) this.deviceProbe.forget(deviceId)
    }
    // The ladder's last move deliberately OUTLIVES this teardown: a tier
    // switch is a close-and-recreate re-offer, and the session an operator
    // then opens the debug overlay on is the recreated one. Dropping it here
    // would blank the answer at exactly the moment it is asked for. Bounded
    // instead of cleared — see `pruneLadderDecisions`.
    this.pruneLadderDecisions()
    if (entry.adaptiveTimer) clearInterval(entry.adaptiveTimer)
    // Clear any pending remote-address tagging retry so no timer fires after
    // teardown (and latch it so a stale fire is a guaranteed no-op).
    if (entry.attributionTimer) clearTimeout(entry.attributionTimer)
    entry.attributionTagged = true
    entry.unsubBroker()
    entry.unsubRtp?.()
    entry.unsubSdpParams?.()
    entry.unsubSourceRestart()
    entry.releaseOpusEgress?.()
    entry.releaseOpusEgress = undefined
    entry.closeTalkback?.()
    entry.closeSource()
  }

  private resolveBrokerId(streamId: string, hints: ClientHints = {}): string {
    // Direct match — `webrtc-session.createSession` resolves the
    // discriminated `WebrtcStreamTarget` to a canonical brokerId
    // (`${deviceId}/${camStreamId}`) before invoking the server, so
    // every legitimate client request hits this branch.
    if (this.brokers.has(streamId)) return streamId

    // Adaptive fallthrough — `${deviceId}/adaptive` is a sentinel
    // that means "pick the best broker for the device". Bare
    // deviceKey (no slash) is treated the same way for legacy
    // callers that only know the device id.
    const slash = streamId.indexOf('/')
    if (slash > 0) {
      const tail = streamId.slice(slash + 1)
      if (tail === 'adaptive') {
        return this.selectBestBroker(streamId.slice(0, slash), hints)
      }
    } else {
      return this.selectBestBroker(streamId, hints)
    }
    // Unknown shape — let the lookup fail in the caller so the
    // 'No broker for stream' message points at the actual input.
    return streamId
  }

  /**
   * Adaptive source selection: score registered brokers for a device
   * against client hints (viewport, downlink). Returns the broker ID
   * with the best fit. Falls back to the smallest available rung when
   * there is no downlink / prefersTier — the first picture is cheap,
   * then a probe climbs.
   */
  private selectBestBroker(deviceKey: string, hints: ClientHints): string {
    // Collect all brokers for this device, attaching the resolver-
    // derived tier so candidates can be ranked irrespective of brokerId
    // shape (post-refactor brokerId carries the camStreamId, not the
    // tier — tiers are looked up in the assignments map at request
    // time via `profileTierResolver`).
    type Candidate = {
      brokerId: string
      tier: CamProfile | null
      broker: IStreamBroker
    }
    const candidates: Candidate[] = []
    for (const [bid, broker] of this.brokers) {
      if (!bid.startsWith(`${deviceKey}/`)) continue
      const tier = this.profileTierResolver?.(bid) ?? null
      candidates.push({ brokerId: bid, tier, broker })
    }
    const pool = preferLiveAdaptiveCandidates(candidates)
    if (pool.length === 0) return `${deviceKey}/high` // will fail at broker lookup
    if (pool.length === 1) return pool[0]!.brokerId

    const adaptiveDeviceIdTag = Number(deviceKey.split('/')[0])
    const deviceIdTag = Number.isFinite(adaptiveDeviceIdTag)
      ? { tags: { deviceId: adaptiveDeviceIdTag } }
      : {}

    const pick = pickAdaptiveTier({
      available: pool.map((c) => c.tier),
      prefersTier: hints.prefersTier,
      downlinkMbps: hints.downlinkMbps,
      viewportWidth: hints.viewportWidth,
      viewportHeight: hints.viewportHeight,
    })
    const selected = pool.find((c) => c.tier === pick.tier) ?? pool[0]!
    this.logger.info(adaptivePickLogLine(pick.reason), {
      ...deviceIdTag,
      meta: {
        deviceKey,
        selected: selected.brokerId,
        tier: selected.tier,
        reason: pick.reason,
        prefersTier: hints.prefersTier,
        hints,
      },
    })
    return selected.brokerId
  }

  private async resolveIceServers(): Promise<readonly IceServerEntry[]> {
    if (this.getIceServersFn) {
      try {
        return await this.getIceServersFn()
      } catch (err) {
        this.logger.warn('getIceServers failed', { meta: { error: errMsg(err) } })
      }
    }
    return this.staticIceServers ?? []
  }
}

// ---------------------------------------------------------------------------
// Push-based FrameSource factory
// ---------------------------------------------------------------------------
// NAL type detection (codec-agnostic)
// ---------------------------------------------------------------------------

/**
 * Parse the numeric deviceId out of a canonical brokerId
 * (`${deviceId}/${camStreamId}`). Returns -1 for the bare-deviceKey
 * shape with no slash. Used so every session/broker log line can carry
 * `deviceId` (operator log filters scoped to one device otherwise drop
 * them as `dev=?`).
 */
function deviceIdFromBrokerId(brokerId: string): number {
  const slashIdx = brokerId.indexOf('/')
  if (slashIdx <= 0) return -1
  const parsed = Number.parseInt(brokerId.slice(0, slashIdx), 10)
  return Number.isNaN(parsed) ? -1 : parsed
}

interface NalTypeInfo {
  readonly isParamSet: boolean
  readonly isKeyframe: boolean
}

/**
 * Detect the type of the first NAL in an Annex-B buffer.
 * Works for both H.264 (1-byte NAL header) and H.265 (2-byte NAL header).
 */
function detectFirstNalType(annexB: Buffer, isHevc: boolean): NalTypeInfo {
  for (let i = 0; i < annexB.length - 4; i++) {
    if (
      annexB[i] === 0 &&
      annexB[i + 1] === 0 &&
      annexB[i + 2] === 0 &&
      annexB[i + 3] === 1 &&
      i + 4 < annexB.length
    ) {
      if (isHevc) {
        const nalType = (annexB[i + 4]! & 0x7e) >> 1
        const isParamSet = nalType === 32 || nalType === 33 || nalType === 34
        const isKeyframe = isParamSet || (nalType >= 16 && nalType <= 21)
        return { isParamSet, isKeyframe }
      } else {
        const nalType = annexB[i + 4]! & 0x1f
        const isParamSet = nalType === 7 || nalType === 8
        const isKeyframe = nalType === 5 || isParamSet
        return { isParamSet, isKeyframe }
      }
    }
  }
  return { isParamSet: false, isKeyframe: false }
}

// ---------------------------------------------------------------------------
// Push-based FrameSource factory
// ---------------------------------------------------------------------------

/** Queue depth that triggers the back-pressure purge. */
const PUSH_QUEUE_MAX = 120
/** Frames retained by a purge, at most — the bound the cut may never exceed. */
const PUSH_QUEUE_KEEP = 60

/**
 * Push-based `FrameSource` for a WebRTC session.
 *
 * `onFramesDropped` reports the back-pressure purge below. It used to be
 * silent: a session whose consumer stalled discarded 61 encoded frames — two
 * seconds of video, GOP boundaries included — with no line at any level, so the
 * gap it produced downstream looked like the camera had stopped sending.
 * Reported per purge, never per frame: the purge is already the aggregate.
 *
 * **The purge cuts at a KEYFRAME.** The queue fills between the subscription
 * (which replays the broker's retained GOP, then takes live packets) and the
 * moment werift starts pulling this generator — for an Echo, after non-trickle
 * ICE gathering and the answer round trip, seconds later. That is normal and
 * the bound is right; cutting "keep the last 60" was not, because the retained
 * window then began at whatever P-frame happened to land there and the first
 * decodable picture was the NEXT IDR — a whole keyframe interval of black out
 * of a purge that was meant to be the recovery. So the cut is the SMALLEST one
 * that both respects the bound and lands on a keyframe; with no keyframe in
 * range it falls back to the plain bound, which is exactly the old behaviour.
 */
export function createPushFrameSource(
  onFramesDropped?: (count: number, keyframeAligned: boolean) => void,
): {
  source: FrameSource
  pushFrame: (frame: MediaFrame) => void
  close: () => void
  /** Visit the queued frames — probe time only, ≤ PUSH_QUEUE_MAX + 1 items. */
  forEachQueued: (visit: (frame: MediaFrame) => void) => void
} {
  const queue: MediaFrame[] = []
  let resolve: ((value: IteratorResult<MediaFrame>) => void) | null = null
  let done = false

  const pushFrame = (mf: MediaFrame): void => {
    if (done) return
    if (resolve) {
      const r = resolve
      resolve = null
      r({ value: mf, done: false })
    } else {
      queue.push(mf)
      if (queue.length > PUSH_QUEUE_MAX) {
        // The bound first: never retain more than PUSH_QUEUE_KEEP.
        const minCut = queue.length - PUSH_QUEUE_KEEP
        let cut = minCut
        let keyframeAligned = false
        for (let i = minCut; i < queue.length; i++) {
          const frame = queue[i]
          if (frame?.type === 'video' && frame.frame.isKeyframe) {
            cut = i
            keyframeAligned = true
            break
          }
        }
        queue.splice(0, cut)
        onFramesDropped?.(cut, keyframeAligned)
      }
    }
  }

  const close = (): void => {
    done = true
    if (resolve) {
      const r = resolve
      resolve = null
      r({ value: undefined as never, done: true })
    }
  }

  const source: FrameSource = (async function* () {
    try {
      while (true) {
        const item = queue.shift()
        if (item) {
          yield item
          continue
        }
        if (done) return
        const result = await new Promise<IteratorResult<MediaFrame>>((r) => {
          resolve = r
        })
        if (result.done) return
        yield result.value
      }
    } finally {
      done = true
    }
  })()

  const forEachQueued = (visit: (frame: MediaFrame) => void): void => {
    for (const frame of queue) visit(frame)
  }

  return { source, pushFrame, close, forEachQueued }
}

// ---------------------------------------------------------------------------
