/**
 * The Alert Center's view of the migration ledger (D987): a pure planner.
 * The ledger is the authority; an event is only a hint that it changed (D11).
 * Each faulted id is one card under a stable id, so a retry that fixes it
 * dismisses exactly that card and a repeated reconcile never duplicates it.
 */
import type { Alert, MigrationLedgerEntry } from '@camstack/types'
import { EventCategory } from '@camstack/types'

export const MIGRATION_ALERT_PREFIX = 'migration:'

export interface MigrationAlertPlan {
  readonly raise: readonly Alert[]
  readonly dismiss: readonly string[]
}

function faulted(entry: MigrationLedgerEntry): 'critical' | 'warning' | null {
  // A migration declared `tolerate` says the system works without it: it is worth a look, not a page.
  if (entry.status === 'failed')
    return entry.meta?.onFailure === 'tolerate' ? 'warning' : 'critical'
  if (entry.status === 'blocked' && entry.reason === 'snapshot-refused') return 'critical'
  if (entry.status === 'skipped-newer') return 'warning'
  return null
}

function messageOf(entry: MigrationLedgerEntry): string {
  if (entry.status === 'failed') {
    return `Migration ${entry.id} failed and was rolled back: ${entry.error ?? 'no error recorded'}. What depends on it is blocked until it is retried.`
  }
  if (entry.status === 'blocked') {
    return `Migration ${entry.id} did not run: the safety snapshot before it could not be written. Free disk space and retry.`
  }
  return `The database holds migration ${entry.id}, which this version does not know. It was left untouched; update this node to the version that wrote it.`
}

export function planMigrationAlerts(
  ledger: readonly MigrationLedgerEntry[],
  open: readonly Pick<Alert, 'id' | 'status'>[],
  now: number,
): MigrationAlertPlan {
  const raise: Alert[] = []
  const faultedIds = new Set<string>()
  for (const entry of ledger) {
    const severity = faulted(entry)
    if (severity === null) continue
    const id = `${MIGRATION_ALERT_PREFIX}${entry.id}`
    faultedIds.add(id)
    raise.push({
      id,
      category: EventCategory.MigrationFailed,
      severity,
      title:
        entry.status === 'skipped-newer'
          ? 'Database is newer than this version'
          : 'Migration failed',
      message: messageOf(entry),
      ...(entry.status !== 'skipped-newer'
        ? {
            action: {
              label: 'Retry',
              invoke: {
                addonId: 'sqlite-settings',
                action: 'retryMigration',
                input: { id: entry.id },
              },
            },
          }
        : {}),
      status: 'active',
      read: false,
      createdAt: now,
      updatedAt: now,
      source: { type: 'addon', id: 'sqlite-settings' },
      metadata: { migrationId: entry.id, owner: entry.owner, database: entry.database },
    })
  }
  const dismiss = open
    .filter(
      (alert) =>
        alert.status === 'active' &&
        alert.id.startsWith(MIGRATION_ALERT_PREFIX) &&
        !faultedIds.has(alert.id),
    )
    .map((alert) => alert.id)
  return { raise, dismiss }
}
