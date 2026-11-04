/**
 * The values of a Home Assistant instance that sit in the `integration_settings` rows of its
 * integration move onto the instance's own `brokers` record (planning#416): the calendars it
 * imports (`calendarIds`) and the integration it belongs to (`integrationId`, from the row's
 * `brokerId` link). After this pair nothing at runtime reads those rows.
 *
 * Two migrations, in this order:
 *
 * 1. `instance-settings-to-record` (procedure) merges each integration's values into the record
 *    its `brokerId` names. A field the record already holds WINS; an integration whose broker has
 *    no record any more is skipped, never recreated; two integrations linking one broker with
 *    different values are an ambiguity and throw. Every write is read back from the record.
 * 2. `clear-instance-settings-rows` (procedure) removes `calendarIds` from an integration's rows
 *    only after the record shows the same set. A row whose record differs or is missing keeps its
 *    key (parked). The `brokerId` link stays: the export's migrations still resolve their broker
 *    through it.
 *
 * Both are idempotent.
 */
import type { MigrationProcedureResult } from '@camstack/types'
import type { HaInstanceRecordPorts, HaInstanceValues } from '../ha-instance-settings.js'
import type { HaInstanceClearPorts, HaInstanceRow } from './legacy-integration-rows.js'

export const INSTANCE_SETTINGS_TO_RECORD_ID =
  'provider-homeassistant/2026-11-05-instance-settings-to-record'
export const CLEAR_INSTANCE_SETTINGS_ROWS_ID =
  'provider-homeassistant/2026-11-05-clear-instance-settings-rows'

/** The legacy row key the clearing migration removes once the record carries it. */
export const MOVED_ROW_KEYS = ['calendarIds'] as const

export interface InstanceSettingsPorts extends HaInstanceClearPorts, HaInstanceRecordPorts {}

const asIds = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : null

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((id) => right.has(id))
}

/** What the rows of one integration say about its record. */
function wanted(row: HaInstanceRow): HaInstanceValues {
  const calendarIds = asIds(row.settings['calendarIds'])
  return {
    integrationId: row.integrationId,
    ...(calendarIds !== null ? { calendarIds } : {}),
  }
}

function assertNoAmbiguity(rows: readonly HaInstanceRow[]): void {
  const seen = new Map<string, HaInstanceRow>()
  for (const row of rows) {
    if (row.brokerId === null) continue
    const other = seen.get(row.brokerId)
    if (other === undefined) {
      seen.set(row.brokerId, row)
      continue
    }
    throw new Error(
      `provider-homeassistant: integrations ${other.integrationId} and ${row.integrationId} both link broker ${row.brokerId} — nothing moved`,
    )
  }
}

export async function moveInstanceSettingsToRecords(
  ports: InstanceSettingsPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.listInstances()
  assertNoAmbiguity(rows)
  let moved = 0
  let kept = 0
  let gone = 0
  for (const row of rows) {
    if (row.brokerId === null) continue
    const record = await ports.readInstance(row.brokerId)
    if (record === null) {
      gone += 1
      continue
    }
    const want = wanted(row)
    // The record wins: only the fields it does not hold are written.
    const patch: HaInstanceValues = {
      ...(record.integrationId === undefined && want.integrationId !== undefined
        ? { integrationId: want.integrationId }
        : {}),
      ...(record.calendarIds === undefined && want.calendarIds !== undefined
        ? { calendarIds: want.calendarIds }
        : {}),
    }
    if (Object.keys(patch).length === 0) {
      kept += 1
      continue
    }
    if (!(await ports.patchInstance(row.brokerId, patch))) {
      gone += 1
      continue
    }
    const back = await ports.readInstance(row.brokerId)
    const missing =
      back === null ||
      (patch.integrationId !== undefined && back.integrationId !== patch.integrationId) ||
      (patch.calendarIds !== undefined &&
        !(back.calendarIds !== undefined && sameSet(back.calendarIds, patch.calendarIds)))
    if (missing) {
      throw new Error(
        `provider-homeassistant: record ${row.brokerId} does not show the values of integration ${row.integrationId} after the write — rows kept`,
      )
    }
    moved += 1
  }
  return { outcome: moved === 0 ? 'already-done' : 'done', summary: { moved, kept, gone } }
}

export async function clearInstanceSettingsRows(
  ports: InstanceSettingsPorts,
): Promise<MigrationProcedureResult> {
  let cleared = 0
  let parked = 0
  for (const row of await ports.listInstances()) {
    if (!MOVED_ROW_KEYS.some((key) => key in row.settings)) continue
    const own = asIds(row.settings['calendarIds'])
    const record = row.brokerId === null ? null : await ports.readInstance(row.brokerId)
    // Cleared only once the record reads back the same set; otherwise parked in place.
    const onRecord = record?.calendarIds
    if (own === null || onRecord === undefined || !sameSet(own, onRecord)) {
      parked += 1
      continue
    }
    if (await ports.clearInstanceSettingsKeys(row.integrationId, MOVED_ROW_KEYS)) cleared += 1
  }
  return { outcome: cleared === 0 ? 'already-done' : 'done', summary: { cleared, parked } }
}
