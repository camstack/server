/**
 * Pure derivation of the stream-debug overlay's CLIENT half from one
 * `RTCPeerConnection.getStats()` report.
 *
 * Why it is pure: this is the surface an operator reads while a camera is
 * frozen, and the numbers it shows decide whether the stall is in the
 * transport or in the decoder. A derivation that can only be exercised by
 * mounting a player and waiting for a real freeze is a derivation nobody
 * checks. Everything here is a function of (report, previous sample, clock).
 *
 * D393 — a measurement that FAILED is `null`, never `0`. A stat the browser
 * did not report is absent, and "absent" must never render as "zero" in a
 * debug tool: `freezeCount: 0` means the decoder measured no freeze,
 * `freezeCount: null` means nobody measured. Those are opposite conclusions.
 */
import type { WebrtcSessionDebug } from '@camstack/types'

/** One resolution the stream actually presented, and when it started. */
export interface ResolutionMark {
  readonly width: number
  readonly height: number
  readonly at: number
}

/** Deltas over the interval between the previous sample and this one. */
export interface WebrtcDebugWindow {
  /** Length of the window, from the RTP report clock. Null on the first
   *  sample and whenever the report timestamp did not advance. */
  readonly spanMs: number | null
  readonly kbps: number | null
  readonly packetsReceived: number | null
  readonly packetsLost: number | null
  readonly lossPercent: number | null
  /** 0 here is the load-bearing value: the transport is delivering and the
   *  decoder emitted nothing. */
  readonly framesDecoded: number | null
  readonly framesDropped: number | null
  readonly freezeCount: number | null
  readonly freezeMs: number | null
  readonly nackCount: number | null
  readonly pliCount: number | null
  /** Mean decode time per frame decoded IN THIS WINDOW. */
  readonly decodeMs: number | null
}

export interface WebrtcDebugStats {
  /** Wall clock at which this sample was taken — the overlay prints its age
   *  so a stale poll can never be mistaken for a live one. */
  readonly at: number
  /** Whether an inbound-rtp video report existed at all. `false` means every
   *  inbound field below is null because nothing was measured. */
  readonly hasInboundVideo: boolean
  readonly width: number | null
  readonly height: number | null
  readonly fps: number | null
  readonly codec: string | null
  readonly codecProfileLevelId: string | null
  readonly jitterMs: number | null
  readonly packetsReceived: number | null
  readonly packetsLost: number | null
  readonly lossPercent: number | null
  readonly nackCount: number | null
  readonly pliCount: number | null
  readonly framesDecoded: number | null
  readonly framesDropped: number | null
  readonly freezeCount: number | null
  readonly totalFreezeMs: number | null
  readonly avgDecodeMs: number | null
  readonly rttMs: number | null
  readonly availableIncomingKbps: number | null
  readonly localCandidateType: string | null
  readonly remoteCandidateType: string | null
  /** `local/remote` candidate types of the selected pair, e.g. `srflx/host`. */
  readonly candidatePairType: string | null
  readonly candidateProtocol: string | null
  readonly iceConnectionState: string | null
  readonly dtlsState: string | null
  readonly window: WebrtcDebugWindow
  /** Every resolution the stream presented, oldest first, newest last. */
  readonly resolutionLog: readonly ResolutionMark[]
  /** Raw counters carried forward so the NEXT sample can window them. */
  readonly raw: RawCounters
}

/** The cumulative counters a window is computed from. */
export interface RawCounters {
  /** The RTP report clock (`RTCStats.timestamp`), not the wall clock. */
  readonly timestamp: number | null
  readonly bytesReceived: number | null
  readonly packetsReceived: number | null
  readonly packetsLost: number | null
  readonly framesDecoded: number | null
  readonly framesDropped: number | null
  readonly freezeCount: number | null
  readonly totalFreezesDurationS: number | null
  readonly totalDecodeTimeS: number | null
  readonly nackCount: number | null
  readonly pliCount: number | null
}

export interface DeriveWebrtcDebugStatsInput {
  readonly report: RTCStatsReport
  readonly prev: WebrtcDebugStats | null
  /** Wall clock — `Date.now()` in production, fixed in tests. */
  readonly now: number
  readonly iceConnectionState: string | null
  readonly dtlsState: string | null
}

/** Beyond this the log is a scroll, not a signal. */
const RESOLUTION_LOG_MAX = 8

/** Every field this derivation reads, all optional — a browser reports what
 *  it reports. Nothing here is cast; the shape is the WebRTC stats spec. */
interface StatsLike {
  readonly id?: string
  readonly type?: string
  readonly kind?: string
  readonly mediaType?: string
  readonly timestamp?: number
  readonly codecId?: string
  readonly mimeType?: string
  readonly sdpFmtpLine?: string
  readonly bytesReceived?: number
  readonly packetsReceived?: number
  readonly packetsLost?: number
  readonly jitter?: number
  readonly framesPerSecond?: number
  readonly frameWidth?: number
  readonly frameHeight?: number
  readonly framesDecoded?: number
  readonly framesDropped?: number
  readonly freezeCount?: number
  readonly totalFreezesDuration?: number
  readonly totalDecodeTime?: number
  readonly nackCount?: number
  readonly pliCount?: number
  readonly nominated?: boolean
  readonly state?: string
  readonly selected?: boolean
  readonly currentRoundTripTime?: number
  readonly availableIncomingBitrate?: number
  readonly localCandidateId?: string
  readonly remoteCandidateId?: string
  readonly candidateType?: string
  readonly protocol?: string
  readonly selectedCandidatePairId?: string
}

function num(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Δ of two cumulative counters. Null unless BOTH ends were measured; a
 *  counter that went backwards (a reset) yields null rather than a negative. */
function delta(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null
  const d = now - before
  return d < 0 ? null : d
}

function lossPercentOf(lost: number | null, received: number | null): number | null {
  if (lost === null || received === null) return null
  const total = lost + received
  if (total <= 0) return null
  return (lost / total) * 100
}

function profileLevelIdOf(fmtp: string | null): string | null {
  if (fmtp === null) return null
  const match = /profile-level-id=([0-9a-fA-F]+)/.exec(fmtp)
  return match?.[1] ?? null
}

interface Collected {
  inbound: StatsLike | null
  codecs: Map<string, StatsLike>
  candidates: Map<string, StatsLike>
  pair: StatsLike | null
  selectedPairId: string | null
}

function collect(report: RTCStatsReport): Collected {
  const out: Collected = {
    inbound: null,
    codecs: new Map<string, StatsLike>(),
    candidates: new Map<string, StatsLike>(),
    pair: null,
    selectedPairId: null,
  }
  const pairs: StatsLike[] = []
  report.forEach((raw: RTCStats): void => {
    const s: StatsLike = raw
    const id = str(s.id)
    switch (s.type) {
      case 'inbound-rtp':
        if ((s.kind ?? s.mediaType) === 'video') out.inbound = s
        break
      case 'codec':
        if (id !== null) out.codecs.set(id, s)
        break
      case 'local-candidate':
      case 'remote-candidate':
        if (id !== null) out.candidates.set(id, s)
        break
      case 'candidate-pair':
        pairs.push(s)
        break
      case 'transport':
        out.selectedPairId = str(s.selectedCandidatePairId)
        break
      default:
        break
    }
  })
  // Preference order for "the pair actually carrying media": the transport's
  // own pointer, then Chrome's `selected`, then nominated+succeeded, then any
  // succeeded pair. A pair that merely exists proves nothing — a failed pair's
  // RTT used to be printed as if it were the live path.
  const byId = out.selectedPairId
  out.pair =
    pairs.find((p) => str(p.id) === byId) ??
    pairs.find((p) => p.selected === true) ??
    pairs.find((p) => p.nominated === true && p.state === 'succeeded') ??
    pairs.find((p) => p.nominated === true) ??
    pairs.find((p) => p.state === 'succeeded') ??
    null
  return out
}

function readCounters(inbound: StatsLike | null): RawCounters {
  if (inbound === null) {
    return {
      timestamp: null,
      bytesReceived: null,
      packetsReceived: null,
      packetsLost: null,
      framesDecoded: null,
      framesDropped: null,
      freezeCount: null,
      totalFreezesDurationS: null,
      totalDecodeTimeS: null,
      nackCount: null,
      pliCount: null,
    }
  }
  return {
    timestamp: num(inbound.timestamp),
    bytesReceived: num(inbound.bytesReceived),
    packetsReceived: num(inbound.packetsReceived),
    packetsLost: num(inbound.packetsLost),
    framesDecoded: num(inbound.framesDecoded),
    framesDropped: num(inbound.framesDropped),
    freezeCount: num(inbound.freezeCount),
    totalFreezesDurationS: num(inbound.totalFreezesDuration),
    totalDecodeTimeS: num(inbound.totalDecodeTime),
    nackCount: num(inbound.nackCount),
    pliCount: num(inbound.pliCount),
  }
}

const EMPTY_WINDOW: WebrtcDebugWindow = {
  spanMs: null,
  kbps: null,
  packetsReceived: null,
  packetsLost: null,
  lossPercent: null,
  framesDecoded: null,
  framesDropped: null,
  freezeCount: null,
  freezeMs: null,
  nackCount: null,
  pliCount: null,
  decodeMs: null,
}

function windowOf(now: RawCounters, before: RawCounters | null): WebrtcDebugWindow {
  if (before === null) return EMPTY_WINDOW
  const spanMs = delta(now.timestamp, before.timestamp)
  // A window with no measured span is not a window. Reporting the deltas
  // anyway would attribute a whole session's counters to one second.
  if (spanMs === null || spanMs <= 0) return EMPTY_WINDOW
  const bytes = delta(now.bytesReceived, before.bytesReceived)
  const lost = delta(now.packetsLost, before.packetsLost)
  const received = delta(now.packetsReceived, before.packetsReceived)
  const decoded = delta(now.framesDecoded, before.framesDecoded)
  const decodeS = delta(now.totalDecodeTimeS, before.totalDecodeTimeS)
  const freezeS = delta(now.totalFreezesDurationS, before.totalFreezesDurationS)
  return {
    spanMs,
    kbps: bytes === null ? null : Math.round((bytes * 8) / spanMs),
    packetsReceived: received,
    packetsLost: lost,
    lossPercent: lossPercentOf(lost, received),
    framesDecoded: decoded,
    framesDropped: delta(now.framesDropped, before.framesDropped),
    freezeCount: delta(now.freezeCount, before.freezeCount),
    freezeMs: freezeS === null ? null : Math.round(freezeS * 1000),
    nackCount: delta(now.nackCount, before.nackCount),
    pliCount: delta(now.pliCount, before.pliCount),
    decodeMs:
      decodeS === null || decoded === null || decoded <= 0 ? null : (decodeS / decoded) * 1000,
  }
}

function resolutionLogOf(
  prev: readonly ResolutionMark[],
  width: number | null,
  height: number | null,
  at: number,
): readonly ResolutionMark[] {
  // An UNKNOWN resolution is not a change — it is a gap in measurement, and
  // logging it would invent a transition the stream never made.
  if (width === null || height === null) return prev
  const last = prev.at(-1)
  if (last !== undefined && last.width === width && last.height === height) return prev
  const next = [...prev, { width, height, at }]
  return next.length > RESOLUTION_LOG_MAX ? next.slice(next.length - RESOLUTION_LOG_MAX) : next
}

/**
 * Derive one debug sample. Immutable: `prev` is read, never mutated, and the
 * returned object is the input for the next call.
 */
export function deriveWebrtcDebugStats(input: DeriveWebrtcDebugStatsInput): WebrtcDebugStats {
  const { inbound, codecs, candidates, pair } = collect(input.report)
  const raw = readCounters(inbound)

  const codecStat = inbound !== null ? codecs.get(str(inbound.codecId) ?? '') : undefined
  const mime = str(codecStat?.mimeType)
  const fmtp = str(codecStat?.sdpFmtpLine)

  const localCand = pair !== null ? candidates.get(str(pair.localCandidateId) ?? '') : undefined
  const remoteCand = pair !== null ? candidates.get(str(pair.remoteCandidateId) ?? '') : undefined
  const localType = str(localCand?.candidateType)
  const remoteType = str(remoteCand?.candidateType)

  const width = num(inbound?.frameWidth)
  const height = num(inbound?.frameHeight)

  const totalFreezeS = raw.totalFreezesDurationS
  const decodeS = raw.totalDecodeTimeS
  const decodedTotal = raw.framesDecoded

  return {
    at: input.now,
    hasInboundVideo: inbound !== null,
    width,
    height,
    fps: num(inbound?.framesPerSecond),
    codec: mime === null ? null : (mime.split('/')[1] ?? mime),
    codecProfileLevelId: profileLevelIdOf(fmtp),
    jitterMs: jitterMsOf(inbound),
    packetsReceived: raw.packetsReceived,
    packetsLost: raw.packetsLost,
    lossPercent: lossPercentOf(raw.packetsLost, raw.packetsReceived),
    nackCount: raw.nackCount,
    pliCount: raw.pliCount,
    framesDecoded: decodedTotal,
    framesDropped: raw.framesDropped,
    freezeCount: raw.freezeCount,
    totalFreezeMs: totalFreezeS === null ? null : Math.round(totalFreezeS * 1000),
    avgDecodeMs:
      decodeS === null || decodedTotal === null || decodedTotal <= 0
        ? null
        : (decodeS / decodedTotal) * 1000,
    rttMs: rttMsOf(pair),
    availableIncomingKbps: availableKbpsOf(pair),
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    candidatePairType:
      localType === null && remoteType === null ? null : `${localType ?? '?'}/${remoteType ?? '?'}`,
    candidateProtocol: str(localCand?.protocol),
    iceConnectionState: input.iceConnectionState,
    dtlsState: input.dtlsState,
    window: windowOf(raw, input.prev?.raw ?? null),
    resolutionLog: resolutionLogOf(input.prev?.resolutionLog ?? [], width, height, input.now),
    raw,
  }
}

function jitterMsOf(inbound: StatsLike | null): number | null {
  const jitter = num(inbound?.jitter)
  return jitter === null ? null : jitter * 1000
}

function rttMsOf(pair: StatsLike | null): number | null {
  const rtt = num(pair?.currentRoundTripTime)
  return rtt === null ? null : rtt * 1000
}

function availableKbpsOf(pair: StatsLike | null): number | null {
  const bps = num(pair?.availableIncomingBitrate)
  return bps === null ? null : Math.round(bps / 1000)
}

/**
 * The one question this overlay exists to answer while a camera is frozen:
 * did the BYTES stop, or did the DECODER stop?
 *
 * The open investigation is a `mid` stream that freezes until the user hits
 * pause/play. Those two causes need opposite fixes and look identical on the
 * screen; they differ only here, in one window's worth of counters:
 *  - bytes arriving, no frame out  ⇒ the decoder is wedged (pause/play
 *    rebuilds it, which is exactly the reported workaround);
 *  - nothing arriving              ⇒ the transport stopped, and the server
 *    half of the overlay says whether the broker was still sending.
 *
 * Every other case is `unknown`, deliberately. A verdict guessed from a
 * missing byte rate is worse than no verdict — it is the thing an operator
 * will trust and stop measuring.
 */
export type FreezeVerdictKind =
  | 'unknown'
  | 'decoding'
  | 'decoder-stall'
  | 'transport-stall'
  | 'frozen-unknown'

export interface FreezeVerdict {
  readonly kind: FreezeVerdictKind
  readonly label: string
}

const VERDICTS: Readonly<Record<FreezeVerdictKind, string>> = {
  unknown: 'no window yet',
  decoding: 'decoding',
  'decoder-stall': 'DECODER STALL — bytes arriving, no frames out',
  'transport-stall': 'TRANSPORT STALL — nothing arriving',
  'frozen-unknown': 'frames stopped — byte rate unknown',
}

export function freezeVerdict(stats: WebrtcDebugStats | null): FreezeVerdict {
  const kind = freezeVerdictKind(stats)
  return { kind, label: VERDICTS[kind] }
}

function freezeVerdictKind(stats: WebrtcDebugStats | null): FreezeVerdictKind {
  if (stats === null || !stats.hasInboundVideo) return 'unknown'
  const decoded = stats.window.framesDecoded
  if (decoded === null) return 'unknown'
  if (decoded > 0) return 'decoding'
  const kbps = stats.window.kbps
  if (kbps === null) return 'frozen-unknown'
  return kbps > 0 ? 'decoder-stall' : 'transport-stall'
}

/**
 * One reported sample: both halves of the stream-debug answer, plus the session
 * they describe.
 *
 * It exists because the overlay cannot always be the surface. In the native app
 * the player lives inside a WebView whose touches belong to the RN gesture
 * layer, so the in-picture panel can never be opened there — the numbers have
 * to leave the player and be drawn by the host, next to the battery and link
 * details where the operator already looks.
 *
 * Everything in it is nullable for the same reason it is nullable everywhere
 * else in this file: a measurement that did not happen is not a zero.
 */
export interface StreamDebugSample {
  /** When this sample was taken, by the reporting player's clock. */
  readonly at: number
  /**
   * The verdict, computed HERE.
   *
   * The host that renders this sample is not always a web page — the native
   * app draws it in React Native — and `@camstack/ui-library` is a DOM
   * component library whose bundle a React Native app must not import (it
   * reaches for browser globals and for `Array.prototype.toSorted`, which
   * Hermes does not have). Sending the verdict rather than the function that
   * derives it keeps that boundary one-way.
   */
  readonly verdict: FreezeVerdictKind
  /** The session both halves describe; `null` before the player has one. */
  readonly sessionId: string | null
  readonly stats: WebrtcDebugStats | null
  readonly server: WebrtcSessionDebug | null
  /** Why the last server poll produced nothing, verbatim. */
  readonly serverError: string | null
  /** Whether the player was given a way to ask the server at all. */
  readonly serverWired: boolean
}
