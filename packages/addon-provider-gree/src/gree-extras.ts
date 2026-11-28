import { DeviceRole, DeviceType, ERROR_STATUS_COLD, type ErrorStatus } from '@dominevo/types'

/**
 * Status columns the vendored library's `updateState` does not ask for. They are
 * read through `AcDevice.requestColumns` alongside the normal poll.
 */
export const GREE_EXTRA_COLUMNS: readonly string[] = ['OutEnvTem', 'Defrost', 'AllErr']

/** `OutEnvTem` (like `TemSen`) is reported with a +40 offset. */
export const GREE_TEMP_OFFSET = 40

/** What one unit answered for the extra columns; `null` = the column was not answered. */
export interface GreeExtras {
  readonly outdoorTemp: number | null
  readonly defrost: boolean | null
  readonly errorCode: number | null
}

function column(raw: Readonly<Record<string, number>>, key: string): number | null {
  const v = raw[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Raw `requestColumns` answer → typed extras. Pure. */
export function parseGreeExtras(raw: Readonly<Record<string, number>>): GreeExtras {
  const out = column(raw, 'OutEnvTem')
  const defrost = column(raw, 'Defrost')
  return {
    // A unit without an outdoor probe answers 0 (= -40 °C): not answered, never a reading.
    outdoorTemp: out === null || out <= 0 ? null : out - GREE_TEMP_OFFSET,
    defrost: defrost === null ? null : defrost !== 0,
    errorCode: column(raw, 'AllErr'),
  }
}

/** Climate action the unit's own flags prove; `null` when they prove nothing. */
export type GreeClimateAction = 'off' | 'idle' | null

export function greeClimateAction(input: {
  readonly power: boolean
  readonly defrost: boolean | null
}): GreeClimateAction {
  if (!input.power) return 'off'
  if (input.defrost === true) return 'idle'
  return null
}

/**
 * The `error` cap reading for a unit's `AllErr` column. A column the unit did
 * not answer is UNKNOWN (`active: null`, never "no fault"); `0` is a clean
 * reading. The unit gives a number and no words, so the code names the fault.
 */
export function greeErrorReading(code: number | null, now: number): ErrorStatus {
  if (code === null) return { ...ERROR_STATUS_COLD, lastFetchedAt: now }
  if (code === 0) return { ...ERROR_STATUS_COLD, active: false, lastFetchedAt: now }
  return {
    active: true,
    code: `E${code}`,
    label: `Error E${code}`,
    severity: 'error',
    since: null,
    lastFetchedAt: now,
  }
}

/** The sensor children a unit can earn. Its fault is the AC's `error` cap, not a child. */
export type GreeSensorKind = 'outdoor'

export interface GreeSensorChildPlan {
  readonly kind: GreeSensorKind
  readonly suffix: string
  readonly label: string
  readonly type: DeviceType
  readonly role: DeviceRole
}

/** The sensor children a unit earns from what it answered. Pure. */
export function planGreeSensorChildren(extras: GreeExtras | null): readonly GreeSensorChildPlan[] {
  if (extras === null) return []
  const plan: GreeSensorChildPlan[] = []
  if (extras.outdoorTemp !== null) {
    plan.push({
      kind: 'outdoor',
      suffix: 'outdoor',
      label: 'Temperatura esterna',
      type: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
    })
  }
  return plan
}

/** The slice of an `AcDevice` the extras poll needs. */
export interface GreeColumnReader {
  requestColumns(cols: string[]): Promise<Record<string, number>>
}

/** Read the extra columns once; a failed read throws. */
export async function readGreeExtras(ac: GreeColumnReader): Promise<GreeExtras> {
  return parseGreeExtras(await ac.requestColumns([...GREE_EXTRA_COLUMNS]))
}
