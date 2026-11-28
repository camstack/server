/**
 * The pure edits of a `wait-until` step and of a `wait` step: a duration is
 * stored in seconds and edited one field per unit (`DurationInput`).
 */
import {
  type AutomationWaitUntilStep,
  WAIT_MAX_SECONDS,
  WAIT_UNTIL_TIMEOUT_MAX_S,
} from '@dominevo/types'

/** Whole seconds inside the bounds the schema enforces; a value that is not a number is the minimum. */
export function clampTimeout(seconds: number): number {
  const whole = Math.round(seconds)
  if (!Number.isFinite(whole)) return 1
  return Math.min(Math.max(whole, 1), WAIT_UNTIL_TIMEOUT_MAX_S)
}

export function newWaitUntil(): AutomationWaitUntilStep {
  return {
    kind: 'wait-until',
    when: { kind: 'all', children: [] },
    timeoutS: 600,
    onTimeout: 'continue',
  }
}

/**
 * A plain `wait` step: its seconds may be zero and may carry a fraction, kept
 * to the millisecond. Inside the bounds the schema enforces (0 up to the
 * longest wait); a value that is not a number is 0.
 */
export function clampWait(seconds: number): number {
  const ms = Math.round(seconds * 1000)
  if (!Number.isFinite(ms)) return 0
  return Math.min(Math.max(ms / 1000, 0), WAIT_MAX_SECONDS)
}
