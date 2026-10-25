/**
 * A rung's expected bitrate, from the broker's OWN measurement of it — what
 * the adaptive ladder's capacity gate compares the receiver's estimate (REMB)
 * against before climbing to that rung (D635).
 *
 * Measured, not declared: a camera's configured bitrate is a ceiling for VBR
 * and a static scene sends a fraction of it. `null` when the broker has
 * measured nothing — an unknown rate must never read as 0 kbps, which would
 * make every estimate look sufficient (D393).
 */
import type { BrokerStats } from '@camstack/types'

/** The slice of `BrokerStats` the estimate reads. */
export type RungStats = Pick<BrokerStats, 'status' | 'bitrateKbps' | 'totalBytes' | 'uptimeMs'>

/**
 * Shortest lifetime whose average means anything: 4 000 ms ≈ one GOP on the
 * cameras this hub serves; less than that is one IDR divided by nothing.
 */
const MIN_AVERAGE_UPTIME_MS = 4_000

export function expectedRungKbps(stats: RungStats): number | null {
  const lifetime =
    stats.totalBytes > 0 && stats.uptimeMs >= MIN_AVERAGE_UPTIME_MS
      ? Math.round((stats.totalBytes * 8) / stats.uptimeMs)
      : null
  // The 2 s window is current but IDR-dependent; the lifetime average carries
  // the IDRs but lags. While streaming, take the larger — the gate should err
  // toward asking for MORE room, not less.
  const windowKbps =
    stats.status === 'streaming' && stats.bitrateKbps > 0 ? stats.bitrateKbps : null
  if (windowKbps === null) return lifetime
  return lifetime === null ? windowKbps : Math.max(windowKbps, lifetime)
}
