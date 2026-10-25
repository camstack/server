/**
 * The panel as it is NOW — `NcAlarmConfig.live`, which the admin's Alarm tab
 * and the viewer's `nc.getAlarmStatus` both render (D630).
 *
 * Pure: the centre reads the openings and hands them in. Two properties are
 * the point of keeping this separate from the arm check:
 *
 *  - it answers for EVERY mode from ONE read — the caller unions the covered
 *    devices of all modes and reads each id once, so a status poll is never a
 *    fan-out of one read per mode;
 *  - it never throws and never guesses (D49): a device the read did not
 *    answer for, or whose opening word its cap does not define, is `unknown`
 *    — neither open nor closed. A status the UI polls must not fail because
 *    one contact is asleep, and must not show that contact as closed.
 */

import type { AlarmArmMode, AlarmState, NcAlarmConfig, NcAlarmSettings } from '@camstack/types'
import { armModeOf, type NcDeviceNameLookup } from './alarm-mode-coverage.js'
import { classifyCoveredOpening, type NcAlarmOpening } from './alarm-openings.js'
import type { NcAlarmInputBypassRecord } from './alarm-input-bypasses.js'
import type { NcAlarmExclusionPhase } from './alarm-panel-device.js'

/**
 * Derived from the published `NcAlarmConfig` rather than imported: the live
 * sub-schemas are not on the `@camstack/types` barrel, and adding them would
 * be a framework train for a name.
 */
export type NcAlarmLive = NonNullable<NcAlarmConfig['live']>
type NcAlarmModeOpenings = NcAlarmLive['openings'][number]

export interface NcAlarmLiveInput {
  readonly state: AlarmState
  /** The machine's target (`disarmed` or `armed_<mode>`). */
  readonly target: AlarmState
  readonly modes: readonly AlarmArmMode[]
  /** Per mode, the devices its rules cover (`alarmCoveredDevices`). */
  readonly covered: ReadonlyMap<AlarmArmMode, readonly number[]>
  /** ONE read of the union of `covered`; empty when the read failed. */
  readonly openings: ReadonlyMap<number, NcAlarmOpening>
  readonly nonBlocking: NcAlarmSettings['nonBlocking']
  readonly exclusions: readonly NcAlarmExclusionPhase[]
  /** The (rule, input) pairs this arm session ignores — the panel's list, read. */
  readonly bypasses: readonly NcAlarmInputBypassRecord[]
  /** The rule's CURRENT name, or undefined when the rule is gone (its frozen name is used). */
  readonly ruleName: (ruleId: string) => string | undefined
  readonly name: NcDeviceNameLookup
}

/** Every covered id across all modes, ascending, once — what the one read asks for. */
export function alarmLiveReadIds(
  covered: ReadonlyMap<AlarmArmMode, readonly number[]>,
): readonly number[] {
  const ids = new Set<number>()
  for (const list of covered.values()) for (const id of list) ids.add(id)
  return [...ids].toSorted((a, b) => a - b)
}

function modeOpenings(input: NcAlarmLiveInput, mode: AlarmArmMode): NcAlarmModeOpenings {
  const tolerated = new Set(input.nonBlocking.find((l) => l.mode === mode)?.deviceIds ?? [])
  const devices: NcAlarmModeOpenings['devices'] = []
  const unknown: number[] = []
  for (const deviceId of input.covered.get(mode) ?? []) {
    const verdict = classifyCoveredOpening(input.openings.get(deviceId))
    if (verdict.kind === 'unknown') {
      unknown.push(deviceId)
      continue
    }
    if (verdict.kind === 'skip') continue
    devices.push({
      deviceId,
      name: input.name(deviceId),
      state: verdict.state,
      blocking: !tolerated.has(deviceId),
    })
  }
  return { mode, devices, unknown }
}

export function buildAlarmLive(input: NcAlarmLiveInput): NcAlarmLive {
  return {
    state: input.state,
    targetMode: armModeOf(input.target, input.modes),
    availableModes: [...input.modes],
    openings: input.modes.map((mode) => modeOpenings(input, mode)),
    exclusions: input.exclusions.map((e) => ({
      deviceId: e.deviceId,
      name: input.name(e.deviceId),
      phase: e.phase,
    })),
    bypassedInputs: input.bypasses.map((b) => ({
      ruleId: b.ruleId,
      ruleName: input.ruleName(b.ruleId) ?? b.ruleName,
      deviceId: b.deviceId,
      name: input.name(b.deviceId),
      since: b.at,
      dropped: b.dropped,
    })),
  }
}
