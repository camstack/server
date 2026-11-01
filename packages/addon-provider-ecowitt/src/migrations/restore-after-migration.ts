import {
  DeviceType,
  errMsg,
  type AddonMigrationRunReport,
  type DeviceRestoreReport,
  type IScopedLogger,
  type SavedDevice,
} from '@camstack/types'

export interface RestoreAfterMigrationDeps {
  readonly saved: readonly SavedDevice[]
  readonly migrationId: string
  readonly logger: IScopedLogger
  /** Runs the catalogue; throws when a block-owner migration did not apply. */
  readonly runMigration: (
    restoreRows: (rows: readonly SavedDevice[]) => Promise<void>,
  ) => Promise<AddonMigrationRunReport>
  /** The raw restore of a set of rows (what the migration's `restoreRows` port calls). */
  readonly restoreRows: (rows: readonly SavedDevice[]) => Promise<void>
  /** Restore the rows the migration left alone. */
  readonly restoreRest: (rows: readonly SavedDevice[]) => Promise<DeviceRestoreReport | void>
}

/**
 * Boot order: the migration first (it needs the persisted rows), then everything else.
 * A Hub row is never restored (the class is gone); a row the migration already restored is not
 * restored twice. When the migration did not run, say so once instead of letting the
 * Containers fail one by one with "parent not restored".
 */
export async function restoreAfterMigration(
  deps: RestoreAfterMigrationDeps,
): Promise<DeviceRestoreReport | void> {
  const { saved, migrationId, logger } = deps
  const restored = new Set<number>()
  let report: AddonMigrationRunReport
  try {
    report = await deps.runMigration(async (rows) => {
      await deps.restoreRows(rows)
      for (const row of rows) restored.add(row.id)
    })
  } catch (err) {
    logger.warn(
      `Ecowitt migration ${migrationId} did not run or did not apply — the addon stops; the Hub device and its Containers stay as saved`,
      { meta: { migrationId, error: errMsg(err) } },
    )
    throw err
  }
  if (!report.applied.includes(migrationId)) {
    for (const hub of saved.filter((row) => row.type === DeviceType.Hub)) {
      logger.warn(
        `Ecowitt migration ${migrationId} did not run — this Hub row is not restored and its Containers will not find their parent`,
        { tags: { deviceId: hub.id }, meta: { migrationId } },
      )
    }
  }
  return deps.restoreRest(
    saved.filter((row) => row.type !== DeviceType.Hub && !restored.has(row.id)),
  )
}
