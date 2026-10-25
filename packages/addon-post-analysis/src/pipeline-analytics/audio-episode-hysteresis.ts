/**
 * Per-camera audio-episode hysteresis.
 *
 * Audio classification heartbeats at ~5 s (and the classifier itself at
 * ~30 Hz). Without this, a 20-second cry becomes four AudioEvents and four
 * synthetic tracks. The contract is: one episode = one event = one track,
 * extended while the class continues, closed after a gap, and not reopened
 * until a cooldown. There is deliberately no class allowlist — the knobs
 * are how we bound spam; a 1–2 day live trial tells us if that is enough.
 *
 * Pure, no allocation on the common path beyond the returned state object.
 * The caller keeps one {@link AudioEpisodeState} per device.
 */

export interface AudioEpisodeKnobs {
  readonly enabled: boolean
  /** Class must be seen continuously this long before an episode opens. */
  readonly openHoldMs: number
  /** Class must be absent this long before the open episode closes. */
  readonly closeGapMs: number
  /** After close, the SAME class cannot reopen until this elapses. */
  readonly cooldownMs: number
}

export interface AudioEpisodeSample {
  readonly timestampMs: number
  /** Confident classification, or `null` when the frame fell to the level path. */
  readonly className: string | null
}

export interface AudioEpisodeState {
  readonly pendingClass: string | null
  readonly pendingSinceMs: number
  readonly openClass: string | null
  readonly episodeId: string | null
  readonly lastHeardMs: number
  readonly lastClosedClass: string | null
  readonly lastClosedMs: number
}

export type AudioEpisodeRef = {
  readonly className: string
  readonly episodeId: string
}

export type AudioEpisodeAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'open'; readonly className: string; readonly episodeId: string }
  | { readonly kind: 'hold'; readonly className: string; readonly episodeId: string }
  | { readonly kind: 'close'; readonly className: string; readonly episodeId: string }
  | {
      readonly kind: 'replace'
      readonly closed: AudioEpisodeRef
      readonly opened: AudioEpisodeRef
    }

const EMPTY: AudioEpisodeState = {
  pendingClass: null,
  pendingSinceMs: 0,
  openClass: null,
  episodeId: null,
  lastHeardMs: 0,
  lastClosedClass: null,
  lastClosedMs: 0,
}

export function emptyAudioEpisodeState(): AudioEpisodeState {
  return EMPTY
}

function episodeIdFor(className: string, timestampMs: number): string {
  return `${className}:${timestampMs}`
}

function inCooldown(
  state: AudioEpisodeState,
  className: string,
  timestampMs: number,
  knobs: AudioEpisodeKnobs,
): boolean {
  return state.lastClosedClass === className && timestampMs - state.lastClosedMs < knobs.cooldownMs
}

function closedState(className: string, atMs: number): AudioEpisodeState {
  return {
    ...EMPTY,
    lastClosedClass: className,
    lastClosedMs: atMs,
  }
}

export function observeAudioEpisode(
  state: AudioEpisodeState,
  sample: AudioEpisodeSample,
  knobs: AudioEpisodeKnobs,
): { readonly nextState: AudioEpisodeState; readonly action: AudioEpisodeAction } {
  if (!knobs.enabled) {
    // No GROUPING when the knob is off — which is not permission to write
    // nothing. The caller persists classified audio through the ungrouped
    // heartbeat writer instead (`handleAudioResult` in `index.ts`); routing
    // every frame here and letting this `none` be the answer is what silenced
    // classified audio entirely on a knob-off camera.
    return { nextState: EMPTY, action: { kind: 'none' } }
  }

  const { timestampMs, className } = sample
  const openClass = state.openClass
  const openId = state.episodeId

  if (openClass !== null && openId !== null) {
    if (className === openClass) {
      return {
        nextState: {
          ...state,
          pendingClass: null,
          pendingSinceMs: 0,
          lastHeardMs: timestampMs,
        },
        action: { kind: 'hold', className: openClass, episodeId: openId },
      }
    }
    if (className === null) {
      if (timestampMs - state.lastHeardMs < knobs.closeGapMs) {
        return { nextState: state, action: { kind: 'none' } }
      }
      return {
        nextState: closedState(openClass, timestampMs),
        action: { kind: 'close', className: openClass, episodeId: openId },
      }
    }
    // Competing class while open: ignore it during its own cooldown, otherwise
    // it must hold for openHoldMs before we close the current episode. A
    // single misclassified frame must not fork a second track.
    if (inCooldown(state, className, timestampMs, knobs)) {
      return { nextState: state, action: { kind: 'none' } }
    }
    const pendingSince = state.pendingClass === className ? state.pendingSinceMs : timestampMs
    if (
      knobs.openHoldMs === 0 ||
      (state.pendingClass === className && timestampMs - pendingSince >= knobs.openHoldMs)
    ) {
      const openedId = episodeIdFor(className, timestampMs)
      return {
        nextState: {
          pendingClass: null,
          pendingSinceMs: 0,
          openClass: className,
          episodeId: openedId,
          lastHeardMs: timestampMs,
          lastClosedClass: openClass,
          lastClosedMs: timestampMs,
        },
        action: {
          kind: 'replace',
          closed: { className: openClass, episodeId: openId },
          opened: { className, episodeId: openedId },
        },
      }
    }
    return {
      nextState: {
        ...state,
        pendingClass: className,
        pendingSinceMs: pendingSince,
      },
      action: { kind: 'none' },
    }
  }

  if (className === null) {
    if (state.pendingClass === null) return { nextState: state, action: { kind: 'none' } }
    return {
      nextState: { ...state, pendingClass: null, pendingSinceMs: 0 },
      action: { kind: 'none' },
    }
  }

  if (inCooldown(state, className, timestampMs, knobs)) {
    return { nextState: state, action: { kind: 'none' } }
  }

  const pendingSince = state.pendingClass === className ? state.pendingSinceMs : timestampMs
  if (
    knobs.openHoldMs === 0 ||
    (state.pendingClass === className && timestampMs - pendingSince >= knobs.openHoldMs)
  ) {
    const episodeId = episodeIdFor(className, timestampMs)
    return {
      nextState: {
        pendingClass: null,
        pendingSinceMs: 0,
        openClass: className,
        episodeId,
        lastHeardMs: timestampMs,
        lastClosedClass: state.lastClosedClass,
        lastClosedMs: state.lastClosedMs,
      },
      action: { kind: 'open', className, episodeId },
    }
  }

  if (state.pendingClass === className) {
    return { nextState: state, action: { kind: 'none' } }
  }

  return {
    nextState: { ...state, pendingClass: className, pendingSinceMs: timestampMs },
    action: { kind: 'none' },
  }
}
