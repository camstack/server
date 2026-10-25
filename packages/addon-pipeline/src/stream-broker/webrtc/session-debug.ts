import type {
  CamProfile,
  WebrtcClimbHold,
  WebrtcLadderDecision,
  WebrtcSessionDebug,
} from '@camstack/types'

/**
 * The SERVER half of the stream-debug overlay, as a pure projection.
 *
 * Every fact the overlay shows about a session is gathered into a plain
 * snapshot by `BrokerWebrtcServer.getSessionDebugSnapshot` and shaped here.
 * Splitting it this way is the point: the interesting behaviour is the
 * null-discipline (D393 — an unmeasured number is `null`, never `0`) and the
 * native/derived and copy/transcode naming, and none of that is reachable
 * through a test that has to stand up werift, a broker and a live camera.
 *
 * Nothing here reads a clock, a registry or a session object; `observedAt` is
 * supplied by the caller.
 */

/** What the live session object could tell us. `null` ⇒ no such session. */
export interface SessionDebugSessionFacts {
  /** `<deviceId>/<camStreamId>`. */
  readonly brokerId: string
  /** Whether an adaptive ladder is running for this session. */
  readonly adaptive: boolean
  readonly sourceCodec: string
  readonly negotiatedCodec: string
  /** Whether the egress leg re-encodes for this client. */
  readonly needsTranscode: boolean
  readonly rtpPacketsSent: number
  /** D42 — live, recorded and scrub share one track. */
  readonly trackMode: 'live' | 'recorded'
}

/** Where the media is ingested. Every field null when unresolved. */
export interface SessionDebugOrigin {
  readonly ingestNodeId: string | null
  readonly ingestIsRemote: boolean | null
}

/** The broker's own report about the rung it serves. */
export interface SessionDebugBrokerStats {
  readonly status: string
  readonly codec?: string
  readonly bitrateKbps: number
  readonly inputFps: number
  readonly uptimeMs: number
}

/** The adaptive controller's state. `null` ⇒ no ladder is running. */
export interface SessionDebugLadder {
  readonly lastDecision: WebrtcLadderDecision | null
  /** `[tier, failures]` pairs, in the order the controller holds them. */
  readonly failures: readonly (readonly [CamProfile, number])[]
  readonly upgradeCount: number
  /** Why the ladder is not climbing right now; null at the top or just moved. */
  readonly climbHold: WebrtcClimbHold | null
}

export interface SessionDebugInput {
  readonly sessionId: string
  /** Epoch ms — supplied, never read from a clock here. */
  readonly observedAt: number
  readonly session: SessionDebugSessionFacts | null
  /** The rung `auto` actually resolved to. Null when the broker is bound to
   *  no profile slot. */
  readonly servedTier: CamProfile | null
  readonly origin: SessionDebugOrigin | null
  readonly brokerStats: SessionDebugBrokerStats | null
  readonly ladder: SessionDebugLadder | null
}

/** `<deviceId>/<camStreamId>` → the camStreamId, or null when it is not one. */
function camStreamIdOf(brokerId: string): string | null {
  const slash = brokerId.indexOf('/')
  if (slash <= 0) return null
  const tail = brokerId.slice(slash + 1)
  return tail.length > 0 ? tail : null
}

/**
 * Native (the camera's own encode) vs derived (a rung this hub BUILT).
 * `unknown` when the brokerId does not parse — a guess here would tell an
 * operator the hub is transcoding when it is not, or the reverse.
 */
function sourceKindOf(camStreamId: string | null): WebrtcSessionDebug['sourceKind'] {
  if (camStreamId === null) return 'unknown'
  return camStreamId.startsWith('derived:') ? 'derived' : 'native'
}

const DEAD: Omit<WebrtcSessionDebug, 'sessionId' | 'observedAt'> = {
  alive: false,
  brokerId: null,
  camStreamId: null,
  sourceKind: 'unknown',
  adaptive: false,
  servedTier: null,
  ingestNodeId: null,
  ingestIsRemote: null,
  sourceCodec: null,
  negotiatedCodec: null,
  egressLeg: 'unknown',
  brokerStatus: null,
  brokerCodec: null,
  brokerBitrateKbps: null,
  brokerInputFps: null,
  brokerUptimeMs: null,
  rtpPacketsSent: null,
  trackMode: null,
  lastDecision: null,
  tierFailures: [],
  upgradeCount: null,
  climbHold: null,
}

export function projectSessionDebug(input: SessionDebugInput): WebrtcSessionDebug {
  const { session } = input
  if (session === null) {
    // A session id this server has never heard of and one that has ended give
    // the same answer, and it is the honest one: nothing was measured. Do not
    // fill any of it in from the surrounding state — a dead session's broker
    // stats describe SOMEONE ELSE'S stream.
    return { ...DEAD, sessionId: input.sessionId, observedAt: input.observedAt }
  }
  const camStreamId = camStreamIdOf(session.brokerId)
  const stats = input.brokerStats
  return {
    sessionId: input.sessionId,
    alive: true,
    observedAt: input.observedAt,
    brokerId: session.brokerId,
    camStreamId,
    sourceKind: sourceKindOf(camStreamId),
    adaptive: session.adaptive,
    servedTier: input.servedTier,
    ingestNodeId: input.origin?.ingestNodeId ?? null,
    ingestIsRemote: input.origin?.ingestIsRemote ?? null,
    sourceCodec: session.sourceCodec,
    negotiatedCodec: session.negotiatedCodec,
    egressLeg: session.needsTranscode ? 'transcode' : 'copy',
    brokerStatus: stats?.status ?? null,
    // An absent codec string is unknown, not empty.
    brokerCodec: stats?.codec !== undefined && stats.codec.length > 0 ? stats.codec : null,
    brokerBitrateKbps: stats?.bitrateKbps ?? null,
    brokerInputFps: stats?.inputFps ?? null,
    brokerUptimeMs: stats?.uptimeMs ?? null,
    rtpPacketsSent: session.rtpPacketsSent,
    trackMode: session.trackMode,
    lastDecision: input.ladder?.lastDecision ?? null,
    tierFailures: (input.ladder?.failures ?? []).map(([tier, failures]) => ({ tier, failures })),
    // Null when no ladder is running at all; 0 is a real count when one is.
    upgradeCount: input.ladder?.upgradeCount ?? null,
    climbHold: input.ladder?.climbHold ?? null,
  }
}
