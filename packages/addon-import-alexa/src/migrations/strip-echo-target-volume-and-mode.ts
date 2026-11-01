/**
 * An Echo target no longer carries a volume or a mode: the Echo speaks at its own current
 * volume, and quiet vs announce follows each notification. Rows saved by an older version
 * still hold both keys; this strips them. Every other field of a row is kept as stored.
 *
 * Idempotent: a row without either key is not touched, and a pass that strips nothing
 * writes nothing and reports `already-done`.
 */

import type { MigrationProcedureResult } from '@camstack/types'

export interface EchoTargetMigrationPorts {
  /** The stored `echoTargets` value as written, one entry per row, unparsed. */
  readRows(): readonly unknown[]
  writeRows(rows: readonly unknown[]): Promise<void>
}

const RETIRED_KEYS: readonly string[] = ['volume', 'mode']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function carriesRetiredKey(row: unknown): boolean {
  return isRecord(row) && RETIRED_KEYS.some((key) => key in row)
}

function strippedRow(row: unknown): unknown {
  if (!isRecord(row)) return row
  return Object.fromEntries(Object.entries(row).filter(([key]) => !RETIRED_KEYS.includes(key)))
}

export async function stripEchoTargetVolumeAndMode(
  ports: EchoTargetMigrationPorts,
): Promise<MigrationProcedureResult> {
  const rows = ports.readRows()
  const stripped = rows.filter(carriesRetiredKey).length
  if (stripped === 0)
    return {
      outcome: 'already-done',
      summary: { targets: rows.length, stripped },
    }
  await ports.writeRows(rows.map(strippedRow))
  return { outcome: 'done', summary: { targets: rows.length, stripped } }
}
