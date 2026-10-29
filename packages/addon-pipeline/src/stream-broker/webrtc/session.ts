/**
 * Adaptive WebRTC session — extends the base session pattern with:
 * - RTCP Receiver Report monitoring (packet loss, jitter, RTT)
 * - Source replacement (replaceTrack for seamless quality switching)
 * - Stats emission for the AdaptiveController
 *
 * Uses werift (optional peer dependency) for server-side WebRTC.
 */

import { shouldWriteLossLine, type LossSample } from './loss-line.js'
import type { FrameSource, Logger, VideoCodec, AudioCodec } from './types.js'
import { audioCodecForPayloadType, clientOfferAudioDirection } from './talkback-bridge.js'
import { splitAnnexBToNals } from './nal-utils.js'
import { convertH264ToAnnexB, isH264IdrAccessUnit } from './h264-utils.js'
import { convertH265ToAnnexB, isH265IrapAccessUnit } from './h265-utils.js'
import { resolveMdnsCandidatesInSdp } from './mdns-resolve.js'
import { networkInterfaces } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { H265Repacketizer, type H265CodecInfo } from './h265-repacketizer.js'
import { H264Repacketizer } from './h264-repacketizer.js'
import { PacedRtpReplay, type PacedReplayTuning } from '../paced-rtp-replay.js'
import {
  BackingTally,
  type SessionOwnMemReading,
  tallyRtpCache,
} from '../stream-broker/session-mem.js'
import { HeldPacketWindow } from '../stream-broker/slab-pool.js'
import type {
  WeriftModule,
  WeriftPeerConnection,
  WeriftMediaStreamTrack,
  WeriftRtpSender,
  WeriftTransceiver,
  WeriftPcOptions,
  WeriftIceServer,
  WeriftReceiverReport,
  WeriftIceCandidate,
  WeriftDataChannel,
} from './werift-types.js'

/** A trickle ICE candidate exchanged over the signaling channel. */
export interface IceCandidatePayload {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}
import { errMsg, type EncodeProfile, type WebrtcStreamTarget } from '@camstack/types'
import { WEBRTC_FALLBACK_PROFILE } from './webrtc-fallback-profile.js'
import { SendHistory, type SendHistoryReader } from './delivery-meter.js'
import { ADAPTIVE_DELIVERY_CONFIG } from './adaptive-config.js'
import { RembWatch } from './climb-capacity.js'
import { InboundStunProbe } from './inbound-stun-probe.js'

/** A REMB unchanged this long is no estimate (`RembWatch`). */
const REMB_STALE_MS = 30_000

/** werift's NACK history depth (patched RTP_HISTORY_SIZE, `patches/werift+0.22.9.patch`). */
const SOURCE_RTP_HOLD_PACKETS = 4096
import {
  H264EgressFramer,
  type AcquireTranscodeEgress,
  type TranscodeEgressLeg,
} from './transcode-egress-leg.js'
import {
  selectAudioClock,
  AUDIO_CLOCK_PCMU,
  AUDIO_CLOCK_OPUS,
  type AudioRtpClock,
} from './audio-rtp-clock.js'

// ---------------------------------------------------------------------------
// Werift type aliases (lazy-loaded optional peer dep)
// ---------------------------------------------------------------------------

let _werift: WeriftModule | undefined

async function loadWerift(): Promise<WeriftModule> {
  if (_werift) return _werift
  // werift carries patches/werift+0.22.9.patch: under iceTransportPolicy:'relay' it emits a
  // relay-only SDP (forceTurn candidate-leak fix) so remote/NAT viewers don't nominate a dead
  // host candidate, and RTP_HISTORY_SIZE goes 128 → 4096 so a late NACK can still be served.
  // See docs/superpowers/specs/2026-05-25-werift-turn-nat-fix-design.md.
  //
  // WHERE that patch comes from is the part this comment used to get wrong. It said the copy in
  // the closure was "the patched copy". It was not: `patch-package` runs on the repo root's
  // postinstall, in a DEV tree, and the closure installs werift from npm with no patch step —
  // so the hub, the Docker agent and the Electron agent all ran it UNPATCHED from the day the
  // patch was written until 2026-09-12 (D478). It is patched there now because @camstack/server
  // ships the patch in `dist/closure-patches/` and applies it from its own postinstall, and
  // `findUnappliedClosurePatches` refuses to swap into a closure where the marker is absent.
  // Bumping werift means re-taking the patch AND moving the exact pin in patch-reach.json and
  // in all three declaring packages — `scripts/check-patches-reach-production.ts` enforces both.
  //
  // werift stays a HOST-PROVIDED, SHARED dep (pipeline + reolink + hikvision) resolved out of the
  // framework node_modules (CAMSTACK_FRAMEWORK_DIR → NODE_PATH) so the installer's closure-dedupe
  // (D343) links all three at ONE 5.3 MB copy rather than bundling three. A bare ESM `import('werift')`
  // FAILS here because ESM `import()` does NOT consult NODE_PATH — only CJS resolution does. So we
  // resolve the absolute path via `createRequire().resolve` (which honours NODE_PATH → the shared
  // framework werift) and then dynamic-import that path.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- dynamic import via Function to avoid bundler static analysis
  const importModule = (spec: string): Promise<WeriftModule> =>
    Function('m', 'return import(m)')(spec) as Promise<WeriftModule>
  // Resolution base: the shared framework node_modules (format-agnostic — avoids import.meta.url /
  // __filename, which differ between the addon's ESM/CJS builds). `require.resolve` from here finds
  // the framework's werift directly, and also honours NODE_PATH.
  const fwDir = process.env['CAMSTACK_FRAMEWORK_DIR']
  const resolveBase = fwDir
    ? join(fwDir, 'node_modules', '_werift_anchor.js')
    : join(process.cwd(), '_werift_anchor.js')
  try {
    const req = createRequire(resolveBase)
    const resolved = req.resolve('werift')
    _werift = await importModule(pathToFileURL(resolved).href)
    return _werift
  } catch {
    // Last resort: a plain ESM import for a werift co-located in the addon's own node_modules.
    try {
      _werift = await importModule('werift')
      return _werift
    } catch {
      throw new Error(
        "The 'werift' package is required for WebRTC support but is not installed. " +
          'Install it with: npm install werift',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Tailscale host-candidate detection
// ---------------------------------------------------------------------------

/**
 * Minimal shape of an `os.networkInterfaces()` entry we rely on. Kept
 * structural (not the full `os.NetworkInterfaceInfo`) so the detector
 * can be unit-tested with a hand-rolled map and no `os` mock.
 */
export interface NetworkInterfaceAddress {
  readonly address: string
  readonly family: string | number
  readonly internal: boolean
}

/** Map shape returned by `os.networkInterfaces()` (subset we consume). */
export type NetworkInterfaceMap = Readonly<
  Record<string, readonly NetworkInterfaceAddress[] | undefined>
>

/** True for an IPv4 address inside the Tailscale CGNAT range 100.64.0.0/10. */
function isTailscaleIpv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return false
  const a = Number.parseInt(parts[0] ?? '', 10)
  const b = Number.parseInt(parts[1] ?? '', 10)
  if (Number.isNaN(a) || Number.isNaN(b)) return false
  // 100.64.0.0 – 100.127.255.255
  return a === 100 && b >= 64 && b <= 127
}

/** True for an IPv6 address inside the Tailscale ULA range fd7a::/16. */
function isTailscaleIpv6(address: string): boolean {
  // Strip a zone id (`fd7a::1%utun4`) before the prefix check.
  const pct = address.indexOf('%')
  const clean = (pct === -1 ? address : address.slice(0, pct)).toLowerCase()
  return clean.startsWith('fd7a:')
}

/**
 * Enumerate the host's network interfaces and return any Tailscale
 * overlay addresses — IPv4 in 100.64.0.0/10 (CGNAT) and IPv6 in
 * fd7a::/16 (ULA). Loopback/internal interfaces are skipped.
 *
 * werift gathers ICE candidates from its own socket binds and (in
 * 0.22.9) skips point-to-point `utun` interfaces, so a Tailscale host
 * candidate is never offered by default. Feeding the detected
 * address(es) into `pcOptions.iceAdditionalHostAddresses` makes werift
 * advertise them explicitly, so a remote Tailscale viewer can form a
 * direct host↔host pair (native H.264, no relay, no re-encode).
 *
 * The address is detected dynamically — never hardcoded — so it follows
 * the host's actual Tailscale assignment.
 *
 * @param interfaces injected for testing; defaults to `os.networkInterfaces()`.
 */
export function getTailscaleHostAddresses(
  interfaces: NetworkInterfaceMap = networkInterfaces(),
): readonly string[] {
  const found = new Set<string>()
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const entry of entries) {
      if (entry.internal) continue
      const fam = entry.family
      const isV4 = fam === 'IPv4' || fam === 4
      const isV6 = fam === 'IPv6' || fam === 6
      if (isV4 && isTailscaleIpv4(entry.address)) found.add(entry.address)
      else if (isV6 && isTailscaleIpv6(entry.address)) {
        // Drop any zone id so werift sees a bare literal.
        const pct = entry.address.indexOf('%')
        found.add(pct === -1 ? entry.address : entry.address.slice(0, pct))
      }
    }
  }
  return [...found]
}

// ---------------------------------------------------------------------------
// Video transcode decision
// ---------------------------------------------------------------------------

export interface VideoTranscodeInput {
  /** Camera source video codec. */
  readonly sourceCodec: 'H264' | 'H265'
  /** Codec the browser selected in its SDP answer. */
  readonly negotiatedCodec: 'H264' | 'H265'
  /**
   * True when the H.264 source profile is non-Baseline (Main/High) so the
   * egress must be re-encoded to Constrained Baseline for iOS. Decided by
   * the broker from the camera's SPS; irrelevant for H.265 sources.
   */
  readonly transcodeToBaseline: boolean
}

/**
 * Whether the session must run ffmpeg to produce a browser-decodable
 * egress instead of forwarding the camera's native bytes:
 *
 *  - H.265 source + H.264-only browser       → transcode (pre-existing).
 *  - H.264 Main/High source + H.264 browser   → transcode to Baseline (iOS fix).
 *  - Baseline H.264, or H.265↔H.265           → passthrough (zero re-encode).
 */
export function resolveVideoTranscode(input: VideoTranscodeInput): boolean {
  const { sourceCodec, negotiatedCodec, transcodeToBaseline } = input
  if (sourceCodec === 'H265' && negotiatedCodec === 'H264') return true
  if (sourceCodec === 'H264' && negotiatedCodec === 'H264' && transcodeToBaseline) return true
  return false
}

/**
 * Read the video codec the peer settled on from a negotiated SDP — the
 * browser's answer (server-offer flow) or the server's answer to a client
 * offer (client-offer flow). Returns the first `H264`/`H265` rtpmap codec
 * (the primary payload type listed first on the `m=video` line), or
 * undefined when the SDP carries no video. Drives `negotiatedCodec`, which
 * `needsTranscode` reads to decide passthrough vs ffmpeg.
 */
export function detectNegotiatedVideoCodec(
  sdp: string,
  preferred?: 'H264' | 'H265',
): 'H264' | 'H265' | undefined {
  // The werift client-offer answer lists H.264 BEFORE H.265 (it preserves the
  // browser's offer order, which puts the 10+ H.264 PTs ahead of the two
  // H.265 PTs). The raw "first match" would then return H.264 even when both
  // codecs were negotiated and we configured H.265 as preferred. With a
  // `preferred` hint: if that codec appears anywhere in the SDP, return it;
  // otherwise fall back to the first-match behaviour. Callers thread
  // `this.sourceCodec` so an H.265 source ends up on the H.265 wire path.
  if (preferred && new RegExp(`a=rtpmap:\\d+ ${preferred}/90000`, 'i').test(sdp)) {
    return preferred
  }
  const m = sdp.match(/a=rtpmap:\d+ (H264|H265)\/90000/i)?.[1]?.toUpperCase()
  return m === 'H264' || m === 'H265' ? m : undefined
}

/** Parsed view of one SDP `a=candidate:` line — the fields a debug log needs. */
export interface CandidateSummary {
  /** ICE candidate type: `host` | `srflx` | `prflx` | `relay` | `unknown`. */
  readonly type: string
  /** `address:port` (the connection address advertised in the candidate). */
  readonly address: string
  /** `udp` | `tcp` | the raw transport token. */
  readonly protocol: string
}

/**
 * Parse a single SDP candidate line into `{ type, address, protocol }`.
 * The grammar (RFC 5245 §15.1) is:
 *   `candidate:<foundation> <component> <transport> <priority> <addr> <port> typ <type> ...`
 * possibly prefixed with `a=`. Returns an `unknown`-typed summary when the
 * line doesn't match — never throws, so it's safe in a debug log path.
 */
export function parseCandidateLine(line: string): CandidateSummary {
  const body = line.startsWith('a=') ? line.slice(2) : line
  const parts = body.trim().split(/\s+/)
  // parts: ['candidate:F', comp, transport, prio, addr, port, 'typ', type, ...]
  const protocol = (parts[2] ?? 'unknown').toLowerCase()
  const addr = parts[4]
  const port = parts[5]
  const typIdx = parts.indexOf('typ')
  const type = typIdx >= 0 ? (parts[typIdx + 1] ?? 'unknown') : 'unknown'
  const address = addr !== undefined && port !== undefined ? `${addr}:${port}` : 'unknown'
  return { type, address, protocol }
}

/**
 * Extract every `a=candidate:` line from an SDP and summarise each as
 * `{ type, address, protocol }`. Used by the advanced WebRTC debug log to
 * SHOW exactly which local candidates we put in the answer (the suspected
 * unreachable Tailscale/private host candidates on the Alexa path) and which
 * remote candidates the peer offered.
 */
export function summarizeCandidates(sdp: string): readonly CandidateSummary[] {
  return sdp
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('a=candidate:'))
    .map(parseCandidateLine)
}

/**
 * Extract the `a=fmtp:` and `a=rtpmap:` lines from an SDP — the codec
 * parameter lines carrying `profile-level-id` and the codec/clock mapping.
 * Used by the advanced WebRTC debug log to compare offered vs negotiated
 * codec profiles (the iOS/Alexa H.264 passthrough discriminator).
 */
export function extractFmtpLines(sdp: string): readonly string[] {
  return sdp
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('a=fmtp:') || l.startsWith('a=rtpmap:'))
}

// ---------------------------------------------------------------------------
// Nominated-pair classification (session diagnostics)
// ---------------------------------------------------------------------------

/**
 * Coarse network class of the SELECTED (nominated) ICE pair, derived from the
 * REMOTE candidate the browser offered. This is the broker-side complement of
 * the hub's client-IP classification (they can't share code across the
 * process boundary): the hub decides `relayOnly` from the tRPC source IP; the
 * broker reports what ICE actually nominated. A `relay` here on a session the
 * hub marked `remote` confirms the forced relay path took effect; a
 * `lan-direct`/`cgnat-vpn` confirms a direct pair won.
 */
export type IcePairClass = 'lan-direct' | 'cgnat-vpn' | 'relay' | 'public'

/**
 * Strip the trailing `:port` from a candidate `host:port` string. IPv6 hosts
 * carry embedded colons, so the port is the segment after the LAST colon.
 * Returns the input unchanged when there's no port separator.
 */
export function hostFromCandidateAddress(address: string): string {
  const idx = address.lastIndexOf(':')
  return idx > 0 ? address.slice(0, idx) : address
}

/** IPv4 / IPv6 / unknown of a bare host literal (for log meta). */
export function remoteAddressFamily(host: string): 'ipv4' | 'ipv6' | 'unknown' {
  if (host.includes(':')) return 'ipv6'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 'ipv4'
  return 'unknown'
}

/** 100.64.0.0/10 (Tailscale CGNAT v4) or fd7a:115c:a1e0::/48 (Tailscale v6). */
function isTailscaleOverlay(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower.startsWith('fd7a:115c:a1e0:')) return true
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!m) return false
  const a = Number.parseInt(m[1]!, 10)
  const b = Number.parseInt(m[2]!, 10)
  return a === 100 && b >= 64 && b <= 127
}

/** RFC1918 / loopback / link-local / generic ULA — i.e. a direct LAN host. */
function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fe80')) return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 ULA
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (!m) return false
  const a = Number.parseInt(m[1]!, 10)
  const b = Number.parseInt(m[2]!, 10)
  if (a === 10 || a === 127) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  return false
}

/**
 * Derive the coarse pair class from the nominated pair's remote candidate:
 *   - `relay`     — the ICE type is `relay` (TURN-relayed, whatever the addr).
 *   - `cgnat-vpn` — Tailscale overlay address (100.64/10 or fd7a:115c:a1e0::/48).
 *   - `lan-direct`— private / loopback / link-local (RFC1918, fc00::/7, …).
 *   - `public`    — any other (routable internet) address.
 * Pure — never throws; unparseable addresses fall through to `public`.
 */
export function derivePairClass(remoteType: string, remoteAddr: string): IcePairClass {
  if (remoteType.toLowerCase() === 'relay') return 'relay'
  const host = hostFromCandidateAddress(remoteAddr)
  if (isTailscaleOverlay(host)) return 'cgnat-vpn'
  if (isPrivateHost(host)) return 'lan-direct'
  return 'public'
}

/**
 * Pair-class-aware replay pacing. The safe 300 ms drain exists to protect
 * LOSSY remote links (the PLI-storm history) — but on a nominated lan-direct
 * pair the peer is on the same switch and the caution only delays the first
 * frame. Tighten the drain window by network class; relay/public keep the
 * safe `PACED_REPLAY_DEFAULTS` (return undefined).
 */
export function replayTuningForPairClass(
  cls: IcePairClass,
): Partial<PacedReplayTuning> | undefined {
  if (cls === 'lan-direct') return { targetDurationMs: 100, maxChunkSize: 256 }
  if (cls === 'cgnat-vpn') return { targetDurationMs: 200 }
  return undefined
}

// ---------------------------------------------------------------------------
// A/V sync diagnostic timeline math
// ---------------------------------------------------------------------------

/**
 * One track's sampled clock state at the instant the diagnostic runs: the
 * last RTP timestamp we sent on that track, that track's RTP clock rate
 * (90000 for video, 8000 for PCMU audio), and the wall-clock elapsed since
 * the session was created. Pure input — no werift, no timers.
 */
export interface AvSyncTrackSample {
  /** Last RTP timestamp sent on this track (RTP ticks at `rate`). */
  readonly rtpTs: number
  /** RTP clock rate in Hz (90000 video / 8000 PCMU audio). */
  readonly rate: number
  /** Wall-clock ms elapsed since the session was created. */
  readonly elapsedMs: number
}

/** Per-track derived timeline figures for the av-sync diagnostic. */
export interface AvSyncTrackResult {
  /** Media-time = rtpTs / rate, in seconds. */
  readonly mediaSeconds: number
  /** Skew = media-time − wall-clock-elapsed (seconds). Negative ⇒ the RTP
   *  clock has fallen behind real time. */
  readonly skewSeconds: number
}

/** Result of the av-sync timeline computation for one diagnostic tick. */
export interface AvSyncSkewResult {
  /** Video track figures, or null when video is absent / rate is invalid. */
  readonly video: AvSyncTrackResult | null
  /** Audio track figures, or null when audio is absent / rate is invalid. */
  readonly audio: AvSyncTrackResult | null
  /**
   * Inter-track skew = audio media-seconds − video media-seconds, in seconds.
   * Negative ⇒ the audio media clock lags the video media clock (the suspected
   * "audio plays ~0.5s behind video" signature). null when either track is
   * absent / has an invalid clock rate, so no comparison is possible.
   */
  readonly interTrackSkewSeconds: number | null
}

/** Convert one sampled track to media-seconds + per-track skew, or null when
 *  the clock rate is non-positive (would divide by zero). */
function deriveAvSyncTrack(sample: AvSyncTrackSample | null): AvSyncTrackResult | null {
  if (!sample || sample.rate <= 0) return null
  const mediaSeconds = sample.rtpTs / sample.rate
  const skewSeconds = mediaSeconds - sample.elapsedMs / 1000
  return { mediaSeconds, skewSeconds }
}

/**
 * Compute the per-track and inter-track timeline skew for the av-sync
 * diagnostic. Given the last sent RTP timestamp, clock rate, and wall-clock
 * elapsed for each track, derive media-time (rtpTs/rate) and how far each
 * track's media clock has drifted from real time, plus the inter-track skew
 * (audio media-seconds − video media-seconds) that quantifies the observed
 * "audio behind video" lag. A missing track or an invalid (≤0) clock rate
 * yields null for that track and null for the inter-track figure. Pure.
 */
export function computeAvSyncSkew(input: {
  readonly video: AvSyncTrackSample | null
  readonly audio: AvSyncTrackSample | null
}): AvSyncSkewResult {
  const video = deriveAvSyncTrack(input.video)
  const audio = deriveAvSyncTrack(input.audio)
  const interTrackSkewSeconds = video && audio ? audio.mediaSeconds - video.mediaSeconds : null
  return { video, audio, interTrackSkewSeconds }
}

/**
 * Input to `computeAudioSilencePadPackets` — the pure decision of how many
 * PCMU silence packets to pre-stream BEFORE the first real audio packet so the
 * audio first-send wall-clock aligns to the video first-send wall-clock. Used
 * by `AdaptiveSession.writeAudio` once per session, on the very first audio
 * frame, to close the constant startup gap seen on transcoded sources (e.g.
 * Reolink AAC → PCMU runs ~400 ms behind video → browser inflates audio jitter
 * buffer → user perceives ~1 s of audio-late lag).
 */
export interface AudioSilencePadInput {
  /** Wall-clock at the moment the first real audio frame is about to send (ms). */
  readonly nowMs: number
  /** Wall-clock at which the FIRST video RTP packet was sent (ms), or null
   *  when video hasn't sent yet — no anchor → emit nothing. */
  readonly firstVideoSendWallMs: number | null
  /** PCMU frame size in samples per packet (160 = 20 ms at 8 kHz). */
  readonly framesizeSamples: number
  /** Audio sample rate (Hz). PCMU is 8 kHz. */
  readonly rateHz: number
  /** Upper bound on the silence pre-stream duration so a runaway gap can't
   *  blast tens of seconds of silence onto the wire. */
  readonly maxPadMs: number
}

/**
 * Decide how many PCMU silence packets to pre-stream BEFORE the first real
 * audio packet so audio `firstSendWallMs` aligns to video `firstSendWallMs`.
 * Pure — no I/O, no clock reads, no side effects.
 *
 * Returns 0 when there's nothing to align to (no video anchor, gap ≤ 0,
 * sub-packet gap), and caps the count at `ceil(maxPadMs / frameMs)` to bound
 * the worst case. For positive gaps of one packet or more it returns
 * `ceil(gap / frameMs)` so the silence FULLY covers the measured gap.
 *
 * frameMs = `framesizeSamples / rateHz * 1000`. With PCMU 8 kHz / 160 samples
 * that's 20 ms — so a 401 ms gap returns 21 packets, and a 30 s gap saturates
 * at 100 packets (the 2000 ms cap / 20 ms-per-packet).
 */
export function computeAudioSilencePadPackets(input: AudioSilencePadInput): number {
  if (input.firstVideoSendWallMs === null) return 0
  if (input.framesizeSamples <= 0 || input.rateHz <= 0) return 0
  if (input.maxPadMs <= 0) return 0
  const gapMs = input.nowMs - input.firstVideoSendWallMs
  if (gapMs <= 0) return 0
  const frameMs = (input.framesizeSamples / input.rateHz) * 1000
  if (gapMs < frameMs) return 0
  const desired = Math.ceil(gapMs / frameMs)
  const cap = Math.ceil(input.maxPadMs / frameMs)
  return Math.min(desired, cap)
}

/** One scheduled silence packet on the audio pre-stream plan — what
 *  `planAudioSilencePadPackets` emits and the writer turns into a werift
 *  `RtpPacket` (PCMU payload of `framesizeSamples` × `0xFF`). */
export interface AudioSilencePadPacketPlan {
  /** RTP timestamp at the audio clock rate (already `>>> 0`-normalised). */
  readonly rtpTs: number
  /** Sequence number (`& 0xffff`-normalised), contiguous from the prior
   *  `audioSeqNum` and ending one BEFORE the real packet's seq. */
  readonly seq: number
}

/** Result of `planAudioSilencePadPackets` — the silence packets to emit + the
 *  updated `audioSeqNum` to carry forward into the real packet's seq. The plan
 *  is empty when `computeAudioSilencePadPackets` returns 0. */
export interface AudioSilencePadPlan {
  readonly packets: readonly AudioSilencePadPacketPlan[]
  /** The sequence number of the LAST silence packet emitted, OR the input
   *  `audioSeqNum` when no packets were emitted. The next real packet's seq
   *  is `(nextAudioSeqNum + 1) & 0xffff`. */
  readonly nextAudioSeqNum: number
}

/** Input to `planAudioSilencePadPackets` — same parameters as
 *  `computeAudioSilencePadPackets` plus the real first audio packet's `rtpTs`
 *  (so silence timestamps anchor contiguously to it) and the current
 *  `audioSeqNum` (so silence seqs continue from it). */
export interface AudioSilencePadPlanInput extends AudioSilencePadInput {
  /** RTP timestamp the FIRST real audio packet would carry (already
   *  `>>> 0`-normalised). Silence packets occupy `[realRtpTs − N·160, realRtpTs)`. */
  readonly realRtpTs: number
  /** Current `audioSeqNum` BEFORE any silence packet. The first silence
   *  packet's seq is `(audioSeqNum + 1) & 0xffff`. */
  readonly audioSeqNum: number
}

/**
 * Pure plan-builder for the PCMU silence pre-stream — turns
 * `computeAudioSilencePadPackets`'s count into the concrete (rtpTs, seq) list
 * the audio writer emits, plus the updated `audioSeqNum` to carry forward into
 * the real packet's seq.
 *
 * Silence timestamps run `realRtpTs − N·framesizeSamples … realRtpTs −
 * framesizeSamples`, then the real packet at `realRtpTs` — fully contiguous in
 * both ts and seq (32-bit/16-bit wrap-safe via `>>> 0` / `& 0xffff`). No I/O,
 * no clock reads, no side effects — safe to unit-test in isolation.
 */
export function planAudioSilencePadPackets(input: AudioSilencePadPlanInput): AudioSilencePadPlan {
  const packetCount = computeAudioSilencePadPackets(input)
  if (packetCount <= 0) {
    return { packets: [], nextAudioSeqNum: input.audioSeqNum }
  }
  const frameSize = input.framesizeSamples
  const firstSilenceRtpTs = (input.realRtpTs - packetCount * frameSize) >>> 0
  const packets: AudioSilencePadPacketPlan[] = []
  let seq = input.audioSeqNum
  for (let i = 0; i < packetCount; i++) {
    seq = (seq + 1) & 0xffff
    packets.push({
      rtpTs: (firstSilenceRtpTs + i * frameSize) >>> 0,
      seq,
    })
  }
  return { packets, nextAudioSeqNum: seq }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Unified ICE server entry — RTCIceServer-compatible. Covers both STUN
 * (no credentials) and TURN (username + credential). We keep a single
 * list instead of splitting stun/turn because the downstream werift API
 * takes a flat `iceServers` array and the split-only added ceremony.
 */
export interface IceServerEntry {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface AdaptiveSessionOptions {
  sessionId: string
  /**
   * Owning device id (parsed from the brokerId `${deviceId}/${camStreamId}`).
   * Threaded into every session log's `meta` so device-scoped operator
   * log filters don't drop session lifecycle lines as `dev=?`. The
   * `logger` passed in is ALSO expected to be device-tagged
   * (`withTags({ deviceId })`) so the structured tag column is populated;
   * this field mirrors it into `meta` for the diagnostic logs. `-1` for
   * the bare-deviceKey shape with no parseable id.
   */
  deviceId: number
  source: FrameSource
  intercom?: {
    onAudioReceived: (data: Buffer, format: AudioCodec) => void | Promise<void>
  }
  iceConfig?: {
    /** Flat RTCIceServer-compatible list (STUN + TURN merged). */
    iceServers?: readonly IceServerEntry[]
    portRange?: [number, number]
    additionalHostAddresses?: readonly string[]
    /**
     * Suppress IPv6 host gathering and filter IPv6 entries out of
     * `additionalHostAddresses`. Default false. Used for peers that
     * document IPv4-only ICE (Alexa RTC). See `webrtc-session.cap.ts`.
     */
    disableIpv6?: boolean
  }
  /** Callback for RTCP stats (called every ~3s). */
  onStats?: (stats: SessionStats) => void
  /**
   * WHO is watching — `alexa`, `hap`, `webrtc-browser`, … Carried only so the
   * always-on loss line can say it: "which consumer is losing packets" is the
   * first question asked of that line, and a sessionId does not answer it.
   */
  consumerKind?: string
  /**
   * Source-RTP pre-buffer accessor (broker's current GOP). On the
   * repacketizer path, the session replays this on its first forwarded
   * packet so the viewer's decoder starts immediately from a keyframe
   * instead of waiting for the camera's next IDR. Returns [] when no
   * bootstrap is available (non-RTP source, no keyframe yet, cap overflow).
   */
  rtpBootstrap?: () => readonly Buffer[]
  /** Enable verbose frame/RTP logging. */
  debug?: boolean
  /** Source video codec. Determines SDP negotiation + RTP packetization. */
  sourceCodec?: 'H264' | 'H265'
  /**
   * H.264 source whose profile is non-Baseline (Main/High) — the egress
   * must be re-encoded to Constrained Baseline so iOS (WebKit) can decode
   * it. Decided by the broker from the camera's SPS. Ignored for H.265
   * sources (their transcode is driven by codec negotiation). Default false.
   */
  transcodeToBaseline?: boolean
  /**
   * EncodeProfile this session's transcode leg ASKS the primitive for (when the
   * source codec or client capabilities require one). Resolved from
   * `WEBRTC_FALLBACK_PROFILE`, smart-adapted to the probed source resolution,
   * and reduced to the transcode-down rung when the adaptive ladder forced one.
   *
   * It is fixed for the session's lifetime — the acquired handle is IMMUTABLE
   * (D67: there is no `reconfigure`), so a ladder rung change is a
   * close-and-recreate re-offer that releases this handle and acquires another.
   */
  transcodeProfile?: EncodeProfile
  /**
   * Acquire the encoded stream for the transcode leg from
   * `streamBroker.acquireEgressTranscode`. Injected by `BrokerWebrtcServer`,
   * which binds the source cam stream and knows how to attach to the published
   * push stream the broker mints. Absent ⇒ the transcode leg cannot start and
   * says so; it never falls back to spawning an ffmpeg of its own, because a
   * second spawn site is exactly what D67 collapsed.
   */
  acquireTranscodeEgress?: AcquireTranscodeEgress
  logger: Logger
}

export interface SessionStats {
  sessionId: string
  /** Fraction of packets lost (0.0–1.0). */
  packetLoss: number
  /** Interarrival jitter in ms. */
  jitterMs: number
  /** Round-trip time in ms (from RTCP SR/RR). */
  rttMs: number
  /** Total packets received. */
  packetsReceived: number
  /** Total packets lost. */
  packetsLost: number
  /** Timestamp. */
  timestamp: number
}

export interface SessionInfo {
  sessionId: string
  state: 'new' | 'connecting' | 'connected' | 'disconnected' | 'closed'
  createdAt: number
}

// ---------------------------------------------------------------------------
// AdaptiveSession
// ---------------------------------------------------------------------------

export class AdaptiveSession {
  private readonly sessionId: string
  private readonly deviceId: number
  private source: FrameSource
  private readonly logger: Logger
  private readonly intercom: AdaptiveSessionOptions['intercom']
  private readonly iceConfig: AdaptiveSessionOptions['iceConfig']
  /** Force TURN-relay-only ICE — set for client-offer (Alexa) sessions whose
   *  peer is a cloud media server unreachable via host/srflx behind NAT. */
  private forceRelayOnly = false
  /** Latest RTCP Receiver Report from the remote viewer (jitter/loss),
   *  captured via sender.onRtcp. null until the first RR arrives. */
  private lastRr: WeriftReceiverReport | null = null
  /** Monotonic base (ms, performance.now) for send-time RTP timestamps. */
  private videoRtpClockBaseMs: number | null = null
  /** Log the camera's actual H.264 profile-level-id once per session. */
  private profileLogged = false
  private readonly onStats: AdaptiveSessionOptions['onStats']
  private readonly consumerKind: string
  /** The last loss sample actually WRITTEN, and how many ticks ago. */
  private lastLossWritten: LossSample | null = null
  private lossTicksSinceWrite = 0
  debug: boolean
  private readonly sourceCodec: 'H264' | 'H265'
  /**
   * H.264 source profile is non-Baseline (Main/High) → egress must be
   * re-encoded to Constrained Baseline for iOS. Set by the broker from the
   * camera SPS; ignored for H.265 sources. Default false.
   */
  private readonly transcodeToBaseline: boolean
  /** EncodeProfile the transcode leg asks the egress primitive for. */
  private readonly transcodeProfile: EncodeProfile
  /** Acquire the leg's encoded stream from the primitive; null = not wired. */
  private readonly acquireTranscodeEgress: AcquireTranscodeEgress | null
  /** The acquired egress, while this session holds a reference to it. */
  private transcodeEgressLeg: TranscodeEgressLeg | null = null
  /**
   * An acquire started at the ANSWER and not yet consumed by the feed.
   *
   * Read-and-null-out is the whole ownership protocol: whichever of
   * `startTranscodeFeed` and `releaseTranscodeEgress` reads a non-null value
   * owns the release, and since both read it synchronously exactly one can.
   * Without that, a session closing while its prewarm is in flight either
   * double-releases (the manager logs it as a consumer bookkeeping bug) or
   * leaks a child the primitive has no TTL to reclaim.
   */
  private transcodeEgressPending: Promise<TranscodeEgressLeg> | null = null
  /** Unsubscribe from the acquired egress's video plane. */
  private detachTranscodeEgress: (() => void) | null = null
  /** Codec actually negotiated with the browser after SDP answer. */
  private negotiatedCodec: 'H264' | 'H265' = 'H264'
  /**
   * True when the egress can't be the camera's native bytes: H.265 source
   * with an H.264-only browser, or an H.264 Main/High source that must be
   * forced to Constrained Baseline for iOS. See `resolveVideoTranscode`.
   */
  get needsTranscode(): boolean {
    return resolveVideoTranscode({
      sourceCodec: this.sourceCodec,
      negotiatedCodec: this.negotiatedCodec,
      transcodeToBaseline: this.transcodeToBaseline,
    })
  }

  /**
   * The codec off the SOURCE. Read-only, for the stream-debug overlay: an
   * operator staring at a frozen picture needs to know whether this hub is
   * re-encoding for them, and `needsTranscode` alone does not say WHAT from.
   */
  get debugSourceCodec(): 'H264' | 'H265' {
    return this.sourceCodec
  }

  /** The codec this client's SDP answer settled on. See `debugSourceCodec`. */
  get debugNegotiatedCodec(): 'H264' | 'H265' {
    return this.negotiatedCodec
  }
  private _firstKeyFrame: number | undefined
  /**
   * Last seen SPS and PPS NALs. Many cameras send SPS/PPS only once
   * at stream start (not inline with every IDR). We cache them so
   * PLI-triggered keyframe re-sends include the parameter sets the
   * decoder needs to re-initialise.
   */
  private lastSps: Buffer | null = null
  private lastPps: Buffer | null = null
  /** H.265 VPS (Video Parameter Set) — required before every IRAP for decoder init. */
  private lastVps: Buffer | null = null
  /** Whether replaceRTP has been called on the video sender to sync SSRC/seq. */
  private videoRtpSynced = false
  private readonly createdAt: number

  private state: SessionInfo['state'] = 'new'
  private pc: WeriftPeerConnection | null = null
  /**
   * When true, live broker frames should be dropped so recorded playback owns the video track.
   * NOTE: gate ENFORCEMENT lives in the broker (it checks `isLiveFeedGated` before forwarding);
   * this flag is only the state the broker reads. Wired in the broker-server task.
   */
  private liveFeedGated = false
  /**
   * Set whenever the source feeding the video track switches (live↔recorded).
   * The next outgoing packet (on either path) calls `replaceRTP` so werift
   * remaps the new source's seq/timestamp to continue seamlessly from the last
   * sent packet — without this, the recorded stream (seq/ts starting near 0) is
   * discontinuous from live and the client drops every packet (frozen frame).
   * The lifetime `videoRtpSynced` one-shot is insufficient: the live repacketizer
   * consumes it before recorded ever runs.
   */
  private rtpRebasePending = false
  /**
   * Recorded audio (PCMU) software-rebase. werift's `replaceRTP` is too brittle
   * for the audio SSRC (see writeAudio), so instead of remapping in werift we
   * offset the recorded audio timestamp in software so it continues monotonically
   * from the last sent audio packet across the live→recorded source switch.
   */
  private recordedAudioRebasePending = false
  private recordedAudioTsOffset = 0
  // Negotiated audio clock (PCMU 8 kHz vs Opus 48 kHz). Resolved lazily from the
  // werift audio sender's bound codec after SDP exchange and cached. Everything
  // that used the hard-coded PCMU 8 kHz / 160-sample constants now reads this so
  // the SAME send/rebase/av-sync logic serves both codecs. PCMU stays the
  // default until the sender codec proves Opus.
  private negotiatedAudioClock: AudioRtpClock | null = null
  // A canonical 20 ms encoded-Opus silence packet for sentry A/V-sync padding
  // (Opus has no fixed silence byte). Injected by the broker when the session
  // negotiates Opus; null → sentry padding is skipped for Opus.
  private opusSilenceFrame: Buffer | null = null
  /** Client-created control data channel (recorded-playback protocol). */
  private controlChannel: WeriftDataChannel | null = null
  private onControlMessageCb: ((raw: string) => void) | null = null
  private videoTrack: WeriftMediaStreamTrack | null = null
  private audioTrack: WeriftMediaStreamTrack | null = null
  /** Transceiver senders for direct sendRtp (more reliable than track.writeRtp) */
  private videoSender: WeriftRtpSender | null = null
  private audioSender: WeriftRtpSender | null = null
  private feedAbort: AbortController | null = null
  private closed = false
  /** Armed by `handleOffer`; counts the peer's inbound ICE checks. */
  private inboundStun: InboundStunProbe | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Notification hook invoked exactly once when `close()` finishes. The
   * adaptive server wires this up after `createSession()` so the ICE
   * disconnect/failed path (see the `iceConnectionStateChange` handler
   * that calls `this.close()` on its own) reaches `cam.sessions.delete`
   * + `scheduleCameraAutoStop`. Without this callback the server kept
   * stale entries in `cam.sessions`, the auto-stop guard (`size > 0`)
   * never fired, ffmpeg stayed up, and the RTSP client toward the
   * broker leaked forever (`rtspClients: 2` on idle brokers).
   */
  onClosed: (() => void) | null = null

  /**
   * Fires once ICE reaches connected; the server reads the nominated pair to
   * tag the broker subscription with the remote address.
   */
  onConnected: (() => void) | null = null

  /** RTP sequence number counter (must increment per packet). */
  private videoSeqNum = 0
  private audioSeqNum = 0
  /**
   * Last RTP timestamp actually written on each track (RTP ticks at the
   * track's clock rate — 90 kHz video, 8 kHz PCMU audio). Captured purely
   * for the debug-only av-sync diagnostic, which converts them to media-time
   * to expose whether the audio RTP clock runs behind video's and by how much.
   * null until the first packet is sent on that track. Diagnostic-only — no
   * send-path behaviour reads these.
   */
  private lastVideoRtpTs: number | null = null
  private lastAudioRtpTs: number | null = null
  /**
   * First RTP timestamp seen on each track, captured to make the av-sync diag
   * media-time SESSION-RELATIVE. Video is H.264 PASSTHROUGH, so its RTP ts is
   * the camera's free-running source clock (a huge arbitrary value, hours of
   * media); audio is a sample counter starting near 0. Subtracting the per-track
   * first ts puts both on a common session-zero base so interTrackSkew is
   * meaningful. null until the first packet on that track. Diagnostic-only.
   */
  private firstVideoRtpTs: number | null = null
  private firstAudioRtpTs: number | null = null
  /**
   * Wall-clock (Date.now(), ms) at the FIRST packet sent on each track. The gap
   * `firstAudioSendWallMs − firstVideoSendWallMs` is the constant startup offset
   * between the two tracks — when video forwards with ~0 latency (passthrough)
   * but audio is delayed by its decode/transcode pipeline, this gap ≈ the steady
   * perceived audio-behind-video lag. Per-track media-vs-wall skew then tells us
   * if it's a constant offset (no drift) vs a growing one. Diagnostic-only.
   */
  private firstVideoSendWallMs: number | null = null
  private firstAudioSendWallMs: number | null = null
  /**
   * Most recent AUDIO source-frame capture timestamp (the incoming frame's
   * `timestampMicros`, in µs) and the send-time wall-clock (Date.now(), ms)
   * captured at the instant we wrote that frame's RTP. Their relationship is
   * the transcode/buffer latency the av-sync diagnostic surfaces — the prime
   * suspect for a constant audio lag (esp. the AAC→PCMU transcode path).
   * Diagnostic-only; null until the first audio frame is written.
   */
  private lastAudioSrcCaptureMicros: number | null = null
  private lastAudioSendWallMs: number | null = null
  /**
   * Cached last keyframe NALs (SPS + PPS + IDR slices) in Annex-B format,
   * split and ready for RTP packetization. When the browser sends a PLI
   * (Picture Loss Indication) because it lost reference frames, we
   * immediately re-send this stored keyframe so the decoder can recover
   * without waiting for the next natural keyframe from the encoder.
   */
  private lastKeyframeNals: Buffer[] | null = null
  /** Throttle: minimum interval between PLI-triggered keyframe re-sends (ms). */
  private static readonly PLI_RESEND_COOLDOWN_MS = 500
  private lastPliResendAt = 0
  /** Minimum interval between two "PLI refused while recorded owns the
   *  track" lines; the refusals in between are counted into the next one. */
  private static readonly RECORDED_PLI_LOG_INTERVAL_MS = 10_000
  private lastRecordedPliLogAt = 0
  private recordedPliRefusedSinceLog = 0

  /**
   * Per-session H.265 RTP repacketizer (lazy-init). The H.265 path
   * forwards source RTP from the broker through this repacketizer so
   * Chrome's HEVC depacketizer sees an RTP shape it actually accepts —
   * the prior depacketize → AnnexB → re-packetize-from-scratch path
   * produced `framesAssembledFromMultiplePackets = 0` regardless of
   * codec metadata being correct. See `forwardSourceRtpVideo`.
   */
  private h265Repacketizer: H265Repacketizer | null = null
  /** RTP MTU for the repacketizer. 1100 keeps the full wire packet
   *  (payload + RTP hdr + hdr-extensions + SRTP/GCM tag + UDP + IPv4/IPv6)
   *  comfortably under the Tailscale/WireGuard overlay MTU (1280) — at the
   *  old 1180/1200 a packet is ~1266 B, which fits a plain 1500-MTU LAN but
   *  is at/over the 1280 overlay limit, so keyframe packets silently drop
   *  over Tailscale → the keyframe never reassembles → endless PLI storm
   *  (LAN-OK / remote-fail). 1100 leaves ~90 B of headroom for IPv6.
   *  Both codecs share the live `repacketizerMtu` (default = the H264 static
   *  below) so the adaptive ladder can shrink packets for either codec. */
  /**
   * Per-session H.264 RTP repacketizer (lazy-init). H.264 RTSP sources
   * forward source RTP through this — same Tailscale-safe MTU and the same
   * reason as H.265: iOS (WebKit) rejects the `writeVideoNals` synthesized
   * RTP shape for Main/High passthrough; the repacketizer preserves the
   * native RTP layout (STAP-A SPS/PPS + FU-A). See `forwardSourceRtpVideo`.
   */
  private h264Repacketizer: H264Repacketizer | null = null
  static readonly H264_REPACKETIZER_MTU = 1100
  /** Reduced RTP payload MTU engaged by the adaptive ladder at the lowest
   *  tier when loss persists — smaller packets survive lossy links better.
   *  Must stay below H264_REPACKETIZER_MTU (1100). */
  static readonly ADAPTIVE_LOW_MTU = 900
  /** Broker source-RTP pre-buffer accessor + one-shot replay guard. Replaced
   *  by `switchLiveSource` when an adaptive tier change moves the track onto
   *  another broker in place. */
  private rtpBootstrap?: () => readonly Buffer[]
  private rtpBootstrapDone = false
  /**
   * Answered-but-silent guard. The answer deliberately returns WITHOUT
   * awaiting source bring-up (bare trickle answer, background dial); the
   * failure shape that buys is a connected client staring at a black player
   * because the source never delivered. `sourceMediaSeen` flips on the FIRST
   * evidence of source media reaching this session — a source RTP packet
   * (`forwardSourceRtpVideo`, even before DTLS lets it transmit) or a video
   * NAL write (`writeVideoNals`, the AnnexB + transcode egress) — and the
   * watchdog armed at feed start warns ONCE if the budget elapses first.
   */
  private sourceMediaSeen = false
  private sourceSilenceTimer: ReturnType<typeof setTimeout> | null = null
  /** Budget between "feeding started" (post-answer, post-DTLS) and the first
   *  source media. Chosen above a healthy cold dial's worst case (~2–3 s) and
   *  below the point a viewer gives up. */
  static readonly SOURCE_SILENT_AFTER_ANSWER_MS = 5_000
  /** In-flight paced pre-buffer replay (instant-start bootstrap or PLI
   *  recovery). While active, live source-RTP packets are enqueued behind
   *  the replay tail to preserve packet order. Aborted on close/rebind. */
  private activeRtpReplay: PacedRtpReplay<Buffer> | null = null
  /** The source packets werift's NACK history may still read (`slab-pool.ts`). */
  private readonly sourceRtpHold = new HeldPacketWindow(SOURCE_RTP_HOLD_PACKETS)
  /**
   * Trickle ICE: the server's locally-gathered candidates, buffered as werift
   * surfaces them via `onIceCandidate`. The client polls `getIceCandidates`
   * and adds each. Lets `handleOffer` return the answer IMMEDIATELY (no
   * gathering wait) — candidates flow afterwards → ~0s connect.
   */
  private readonly localIceCandidates: IceCandidatePayload[] = []
  private iceGatheringComplete = false
  /** Source SSRC — captured on first source RTP, used to populate the
   *  outbound packets so werift's send pipeline doesn't reject them. */
  private sourceVideoSsrc: number | null = null

  /** Set by the broker server when a tier change needs a client re-offer.
   *  Polled via the session state. null when no renegotiation is pending. */
  pendingRenegotiation: { target: WebrtcStreamTarget; epoch: number } | null = null

  /** Sink for RTCP Receiver Report loss samples (adaptive controller). */
  private rrSink: ((s: { packetsLost: number; highestSequence: number }) => void) | null = null

  /** Register a sink for RTCP Receiver Report loss samples (adaptive controller). */
  onReceiverReport(cb: (s: { packetsLost: number; highestSequence: number }) => void): void {
    this.rrSink = cb
  }

  /** Live repacketizer MTU; read when (re)building the repacketizer so a
   *  mid-session change applies on the next rebuild. Defaults to the static
   *  H264 MTU so current behaviour is identical until an override is set. */
  private repacketizerMtu: number = AdaptiveSession.H264_REPACKETIZER_MTU

  /** Override the repacketizer MTU at runtime (adaptive ladder lowest tier). */
  setRepacketizerMtu(mtu: number): void {
    this.repacketizerMtu = mtu
  }

  /**
   * The BROKER re-dialed the source under this session — recover in place.
   *
   * The broker keeps the same object across a reconnect, so `rtpVideoCallbacks`
   * survives and packets DO resume. What does not survive is the mapping: a new
   * RTSP session means a new SSRC and a fresh random sequence/timestamp base,
   * while werift's sender offset was latched once, on the first packet of the
   * connection that just died. The client then receives a wild sequence jump,
   * drops everything, and shows the last frame forever — which is exactly the
   * "it froze, pause+play fixed it" the operator reported on 2026-08-07 after
   * toggling the camera's microphone (pause+play rebuilds the session, so it
   * re-latches).
   *
   * Three things, and each one is load-bearing:
   *  - `rtpRebasePending` — re-latch werift on the next packet, CONTINUING
   *    from the last packet actually sent. `videoRtpSynced` is deliberately
   *    left alone: its branch latches onto the source's raw sequence, which is
   *    right for the first packet ever and wrong for a mid-session switch.
   *  - `rtpBootstrapDone = false` — replay the broker's pre-buffer, which
   *    starts at the fresh connection's keyframe. Without it the viewer waits
   *    for the camera's next natural IDR, i.e. a keyframe interval of frozen
   *    picture out of a recovery.
   *  - the repacketizers — they hold the previous stream's parameter sets.
   *
   * Audio needs nothing here: `sendSourceRtpAudio` derives its own timestamps.
   */
  onSourceRestarted(reason: string): void {
    if (this.closed) return
    this.activeRtpReplay?.abort()
    this.activeRtpReplay = null
    this.h264Repacketizer = null
    this.h265Repacketizer = null
    this.sourceVideoSsrc = null
    this.rtpRebasePending = true
    this.rtpBootstrapDone = false
    // Re-arm the answered-but-silent guard against the NEW connection: a
    // re-dial that never delivers is the same failure as a cold dial that
    // never delivers, and until now only the cold one was ever named.
    this.sourceMediaSeen = false
    this.armSourceSilenceWatchdog()
    this.logger.info('source restarted — session RTP re-synced in place', {
      meta: { phase: 'session', sessionId: this.sessionId, deviceId: this.deviceId, reason },
    })
  }

  /**
   * Move the live track onto ANOTHER source of the same codec, in place — an
   * adaptive tier change on the session the viewer already has (D733).
   *
   * Everything `onSourceRestarted` does for a re-dial, because a different
   * rung IS a different RTP stream (new SSRC, new sequence/timestamp base, new
   * parameter sets), plus the two things only a different broker changes:
   *  - the bootstrap accessor now reads the NEW broker's pre-buffer, so the
   *    next forwarded packet replays its current GOP from the keyframe — the
   *    decoder switches on an IDR instead of waiting for the camera's next one;
   *  - the repacketizer is re-seeded with the new rung's SDP parameter sets,
   *    for a camera that publishes them only in SDP.
   * The MTU returns to the default a freshly built session would have: the
   * reduced MTU belongs to the lowest rung's loss recovery, not to the session.
   */
  switchLiveSource(next: {
    readonly rtpBootstrap: () => readonly Buffer[]
    readonly parameterSets: ReadonlyArray<Buffer> | null
    readonly reason: string
  }): void {
    if (this.closed) return
    this.rtpBootstrap = next.rtpBootstrap
    this.activeRtpReplay?.abort()
    this.activeRtpReplay = null
    this.h264Repacketizer = null
    this.h265Repacketizer = null
    this.sourceVideoSsrc = null
    this.rtpRebasePending = true
    this.rtpBootstrapDone = false
    this.repacketizerMtu = AdaptiveSession.H264_REPACKETIZER_MTU
    const ps = next.parameterSets ?? []
    if (ps.length > 0) {
      if (this.sourceCodec === 'H265') this.seedH265CodecInfoFromSdp(ps)
      else this.seedH264CodecInfoFromSdp(ps)
    }
    this.logger.info('live source switched in place — replaying the new source from its keyframe', {
      tags: { deviceId: this.deviceId },
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        reason: next.reason,
        seededParamSets: ps.length,
      },
    })
  }

  /** Drop the repacketizer + bootstrap/sync state so a newly bound source
   *  stream re-seeds its SPS/PPS and replays instant-start cleanly. */
  resetRepacketizer(): void {
    this.activeRtpReplay?.abort()
    this.activeRtpReplay = null
    this.h264Repacketizer = null
    this.h265Repacketizer = null
    this.videoRtpSynced = false
    this.rtpBootstrapDone = false
    this.sourceVideoSsrc = null
  }

  constructor(options: AdaptiveSessionOptions) {
    this.sessionId = options.sessionId
    this.deviceId = options.deviceId
    this.source = options.source
    this.logger = options.logger
    this.intercom = options.intercom
    this.iceConfig = options.iceConfig
    this.onStats = options.onStats
    this.consumerKind = options.consumerKind ?? 'unknown'
    this.debug = options.debug ?? false
    this.sourceCodec = options.sourceCodec ?? 'H264'
    this.transcodeToBaseline = options.transcodeToBaseline ?? false
    this.transcodeProfile = options.transcodeProfile ?? WEBRTC_FALLBACK_PROFILE
    this.acquireTranscodeEgress = options.acquireTranscodeEgress ?? null
    this.rtpBootstrap = options.rtpBootstrap
    this.createdAt = Date.now()
  }

  /**
   * Force TURN-relay-only ICE for this session. MUST be called before
   * `createOffer()` (which builds the PeerConnection via
   * `buildPcOptions`) — once the PC exists the policy is fixed.
   *
   * Set by the broker for remote (non-LAN) viewers: with the patched
   * werift, `iceTransportPolicy:'relay'` produces a genuinely relay-only
   * SDP, so a CGNAT client (which can only offer a relay candidate) gets
   * a clean relay↔relay media path instead of werift nominating a dead
   * host/hairpin-srflx pair. The Alexa/WHEP `handleOffer` path sets this
   * internally; this setter is the server-offer (browser live-view) path.
   */
  setForceRelayOnly(value: boolean): void {
    this.forceRelayOnly = value
  }

  /**
   * Wait for ICE gathering to yield a usable candidate, then return — do NOT
   * block on full gathering "complete". The direct LAN/Tailscale path only
   * needs a host candidate (present in <1s); waiting for STUN/TURN gathering
   * to finish cost many seconds of dead startup latency before the offer/
   * answer could be sent. srflx/relay keep gathering into the local SDP; we
   * just don't wait on them. A small floor (600ms) lets a fast srflx also
   * land in the SDP. Hard cap (2.5s) bounds a stalled agent — e.g. a
   * remote-only peer that genuinely needs a slow relay.
   */
  private async waitForIceGatheringFast(): Promise<void> {
    if (!this.pc) return
    if (this.pc.iceGatheringState === 'complete') return
    await new Promise<void>((resolve) => {
      let settled = false
      let poll: ReturnType<typeof setInterval> | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (poll) clearInterval(poll)
        resolve()
      }
      this.pc?.iceGatheringStateChange.subscribe((state: string) => {
        if (state === 'complete') finish()
      })
      const start = Date.now()
      poll = setInterval(() => {
        const sdp = this.pc?.localDescription?.sdp ?? ''
        if (/ typ host/.test(sdp) && Date.now() - start >= 600) finish()
      }, 100)
      setTimeout(finish, 2500)
    })
  }

  /**
   * Wait for ICE gathering to COMPLETE (not just yield a host candidate).
   * Used by the NON-TRICKLE answer path (Alexa): unlike the browser path,
   * a non-trickle peer never polls `getIceCandidates` nor trickles back, so
   * the answer SDP must already carry the server's candidates. The Alexa
   * path is `relayOnly` — there are NO host candidates, so the host-floor
   * heuristic in `waitForIceGatheringFast` would never fire; we wait on the
   * gathering-complete signal instead. werift fires `onIceCandidate(undefined)`
   * on completion (which sets `iceGatheringComplete`), and also emits
   * `iceGatheringStateChange('complete')`. A hard cap (`capMs`, default 5s)
   * bounds a stalled relay so we never block forever — the answer is still
   * returned with whatever candidates landed.
   */
  private async waitForIceGatheringComplete(capMs = 5000): Promise<void> {
    if (!this.pc) return
    if (this.iceGatheringComplete || this.pc.iceGatheringState === 'complete') return
    await new Promise<void>((resolve) => {
      let settled = false
      let poll: ReturnType<typeof setInterval> | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (poll) clearInterval(poll)
        resolve()
      }
      this.pc?.iceGatheringStateChange.subscribe((state: string) => {
        if (state === 'complete') finish()
      })
      // The `onIceCandidate(undefined)` handler set up in `handleOffer` flips
      // `iceGatheringComplete`; poll that flag so completion is observed even
      // if the state-change event is missed.
      poll = setInterval(() => {
        if (this.iceGatheringComplete || this.pc?.iceGatheringState === 'complete') finish()
      }, 100)
      setTimeout(finish, capMs)
    })
  }

  /**
   * Read the nominated (selected) ICE candidate pair off the live
   * werift connection, via the video sender's DTLS → ICE transport.
   * Returns null until ICE has nominated a pair (or if werift hasn't
   * wired the transport chain yet). Used by the media diagnostic to
   * confirm — on a remote retest — whether werift converged on a
   * relay↔relay pair.
   */
  public readNominatedPair(): {
    localType: string
    localAddr: string
    remoteType: string
    remoteAddr: string
  } | null {
    const conn = this.videoSender?.dtlsTransport?.iceTransport?.connection
    const pair = conn?.nominated
    if (!pair) return null
    const lc = pair.localCandidate
    const rc = pair.remoteCandidate
    return {
      localType: lc.type,
      localAddr: `${lc.host}:${lc.port}`,
      remoteType: rc.type,
      remoteAddr: `${rc.host}:${rc.port}`,
    }
  }

  /**
   * Log the nominated ICE candidate pair once ICE connects. werift may
   * populate `connection.nominated` a tick AFTER the "connected" event
   * fires, so retry briefly before giving up. This is the decisive
   * one-shot line for a remote retest: a `relay/…` ↔ `relay/…` pair
   * means the relay-only fix took effect; anything else (or null) on a
   * remote session is the dead-pair symptom.
   */
  private logNominatedPair(attempt = 0): void {
    if (this.closed) return
    const pair = this.readNominatedPair()
    if (!pair) {
      if (attempt < 5) {
        setTimeout(() => this.logNominatedPair(attempt + 1), 200)
        return
      }
      this.logger.info('ICE nominated pair', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          forceRelayOnly: this.forceRelayOnly,
          nominated: 'none',
        },
      })
      return
    }
    this.logger.info('ICE nominated pair', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        // `forceRelayOnly` is the hub's server-injected `relayOnly` decision
        // (from the client's IP class); `pairClass` is what ICE actually
        // nominated — see `derivePairClass`. Together they show whether the
        // policy took effect on this session.
        forceRelayOnly: this.forceRelayOnly,
        selectedLocalType: pair.localType,
        selectedLocalAddr: pair.localAddr,
        selectedRemoteType: pair.remoteType,
        selectedRemoteAddr: pair.remoteAddr,
        remoteAddressFamily: remoteAddressFamily(hostFromCandidateAddress(pair.remoteAddr)),
        pairClass: derivePairClass(pair.remoteType, pair.remoteAddr),
      },
    })
  }

  /** Build PeerConnection options including H.264 codec config. */
  private async buildPcOptions(): Promise<{ werift: WeriftModule; pcOptions: WeriftPcOptions }> {
    const werift = await loadWerift()

    // See `shared-session.ts` — werift's WeriftIceServer carries one URL
    // per entry, so array-shaped `entry.urls` expands into N entries that
    // share the same credentials.
    // ICE servers — STUN/TURN. werift's `setLocalDescription` blocks on
    // `gatherCandidates()` until every STUN/TURN server responds or hits the
    // per-server gather timeout — which the werift patch caps short (see
    // patches/werift+0.22.9.patch) so a slow/unreachable server can't stall
    // startup. We keep the full set so a mobile viewer (iOS Safari does NOT
    // offer a Tailscale candidate → no direct path) can use a TURN relay.
    const iceServers: WeriftIceServer[] = []
    for (const entry of this.iceConfig?.iceServers ?? []) {
      const urlList = Array.isArray(entry.urls) ? entry.urls : [entry.urls]
      for (const url of urlList) {
        iceServers.push({
          urls: url,
          ...(entry.username !== undefined ? { username: entry.username } : {}),
          ...(entry.credential !== undefined ? { credential: entry.credential } : {}),
        })
      }
    }
    // NOTE: we no longer add extra public STUN servers (stun.cloudflare /
    // stun.l.google). From this hub they timed out (no srflx was ever
    // produced) and — because werift only finalises the answer SDP when ICE
    // gathering COMPLETES (peerConnection.js sets the candidates on the
    // end-of-gathering signal, never incrementally) — every dead/slow server
    // delays the answer. The turn-provider cap already supplies the servers
    // we want (Cloudflare STUN+TURN); keeping the answer gated only on fast
    // servers is what lets gathering complete (and the answer return) quickly.

    const rtcpFeedback = [
      { type: 'transport-cc' },
      { type: 'ccm', parameter: 'fir' },
      { type: 'nack' },
      { type: 'nack', parameter: 'pli' },
      { type: 'goog-remb' },
    ]

    // Offer both codecs when source is H.265: browser picks H.265 if
    // supported, falls back to H.264. When source is H.264, offer only H.264.
    // After SDP negotiation, `negotiatedCodec` tells us which one won.
    const h264Codec = new werift.RTCRtpCodecParameters({
      mimeType: 'video/H264',
      clockRate: 90000,
      payloadType: 96,
      // Constrained Baseline 3.1. iOS Safari WebRTC ONLY negotiates Constrained
      // Baseline for H.264 RECEIVE — offering Main (4d0033) or High (640034)
      // makes werift's handleAnswer throw "negotiate codecs failed" because iOS
      // answers Baseline and werift can't reconcile. So Baseline is the only
      // value that negotiates with iOS; the catch is iOS then decodes ONLY
      // Baseline, so the CAMERA must emit Baseline for the picture to render
      // (set the camera/substream to a low/baseline profile). Desktop Chrome
      // decodes any profile regardless. For a Main/High camera that can't be
      // set to Baseline, the only werift-passthrough route to iOS is H.265
      // (iOS negotiates + HW-decodes HEVC natively); H.264 needs transcoding.
      parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      rtcpFeedback,
    })
    // H.265 fmtp — using the H.264-shaped fmtp string for H.265 works
    // in practice: Chrome rewrites the fmtp to proper H.265 syntax in
    // the answer regardless. Switching the offer to RFC 7798 syntax did
    // NOT change `framesDecoded=0` so the offer fmtp isn't the dominant
    // factor — keep this known-good fmtp value.
    const h265Codec = new werift.RTCRtpCodecParameters({
      mimeType: 'video/H265',
      clockRate: 90000,
      payloadType: 97,
      parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      rtcpFeedback,
    })

    const videoCodecs =
      this.sourceCodec === 'H265'
        ? [h265Codec, h264Codec] // prefer H.265, fallback H.264
        : [h264Codec] // H.264 only

    const pcOptions: WeriftPcOptions = {
      codecs: {
        video: videoCodecs,
        audio: [
          // Opus PREFERRED (48 kHz stereo, dynamic PT 111): in-process encode
          // (audio-codec cap) for the live leg and stored-Opus passthrough for
          // recorded playback — no per-fragment ffmpeg. PCMU stays as the
          // ALWAYS-offered fallback so a peer that can't do Opus still gets
          // audio; `audioClock()` branches the sender on whichever the answer
          // selected. Keep these in sync with `__tests__/opus-negotiation.spec.ts`.
          new werift.RTCRtpCodecParameters({
            mimeType: 'audio/opus',
            clockRate: 48000,
            payloadType: 111,
            channels: 2,
            parameters: 'minptime=10;useinbandfec=1',
          }),
          new werift.RTCRtpCodecParameters({
            mimeType: 'audio/PCMU',
            clockRate: 8000,
            payloadType: 0,
            channels: 1,
            parameters: '',
          }),
        ],
      },
      // RTP header extensions — KEEP `sdes:mid` only (required for BUNDLE
      // demux; without it browsers can't route incoming RTP to the right
      // m-line). DROP `transport-wide-cc` + `abs-send-time`: werift emits
      // unreliable timing values on those, which a Chrome receiver feeds into
      // its jitter buffer. On a ~zero-jitter LAN the bad timing is harmless,
      // but over a real remote path (Tailscale/4G jitter+RTT) the jitter
      // buffer discards frames as "too late" → never decodes → PLI storm,
      // even though every packet arrives (browser sends RR, sends NO NACK).
      // Dropping them lets Chrome time playout off its own receive clock.
      // (Distinct from the earlier mistaken full-disable that also removed
      // sdes:mid and regressed LAN demux.)
      headerExtensions: {
        video: [{ uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
        audio: [{ uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
      },
    }
    if (iceServers.length > 0) pcOptions.iceServers = iceServers
    if (this.forceRelayOnly) pcOptions.iceTransportPolicy = 'relay'
    // Amazon's Alexa.RTCSessionController spec: "For ICE candidates, you can
    // use either UDP or TCP but you must use IPv4." Echo's media gateway
    // silently ignores IPv6 candidates AND counts them against the
    // documented 6-second SDP processing budget — so emitting our 4 native
    // GUA + 1 Tailscale fd7a:: candidates wastes the gateway's budget and
    // can starve the host/srflx pair of validation time. With this set,
    // werift skips IPv6 host gathering entirely (see
    // node_modules/werift/lib/ice/src/iceBase.d.ts iceUseIpv6).
    if (this.iceConfig?.disableIpv6) pcOptions.iceUseIpv6 = false
    // Per-candidate-pair logging is DEBUG-only — it floods (dozens of pairs
    // per session). The nominated pair (the decisive one) is logged at info
    // unconditionally via `logNominatedPair`. Deduped to avoid spam.
    if (this.debug) {
      const loggedPairs = new Set<string>()
      pcOptions.iceFilterCandidatePair = (pair) => {
        try {
          const lc = pair.localCandidate
          const rc = pair.remoteCandidate
          const key = `${lc?.type}:${lc?.host}:${lc?.port}|${rc?.type}:${rc?.host}:${rc?.port}`
          if (!loggedPairs.has(key)) {
            loggedPairs.add(key)
            this.logger.info('ICE candidate pair', {
              meta: {
                phase: 'session',
                sessionId: this.sessionId,
                local: `${lc?.type ?? '?'}/${lc?.host ?? '?'}:${lc?.port ?? '?'}`,
                remote: `${rc?.type ?? '?'}/${rc?.host ?? '?'}:${rc?.port ?? '?'}`,
                proto: pair?.protocol?.type,
              },
            })
          }
        } catch {
          // never break ICE on a logging error
        }
        return true
      }
    }
    if (this.iceConfig?.portRange) pcOptions.icePortRange = this.iceConfig.portRange

    // Merge any explicitly-configured additional host addresses with the
    // dynamically-detected Tailscale overlay address(es). werift skips the
    // point-to-point utun interface in its own gathering, so without this
    // the broker never offers a Tailscale-reachable host candidate and a
    // remote Tailscale viewer is stuck on the (broken) relay path. With it,
    // both peers sit on the 100.x / fd7a:: overlay and a direct host↔host
    // pair wins ICE — native H.264, no re-encode. De-dupe; never clobber.
    const tailscaleHosts = getTailscaleHostAddresses()
    let mergedHostAddrs = [
      ...new Set<string>([...(this.iceConfig?.additionalHostAddresses ?? []), ...tailscaleHosts]),
    ]
    // Drop IPv6 addresses (anything containing a colon) when the caller
    // banned IPv6 — Tailscale exposes both an IPv4 100.x and an IPv6
    // fd7a:: overlay address; only the IPv4 one is useful for an
    // IPv4-only peer like Alexa.
    if (this.iceConfig?.disableIpv6) {
      mergedHostAddrs = mergedHostAddrs.filter((addr) => !addr.includes(':'))
    }
    if (mergedHostAddrs.length > 0) {
      pcOptions.iceAdditionalHostAddresses = mergedHostAddrs
      if (tailscaleHosts.length > 0) {
        this.logger.info('offering Tailscale host candidate(s)', {
          meta: {
            phase: 'session',
            sessionId: this.sessionId,
            tailscaleHosts: tailscaleHosts.join(','),
            additionalHostAddresses: mergedHostAddrs.join(','),
          },
        })
      }
    }

    return { werift, pcOptions }
  }

  /** Create offer SDP (server → client). */
  async createOffer(): Promise<{ sdp: string; type: 'offer' }> {
    const { werift, pcOptions } = await this.buildPcOptions()

    this.pc = new werift.RTCPeerConnection(pcOptions)
    this.wireControlChannel()

    // ICE state monitoring — promoted to info so the full lifecycle
    // (new → checking → connected/failed) is visible without flipping a
    // debug flag. Sessions stuck at "checking" are the canonical symptom
    // of ICE candidate mismatch; hiding the transitions behind `debug`
    // meant we couldn't tell "stuck checking" from "never even started".
    this.pc.iceConnectionStateChange.subscribe((state: string) => {
      this.logger.info('ICE state changed', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          state,
          forceRelayOnly: this.forceRelayOnly,
        },
      })
      if (state === 'connected') {
        this.state = 'connected'
        this.logNominatedPair()
        // Best-effort: the hook reads the nominated pair to tag the broker
        // subscription. A throwing hook must never break the ICE path.
        try {
          this.onConnected?.()
        } catch {
          /* swallow — the session must not care */
        }
        this.startStatsCollection()
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.state = state === 'disconnected' ? 'disconnected' : 'closed'
        void this.close()
      }
    })

    // Gathering state — surfaces whether the server is actually producing
    // ICE candidates and how long it takes. "gathering" without a
    // subsequent "complete" points at a local-network / binding issue.
    this.pc.iceGatheringStateChange.subscribe((state: string) => {
      this.logger.info('ICE gathering state changed', {
        meta: { phase: 'session', sessionId: this.sessionId, state },
      })
    })

    // Video track (sendonly) — save transceiver sender for sendRtp
    this.videoTrack = new werift.MediaStreamTrack({ kind: 'video' })
    const videoTransceiver = this.pc.addTransceiver(this.videoTrack, { direction: 'sendonly' })
    this.videoSender = videoTransceiver.sender

    // PLI/FIR listener — when the browser reports picture loss (decoder
    // can't decode P-frames because it missed the reference), re-send
    // the last cached keyframe immediately. This is the fix for the
    // "stale frame with diffs" symptom: without it, the viewer is stuck
    // on an old I-frame until the encoder naturally emits the next one.
    this.setupPliListener()

    // Audio track (sendrecv if intercom, sendonly otherwise)
    this.audioTrack = new werift.MediaStreamTrack({ kind: 'audio' })
    const audioDir = this.intercom ? 'sendrecv' : 'sendonly'
    const audioTransceiver = this.pc.addTransceiver(this.audioTrack, { direction: audioDir })
    this.audioSender = audioTransceiver.sender

    // Intercom: listen for incoming audio
    if (this.intercom) this.subscribeInboundAudio(audioTransceiver)

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)

    // Include candidates in the offer, but don't block on full gathering —
    // resolve as soon as a host candidate is present (see
    // `waitForIceGatheringFast`). Cuts startup from ~5-10s to <1s on the
    // LAN/Tailscale direct path.
    await this.waitForIceGatheringFast()

    // Use the local description which now includes gathered ICE candidates.
    // Force a=setup:actpass (let browser choose role) — werift defaults may cause DTLS issues.
    let finalSdp = this.pc.localDescription?.sdp ?? offer.sdp
    // Ensure actpass so browser can be either active or passive
    finalSdp = finalSdp.replace(/a=setup:active\r?\n/g, 'a=setup:actpass\r\n')
    this.state = 'connecting'

    // Surface the ICE candidates the server ended up advertising. Printed
    // at info level because this is the first thing to inspect when a
    // session gets stuck at "checking" — if we only see a single
    // `127.0.0.1 host` line, the browser may well be unable to pair from
    // anywhere except a same-machine loopback, and anonymised mDNS
    // candidates from Chrome won't bind.
    const gatheredCandidates = finalSdp
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('a=candidate:'))
    this.logger.info('Offer gathered ICE candidates', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        count: gatheredCandidates.length,
        candidates: gatheredCandidates,
      },
    })

    // Log SDP video codec lines for debugging
    const videoCodecLines = finalSdp
      .split('\n')
      .filter(
        (l: string) =>
          l.includes('H264') ||
          l.includes('rtpmap:96') ||
          l.includes('fmtp:96') ||
          l.includes('profile-level-id'),
      )
      .map((l: string) => l.trim())
    if (this.debug)
      this.logger.info('Offer created — video SDP', {
        meta: { phase: 'session', sessionId: this.sessionId, videoCodecLines },
      })
    return { sdp: finalSdp, type: 'offer' }
  }

  /** Handle WHEP answer: client sends SDP answer, we set remote description and start feeding. */
  async handleAnswer(answer: { sdp: string; type: 'answer' }): Promise<void> {
    if (!this.pc) throw new Error('Call createOffer() first')
    const werift = await loadWerift()

    // Surface the browser's ICE candidates BEFORE setRemoteDescription so
    // we can see them even if werift rejects one of them. Chrome's mDNS
    // privacy layer emits candidates like `abcdef.local` on loopback; a
    // Node.js ICE agent without mDNS resolution can't pair them, and the
    // session stays at "checking" forever. If the only candidates shown
    // here are `*.local`, that's the smoking gun.
    const remoteCandidates = answer.sdp
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('a=candidate:'))
    this.logger.info('Answer received ICE candidates', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        count: remoteCandidates.length,
        candidates: remoteCandidates,
      },
    })

    // Rewrite Chrome-anonymised `*.local` candidates into their resolved IPs
    // before werift sees them; werift's ICE agent doesn't run mDNS itself
    // and would otherwise stall at "checking" forever.
    const resolvedSdp = await resolveMdnsCandidatesInSdp(
      answer.sdp,
      this.logger,
      `session:${this.sessionId}`,
    )
    const desc = new werift.RTCSessionDescription(resolvedSdp, answer.type)
    await this.pc.setRemoteDescription(desc)

    // Detect which video codec the browser selected from the answer SDP.
    // If source is H.265 but browser only supports H.264, needsTranscode
    // will be true and the feed loop will spawn ffmpeg. Thread `sourceCodec`
    // as the preferred hint so an answer SDP that lists H.264 ahead of H.265
    // doesn't wrongly downgrade an H.265-capable session to H.264 (see
    // detectNegotiatedVideoCodec docstring).
    const answerVideoCodec = detectNegotiatedVideoCodec(resolvedSdp, this.sourceCodec)
    if (answerVideoCodec) {
      this.negotiatedCodec = answerVideoCodec
    }
    this.logger.info('Codec negotiated', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        source: this.sourceCodec,
        negotiated: this.negotiatedCodec,
        needsTranscode: this.needsTranscode,
      },
    })

    // Same as the client-offer flow: the child spawns while ICE and DTLS
    // handshake, not after them.
    this.prewarmTranscodeEgress()

    if (this.debug) {
      // Offered (our offer) vs negotiated (browser answer) profile-level-ids —
      // the decisive evidence for an iOS H.264 passthrough that "negotiates but
      // shows black" because the camera emits a higher profile than the
      // browser will decode. See the iOS H.264 passthrough notes.
      this.logger.info('Codec negotiation detail', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          offeredFmtp: extractFmtpLines(this.pc.localDescription?.sdp ?? ''),
          negotiatedFmtp: extractFmtpLines(resolvedSdp),
        },
      })
    }

    // Wait for DTLS to connect before feeding — sendRtp silently drops if DTLS not ready
    const dtlsTransport = this.videoSender?.dtlsTransport
    if (dtlsTransport && dtlsTransport.state !== 'connected') {
      this.logger.debug('Waiting for DTLS...', {
        meta: { phase: 'session', sessionId: this.sessionId, current: dtlsTransport.state },
      })
      const deadline = Date.now() + 10_000
      // Track DTLS state transitions while we poll — werift's typed surface
      // exposes only `state` (no onStateChange), so the wait loop doubles as
      // the transition observer. Each change is logged when debug is on.
      let prevDtls = dtlsTransport.state
      while (dtlsTransport.state !== 'connected' && Date.now() < deadline) {
        if (this.debug && dtlsTransport.state !== prevDtls) {
          this.logger.info('DTLS state', {
            meta: {
              phase: 'session',
              sessionId: this.sessionId,
              deviceId: this.deviceId,
              from: prevDtls,
              to: dtlsTransport.state,
            },
          })
          prevDtls = dtlsTransport.state
        }
        await new Promise<void>((r) => setTimeout(r, 100))
      }
      if (this.debug && dtlsTransport.state !== prevDtls) {
        this.logger.info('DTLS state', {
          meta: {
            phase: 'session',
            sessionId: this.sessionId,
            deviceId: this.deviceId,
            from: prevDtls,
            to: dtlsTransport.state,
          },
        })
      }
      this.logger.debug('DTLS wait complete', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          state: dtlsTransport.state,
          waitedSec: (10000 - (deadline - Date.now())) / 1000,
        },
      })
    }

    this.logger.debug('Answer set, feeding started', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        dtls: dtlsTransport?.state ?? 'unknown',
      },
    })
    this.startFeedingFrames()
  }

  /**
   * Relay the peer's audio to `intercom.onAudioReceived`, naming each packet's
   * codec from the payload type werift negotiated — never assumed: the offer
   * carries PCMU as well as Opus, and a PCMU frame labelled Opus is noise at
   * the camera. Packets of a codec the intercom path cannot take are dropped.
   */
  private subscribeInboundAudio(transceiver: WeriftTransceiver): void {
    const intercom = this.intercom
    if (intercom === undefined) return
    transceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((pkt) => {
        try {
          const payload = pkt.payload
          if (payload === undefined || payload.length === 0) return
          const format = audioCodecForPayloadType(transceiver.codecs ?? [], pkt.header.payloadType)
          if (format === null) return
          void intercom.onAudioReceived(payload, format)
        } catch (err) {
          this.logger.error('Intercom error', {
            meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(err) },
          })
        }
      })
    })
  }

  /**
   * Handle WHEP offer: client sends SDP offer, we create answer.
   *
   * Uses the server-creates-offer pattern internally: we create our own offer
   * with sendonly tracks, then use the client's offer codecs to build a
   * compatible answer. This avoids werift transceiver direction issues.
   */
  async handleOffer(
    clientOffer: { sdp: string; type: 'offer' },
    opts?: { nonTrickle?: boolean },
  ): Promise<{ sdp: string; type: 'answer' }> {
    // `forceRelayOnly` is set by the caller via `setForceRelayOnly` BEFORE
    // this runs (the broker does it from the cap's server-injected
    // `relayOnly` flag): true for a cloud peer like Alexa's
    // RTCSessionController (never reachable via our host/srflx behind NAT),
    // false for a LAN/Tailscale browser viewer doing client-offer
    // passthrough (a direct host pair carries full native quality, and
    // forcing relay would defeat it). No hardcoded assumption here.
    //
    // Phase brackets: production `embed:webrtc-timing` lines put the client's
    // offer→answer round trip at 2.3–7.3 s on the first connect after idle
    // while every step in here LOOKED instant — the block sat in an
    // unmeasured window. Each awaited step below is timed and the split is
    // logged on the existing 'Codec negotiated (client-offer)' line, so the
    // next slow session names its phase; if the sum is far below the
    // client-measured `signalingRttMs`, the residue is transport / event-loop
    // scheduling, not negotiation.
    const negotiateStart = Date.now()
    const { werift, pcOptions } = await this.buildPcOptions()

    // Observe-only: does the peer ever send a connectivity check? Summarised
    // on `close()` so a session that never leaves `checking` says whether the
    // Echo sent nothing or our replies did not get back.
    this.inboundStun = new InboundStunProbe((from, afterMs) => {
      this.logger.info('ICE first inbound STUN binding request from the peer', {
        tags: { deviceId: this.deviceId },
        meta: { phase: 'session', sessionId: this.sessionId, from, afterMs },
      })
    })
    pcOptions.iceFilterStunResponse = this.inboundStun.filter

    this.pc = new werift.RTCPeerConnection(pcOptions)
    const pcSetupMs = Date.now() - negotiateStart
    this.wireControlChannel()

    // ICE state at INFO (the server-offer path does the same) — for the
    // client-offer flow Alexa uses, "stuck at checking" is the canonical
    // black-view symptom and we need to see the transition without a debug flag.
    this.pc.iceConnectionStateChange.subscribe((state: string) => {
      this.logger.info('ICE state', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          state,
          forceRelayOnly: this.forceRelayOnly,
        },
      })
      if (state === 'connected') {
        this.state = 'connected'
        this.logNominatedPair()
        // Best-effort: the hook reads the nominated pair to tag the broker
        // subscription. A throwing hook must never break the ICE path.
        try {
          this.onConnected?.()
        } catch {
          /* swallow — the session must not care */
        }
        this.startStatsCollection()
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.state = state === 'disconnected' ? 'disconnected' : 'closed'
        void this.close()
      }
    })

    // Trickle ICE: buffer each local candidate werift gathers so the client
    // can poll it (`getIceCandidates`) AFTER we return the answer. werift
    // fires `undefined` when gathering completes. This is what lets the answer
    // go back immediately instead of blocking on full gathering.
    this.pc.onIceCandidate.subscribe((c: WeriftIceCandidate | undefined) => {
      if (!c || !c.candidate) {
        this.iceGatheringComplete = true
        return
      }
      this.localIceCandidates.push({
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? null,
      })
    })

    // Set the client's offer as remote description. mDNS-rewriting the
    // offer for the same reason as `handleAnswer` — Chrome sends
    // anonymised `*.local` host candidates even in the offer path when
    // issuing WHEP-style requests.
    const mdnsStart = Date.now()
    const resolvedOfferSdp = await resolveMdnsCandidatesInSdp(
      clientOffer.sdp,
      this.logger,
      `session:${this.sessionId}`,
    )
    const mdnsMs = Date.now() - mdnsStart
    // Count of REMOTE candidates the peer offered (full list only at debug).
    const offerCandidates = resolvedOfferSdp
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('a=candidate:'))
    // Always at info: the next failed session has to say which candidates the
    // peer offered (types and addresses; the ufrag/pwd are not in this list).
    this.logger.info('client offer REMOTE ICE candidates', {
      tags: { deviceId: this.deviceId },
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        count: offerCandidates.length,
        candidateTypes: summarizeCandidates(resolvedOfferSdp),
        candidates: offerCandidates,
      },
    })
    const remoteDesc = new werift.RTCSessionDescription(resolvedOfferSdp, clientOffer.type)
    const setRemoteStart = Date.now()
    await this.pc.setRemoteDescription(remoteDesc)
    const setRemoteMs = Date.now() - setRemoteStart

    // Find the transceivers werift created from the offer and attach our
    // tracks. CRITICAL: save the transceiver senders — the feed loop pushes
    // RTP through `this.videoSender`/`this.audioSender`, and without these
    // assignments every send path bails out with "writeVideoNals: no sender"
    // (the server-offer path in `start()` does the same at line ~333).
    const transceivers: WeriftTransceiver[] = this.pc.getTransceivers()
    for (const t of transceivers) {
      const kind = t.receiver?.track?.kind ?? t.kind
      if (kind === 'video' && !this.videoTrack) {
        // CRITICAL: force `sendonly`. The browser offers each transceiver
        // `recvonly` (it only wants to receive). Without this, werift answers
        // `inactive` and marks the m-line rejected (port 0), which empties
        // the `a=group:BUNDLE` line → Chrome/iOS rejects the whole answer with
        // "A BUNDLE group contains a MID='' matching no m= section" and the
        // session never connects. The server-offer path adds its transceivers
        // with `{direction:'sendonly'}` for the same reason.
        t.setDirection('sendonly')
        this.videoTrack = new werift.MediaStreamTrack({ kind: 'video' })
        await t.sender.replaceTrack(this.videoTrack)
        this.videoSender = t.sender
        // When the source is H.265, override the sender's codec with the
        // H.265 entry from the transceiver's negotiated codec list.
        // Without this, werift's createAnswer settles `sender.codec` on
        // the FIRST codec the browser offered — and browsers list 10+
        // H.264 PTs before the 2 H.265 PTs in their offer order, so the
        // sender ends up tagged H.264 even though our pcOptions preferred
        // H.265 and the answer SDP advertised both. The outgoing RTP
        // packets then carry PT=H.264 in the header but payload=H.265
        // NAL units; Chrome's depacketizer never initialises an HEVC
        // decoder, and `hasReceiverReport` stays false even as packets
        // keep flowing. Reassigning here before `createAnswer` propagates
        // the right PT through werift's sender path. Symmetrical for
        // H.264 sources is not required: pcOptions only advertises
        // H.264 in that case, so there is no PT ambiguity.
        if (this.sourceCodec === 'H265') {
          const h265 = t.codecs?.find((c) => c.mimeType === 'video/H265')
          if (h265) {
            t.sender.codec = h265
            this.logger.info('forced H.265 codec on video sender', {
              meta: {
                phase: 'session',
                sessionId: this.sessionId,
                payloadType: h265.payloadType,
              },
            })
          } else {
            this.logger.warn('sourceCodec=H265 but no H.265 codec in transceiver', {
              meta: {
                phase: 'session',
                sessionId: this.sessionId,
                availableMimeTypes: t.codecs?.map((c) => c.mimeType) ?? [],
              },
            })
          }
        }
      } else if (kind === 'audio' && !this.audioTrack) {
        // `sendonly` for every viewer, as always — EXCEPT a talk-back session
        // (D771: `intercom` set by the broker for `talkback: true`) whose peer
        // offered to send audio: that one answers `sendrecv`, and the peer's
        // microphone is relayed to the camera speaker.
        const audioDirection = clientOfferAudioDirection(
          this.intercom !== undefined,
          clientOffer.sdp,
        )
        t.setDirection(audioDirection)
        this.audioTrack = new werift.MediaStreamTrack({ kind: 'audio' })
        await t.sender.replaceTrack(this.audioTrack)
        this.audioSender = t.sender
        if (audioDirection === 'sendrecv') this.subscribeInboundAudio(t)
      }
    }

    // Fallback: if no transceivers matched (shouldn't happen with valid offer)
    if (!this.videoTrack) {
      this.logger.warn('No video transceiver found in offer, adding one', {
        meta: { phase: 'session', sessionId: this.sessionId },
      })
      this.videoTrack = new werift.MediaStreamTrack({ kind: 'video' })
      const videoTransceiver = this.pc.addTransceiver(this.videoTrack, { direction: 'sendonly' })
      this.videoSender = videoTransceiver.sender
    }
    if (!this.audioTrack) {
      this.logger.warn('No audio transceiver found in offer, adding one', {
        meta: { phase: 'session', sessionId: this.sessionId },
      })
      this.audioTrack = new werift.MediaStreamTrack({ kind: 'audio' })
      const audioTransceiver = this.pc.addTransceiver(this.audioTrack, { direction: 'sendonly' })
      this.audioSender = audioTransceiver.sender
    }

    // PLI/FIR + Receiver Report listener — the same wiring `createOffer` does.
    // This client-offer path (every browser and the native embed) never
    // attached it: a browser's PLI was dropped, so a viewer that lost a
    // reference frame stayed frozen until the camera's next natural IDR, and
    // no RTCP RR ever reached `lastRr` / the adaptive controller (48 h of
    // `webrtc loss` lines, all `hasReceiverReport=false`).
    this.setupPliListener()

    const createAnswerStart = Date.now()
    const answerDesc = await this.pc.createAnswer()
    const createAnswerMs = Date.now() - createAnswerStart
    let finalSdp: string
    if (opts?.nonTrickle === true) {
      // NON-TRICKLE ICE (Alexa): the peer never polls `getIceCandidates` nor
      // trickles back, so the answer SDP must already carry the server's
      // candidates. Await `setLocalDescription` then WAIT for ICE gathering to
      // COMPLETE, then read the populated `localDescription.sdp` (now with
      // `a=candidate` lines). The Alexa path is relayOnly (no host candidates),
      // so we wait on gathering-complete — bounded to ~5s — rather than the
      // host-floor heuristic of the trickle path; a relay/srflx candidate lands
      // in the SDP without blocking forever.
      await this.pc.setLocalDescription(answerDesc).catch((e) => {
        this.logger.warn('setLocalDescription failed (non-trickle)', {
          meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(e) },
        })
      })
      await this.waitForIceGatheringComplete()
      finalSdp = this.pc?.localDescription?.sdp ?? answerDesc.sdp
    } else {
      // TRICKLE ICE (tempo-0 model): do NOT await setLocalDescription
      // and do NOT wait for gathering. werift's setLocalDescription resolves only
      // after FULL ICE gathering completes (~10s with TURN); awaiting it — or
      // waiting for candidates to land in the answer SDP — is the entire startup
      // latency. Instead fire it, return the BARE answer (ufrag/pwd/fingerprint/
      // setup, no candidates) IMMEDIATELY, and let the server's candidates flow to
      // the client afterwards via `getIceCandidates` (buffered by the
      // onIceCandidate subscription above). The client likewise trickles its
      // candidates back via `addIceCandidate`. Connection forms in ~0s.
      void this.pc.setLocalDescription(answerDesc).catch((e) => {
        this.logger.warn('setLocalDescription failed', {
          meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(e) },
        })
      })

      // Bare answer — candidates trickle separately. `localDescription` may not
      // be populated yet (not awaited), so fall back to the createAnswer SDP.
      finalSdp = this.pc?.localDescription?.sdp ?? answerDesc.sdp
    }
    this.state = 'connecting'

    // Detect the codec werift settled on in OUR answer. In the client-offer
    // flow the browser offers its full decode caps (incl. H.264 High on
    // iOS 18) and werift echoes the matching codec — so `negotiatedCodec`
    // must be read from the answer here, exactly as `handleAnswer` reads it
    // from the browser's answer in the server-offer flow. Without this it
    // stays at the 'H264' default and `needsTranscode` mis-decides for an
    // H.265 source. Set BEFORE `startFeedingFrames()` so the feed picks the
    // right path on the first frame. Thread `sourceCodec` as the preferred
    // hint: werift orders H.264 ahead of H.265 in the answer (mirroring the
    // browser offer), so the first-match regex would wrongly choose H.264 for
    // an H.265-capable browser — see cam 99 freeze diagnosis.
    const answerVideoCodec = detectNegotiatedVideoCodec(finalSdp, this.sourceCodec)
    if (answerVideoCodec) {
      this.negotiatedCodec = answerVideoCodec
    }
    this.logger.info('Codec negotiated (client-offer)', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        source: this.sourceCodec,
        negotiated: this.negotiatedCodec,
        needsTranscode: this.needsTranscode,
        // Negotiation phase split — see the bracket comment at the top of
        // this method. `negotiateMs` is the whole in-session window; the
        // named phases are its awaited steps.
        negotiateMs: Date.now() - negotiateStart,
        pcSetupMs,
        mdnsMs,
        setRemoteMs,
        createAnswerMs,
      },
    })

    // The ffmpeg starts HERE, not after the DTLS wait below. `needsTranscode`
    // is final as of the line above; everything between here and
    // `startFeedingFrames` is handshake this child does not have to wait for.
    this.prewarmTranscodeEgress()

    if (this.debug) {
      // Offered = the client's offer (Alexa/WHEP/browser); negotiated = OUR
      // answer. Surfaces the profile-level-id the peer asked for vs the one we
      // echoed back — the iOS/Alexa passthrough discriminator.
      this.logger.info('Codec negotiation detail (client-offer)', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          offeredFmtp: extractFmtpLines(resolvedOfferSdp),
          negotiatedFmtp: extractFmtpLines(finalSdp),
        },
      })
    }

    if (this.debug) {
      // CRITICAL: SHOW the FULL set of LOCAL ICE candidates we put in the
      // ANSWER — parsed into type (host/srflx/relay) + address — not just the
      // count. On the Alexa (non-trickle, relay-only) path the answer must
      // already carry the candidates; if it carries an unreachable
      // Tailscale/private `host` candidate the peer can't pair with, this is
      // the line that proves it. Raw lines are kept too for full fidelity.
      const gatheredCandidates = finalSdp
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('a=candidate:'))
      this.logger.info('WHEP answer LOCAL ICE candidates', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          nonTrickle: opts?.nonTrickle === true,
          forceRelayOnly: this.forceRelayOnly,
          candidateCount: gatheredCandidates.length,
          candidateTypes: summarizeCandidates(finalSdp),
          candidates: gatheredCandidates,
        },
      })
    }

    // CRITICAL: do NOT feed synchronously here. In the client-offer flow the
    // answer must be RETURNED before the browser can complete DTLS — so at
    // this point the transport is never connected yet, and `sendRtp` silently
    // drops everything until DTLS comes up (see `handleAnswer`'s DTLS wait).
    // Feeding now blasts the FIRST keyframe into a dead transport; the browser
    // then has only P-frames, can't initialise its decoder, and shows black
    // (no loss/PLI on our side because nothing was actually transmitted).
    // Defer feeding until DTLS connects — the dual of the server-offer path.
    void this.startFeedingWhenDtlsReady()

    return { sdp: finalSdp, type: 'answer' }
  }

  /**
   * Wait for the video sender's DTLS transport to connect, then start
   * feeding. Used by the client-offer (`handleOffer`) path, which must
   * return its SDP answer before the browser performs the DTLS handshake —
   * so feeding can only safely begin once the transport is up. Mirrors the
   * inline DTLS wait `handleAnswer` does for the server-offer path. Bounded
   * (10s) so a never-connecting session doesn't leak the wait forever.
   */
  private async startFeedingWhenDtlsReady(): Promise<void> {
    const dtlsTransport = this.videoSender?.dtlsTransport
    if (dtlsTransport && dtlsTransport.state !== 'connected') {
      const deadline = Date.now() + 10_000
      // Observe DTLS transitions while polling (werift exposes only `state`).
      let prevDtls = dtlsTransport.state
      while (dtlsTransport.state !== 'connected' && Date.now() < deadline && !this.closed) {
        if (this.debug && dtlsTransport.state !== prevDtls) {
          this.logger.info('DTLS state (client-offer)', {
            meta: {
              phase: 'session',
              sessionId: this.sessionId,
              deviceId: this.deviceId,
              from: prevDtls,
              to: dtlsTransport.state,
            },
          })
          prevDtls = dtlsTransport.state
        }
        await new Promise<void>((r) => setTimeout(r, 100))
      }
      if (this.debug && dtlsTransport.state !== prevDtls) {
        this.logger.info('DTLS state (client-offer)', {
          meta: {
            phase: 'session',
            sessionId: this.sessionId,
            deviceId: this.deviceId,
            from: prevDtls,
            to: dtlsTransport.state,
          },
        })
      }
      this.logger.debug('client-offer DTLS wait complete', {
        meta: { phase: 'session', sessionId: this.sessionId, state: dtlsTransport.state },
      })
    }
    if (this.closed) return
    // If DTLS never reached "connected" within the deadline, sendRtp would
    // silently drop every packet and the session would sit forever as a
    // zombie — the broker keeps reading source RTP, the feed loop keeps
    // pushing frames in, the transport drops them all, and nothing ever
    // tears the session down. Observed today: a Hikvision session sat
    // for 16+ minutes burning CPU on audio frames going nowhere because
    // Echo's ICE check failed and there was no cleanup. Tear it down so
    // the broker releases the source subscription too.
    const dtlsState = this.videoSender?.dtlsTransport?.state
    if (dtlsState !== 'connected') {
      this.logger.warn('client-offer: DTLS never connected — closing session', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          dtls: dtlsState ?? 'unknown',
          forceRelayOnly: this.forceRelayOnly,
        },
      })
      void this.close()
      return
    }
    this.startFeedingFrames()
  }

  /** Add a remote (client) ICE candidate — trickle ICE client→server. */
  async addIceCandidate(candidate: unknown): Promise<void> {
    if (!this.pc) throw new Error('Call createOffer() first')
    const werift = await loadWerift()
    await this.pc.addIceCandidate(new werift.RTCIceCandidate(candidate))
  }

  /**
   * Snapshot of the server's locally-gathered ICE candidates for trickle
   * polling (server→client). The client polls this after receiving the bare
   * answer and adds each candidate; `done` flips true when gathering finishes
   * so the client can stop polling.
   */
  getIceCandidatesSnapshot(): { candidates: IceCandidatePayload[]; done: boolean } {
    return { candidates: [...this.localIceCandidates], done: this.iceGatheringComplete }
  }

  /**
   * Detach the frame source (for connection pooling).
   * The session stays alive (ICE/DTLS connected) but stops feeding frames.
   * Call replaceSource() later to reattach a camera.
   */
  detachSource(): void {
    if (this.feedAbort) {
      this.feedAbort.abort()
      this.feedAbort = null
    }
    this.logger.debug('Source detached (idle)', {
      meta: { phase: 'session', sessionId: this.sessionId },
    })
  }

  /** Whether the session has an active feed (vs idle/pooled). */
  /**
   * What this session pins outside the heap, by backing store: werift's NACK
   * history (video + audio, one tally so a slab shared by both counts once) and
   * the paced replay queue. Probe / lifecycle-line time only — it walks
   * ≤ 2 × RTP_HISTORY_SIZE slots and the replay tail, never per packet.
   */
  readMemTotals(): SessionOwnMemReading {
    const cache = new BackingTally()
    tallyRtpCache(cache, this.videoSender?.rtpCache)
    tallyRtpCache(cache, this.audioSender?.rtpCache)
    const replay = new BackingTally()
    this.activeRtpReplay?.forEachQueued((pkt) => replay.add(pkt))
    return { rtpCache: cache.totals(), rtpReplay: replay.totals() }
  }

  get isFeeding(): boolean {
    return this.feedAbort !== null && !this.feedAbort.signal.aborted
  }

  /**
   * Replace the frame source (for seamless source switching).
   * The new source will take effect at the next keyframe.
   */
  replaceSource(newSource: FrameSource): void {
    this.source = newSource
    // Abort old feed — the feeding loop will restart with new source
    if (this.feedAbort) {
      this.feedAbort.abort()
      this.feedAbort = null
    }
    this.startFeedingFrames()
  }

  getInfo(): SessionInfo {
    return { sessionId: this.sessionId, state: this.state, createdAt: this.createdAt }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.state = 'closed'
    this.logger.info('Closing', { meta: { phase: 'session', sessionId: this.sessionId } })
    if (this.inboundStun !== null) {
      this.logger.info('ICE inbound STUN summary at close', {
        tags: { deviceId: this.deviceId },
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          iceConnectionState: this.pc?.iceConnectionState ?? 'unknown',
          ...this.inboundStun.summary(),
        },
      })
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer)
      this.statsTimer = null
    }
    if (this.sourceSilenceTimer) {
      clearTimeout(this.sourceSilenceTimer)
      this.sourceSilenceTimer = null
    }
    if (this.feedAbort) {
      this.feedAbort.abort()
      this.feedAbort = null
    }
    if (this.activeRtpReplay) {
      this.activeRtpReplay.abort()
      this.activeRtpReplay = null
    }
    this.sourceRtpHold.releaseAll()
    // Before the source teardown: the primitive has no lease TTL, so this is
    // the only thing that stops a torn-down viewer leaving an ffmpeg child with
    // no holder. An acquire still in flight sees `this.closed` and releases its
    // own handle — see `startTranscodeFeed`.
    await this.releaseTranscodeEgress()
    try {
      await this.source.return(undefined)
    } catch {
      /* */
    }
    if (this.pc) {
      try {
        await this.pc.close()
      } catch {
        /* */
      }
      this.pc = null
    }
    this.controlChannel = null
    this.onControlMessageCb = null
    this.videoTrack = null
    this.audioTrack = null

    // Notify the adaptive server so it can drop us from cam.sessions and
    // trigger scheduleCameraAutoStop. Guarded null-call so the server is
    // free to not wire it (tests, pooled sessions that manage cleanup
    // themselves).
    const hook = this.onClosed
    this.onClosed = null
    try {
      hook?.()
    } catch {
      /* server-side bookkeeping shouldn't break close */
    }
  }

  // -----------------------------------------------------------------------
  // H.265 source-RTP forwarding (packet-level repacketization)
  // -----------------------------------------------------------------------

  /**
   * Seed the H.265 repacketizer's codec info with VPS/SPS/PPS harvested
   * from the camera SDP. Cameras that publish parameter sets only via
   * SDP (e.g. Reolink high-profile streams) leave the wire bare of
   * VPS/SPS/PPS — without this seed the repacketizer would never
   * generate the AP codec packet that initialises the browser decoder.
   */
  seedH265CodecInfoFromSdp(parameterSets: ReadonlyArray<Buffer>): void {
    // DO NOT gate on `this.negotiatedCodec === 'H265'` here. The broker calls
    // this at session-create time (`broker-webrtc-server.ts:719`), BEFORE
    // `handleOffer`/`handleAnswer` has had a chance to populate
    // `negotiatedCodec` from the answer SDP — at that point the field is
    // still the constructor default `'H264'` and the seed would be silently
    // dropped. Without the seed, `H265Repacketizer.codecInfo` stays empty
    // and `maybeSendAPCodecInfo` never emits the VPS+SPS+PPS aggregation
    // packet that Chrome's HEVC depacketizer needs to initialise → freeze.
    // The broker already gates the call by `sessionCodec === 'H265'`, so
    // seeding here is a no-op for non-H.265 sessions.
    if (!parameterSets.length) return
    this.ensureH265Repacketizer()
    const rep = this.h265Repacketizer!
    for (const ps of parameterSets) {
      const nalType = (ps[0]! & 0x7e) >> 1
      if (nalType === 32) rep.updateVps(Buffer.from(ps))
      else if (nalType === 33) rep.updateSps(Buffer.from(ps))
      else if (nalType === 34) rep.updatePps(Buffer.from(ps))
    }
    if (this.debug) {
      this.logger.info('seeded H.265 repacketizer codecInfo from SDP', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          psCount: parameterSets.length,
          hasVps: !!rep.codecInfo?.vps,
          hasSps: !!rep.codecInfo?.sps,
          hasPps: !!rep.codecInfo?.pps,
        },
      })
    }
  }

  private ensureH265Repacketizer(): void {
    if (this.h265Repacketizer) return
    const codecInfo: H265CodecInfo | undefined = undefined
    this.h265Repacketizer = new H265Repacketizer(console, this.repacketizerMtu, codecInfo)
  }

  /**
   * Seed the H.264 repacketizer's SPS/PPS from SDP-published parameter sets
   * so the STAP-A codec packet can precede the first IDR even when the
   * camera doesn't emit param sets in-band. H.264 sibling of
   * `seedH265CodecInfoFromSdp`. No-op on non-H.264 sessions.
   */
  seedH264CodecInfoFromSdp(parameterSets: ReadonlyArray<Buffer>): void {
    // Mirror of `seedH265CodecInfoFromSdp`: do NOT gate on negotiatedCodec.
    // The broker discriminates by `sessionCodec === 'H264'` before calling
    // (broker-webrtc-server.ts ~720), and seeding the H.264 repacketizer's
    // SPS/PPS is a no-op for non-H.264 sessions because the repacketizer is
    // only instantiated when `forwardSourceRtpVideo` runs with `codec='H264'`.
    if (!parameterSets.length) return
    this.ensureH264Repacketizer()
    const rep = this.h264Repacketizer!
    for (const ps of parameterSets) {
      const nalType = ps[0]! & 0x1f
      if (nalType === 7) rep.updateSps(Buffer.from(ps))
      else if (nalType === 8) rep.updatePps(Buffer.from(ps))
    }
    if (this.debug) {
      this.logger.info('seeded H.264 repacketizer codecInfo from SDP', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          psCount: parameterSets.length,
          hasSps: !!rep.codecInfo?.sps,
          hasPps: !!rep.codecInfo?.pps,
        },
      })
    }
  }

  private ensureH264Repacketizer(): void {
    if (this.h264Repacketizer) return
    this.h264Repacketizer = new H264Repacketizer(console, this.repacketizerMtu)
  }

  /**
   * Forward a source RTP video packet (raw on-wire bytes) through the
   * codec's repacketizer to the browser. Used by the broker's RTSP
   * direct-RTP subscription for BOTH H.265 and H.264 — bypasses the
   * AnnexB→writeVideoNals path entirely so the native RTP layout (which
   * iOS's strict depacketizer requires) is preserved.
   *
   * Drops everything until the SDP answer has been negotiated
   * (`negotiatedCodec`/`videoSender` populated).
   */
  forwardSourceRtpVideo(rtpData: Buffer): void {
    if (this.closed) return
    // Source liveness: a packet reached the session — regardless of whether
    // the guards below let it transmit yet. See the watchdog docblock.
    this.sourceMediaSeen = true
    const codec = this.negotiatedCodec
    if (codec !== 'H265' && codec !== 'H264') return
    if (!this.videoSender || !_werift) return

    // Wait for DTLS. `sendRtp` silently drops before the transport is
    // connected — and `handleOffer` returns its answer (so feeding can begin)
    // BEFORE the browser performs DTLS. Without this gate the pre-buffer
    // bootstrap fires the instant `videoSender` exists (mid-negotiation,
    // pre-ICE), gets entirely dropped, and the viewer still waits a full GOP
    // for the next live keyframe — the "instant start" never lands. Gating
    // here means the bootstrap replays on the FIRST packet AFTER DTLS, when
    // the pre-buffer = the current GOP and the packets actually transmit.
    if (this.videoSender.dtlsTransport?.state !== 'connected') return

    // Instant start: on the FIRST packet forwarded after the session is
    // ready, replay the broker's source-RTP pre-buffer (the current GOP from
    // its keyframe) so the decoder initialises immediately instead of waiting
    // for the camera's next IDR. The pre-buffer is captured in the broker's
    // dispatch BEFORE fan-out, so `rtpData` is its tail — it's included in the
    // replay and must not be forwarded again, hence the early return.
    //
    // The replay is PACED (chunked over ~250-400 ms) instead of one
    // synchronous burst: blasting 651-2273 packets (~0.8-2.7 MB measured)
    // overruns phone/4G socket buffers, and packets dropped mid-burst leave
    // the decoder without a complete GOP — nothing rendered until the NEXT
    // live IDR, a full GOP interval (2-4.5 s) later.
    if (!this.rtpBootstrapDone) {
      this.rtpBootstrapDone = true
      const bootstrap = this.rtpBootstrap?.() ?? []
      if (bootstrap.length > 0) {
        this.startPacedRtpReplay(bootstrap, codec, 'replayed source-RTP pre-buffer (instant start)')
        return
      }
      // The instant-start replay is a NO-OP: the broker's RTP ring has no
      // complete GOP (cold on-demand dial, or a source that just
      // reconnected). The viewer now silently waits a full GOP interval
      // (2–4.5 s) for the camera's next IDR — this line exists because that
      // wait was previously indistinguishable from a healthy fast start in
      // the logs, and it is the direct first-frame cost of steering a
      // session onto a cold broker.
      this.logger.warn('instant-start pre-buffer empty — viewer waits for the next source IDR', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          codec,
        },
      })
    }

    // Live packets arriving while a paced replay is draining must queue
    // BEHIND the replay tail — sending them directly would deliver them out
    // of order (mid-GOP frames ahead of the keyframe being replayed).
    if (this.activeRtpReplay?.active && this.activeRtpReplay.enqueue(rtpData)) return

    this.sendSourceRtpPacket(rtpData, codec)
  }

  /**
   * Repacketize one source RTP packet and send it on the video sender.
   * Shared by the live forward path and the pre-buffer bootstrap replay.
   * Returns true when at least one output packet was sent.
   */
  private sendSourceRtpPacket(rtpData: Buffer, codec: 'H264' | 'H265'): boolean {
    if (!this.videoSender || !_werift) return false
    const werift = _werift

    let srcPkt
    try {
      srcPkt = werift.RtpPacket.deSerialize(rtpData)
    } catch (err) {
      this.logger.warn('source RTP deserialize failed', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          codec,
          error: errMsg(err),
          len: rtpData.length,
        },
      })
      return false
    }

    // werift's NACK history keeps these packets' payloads (views of the broker's
    // packet slabs) for RTP_HISTORY_SIZE packets: hold them as long (D868).
    this.sourceRtpHold.hold(rtpData)

    if (this.sourceVideoSsrc === null) {
      this.sourceVideoSsrc = srcPkt.header.ssrc
    }

    const senderCodec = this.videoSender.codec
    const pt = senderCodec?.payloadType ?? (codec === 'H265' ? 97 : 96)

    let outPkts
    try {
      if (codec === 'H265') {
        this.ensureH265Repacketizer()
        outPkts = this.h265Repacketizer!.repacketize(srcPkt)
      } else {
        this.ensureH264Repacketizer()
        outPkts = this.h264Repacketizer!.repacketize(srcPkt)
      }
    } catch (err) {
      this.logger.warn('repacketize failed', {
        meta: { phase: 'session', sessionId: this.sessionId, codec, error: errMsg(err) },
      })
      return false
    }

    let sent = false
    for (const pkt of outPkts) {
      pkt.header.payloadType = pt
      // Sync werift's sender SSRC/seq to our outbound stream on first
      // packet — same fix the writeVideoNals path uses.
      if (!this.videoRtpSynced) {
        this.videoRtpSynced = true
        try {
          this.videoSender.replaceRTP(
            { sequenceNumber: pkt.header.sequenceNumber, timestamp: pkt.header.timestamp },
            true,
          )
        } catch (e) {
          this.logger.warn('replaceRTP failed (non-fatal)', {
            meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(e) },
          })
        }
      }
      // Rebase onto the previous source on a switch back to live (goLive).
      this.maybeRebaseRtp(pkt.header.sequenceNumber, pkt.header.timestamp)
      try {
        this.videoSender.sendRtp(pkt)
        this.videoSendHistory.record(pkt.payload.length, Date.now())
        // Record the forwarded packet's RTP timestamp (90 kHz) for the
        // av-sync diagnostic. Diagnostic-only.
        this.lastVideoRtpTs = pkt.header.timestamp >>> 0
        if (this.firstVideoRtpTs === null) {
          this.firstVideoRtpTs = this.lastVideoRtpTs
          this.firstVideoSendWallMs = Date.now()
        }
        this.rtpPacketsSent++
        sent = true
        this.logFirstVideoRtp('source-rtp', codec)
        if (this.debug && (this.rtpPacketsSent === 1 || this.rtpPacketsSent % 500 === 0)) {
          this.logger.info('source-RTP forwarded', {
            meta: {
              phase: 'session',
              sessionId: this.sessionId,
              codec,
              count: this.rtpPacketsSent,
            },
          })
        }
      } catch (err) {
        if (this.rtpPacketsSent <= 10) {
          this.logger.error('sendRtp (source forward) error', {
            meta: { phase: 'session', sessionId: this.sessionId, codec, error: errMsg(err) },
          })
        }
      }
    }
    return sent
  }

  /**
   * Start a paced replay of a source-RTP pre-buffer burst (instant-start
   * bootstrap or PLI recovery). The first chunk goes out synchronously; the
   * rest drain on a short timer cadence (see `PACED_REPLAY_DEFAULTS`:
   * 5 ms ticks, 32-128 packets/tick scaled to finish within ~300 ms).
   * An already-running replay is aborted first (goLive re-bootstrap). The
   * completion log preserves the historical message and adds pacing stats.
   */
  private startPacedRtpReplay(
    bootstrap: readonly Buffer[],
    codec: 'H264' | 'H265',
    logMessage: string,
  ): void {
    this.activeRtpReplay?.abort()
    const pair = this.readNominatedPair()
    const tuning = pair
      ? replayTuningForPairClass(derivePairClass(pair.remoteType, pair.remoteAddr))
      : undefined
    const replay = new PacedRtpReplay<Buffer>(
      (pkt) => this.sendSourceRtpPacket(pkt, codec),
      (stats) => {
        if (this.activeRtpReplay === replay) this.activeRtpReplay = null
        const meta = {
          phase: 'session',
          sessionId: this.sessionId,
          codec,
          packets: stats.packets,
          sent: stats.sent,
          chunks: stats.chunks,
          chunkSize: stats.chunkSize,
          durationMs: stats.durationMs,
          enqueuedLive: stats.enqueuedLive,
        }
        if (stats.aborted) {
          this.logger.debug(`${logMessage} — aborted mid-replay`, { meta })
        } else {
          this.logger.info(logMessage, { meta })
        }
      },
      tuning ? { tuning } : undefined,
    )
    this.activeRtpReplay = replay
    replay.start(bootstrap)
  }

  // -----------------------------------------------------------------------
  // PLI handling — resend cached keyframe on picture loss
  // -----------------------------------------------------------------------

  private setupPliListener(): void {
    const sender = this.videoSender
    if (!sender) return

    // werift exposes PLI via onPictureLossIndication (preferred) or the
    // generic onRtcpFeedback. Not all builds surface these — degrade
    // gracefully if neither is available.
    const onPli = () => this.handlePli()

    // Capture the remote receiver's RTCP Receiver Reports (jitter / loss).
    // werift parses RR but never persists it, so the media-diag fields were
    // always empty. Stash the latest RR matching our ssrc for diagnostics —
    // jitter (90kHz units) and fractionLost tell us whether a remote viewer
    // is seeing network jitter (timing) vs actual packet loss.
    if (sender.onRtcp) {
      sender.onRtcp.subscribe((rtcp) => {
        const reports = rtcp?.reports
        if (!reports || reports.length === 0) return
        const mine = reports.find((r) => r.ssrc === sender.ssrc) ?? reports[0]
        if (mine) this.lastRr = mine
        if (this.rrSink && mine) {
          this.rrSink({
            packetsLost: mine.packetsLost ?? mine.cumulativeLost ?? 0,
            highestSequence: mine.highestSequence ?? 0,
          })
        }
      })
    }

    if (sender.onPictureLossIndication) {
      sender.onPictureLossIndication.subscribe(onPli)
      this.logger.debug('PLI listener attached (onPictureLossIndication)', {
        meta: { phase: 'session', sessionId: this.sessionId },
      })
    } else if (sender.onRtcpFeedback) {
      sender.onRtcpFeedback.subscribe((fb) => {
        if (fb.type === 'nack' && fb.parameter === 'pli') onPli()
        if (fb.type === 'ccm' && fb.parameter === 'fir') onPli()
      })
      this.logger.debug('PLI listener attached (onRtcpFeedback)', {
        meta: { phase: 'session', sessionId: this.sessionId },
      })
    } else {
      this.logger.debug(
        'PLI listener not available — werift version may not expose RTCP feedback',
        {
          meta: { phase: 'session', sessionId: this.sessionId },
        },
      )
    }
  }

  private logRecordedPliRefusal(now: number): void {
    this.recordedPliRefusedSinceLog += 1
    if (now - this.lastRecordedPliLogAt < AdaptiveSession.RECORDED_PLI_LOG_INTERVAL_MS) return
    this.lastRecordedPliLogAt = now
    const refused = this.recordedPliRefusedSinceLog
    this.recordedPliRefusedSinceLog = 0
    this.logger.info(
      'PLI during recorded playback — live pre-buffer NOT replayed (recorded owns the track)',
      {
        tags: { deviceId: this.deviceId },
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          refused,
          windowMs: AdaptiveSession.RECORDED_PLI_LOG_INTERVAL_MS,
        },
      },
    )
  }

  private handlePli(): void {
    const now = Date.now()
    if (now - this.lastPliResendAt < AdaptiveSession.PLI_RESEND_COOLDOWN_MS) return
    this.lastPliResendAt = now

    // Recorded playback owns the track (D42). Both recoveries below replay
    // LIVE media — the broker's source-RTP pre-buffer (the camera's current
    // GOP) or the live feed's cached keyframe — and neither passes the
    // forwarder's live gate, so answering a PLI here
    // put the live rendition on the wire in the middle of a recording: on
    // 2026-10-07 camera 103's recorded `low` picture (106 wide) was repeatedly
    // replaced by a GOP of the live `main` (3840 wide), 369 times in 24 h, all
    // during recorded playback. The recorded feeder's next keyframe is the
    // recovery; the refusal is logged, never silent.
    if (this.liveFeedGated) {
      this.logRecordedPliRefusal(now)
      return
    }

    // A paced pre-buffer replay is already delivering the GOP the browser
    // is asking for — starting a second one would interleave two replays
    // out of order. Let the in-flight one finish; if it was lossy the
    // browser re-PLIs after the cooldown and we replay again below.
    if (this.activeRtpReplay?.active) {
      this.logger.debug('PLI received — paced pre-buffer replay already in flight', {
        meta: { phase: 'session', sessionId: this.sessionId },
      })
      return
    }

    // Source-RTP path (RTSP H.264 / H.265 — current cam 127, cam 99 H.265):
    // replay the broker's source-RTP pre-buffer. The ring buffer contains
    // the current GOP starting from the most recent keyframe — exactly
    // what the browser is asking for after losing reference frames. This
    // is the only recovery path that doesn't require an out-of-band
    // keyframe-request to the camera; the keyframe is already in our
    // hands, we just need to retransmit. Same mechanism as the first-
    // packet instant-start replay, but on-demand for PLI recovery.
    // Without this, an on-Wi-Fi camera that loses a packet from the
    // initial IDR (or mid-GOP) freezes the viewer with no recovery —
    // the browser sends PLI, our cached-keyframe path bails because
    // `lastKeyframeNals` is only populated by `writeVideoNals` (the
    // AnnexB path), not by `forwardSourceRtpVideo` (the source-RTP path).
    if (this.rtpBootstrap) {
      const codec = this.negotiatedCodec
      if (codec === 'H264' || codec === 'H265') {
        const bootstrap = this.rtpBootstrap()
        if (bootstrap.length > 0) {
          // Same paced replay as the instant-start bootstrap — a PLI means
          // the browser ALREADY lost packets, so re-blasting the GOP in one
          // burst would likely re-trigger the very loss it recovers from.
          this.startPacedRtpReplay(
            bootstrap,
            codec,
            'PLI received — replayed source-RTP pre-buffer',
          )
          return
        }
      }
      // Falls through to the AnnexB cached-keyframe path when the
      // pre-buffer is empty (broker just rebuilt the reader, hasn't seen
      // a keyframe yet) AND the AnnexB feed has populated lastKeyframeNals.
    }

    // AnnexB push-mode path (Reolink Baichuan, push-rtp): re-send
    // the last cached keyframe via writeVideoNals. Same packetization the
    // feed loop uses for keyframes (single-NAL packets for VPS/SPS/PPS,
    // FU fragmentation for IDR slice).
    if (!this.lastKeyframeNals || this.lastKeyframeNals.length === 0) {
      this.logger.debug('PLI received but no cached keyframe yet', {
        meta: { phase: 'session', sessionId: this.sessionId },
      })
      return
    }

    this.logger.info('PLI received — re-sending cached keyframe', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        nals: this.lastKeyframeNals.length,
        totalBytes: this.lastKeyframeNals.reduce((s, n) => s + n.length, 0),
      },
    })
    // Stamp with a CURRENT send-time RTP timestamp (not the cached
    // keyframe's old ts): a resend carrying a past timestamp arrives
    // out-of-order and the receiver discards it, which would perpetuate
    // the PLI storm we're trying to break.
    this.writeVideoNals(this.lastKeyframeNals, this.sendRtpTimestamp(), this.negotiatedCodec)
  }

  // -----------------------------------------------------------------------
  // Frame feeding
  // -----------------------------------------------------------------------

  /**
   * Arm the answered-but-silent watchdog: if no source media has reached
   * this session `SOURCE_SILENT_AFTER_ANSWER_MS` after feeding started, one
   * named WARN fires. Idempotent; disarmed by `close()`. Public so the guard
   * is testable without standing up werift.
   */
  armSourceSilenceWatchdog(): void {
    if (this.sourceSilenceTimer || this.closed) return
    this.sourceSilenceTimer = setTimeout(() => {
      this.sourceSilenceTimer = null
      if (this.closed || this.sourceMediaSeen) return
      this.logger.warn(
        'answered but NO source media reached the session — source dial stalled or camera silent',
        {
          meta: {
            phase: 'session',
            sessionId: this.sessionId,
            deviceId: this.deviceId,
            budgetMs: AdaptiveSession.SOURCE_SILENT_AFTER_ANSWER_MS,
            needsTranscode: this.needsTranscode,
          },
        },
      )
    }, AdaptiveSession.SOURCE_SILENT_AFTER_ANSWER_MS)
    this.sourceSilenceTimer.unref?.()
  }

  /**
   * Start the feed loop for whichever path this session negotiated. Public for
   * the same reason `armSourceSilenceWatchdog` is: the transcode leg's acquire
   * and release contract is testable without standing up werift.
   */
  startFeedingFrames(): void {
    this.feedAbort = new AbortController()
    const { signal } = this.feedAbort

    this.logger.info('Feed loop starting', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        dtls: this.videoSender?.dtlsTransport?.state ?? 'unknown',
        needsTranscode: this.needsTranscode,
      },
    })
    // A fast answer followed by silence must surface as a named failure,
    // not a black player.
    this.armSourceSilenceWatchdog()

    if (this.needsTranscode) {
      this.startTranscodeFeed(signal)
    } else {
      this.startDirectFeed(signal)
    }
  }

  /**
   * Direct feed — source codec matches negotiated codec. Zero transcode.
   * H.264 and H.265 both go through this path with codec-specific RTP
   * packetization handled by writeVideoNals.
   */
  private startDirectFeed(signal: AbortSignal): void {
    void (async () => {
      let gotKeyframe = false
      // Sample-count accumulator for PCMU/PCMA audio RTP timestamps:
      // 1 byte = 1 sample @ codec clock (PCMU 8 kHz mono). The counter
      // advances exactly with the audio data we've forwarded, so RTP
      // timestamps stay clock-coherent with the codec even when the
      // source delivers below real-time. (A µs-derived alternative was
      // tried but the broker doesn't seem to populate
      // `frame.timestampMicros` with a usable source-clock value for
      // audio — debug log gated on `this.debug` below dumps the raw
      // value so we can confirm what the broker is passing through.)
      let audioTimestampBase: number | null = null
      let frameCount = 0

      try {
        for await (const mediaFrame of this.source) {
          if (signal.aborted || this.closed) break
          frameCount++
          if (frameCount <= 5 || frameCount % 100 === 0) {
            this.logger.debug('Frame received', {
              meta: {
                phase: 'session',
                sessionId: this.sessionId,
                frameCount,
                type: mediaFrame.type,
                size: mediaFrame.frame.data.length,
                isKeyframe:
                  mediaFrame.type === 'video' && 'isKeyframe' in mediaFrame.frame
                    ? mediaFrame.frame.isKeyframe
                    : undefined,
              },
            })
          }

          if (mediaFrame.type === 'video') {
            const frame = mediaFrame.frame
            const annexB =
              frame.codec === 'H264'
                ? convertH264ToAnnexB(frame.data)
                : convertH265ToAnnexB(frame.data)

            // Cache parameter sets BEFORE the keyframe gate. Cameras
            // that ship VPS/SPS/PPS in their own non-keyframe access
            // unit (or via the broker's synthetic SDP-replay packet —
            // see StreamBroker.emitSdpParamSetsTo) deliver them in a
            // frame whose `isKeyframe` is false. The previous code
            // skipped such frames entirely with `continue`, so
            // `lastVps/Sps/Pps` were never populated and HEVC decoding
            // failed on the first IDR.
            const __nalsForCaching = splitAnnexBToNals(annexB)
            if (frame.codec === 'H265') {
              for (const n of __nalsForCaching) {
                const nalType = (n[0]! & 0x7e) >> 1
                if (nalType === 32) this.lastVps = Buffer.from(n)
                if (nalType === 33) this.lastSps = Buffer.from(n)
                if (nalType === 34) this.lastPps = Buffer.from(n)
              }
            } else {
              for (const n of __nalsForCaching) {
                const nalType = n[0]! & 0x1f
                if (nalType === 7) this.lastSps = Buffer.from(n)
                if (nalType === 8) this.lastPps = Buffer.from(n)
              }
            }

            if (!gotKeyframe) {
              const isKey =
                frame.codec === 'H264' ? isH264IdrAccessUnit(annexB) : isH265IrapAccessUnit(annexB)
              if (!isKey) {
                if (frameCount <= 3) {
                  this.logger.debug('Skipping frame (waiting for keyframe)', {
                    meta: {
                      phase: 'session',
                      sessionId: this.sessionId,
                      frameCount,
                      size: annexB.length,
                    },
                  })
                }
                continue
              }
              gotKeyframe = true
              const iceState = this.pc?.iceConnectionState ?? 'unknown'
              this.logger.info('First keyframe', {
                meta: {
                  phase: 'session',
                  sessionId: this.sessionId,
                  frameCount,
                  size: annexB.length,
                  ice: iceState,
                },
              })
            }

            // Send-time RTP timestamp (see sendRtpTimestamp): capture-time
            // stamps caused ~80ms receiver jitter over Tailscale → PLI storm.
            const rtpTs = this.sendRtpTimestamp()

            // Filter out AUD and SEI — not needed in RTP.
            // H.264: AUD=9, SEI=6 (mask 0x1f). H.265: AUD=35, SEI_PREFIX=39, SEI_SUFFIX=40 (mask (b>>1)&0x3f).
            const isH265 = frame.codec === 'H265'
            const allNals = splitAnnexBToNals(annexB)
            const nals = allNals.filter((n: Buffer) => {
              if (isH265) {
                const t = (n[0]! & 0x7e) >> 1
                return t !== 35 && t !== 39 && t !== 40 // AUD, SEI_PREFIX, SEI_SUFFIX
              }
              const t = n[0]! & 0x1f
              return t !== 9 && t !== 6 // AUD, SEI
            })

            // Debug: dump NAL info for first few frames (only when debug enabled)
            if (
              this.debug &&
              (frameCount <= 5 || (gotKeyframe && frameCount <= (this._firstKeyFrame ?? 0) + 2))
            ) {
              const nalInfo = allNals
                .map((n: Buffer) => {
                  if (isH265) {
                    const t = (n[0]! & 0x7e) >> 1
                    const names: Record<number, string> = {
                      0: 'TRAIL_N',
                      1: 'TRAIL_R',
                      19: 'IDR_W_RADL',
                      20: 'IDR_N_LP',
                      21: 'CRA',
                      32: 'VPS',
                      33: 'SPS',
                      34: 'PPS',
                      35: 'AUD',
                      39: 'SEI_P',
                      40: 'SEI_S',
                    }
                    return `${names[t] ?? `t${t}`}(${n.length})`
                  }
                  const t = n[0]! & 0x1f
                  const names: Record<number, string> = {
                    1: 'SLICE',
                    5: 'IDR',
                    6: 'SEI',
                    7: 'SPS',
                    8: 'PPS',
                    9: 'AUD',
                  }
                  return `${names[t] ?? `t${t}`}(${n.length})`
                })
                .join(' + ')
              this.logger.info('Frame NAL breakdown', {
                meta: {
                  phase: 'session',
                  sessionId: this.sessionId,
                  frameCount,
                  codec: frame.codec,
                  nals: nalInfo,
                  sending: nals.length,
                },
              })
              if (gotKeyframe && !this._firstKeyFrame) this._firstKeyFrame = frameCount
            }

            if (nals.length > 0 && this.videoTrack) {
              // For H.265 IRAP access units, send VPS+SPS+PPS as a
              // single Aggregation Packet (RFC 7798 §4.4.2) BEFORE the
              // IDR fragments. Chrome's HEVC
              // depacketizer relies on this shape to initialise
              // VideoToolbox properly. Sending the param sets as 3
              // separate single-NAL packets caused `framesDecoded` to
              // stay at 0 with PLI flooding even with valid SDP fmtp.
              if (isH265) {
                // ── Param set tracking + AP+IDR for keyframes ──
                for (const n of nals) {
                  const nalType = (n[0]! & 0x7e) >> 1
                  if (nalType === 32) this.lastVps = Buffer.from(n)
                  if (nalType === 33) this.lastSps = Buffer.from(n)
                  if (nalType === 34) this.lastPps = Buffer.from(n)
                }

                if (isH265IrapAccessUnit(annexB)) {
                  // Resolve param sets — prefer inline, fall back to cache.
                  const inlineVps = nals.find((n) => (n[0]! & 0x7e) >> 1 === 32) ?? this.lastVps
                  const inlineSps = nals.find((n) => (n[0]! & 0x7e) >> 1 === 33) ?? this.lastSps
                  const inlinePps = nals.find((n) => (n[0]! & 0x7e) >> 1 === 34) ?? this.lastPps
                  // VCL NALs (IRAP slices) — everything that isn't a param set.
                  const vclNals = nals.filter((n) => {
                    const t = (n[0]! & 0x7e) >> 1
                    return t !== 32 && t !== 33 && t !== 34
                  })
                  if (inlineVps && inlineSps && inlinePps && vclNals.length > 0) {
                    // Send VPS+SPS+PPS+IDR all via writeVideoNals — same
                    // shape as the H.264 path that Chrome decodes
                    // correctly. The previous Aggregation Packet (AP,
                    // RFC 7798 §4.4.2) bundling produced a packet shape
                    // that Chrome's HEVC depacketizer never accepted —
                    // `framesAssembledFromMultiplePackets` stayed 0 and
                    // `framesDecoded` stayed 0 even with valid SDP and
                    // fmtp. Single-NAL packets for the param sets
                    // followed by FU-fragmented IDR is what the H.264
                    // path does for SPS/PPS/IDR and it works.
                    const auNals = [inlineVps, inlineSps, inlinePps, ...vclNals]
                    this.writeVideoNals(auNals, rtpTs, frame.codec)
                    this.lastKeyframeNals = auNals.map((n) => Buffer.from(n))
                  } else {
                    // Missing param sets — fall back to "send as-is".
                    this.writeVideoNals(nals, rtpTs, frame.codec)
                  }
                } else {
                  // Non-IRAP frames (TRAIL_R / RADL_R / etc.) — send as-is.
                  this.writeVideoNals(nals, rtpTs, frame.codec)
                }
              } else {
                // ── H.264 param set tracking ──
                let auNals: Buffer[] = nals
                for (const n of nals) {
                  const nalType = n[0]! & 0x1f
                  if (nalType === 7) {
                    this.lastSps = Buffer.from(n)
                    if (!this.profileLogged && n.length >= 4) {
                      this.profileLogged = true
                      const plid = `${n[1]!.toString(16).padStart(2, '0')}${n[2]!.toString(16).padStart(2, '0')}${n[3]!.toString(16).padStart(2, '0')}`
                      this.logger.info('camera H.264 SPS profile-level-id', {
                        meta: {
                          phase: 'session',
                          sessionId: this.sessionId,
                          deviceId: this.deviceId,
                          actualProfileLevelId: plid,
                          advertisedProfileLevelId: '42e01f',
                          match: plid === '42e01f',
                          profileIdc: n[1],
                          levelIdc: n[3],
                        },
                      })
                    }
                  }
                  if (nalType === 8) this.lastPps = Buffer.from(n)
                }
                if (isH264IdrAccessUnit(annexB)) {
                  const hasInlineSps = nals.some((n: Buffer) => (n[0]! & 0x1f) === 7)
                  if (!hasInlineSps && this.lastSps && this.lastPps) {
                    auNals = [this.lastSps, this.lastPps, ...nals]
                  }
                  this.lastKeyframeNals = auNals.map((n) => Buffer.from(n))
                }
                this.writeVideoNals(auNals, rtpTs, frame.codec)
              }
              if (this.debug && frameCount % 250 === 0) {
                this.logger.info('Feed progress', {
                  meta: {
                    phase: 'session',
                    sessionId: this.sessionId,
                    frames: frameCount,
                    rtpPackets: this.rtpPacketsSent,
                    ice: this.pc?.iceConnectionState ?? '?',
                    conn: this.pc?.connectionState ?? '?',
                  },
                })
              }
            }
          } else if (mediaFrame.type === 'audio') {
            const frame = mediaFrame.frame
            if (!this.audioSender) continue

            // Derive RTP timestamp from the SOURCE frame's capture
            // time (now in honest µs after the broker-side packet.pts
            // ms→µs conversion in broker-webrtc-server.ts). Lets
            // werift's RTCP Sender Report carry an honest NTP↔RTP
            // mapping anchored on the source clock — the browser can
            // apply its internal drift compensation instead of sync-
            // gating the MediaStream into a freeze. Clock is the
            // negotiated audio codec's rate (PCMU 8 kHz / Opus 48 kHz):
            // `µs × rate / 1e6`, u32-wrapped.
            const rtpTs =
              Math.floor((frame.timestampMicros * this.audioClock().rateHz) / 1_000_000) >>> 0
            // `audioTimestampBase` reference kept satisfied for tsc —
            // see the loop-local declaration above; not used now.
            void audioTimestampBase

            // Audio pipeline latency: stash the SOURCE frame's capture
            // timestamp (`timestampMicros`) and the send-time wall-clock at the
            // instant we write it. The av-sync diagnostic compares them to
            // surface transcode/buffer latency — the prime suspect for the
            // constant ~0.5s audio lag (esp. the AAC→PCMU transcode path).
            // Diagnostic-only; no effect on the RTP we send.
            this.recordAudioSourceLatency(frame.timestampMicros)

            this.writeAudio(frame.data, rtpTs, frame.codec)
          }
        }
      } catch (err) {
        if (!signal.aborted && !this.closed) {
          this.logger.error('Feed error', {
            meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(err) },
          })
        }
      } finally {
        if (!this.closed) {
          if (this.debug)
            this.logger.info('Feed ended', {
              meta: { phase: 'session', sessionId: this.sessionId },
            })
          void this.close()
        }
      }
    })()
  }

  /**
   * Transcode feed — the session ACQUIRES its encoded stream, it does not spawn
   * one.
   *
   * Needed when the browser cannot decode the source: H.265 source on an
   * H.264-only browser, or a Main/High H.264 source on iOS (which decodes
   * Constrained Baseline only). What changed with D67 is WHO runs the ffmpeg:
   * `streamBroker.acquireEgressTranscode` does, so this leg inherits the
   * manager's copy-vs-encode decision, its hardware→software retry, its
   * refcounted dedup on an exact sharing key, and a `decodeHwAccel` that
   * reports what the child ACTUALLY ran with rather than what was asked for.
   * The old in-session builder + spawn + stdout re-framer are gone; see
   * `transcode-egress-leg.ts` for what the request has to keep saying.
   *
   * The acquire BLOCKS until the child's first packet (the manager's
   * first-packet deadline plus one software retry), so a failure surfaces here
   * as a named error instead of as a black player.
   *
   * VIDEO comes from the acquired egress; AUDIO still comes from `this.source`,
   * unchanged — the request asks for `audio: 'passthrough'` precisely so the
   * child does not encode a plane this session never reads.
   */
  /**
   * Start the egress acquire NOW, in parallel with ICE and DTLS.
   *
   * `needsTranscode` is final the moment the answer's codec is known — the
   * "Codec negotiated" line already prints it — but the acquire used to happen
   * inside `startFeedingFrames`, which runs only after the DTLS wait. On camera
   * 101 that put the leg ~2 s after session creation and the first packet ~5 s
   * after that, against a browser watchdog that re-offers every ~5 s: the viewer
   * was always gone before the media existed, and the next session paid for a
   * cold child again. Three minutes of that on 2026-08-07 22:17–22:20.
   *
   * Only the ffmpeg moves. The ATTACH stays behind DTLS, because `sendRtp`
   * silently drops before the transport is connected.
   *
   * Idempotent and safe to call from any negotiation path; a session that needs
   * no transcode does nothing. Public for the same reason
   * {@link armSourceSilenceWatchdog} is — the acquire/release contract is
   * testable without standing up werift.
   */
  prewarmTranscodeEgress(): void {
    if (this.closed) return
    if (!this.needsTranscode) return
    if (this.transcodeEgressPending !== null || this.transcodeEgressLeg !== null) return
    const acquire = this.acquireTranscodeEgress
    if (acquire === null) return

    this.logger.info('Transcode leg: prewarming the egress while ICE/DTLS negotiate', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        sourceCodec: this.sourceCodec,
      },
    })
    // No `.catch` here on purpose: `startTranscodeFeed` awaits this promise and
    // owns the error reporting, and the release path attaches its own. A catch
    // planted here would swallow the failure the feed has to see.
    this.transcodeEgressPending = acquire({
      profile: this.transcodeProfile,
      sessionId: this.sessionId,
    })
  }

  /**
   * Take ownership of the in-flight prewarm, if there is one. Nulls the field
   * synchronously so the release path can never also claim it — see the field.
   */
  private claimPrewarmedEgress(): Promise<TranscodeEgressLeg> | null {
    const pending = this.transcodeEgressPending
    this.transcodeEgressPending = null
    return pending
  }

  private startTranscodeFeed(signal: AbortSignal): void {
    const acquire = this.acquireTranscodeEgress
    if (acquire === null) {
      // Nothing wired the primitive. The broker publishes and registers every
      // egress it acquires, so in production this is a wiring fault, not a
      // transient — bail loudly rather than feed silence.
      this.logger.error(
        'Transcode feed: no egress-transcode acquirer wired — cannot start the transcode leg',
        {
          meta: { phase: 'session', sessionId: this.sessionId, sourceCodec: this.sourceCodec },
        },
      )
      if (!this.closed) void this.close()
      return
    }

    // The acquire may already be in flight — `prewarmTranscodeEgress` starts it
    // at the answer so the ffmpeg spawns while ICE and DTLS handshake. Claiming
    // it here also takes ownership of its release from the teardown path.
    const prewarmed = this.claimPrewarmedEgress()
    this.logger.info(`Starting ${this.sourceCodec}→H.264 Baseline transcode leg`, {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        sourceCodec: this.sourceCodec,
        mode: 'egress-primitive',
        prewarmed: prewarmed !== null,
      },
    })
    const acquireNow = (): Promise<TranscodeEgressLeg> =>
      acquire({ profile: this.transcodeProfile, sessionId: this.sessionId })

    void (async () => {
      let leg: TranscodeEgressLeg
      try {
        // A prewarm races the source dial — it starts at the ANSWER, and a
        // broker with no consumer yet dials on attach, so
        // `source … is not dialed` is a legitimate outcome of moving the
        // acquire earlier. It is retried at the point the acquire used to
        // happen, never turned into a closed session: pipelining must not be
        // able to break a camera that worked.
        leg = await (prewarmed === null
          ? acquireNow()
          : prewarmed.catch((err: unknown) => {
              if (signal.aborted || this.closed) throw err
              this.logger.warn(
                'Transcode leg: the prewarmed acquire failed — retrying now that the feed has started',
                {
                  meta: {
                    phase: 'session',
                    sessionId: this.sessionId,
                    deviceId: this.deviceId,
                    error: errMsg(err),
                  },
                },
              )
              return acquireNow()
            }))
      } catch (err) {
        this.logger.error('Transcode feed: acquiring the egress transcode FAILED', {
          meta: {
            phase: 'session',
            sessionId: this.sessionId,
            deviceId: this.deviceId,
            error: errMsg(err),
          },
        })
        if (!this.closed) void this.close()
        return
      }

      // The acquire can outlive the session that asked for it. Releasing here
      // is the only thing standing between a viewer that gave up mid-acquire
      // and a child with no holder alive to release it — the primitive has no
      // lease TTL, on purpose (D67).
      if (signal.aborted || this.closed) {
        await leg.release().catch(() => undefined)
        return
      }

      this.transcodeEgressLeg = leg
      this.logger.info('Transcode leg attached to the acquired egress', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          camStreamId: leg.camStreamId,
          pipelineKey: leg.pipelineKey,
          encoder: leg.encoder,
          // A software outcome on a hub whose vaapi works is a flow bug, not a
          // capability limit — so report what RAN, never what was requested.
          decodeHwAccel: leg.decodeHwAccel ?? 'software',
        },
      })

      const framer = new H264EgressFramer()
      this.detachTranscodeEgress = leg.attachVideo((packet) => {
        if (signal.aborted || this.closed) return
        const au = framer.accept(packet)
        if (au === null) return
        this.sourceMediaSeen = true
        const nals = au.nals.map((n) => Buffer.from(n))
        if (au.keyframe) this.lastKeyframeNals = nals.map((n) => Buffer.from(n))
        // One picture, one RTP timestamp. Send-time rather than capture-time —
        // see `sendRtpTimestamp` for why capture-time stamps produced ~80 ms of
        // receiver jitter over the overlay and a PLI storm.
        this.writeVideoNals(nals, this.sendRtpTimestamp(), 'H264')
      })
    })()

    // Audio-only feed: video arrives on the acquired egress, so only audio is
    // forwarded from `this.source` here.
    void (async () => {
      try {
        for await (const mediaFrame of this.source) {
          if (signal.aborted || this.closed) break
          if (mediaFrame.type === 'audio') {
            // Audio passthrough (no transcode needed). Same µs-derived
            // RTP timestamp as the direct-feed branch — see comment
            // there for the RTCP SR / NTP↔RTP rationale. Clock is the
            // negotiated audio codec's rate (PCMU 8 kHz / Opus 48 kHz).
            const frame = mediaFrame.frame
            const rtpTs =
              Math.floor((frame.timestampMicros * this.audioClock().rateHz) / 1_000_000) >>> 0

            // Audio pipeline latency probe for the av-sync diagnostic — see the
            // direct-feed audio branch. Diagnostic-only.
            this.recordAudioSourceLatency(frame.timestampMicros)
            this.writeAudio(frame.data, rtpTs, frame.codec)
          }
        }
      } catch (err) {
        if (!signal.aborted && !this.closed) {
          this.logger.error('Transcode feed error', {
            meta: { sessionId: this.sessionId, error: errMsg(err) },
          })
        }
      } finally {
        if (!this.closed) void this.close()
      }
    })()
  }

  /**
   * Drop the acquired egress. Idempotent, never throws, and it is the ONLY
   * release path: the primitive has no lease TTL and no heartbeat, so a holder
   * that fails to release leaks a child until the broker restarts.
   */
  private async releaseTranscodeEgress(): Promise<void> {
    const detach = this.detachTranscodeEgress
    this.detachTranscodeEgress = null
    try {
      detach?.()
    } catch {
      /* a detach that throws must not stop the release */
    }
    // A prewarm the feed never claimed. The reproducer this exists for IS this
    // case — the viewer's watchdog gives up while the child is still spawning —
    // and the primitive has no lease TTL, so an unclaimed handle that lands
    // after the session is gone stays alive until the broker restarts.
    const orphan = this.claimPrewarmedEgress()
    if (orphan !== null) {
      void orphan
        .then((prewarmedLeg) => prewarmedLeg.release())
        .catch((err: unknown) => {
          // A prewarm that FAILED to acquire has nothing to release; a release
          // that itself failed is a leak worth naming.
          this.logger.debug('Transcode leg: the unclaimed prewarm ended without a handle', {
            meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(err) },
          })
        })
    }

    const leg = this.transcodeEgressLeg
    this.transcodeEgressLeg = null
    if (!leg) return
    try {
      await leg.release()
    } catch (err) {
      this.logger.warn('Transcode leg: releasing the egress handle failed — it may leak', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          pipelineKey: leg.pipelineKey,
          error: errMsg(err),
        },
      })
    }
  }

  // 1100 (not 1200): keep the full wire packet under the Tailscale/WireGuard
  // overlay MTU (1280). See H264_REPACKETIZER_MTU for the rationale — at 1200
  // a keyframe's RTP packets are ~1266 B and silently drop over the overlay,
  // causing a never-decoding PLI storm that works fine on a 1500-MTU LAN.
  private static readonly MAX_RTP_PAYLOAD = 1100

  private rtpPacketsSent = 0
  /**
   * Cumulative RTP packets this session has put on the wire.
   *
   * Read by the adaptive ladder's stall detector: "the client received
   * nothing" only means the link is broken if the broker was SENDING at the
   * time. Without this half, a paused camera, a battery source between wakes
   * or any legitimately idle feed reads as a stall and walks the ladder to
   * the floor for nothing.
   */
  get rtpPacketsSentTotal(): number {
    return this.rtpPacketsSent
  }

  /**
   * Video RTP PAYLOAD bytes this session sent, bucketed by time — the "sent"
   * half of the adaptive ladder's delivery ratio (D635). Payload, not wire
   * size, because the client's `bytesReceived` excludes RTP headers.
   */
  private readonly videoSendHistory = new SendHistory(ADAPTIVE_DELIVERY_CONFIG.historySpanMs)
  get sentVideoHistory(): SendHistoryReader {
    return this.videoSendHistory
  }

  /**
   * The receiver's bandwidth estimate (REMB) in kbps, or `null` when the peer
   * has sent none. werift stores the last REMB on the sender; `-1`/absent in
   * the loss line means the same "no estimate", which is not "zero".
   */
  receiverEstimateKbps(now: number): number | null {
    const raw = this.videoSender?.receiverEstimatedMaxBitrate
    return this.rembWatch.read(typeof raw === 'bigint' && raw > 0n ? Number(raw) / 1000 : null, now)
  }
  /** Ages the REMB werift keeps forever — see `RembWatch`. */
  private readonly rembWatch = new RembWatch(REMB_STALE_MS)
  private rtpLogCounter = 0
  /** One-shot guards for the "first video/audio RTP" debug markers. */
  private firstVideoRtpLogged = false
  private firstAudioRtpLogged = false
  /**
   * One-shot guard for the audio-silence pre-stream. When the source audio
   * pipeline (e.g. AAC → PCMU transcode) lags video by a CONSTANT startup
   * delay, the first real audio frame arrives N ms AFTER the first video
   * frame went out → audio `firstSendWallMs` − video `firstSendWallMs` is a
   * persistent positive gap, the browser inflates its audio jitter buffer
   * over that gap, and the user perceives ~1 s of audio-late lag.
   *
   * Right before the very first real audio packet is written we emit N PCMU
   * silence packets (0xFF bytes, 160 samples each = 20 ms) so the audio
   * sender's first wall-clock instant aligns with the video sender's first
   * wall-clock instant, then the real packet continues seamlessly. See
   * `sentryAudioSilenceIfNeeded` + `computeAudioSilencePadPackets`.
   */
  private firstAudioFramePadded = false
  /** PCMU frame size in samples per packet — 160 = 20 ms at 8 kHz. */
  private static readonly PCMU_FRAME_SAMPLES = 160
  /** PCMU silence byte. PCMU's µ-law representation of digital zero is 0xFF. */
  private static readonly PCMU_SILENCE_BYTE = 0xff
  /** Upper bound on the audio silence pre-stream duration (ms) — guards a
   *  runaway from blasting tens of seconds of silence onto the wire. */
  private static readonly AUDIO_SILENCE_MAX_PAD_MS = 2_000

  /**
   * Emit the one-shot "first video RTP sent" debug marker. Both egress
   * paths (`writeVideoNals` synthesis + `sendSourceRtpPacket` repacketizer
   * forward) funnel here so the marker fires exactly once regardless of
   * which path the session took. Gated on `debug`.
   */
  private logFirstVideoRtp(path: 'writeVideoNals' | 'source-rtp', codec: string): void {
    if (!this.debug || this.firstVideoRtpLogged) return
    this.firstVideoRtpLogged = true
    this.logger.info('first video RTP sent', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        path,
        codec,
        negotiated: this.negotiatedCodec,
        sinceCreatedMs: Date.now() - this.createdAt,
      },
    })
  }

  /**
   * Emit the one-shot "first audio RTP sent" marker: the SOURCE codec next to
   * the NEGOTIATED sender mime, which is the pair that answers "why is there
   * no audio".
   *
   * No longer gated on `debug`. It is one line per session — bounded by
   * `firstAudioRtpLogged` — and it is the only place the two codecs are ever
   * seen together. Without it, a source carrying AAC into a track negotiated
   * as Opus looks exactly like a source carrying nothing: the video plays, the
   * session reports healthy, and every log line agrees that audio is fine.
   * That is a silent drop, which this repo requires to be announced.
   */
  private logFirstAudioRtp(sourceCodec: string | undefined, senderPt: number): void {
    if (this.firstAudioRtpLogged) return
    this.firstAudioRtpLogged = true
    const senderCodec = this.audioSender?.codec
    this.logger.info('first audio RTP sent', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        sourceCodec: sourceCodec ?? 'unknown',
        senderMime: senderCodec?.mimeType ?? 'unknown',
        senderPayloadType: senderPt,
        sinceCreatedMs: Date.now() - this.createdAt,
      },
    })
  }

  /**
   * RTP timestamp (90 kHz) derived from the hub's MONOTONIC clock at the
   * moment of sending — NOT the camera capture time.
   *
   * Forwarding live media with capture-time RTP timestamps creates a cadence
   * mismatch vs the actual send time: the pipeline/decoder adds variable
   * latency between capture (`frame.timestampMicros`) and the instant we push
   * the packets out. A remote receiver measures that mismatch as high RTCP
   * jitter (~80 ms observed over Tailscale, with ZERO packet loss) — its
   * jitter buffer can't lock onto a stable clock, so frames are discarded and
   * it PLI-storms. A ~0-RTT LAN absorbs it; a real remote path does not.
   *
   * Stamping off send time makes the RTP-timestamp cadence equal the actual
   * transmit cadence, so arrival cadence matches and the receiver's jitter
   * collapses to true network jitter. Same effect ffmpeg/libwebrtc achieve by
   * pacing output. All video send paths (live feed + PLI keyframe resend)
   * share this one clock so timestamps stay monotonic.
   */
  private sendRtpTimestamp(): number {
    const now = performance.now()
    if (this.videoRtpClockBaseMs === null) this.videoRtpClockBaseMs = now
    return Math.floor((now - this.videoRtpClockBaseMs) * 90) >>> 0
  }

  /**
   * Record the latest audio SOURCE frame's capture timestamp and the send-time
   * wall-clock at the moment we write it. Diagnostic-only — read by the
   * debug "av-sync diag" log to estimate audio transcode/buffer latency. Does
   * not touch any send path. A non-finite capture timestamp is ignored so a
   * source that doesn't stamp frames can't poison the figure.
   */
  private recordAudioSourceLatency(captureMicros: number): void {
    if (!Number.isFinite(captureMicros)) return
    this.lastAudioSrcCaptureMicros = captureMicros
    this.lastAudioSendWallMs = Date.now()
  }

  /** When gated, incoming live broker frames are dropped so recorded playback owns the track. */
  setLiveFeedGate(gated: boolean): void {
    this.liveFeedGated = gated
    // A paced replay in flight is LIVE media — the broker's pre-buffer, and
    // the live packets queued behind it. The forwarder's gate stops new live
    // packets, but not the tail of a replay that started a moment earlier:
    // 2026-10-07, camera 103, an instant-start replay finished draining
    // 127 ms AFTER "live RTP GATED", interleaving the live main rendition into
    // the first recorded GOP. Recorded owns the track from here.
    if (gated) {
      this.activeRtpReplay?.abort()
      this.activeRtpReplay = null
    }
    // The track's source is switching — rebase the next outgoing packet's seq/ts
    // onto the live stream so the client doesn't see a discontinuity and drop it.
    this.rtpRebasePending = true
    this.recordedAudioRebasePending = true
  }

  /**
   * Send one recorded PCMU (8 kHz µ-law) audio frame on the shared audio sender.
   * Active ONLY while the live feed is gated (recorded owns the track) — the
   * mirror of `writeAudio`, which is gated OFF during recorded. The recorded
   * timestamp is software-rebased to continue monotonically from the last sent
   * audio packet (no backward jump across the live→recorded switch).
   */
  writeRecordedAudio(pcmu: Buffer, rtpTs8k: number): void {
    if (!this.audioSender || !_werift) return
    if (!this.liveFeedGated) return // live owns the track when ungated
    const werift = _werift
    if (this.recordedAudioRebasePending) {
      this.recordedAudioRebasePending = false
      // Continue ~one frame (160 samples @ 8 kHz = 20 ms) past the last sent ts.
      this.recordedAudioTsOffset = ((this.lastAudioRtpTs ?? 0) + 160 - rtpTs8k) | 0
    }
    const outTs = (rtpTs8k + this.recordedAudioTsOffset) >>> 0
    const senderCodec = this.audioSender.codec
    const pt = senderCodec?.payloadType ?? 0 // PCMU = 0
    try {
      const header = new werift.RtpHeader()
      header.payloadType = pt
      header.timestamp = outTs
      header.marker = true
      header.sequenceNumber = this.audioSeqNum = (this.audioSeqNum + 1) & 0xffff
      this.audioSender.sendRtp(new werift.RtpPacket(header, pcmu))
      this.lastAudioRtpTs = outTs
    } catch (err) {
      this.logger.debug('recorded audio write error', {
        meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(err) },
      })
    }
  }

  /**
   * Send one recorded Opus (48 kHz) audio frame on the shared audio sender.
   * The Opus sibling of `writeRecordedAudio` — active ONLY while the live feed
   * is gated and the session negotiated Opus. Stored Opus AUs (post-A1 fMP4
   * fragments) are forwarded with NO transcode. Timestamp is software-rebased
   * to continue monotonically from the last sent audio packet across the
   * live→recorded switch, at the 48 kHz Opus clock (one 20 ms frame = 960
   * samples).
   */
  writeRecordedAudioOpus(opus: Buffer, rtpTs48k: number): void {
    if (!this.audioSender || !_werift) return
    if (!this.liveFeedGated) return // live owns the track when ungated
    const werift = _werift
    if (this.recordedAudioRebasePending) {
      this.recordedAudioRebasePending = false
      // Continue ~one frame (960 samples @ 48 kHz = 20 ms) past the last sent ts.
      this.recordedAudioTsOffset =
        ((this.lastAudioRtpTs ?? 0) + AUDIO_CLOCK_OPUS.frameSamples - rtpTs48k) | 0
    }
    const outTs = (rtpTs48k + this.recordedAudioTsOffset) >>> 0
    const senderCodec = this.audioSender.codec
    const pt = senderCodec?.payloadType ?? AUDIO_CLOCK_OPUS.payloadType
    try {
      const header = new werift.RtpHeader()
      header.payloadType = pt
      header.timestamp = outTs
      header.marker = true
      header.sequenceNumber = this.audioSeqNum = (this.audioSeqNum + 1) & 0xffff
      this.audioSender.sendRtp(new werift.RtpPacket(header, opus))
      this.lastAudioRtpTs = outTs
    } catch (err) {
      this.logger.debug('recorded opus audio write error', {
        meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(err) },
      })
    }
  }

  /**
   * On a source switch, remap werift's sender offsets so the new source's first
   * packet (seq/ts) continues seamlessly from the last sent packet. One-shot per
   * switch (cleared after firing). No-op until a packet has actually been sent
   * (werift's replaceRTP guards on an undefined last-sequence).
   */
  private maybeRebaseRtp(sequenceNumber: number, timestamp: number): void {
    if (!this.rtpRebasePending || !this.videoSender) return
    this.rtpRebasePending = false
    try {
      this.videoSender.replaceRTP(
        { sequenceNumber: sequenceNumber & 0xffff, timestamp: timestamp >>> 0 },
        true,
      )
      this.logger.info('recorded: rebased RTP on source switch', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          sequenceNumber: sequenceNumber & 0xffff,
          timestamp: timestamp >>> 0,
        },
      })
    } catch (e) {
      this.logger.warn('replaceRTP (rebase) failed (non-fatal)', {
        meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(e) },
      })
    }
  }

  get isLiveFeedGated(): boolean {
    return this.liveFeedGated
  }

  /**
   * Push a recorded Annex-B access unit (H.264 or H.265) to the video track at
   * the given 90 kHz timestamp. The `codec` tag selects packetization (H.264
   * FU-A vs H.265 FU); it MUST match the codec negotiated in the session's SDP
   * for the browser to decode it (see broker-webrtc-server wiring).
   */
  pushRecordedAccessUnit(annexB: Uint8Array, rtpTs90k: number, codec: VideoCodec): void {
    const nals = splitAnnexBToNals(Buffer.from(annexB))
    if (nals.length === 0) return
    this.writeVideoNals(nals, rtpTs90k, codec)
  }

  /**
   * Force a decodable live restart when returning to live (goLive). Resetting the
   * bootstrap flag makes the next forwarded source-RTP packet replay the broker's
   * source-RTP pre-buffer — which starts at the current GOP's keyframe — so the
   * decoder re-initialises immediately instead of waiting (often seconds) for the
   * camera's next natural IDR. Without this, live resumes mid-GOP and the client
   * shows nothing until the next keyframe (the "press Go-Live 2-3 times" symptom).
   */
  requestKeyframe(): void {
    this.rtpBootstrapDone = false
  }

  /**
   * Register a handler for inbound control-channel messages (recorded-playback protocol).
   * Register BEFORE createOffer/handleOffer so the channel can't open and deliver a message
   * before the callback is set.
   */
  onControlMessage(cb: (raw: string) => void): void {
    this.onControlMessageCb = cb
  }

  /** Send a control-channel message to the client if the channel is open (best-effort). */
  sendControl(raw: string): void {
    if (this.controlChannel && this.controlChannel.readyState === 'open') {
      this.controlChannel.send(raw)
    } else {
      this.logger.debug('sendControl: channel not ready, dropping', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          readyState: this.controlChannel?.readyState ?? 'absent',
        },
      })
    }
  }

  /**
   * Subscribe to the client-created `camstack-control` data channel. The embed player is the
   * offerer (handleOffer flow), so its data channel arrives via `onDataChannel`. Called right
   * after the RTCPeerConnection is created in both negotiation flows.
   */
  private wireControlChannel(): void {
    this.pc?.onDataChannel.subscribe((channel: WeriftDataChannel) => {
      if (channel.label !== 'camstack-control') return
      this.controlChannel = channel
      channel.onMessage.subscribe((data: string | Buffer) => {
        const raw = typeof data === 'string' ? data : Buffer.from(data).toString('utf8')
        this.onControlMessageCb?.(raw)
      })
    })
  }

  private writeVideoNals(nals: Buffer[], rtpTs: number, codec: VideoCodec): void {
    // Source liveness for the AnnexB/transcode egress — see the watchdog.
    this.sourceMediaSeen = true
    if (!this.videoSender || !_werift) {
      if (this.rtpLogCounter === 0) {
        this.logger.warn('writeVideoNals: no sender', {
          meta: {
            phase: 'session',
            sessionId: this.sessionId,
            hasVideoSender: !!this.videoSender,
            hasWerift: !!_werift,
          },
        })
        this.rtpLogCounter++
      }
      return
    }
    const werift = _werift
    // Record the last video RTP timestamp for the av-sync diagnostic
    // (90 kHz). Diagnostic-only — does not influence packetization.
    this.lastVideoRtpTs = rtpTs >>> 0
    if (this.firstVideoRtpTs === null) {
      this.firstVideoRtpTs = this.lastVideoRtpTs
      this.firstVideoSendWallMs = Date.now()
    }
    // Use the payload type from the negotiated codec on the sender,
    // not a hardcoded value. After SDP negotiation, werift assigns the
    // correct PT to the sender's codec. Using a different PT causes
    // the browser to ignore the packets.
    const senderCodec = this.videoSender.codec
    const pt = senderCodec?.payloadType ?? (codec === 'H264' ? 96 : 97)

    const sendPkt = (payload: Buffer, marker: boolean) => {
      try {
        const header = new werift.RtpHeader()
        header.payloadType = pt
        header.timestamp = rtpTs
        header.marker = marker
        header.sequenceNumber = this.videoSeqNum = (this.videoSeqNum + 1) & 0xffff
        const pkt = new werift.RtpPacket(header, payload)

        // FIX: Sync SSRC/seq on first packet via werift's replaceRTP.
        // Without this, werift's internal SSRC and the RTP header SSRC
        // diverge, and the browser ignores the packets.
        if (!this.videoRtpSynced) {
          this.videoRtpSynced = true
          try {
            this.videoSender!.replaceRTP(header, true)
          } catch (e) {
            this.logger.warn('replaceRTP failed (non-fatal)', {
              meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(e) },
            })
          }
        }

        // Debug: check sender state for first few packets
        if (this.debug && this.rtpPacketsSent < 3) {
          const dtls = this.videoSender?.dtlsTransport
          const debugCodec = this.videoSender?.codec
          const ssrc = this.videoSender?.ssrc
          this.logger.info('sendRtp debug', {
            meta: {
              phase: 'session',
              sessionId: this.sessionId,
              packetIndex: this.rtpPacketsSent,
              dtls: dtls?.state ?? 'none',
              codec: debugCodec?.mimeType ?? 'NULL',
              payloadType: debugCodec?.payloadType ?? '?',
              ssrc: String(ssrc),
              payloadSize: payload.length,
            },
          })
        }
        this.videoSender!.sendRtp(pkt)
        this.videoSendHistory.record(payload.length, Date.now())

        this.rtpPacketsSent++
        this.logFirstVideoRtp('writeVideoNals', codec)
        if (this.debug && (this.rtpPacketsSent === 1 || this.rtpPacketsSent % 500 === 0)) {
          this.logger.info('RTP packets sent', {
            meta: {
              phase: 'session',
              sessionId: this.sessionId,
              count: this.rtpPacketsSent,
              payload: payload.length,
            },
          })
        }
      } catch (err) {
        if (this.rtpPacketsSent <= 10) {
          this.logger.error('sendRtp error', {
            meta: {
              phase: 'session',
              sessionId: this.sessionId,
              packetIndex: this.rtpPacketsSent,
              error: errMsg(err),
            },
          })
        }
      }
    }

    // Rebase onto the live stream on the switch into recorded (the first recorded
    // packet will carry seq=videoSeqNum+1 / ts=rtpTs). Must run before the first
    // sendPkt so werift's offsets are set when that packet goes out.
    this.maybeRebaseRtp((this.videoSeqNum + 1) & 0xffff, rtpTs)

    for (let i = 0; i < nals.length; i++) {
      const nal = nals[i]!
      const isLastNal = i === nals.length - 1

      if (nal.length <= AdaptiveSession.MAX_RTP_PAYLOAD) {
        sendPkt(nal, isLastNal)
      } else if (codec === 'H265') {
        // H.265 FU fragmentation (RFC 7798 §4.4.3)
        // NAL header is 2 bytes: [F|type(6)|layerId_hi(1)] [layerId_lo(5)|tid(3)]
        const nalType = (nal[0]! & 0x7e) >> 1
        const layerId = ((nal[0]! & 0x01) << 5) | ((nal[1]! & 0xf8) >> 3)
        const tid = nal[1]! & 0x07
        // FU NAL header: type=49 (FU), keep layerId+tid
        const fuNalHeader0 = (49 << 1) | (layerId >> 5)
        const fuNalHeader1 = ((layerId & 0x1f) << 3) | tid
        const nalBody = nal.subarray(2) // skip 2-byte NAL header

        let offset = 0
        let isFirst = true
        while (offset < nalBody.length) {
          const end = Math.min(offset + AdaptiveSession.MAX_RTP_PAYLOAD - 3, nalBody.length)
          const isLast = end >= nalBody.length

          let fuHeader = nalType & 0x3f
          if (isFirst) fuHeader |= 0x80
          if (isLast) fuHeader |= 0x40

          const fragment = Buffer.alloc(3 + (end - offset))
          fragment[0] = fuNalHeader0
          fragment[1] = fuNalHeader1
          fragment[2] = fuHeader
          nalBody.copy(fragment, 3, offset, end)

          sendPkt(fragment, isLastNal && isLast)
          offset = end
          isFirst = false
        }
      } else {
        // H.264 FU-A fragmentation (RFC 6184 §5.8)
        const nalHeader = nal[0]!
        const fnri = nalHeader & 0xe0
        const nalType = nalHeader & 0x1f
        const fuIndicator = fnri | 28
        const nalBody = nal.subarray(1)

        let offset = 0
        let isFirst = true
        while (offset < nalBody.length) {
          const end = Math.min(offset + AdaptiveSession.MAX_RTP_PAYLOAD - 2, nalBody.length)
          const isLast = end >= nalBody.length

          let fuHeader = nalType
          if (isFirst) fuHeader |= 0x80
          if (isLast) fuHeader |= 0x40

          const fragment = Buffer.alloc(2 + (end - offset))
          fragment[0] = fuIndicator
          fragment[1] = fuHeader
          nalBody.copy(fragment, 2, offset, end)

          sendPkt(fragment, isLastNal && isLast)
          offset = end
          isFirst = false
        }
      }
    }
  }

  /**
   * The negotiated audio RTP clock (PCMU 8 kHz or Opus 48 kHz), resolved once
   * from the werift sender's bound codec and cached. Returns the PCMU baseline
   * (uncached) until the sender codec is bound, so an early call can't lock in
   * the wrong clock.
   */
  private audioClock(): AudioRtpClock {
    if (this.negotiatedAudioClock) return this.negotiatedAudioClock
    const mime = this.audioSender?.codec?.mimeType
    if (!mime) return AUDIO_CLOCK_PCMU
    const clock = selectAudioClock(mime)
    this.negotiatedAudioClock = clock
    return clock
  }

  /** True once the session has negotiated the Opus audio codec. */
  get isOpusAudio(): boolean {
    return this.audioClock().codec === 'opus'
  }

  /**
   * Inject the canonical 20 ms Opus silence packet used for sentry A/V-sync
   * padding. Broker-provided (encoded via the audio-codec cap) because Opus has
   * no fixed silence byte the way PCMU does (0xFF).
   */
  setOpusSilenceFrame(frame: Buffer): void {
    this.opusSilenceFrame = frame
  }

  private writeAudio(data: Buffer, rtpTs: number, codec?: string): void {
    if (!this.audioSender || !_werift) return
    // Recorded playback is video-only (v1). While the live feed is gated, drop
    // live audio too — otherwise the live soundtrack bleeds over recorded video.
    if (this.liveFeedGated) return
    const werift = _werift
    // Use the payload type from the negotiated codec on the sender —
    // SAME pattern as `writeVideoNals`. werift assigns the negotiated
    // codec to the sender after SDP exchange completes; reading
    // `senderCodec.payloadType` keeps us in sync with whatever the
    // browser actually accepted in its answer. Fallback to the
    // static OFFER-side PT only if werift hasn't bound the codec yet
    // (timing race during the very first packet).
    // NOTE: NOT calling `audioSender.replaceRTP(header, true)`. Video
    // does it (and works), but audio's SSRC binding is more brittle
    // in werift — overriding the sender's SSRC with our header's
    // default (zero) leaves the SRTP context out of sync with the
    // SSRC the browser expects from the answer SDP, so the browser
    // gets RTP with the right PT but can't decrypt → silent drop.
    // werift assigns the audio sender's SSRC during transceiver
    // setup; let `sendRtp` use it directly.
    const senderCodec = this.audioSender.codec
    const fallbackPt = codec === 'Pcmu' || codec === 'Pcma' ? 0 : 111
    const pt = senderCodec?.payloadType ?? fallbackPt
    // ONE-SHOT: pre-stream PCMU silence so audio first-send wall-clock
    // aligns to video first-send wall-clock. Runs only on the very first
    // real audio packet; idempotent on every subsequent call.
    this.sentryAudioSilenceIfNeeded(rtpTs >>> 0, pt)
    try {
      const header = new werift.RtpHeader()
      header.payloadType = pt
      header.timestamp = rtpTs
      // marker=true on every audio packet — browsers tolerate it on
      // G.711 codecs, and some receive paths stall the jitter buffer
      // waiting for marker=true to start playback. Setting marker
      // on the first packet only (RFC 3551 talkspurt convention)
      // produced silent receivers in practice.
      header.marker = true
      header.sequenceNumber = this.audioSeqNum = (this.audioSeqNum + 1) & 0xffff
      const pkt = new werift.RtpPacket(header, data)
      this.audioSender.sendRtp(pkt)
      // Record the last audio RTP timestamp (PCMU 8 kHz) for the av-sync
      // diagnostic. Diagnostic-only.
      this.lastAudioRtpTs = rtpTs >>> 0
      if (this.firstAudioRtpTs === null) {
        this.firstAudioRtpTs = this.lastAudioRtpTs
        this.firstAudioSendWallMs = Date.now()
      }
      this.logFirstAudioRtp(codec, pt)
    } catch (err) {
      this.logger.debug('Audio write error', {
        meta: { phase: 'session', sessionId: this.sessionId, error: errMsg(err) },
      })
    }
  }

  /**
   * Pre-stream N PCMU silence packets (160 bytes of 0xFF each, 20 ms / 8 kHz)
   * BEFORE the first real audio packet so the audio sender's first wall-clock
   * instant aligns with the video sender's first wall-clock instant. One-shot
   * per session, gated on `firstAudioFramePadded`. The packet count comes from
   * the pure `computeAudioSilencePadPackets` helper (gap clamp, sub-frame
   * floor, maxPad cap). Silence packets occupy RTP timestamps
   * `[realRtpTs − N·160, realRtpTs)` so the real packet's own timestamp stays
   * exactly what the caller computed and continuity holds across the boundary
   * (no gap, no overlap). Sequence numbers continue from `audioSeqNum`.
   *
   * After emitting the silence, `firstAudioRtpTs` / `firstAudioSendWallMs`
   * reference the FIRST silence packet (so `firstSendGapMs` in the av-sync
   * diag reads ~0). Any failure on a single `sendRtp` is logged and the loop
   * continues — partial alignment is better than aborting.
   */
  private sentryAudioSilenceIfNeeded(realRtpTs: number, payloadType: number): void {
    if (this.firstAudioFramePadded) return
    this.firstAudioFramePadded = true
    if (!this.audioSender || !_werift) return
    const werift = _werift
    const nowMs = Date.now()
    const clock = this.audioClock()
    // Opus has no fixed silence byte — pad only if the broker supplied an
    // encoded-silence packet; without it, skip sentry padding for Opus
    // (A/V-sync alignment is best-effort, never a hard requirement). PCMU pads
    // with a 160-byte 0xFF frame as before.
    const silencePayload =
      clock.codec === 'opus'
        ? this.opusSilenceFrame
        : Buffer.alloc(AdaptiveSession.PCMU_FRAME_SAMPLES, AdaptiveSession.PCMU_SILENCE_BYTE)
    if (!silencePayload) return
    const plan = planAudioSilencePadPackets({
      nowMs,
      firstVideoSendWallMs: this.firstVideoSendWallMs,
      framesizeSamples: clock.frameSamples,
      rateHz: clock.rateHz,
      maxPadMs: AdaptiveSession.AUDIO_SILENCE_MAX_PAD_MS,
      realRtpTs,
      audioSeqNum: this.audioSeqNum,
    })
    if (plan.packets.length === 0) return
    for (let i = 0; i < plan.packets.length; i++) {
      const planned = plan.packets[i]!
      try {
        const header = new werift.RtpHeader()
        header.payloadType = payloadType
        header.timestamp = planned.rtpTs
        header.marker = true
        header.sequenceNumber = planned.seq
        const pkt = new werift.RtpPacket(header, silencePayload)
        this.audioSender.sendRtp(pkt)
        this.lastAudioRtpTs = planned.rtpTs
        if (this.firstAudioRtpTs === null) {
          this.firstAudioRtpTs = planned.rtpTs
          // Anchor to the VIDEO first-send wall-clock so the av-sync diag's
          // `firstSendGapMs = firstAudioSendWallMs − firstVideoSendWallMs`
          // reads ~0 after this fix. Falls back to `nowMs` defensively.
          this.firstAudioSendWallMs = this.firstVideoSendWallMs ?? nowMs
        }
      } catch (err) {
        this.logger.debug('Audio silence pre-stream error', {
          meta: {
            phase: 'session',
            sessionId: this.sessionId,
            error: errMsg(err),
            packetIndex: i,
            totalPackets: plan.packets.length,
          },
        })
      }
    }
    // Carry forward the seqNum past the silence packets so the real packet
    // (which does `this.audioSeqNum = (this.audioSeqNum + 1) & 0xffff`) lands
    // on the next contiguous seq, matching the plan.
    this.audioSeqNum = plan.nextAudioSeqNum
    if (this.debug) {
      this.logger.info('audio silence pre-stream emitted', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          packets: plan.packets.length,
          gapMs: this.firstVideoSendWallMs === null ? null : nowMs - this.firstVideoSendWallMs,
          firstSilenceRtpTs: plan.packets[0]?.rtpTs ?? null,
          realRtpTs,
          frameSize: clock.frameSamples,
        },
      })
    }
  }

  // -----------------------------------------------------------------------
  // RTCP stats collection
  // -----------------------------------------------------------------------

  private startStatsCollection(): void {
    // Runs regardless of `onStats` so the diagnostic log below always fires —
    // it's the decisive evidence for "hub sends RTP but browser loses it" vs
    // "hub never sends" on a remote (WAN) session.
    if (this.statsTimer) return

    this.statsTimer = setInterval(() => {
      if (!this.pc || this.closed) return
      this.collectStats()
    }, 3_000)
  }

  private collectStats(): void {
    if (!this.pc) return

    // Receiver Report captured live from sender.onRtcp (werift never persists
    // lastReceiverReport, so the old getSenders()-based read was always empty).
    const report: WeriftReceiverReport | undefined = this.lastRr ?? undefined

    const fractionLost = report?.fractionLost ?? 0
    const packetsLost = report?.packetsLost ?? report?.cumulativeLost ?? 0
    const jitter = report?.jitter ?? 0
    const rtt = report?.roundTripTime ?? report?.rtt ?? 0

    // Decisive diagnostic: is the hub actually emitting RTP, and does the
    // browser's RTCP receiver-report show loss? `rtpPacketsSent` climbing +
    // a receiver-report with loss ⇒ packets sent but dropped on hub→browser
    // (path/relay loss). `rtpPacketsSent` flat ⇒ werift isn't sending at all.
    //
    // The nominated-pair fields are the smoking gun for the remote-NAT
    // case: on a 4G/CGNAT retest we expect `selectedLocalType:'relay'` +
    // `selectedRemoteType:'relay'` once relay-only is forced. A
    // `host`/`srflx` local with a `relay` remote (or no pair) on a
    // remote session is the dead-pair symptom this fix targets.
    const nominated = this.readNominatedPair()
    if (this.debug) {
      this.logger.info('webrtc media diag', {
        meta: {
          phase: 'session',
          sessionId: this.sessionId,
          deviceId: this.deviceId,
          rtpPacketsSent: this.rtpPacketsSent,
          dtls: this.videoSender?.dtlsTransport?.state ?? 'unknown',
          ice: this.state,
          forceRelayOnly: this.forceRelayOnly,
          hasReceiverReport: !!report,
          fractionLostPct: report ? Math.round((fractionLost / 256) * 100) : -1,
          packetsLost,
          // video RTP clock is 90 kHz → jitter ticks / 90 = milliseconds.
          jitterMs: report ? Math.round(jitter / 90) : -1,
          rttMs: Math.round(rtt * 1000),
          selectedLocalType: nominated?.localType ?? 'none',
          selectedLocalAddr: nominated?.localAddr ?? 'none',
          selectedRemoteType: nominated?.remoteType ?? 'none',
          selectedRemoteAddr: nominated?.remoteAddr ?? 'none',
        },
      })
    }

    // The LOSS line, unconditionally. Not behind `this.debug`: that flag is a
    // per-device operator toggle and is off by default, so in production an
    // Alexa session produced no line about loss at all and nobody could say
    // whether the Echo sends receiver reports. `shouldWriteLossLine` keeps the
    // volume sane without ever throttling away the transition that matters.
    // REMB — the OTHER direction a peer can answer in. werift stores it on the
    // sender; nothing here had ever read it. `-1` means "no estimate", which is
    // a different fact from "the peer said zero".
    const rembRaw = this.videoSender?.receiverEstimatedMaxBitrate
    const rembBps = typeof rembRaw === 'bigint' && rembRaw > 0n ? Number(rembRaw) : -1
    const sample: LossSample = {
      hasReceiverReport: report !== undefined,
      lossPct: report ? Math.round((fractionLost / 256) * 100) : -1,
    }
    this.lossTicksSinceWrite += 1
    const verdict = shouldWriteLossLine({
      sample,
      lastWritten: this.lastLossWritten,
      ticksSinceWrite: this.lossTicksSinceWrite,
    })
    if (verdict.write) {
      this.lastLossWritten = sample
      this.lossTicksSinceWrite = 0
      this.logger.info('webrtc loss', {
        tags: { deviceId: this.deviceId },
        meta: {
          sessionId: this.sessionId,
          consumerKind: this.consumerKind,
          why: verdict.reason,
          // A consumer that never sends RTCP is the thing this line exists to
          // make visible: `false` here, for a whole session, is the answer to
          // "can an adaptive ladder be built on receiver reports for it".
          hasReceiverReport: sample.hasReceiverReport,
          // A peer that answers HERE and nowhere else can still be adapted to.
          rembBps,
          lossPct: sample.lossPct,
          packetsLost,
          // video RTP clock is 90 kHz → jitter ticks / 90 = milliseconds.
          jitterMs: report ? Math.round(jitter / 90) : -1,
          rttMs: report ? Math.round(rtt * 1000) : -1,
          rtpPacketsSent: this.rtpPacketsSent,
        },
      })
    }

    if (report && this.onStats) {
      this.onStats({
        sessionId: this.sessionId,
        packetLoss: fractionLost / 256, // Fraction lost is 0–255
        jitterMs: jitter,
        rttMs: rtt * 1000,
        packetsReceived: 0,
        packetsLost,
        timestamp: Date.now(),
      })
    }

    // Debug-only A/V lip-sync diagnostic — shares this 3s tick.
    this.emitAvSyncDiag()
  }

  /** Video RTP clock rate in Hz (audio rate now comes from `audioClock()`,
   *  which follows the negotiated codec — PCMU 8 kHz / Opus 48 kHz). */
  private static readonly VIDEO_RTP_CLOCK_HZ = 90_000

  /**
   * Emit the periodic "av-sync diag" log (debug only, ~every 3s) to gather the
   * evidence for the steady "audio plays ~0.5s behind video" lag — WITHOUT
   * changing any audio/video behaviour. For BOTH tracks it reports the last
   * sent RTP timestamp, the clock rate, the media-time (rtpTs/rate), the
   * wall-clock elapsed since session create, and the per-track skew
   * (media-time − wall-clock-elapsed); plus the INTER-TRACK skew (audio
   * media-seconds − video media-seconds) — negative means audio's RTP clock
   * runs behind video's, and by how much. It also surfaces the audio pipeline
   * latency (source capture timestamp vs send wall-clock) — the prime suspect
   * for the constant offset — and documents the werift RTCP-SR limitation.
   */
  private emitAvSyncDiag(): void {
    if (!this.debug) return

    const elapsedMs = Date.now() - this.createdAt
    // Audio RTP clock follows the negotiated codec (PCMU 8 kHz / Opus 48 kHz).
    // The typed werift sender surface exposes mimeType/payloadType but no
    // clockRate, so `audioClock()` maps the mime to its codec-fixed rate.
    const audioRate = this.audioClock().rateHz

    // Feed SESSION-RELATIVE rtp timestamps (last − first, 32-bit-wrap-safe via
    // `>>> 0`) so video's huge source clock and audio's near-zero sample counter
    // share a session-zero base — otherwise videoMediaSec is hours and
    // interTrackSkew is garbage.
    const skew = computeAvSyncSkew({
      video:
        this.lastVideoRtpTs === null || this.firstVideoRtpTs === null
          ? null
          : {
              rtpTs: (this.lastVideoRtpTs - this.firstVideoRtpTs) >>> 0,
              rate: AdaptiveSession.VIDEO_RTP_CLOCK_HZ,
              elapsedMs,
            },
      audio:
        this.lastAudioRtpTs === null || this.firstAudioRtpTs === null
          ? null
          : {
              rtpTs: (this.lastAudioRtpTs - this.firstAudioRtpTs) >>> 0,
              rate: audioRate,
              elapsedMs,
            },
    })

    // Audio pipeline latency: source-frame capture (µs) vs the send wall-clock
    // captured when we wrote it. We can't subtract a µs capture clock from a
    // ms wall clock to a single absolute latency (the two clocks have unknown
    // offsets) — but the DRIFT of (sendWall − capture) across ticks is the
    // transcode/buffer latency growth. Report both raw anchors so the operator
    // can watch the delta evolve; a steady gap that matches the inter-track
    // skew points the finger at the audio pipeline (esp. AAC→PCMU transcode).
    const audioCaptureMs =
      this.lastAudioSrcCaptureMicros === null ? null : this.lastAudioSrcCaptureMicros / 1000
    const audioSendWallMs = this.lastAudioSendWallMs
    const audioPipelineDeltaMs =
      audioCaptureMs !== null && audioSendWallMs !== null
        ? Math.round(audioSendWallMs - audioCaptureMs)
        : null

    // Constant startup offset between tracks: how much LATER (wall-clock) audio
    // first flowed vs video. Positive ⇒ audio started later ⇒ steady audio-late
    // lag of roughly this magnitude (video passthrough ~0 latency, audio behind
    // its decode/transcode pipeline). The decisive number for a CONSTANT lag.
    const firstSendGapMs =
      this.firstAudioSendWallMs !== null && this.firstVideoSendWallMs !== null
        ? this.firstAudioSendWallMs - this.firstVideoSendWallMs
        : null

    // RTCP Sender Report (ntpTime, rtpTimestamp) — NOT reachable from our
    // typed werift surface. werift builds the SR inside `RTCRtpSender.runRtcp`
    // from the PRIVATE fields `ntpTimestamp` / `rtpTimestamp` (set in
    // `sendRtp`); the `.d.ts` declares them `private`, and `onRtcp` only fires
    // on INCOMING RTCP (the remote's RR/SR), never the SR we emit. Surfacing
    // the pair would require an `as any` reach into werift internals, which the
    // project forbids — so we report the limitation instead of the value.
    this.logger.info('av-sync diag', {
      meta: {
        phase: 'session',
        sessionId: this.sessionId,
        deviceId: this.deviceId,
        elapsedMs,
        // Video track.
        videoRtpTs: this.lastVideoRtpTs,
        videoClockRate: AdaptiveSession.VIDEO_RTP_CLOCK_HZ,
        videoMediaSec: skew.video ? Number(skew.video.mediaSeconds.toFixed(3)) : null,
        videoSkewSec: skew.video ? Number(skew.video.skewSeconds.toFixed(3)) : null,
        // Constant startup offset audio-vs-video (ms); ≈ steady perceived lag.
        firstSendGapMs,
        // Audio track (PCMU).
        audioRtpTs: this.lastAudioRtpTs,
        audioClockRate: audioRate,
        audioMediaSec: skew.audio ? Number(skew.audio.mediaSeconds.toFixed(3)) : null,
        audioSkewSec: skew.audio ? Number(skew.audio.skewSeconds.toFixed(3)) : null,
        // The decisive figure: negative ⇒ audio media clock lags video.
        interTrackSkewSec:
          skew.interTrackSkewSeconds === null
            ? null
            : Number(skew.interTrackSkewSeconds.toFixed(3)),
        // Audio pipeline latency anchors (see comment above).
        audioSrcCaptureMs: audioCaptureMs === null ? null : Number(audioCaptureMs.toFixed(1)),
        audioSendWallMs,
        audioPipelineDeltaMs,
        // RTCP SR limitation (see comment above).
        rtcpSr:
          'unavailable: werift sender ntpTimestamp/rtpTimestamp are private; onRtcp is incoming-only',
      },
    })
  }
}
