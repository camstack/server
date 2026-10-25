/**
 * Last Maintenance audit snapshot for this browser tab.
 *
 * AdminTabs unmounts inactive panels, so React state on the section dies on
 * a tab switch. The count itself is not a server job — keep it in-module so
 * coming back to Management still shows what just ran.
 */
import type { LedgerWalkReport } from '@camstack/types'

export interface MaintenanceOrphanReport {
  readonly ran: boolean
  readonly mode: 'report' | 'reclaim'
  readonly totalOrphans: number
  readonly totalReclaimed: number
  readonly totalBytesReclaimed: number
}

export interface MaintenanceMediaReport {
  readonly alreadyRunning: boolean
  readonly totalEligible: number
  readonly totalExamined: number
  readonly totalReclaimed: number
  readonly totalBytesReclaimed: number
  readonly error: string | null
}

export interface MaintenanceAuditSnapshot {
  readonly orphans: MaintenanceOrphanReport | null
  readonly debugMedia: MaintenanceMediaReport | null
  readonly ledgers: readonly LedgerWalkReport[]
  readonly ledgerSkipped: boolean
  readonly error: string | null
}

let snapshot: MaintenanceAuditSnapshot | null = null

export function readMaintenanceAudit(): MaintenanceAuditSnapshot | null {
  return snapshot
}

export function writeMaintenanceAudit(next: MaintenanceAuditSnapshot): void {
  snapshot = next
}

export function clearMaintenanceAudit(): void {
  snapshot = null
}
