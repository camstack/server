/**
 * One hub session run, as an immutable event log folded into a report.
 *
 * The run drives the real `CameraStreamPlayer`; this module never touches a
 * peer connection. The host feeds it what it observed — the hub's answer SDP
 * and trickled candidates (from the wrapped signaling callbacks), the
 * browser's own candidates and ICE / DTLS / peer transitions (from the
 * player's peer connection), the first decoded frame, and the player's 1 Hz
 * `StreamDebugSample` (the `webrtc-debug-stats` collector plus the server's
 * `getSessionDebug` answer). `at` is milliseconds since the run started.
 *
 * Every number in the report is `null` until something measured it (D393).
 */
import type { WebrtcSessionDebug } from '@camstack/types'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text'
import type { StreamDebugSample, WebrtcDebugStats } from '../stream-debug/webrtc-debug-stats'
import {
  countCandidateTypes,
  type HubCandidateSummary,
  type IceCandidateType,
  type ParsedIceCandidate,
  parseIceCandidate,
  summarizeHubCandidates,
} from './ice-candidates'
import {
  classifySessionVerdict,
  type DiagnosticIcePolicy,
  type SessionVerdict,
} from './session-verdict'

export type SessionRunEvent =
  | {
      readonly kind: 'offer-answered'
      readonly at: number
      readonly sessionId: string
      readonly sdpAnswer: string
    }
  | {
      readonly kind: 'hub-candidates'
      readonly at: number
      readonly candidates: readonly string[]
      readonly done: boolean
    }
  | {
      readonly kind: 'local-candidate'
      readonly at: number
      readonly candidate: string
      readonly url: string | null
      readonly relayProtocol: string | null
    }
  | { readonly kind: 'ice-state'; readonly at: number; readonly state: string }
  | { readonly kind: 'dtls-state'; readonly at: number; readonly state: string }
  | { readonly kind: 'peer-state'; readonly at: number; readonly state: string }
  | { readonly kind: 'first-frame'; readonly at: number }
  | { readonly kind: 'sample'; readonly at: number; readonly sample: StreamDebugSample }
  | { readonly kind: 'reconnect'; readonly at: number }
  | { readonly kind: 'error'; readonly at: number; readonly message: string }

export interface StateMark {
  readonly state: string
  readonly at: number
}

export interface LocalCandidateRecord {
  readonly candidate: ParsedIceCandidate
  readonly url: string | null
  readonly relayProtocol: string | null
}

export interface SessionRunState {
  readonly policy: DiagnosticIcePolicy
  readonly sessionIds: readonly string[]
  readonly sdpAnswer: string | null
  readonly trickled: readonly string[]
  readonly trickleDone: boolean | null
  readonly local: readonly LocalCandidateRecord[]
  readonly ice: readonly StateMark[]
  readonly dtls: readonly StateMark[]
  readonly peer: readonly StateMark[]
  readonly firstFrameAt: number | null
  /** The last sample that carried client stats — a later failed poll keeps it. */
  readonly lastStats: WebrtcDebugStats | null
  readonly lastServer: WebrtcSessionDebug | null
  readonly maxServerPacketsSent: number | null
  readonly lastServerError: string | null
  readonly samples: number
  readonly reconnects: number
  readonly errors: readonly string[]
}

export function emptySessionRun(policy: DiagnosticIcePolicy): SessionRunState {
  return {
    policy,
    sessionIds: [],
    sdpAnswer: null,
    trickled: [],
    trickleDone: null,
    local: [],
    ice: [],
    dtls: [],
    peer: [],
    firstFrameAt: null,
    lastStats: null,
    lastServer: null,
    maxServerPacketsSent: null,
    lastServerError: null,
    samples: 0,
    reconnects: 0,
    errors: [],
  }
}

function mark(list: readonly StateMark[], state: string, at: number): readonly StateMark[] {
  return list.at(-1)?.state === state ? list : [...list, { state, at }]
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

function reduceSample(state: SessionRunState, sample: StreamDebugSample): SessionRunState {
  return {
    ...state,
    samples: state.samples + 1,
    lastStats: sample.stats ?? state.lastStats,
    lastServer: sample.server ?? state.lastServer,
    maxServerPacketsSent: maxOrNull(
      state.maxServerPacketsSent,
      sample.server?.rtpPacketsSent ?? null,
    ),
    lastServerError: sample.serverError,
    sessionIds:
      sample.sessionId !== null && !state.sessionIds.includes(sample.sessionId)
        ? [...state.sessionIds, sample.sessionId]
        : state.sessionIds,
  }
}

export function reduceSessionRun(state: SessionRunState, event: SessionRunEvent): SessionRunState {
  switch (event.kind) {
    case 'offer-answered':
      return {
        ...state,
        sdpAnswer: state.sdpAnswer ?? event.sdpAnswer,
        sessionIds: state.sessionIds.includes(event.sessionId)
          ? state.sessionIds
          : [...state.sessionIds, event.sessionId],
      }
    case 'hub-candidates':
      return {
        ...state,
        trickled: [
          ...state.trickled,
          ...event.candidates.filter((c) => !state.trickled.includes(c)),
        ],
        trickleDone: event.done || state.trickleDone === true,
      }
    case 'local-candidate': {
      const candidate = parseIceCandidate(event.candidate)
      if (candidate === null) return state
      return {
        ...state,
        local: [...state.local, { candidate, url: event.url, relayProtocol: event.relayProtocol }],
      }
    }
    case 'ice-state':
      return { ...state, ice: mark(state.ice, event.state, event.at) }
    case 'dtls-state':
      return { ...state, dtls: mark(state.dtls, event.state, event.at) }
    case 'peer-state':
      return { ...state, peer: mark(state.peer, event.state, event.at) }
    case 'first-frame':
      return { ...state, firstFrameAt: state.firstFrameAt ?? event.at }
    case 'sample':
      return reduceSample(state, event.sample)
    case 'reconnect':
      return { ...state, reconnects: state.reconnects + 1 }
    case 'error':
      return { ...state, errors: [...state.errors, event.message] }
  }
}

export interface SessionTimeline {
  readonly iceConnectedMs: number | null
  readonly dtlsConnectedMs: number | null
  readonly firstFrameMs: number | null
  readonly iceFinalState: string | null
  readonly dtlsFinalState: string | null
}

export interface SessionPath {
  /** `local/remote` candidate types of the selected pair, e.g. `relay/host`. */
  readonly pairType: string | null
  readonly protocol: string | null
  readonly rttMs: number | null
}

export interface SessionMedia {
  readonly clientBytesReceived: number | null
  readonly clientPacketsReceived: number | null
  readonly framesDecoded: number | null
  readonly serverPacketsSent: number | null
  readonly serverAlive: boolean | null
  readonly servedTier: string | null
  readonly egressLeg: string | null
  readonly lossPercent: number | null
  readonly freezeCount: number | null
  readonly totalFreezeMs: number | null
  readonly pliCount: number | null
  readonly nackCount: number | null
}

export interface SessionLocalCandidates {
  readonly countByType: Readonly<Record<IceCandidateType, number>>
  readonly relayProtocols: readonly string[]
  readonly urls: readonly string[]
}

export interface HubSessionRunReport {
  readonly policy: DiagnosticIcePolicy
  readonly durationMs: number
  readonly sessionIds: readonly string[]
  readonly hub: HubCandidateSummary
  readonly local: SessionLocalCandidates
  readonly timeline: SessionTimeline
  readonly path: SessionPath
  readonly media: SessionMedia
  readonly reconnects: number
  readonly errors: readonly string[]
  readonly serverError: string | null
  readonly verdict: SessionVerdict
}

const CONNECTED_ICE = new Set(['connected', 'completed'])

function firstAt(list: readonly StateMark[], states: ReadonlySet<string>): number | null {
  return list.find((m) => states.has(m.state))?.at ?? null
}

const CONNECTED = new Set(['connected'])

function timelineOf(state: SessionRunState): SessionTimeline {
  const dtlsAt = firstAt(state.dtls, CONNECTED) ?? firstAt(state.peer, CONNECTED)
  const dtlsFinal = state.dtls.at(-1)?.state ?? state.peer.at(-1)?.state ?? null
  return {
    iceConnectedMs: firstAt(state.ice, CONNECTED_ICE),
    dtlsConnectedMs: dtlsAt,
    firstFrameMs: state.firstFrameAt,
    iceFinalState: state.ice.at(-1)?.state ?? null,
    dtlsFinalState: dtlsFinal,
  }
}

function mediaOf(state: SessionRunState): SessionMedia {
  const s = state.lastStats
  const srv = state.lastServer
  return {
    clientBytesReceived: s?.raw.bytesReceived ?? null,
    clientPacketsReceived: s?.packetsReceived ?? null,
    framesDecoded: s?.framesDecoded ?? null,
    serverPacketsSent: state.maxServerPacketsSent,
    serverAlive: srv?.alive ?? null,
    servedTier: srv?.servedTier ?? null,
    egressLeg: srv?.egressLeg ?? null,
    lossPercent: s?.lossPercent ?? null,
    freezeCount: s?.freezeCount ?? null,
    totalFreezeMs: s?.totalFreezeMs ?? null,
    pliCount: s?.pliCount ?? null,
    nackCount: s?.nackCount ?? null,
  }
}

function localOf(state: SessionRunState): SessionLocalCandidates {
  const unique = (xs: readonly (string | null)[]): readonly string[] => [
    ...new Set(xs.filter((x): x is string => x !== null)),
  ]
  return {
    countByType: countCandidateTypes(state.local.map((l) => l.candidate)),
    relayProtocols: unique(
      state.local.filter((l) => l.candidate.type === 'relay').map((l) => l.relayProtocol),
    ),
    urls: unique(state.local.map((l) => l.url)),
  }
}

export function finalizeSessionRun(
  state: SessionRunState,
  durationMs: number,
  t: UiTextFn = defaultUiText,
): HubSessionRunReport {
  const hub = summarizeHubCandidates({
    sdpAnswer: state.sdpAnswer,
    trickled: state.trickled,
    trickleDone: state.trickleDone,
  })
  const timeline = timelineOf(state)
  const media = mediaOf(state)
  const verdict = classifySessionVerdict(
    {
      policy: state.policy,
      durationMs,
      iceConnected: timeline.iceConnectedMs !== null,
      iceFinalState: timeline.iceFinalState,
      dtlsConnected: timeline.dtlsConnectedMs !== null,
      dtlsFinalState: timeline.dtlsFinalState,
      hubFlag: hub.flag,
      clientPacketsReceived: media.clientPacketsReceived,
      framesDecoded: media.framesDecoded,
      serverPacketsSent: media.serverPacketsSent,
      pliCount: media.pliCount,
      freezeCount: media.freezeCount,
      lossPercent: media.lossPercent,
    },
    t,
  )
  return {
    policy: state.policy,
    durationMs,
    sessionIds: state.sessionIds,
    hub,
    local: localOf(state),
    timeline,
    path: {
      pairType: state.lastStats?.candidatePairType ?? null,
      protocol: state.lastStats?.candidateProtocol ?? null,
      rttMs: state.lastStats?.rttMs ?? null,
    },
    media,
    reconnects: state.reconnects,
    errors: state.errors,
    serverError: state.lastServerError,
    verdict,
  }
}
