/**
 * An Echo target no longer carries `respectDnd`: Do Not Disturb follows each notification's
 * priority (`high` speaks over it, `normal` stays quiet), never a per-target switch. Records and
 * rows saved by an older version still hold the key; this strips it from both the
 * `notify-alexa-echo` records and any row still in the `echoTargets` setting. Every other field is
 * kept as stored.
 *
 * Idempotent: a record or row without the key is not touched, and a pass that strips nothing
 * writes nothing and reports `already-done`.
 */
import type { MigrationProcedureResult } from '@camstack/types'
import type { EchoTargetMigrationPorts } from './strip-echo-target-volume-and-mode.js'

export const STRIP_ECHO_TARGET_RESPECT_DND_ID =
  'import-alexa/2026-11-11-strip-echo-target-respect-dnd'

const RETIRED_KEY = 'respectDnd'

/** One stored Echo target record, as written. */
export interface StoredEchoRecord {
  readonly id: string
  readonly data: Readonly<Record<string, unknown>>
}

/** One target the pass changed; `wasOff` = it had the switch off, so it now goes quiet in DND. */
export interface EchoDndStripped {
  readonly id: string
  readonly name: string | null
  readonly wasOff: boolean
}

/**
 * The Echo target records, read and replaced whole: a records `put` replaces the stored body
 * (`data = excluded.data` in the SQLite engine, the same in the in-memory engine), while a patch
 * cannot remove a key.
 */
export interface EchoDndRecordPorts {
  listEchoRecords(): Promise<readonly StoredEchoRecord[]>
  replaceEchoRecord(id: string, data: Readonly<Record<string, unknown>>): Promise<void>
  /** Logs the targets the pass changed, by id and name, flagging the ones that had the switch off. */
  echoDndStripped(changed: readonly EchoDndStripped[]): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strippedOf(id: string, row: Readonly<Record<string, unknown>>): EchoDndStripped {
  const name = row['name']
  return {
    id,
    name: typeof name === 'string' ? name : null,
    wasOff: row[RETIRED_KEY] === false,
  }
}

function withoutRetiredKey(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== RETIRED_KEY))
}

export async function stripEchoTargetRespectDnd(
  ports: EchoDndRecordPorts & EchoTargetMigrationPorts,
): Promise<MigrationProcedureResult> {
  const records = await ports.listEchoRecords()
  const marked = records.filter((record) => RETIRED_KEY in record.data)
  for (const record of marked) {
    await ports.replaceEchoRecord(record.id, withoutRetiredKey(record.data))
  }
  const rows = await ports.readRows()
  const markedRowList = rows.filter(
    (row): row is Record<string, unknown> => isRecord(row) && RETIRED_KEY in row,
  )
  const markedRows = markedRowList.length
  if (markedRows > 0) {
    await ports.writeRows(rows.map((row) => (isRecord(row) ? withoutRetiredKey(row) : row)))
  }
  const changed = [
    ...marked.map((record) => strippedOf(record.id, record.data)),
    ...markedRowList.map((row) => strippedOf(typeof row['id'] === 'string' ? row['id'] : '?', row)),
  ]
  if (changed.length > 0) ports.echoDndStripped(changed)
  // A target that had the switch OFF spoke through Do Not Disturb; from now on a `normal`
  // notification is quiet there. Counted so the ledger says how many behave differently.
  const summary = {
    records: records.length,
    stripped: marked.length,
    settingRows: markedRows,
    wasOff: changed.filter((c) => c.wasOff).length,
  }
  return {
    outcome: marked.length + markedRows === 0 ? 'already-done' : 'done',
    summary,
  }
}
