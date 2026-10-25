/**
 * Pulse and span edges for Customize preview (D936 §5.5).
 *
 * An unread sample is not a level. It does not arm, start, end or count
 * (D49): a failed read must not look like a falling edge.
 */

export type LevelSample =
  | { readonly kind: 'unread' }
  | { readonly kind: 'level'; readonly active: boolean; readonly changedAt: number | null }

export interface PulseState {
  readonly priorActive: boolean | undefined
  readonly lastPressedAt: number | null
  readonly count: number
  readonly acceptedAt: number | null
}

export interface SpanState {
  readonly open: boolean
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly quietUntil: number | null
  readonly priorActive: boolean | undefined
}

export interface SpanTiming {
  readonly timeoutMs: number
  readonly cooldownMs: number
  readonly nowMs: number
}

export const INITIAL_PULSE: PulseState = {
  priorActive: undefined,
  lastPressedAt: null,
  count: 0,
  acceptedAt: null,
}

export const INITIAL_SPAN: SpanState = {
  open: false,
  startedAt: null,
  endedAt: null,
  quietUntil: null,
  priorActive: undefined,
}

export function stepPulse(state: PulseState, sample: LevelSample, debounceMs: number): PulseState {
  if (sample.kind === 'unread' || debounceMs < 0) return state
  if (state.priorActive === undefined) {
    return { ...state, priorActive: sample.active }
  }
  if (!sample.active) return { ...state, priorActive: false }
  if (state.priorActive) return state
  const at = finite(sample.changedAt)
  if (at === null) return { ...state, priorActive: true }
  if (state.acceptedAt !== null && at - state.acceptedAt < debounceMs) {
    return { ...state, priorActive: true }
  }
  return {
    priorActive: true,
    lastPressedAt: at,
    count: state.count + 1,
    acceptedAt: at,
  }
}

export function stepSpan(state: SpanState, sample: LevelSample, timing: SpanTiming): SpanState {
  const timed = expire(state, timing)
  if (sample.kind === 'unread' || timing.timeoutMs < 0 || timing.cooldownMs < 0) return timed
  if (timed.priorActive === undefined) {
    return { ...timed, priorActive: sample.active }
  }
  if (timed.open && timed.priorActive && !sample.active) {
    return finish(timed, finite(sample.changedAt) ?? timing.nowMs, timing.cooldownMs, false)
  }
  if (!sample.active) return { ...timed, priorActive: false }
  if (timed.priorActive || timed.open) return { ...timed, priorActive: true }
  const at = finite(sample.changedAt) ?? timing.nowMs
  if (timed.quietUntil !== null && at < timed.quietUntil) {
    return { ...timed, priorActive: true }
  }
  return {
    open: true,
    startedAt: at,
    endedAt: null,
    quietUntil: null,
    priorActive: true,
  }
}

function expire(state: SpanState, timing: SpanTiming): SpanState {
  if (!state.open || state.startedAt === null) return state
  const deadline = state.startedAt + timing.timeoutMs
  if (timing.nowMs < deadline) return state
  return finish(state, deadline, timing.cooldownMs, state.priorActive === true)
}

function finish(
  state: SpanState,
  endedAt: number,
  cooldownMs: number,
  priorActive: boolean,
): SpanState {
  return {
    open: false,
    startedAt: state.startedAt,
    endedAt,
    quietUntil: cooldownMs > 0 ? endedAt + cooldownMs : null,
    priorActive,
  }
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null
}
