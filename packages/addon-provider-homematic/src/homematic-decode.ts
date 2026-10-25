import type {
  ClimateControlStatus,
  CoverStatus,
  HvacMode,
  LockControlStatus,
} from '@camstack/types'
import type { HmValue } from 'nodehomematic'

/**
 * Pure decoders translating a single Homematic datapoint (parameter +
 * value) into an immutable patch for the owning CamStack cap slice.
 * Kept free of any `BaseDevice` / facade dependency so they are unit-
 * testable in isolation and the device class stays a thin wiring layer.
 *
 * Datapoint parameter names are the authoritative HmIP set captured from
 * the live CCU. Values arrive already converted by the library (BOOL →
 * boolean, FLOAT → number, ENUM → number index).
 */

/** Local mirror of the library's non-exported `ClimateMode` union. */
export type HmClimateMode = 'auto' | 'heat' | 'off'

/** HmIP `CONTROL_MODE` ENUM index → library climate mode. Numeric-arm
 *  fallback only (see {@link fromHmControlMode}) — the wire index, used
 *  when the value list did not resolve. */
const HM_CONTROL_MODE_BY_INDEX: Readonly<Record<number, HmClimateMode>> = {
  0: 'auto',
  1: 'heat', // MANU
  2: 'heat', // PARTY / holiday — treated as a manual setpoint
  3: 'heat', // BOOST — slice boost is tracked separately via BOOST_MODE
}

/**
 * HmIP `CONTROL_MODE` ENUM member (the CONVERTED value the library hands
 * over — `nodehomematic` resolves the value list, same as `LOCK_STATE` /
 * `ACTIVITY_STATE`, see {@link readLockState} / {@link readTravel}) →
 * library climate mode. Matched BY NAME, case-insensitively.
 */
const HM_CONTROL_MODE_BY_NAME: Readonly<Record<string, HmClimateMode>> = {
  'AUTO-MODE': 'auto',
  'MANU-MODE': 'heat',
  'PARTY-MODE': 'heat', // holiday — treated as a manual setpoint
  'BOOST-MODE': 'heat', // slice boost is tracked separately via BOOST_MODE
}

/** Map a CamStack `HvacMode` to the library's narrower climate mode. */
export function toHmClimateMode(mode: HvacMode): HmClimateMode {
  switch (mode) {
    case 'off':
      return 'off'
    case 'auto':
    case 'heat_cool':
      return 'auto'
    default:
      // heat / cool / dry / fan_only all drive the valve manually.
      return 'heat'
  }
}

/**
 * Map a library climate mode back to the CamStack `HvacMode`.
 *
 * Like {@link readLockState} / {@link readTravel}, the library delivers a
 * CONVERTED ENUM string on the live CCU (`'AUTO-MODE'` etc) — testing
 * `typeof value === 'number'` alone meant a resolved `CONTROL_MODE` never
 * decoded at all. The numeric arm survives for a datapoint whose value
 * list did not resolve.
 */
export function fromHmControlMode(value: HmValue): HvacMode | null {
  if (typeof value === 'string') {
    const mode = HM_CONTROL_MODE_BY_NAME[value.toUpperCase()]
    if (mode === undefined) return null
    return mode === 'auto' ? 'auto' : 'heat'
  }
  if (typeof value !== 'number') return null
  const mode = HM_CONTROL_MODE_BY_INDEX[value]
  if (mode === undefined) return null
  return mode === 'auto' ? 'auto' : 'heat'
}

/** Convert a 0..1 HmIP LEVEL into a 0..100 CamStack position (rounded). */
export function levelToPercent(level: number): number {
  return Math.round(Math.max(0, Math.min(1, level)) * 100)
}

/**
 * Decode a cover datapoint into a CoverStatus patch, or `null` when the
 * parameter is irrelevant. `LEVEL` is the 0..1 position; `ACTIVITY_STATE`
 * is an ENUM (0 inactive, 1 up/opening, 2 down/closing) used for the
 * lifecycle state.
 */
export function decodeCover(
  previous: CoverStatus,
  parameter: string,
  value: HmValue,
  now: number,
): CoverStatus | null {
  // `LEVEL` only. `LEVEL_STATUS` was in here too and it is NOT a level: read
  // off the live CCU, it is an ENUM whose value list is
  // `NORMAL|UNKNOWN|OVERFLOW|UNDERFLOW|ERROR` and whose `CONTROL` is
  // `SHUTTER_VIRTUAL_RECEIVER.LEVEL` — the STATUS of the level, not the level.
  // Today it arrives converted to a string so this branch skipped it by
  // accident; the day a value list failed to resolve, `ERROR` would have
  // arrived as `4` and been published as a 400 % position.
  if (parameter === 'LEVEL' && typeof value === 'number') {
    const position = levelToPercent(value)
    return {
      ...previous,
      position,
      // A LEVEL update during a move must NOT end the move. Homematic streams
      // LEVEL continuously while the motor runs, so deriving `open`/`closed`
      // here unconditionally wiped the `closing` that `ACTIVITY_STATE` had
      // just set — the transient was destroyed by the very messages that prove
      // the cover is moving, and no surface ever saw one. Only ACTIVITY_STATE
      // ends a move; this branch reports WHERE it has got to.
      state: isMoving(previous.state) ? previous.state : restingState(position),
      lastChangedAt: now,
    }
  }
  if (parameter === 'ACTIVITY_STATE' || parameter === 'DIRECTION') {
    const travel = readTravel(value)
    if (travel === 'unknown') return null
    if (travel === 'opening') return { ...previous, state: 'opening', lastChangedAt: now }
    if (travel === 'closing') return { ...previous, state: 'closing', lastChangedAt: now }
    // Idle: the move ENDED. Resolving from the last known position is the only
    // thing that ends it — `previous.state` kept the transient for ever, so a
    // cover that finished closing stayed `closing` until the next unrelated
    // LEVEL arrived, and with the LEVEL branch fixed, never.
    return { ...previous, state: restingState(previous.position), lastChangedAt: now }
  }
  return null
}

/** The two states a cover rests in. `null` position = no intermediate surface;
 *  such a device reports its rest state through LEVEL's 0/1 ends only, so an
 *  unknown position keeps whatever was last known rather than inventing one. */
function restingState(position: number | null): CoverStatus['state'] {
  if (position === null) return 'stopped'
  return position <= 0 ? 'closed' : 'open'
}

/** Is this a MOVE in progress? The two transient states, named once. */
function isMoving(state: CoverStatus['state']): boolean {
  return state === 'opening' || state === 'closing'
}

/** What a travel datapoint says, or `unknown` when this build cannot read it. */
export type CoverTravel = 'opening' | 'closing' | 'idle' | 'unknown'

/**
 * Read a cover's travel datapoint, whichever of the two it is and in whichever
 * form the library hands it over.
 *
 * Two axes, and getting either wrong costs the whole transient:
 *
 *  - **The PARAMETER differs by family.** HmIP reports travel on
 *    `ACTIVITY_STATE`, classic RF on `DIRECTION` — `nodehomematic`'s profiles
 *    map both onto its own `Field.DIRECTION`. Listening only for
 *    `ACTIVITY_STATE` left every RF cover with no travel at all.
 *  - **The VALUE is a converted string, not the wire index.** The library's
 *    `ValueChangedEvent.value` is documented as "New converted value", and its
 *    inbound ENUM converter maps the CCU's index onto the value-list member.
 *    This decoder tested `typeof value === 'number'`, which a converted ENUM
 *    never is — so the branch never fired and the cover never reported a move.
 *    That is why the operator pressed "down" and saw nothing.
 *
 * Matched BY NAME on purpose. The two value lists differ in their members,
 * not merely their order: measured on this CCU, HmIP's `ACTIVITY_STATE` is
 * `UNKNOWN|UP|DOWN|STABLE` — its rest member is `STABLE` and it carries a
 * fourth meaning, "no opinion", that RF's `NONE|UP|DOWN|UNDEFINED` has no
 * equivalent for. An index mapping would be a guess about a list this code
 * never sees; a name mapping is not.
 *
 * The numeric arm survives only for a datapoint whose value list the library
 * could not resolve. Index 0 is the non-travelling member in BOTH families, so
 * it ends a move; 1 and 2 are up and down in both.
 */
export function readTravel(value: HmValue): CoverTravel {
  if (typeof value === 'string') {
    const v = value.toUpperCase()
    if (v === 'UP' || v === 'OPENING') return 'opening'
    if (v === 'DOWN' || v === 'CLOSING') return 'closing'
    // `STABLE` is HmIP's rest member and it is the one that ENDS a move —
    // measured on this CCU, channel 4 of 00111BE992A8E5:
    //   ACTIVITY_STATE  TYPE=ENUM  VALUE_LIST = UNKNOWN|UP|DOWN|STABLE
    // Without it the transient never resolved and the button would have
    // pulsed for ever. The RF names are kept beside it for that family.
    if (v === 'STABLE' || v === 'NONE' || v === 'INACTIVE' || v === 'STOP' || v === 'STOPPED')
      return 'idle'
    // `UNKNOWN` is HmIP's DEFAULT and means exactly that. It is NOT "stopped",
    // so it changes nothing — ending a move because the CCU has no opinion
    // would drop the pulse mid-travel.
    return 'unknown'
  }
  if (typeof value === 'number') {
    if (value === 0) return 'idle'
    if (value === 1) return 'opening'
    if (value === 2) return 'closing'
    return 'unknown'
  }
  return 'unknown'
}

/** What a `LOCK_STATE` datapoint says, or `unknown` when the CCU has no opinion. */
export type HmLockReading = 'locked' | 'unlocked' | 'unknown'

/**
 * Read `LOCK_STATE`, in either form the library hands it over.
 *
 * Like the cover's travel ENUM (see {@link readTravel}), the library delivers a
 * CONVERTED ENUM — the value-list member, `UNKNOWN|LOCKED|UNLOCKED` on HmIP —
 * and only falls back to the wire index (0 unknown, 1 locked, 2 unlocked) when
 * the value list did not resolve. Testing `typeof value === 'number'` alone
 * meant a resolved lock never decoded at all.
 */
export function readLockState(value: HmValue): HmLockReading {
  if (typeof value === 'string') {
    const v = value.toUpperCase()
    if (v === 'LOCKED') return 'locked'
    if (v === 'UNLOCKED') return 'unlocked'
    return 'unknown'
  }
  if (value === 1) return 'locked'
  if (value === 2) return 'unlocked'
  return 'unknown'
}

/**
 * Decode a lock datapoint into a LockControlStatus patch, or `null` when the
 * datapoint carries nothing to write.
 *
 * An UNKNOWN `LOCK_STATE` is `null` — it never becomes a reading. It used to
 * keep `previous.state` and stamp it `now`: after a respawn `previous` is
 * `COLD_LOCK`, a placeholder `unlocked` (`lastChangedAt: 0`), and the CCU
 * saying "I don't know" turned it into a real, fresh unlock the alarm could
 * act on. Returning `null` leaves a placeholder a placeholder, and a real
 * reading exactly as it was, timestamp included (D49: unknown is never a
 * state). The caller logs the drop. Unlike the other decoders in this file,
 * no reading is ever derived from the previous slice, so there is no
 * `previous` parameter to carry.
 */
export function decodeLock(
  parameter: string,
  value: HmValue,
  now: number,
): LockControlStatus | null {
  if (parameter !== 'LOCK_STATE') return null
  const reading = readLockState(value)
  if (reading === 'unknown') return null
  return { state: reading, lastChangedAt: now }
}

/**
 * Decode a climate datapoint into a ClimateControlStatus patch.
 * Parameters: SET_POINT_TEMPERATURE (target °C), ACTUAL_TEMPERATURE
 * (current °C), HUMIDITY (%), CONTROL_MODE (ENUM), BOOST_MODE (bool).
 */
export function decodeClimate(
  previous: ClimateControlStatus,
  parameter: string,
  value: HmValue,
  now: number,
): ClimateControlStatus | null {
  if (parameter === 'SET_POINT_TEMPERATURE' && typeof value === 'number') {
    return { ...previous, target: value, lastFetchedAt: now }
  }
  if (parameter === 'ACTUAL_TEMPERATURE' && typeof value === 'number') {
    return { ...previous, currentTemp: value, lastFetchedAt: now }
  }
  if (parameter === 'HUMIDITY' && typeof value === 'number') {
    return { ...previous, currentHumidity: value, lastFetchedAt: now }
  }
  if (parameter === 'CONTROL_MODE') {
    const mode = fromHmControlMode(value)
    if (mode === null) return null
    // BOOST is reflected on the preset, not the base mode.
    return { ...previous, mode, lastFetchedAt: now }
  }
  if (parameter === 'BOOST_MODE' && typeof value === 'boolean') {
    return { ...previous, preset: value ? 'boost' : '', lastFetchedAt: now }
  }
  return null
}
