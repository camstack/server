/**
 * What the player reports to the broker every ~2 s
 * (`networkQuality.reportClientStats`), as a pure step over two `getStats`
 * readings — so the two ways it used to lie can be pinned (D635 round 3):
 *
 * - Across a PC swap (a tier change's make-before-break) the byte baseline was
 *   the OLD connection's, so the new PC's first reading clamped to 0 kbps; and
 *   while a renegotiation was in flight the reporter read a closing PC. Both
 *   zeros were matched by the broker against real sends (review I1). A new PC
 *   now re-baselines, and nothing is reported while renegotiating.
 * - The downlink probe never reached the broker unless it justified a climb.
 *   The sample now carries the latest probe whatever it read, with its age
 *   (review I4), so "measured slow" is no longer indistinguishable from
 *   "failed".
 */

/** Client-observed network conditions. Matches the `networkQuality.reportClientStats`
 *  mutation input (minus `deviceId`, which the caller adds). */
export interface ClientNetworkSample {
  readonly rttMs: number
  readonly jitterMs: number
  readonly estimatedBandwidthKbps: number
  readonly packetLossPercent: number
  /** Latest `/adaptive-probe` reading, Mbps, whatever it read; absent = never / failed. */
  readonly downlinkMbps?: number
  /** Age of that reading now, ms. */
  readonly downlinkAgeMs?: number
}

/** One inbound-video `getStats` reading, and the connection it came from. */
export interface InboundReading {
  /** The RTCPeerConnection read — identity only. */
  readonly pc: object
  readonly lost: number
  readonly recv: number
  readonly bytes: number
  /** getStats timestamp, ms. */
  readonly ts: number
  readonly rttS: number
  readonly jitterS: number
}

/** The latest probe as the player holds it. */
export interface ProbeReading {
  readonly mbps: number
  readonly ageMs: number
}

export interface SampleContext {
  /** A renegotiation (tier change) is in flight: the PC being read is on its way out. */
  readonly renegotiating: boolean
  readonly probe: ProbeReading | null
}

export interface SampleStep {
  /** The reading to diff the next one against; null = start over. */
  readonly baseline: InboundReading | null
  /** What to report now; null = report nothing this window. */
  readonly sample: ClientNetworkSample | null
}

/** Schema bound of `estimatedBandwidthKbps` / `packetLossPercent`. */
const MAX_LOSS_PERCENT = 100

export function nextClientSample(
  prev: InboundReading | null,
  cur: InboundReading,
  ctx: SampleContext,
): SampleStep {
  if (ctx.renegotiating) return { baseline: null, sample: null }
  if (prev === null || prev.pc !== cur.pc || cur.ts <= prev.ts)
    return { baseline: cur, sample: null }
  const dLost = Math.max(0, cur.lost - prev.lost)
  const dRecv = Math.max(0, cur.recv - prev.recv)
  const denom = dLost + dRecv
  const packetLossPercent = denom > 0 ? Math.min(MAX_LOSS_PERCENT, (dLost / denom) * 100) : 0
  const estimatedBandwidthKbps = Math.max(
    0,
    Math.round(((cur.bytes - prev.bytes) * 8) / (cur.ts - prev.ts)),
  )
  return {
    baseline: cur,
    sample: {
      rttMs: Math.round(cur.rttS * 1000),
      jitterMs: Math.round(cur.jitterS * 1000),
      estimatedBandwidthKbps,
      packetLossPercent,
      ...(ctx.probe !== null
        ? { downlinkMbps: ctx.probe.mbps, downlinkAgeMs: ctx.probe.ageMs }
        : {}),
    },
  }
}
