/**
 * THE rule that decides whether a battery camera's `sleeping` slice moves.
 *
 * Extracted from `ReolinkCamera.commitSleepState` so the rule can be driven
 * as a state machine by a test instead of being asserted from the source
 * text. Constructing a `ReolinkCamera` needs the whole `DeviceContext`, which
 * is why the surrounding specs read this file with a regex — and a regex
 * cannot tell a rule that works from a rule that merely still exists. The
 * defect below was live for weeks under a green suite that pinned its
 * *shape*.
 *
 * ## The two clocks that used to be one
 *
 * Three writers reach this slice, and only two of them are FIRST-HAND:
 *
 * - `simple-event` / `sleep-poll` — the library's own reading of the camera.
 *   Partly inference from socket I/O, hence the anti-flap hysteresis.
 * - `confirmed-wake` / `hub-summary` — this process issued a wake, or read
 *   the parent's channel summary as part of one, and watched it land. First
 *   hand and NOW.
 * - `hub-reconcile` — the parent NVR's periodic channel summary, pushed by
 *   `applyHubSleepState` roughly once a minute. Firmware truth, but LAGGING:
 *   measured more than 75 s behind an `awake` push (2026-08-16).
 *
 * Every one of them used to stamp the same `sleepStateChangedAt`, and the
 * anti-flap window measures against it. So a lagging `hub-reconcile` commit
 * of `sleeping: true` armed a 30 s window against the one source that is
 * both first-hand and current, and the camera's real wake was thrown away.
 * Measured on the live hub (2026-09-22, device 3629, `provider-reolink`):
 *
 *   06:06:15.105  battery sleep state committed  {sleeping: true, source: 'hub-summary'}
 *   06:06:16.8    ignoring sleep inference flap  {next: false, sinceLastChangeMs: 1723}
 *   06:08:41.609  battery sleep state committed  {sleeping: false, source: 'simple-event'}
 *                 → 2 min 26 s reported asleep while awake
 *
 *   06:37:41.035  battery sleep state committed  {sleeping: true, source: 'hub-summary'}
 *   06:37:42.5    ignoring sleep inference flap  {next: false, sinceLastChangeMs: 1479}
 *   06:38:50.825  battery sleep state committed  {sleeping: false, source: 'simple-event'}
 *                 → 1 min 10 s reported asleep while awake
 *
 * Seven refusals in twelve hours across the fleet's battery cameras, every
 * single one of them in the `→ awake` direction.
 *
 * So the periodic reconcile gets its own source name and stamps NOTHING. The
 * timestamp keeps its one meaning — "when a first-hand observation last moved
 * this slice" — which is also exactly what the summary grace below needs, and
 * was already what its docstring claimed it held.
 */

/**
 * Who is asking for the slice to move.
 *
 * - `simple-event` — an `awake` / `sleeping` push routed from the camera or
 *   its parent, partly inferred by the library from socket I/O.
 * - `sleep-poll` — this addon's own passive `getSleepStatus` tick.
 * - `confirmed-wake` — this process issued a wake and is answering `awoke`.
 * - `hub-summary` — the parent's channel summary read AS PART OF a wake we
 *   drove, i.e. observed now.
 * - `hub-reconcile` — the parent's periodic channel summary sweep. Firmware
 *   truth, but up to minutes behind.
 */
export type SleepCommitSource =
  | 'simple-event'
  | 'sleep-poll'
  | 'hub-summary'
  | 'hub-reconcile'
  | 'confirmed-wake'

/**
 * Hysteresis is ASYMMETRIC, because the two directions have very different
 * costs when we get them wrong.
 *
 * `→ awake` (`WAKE_HYSTERESIS_MS`): expensive if wrong. Believing an asleep
 * camera is awake un-gates every background probe and makes `wakeForStream`
 * early-out without actually waking. Keep the window >= the library's UDP
 * inference cycle (~12 s on battery cams with idle-disconnect) and >= its
 * `getIdleDisconnectTimeoutMs` (30 s default).
 *
 * `→ sleeping` (`SLEEP_HYSTERESIS_MS`): cheap if wrong. Believing an awake
 * camera is asleep only means we skip background probes and serve cached
 * values; the demand paths still drive a real wake. The old symmetric 30 s
 * window was LONGER than the camera's own awake window (~14 s), so a natural
 * wake→sleep cycle had its `sleeping` transition dropped and the slice stayed
 * stuck on "awake" while the camera slept.
 */
export const WAKE_HYSTERESIS_MS = 30_000
/** See {@link WAKE_HYSTERESIS_MS}. */
export const SLEEP_HYSTERESIS_MS = 5_000

/**
 * How long a freshly committed FIRST-HAND state is protected from a lagging
 * summary's awake→sleeping flip. The summary lags real pushes by over a
 * minute (measured >75 s on 2026-08-16); 3 min covers two full
 * discovery-refresh cycles of lag without letting a genuinely stuck "awake"
 * slice stand forever — the reconcile still wins after the grace, which is
 * exactly its recovery role.
 */
export const HUB_SUMMARY_SLEEP_GRACE_MS = 180_000

export interface SleepCommitInput {
  /** What the slice says right now. */
  readonly current: boolean
  /** What the caller wants it to say. */
  readonly next: boolean
  readonly source: SleepCommitSource
  /**
   * When a FIRST-HAND observation last moved this slice, or `0` when none
   * ever has. Never stamped by `hub-reconcile` — that is the whole fix.
   */
  readonly lastFirstHandCommitAt: number
  readonly nowMs: number
}

/** Why a commit was refused, for the log line that has to name it. */
export interface SleepCommitRefusal {
  readonly kind: 'refused'
  readonly reason: 'hysteresis' | 'summary-grace'
  /** The window the refusal was measured against. */
  readonly windowMs: number
  /** How long ago the last first-hand commit was. */
  readonly sinceLastChangeMs: number
}

export type SleepCommitDecision =
  | { readonly kind: 'unchanged' }
  | SleepCommitRefusal
  | {
      readonly kind: 'commit'
      /**
       * Whether this commit re-stamps `lastFirstHandCommitAt`. False only for
       * `hub-reconcile`, which is a lagging reconcile and must not arm the
       * anti-flap window against the fresher sources.
       */
      readonly stampFirstHand: boolean
    }

/** A source whose verdict comes from the parent NVR's channel summary. */
function isSummarySourced(source: SleepCommitSource): boolean {
  return source === 'hub-summary' || source === 'hub-reconcile'
}

/**
 * Decide one commit. Pure: the caller owns the slice, the clock and the log.
 *
 * Order of the gates, and why:
 *  1. No-op first — re-asserting the current value is never a transition.
 *  2. A summary-sourced verdict is firmware state, not socket inference, so
 *     the anti-flap window does not apply to it at all.
 *  3. A `confirmed-wake` in the `→ awake` direction is first-hand evidence
 *     this process produced: gating it with the anti-flap window is what
 *     stranded 3825's mirror on "asleep" while `wakeForStream` answered
 *     `awoke: true`.
 *  4. Everything else is subject to the asymmetric hysteresis.
 *  5. A summary flip toward `sleeping` is refused while a first-hand
 *     observation inside the grace says otherwise.
 */
export function decideSleepCommit(input: SleepCommitInput): SleepCommitDecision {
  const { current, next, source, lastFirstHandCommitAt, nowMs } = input
  if (current === next) return { kind: 'unchanged' }

  const summarySourced = isSummarySourced(source)
  const firstHandWake = source === 'confirmed-wake' && next === false
  const sinceLastChangeMs = nowMs - lastFirstHandCommitAt

  if (!summarySourced && !firstHandWake) {
    const windowMs = next ? SLEEP_HYSTERESIS_MS : WAKE_HYSTERESIS_MS
    if (lastFirstHandCommitAt > 0 && sinceLastChangeMs < windowMs) {
      return { kind: 'refused', reason: 'hysteresis', windowMs, sinceLastChangeMs }
    }
  }

  if (
    summarySourced &&
    next === true &&
    lastFirstHandCommitAt > 0 &&
    sinceLastChangeMs < HUB_SUMMARY_SLEEP_GRACE_MS
  ) {
    return {
      kind: 'refused',
      reason: 'summary-grace',
      windowMs: HUB_SUMMARY_SLEEP_GRACE_MS,
      sinceLastChangeMs,
    }
  }

  return { kind: 'commit', stampFirstHand: source !== 'hub-reconcile' }
}
