/**
 * Pure helpers behind the recorded-playback census (`embed:playback stats`).
 *
 * After a recorded seek lands, the viewer sometimes receives frames and decodes
 * none of them for seconds. Two causes fit: the land prefix burst lost packets
 * (the decoder waits for an IDR), or no decodable IDR reached the decoder. The
 * counters here (keyframes decoded, PLI/NACK/FIR sent, packets lost, windowed
 * jitter-buffer delay) and `msToFirstDecode` tell them apart.
 */

/** The cumulative inbound-rtp video counters one getStats() read yields. */
export interface InboundVideoCounters {
  readonly framesReceived: number
  readonly framesDecoded: number
  readonly framesDropped: number
  readonly keyFramesDecoded: number
  readonly pliCount: number
  readonly nackCount: number
  readonly firCount: number
  readonly packetsLost: number
  readonly jitterBufferDelay: number
  readonly jitterBufferEmittedCount: number
}

/** Per-window deltas of the loss-recovery counters. */
export interface RecoveryDeltas {
  readonly dKeyFramesDecoded: number
  readonly dPli: number
  readonly dNack: number
  readonly dFir: number
  readonly dPacketsLost: number
  /** Mean jitter-buffer delay of the frames emitted THIS window (ms); 0 when none. */
  readonly windowJitterMs: number
}

export function recoveryDeltas(
  prev: InboundVideoCounters,
  cur: InboundVideoCounters,
): RecoveryDeltas {
  const emitted = cur.jitterBufferEmittedCount - prev.jitterBufferEmittedCount
  const delay = cur.jitterBufferDelay - prev.jitterBufferDelay
  return {
    dKeyFramesDecoded: cur.keyFramesDecoded - prev.keyFramesDecoded,
    dPli: cur.pliCount - prev.pliCount,
    dNack: cur.nackCount - prev.nackCount,
    dFir: cur.firCount - prev.firCount,
    dPacketsLost: cur.packetsLost - prev.packetsLost,
    windowJitterMs: emitted > 0 ? Math.round((delay / emitted) * 1000) : 0,
  }
}

/** True when a control-channel text frame is the server's `playing`/`paused` state (a seek landed). */
export function isLandMessage(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const t = 't' in parsed ? parsed.t : undefined
  const state = 'state' in parsed ? parsed.state : undefined
  return t === 'state' && (state === 'playing' || state === 'paused')
}

/** What one land measured. `msToFirstDecode` is null when nothing decoded in time. */
export interface LandFirstDecode {
  readonly msToFirstDecode: number | null
  readonly keyFramesDecoded: number
  readonly timedOut: boolean
}

/**
 * Time from a land to the first decoded frame. `observe` is fed a fresh
 * counter read each poll and answers exactly once per land.
 */
export class LandWatch {
  private landedAt: number | null = null
  private baseFramesDecoded = 0

  /** Start (or restart) the measurement at `now`, against the current counters. */
  mark(now: number, framesDecoded: number): void {
    this.landedAt = now
    this.baseFramesDecoded = framesDecoded
  }

  get active(): boolean {
    return this.landedAt !== null
  }

  observe(
    now: number,
    framesDecoded: number,
    keyFramesDecoded: number,
    timeoutMs: number,
  ): LandFirstDecode | null {
    if (this.landedAt === null) return null
    const elapsed = now - this.landedAt
    if (framesDecoded > this.baseFramesDecoded) {
      this.landedAt = null
      return { msToFirstDecode: Math.round(elapsed), keyFramesDecoded, timedOut: false }
    }
    if (elapsed >= timeoutMs) {
      this.landedAt = null
      return { msToFirstDecode: null, keyFramesDecoded, timedOut: true }
    }
    return null
  }
}

function num(rec: Record<string, unknown>, key: string): number {
  const v = rec[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Give up waiting for a first decode after a land. */
export const LAND_FIRST_DECODE_TIMEOUT_MS = 30_000

/** The inbound-rtp VIDEO counters of one getStats() report, or null when it has none. */
export function readInboundVideo(report: {
  forEach: (cb: (stat: RTCStats) => void) => void
}): InboundVideoCounters | null {
  let found: InboundVideoCounters | null = null
  report.forEach((stat) => {
    if (stat.type !== 'inbound-rtp') return
    const rec: Record<string, unknown> = { ...stat }
    if ((rec.kind ?? rec.mediaType) !== 'video') return
    found = {
      framesReceived: num(rec, 'framesReceived'),
      framesDecoded: num(rec, 'framesDecoded'),
      framesDropped: num(rec, 'framesDropped'),
      keyFramesDecoded: num(rec, 'keyFramesDecoded'),
      pliCount: num(rec, 'pliCount'),
      nackCount: num(rec, 'nackCount'),
      firCount: num(rec, 'firCount'),
      packetsLost: num(rec, 'packetsLost'),
      jitterBufferDelay: num(rec, 'jitterBufferDelay'),
      jitterBufferEmittedCount: num(rec, 'jitterBufferEmittedCount'),
    }
  })
  return found
}
