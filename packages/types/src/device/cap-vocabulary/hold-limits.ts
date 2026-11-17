/**
 * Hold limits a cap's vocabulary may declare on an action (D1061).
 *
 * A one-shot command (feed, run a script) has no lasting state to confirm; it
 * holds its in-progress flag just long enough that a second tap, before the
 * device reports, is seen as "already running" and refused.
 */
export const ONE_SHOT_HOLD_MS = 10_000
