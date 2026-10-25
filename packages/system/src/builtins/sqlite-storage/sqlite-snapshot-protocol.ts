/**
 * The messages between `SqliteSnapshotter` (the runner's main thread) and the
 * snapshot worker thread (D693). Pure: no driver, no kernel — the worker bundle
 * imports it, and so does the main thread.
 */
import type { DatabaseSnapshotTable } from '@camstack/types'

/** `workerData` of one snapshot thread. The `kind` tells it apart from any other worker. */
export interface SnapshotWorkerData {
  readonly kind: 'sqlite-snapshot'
  /** The live database — opened read-only, through this thread's own connection. */
  readonly livePath: string
  /** Where the copy is written. Lives in a work directory nothing else uses. */
  readonly copyPath: string
  /** Pages per backup step. Every step reads the same pinned transaction. */
  readonly pagesPerStep: number
}

/** What a copy that passed every check holds. */
export interface VerifiedCopy {
  readonly takenAt: number
  readonly tables: readonly DatabaseSnapshotTable[]
  readonly pageCount: number
  readonly pageSize: number
  readonly copyMs: number
  readonly verifyMs: number
}

/**
 * Why a copy was refused:
 * - `integrity` — `PRAGMA integrity_check` on the copy answered anything but `ok`;
 * - `row-count` — a table of the copy holds a different number of rows than the
 *   pinned source did, or the table sets differ;
 * - `failed` — the copy could not be taken at all (open, I/O, busy, deadline);
 * - `no-space` — the live database's disk cannot take the copy and keep its
 *   reserve, or its free space could not be measured (decided before the
 *   thread starts, by the snapshotter).
 */
export type SnapshotRefusalReason = 'integrity' | 'row-count' | 'failed' | 'no-space'

export interface SnapshotDone {
  readonly kind: 'done'
  readonly copy: VerifiedCopy
}

export interface SnapshotRefused {
  readonly kind: 'refused'
  readonly reason: SnapshotRefusalReason
  readonly detail: string
}

export type SnapshotWorkerMessage = SnapshotDone | SnapshotRefused

/** Thrown inside the worker by a check that refuses the copy. */
export class SnapshotRefusedError extends Error {
  constructor(
    readonly reason: SnapshotRefusalReason,
    readonly detail: string,
  ) {
    super(`database snapshot refused (${reason}): ${detail}`)
    this.name = 'SnapshotRefusedError'
  }
}

export function isSnapshotWorkerData(value: unknown): value is SnapshotWorkerData {
  if (typeof value !== 'object' || value === null) return false
  if (!('kind' in value) || value.kind !== 'sqlite-snapshot') return false
  if (!('livePath' in value) || !('copyPath' in value) || !('pagesPerStep' in value)) return false
  return (
    typeof value.livePath === 'string' &&
    typeof value.copyPath === 'string' &&
    typeof value.pagesPerStep === 'number'
  )
}

function isTableList(value: unknown): value is readonly DatabaseSnapshotTable[] {
  return (
    Array.isArray(value) &&
    value.every(
      (t: unknown) =>
        typeof t === 'object' &&
        t !== null &&
        'name' in t &&
        'rows' in t &&
        typeof t.name === 'string' &&
        typeof t.rows === 'number',
    )
  )
}

function isVerifiedCopy(value: unknown): value is VerifiedCopy {
  if (typeof value !== 'object' || value === null) return false
  if (
    !('takenAt' in value) ||
    !('tables' in value) ||
    !('pageCount' in value) ||
    !('pageSize' in value) ||
    !('copyMs' in value) ||
    !('verifyMs' in value)
  ) {
    return false
  }
  return (
    typeof value.takenAt === 'number' &&
    isTableList(value.tables) &&
    typeof value.pageCount === 'number' &&
    typeof value.pageSize === 'number' &&
    typeof value.copyMs === 'number' &&
    typeof value.verifyMs === 'number'
  )
}

export function isSnapshotWorkerMessage(value: unknown): value is SnapshotWorkerMessage {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  if (value.kind === 'done') return 'copy' in value && isVerifiedCopy(value.copy)
  if (value.kind === 'refused') {
    return (
      'reason' in value &&
      (value.reason === 'integrity' ||
        value.reason === 'row-count' ||
        value.reason === 'failed' ||
        value.reason === 'no-space') &&
      'detail' in value &&
      typeof value.detail === 'string'
    )
  }
  return false
}
