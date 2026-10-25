/**
 * The words the alarm panel answers to the `deviceState` gate (D630).
 *
 * A rule gated on `armed_away` is an intruder rule for the AWAY mode, and the
 * panel leaves `armed_away` exactly when an intruder is found: `pending` (the
 * entry delay) and then `triggered` (the siren). Answering only the bare state
 * silenced every such rule for the whole incident — the detections that matter
 * most were the ones no longer reported. So while the panel is `pending` or
 * `triggered`, it ALSO answers as the armed mode it belongs to (its machine's
 * `target`).
 *
 * Never while `arming`: people are still leaving. And never for another mode:
 * a `triggered` whose target is `armed_night` answers `armed_night`, not
 * `armed_away`. The target comes from the panel's own machine, which only the
 * Notification Center's in-process panel knows — any other device answers one
 * word.
 */

import type { AlarmState } from '@camstack/types'
import type { NcDeviceStateLookup } from '../rule-engine.js'

/** The states that belong to an armed mode without being it. */
const INCIDENT_STATES: ReadonlySet<AlarmState> = new Set<AlarmState>(['pending', 'triggered'])

/** `[state]`, plus `target` while `state` is `pending`/`triggered` of an armed mode. */
export function alarmGateWords(state: AlarmState, target: string): readonly string[] {
  if (INCIDENT_STATES.has(state) && target.startsWith('armed_')) return [state, target]
  return [state]
}

/**
 * The words the panel published last. `words[0]` is the state itself, by
 * construction of {@link alarmGateWords}.
 */
export interface NcPanelGateWords {
  readonly deviceId: number
  readonly words: readonly string[]
}

/**
 * The engine's lookup: every device answers its one mirrored word, and the
 * panel answers its gate words — but only while the mirror AGREES on the state.
 *
 * The mirror keeps the freshness policy (an expired or cold entry is
 * `undefined`, which fails the gate closed — D49); the alias only widens an
 * answer the mirror already gives. A target paired with a state it was not
 * published with would be a guess, so a disagreement answers the mirror alone.
 */
export function panelAwareLookup(
  read: (deviceId: number) => string | undefined,
  panel: NcPanelGateWords | null,
): NcDeviceStateLookup {
  return (deviceId) => {
    const state = read(deviceId)
    if (state === undefined) return undefined
    if (panel !== null && panel.deviceId === deviceId && sameWord(panel.words[0], state)) {
      return panel.words
    }
    return [state]
  }
}

function sameWord(a: string | undefined, b: string): boolean {
  return a !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()
}
