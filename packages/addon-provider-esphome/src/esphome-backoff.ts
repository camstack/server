/** First retry after a lost session. */
export const RECONNECT_BASE_MS = 1_000
/** No retry waits longer than this (before jitter), so a returning board is found within a minute. */
export const RECONNECT_MAX_MS = 60_000
const JITTER_FRACTION = 0.2

/**
 * Delay before reconnect attempt number `attempt` (0-based): doubles from the
 * base, bounded by the cap, with +-20% jitter so a rebooted network does not
 * see every board knock at once. `random` is injected (0..1) so the schedule is
 * a pure function. This is the only retry loop; a permanent failure never
 * enters it (D952).
 */
export function reconnectDelayMs(attempt: number, random: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 30)
  const raw = Math.min(RECONNECT_BASE_MS * 2 ** exponent, RECONNECT_MAX_MS)
  const jitter = 1 + (random * 2 - 1) * JITTER_FRACTION
  return raw * jitter
}
