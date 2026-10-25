/**
 * Operator discard of leftover files on a FROZEN storage location.
 *
 * The HDD that still holds `eventMedia:default` / `recordingsLow:default`
 * is the SAME volume as `recordings:default` (`basePath: /recordings`).
 * A wipe that `rm`s the location root would delete the high archive.
 * The only legal targets are the CLASS subtrees:
 *
 *   eventMedia     → `<camera>/events/`
 *   recordingsLow  → `<camera>/low/`
 *   recordings     → `<camera>/high/` and `<camera>/mid/`
 *
 * Eligibility matches the card: frozen (disabled or read-only) AND a
 * writable sibling of the same type still exists (the SSD). The last
 * writable of a type never offers this button.
 *
 * The work itself is an `addons.custom` job on the addon that owns the
 * blobs — start returns immediately; progress is polled. Capability
 * methods would need an image rebuild; custom actions deploy with the
 * addon.
 */
import type { StorageLocation } from '@camstack/types'
import { modeAcceptsWrites, resolveLocationMode } from './location-mode'

export const DISCARD_SUBTREES: Readonly<Record<string, readonly string[]>> = {
  eventMedia: ['events'],
  recordingsLow: ['low'],
  recordings: ['high', 'mid'],
}

export const DISCARD_ADDON: Readonly<Record<string, string>> = {
  eventMedia: 'pipeline-analytics',
  recordingsLow: 'recorder',
  recordings: 'recorder',
}

export const DISCARD_START_ACTION = 'storage.discardLocation'
export const DISCARD_STATUS_ACTION = 'storage.discardLocationStatus'
export const DISCARD_CANCEL_ACTION = 'storage.discardLocationCancel'

export function discardSubtreesForType(type: string): readonly string[] | null {
  return DISCARD_SUBTREES[type] ?? null
}

export function discardAddonForType(type: string): string | null {
  return DISCARD_ADDON[type] ?? null
}

/** Frozen = any state but `active`: nothing new lands here. */
export function locationIsFrozen(location: Pick<StorageLocation, 'enabled' | 'config'>): boolean {
  return !modeAcceptsWrites(resolveLocationMode(location))
}

/**
 * True when this row may offer "discard leftovers".
 *
 * Frozen, a class we know how to wipe, and at least one sibling of the
 * same type that is still taking writes. The sibling is the reason the
 * wipe is safe to offer: new data has somewhere else to go.
 */
export function discardEligible(
  location: Pick<StorageLocation, 'id' | 'type' | 'enabled' | 'config'>,
  siblings: readonly Pick<StorageLocation, 'id' | 'enabled' | 'config'>[],
): boolean {
  if (discardSubtreesForType(location.type) === null) return false
  if (!locationIsFrozen(location)) return false
  return siblings.some((s) => s.id !== location.id && modeAcceptsWrites(resolveLocationMode(s)))
}

export type DiscardPhase =
  | 'idle'
  | 'scanning'
  | 'wiping-fs'
  | 'wiping-db'
  | 'cascading'
  | 'complete'
  | 'cancelled'
  | 'error'

export interface DiscardStatus {
  readonly running: boolean
  readonly locationId: string | null
  readonly jobId: string | null
  readonly phase: DiscardPhase
  readonly camerasTotal: number
  readonly camerasDone: number
  readonly foldersRemoved: number
  readonly dbRowsDeleted: number
  readonly ownersCascaded: number
  readonly detail: string
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly error: string | null
}

const PHASES: ReadonlySet<string> = new Set([
  'idle',
  'scanning',
  'wiping-fs',
  'wiping-db',
  'cascading',
  'complete',
  'cancelled',
  'error',
])

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Narrow `addons.custom` unknown into a status, or `null` if malformed. */
export function parseDiscardStatus(raw: unknown): DiscardStatus | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['running'] !== 'boolean') return null
  const phase = o['phase']
  if (typeof phase !== 'string' || !PHASES.has(phase)) return null
  const camerasTotal = asNumber(o['camerasTotal'])
  const camerasDone = asNumber(o['camerasDone'])
  const foldersRemoved = asNumber(o['foldersRemoved'])
  const dbRowsDeleted = asNumber(o['dbRowsDeleted'])
  const ownersCascaded = asNumber(o['ownersCascaded'])
  if (
    camerasTotal === null ||
    camerasDone === null ||
    foldersRemoved === null ||
    dbRowsDeleted === null ||
    ownersCascaded === null
  ) {
    return null
  }
  return {
    running: o['running'],
    locationId: asString(o['locationId']),
    jobId: asString(o['jobId']),
    phase: phase as DiscardPhase,
    camerasTotal,
    camerasDone,
    foldersRemoved,
    dbRowsDeleted,
    ownersCascaded,
    detail: asString(o['detail']) ?? '',
    startedAtMs: asNumber(o['startedAtMs']),
    finishedAtMs: asNumber(o['finishedAtMs']),
    error: asString(o['error']),
  }
}

export function discardProgressPct(status: DiscardStatus): number {
  if (status.phase === 'complete') return 100
  if (status.phase === 'cancelled' || status.phase === 'error' || status.phase === 'idle') {
    return status.camerasTotal > 0
      ? Math.min(99, Math.round((status.camerasDone / status.camerasTotal) * 100))
      : 0
  }
  if (status.camerasTotal > 0) {
    const fsPct = (status.camerasDone / status.camerasTotal) * 85
    if (status.phase === 'wiping-db') return Math.min(95, Math.round(fsPct + 8))
    if (status.phase === 'cascading') return Math.min(99, Math.round(fsPct + 12))
    return Math.min(85, Math.round(fsPct))
  }
  if (status.phase === 'scanning') return 2
  return 5
}
