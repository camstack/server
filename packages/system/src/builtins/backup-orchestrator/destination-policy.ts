/**
 * Per-destination policy storage for the backup orchestrator
 * (Task 9 of the storage-unification refactor — backup arch carry-over).
 *
 * Each row is keyed by `locationId` (the `<type>:<slug>` id of a
 * `backups`-typed `StorageLocation`). The orchestrator now reads the
 * authoritative list of destinations from the storage cap
 * (`api.storage.listLocations({ type: 'backups' })`) and joins it with
 * this table to produce the wire-shape `BackupDestinationInfo` consumed
 * by the admin UI. There is no longer a `backup-destination` cap call
 * in the path.
 *
 * The rows are the orchestrator's `destination-policies` records kind
 * (D881); there is no `backup_destination_policies` table any more (D902).
 */
import type { RecordKindHandle } from '@camstack/types'
import { readAllRows } from '../../records/read-all-rows.js'
import { backupOrchestratorRecordKinds, type BackupDestinationPolicyBody } from './record-kinds.js'

/**
 * Per-`backups`-location policy. `locationId` is the foreign-key into
 * the storage orchestrator's `storage_locations` table.
 *
 * `enabled` gates whether scheduled / unspecified-target backups fan out
 * to this destination; operators can disable a destination temporarily
 * without deleting the underlying `StorageLocation`.
 *
 * `retentionCount` is independent per destination — destination A may
 * keep 3 archives while B keeps 30.
 *
 * `label` is an optional operator-defined display string. When omitted
 * the orchestrator falls back to the `StorageLocation.displayName`.
 */
export interface BackupDestinationPolicy {
  readonly locationId: string
  readonly enabled: boolean
  readonly retentionCount: number
  readonly label?: string
  /**
   * ms-epoch of the last time a run ATTEMPTED to write an archive here,
   * whatever the outcome. Never a success stamp — `lastError` says whether
   * the attempt landed, and the newest manifest entry says when one last
   * did. Rows written before 2026-07-28 carry the old per-location
   * scheduler's stamp, which had exactly this meaning.
   */
  readonly lastAttemptAt?: number
  /**
   * Why the last attempt failed, verbatim from the provider. Cleared on the
   * next attempt that lands. A destination that has never been written to
   * has neither field, and that is REPORTED as never — D384.
   */
  readonly lastError?: string
}

export class BackupDestinationPolicyService {
  constructor(private readonly policiesKind: RecordKindHandle<BackupDestinationPolicyBody>) {}

  async list(): Promise<readonly BackupDestinationPolicy[]> {
    const rows = await readAllRows(this.policiesKind)
    rows.sort((a, b) => a.id.localeCompare(b.id))
    const out: BackupDestinationPolicy[] = []
    for (const row of rows) {
      const mapped = bodyToPolicy(row.id, row.data)
      if (mapped) out.push(mapped)
    }
    return out
  }

  async get(locationId: string): Promise<BackupDestinationPolicy | null> {
    const row = await this.policiesKind.get(locationId)
    return row === null ? null : bodyToPolicy(locationId, row.data)
  }

  /** Replace-or-insert: one full `put` of the row. */
  async upsert(p: BackupDestinationPolicy): Promise<void> {
    const data = backupOrchestratorRecordKinds['destination-policies'].schema.parse(policyToBody(p))
    await this.policiesKind.put({ id: p.locationId, data })
  }

  async delete(locationId: string): Promise<void> {
    await this.policiesKind.delete(locationId)
  }

  /**
   * Auto-create a default policy for a `backups` location seen for the
   * first time (returns the existing policy unchanged when present).
   * The orchestrator calls this lazily on the first `listDestinations`
   * pass so newly-added storage locations are surfaced as enabled
   * destinations without an explicit configuration step.
   *
   * Defaults are passed by the orchestrator (currently `retentionCount=7`).
   * A fresh destination is enabled and keeps 7 archives; it gets NO cadence
   * of its own — a destination runs when a schedule fans out to it, and
   * seeding a cron here would advertise a nightly run nothing performs
   * (D384).
   */
  async ensureDefault(
    locationId: string,
    defaults: { retentionCount: number },
  ): Promise<BackupDestinationPolicy> {
    const existing = await this.get(locationId)
    if (existing) return existing
    const fresh: BackupDestinationPolicy = {
      locationId,
      enabled: true,
      retentionCount: defaults.retentionCount,
    }
    await this.upsert(fresh)
    return fresh
  }

  /**
   * Stamp the outcome of ONE attempted write to this destination.
   *
   * Read-modify-write on the policy row so the operator's `enabled`,
   * `retentionCount` and `label` survive. A destination with no row yet
   * gets one — an attempt on an unseen location must still be recorded, or
   * the failure disappears with the process (which is exactly how a 03:00
   * SMB refusal stayed invisible until the operator went looking).
   */
  async recordAttempt(
    locationId: string,
    outcome: { attemptAt: number; error?: string },
    defaults: { retentionCount: number },
  ): Promise<void> {
    const existing = (await this.get(locationId)) ?? {
      locationId,
      enabled: true,
      retentionCount: defaults.retentionCount,
    }
    // `lastError` is REPLACED, never merged: an attempt that landed must
    // clear the previous failure, or the destination screen keeps showing a
    // fault the next run already fixed.
    const { lastError: _cleared, ...carried } = existing
    await this.upsert({
      ...carried,
      lastAttemptAt: outcome.attemptAt,
      ...(outcome.error !== undefined ? { lastError: outcome.error } : {}),
    })
  }
}

// ── Row ↔ record mapping ────────────────────────────────────────────────

function policyToBody(p: BackupDestinationPolicy): BackupDestinationPolicyBody {
  return {
    enabled: p.enabled,
    retentionCount: p.retentionCount,
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.lastAttemptAt !== undefined ? { lastAttemptAt: p.lastAttemptAt } : {}),
    ...(p.lastError !== undefined ? { lastError: p.lastError } : {}),
  }
}

function bodyToPolicy(
  locationId: string,
  body: BackupDestinationPolicyBody,
): BackupDestinationPolicy | null {
  if (!locationId) return null
  return {
    locationId,
    enabled: body.enabled,
    retentionCount: body.retentionCount,
    ...(body.label !== undefined ? { label: body.label } : {}),
    ...(body.lastAttemptAt !== undefined ? { lastAttemptAt: body.lastAttemptAt } : {}),
    ...(body.lastError !== undefined ? { lastError: body.lastError } : {}),
  }
}
