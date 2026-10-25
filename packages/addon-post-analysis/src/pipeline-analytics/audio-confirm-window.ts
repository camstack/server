/**
 * Corroboration window for classified audio — "M occurrences of the same
 * sound inside N seconds, or it is not an event".
 *
 * This is the EVENT GENERATOR's brake, and it is the same shape the
 * Notification Center already uses for audio rules (`confirmHits` inside
 * `confirmWindowSec`, `AudioWatcher.observeLabel`). One sound heard once is
 * the single-frame false positive; the same sound heard twice seconds apart
 * is an episode.
 *
 * PURE: no timers, no wall clock of its own. The clock enters only as
 * `timestampMs`, so every decision is deterministic and unit-testable — and
 * the state is returned, never mutated, matching `observeLevel` next door.
 *
 * Counting is PER CLASS. A bark and a voice in the same five seconds are two
 * unrelated observations; letting them corroborate each other would confirm
 * on "something happened", which is what the window exists to refuse.
 */

export interface AudioConfirmState {
  /** className → timestamps (ms) of the hits still inside the window. */
  readonly hitsByClass: ReadonlyMap<string, readonly number[]>
}

export interface AudioConfirmInput {
  readonly className: string
  readonly timestampMs: number
}

export interface AudioConfirmConfig {
  /** Occurrences required inside the window. `<= 1` disables the window. */
  readonly confirmHits: number
  readonly confirmWindowSec: number
}

export interface AudioConfirmResult {
  readonly confirmed: boolean
  readonly nextState: AudioConfirmState
}

export function emptyAudioConfirmState(): AudioConfirmState {
  return { hitsByClass: new Map() }
}

export function observeAudioConfirm(
  state: AudioConfirmState,
  input: AudioConfirmInput,
  cfg: AudioConfirmConfig,
): AudioConfirmResult {
  // Not a window at all: one occurrence is the event. Kept as the DEFAULT so
  // that installing this changes nothing until an operator asks for grouping.
  if (cfg.confirmHits <= 1) {
    return { confirmed: true, nextState: state }
  }

  const cutoff = input.timestampMs - cfg.confirmWindowSec * 1000
  const kept = [
    ...(state.hitsByClass.get(input.className) ?? []).filter((at) => at > cutoff),
    input.timestampMs,
  ]
  const next = new Map(state.hitsByClass)

  if (kept.length < cfg.confirmHits) {
    next.set(input.className, kept)
    return { confirmed: false, nextState: { hitsByClass: next } }
  }

  // Confirming RE-ARMS: the next event on this class needs a fresh count, so
  // a sound that never stops produces one event per window, not one per frame
  // once the count is reached.
  next.delete(input.className)
  return { confirmed: true, nextState: { hitsByClass: next } }
}
