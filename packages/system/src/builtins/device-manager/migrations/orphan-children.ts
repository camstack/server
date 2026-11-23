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
  /** The tombstoned removal (it cascades to the row's own children). */
  readonly removeDevice: (deviceId: number) => Promise<void>
  readonly info: (message: string, deviceId: number, parentDeviceId: number) => void
}

/** The rows that name a parent no row answers to. */
export function orphansOf(rows: readonly OrphanRow[]): readonly OrphanRow[] {
  const ids = new Set(rows.map((r) => r.id))
  return rows.filter((r) => r.parentDeviceId !== null && !ids.has(r.parentDeviceId))
}

export async function removeOrphanChildren(
  ports: OrphanChildrenPorts,
): Promise<MigrationProcedureResult> {
  const orphans = orphansOf(await ports.listRows())
  if (orphans.length === 0) return { outcome: 'already-done', summary: { removed: [] } }
  const removed: number[] = []
  for (const orphan of orphans) {
    if (orphan.parentDeviceId === null) continue
    ports.info(
      'device-manager: removing an orphan child, its parent no longer exists',
      orphan.id,
      orphan.parentDeviceId,
    )
    await ports.removeDevice(orphan.id)
    removed.push(orphan.id)
  }
  return { outcome: 'done', summary: { removed } }
}
