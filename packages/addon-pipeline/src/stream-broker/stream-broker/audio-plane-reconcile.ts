/**
 * AUDIO-PLANE RECONCILE — the net under [D77](../../../../../docs/decisions/adr-0077.md)'s
 * one-shot recovery, hardened per [D83](../../../../../docs/decisions/adr-0083.md).
 *
 * ## What D77 left exposed
 *
 * D77 made a camera-config write announce itself: the provider emits
 * `StreamParamsChanged`, the broker re-dials after a settle delay, the WebRTC
 * sessions re-sync. That chain is correct and it is the FAST path — it is also
 * a single event, and an event in this repo is droppable telemetry (D8). Two
 * things walk straight past it:
 *
 * - a lost or never-delivered `StreamParamsChanged` (a provider restarting at
 *   exactly the wrong moment, a subscriber not yet attached), and
 * - an audio change made **outside CamStack** — an operator on the camera's
 *   own web UI nudges nothing at all.
 *
 * Either way the broker settles on a video-only session against a camera that
 * is muxing audio, and nothing ever asks again. That is the state that left
 * 104 deaf for forty minutes.
 *
 * ## The shape
 *
 * Desired vs observed, compared every reconcile tick, exactly as the pinned
 * registry-driven pattern says. But the two halves cost wildly different
 * amounts, so **the cheap question comes first** (D54):
 *
 * | | Question | Cost |
 * | --- | --- | --- |
 * | OBSERVED | do my live source brokers carry an audio track? | free, in-memory |
 * | DESIRED | does the camera declare audio enabled? | an ISAPI/Baichuan round trip |
 *
 * A camera that IS delivering audio is a camera whose audio is enabled, so the
 * expensive half is only ever paid when the free half already looks wrong.
 * A steady-state fleet pays nothing.
 *
 * ## Why the decision is a pure function
 *
 * The action it can take — re-dial — tears down a HEALTHY reader. That is the
 * destructive direction, and D49 is explicit about it: a read that contradicts
 * the mirror in the direction that destroys work needs a second read to agree.
 * So a disagreement is observed twice before it is believed, a failed read
 * changes nothing at all, re-dials are spaced by a cooldown and capped, and
 * after the cap the device is declared unrecoverable ONCE rather than
 * re-dialled forever. None of that is testable through a live broker, and all
 * of it is where the bugs would be.
 */

/** How many consecutive passes must disagree before a re-dial is believed. */
export const AUDIO_PLANE_DISAGREEMENTS_TO_ACT = 2

/**
 * Minimum gap between two re-dials of the same device. A re-dial costs a
 * ~2 s video interruption on every source of the camera; at the 30 s
 * reconcile cadence, an un-cooled loop against a camera whose audio genuinely
 * cannot come back would be a permanent stutter.
 */
export const AUDIO_PLANE_REDIAL_COOLDOWN_MS = 5 * 60_000

/**
 * Consecutive re-dials before the reconcile stops trying. Three attempts over
 * at least ten minutes is enough for a camera that is merely slow to finish
 * restarting its encoder; past that the disagreement is not something a
 * re-dial can fix, and continuing would be an infinite loop dressed as a
 * recovery (the thing D6 forbids for runners, for the same reason).
 */
export const AUDIO_PLANE_MAX_REDIALS = 3

/**
 * What one reconcile pass saw for one device. A discriminated union rather
 * than a bag of nullable booleans so "we did not read" and "we read and it
 * said no" cannot be confused — that collapse is precisely the defect D49 was
 * written about.
 */
export type AudioPlaneObservation =
  /** The operator muted this camera's audio broker-side. Silence is the ask. */
  | { readonly kind: 'broker-muted' }
  /** No live non-derived broker is streaming — nothing to observe either way. */
  | { readonly kind: 'no-live-source' }
  /** At least one live broker carries an audio track. Agreement, for free. */
  | { readonly kind: 'audio-present' }
  /** The device read threw. Serves no verdict — a failed read changes nothing. */
  | { readonly kind: 'read-failed' }
  /** The camera answered "I have no such control" (or an unparseable status). */
  | { readonly kind: 'audio-unknown' }
  /** The camera declares audio OFF and we hear none. Agreement. */
  | { readonly kind: 'declared-off' }
  /** The camera declares audio ON and no broker carries a track. DISAGREEMENT. */
  | { readonly kind: 'declared-on' }

/** What the driver should do about it. */
export type AudioPlaneAction =
  | { readonly kind: 'none' }
  /** Disagreed once. Believed only when the next pass agrees with it. */
  | { readonly kind: 'await-second-pass' }
  /** Believed, but too soon after the last re-dial. */
  | { readonly kind: 'cooldown' }
  /** The re-dial cap is reached. Emitted ONCE, then the device goes quiet. */
  | { readonly kind: 'give-up' }
  | { readonly kind: 'redial' }

/** Per-device reconcile memory. Immutable — every transition returns a copy. */
export interface AudioPlaneState {
  /** Consecutive passes that saw `declared-on` with no audio track. */
  readonly disagreements: number
  /** Re-dials issued since the last time audio was actually observed. */
  readonly redials: number
  readonly lastRedialMs: number
  /** True once `give-up` has been reported, so it is reported exactly once. */
  readonly gaveUp: boolean
}

export const EMPTY_AUDIO_PLANE_STATE: AudioPlaneState = {
  disagreements: 0,
  redials: 0,
  lastRedialMs: 0,
  gaveUp: false,
}

export interface AudioPlaneDecision {
  readonly action: AudioPlaneAction
  readonly nextState: AudioPlaneState
}

/**
 * Decide what one pass should do. Pure: no clock, no I/O, no broker.
 *
 * `nowMs` is passed in rather than read so the cooldown is testable without
 * waiting five minutes for it.
 */
export function decideAudioPlaneAction(
  observation: AudioPlaneObservation,
  state: AudioPlaneState,
  nowMs: number,
): AudioPlaneDecision {
  switch (observation.kind) {
    // Every AGREEING observation clears the memory completely, re-dial budget
    // included. A camera that recovered has earned its three attempts back —
    // the cap exists to stop a hopeless loop, not to ration a working one.
    case 'broker-muted':
    case 'no-live-source':
    case 'audio-present':
    case 'declared-off':
      return { action: { kind: 'none' }, nextState: EMPTY_AUDIO_PLANE_STATE }

    // A read that failed and a camera that cannot answer are both "we do not
    // know", and not-knowing must never move the machine one step closer to
    // tearing a healthy stream down. State is returned UNCHANGED — not
    // cleared either, so a genuine disagreement is not reset by one flaky
    // round trip on the pass in between.
    case 'read-failed':
    case 'audio-unknown':
      return { action: { kind: 'none' }, nextState: state }

    case 'declared-on': {
      if (state.gaveUp) return { action: { kind: 'none' }, nextState: state }
      const disagreements = state.disagreements + 1
      if (disagreements < AUDIO_PLANE_DISAGREEMENTS_TO_ACT) {
        return {
          action: { kind: 'await-second-pass' },
          nextState: { ...state, disagreements },
        }
      }
      if (state.redials >= AUDIO_PLANE_MAX_REDIALS) {
        return {
          action: { kind: 'give-up' },
          nextState: { ...state, disagreements, gaveUp: true },
        }
      }
      if (state.lastRedialMs > 0 && nowMs - state.lastRedialMs < AUDIO_PLANE_REDIAL_COOLDOWN_MS) {
        // Hold the counter at the threshold rather than letting it grow: the
        // number means "believed", and an unbounded count would say nothing
        // more while making the log line lie about how long we have waited.
        return {
          action: { kind: 'cooldown' },
          nextState: { ...state, disagreements: AUDIO_PLANE_DISAGREEMENTS_TO_ACT },
        }
      }
      return {
        action: { kind: 'redial' },
        nextState: {
          disagreements: 0,
          redials: state.redials + 1,
          lastRedialMs: nowMs,
          gaveUp: false,
        },
      }
    }
  }
}
