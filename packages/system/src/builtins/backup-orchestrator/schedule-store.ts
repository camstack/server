/**
 * Backup-schedule storage for the backup orchestrator.
 *
 * A schedule is the N:M "entry" that binds one cron cadence to a SET of
 * `backups`-typed destination locations. It supersedes the per-location
 * cron previously carried on `BackupDestinationPolicy`: the operator
 * creates one schedule, picks the locations it should write to, and the
 * orchestrator fans a single archive out to all of them when the cron
 * fires. Retention is per-schedule (D-decision 2026-07-28).
 *
 * The rows are the orchestrator's `schedules` records kind (D881); there is
 * no `backup_schedules` table any more (D902).
 */
import type { DataStoreDatabase, RecordKindHandle } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { backupOrchestratorRecordKinds, type BackupScheduleBody } from './record-kinds.js'

/**
 * A backup schedule row.
 *
 * `locationIds` is the fan-out set (destination `backups` locations).
 * `retentionCount` applies to every one of them for THIS schedule's
 * runs. `dataSources` optionally narrows which top-level state
 * locations get archived; empty = the orchestrator's full default set.
 */
export interface BackupSchedule {
  readonly id: string
  readonly label: string
  readonly cron: string
  readonly enabled: boolean
  readonly locationIds: readonly string[]
  readonly retentionCount: number
  readonly dataSources?: readonly string[]
  /**
   * Which database files this schedule carries. Absent (a `NULL` column) =
   * `['settings']`: an unstated ask is the minimum (D382). Settings runs
   * nightly, events and history weekly (D852).
   */
  readonly databases?: readonly DataStoreDatabase[]
  /**
   * ms-epoch of the last tick that FIRED this schedule. Stamped BEFORE the
   * archive runs — it is the dedupe anchor and the cron's "after" cursor —
   * so it means "attempted", never "succeeded". It was documented as the
   * latter and rendered as "last run", which is how a schedule whose only
   * destination refused every byte read as a healthy nightly backup (D384).
   */
  readonly lastAttemptAt?: number
  /** ms-epoch of the last fired run that landed at ≥1 destination. */
  readonly lastSuccessAt?: number
  /** Why the last fired run failed, verbatim. Cleared by the next success. */
  readonly lastError?: string
}

export class BackupScheduleService {
  constructor(private readonly schedulesKind: RecordKindHandle<BackupScheduleBody>) {}

  async list(): Promise<readonly BackupSchedule[]> {
    const rows = await readAllRows(this.schedulesKind)
    rows.sort((a, b) => a.id.localeCompare(b.id))
    const out: BackupSchedule[] = []
    for (const row of rows) {
      const mapped = bodyToSchedule(row.id, row.data)
      if (mapped) out.push(mapped)
    }
    return out
  }

  async get(id: string): Promise<BackupSchedule | null> {
    const row = await this.schedulesKind.get(id)
    return row === null ? null : bodyToSchedule(id, row.data)
  }

  /** Replace-or-insert: one full `put` of the row. */
  async upsert(s: BackupSchedule): Promise<void> {
    const data = backupOrchestratorRecordKinds.schedules.schema.parse(scheduleToBody(s))
    await this.schedulesKind.put({ id: s.id, data })
  }

  async delete(id: string): Promise<void> {
    await this.schedulesKind.delete(id)
  }
}

function scheduleToBody(s: BackupSchedule): BackupScheduleBody {
  return {
    label: s.label,
    cron: s.cron,
    enabled: s.enabled,
    locationIds: [...s.locationIds],
    retentionCount: s.retentionCount,
    ...(s.dataSources !== undefined ? { dataSources: [...s.dataSources] } : {}),
    ...(s.databases !== undefined ? { databases: [...s.databases] } : {}),
    ...(s.lastAttemptAt !== undefined ? { lastAttemptAt: s.lastAttemptAt } : {}),
    ...(s.lastSuccessAt !== undefined ? { lastSuccessAt: s.lastSuccessAt } : {}),
    ...(s.lastError !== undefined ? { lastError: s.lastError } : {}),
  }
}

function bodyToSchedule(id: string, body: BackupScheduleBody): BackupSchedule | null {
  if (!id) return null
  return {
    id,
    label: body.label,
    cron: body.cron,
    enabled: body.enabled,
    locationIds: [...body.locationIds],
    retentionCount: body.retentionCount,
    ...(body.dataSources !== undefined ? { dataSources: [...body.dataSources] } : {}),
    ...(body.databases !== undefined && body.databases.length > 0
      ? { databases: [...body.databases] }
      : {}),
    ...(body.lastAttemptAt !== undefined ? { lastAttemptAt: body.lastAttemptAt } : {}),
    ...(body.lastSuccessAt !== undefined ? { lastSuccessAt: body.lastSuccessAt } : {}),
    ...(body.lastError !== undefined ? { lastError: body.lastError } : {}),
  }
}
