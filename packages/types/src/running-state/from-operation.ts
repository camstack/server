import type { DishwasherOperationState } from '../capabilities/dishwasher.cap.js'
import type { LawnMowerActivity } from '../capabilities/lawn-mower-control.cap.js'
import type { MediaPlayerState } from '../capabilities/media-player.cap.js'
import type { VacuumState } from '../capabilities/vacuum-control.cap.js'
import type { RunningStateStatus } from '../capabilities/running-state.cap.js'

/** Prior boolean clock used when republishing without moving `since`. */
export interface RunningStatePrevious {
  readonly running: boolean | null
  readonly since: number | null
}

function programStartFromRemaining(
  running: boolean,
  remainingSeconds: number | null | undefined,
  fetchedAt: number,
): number | null {
  if (!running || remainingSeconds === null || remainingSeconds === undefined) return null
  if (remainingSeconds <= 0) return null
  return fetchedAt - remainingSeconds * 1000
}

function resolveSince(
  running: boolean | null,
  previous: RunningStatePrevious | undefined,
  transitionAtMs: number,
  bootstrapSinceMs: number | null,
): number | null {
  if (running === null) return null
  const prevRunning = previous?.running ?? null
  if (prevRunning === null) {
    return bootstrapSinceMs
  }
  if (prevRunning !== running) return transitionAtMs
  return previous?.since ?? null
}

function nativeSlice(
  running: boolean | null,
  phase: string | null,
  previous: RunningStatePrevious | undefined,
  transitionAtMs: number,
  fetchedAt: number,
  bootstrapSinceMs: number | null,
): RunningStateStatus {
  return {
    running,
    since: resolveSince(running, previous, transitionAtMs, bootstrapSinceMs),
    source: 'native',
    phase: running === null ? null : phase,
    lastFetchedAt: fetchedAt,
  }
}

export function runningFromDishwasherOperation(
  operation: DishwasherOperationState | null,
  program: string | null,
  previous: RunningStatePrevious | undefined,
  fetchedAt: number,
  remainingSeconds?: number | null,
  transitionAt?: number,
): RunningStateStatus {
  const transitionAtMs = transitionAt ?? fetchedAt
  if (operation === null) {
    return nativeSlice(null, null, previous, transitionAtMs, fetchedAt, null)
  }
  if (operation === 'Run' || operation === 'Aborting') {
    const bootstrap = programStartFromRemaining(true, remainingSeconds, fetchedAt)
    return nativeSlice(true, program ?? operation, previous, transitionAtMs, fetchedAt, bootstrap)
  }
  if (operation === 'Pause') {
    return nativeSlice(false, 'Pause', previous, transitionAtMs, fetchedAt, null)
  }
  return nativeSlice(false, operation, previous, transitionAtMs, fetchedAt, null)
}

export function runningFromVacuumState(
  state: VacuumState | null,
  previous: RunningStatePrevious | undefined,
  fetchedAt: number,
  transitionAt?: number,
): RunningStateStatus {
  const transitionAtMs = transitionAt ?? fetchedAt
  if (state === null) {
    return nativeSlice(null, null, previous, transitionAtMs, fetchedAt, null)
  }
  if (state === 'cleaning' || state === 'returning' || state === 'drying') {
    return nativeSlice(true, state, previous, transitionAtMs, fetchedAt, null)
  }
  if (state === 'paused') {
    return nativeSlice(false, 'paused', previous, transitionAtMs, fetchedAt, null)
  }
  return nativeSlice(false, state, previous, transitionAtMs, fetchedAt, null)
}

export function runningFromLawnMower(
  activity: LawnMowerActivity | null,
  previous: RunningStatePrevious | undefined,
  fetchedAt: number,
  transitionAt?: number,
): RunningStateStatus {
  const transitionAtMs = transitionAt ?? fetchedAt
  if (activity === null) {
    return nativeSlice(null, null, previous, transitionAtMs, fetchedAt, null)
  }
  if (activity === 'mowing') {
    return nativeSlice(true, activity, previous, transitionAtMs, fetchedAt, null)
  }
  if (activity === 'paused') {
    return nativeSlice(false, 'paused', previous, transitionAtMs, fetchedAt, null)
  }
  return nativeSlice(false, activity, previous, transitionAtMs, fetchedAt, null)
}

export function runningFromMediaPlayer(
  state: MediaPlayerState | null,
  previous: RunningStatePrevious | undefined,
  fetchedAt: number,
  transitionAt?: number,
): RunningStateStatus {
  const transitionAtMs = transitionAt ?? fetchedAt
  if (state === null) {
    return nativeSlice(null, null, previous, transitionAtMs, fetchedAt, null)
  }
  if (state === 'playing' || state === 'buffering') {
    return nativeSlice(true, state, previous, transitionAtMs, fetchedAt, null)
  }
  if (state === 'paused') {
    return nativeSlice(false, 'paused', previous, transitionAtMs, fetchedAt, null)
  }
  return nativeSlice(false, state, previous, transitionAtMs, fetchedAt, null)
}
