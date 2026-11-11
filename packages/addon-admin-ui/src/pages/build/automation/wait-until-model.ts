/**
 * The pure edits of a `wait-until` step: its timeout is stored in seconds and
 * shown in the largest unit that holds it exactly.
 */
import { type AutomationWaitUntilStep, WAIT_UNTIL_TIMEOUT_MAX_S } from '@camstack/types'

export type TimeoutUnit = 's' | 'min' | 'h'

export const TIMEOUT_UNITS: readonly TimeoutUnit[] = ['s', 'min', 'h']

const SECONDS_IN: Readonly<Record<TimeoutUnit, number>> = { s: 1, min: 60, h: 3600 }

export interface TimeoutView {
  readonly value: number
  readonly unit: TimeoutUnit
}

export function isTimeoutUnit(text: string): text is TimeoutUnit {
  return text === 's' || text === 'min' || text === 'h'
}

export function splitTimeout(seconds: number): TimeoutView {
  if (seconds % SECONDS_IN.h === 0) return { value: seconds / SECONDS_IN.h, unit: 'h' }
  if (seconds % SECONDS_IN.min === 0) return { value: seconds / SECONDS_IN.min, unit: 'min' }
  return { value: seconds, unit: 's' }
}

/** Whole seconds inside the bounds the schema enforces; a value that is not a number is the minimum. */
export function joinTimeout(value: number, unit: TimeoutUnit): number {
  const seconds = Math.round(value * SECONDS_IN[unit])
  if (!Number.isFinite(seconds)) return 1
  return Math.min(Math.max(seconds, 1), WAIT_UNTIL_TIMEOUT_MAX_S)
}

export function newWaitUntil(): AutomationWaitUntilStep {
  return {
    kind: 'wait-until',
    when: { kind: 'all', children: [] },
    timeoutS: 600,
    onTimeout: 'continue',
  }
}
