import type { DetailStepAnnounce } from '@camstack/types'

/** A scheduling decision — the caller dispatches the named step for the named track. */
export interface DetailRequest {
  readonly trackId: string
  readonly stepId: string
  readonly reason: 'new-track' | 'improve' | 'periodic' | 'retry'
}

/** Default backoff/period when a step's cadence omits `minIntervalMs`. */
const DEFAULT_MIN_INTERVAL_MS = 1000

/** Default fire cap for a `once` step when its announce omits `maxPerTrack`. */
const DEFAULT_ONCE_MAX_PER_TRACK = 3

/**
 * Consecutive frame-plane misses ("frame + crop both missed") after which a step
 * is ABANDONED for the track. The decode worker serves native crops from a RAM
 * lease store with a ~500ms TTL, so a retry that arrives seconds later re-cuts
 * from an evicted handle and is a guaranteed miss forever. Retrying a
 * permanently-gone frame just burns cross-process RPC + CPU + log lines. Three
 * consecutive misses (each ≥ one tick apart) confidently means the frame is gone
 * for good, while still tolerating a single transient decode-worker hiccup /
 * respawn on a genuinely live track (the counter resets on any resolved result).
 */
const MAX_CONSECUTIVE_FRAME_MISSES = 3

interface StepState {
  readonly announce: DetailStepAnnounce
  firedCount: number
  lastFiredAt: number | null
  sticky: boolean
  /** Set by a failed/low-confidence `onResult`; consumed by the next `tick()` as a retry. */
  retryPending: boolean
  /** Run of frame-plane misses with no resolved result in between (see onFrameMiss). */
  consecutiveFrameMisses: number
  /** Terminal give-up flag: the frame is permanently unrecoverable for this track. */
  abandoned: boolean
}

/**
 * Pure per-(track, step) scheduling state machine for detail-subtree
 * dispatch. Given a camera's announced child steps (`DetailStepAnnounce[]`,
 * read off `PipelineInferenceResultPayload.detailSteps`), decides WHEN each
 * step should run for a given track — independent of transport, I/O, or
 * timers. The caller drives it with wall-clock `nowMs` and dispatches the
 * returned `DetailRequest[]`.
 */
export class DetailScheduler {
  private readonly tracks = new Map<string, Map<string, StepState>>()

  /** Track appeared with class + announce; returns immediate requests. */
  onTrackStarted(
    trackId: string,
    className: string,
    announce: readonly DetailStepAnnounce[],
    nowMs: number,
  ): DetailRequest[] {
    const steps = new Map<string, StepState>()
    const requests: DetailRequest[] = []

    for (const stepAnnounce of announce) {
      if (!stepAnnounce.inputClasses.includes(className)) continue

      const state: StepState = {
        announce: stepAnnounce,
        firedCount: 1,
        lastFiredAt: nowMs,
        sticky: false,
        retryPending: false,
        consecutiveFrameMisses: 0,
        abandoned: false,
      }
      steps.set(stepAnnounce.stepId, state)
      requests.push({ trackId, stepId: stepAnnounce.stepId, reason: 'new-track' })
    }

    this.tracks.set(trackId, steps)
    return requests
  }

  /** Better candidate crop observed for the track. */
  onCandidateImproved(trackId: string, nowMs: number): DetailRequest[] {
    const steps = this.tracks.get(trackId)
    if (!steps) return []

    const requests: DetailRequest[] = []
    for (const state of steps.values()) {
      if (state.announce.cadence.trigger !== 'improve') continue
      if (!this.canFire(state, nowMs)) continue

      this.markFired(state, nowMs)
      requests.push({ trackId, stepId: state.announce.stepId, reason: 'improve' })
    }
    return requests
  }

  /** Periodic tick (call ~1/s). Also carries pending retries for any trigger kind. */
  tick(nowMs: number): DetailRequest[] {
    const requests: DetailRequest[] = []

    for (const [trackId, steps] of this.tracks) {
      for (const state of steps.values()) {
        if (state.sticky || state.abandoned) continue

        if (state.retryPending) {
          if (!this.intervalElapsed(state, nowMs)) continue
          if (!this.underMaxPerTrack(state)) {
            state.retryPending = false
            continue
          }
          this.markFired(state, nowMs)
          requests.push({ trackId, stepId: state.announce.stepId, reason: 'retry' })
          continue
        }

        if (state.announce.cadence.trigger !== 'periodic') continue
        if (!this.canFire(state, nowMs)) continue

        this.markFired(state, nowMs)
        requests.push({ trackId, stepId: state.announce.stepId, reason: 'periodic' })
      }
    }

    return requests
  }

  /**
   * Result arrived; confidence drives sticky/retry. null = failed (retry per
   * policy). `_nowMs` is part of the public signature for symmetry with the
   * other methods but isn't needed here — retry backoff is anchored to
   * `lastFiredAt` (set when the step was actually dispatched), not to when
   * its result came back.
   */
  onResult(trackId: string, stepId: string, confidence: number | null, _nowMs: number): void {
    const steps = this.tracks.get(trackId)
    if (!steps) return
    const state = steps.get(stepId)
    if (!state) return
    // A sticky or abandoned step is terminal — a late/out-of-order result for it
    // must never resurrect retry scheduling (harmless today, fragile if the flag
    // is ever checked less strictly downstream).
    if (state.sticky || state.abandoned) return

    // Reaching onResult means the frame plane RESOLVED this request (the
    // dispatcher routes a "frame + crop both missed" outcome to onFrameMiss
    // instead). Any prior run of consecutive frame misses is broken here — so
    // only genuinely CONSECUTIVE misses (no resolution in between) ever abandon.
    state.consecutiveFrameMisses = 0

    const { stickyOnConfidence } = state.announce.cadence
    if (
      confidence !== null &&
      stickyOnConfidence !== undefined &&
      confidence >= stickyOnConfidence
    ) {
      state.sticky = true
      state.retryPending = false
      return
    }

    // A failed attempt (null confidence) is always retry-eligible, bounded by
    // maxPerTrack. Non-'once' triggers keep following their own cadence
    // (improve/periodic) instead of a null-driven retry.
    if (confidence === null) {
      if (this.underMaxPerTrack(state)) {
        state.retryPending = true
      }
      return
    }

    // Non-null result. For a 'once' step a non-null result is a SUCCESSFUL read
    // (e.g. a plate). It is terminal — never re-run the chain — UNLESS a
    // stickyOnConfidence threshold was configured and this result fell below it
    // (the sticky branch above already consumed the >=-threshold case), in
    // which case it stays retry-eligible up to maxPerTrack.
    if (state.announce.cadence.trigger === 'once' && stickyOnConfidence !== undefined) {
      if (this.underMaxPerTrack(state)) {
        state.retryPending = true
      }
    }
  }

  /**
   * A dispatched request could not resolve a frame AT ALL — the frame handle
   * lease was evicted AND the crop fallback was unavailable (the "frame + crop
   * both missed" outcome). This is fundamentally different from `onResult(null)`:
   * there the frame plane WORKED and the model merely returned nothing (worth a
   * retry on a fresh frame). A frame-plane miss re-cuts from the SAME evicted
   * handle every time, so it can never recover from this request. It is
   * retry-eligible only for a bounded number of CONSECUTIVE attempts; after
   * {@link MAX_CONSECUTIVE_FRAME_MISSES} in a row the step is abandoned for the
   * track — this is the give-up that breaks the permanent-retry loop. `_nowMs`
   * is accepted for signature symmetry (backoff is anchored to `lastFiredAt`).
   */
  onFrameMiss(trackId: string, stepId: string, _nowMs: number): void {
    const steps = this.tracks.get(trackId)
    if (!steps) return
    const state = steps.get(stepId)
    if (!state) return
    if (state.sticky || state.abandoned) return

    state.consecutiveFrameMisses += 1
    if (state.consecutiveFrameMisses >= MAX_CONSECUTIVE_FRAME_MISSES) {
      state.abandoned = true
      state.retryPending = false
      return
    }
    // Below the give-up bound: re-arm a retry exactly as a failed attempt would,
    // still bounded by maxPerTrack.
    if (this.underMaxPerTrack(state)) {
      state.retryPending = true
    }
  }

  /**
   * The root model the announce says SUPPLIES this (track, step), and how
   * (D730). Read from the announce the track was scheduled with. An announce
   * from a runner that predates `filledAs` named only label supplies.
   */
  rootSupply(
    trackId: string,
    stepId: string,
  ): { readonly modelId: string; readonly kind: 'label' | 'crop' } | undefined {
    const announce = this.tracks.get(trackId)?.get(stepId)?.announce
    if (announce?.filledBy === undefined) return undefined
    return { modelId: announce.filledBy, kind: announce.filledAs ?? 'label' }
  }

  /**
   * The root model already produced this step's effect for the track (D730):
   * the step is settled for the track's life — no retry, improve or periodic
   * re-fire. Same terminal state as a confident result.
   */
  markFilled(trackId: string, stepId: string): void {
    const state = this.tracks.get(trackId)?.get(stepId)
    if (state === undefined) return
    state.sticky = true
    state.retryPending = false
  }

  onTrackEnded(trackId: string): void {
    this.tracks.delete(trackId)
  }

  private canFire(state: StepState, nowMs: number): boolean {
    if (state.sticky || state.abandoned) return false
    if (!this.underMaxPerTrack(state)) return false
    return this.intervalElapsed(state, nowMs)
  }

  private intervalElapsed(state: StepState, nowMs: number): boolean {
    if (state.lastFiredAt === null) return true
    const minIntervalMs = state.announce.cadence.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    return nowMs - state.lastFiredAt >= minIntervalMs
  }

  private underMaxPerTrack(state: StepState): boolean {
    const maxPerTrack =
      state.announce.cadence.maxPerTrack ??
      (state.announce.cadence.trigger === 'once' ? DEFAULT_ONCE_MAX_PER_TRACK : Infinity)
    return state.firedCount < maxPerTrack
  }

  private markFired(state: StepState, nowMs: number): void {
    state.firedCount += 1
    state.lastFiredAt = nowMs
    state.retryPending = false
  }
}
