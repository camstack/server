/**
 * Reconnect schedule — the stream player's auto-retry policy as a pure
 * decision function.
 *
 * Why it exists as a module: the inline version had two silent behaviours the
 * operator ran into — exhaustion returned without a trace (the retry loop
 * just stopped, so a camera stayed dark while looking busy), and no attempt
 * was observable anywhere. Attempt in, action out: the component executes the
 * action (timer + callbacks) and can log/report every step; the backoff shape
 * and the exhaustion edge are pinned by tests.
 */

export interface ReconnectPolicy {
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly maxAttempts: number
}

/** Exponential backoff, ±20% jitter, bounded attempts. The bound exists so a
 *  permanently-dead stream stops consuming signaling; the EXHAUSTED action is
 *  the caller's cue to surface a hard error (never to go silent). */
export const RECONNECT_POLICY: ReconnectPolicy = {
  baseDelayMs: 1_500,
  maxDelayMs: 15_000,
  maxAttempts: 40,
}

export type ReconnectAction =
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'exhausted'; readonly attempts: number }

/**
 * Decide what attempt number `attempt` (0-based) should do. `random` is the
 * jitter source (unit interval), injectable for tests.
 */
export function nextReconnectAction(
  attempt: number,
  random: () => number = Math.random,
): ReconnectAction {
  if (attempt >= RECONNECT_POLICY.maxAttempts) {
    return { kind: 'exhausted', attempts: attempt }
  }
  const base = Math.min(RECONNECT_POLICY.maxDelayMs, RECONNECT_POLICY.baseDelayMs * 2 ** attempt)
  // ±20% jitter so a grid of players doesn't stampede the broker in unison.
  const delayMs = Math.round(base * (0.8 + random() * 0.4))
  return { kind: 'retry', delayMs }
}
