/**
 * Accessory rows whose parent no longer exists (D987 procedure).
 *
 * A device removed or migrated without its children (before `removeDevice`
 * cascaded) left them behind with a dangling `parentDeviceId`: a Reolink siren
 * under a camera that is gone. Each such row is removed through the same
 * tombstoned removal as any device (D865), each one listed in the log. A row
 * whose parent exists is never touched, and neither is a top-level row.
 */
import type { MigrationProcedureResult } from '@camstack/types'

export interface OrphanRow {
  readonly id: number
  readonly parentDeviceId: number | null
}

export interface OrphanChildrenPorts {
  readonly listRows: () => Promise<readonly OrphanRow[]>
  /** The most rows one read can return: a read that reaches it may be cut short. */
  readonly rowLimit: number
  /** The tombstoned removal (it cascades to the row's own children). */
  readonly removeDevice: (deviceId: number) => Promise<void>
  readonly info: (message: string, deviceId: number, parentDeviceId: number) => void
  /** One line with the counts and every candidate id (the dry-run view). */
  readonly summary: (counts: Readonly<Record<string, unknown>>) => void
}

/** The rows that name a parent no row answers to. */
export function orphansOf(rows: readonly OrphanRow[]): readonly OrphanRow[] {
  const ids = new Set(rows.map((r) => r.id))
  return rows.filter((r) => r.parentDeviceId !== null && !ids.has(r.parentDeviceId))
}

/**
 * Destructive on one read is never enough (D49): a row is removed only when TWO
 * reads agree it is an orphan, and nothing is removed from a read that may have
 * been cut short at the row limit. The candidate ids are recorded in the summary
 * and the log BEFORE any removal.
 */
export async function removeOrphanChildren(
  ports: OrphanChildrenPorts,
): Promise<MigrationProcedureResult> {
  const first = await ports.listRows()
  if (first.length >= ports.rowLimit) {
    throw new Error(
      `device-manager: ${first.length} rows read, the limit is ${ports.rowLimit} — the read may be truncated, nothing removed`,
    )
  }
  const candidates = orphansOf(first)
  if (candidates.length === 0) {
    return { outcome: 'already-done', summary: { candidates: [], removed: [] } }
  }
  const second = await ports.listRows()
  const stillOrphans = new Set(orphansOf(second).map((r) => r.id))
  const confirmed = candidates.filter((r) => stillOrphans.has(r.id))
  const candidateIds = candidates.map((r) => r.id)
  ports.summary({
    rows: first.length,
    candidateCount: candidateIds.length,
    candidates: candidateIds,
    confirmedCount: confirmed.length,
    confirmed: confirmed.map((r) => r.id),
  })
  const removed: number[] = []
  for (const orphan of confirmed) {
    if (orphan.parentDeviceId === null) continue
    ports.info(
      'device-manager: removing an orphan child, its parent no longer exists',
      orphan.id,
      orphan.parentDeviceId,
    )
    await ports.removeDevice(orphan.id)
    removed.push(orphan.id)
  }
  return { outcome: 'done', summary: { candidates: candidateIds, removed } }
}
