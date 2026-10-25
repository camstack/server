/**
 * Is the round-trip time STABLE? One of the three conditions a try-climb needs
 * (D635, round 2): a queue building in front of the viewer shows up as RTT
 * growing well before it shows as loss, and climbing into a filling queue is
 * the one move guaranteed to stutter.
 *
 * Stable = the spread over the window is within `max(20 ms, 50 % of the
 * minimum)`. 20 ms absorbs a LAN/Wi-Fi's ordinary jitter (the client reports
 * `currentRoundTripTime` rounded to ms); 50 % of the floor is the point where
 * a remote path's RTT is being inflated by queueing rather than wobbling.
 * Fewer than three samples, or none that is positive, is UNKNOWN — not stable,
 * not unstable (D315).
 */
export type RttStability = 'stable' | 'unstable' | 'unknown'

/** 16 s — the longest delivery window, so both halves of a try look at the same span. */
const RTT_WINDOW_MS = 16_000
const MIN_SAMPLES = 3
const MIN_SPREAD_MS = 20
const SPREAD_FRACTION = 0.5

interface RttSample {
  readonly rttMs: number
  readonly at: number
}

export class RttWindow {
  private samples: readonly RttSample[] = []

  observe(rttMs: number | null, now: number): void {
    if (rttMs === null || !Number.isFinite(rttMs) || rttMs <= 0) return
    this.samples = [...this.samples.filter((s) => now - s.at <= RTT_WINDOW_MS), { rttMs, at: now }]
  }

  stability(now: number): RttStability {
    const recent = this.samples.filter((s) => now - s.at <= RTT_WINDOW_MS)
    if (recent.length < MIN_SAMPLES) return 'unknown'
    const values = recent.map((s) => s.rttMs)
    const min = Math.min(...values)
    const spread = Math.max(...values) - min
    return spread <= Math.max(MIN_SPREAD_MS, min * SPREAD_FRACTION) ? 'stable' : 'unstable'
  }
}
