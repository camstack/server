/**
 * Per-(device, source) motion-episode state transitions (D475).
 *
 * The operator's rule, for both motion kinds this repo has:
 *
 *  - **Sensor** (onboard firmware push, or a device reporting its own
 *    activity) — the episode always closes `MOTION_CLOSE_AFTER_MS` after the
 *    LAST rising edge. Every `detected:true` push re-arms the close.
 *  - **Analyzer** (this addon's frame-diff pass) — same shape: it writes its
 *    own on/off, always after `MOTION_CLOSE_AFTER_MS` of calm since the last
 *    relevant movement.
 *
 * One row per episode, not one row per push — `MOTION_EVENT_HEARTBEAT_MS`
 * used to re-insert a row every 5 s while motion stayed on; an open episode
 * now just keeps extending until the quiet window elapses, and is UPDATEd
 * once at close with `durationMs` and the `edges` it collected.
 *
 * Two clocks, deliberately kept apart:
 *
 *  - `lastOnAt` — the last time ANY `detected:true` observation arrived,
 *    transition or not. Drives the close-timer re-arm and `durationMs`
 *    (`lastOnAt - startedAt`, never `closedAt - startedAt` — the 15 s is the
 *    quiet CONFIRMATION, not movement, and folding it in would report 15 s
 *    of motion for an instantaneous trigger).
 *  - `edges` — ms offsets (from `startedAt`) of genuine off→on TRANSITIONS
 *    only, not every observation. A firmware source that keepalives at ~1 Hz
 *    the whole time motion is happening (Reolink, Hikvision — see
 *    `motion-marker-policy.ts`) produces exactly ONE edge for one continuous
 *    burst; a source that reports an explicit `false` mid-episode and then a
 *    fresh `true` before the quiet window elapses produces another. This is
 *    "ogni evento on si deve salvare" [every ON event must be saved] — every ON EVENT, not every tick.
 *
 * Pure. No timer, no store, no await — the caller (`MotionEpisodeTracker`)
 * owns the clock, the map, and the actual writes.
 */

export interface MotionEpisodeOpenState {
  /** The row id this episode owns, from the INSERT that opened it. */
  readonly eventId: number
  /** The episode's first rising edge — `edges[0]` is always `0` relative to this. */
  readonly startedAt: number
  /** The last `detected:true` observation, transition or not. */
  readonly lastOnAt: number
  /** Ms offsets from `startedAt` of every genuine off→on transition so far. */
  readonly edgeOffsetsMs: readonly number[]
}

/** What the tracker remembers per (deviceId, source). */
export interface MotionSignalState {
  /** The raw last observation, used only to tell a transition from a
   *  continuation — NOT the same question as whether an episode is open. */
  readonly lastDetected: boolean
  /** `null` when no episode is currently open for this key. */
  readonly episode: MotionEpisodeOpenState | null
}

export type MotionSignalDecision =
  /** `detected:false` with nothing to remember — never seen this key before. */
  | { readonly kind: 'noop' }
  /** `detected:false` observed. The episode (if any) is untouched — it closes
   *  on its OWN timer, never on an explicit off. */
  | { readonly kind: 'observed-off' }
  /** `detected:true`, no episode open — the caller must INSERT a new row. */
  | { readonly kind: 'open-episode' }
  /** `detected:true`, episode already open — extend it. `isNewEdge` tells the
   *  caller whether this tick is a genuine transition (append to `edges`,
   *  fire the transition-only side effects) or a plain continuation. */
  | {
      readonly kind: 'extend-episode'
      readonly next: MotionEpisodeOpenState
      readonly isNewEdge: boolean
    }

/**
 * Decide what one `(detected, timestamp)` observation does to the episode
 * state for one `(deviceId, source)` key. `prior` is `undefined` the first
 * time this key is ever observed (fresh process, or a key never seen).
 */
export function decideMotionSignal(
  prior: MotionSignalState | undefined,
  detected: boolean,
  timestamp: number,
): MotionSignalDecision {
  if (!detected) {
    if (prior === undefined) return { kind: 'noop' }
    return { kind: 'observed-off' }
  }

  if (prior?.episode == null) {
    // No open episode: this tick opens one, whatever `lastDetected` said
    // before (a stale `true` from a process that crashed with an episode
    // still open has nothing left to extend — this is a fresh start).
    return { kind: 'open-episode' }
  }

  const isNewEdge = prior.lastDetected === false
  const edgeOffsetsMs = isNewEdge
    ? [...prior.episode.edgeOffsetsMs, timestamp - prior.episode.startedAt]
    : prior.episode.edgeOffsetsMs
  return {
    kind: 'extend-episode',
    next: { ...prior.episode, lastOnAt: timestamp, edgeOffsetsMs },
    isNewEdge,
  }
}

/** `lastOnAt - startedAt` — see the module doc for why not `closedAt - startedAt`. */
export function motionEpisodeDurationMs(state: MotionEpisodeOpenState): number {
  return state.lastOnAt - state.startedAt
}
