/**
 * Browser-side probes behind "Test each endpoint" and the NAT mapping check.
 *
 * Everything runs in the operator's browser against real `RTCPeerConnection`s;
 * the only server round-trip is fetching the ICE server list.
 *
 *  - `gatherCandidates` — one peer connection, a given server set: which
 *    candidate types it produces, which server URL produced each (the ICE
 *    event's `url`) and, for a relay, the transport to the TURN server
 *    (`relayProtocol`: udp / tcp / tls).
 *  - `relayLoopback` — two peer connections in this page, both forced to
 *    `relay`: the ONLY way they connect is through the TURN server, so a
 *    connect proves allocation and forwarding work, and the selected pair
 *    gives the relay RTT and the local relay protocol from `getStats()`.
 *    (A same-page loopback with policy `all` proves nothing — the two peers
 *    connect host↔host — which is why it is not offered.)
 *
 * Credentials are attached to `turn:`/`turns:` entries only and never leave
 * this module: nothing here logs or returns them.
 */
import { type ParsedIceCandidate, parseIceCandidate } from './ice-candidates'

/** A single flattened ICE server URL with optional credentials. */
export interface IceServerConfig {
  readonly url: string
  readonly username?: string
  readonly credential?: string
}

export interface ProbedCandidate {
  readonly candidate: ParsedIceCandidate
  /** The server URL the browser says produced this candidate; null when not reported. */
  readonly url: string | null
  /** udp / tcp / tls between the browser and the TURN server, relay candidates only. */
  readonly relayProtocol: string | null
  /** Milliseconds from gather start. */
  readonly tMs: number
}

export interface GatherResult {
  readonly candidates: readonly ProbedCandidate[]
  readonly durationMs: number
  readonly timedOut: boolean
  readonly error: string | null
}

export interface RelayLoopbackResult {
  readonly connected: boolean
  readonly state: string
  readonly rttMs: number | null
  readonly relayProtocol: string | null
  readonly durationMs: number
  readonly error: string | null
}

function toRtcIceServers(servers: readonly IceServerConfig[]): RTCIceServer[] {
  return servers.map((s) => {
    const isTurn = /^turns?:/i.test(s.url)
    if (isTurn && s.username !== undefined && s.credential !== undefined) {
      return { urls: s.url, username: s.username, credential: s.credential }
    }
    return { urls: s.url }
  })
}

/** `RTCPeerConnectionIceEvent.url` — a real field missing from this lib.dom. */
function iceEventUrl(e: RTCPeerConnectionIceEvent): string | null {
  if ('url' in e && typeof e.url === 'string' && e.url.length > 0) return e.url
  return null
}

/** `RTCIceCandidate.relayProtocol` — Chromium and WebKit report it; lib.dom does not type it. */
export function candidateRelayProtocol(c: RTCIceCandidate): string | null {
  if ('relayProtocol' in c && typeof c.relayProtocol === 'string' && c.relayProtocol.length > 0) {
    return c.relayProtocol
  }
  return null
}

/** One local candidate from an ICE event, or null for the end-of-candidates event. */
export function probedCandidateFromEvent(
  e: RTCPeerConnectionIceEvent,
  tMs: number,
): ProbedCandidate | null {
  const raw = e.candidate?.candidate
  if (e.candidate === null || raw === undefined || raw.length === 0) return null
  const candidate = parseIceCandidate(raw)
  if (candidate === null) return null
  return {
    candidate,
    url: iceEventUrl(e),
    relayProtocol: candidateRelayProtocol(e.candidate),
    tMs,
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function gatherCandidates(
  servers: readonly IceServerConfig[],
  policy: RTCIceTransportPolicy,
  timeoutMs = 8000,
): Promise<GatherResult> {
  const start = performance.now()
  const candidates: ProbedCandidate[] = []
  const pc = new RTCPeerConnection({
    iceServers: toRtcIceServers(servers),
    iceTransportPolicy: policy,
  })
  try {
    // A data channel forces ICE gathering without a media track.
    pc.createDataChannel('probe')
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), timeoutMs)
      pc.addEventListener('icecandidate', (e: RTCPeerConnectionIceEvent) => {
        if (e.candidate === null) {
          clearTimeout(timer)
          resolve(false)
          return
        }
        const probed = probedCandidateFromEvent(e, performance.now() - start)
        if (probed !== null) candidates.push(probed)
      })
    })
    await pc.setLocalDescription(await pc.createOffer())
    const timedOut = await done
    return { candidates, durationMs: performance.now() - start, timedOut, error: null }
  } catch (err) {
    return {
      candidates,
      durationMs: performance.now() - start,
      timedOut: false,
      error: errorText(err),
    }
  } finally {
    pc.close()
  }
}

/** Every stats field the loopback reads, all optional — a browser reports what it reports. */
interface PairStatsLike {
  readonly id?: string
  readonly type?: string
  readonly nominated?: boolean
  readonly selected?: boolean
  readonly state?: string
  readonly currentRoundTripTime?: number
  readonly localCandidateId?: string
  readonly relayProtocol?: string
  readonly selectedCandidatePairId?: string
}

function selectedPairFacts(report: RTCStatsReport): {
  rttMs: number | null
  relayProtocol: string | null
} {
  const byId = new Map<string, PairStatsLike>()
  const pairs: PairStatsLike[] = []
  const selected: { id: string | null } = { id: null }
  report.forEach((raw: RTCStats) => {
    const s: PairStatsLike = raw
    if (s.id !== undefined) byId.set(s.id, s)
    if (s.type === 'candidate-pair') pairs.push(s)
    if (s.type === 'transport' && s.selectedCandidatePairId !== undefined) {
      selected.id = s.selectedCandidatePairId
    }
  })
  const pair =
    pairs.find((p) => selected.id !== null && p.id === selected.id) ??
    pairs.find((p) => p.selected === true) ??
    pairs.find((p) => p.nominated === true && p.state === 'succeeded') ??
    null
  if (pair === null) return { rttMs: null, relayProtocol: null }
  const local = pair.localCandidateId !== undefined ? byId.get(pair.localCandidateId) : undefined
  return {
    rttMs:
      typeof pair.currentRoundTripTime === 'number'
        ? Math.round(pair.currentRoundTripTime * 1000)
        : null,
    relayProtocol: typeof local?.relayProtocol === 'string' ? local.relayProtocol : null,
  }
}

export async function relayLoopback(
  servers: readonly IceServerConfig[],
  timeoutMs = 10000,
): Promise<RelayLoopbackResult> {
  const start = performance.now()
  const config: RTCConfiguration = {
    iceServers: toRtcIceServers(servers),
    iceTransportPolicy: 'relay',
  }
  const pcA = new RTCPeerConnection(config)
  const pcB = new RTCPeerConnection(config)
  try {
    pcA.createDataChannel('probe')
    // Same-page signaling: each side's candidate goes straight to the other.
    // A late candidate after close is a no-op, never an unhandled rejection.
    pcA.addEventListener('icecandidate', (e) => {
      if (e.candidate) void pcB.addIceCandidate(e.candidate).catch(() => undefined)
    })
    pcB.addEventListener('icecandidate', (e) => {
      if (e.candidate) void pcA.addIceCandidate(e.candidate).catch(() => undefined)
    })
    const connected = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      pcA.addEventListener('iceconnectionstatechange', () => {
        const st = pcA.iceConnectionState
        if (st === 'connected' || st === 'completed') {
          clearTimeout(timer)
          resolve(true)
        } else if (st === 'failed' || st === 'closed') {
          clearTimeout(timer)
          resolve(false)
        }
      })
    })
    const offer = await pcA.createOffer()
    await pcA.setLocalDescription(offer)
    await pcB.setRemoteDescription(offer)
    const answer = await pcB.createAnswer()
    await pcB.setLocalDescription(answer)
    await pcA.setRemoteDescription(answer)
    const ok = await connected
    const facts = ok
      ? selectedPairFacts(await pcA.getStats())
      : { rttMs: null, relayProtocol: null }
    return {
      connected: ok,
      state: pcA.iceConnectionState,
      rttMs: facts.rttMs,
      relayProtocol: facts.relayProtocol,
      durationMs: performance.now() - start,
      error: null,
    }
  } catch (err) {
    return {
      connected: false,
      state: pcA.iceConnectionState,
      rttMs: null,
      relayProtocol: null,
      durationMs: performance.now() - start,
      error: errorText(err),
    }
  } finally {
    pcA.close()
    pcB.close()
  }
}
