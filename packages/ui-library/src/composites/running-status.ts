/**
 * Pure running-state duration helpers for {@link RunningStatusLine} (D933).
 * `now` is always passed in so tests and screenshots stay deterministic.
 */

export interface RunningDuration {
  /** At least 1 when under 60 minutes. */
  readonly minutes: number
}

export interface RunningDurationHours {
  readonly hours: number
}

export type RunningStatusKey = 'running' | 'idle' | 'unknown'

export interface RunningStatusParts {
  readonly key: RunningStatusKey
  readonly duration?: RunningDuration | RunningDurationHours
  readonly phase?: string
}

function trimmedPhase(phase: string | null): string | undefined {
  if (phase === null) return undefined
  const trimmed = phase.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Minutes elapsed since `since`, at least 1; null when `since` is not usable. */
export function runningDurationSince(
  since: number | null,
  now: number,
): RunningDuration | RunningDurationHours | null {
  if (since === null || !Number.isFinite(since) || since <= 0) return null
  const ms = now - since
  if (ms <= 0) return null
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 60) {
    return { minutes: Math.max(1, totalMinutes) }
  }
  return { hours: Math.floor(totalMinutes / 60) }
}

export function runningStatusParts(
  running: boolean | null,
  since: number | null,
  phase: string | null,
  now: number,
): RunningStatusParts {
  const phaseLabel = trimmedPhase(phase)
  if (running === null) {
    return { key: 'unknown' }
  }
  if (running === false) {
    return phaseLabel === undefined ? { key: 'idle' } : { key: 'idle', phase: phaseLabel }
  }
  const duration = runningDurationSince(since, now)
  if (duration === null) {
    return phaseLabel === undefined ? { key: 'running' } : { key: 'running', phase: phaseLabel }
  }
  return {
    key: 'running',
    duration,
    ...(phaseLabel === undefined ? {} : { phase: phaseLabel }),
  }
}
