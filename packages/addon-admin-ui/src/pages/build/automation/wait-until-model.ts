/**
 * The pure edits of a `wait-until` step: its timeout is stored in seconds and
 * shown in the largest unit that holds it exactly.
 */
import {
  type AutomationWaitUntilStep,
  WAIT_MAX_SECONDS,
  WAIT_UNTIL_TIMEOUT_MAX_S,
} from '@camstack/types'

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

/**
 * The same split for a plain `wait` step, whose seconds may be fractional and
 * may be zero: it adds milliseconds, and a value no whole second holds is shown
 * in them. Stored value unchanged: seconds, as a number.
 */
export type WaitUnit = 'ms' | TimeoutUnit

export const WAIT_UNITS: readonly WaitUnit[] = ['ms', 's', 'min', 'h']

const MS_IN: Readonly<Record<WaitUnit, number>> = { ms: 1, s: 1000, min: 60_000, h: 3_600_000 }

export interface WaitView {
  readonly value: number
  readonly unit: WaitUnit
}

export function isWaitUnit(text: string): text is WaitUnit {
  return text === 'ms' || isTimeoutUnit(text)
}

/** The largest unit that holds the wait exactly (milliseconds are the finest the control writes). */
export function splitWait(seconds: number): WaitView {
  const ms = Math.round(seconds * 1000)
  if (ms === 0) return { value: 0, unit: 's' }
  if (ms % MS_IN.h === 0) return { value: ms / MS_IN.h, unit: 'h' }
  if (ms % MS_IN.min === 0) return { value: ms / MS_IN.min, unit: 'min' }
  if (ms % MS_IN.s === 0) return { value: ms / MS_IN.s, unit: 's' }
  return { value: ms, unit: 'ms' }
}

/** Seconds inside the bounds the schema enforces (0 up to the longest wait); a value that is not a number is 0. */
export function joinWait(value: number, unit: WaitUnit): number {
  const ms = Math.round(value * MS_IN[unit])
  if (!Number.isFinite(ms)) return 0
  return Math.min(Math.max(ms / 1000, 0), WAIT_MAX_SECONDS)
}
