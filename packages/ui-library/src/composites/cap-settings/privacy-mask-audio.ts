/**
 * The camera's MICROPHONE, as the privacy-mask panel controls it
 * ([D113](../../../../../docs/decisions/adr-0113.md) phase 3, the
 * `device-audio` row).
 *
 * | Function | Authority read | Authority written |
 * | --- | --- | --- |
 * | `device-audio` | `privacyMask.getOptions().supportsAudioMute` + `getStatus().audioEnabled` | `privacyMask.setAudioEnabled` |
 *
 * The cap already owns both privacy planes — what the camera does not film and
 * what it does not hear — so the microphone belongs in this panel and nowhere
 * else. It had no surface at all outside the aggregate switch group; without
 * this it would have become unwritable the day the group is deleted, on the one
 * authority whose store is the CAMERA and which therefore cannot be repaired
 * from the hub's own state.
 *
 * **The microphone is not part of the mask draft.** It has its own mutation
 * (`setAudioEnabled`, deliberately not a field on `PrivacyMaskPatch`) and it is
 * written immediately and read back, exactly as the switch that preceded it
 * did. Folding it into Save would mean a Save of the ZONES also rewrote the
 * microphone — two unrelated facts behind one button.
 *
 * Three answers, and collapsing any two loses a real distinction:
 *  - options unread → `null` (UNKNOWN — never "the camera has no microphone")
 *  - `supportsAudioMute: false` → not supported (no control at all)
 *  - supported but `audioEnabled: null` → UNKNOWN, never `false`
 */

export interface CameraMicrophoneState {
  readonly label: string
  /** Does this camera expose a microphone switch that can actually be written? */
  readonly supported: boolean
  /** `null` = nothing answered. Never coerced — "off" and "unknown" differ. */
  readonly on: boolean | null
  /** A control is only offered when the plane is supported AND its state known. */
  readonly available: boolean
  /** What the operator loses while it is off. */
  readonly costWhenOff: string
}

export interface CameraMicrophoneInput {
  /** `getOptions().supportsAudioMute`; `null` when the read failed. */
  readonly supportsAudioMute: boolean | null
  /** `getStatus().audioEnabled`; `null` when unknown or unread. */
  readonly audioEnabled: boolean | null
  /** The value an in-flight write asked for; `null` when nothing is in flight. */
  readonly pendingOn?: boolean | null
}

export const CAMERA_MICROPHONE_LABEL = 'Microphone'

const COST_WHEN_OFF =
  'The camera encodes no audio at all — live view, recordings, exports and the audio analyzer are all silent.'

export function resolveCameraMicrophone(input: CameraMicrophoneInput): CameraMicrophoneState {
  // Options unread is UNKNOWN, not "unsupported": rendering "this camera has no
  // microphone" because one probe timed out is a claim, and a wrong one.
  const supported = input.supportsAudioMute === true
  const read = supported ? input.audioEnabled : null
  const pending = input.pendingOn ?? null
  const on = read === null ? null : (pending ?? read)
  return {
    label: CAMERA_MICROPHONE_LABEL,
    supported,
    on,
    available: supported && read !== null,
    costWhenOff: COST_WHEN_OFF,
  }
}

/** The write ONE toggle implies, in the cap's own vocabulary. */
export interface CameraMicrophoneWrite {
  readonly enabled: boolean
}

/**
 * Polarity here is straight-through (`enabled` means "capturing sound"), which
 * is exactly why it is still pinned by a test: the sibling rows in this
 * refactor (`broker-audio`, `notifications`) both INVERT, and a reader who has
 * just come from one of those is one keystroke from making this one match.
 */
export function cameraMicrophoneWrite(state: CameraMicrophoneState): CameraMicrophoneWrite | null {
  if (!state.available || state.on === null) return null
  return { enabled: !state.on }
}
