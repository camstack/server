/**
 * The alarm's sensor table — what each row SAYS and what its switch WRITES —
 * with no UI in it.
 *
 * TWO BYTE-IDENTICAL COPIES: the admin keeps this at `pages/system/`, the
 * VIEWER at `src/components/notifications/`, because the viewer resolves
 * `@camstack/types` from a published release. `scripts/check-device-selection-in-sync.ts`
 * holds them equal (modulo the viewer's `.js` import specifier). Imports only
 * `@camstack/types` and `./device-picker-model`; no `toSorted`.
 *
 *  - D315: only an ANSWER says closed. Pending, failed, an id the answer lacks and
 *    an `unknown` reading each have their own cell; none of them looks like a
 *    closed contact. "The hub is too old" is claimed from the error text that
 *    NAMES the missing read and from nothing else — a timeout is a failed read.
 *  - D49: a listed id the device list no longer holds stays a row (`removed`)
 *    until the operator removes it; a read never drops it.
 *  - The coverage column EQUALS the arm check. `alarmCoveredDevices` reads only
 *    NAMED ids (`coverage.deviceIds`); a rule with no device scope is never read
 *    by it, so a device covered only by such a rule is `unscoped` and "never blocks
 *    this mode". A skip mutes notifications; it does not stop the arm check, so
 *    a skipped device still blocks arming (`arm-checked-skipped`).
 *  - Q2 (operator, 2026-10-02): a sensor no rule of the mode covers — in the
 *    arm-check sense above, so an all-devices-only one too — is NOT a row. The one
 *    exception is an uncovered sensor a membership list still holds
 *    (`listedUncovered`): D49 forbids an invisible stored entry, so it is shown,
 *    labelled, and its switch removes the entry. A removed id stays a row.
 *  - Controllable openings (cover / lock / switch): Blocks default OFF (opt-in
 *    via `blocking`); Secure on arm default ON (opt-out via `secureOnArmOff`).
 *    Contacts keep Blocks default ON via `nonBlocking`.
 */
import {
  alarmDeviceBlocksArming,
  alarmDeviceSecureOnArm,
  alarmPatchLanded,
} from '@camstack/types/client'
import type {
  AlarmArmMode,
  NcAlarmModeCoverage,
  NcAlarmSensorState,
  NcAlarmSettings,
  NcAlarmSettingsPatch,
  NcAlarmSkipReason,
} from '@camstack/types'
import type { PickerDevice } from './device-picker-model.js'

export type AlarmSensorsRead =
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'answered'; readonly sensors: readonly NcAlarmSensorState[] }

export type AlarmSensorCell =
  | { readonly kind: 'checking' }
  | { readonly kind: 'hub-too-old' }
  | { readonly kind: 'read-failed'; readonly error: string }
  | { readonly kind: 'open'; readonly word: string; readonly offline: boolean }
  | { readonly kind: 'closed'; readonly word: string; readonly offline: boolean }
  | { readonly kind: 'unknown'; readonly why: 'read-failed' | 'unknown-word' | 'not-answered' }
  | { readonly kind: 'not-opening' }
  | { readonly kind: 'removed' }

/** The refusals that NAME the missing read — the only proof the hub lacks it. */
export const ALARM_SENSORS_MISSING_PATTERNS: readonly RegExp[] = [
  // Older addon on the viewer path (child-addon-call-dispatch / addon-runner wordings).
  /has no (?:handler for )?custom action ["']nc\.getAlarmSensors["']/,
  // Older HOST (tRPC v11).
  /No "query"-procedure on path "notificationRules\.getAlarmSensors"/,
  // New host, older post-analysis (child-cap-dispatch).
  /method 'getAlarmSensors' not found on provider 'notification-rules'/,
]

/** By NAME only (spec §3.4) — anything else is a transient failure. */
export function alarmSensorsHubTooOld(error: string): boolean {
  return ALARM_SENSORS_MISSING_PATTERNS.some((p) => p.test(error))
}

export function alarmSensorCell(
  read: AlarmSensorsRead,
  deviceId: number,
  removed: boolean,
): AlarmSensorCell {
  if (removed) return { kind: 'removed' }
  if (read.status === 'pending') return { kind: 'checking' }
  if (read.status === 'failed') {
    return alarmSensorsHubTooOld(read.error)
      ? { kind: 'hub-too-old' }
      : { kind: 'read-failed', error: read.error }
  }
  const sensor = read.sensors.find((s) => s.deviceId === deviceId)
  if (sensor === undefined) return { kind: 'unknown', why: 'not-answered' }
  switch (sensor.reading) {
    case 'unknown':
      return { kind: 'unknown', why: sensor.unknownWhy ?? 'read-failed' }
    case 'open':
      return {
        kind: 'open',
        word: sensor.state ?? sensor.reading,
        offline: sensor.online === false,
      }
    case 'closed':
      return {
        kind: 'closed',
        word: sensor.state ?? sensor.reading,
        offline: sensor.online === false,
      }
    case 'not-opening':
      return { kind: 'not-opening' }
  }
}

/**
 * Controllable when the sensors read answered so, else from the device type
 * (cover / lock / switch) so the defaults do not flash while sensors load.
 */
export function alarmSensorControllable(
  read: AlarmSensorsRead,
  deviceId: number,
  removed: boolean,
  deviceType: string | null | undefined,
): boolean {
  if (removed) return false
  if (read.status === 'answered') {
    const sensor = read.sensors.find((s) => s.deviceId === deviceId)
    if (sensor !== undefined) return sensor.controllable === true
  }
  const t = (deviceType ?? '').toLowerCase()
  return t === 'cover' || t === 'lock' || t === 'switch'
}

/** Equal to the arm check — see the header. */
export type AlarmCoverageCell =
  | { readonly kind: 'arm-checked' }
  | { readonly kind: 'arm-checked-skipped'; readonly reason: NcAlarmSkipReason }
  | { readonly kind: 'unscoped' }
  | { readonly kind: 'not-covered' }

export function alarmCoverageCell(
  coverage: NcAlarmModeCoverage,
  deviceId: number,
): AlarmCoverageCell {
  if (coverage.deviceIds.includes(deviceId)) {
    const skipped = coverage.skippedDevices.find((s) => s.deviceId === deviceId)
    return skipped === undefined
      ? { kind: 'arm-checked' }
      : { kind: 'arm-checked-skipped', reason: skipped.reason }
  }
  if (coverage.allDevices && !coverage.allDevicesExcept.includes(deviceId)) {
    return { kind: 'unscoped' }
  }
  return { kind: 'not-covered' }
}

/** True when no rule of the mode makes the arm check read this id. */
export function alarmCoverageNeverBlocks(cell: AlarmCoverageCell): boolean {
  return cell.kind === 'unscoped' || cell.kind === 'not-covered'
}

export interface AlarmSensorRow {
  readonly device: PickerDevice
  readonly removed: boolean
  readonly cell: AlarmSensorCell
  readonly coverage: AlarmCoverageCell
  /** Cover / lock / switch — shows the Secure-on-arm switch. */
  readonly controllable: boolean
  /** The switch: ON = blocks arming. */
  readonly blocks: boolean
  /** Controllable only: ON = close/lock/off on arm (default). */
  readonly secureOnArm: boolean
  /**
   * Shown only because a membership list holds it: no rule of the
   * mode makes the arm check read it (Q2). Never true for a removed row.
   */
  readonly listedUncovered: boolean
}

export interface AlarmSensorRowsInput {
  readonly candidates: readonly PickerDevice[]
  readonly removedIds: ReadonlySet<number>
  readonly coverage: NcAlarmModeCoverage
  readonly nonBlocking: readonly number[]
  readonly blocking: readonly number[]
  readonly secureOnArmOff: readonly number[]
  readonly sensors: AlarmSensorsRead
}

/**
 * One row per candidate the mode's rules cover, a removed id (D49) and an
 * uncovered id a membership list still holds (`listedUncovered`); by name
 * then id.
 */
export function alarmSensorRows(input: AlarmSensorRowsInput): readonly AlarmSensorRow[] {
  const ordered = [...input.candidates].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
  const rows: AlarmSensorRow[] = []
  for (const device of ordered) {
    const removed = input.removedIds.has(device.id)
    const coverage = alarmCoverageCell(input.coverage, device.id)
    const controllable = alarmSensorControllable(input.sensors, device.id, removed, device.type)
    const blocks = alarmDeviceBlocksArming({
      controllable,
      deviceId: device.id,
      nonBlocking: input.nonBlocking,
      blocking: input.blocking,
    })
    const secureOnArm = alarmDeviceSecureOnArm({
      controllable,
      deviceId: device.id,
      secureOnArmOff: input.secureOnArmOff,
    })
    const heldAsException =
      input.nonBlocking.includes(device.id) ||
      input.blocking.includes(device.id) ||
      input.secureOnArmOff.includes(device.id)
    const listedUncovered =
      !removed &&
      alarmCoverageNeverBlocks(coverage) &&
      (!blocks || heldAsException) &&
      heldAsException
    if (!removed && alarmCoverageNeverBlocks(coverage) && !heldAsException) continue
    rows.push({
      device,
      removed,
      cell: alarmSensorCell(input.sensors, device.id, removed),
      coverage,
      controllable,
      blocks,
      secureOnArm,
      listedUncovered,
    })
  }
  return rows
}

export interface AlarmSensorTableStateInput {
  readonly rowCount: number
  /** The household scan ANSWERED: the candidate list is whole, not just what was already known. */
  readonly candidatesComplete: boolean
}

/** 'none' is a claim only a complete candidate list can make (D315). */
export function alarmSensorTableState(
  input: AlarmSensorTableStateInput,
): 'rows' | 'pending' | 'none' {
  if (input.rowCount > 0) return 'rows'
  return input.candidatesComplete ? 'none' : 'pending'
}

/** The ids to read, ascending, split into calls of at most `max` (NC_ALARM_SENSORS_MAX). */
export function alarmSensorReadChunks(
  ids: readonly number[],
  max: number,
): readonly (readonly number[])[] {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`alarmSensorReadChunks: the bound must be an integer >= 1, got ${max}`)
  }
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  const out: number[][] = []
  for (let at = 0; at < sorted.length; at += max) out.push(sorted.slice(at, at + max))
  return out
}

export type AlarmSwitchKind = 'blocks' | 'secureOnArm'

export interface AlarmSwitchWrite {
  readonly mode: AlarmArmMode
  readonly deviceId: number
  readonly name: string
  readonly kind: AlarmSwitchKind
  /** For blocks: true = non-blocking (contact) or not on blocking list (controllable). */
  readonly nextValue: boolean
  readonly controllable: boolean
}

export type AlarmSwitchBegin =
  | { readonly kind: 'start'; readonly write: AlarmSwitchWrite }
  | { readonly kind: 'refused'; readonly inFlight: AlarmSwitchWrite }

/** One write at a time: a second is refused NAMING the one in flight. */
export function beginAlarmSwitch(
  inFlight: AlarmSwitchWrite | null,
  mode: AlarmArmMode,
  row: AlarmSensorRow,
  switchKind: AlarmSwitchKind,
  nextValue: boolean,
): AlarmSwitchBegin {
  if (inFlight !== null) return { kind: 'refused', inFlight }
  return {
    kind: 'start',
    write: {
      mode,
      deviceId: row.device.id,
      name: row.device.name,
      kind: switchKind,
      nextValue,
      controllable: row.controllable,
    },
  }
}

export function alarmSwitchPatch(write: AlarmSwitchWrite): NcAlarmSettingsPatch {
  if (write.kind === 'secureOnArm') {
    return {
      secureOnArmEdit: {
        mode: write.mode,
        deviceId: write.deviceId,
        secureOnArm: write.nextValue,
      },
    }
  }
  if (write.controllable) {
    return {
      blockingEdit: {
        mode: write.mode,
        deviceId: write.deviceId,
        blocking: write.nextValue,
      },
    }
  }
  return {
    nonBlockingEdit: {
      mode: write.mode,
      deviceId: write.deviceId,
      nonBlocking: !write.nextValue,
    },
  }
}

export type AlarmSwitchOutcome = { readonly kind: 'landed' } | { readonly kind: 'not-landed' }

export function alarmSwitchOutcome(
  write: AlarmSwitchWrite,
  returned: NcAlarmSettings,
): AlarmSwitchOutcome {
  return alarmPatchLanded(alarmSwitchPatch(write), returned)
    ? { kind: 'landed' }
    : { kind: 'not-landed' }
}
