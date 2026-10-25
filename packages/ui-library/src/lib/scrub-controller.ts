/**
 * scrub-controller — shared scrub-position state for timeline surfaces (R9).
 *
 * Ported from the proven srcV2 viewer implementation
 * (camstack/srcV2/recording/scrub-controller.ts): the same throttle,
 * commit-dedupe, and live→recorded-bypass semantics, now driving the
 * admin-ui `RecordingTimeline` through the `camstack-control` datachannel.
 *
 * Two layers:
 *   1. Pure reducer + helpers (unit-tested, no React deps):
 *      scrubReducer, shouldEmit, shouldCommit, cursorFractionFor,
 *      makeScrubBridge
 *   2. useScrubController hook: thin React glue that bridges the reducer
 *      to a PlaybackControlSink (e.g. the recorded-playback datachannel).
 */
import { useMemo, useReducer, useRef } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

export type ScrubSource = 'timeline' | 'heatmap'

export interface ScrubState {
  readonly scrubbing: boolean
  readonly scrubEpoch: number | null
  readonly playheadEpoch: number | null
  readonly lastSource: ScrubSource | null
}

export const initialScrubState: ScrubState = {
  scrubbing: false,
  scrubEpoch: null,
  playheadEpoch: null,
  lastSource: null,
}

export type ScrubAction =
  | { readonly type: 'begin'; readonly source: ScrubSource }
  | { readonly type: 'update'; readonly epoch: number; readonly source: ScrubSource }
  | { readonly type: 'end'; readonly epoch: number; readonly source: ScrubSource }
  | { readonly type: 'seek'; readonly epoch: number; readonly source: ScrubSource }
  | { readonly type: 'playhead'; readonly epoch: number }
  | { readonly type: 'reset' }

// ── Pure reducer ─────────────────────────────────────────────────────────────

export function scrubReducer(state: ScrubState, action: ScrubAction): ScrubState {
  switch (action.type) {
    case 'begin':
      return { ...state, scrubbing: true, scrubEpoch: null, lastSource: action.source }

    case 'update':
      return { ...state, scrubbing: true, scrubEpoch: action.epoch, lastSource: action.source }

    case 'end':
      return {
        ...state,
        scrubbing: false,
        scrubEpoch: null,
        playheadEpoch: action.epoch,
        lastSource: action.source,
      }

    case 'seek':
      return {
        ...state,
        scrubbing: false,
        scrubEpoch: null,
        playheadEpoch: action.epoch,
        lastSource: action.source,
      }

    case 'playhead':
      // Reported by the server; ignored mid-scrub so the drag target wins.
      // Never changes lastSource (no surface produced it → no echo suppression).
      if (state.scrubbing) return state
      return { ...state, playheadEpoch: action.epoch }

    case 'reset':
      // Back to live / channel dropped — clear every position.
      return initialScrubState

    default:
      return state
  }
}

// ── Throttle decision ────────────────────────────────────────────────────────

/**
 * Throttle decision for continuous `update` emits (default ~70 ms).
 * Returns true when enough time has elapsed since the last emit.
 */
export function shouldEmit(lastEmitMs: number, now: number, throttleMs = 70): boolean {
  return now - lastEmitMs >= throttleMs
}

// ── Commit dedupe ─────────────────────────────────────────────────────────────

/** The last committed target (epoch + wall-clock of the commit). */
export interface LastCommit {
  readonly epoch: number
  readonly at: number
}

/** Epochs within this many ms of the last commit count as the SAME target. */
export const COMMIT_DEDUPE_TOLERANCE_MS = 750
/** Only dedupe against a commit made within this recent window. */
export const COMMIT_DEDUPE_WINDOW_MS = 2000

/**
 * Decide whether a `seek`/`scrubCommit` should actually hit the playback sink.
 * Each commit reloads the server feeder (loading→playing) and visibly stutters
 * playback; firing the same (or a near-identical) target twice in quick
 * succession produces a redundant reload. Drop a commit only when it targets
 * essentially the SAME epoch as the last commit AND that commit was recent — a
 * genuinely different target, or a re-seek to the same spot after the window,
 * always commits.
 */
export function shouldCommit(
  last: LastCommit | null,
  epoch: number,
  now: number,
  toleranceMs: number = COMMIT_DEDUPE_TOLERANCE_MS,
  windowMs: number = COMMIT_DEDUPE_WINDOW_MS,
): boolean {
  if (last === null) return true
  const sameTarget = Math.abs(epoch - last.epoch) <= toleranceMs
  const recent = now - last.at <= windowMs
  return !(sameTarget && recent)
}

// ── Cursor fraction ──────────────────────────────────────────────────────────

/**
 * The active cursor position (scrub target while scrubbing, else playhead)
 * expressed as a 0..1 fraction across the day window.
 * Returns null when no position is known or the day window is degenerate.
 */
export function cursorFractionFor(
  state: ScrubState,
  day: { readonly from: number; readonly to: number },
): number | null {
  const epoch = state.scrubbing ? state.scrubEpoch : state.playheadEpoch
  if (epoch === null) return null
  const span = day.to - day.from
  if (span <= 0) return null
  return Math.min(1, Math.max(0, (epoch - day.from) / span))
}

// ── Playback control sink ─────────────────────────────────────────────────────

/**
 * Generic, always-active playback control surface the scrub controller
 * drives. `scrubStart`/`scrubTo` are CLIENT-SIDE hooks (the wire protocol has
 * no per-move scrub message — a future WebCodecs preview consumes them);
 * `scrubCommit`/`seek` reach the server feeder.
 */
export interface PlaybackControlSink {
  scrubStart(): void
  scrubTo(epochMs: number): void
  scrubCommit(epochMs: number): void
  seek(epochMs: number): void
}

// ── Pure bridge factory ───────────────────────────────────────────────────────

/** A mutable holder, structurally compatible with React's `MutableRefObject`. */
export interface MutableRef<T> {
  current: T
}

/** The gesture callbacks the hook exposes (everything except `state`). */
type ScrubBridge = Omit<ScrubController, 'state'>

/**
 * Builds the always-active bridge callbacks from a sink, a dispatch, and the
 * throttle ref. Pure (no React) so it can be unit-tested directly: the hook
 * just wraps the result in `useMemo`.
 *
 * Every gesture drives the sink immediately — there is no VOD-active gate.
 */
export function makeScrubBridge(
  sink: PlaybackControlSink,
  dispatch: (action: ScrubAction) => void,
  lastEmitRef: MutableRef<number>,
  lastCommitRef: MutableRef<LastCommit | null> = { current: null },
  /** Reports whether the PLAYER is currently on the live edge (not in recorded
   *  mode). Used to bypass commit-dedupe on the live→recorded transition. */
  isPlayerLive: () => boolean = () => false,
): ScrubBridge {
  // A commit (scrubCommit/seek) reloads the server feeder; dedupe redundant
  // ones so playback doesn't stutter on duplicate/near-identical targets.
  const commit = (epoch: number, fire: (epoch: number) => void): void => {
    const now = Date.now()
    // NEVER dedupe a commit while the player is still LIVE: this commit is the
    // live→recorded transition, so it MUST reach the server (the TimelineSession
    // only leaves `live` on an explicit seek/scrubCommit — a dropped one strands
    // the player on the live edge while the timeline shows the scrubbed recorded
    // position). There's no feeder to redundantly reload yet, so dedupe would
    // only ever HURT here. (Repro: go-live, then re-scrub near the same epoch
    // within the dedupe window → the seek was swallowed → player stuck live.)
    if (isPlayerLive()) {
      lastCommitRef.current = { epoch, at: now }
      fire(epoch)
      return
    }
    if (!shouldCommit(lastCommitRef.current, epoch, now)) {
      return
    }
    lastCommitRef.current = { epoch, at: now }
    fire(epoch)
  }
  return {
    beginScrub: (source: ScrubSource): void => {
      dispatch({ type: 'begin', source })
      sink.scrubStart()
    },
    updateScrub: (epoch: number, source: ScrubSource): void => {
      dispatch({ type: 'update', epoch, source })
      const now = Date.now()
      if (!shouldEmit(lastEmitRef.current, now)) return
      lastEmitRef.current = now
      sink.scrubTo(epoch)
    },
    endScrub: (epoch: number, source: ScrubSource): void => {
      dispatch({ type: 'end', epoch, source })
      commit(epoch, sink.scrubCommit)
    },
    seek: (epoch: number, source: ScrubSource): void => {
      dispatch({ type: 'seek', epoch, source })
      commit(epoch, sink.seek)
    },
    setPlayhead: (epoch: number): void => dispatch({ type: 'playhead', epoch }),
    reset: (): void => dispatch({ type: 'reset' }),
  }
}

// ── useScrubController hook ──────────────────────────────────────────────────

export interface ScrubController {
  readonly state: ScrubState
  readonly beginScrub: (source: ScrubSource) => void
  readonly updateScrub: (epoch: number, source: ScrubSource) => void
  readonly endScrub: (epoch: number, source: ScrubSource) => void
  readonly seek: (epoch: number, source: ScrubSource) => void
  readonly setPlayhead: (epoch: number) => void
  readonly reset: () => void
}

/**
 * Owns the shared scrub position and bridges it to a playback control sink.
 *
 * The bridge is always active: any gesture (drag or tap) drives the sink
 * immediately. There is no VOD-active gate — the timeline always drives
 * playback while frame-push mode is on.
 *
 * @param sink Always-active playback control surface (e.g. the datachannel)
 * @param isPlayerLive Synchronous getter for "is the player on the live
 *   edge?" — lets a live→recorded commit bypass dedupe so the seek always
 *   reaches the server.
 */
export function useScrubController(
  sink: PlaybackControlSink,
  isPlayerLive: () => boolean = () => false,
): ScrubController {
  const [state, dispatch] = useReducer(scrubReducer, initialScrubState)
  const lastEmitRef = useRef(0)
  const lastCommitRef = useRef<LastCommit | null>(null)
  // Keep the latest getter in a ref so the bridge (memoized on `sink`) always
  // reads the current live state without being re-created each render.
  const isPlayerLiveRef = useRef(isPlayerLive)
  isPlayerLiveRef.current = isPlayerLive

  const bridge = useMemo(
    () =>
      makeScrubBridge(sink, dispatch, lastEmitRef, lastCommitRef, () => isPlayerLiveRef.current()),
    [sink],
  )

  return { state, ...bridge }
}
