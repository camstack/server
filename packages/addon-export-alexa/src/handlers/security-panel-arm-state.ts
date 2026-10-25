/**
 * `alarm-panel` ↔ `Alexa.SecurityPanelController`, in both directions.
 *
 * Pure and on its own, for the reason the HomeKit side keeps its mapping
 * separate: this is where the translation is either honest or dangerous.
 *
 * ```
 *  cap state              armState       burglaryAlarm
 *  disarmed               DISARMED       OK
 *  armed_home             ARMED_STAY     OK
 *  armed_away             ARMED_AWAY     OK
 *  armed_night            ARMED_NIGHT    OK
 *  armed_vacation         ARMED_AWAY     OK    (see below)
 *  armed_custom_bypass    ARMED_STAY     OK    (see below)
 *  arming                 DISARMED       OK    (exit delay: NOT yet armed)
 *  disarming              DISARMED       OK
 *  pending                ARMED_AWAY     OK    (entry delay: still armed)
 *  triggered              ARMED_AWAY     ALARM
 * ```
 *
 * ## The two modes Alexa does not have
 *
 * Alexa knows `ARMED_STAY`, `ARMED_AWAY` and `ARMED_NIGHT`; the panel has five
 * arm modes. `armed_vacation` is an away arm for a longer absence and
 * `armed_custom_bypass` is armed with something deliberately excluded, which is
 * what STAY means to a controller. Both readings are true; a fourth state is
 * not on offer.
 *
 * ## The transitional states
 *
 * HomeKit folds an in-process memo; Alexa answers from one `getStatus`. The
 * cap now carries `targetMode` on the slice, so a night-armed entry delay can
 * report `ARMED_NIGHT` without inventing a second memo here. When
 * `targetMode` is absent the coarse floor still holds:
 *
 *  - `arming` → **DISARMED**. The exit delay has not set the system.
 *  - `disarming` → **DISARMED**.
 *  - `pending` → **ARMED_*** from `targetMode`, else **ARMED_AWAY**. Reporting
 *    DISARMED would hide a break-in in progress.
 *  - `triggered` → same arm-state rule plus `burglaryAlarm: ALARM`.
 *
 * ## What `burglaryAlarm` cannot represent
 *
 * Alexa splits the alarm into `burglaryAlarm` / `fireAlarm` /
 * `carbonMonoxideAlarm` / `waterAlarm`. The `alarm-panel` cap's `triggered`
 * says nothing about WHICH, so only `burglaryAlarm` is declared and raised —
 * the default reading of a security panel, and the one that is right for
 * intrusion, which is what this cap's `trigger` method exists for. A panel
 * that can distinguish alarm kinds needs a field on the cap first; declaring
 * the other three and always answering OK would be worse than not declaring
 * them, because an OK on `fireAlarm` is a claim we have no basis for.
 */
import type { AlarmArmMode, AlarmState } from '@camstack/types'

/** The arm states `Alexa.SecurityPanelController` defines. */
export type AlexaArmState = 'DISARMED' | 'ARMED_STAY' | 'ARMED_AWAY' | 'ARMED_NIGHT'

/** The value shape Alexa's alarm properties carry. */
export interface AlexaAlarmProperty {
  readonly value: 'ALARM' | 'OK'
}

/**
 * The panel modes behind each Alexa arm state, PRIMARY first — the mirror of
 * `MODES_BY_TARGET` in the HomeKit exporter, and for the same reason: one
 * Alexa state stands for two panel modes, so a panel offering only the
 * secondary would otherwise be sent a mode it refuses.
 */
const MODES_BY_ARM_STATE: Readonly<
  Record<Exclude<AlexaArmState, 'DISARMED'>, readonly AlarmArmMode[]>
> = {
  ARMED_STAY: ['home', 'custom_bypass'],
  ARMED_AWAY: ['away', 'vacation'],
  ARMED_NIGHT: ['night'],
}

const ARM_STATES: readonly Exclude<AlexaArmState, 'DISARMED'>[] = [
  'ARMED_STAY',
  'ARMED_AWAY',
  'ARMED_NIGHT',
]

/** Cap `targetMode` → Alexa arm state when the lifecycle word is transitional. */
function alexaArmStateForMode(mode: AlarmArmMode): AlexaArmState {
  switch (mode) {
    case 'home':
    case 'custom_bypass':
      return 'ARMED_STAY'
    case 'night':
      return 'ARMED_NIGHT'
    default:
      return 'ARMED_AWAY'
  }
}

/**
 * The panel's state as Alexa's `armState` property.
 *
 * Prefer `targetMode` on transitional words (`pending` / `triggered`) — a
 * night-armed entry delay must not collapse to ARMED_AWAY when the slice
 * names the mode.
 */
export function alexaArmStateFor(
  state: AlarmState,
  targetMode: AlarmArmMode | null | undefined = null,
): AlexaArmState {
  switch (state) {
    case 'armed_home':
    case 'armed_custom_bypass':
      return 'ARMED_STAY'
    case 'armed_night':
      return 'ARMED_NIGHT'
    case 'armed_away':
    case 'armed_vacation':
      return 'ARMED_AWAY'
    case 'pending':
    case 'triggered':
      // Entry delay / siren: still ARMED. Mode from the slice when present.
      return targetMode !== null && targetMode !== undefined
        ? alexaArmStateForMode(targetMode)
        : 'ARMED_AWAY'
    default:
      // disarmed, arming (exit delay — not yet set) and disarming.
      return 'DISARMED'
  }
}

/** `burglaryAlarm`, the only alarm property this cap can honestly fill. */
export function burglaryAlarmFor(state: AlarmState): AlexaAlarmProperty {
  return { value: state === 'triggered' ? 'ALARM' : 'OK' }
}

/**
 * The `supportedArmStates` for discovery.
 *
 * `DISARMED` is always present: disarming is not one of the panel's arm modes.
 * An EMPTY `availableModes` is unknown, not "none" — a provider that never
 * populated the list looks identical to one that accepts nothing, and
 * publishing a panel that can only be disarmed on that guess takes the
 * controls off a working alarm. The caller logs it.
 */
export function supportedArmStatesFor(
  availableModes: readonly AlarmArmMode[],
): readonly AlexaArmState[] {
  const arms =
    availableModes.length === 0
      ? ARM_STATES
      : ARM_STATES.filter((armState) =>
          MODES_BY_ARM_STATE[armState].some((mode) => availableModes.includes(mode)),
        )
  return [...arms, 'DISARMED']
}

/**
 * The arm mode to send for an Alexa arm state, or `null` when there is none.
 *
 * `null` is not a shrug: `DISARMED` is the Disarm DIRECTIVE, a different call,
 * and an arm state the panel accepts no mode for is a directive the handler
 * refuses with `NOT_READY_FOR_ARM` rather than translating into a guess.
 */
export function alarmArmModeForAlexa(
  armState: AlexaArmState,
  availableModes: readonly AlarmArmMode[],
): AlarmArmMode | null {
  if (armState === 'DISARMED') return null
  const candidates = MODES_BY_ARM_STATE[armState]
  if (availableModes.length === 0) return candidates[0] ?? null
  return candidates.find((mode) => availableModes.includes(mode)) ?? null
}
