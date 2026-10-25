/**
 * "Is the volume full?" — derived from one `RecordingLocationUsage` row.
 *
 * ## The distinction this module exists to keep
 *
 * A usage row carries THREE byte figures and they answer different questions:
 *
 *  - `usedBytes`    — how much of the volume is RECORDINGS. This is what Prune
 *                     and Delete can free, and it is the only figure the
 *                     recorder's index knows.
 *  - `totalBytes`   — the volume's capacity (`statfs`).
 *  - `availableBytes` — free bytes on the volume (`statfs`).
 *
 * Volume fill is `(totalBytes - availableBytes) / totalBytes`. It is NOT
 * `usedBytes / totalBytes`: recordings are one tenant of the disk. On a 4 TB
 * array holding 92.9 GB of footage next to everything else, the recordings
 * share reads 2% while the volume can be at 99% and the next segment write is
 * the ENOSPC. Both are reported here, and only the first one drives severity.
 *
 * A volume that did not answer `statfs` has NO fill — not a fill of zero. The
 * recorder logs that failure with the root; the UI says "capacity unknown"
 * rather than painting an empty bar that reads as plenty of room.
 */

/** Fill at or above which the volume is worth an operator's attention. */
export const FILL_WARN_FRACTION = 0.85
/** Fill at or above which the next writes are the incident. */
export const FILL_CRITICAL_FRACTION = 0.95

export type VolumeFillSeverity = 'ok' | 'warn' | 'critical'

/** The byte figures a `RecordingLocationUsage` row carries about one volume. */
export interface VolumeCapacityFacts {
  readonly usedBytes: number
  readonly availableBytes: number | null
  readonly totalBytes: number | null
}

export interface VolumeFill {
  /** Share of the VOLUME occupied by anything at all (0..1). */
  readonly fraction: number
  readonly severity: VolumeFillSeverity
  /** Share of the volume occupied by RECORDINGS specifically (0..1). */
  readonly recordingsFraction: number
  readonly freeBytes: number
  readonly totalBytes: number
}

export interface VolumeFillSummary {
  /** Volumes that reported capacity — the only ones the totals cover. */
  readonly knownVolumes: number
  /** Volumes whose filesystem did not answer; folded into nothing. */
  readonly unknownVolumes: number
  readonly totalBytes: number
  readonly freeBytes: number
  /** The worst severity among the volumes that answered; null when none did. */
  readonly severity: VolumeFillSeverity | null
}

const SEVERITY_ORDER: readonly VolumeFillSeverity[] = ['ok', 'warn', 'critical']

export function fillSeverity(fraction: number): VolumeFillSeverity {
  if (fraction >= FILL_CRITICAL_FRACTION) return 'critical'
  if (fraction >= FILL_WARN_FRACTION) return 'warn'
  return 'ok'
}

/** Clamp to [0,1] — a filesystem reporting more free than total is a bad
 *  reading, not a negative disk. */
function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * Fill of the volume a usage row accounts, or `null` when the filesystem did
 * not give both capacity figures (or gave a zero-byte capacity, which is an
 * unusable reading rather than a full disk).
 */
export function resolveVolumeFill(facts: VolumeCapacityFacts): VolumeFill | null {
  const { availableBytes, totalBytes } = facts
  if (totalBytes === null || totalBytes <= 0) return null
  if (availableBytes === null) return null
  const fraction = clampFraction((totalBytes - availableBytes) / totalBytes)
  return {
    fraction,
    severity: fillSeverity(fraction),
    recordingsFraction: clampFraction(facts.usedBytes / totalBytes),
    freeBytes: availableBytes,
    totalBytes,
  }
}

/**
 * Node-wide roll-up over every volume row: totals across the volumes that
 * answered, a COUNT of the ones that did not (never folded in as empty), and
 * the worst severity of the lot.
 *
 * `null` when there are no rows at all — a hub whose baked router predates the
 * `locations` array reports nothing here, and nothing is what should render.
 */
export function summarizeVolumeFill(
  rows: readonly VolumeCapacityFacts[],
): VolumeFillSummary | null {
  if (rows.length === 0) return null
  let knownVolumes = 0
  let unknownVolumes = 0
  let totalBytes = 0
  let freeBytes = 0
  let severity: VolumeFillSeverity | null = null
  for (const row of rows) {
    const fill = resolveVolumeFill(row)
    if (fill === null) {
      unknownVolumes += 1
      continue
    }
    knownVolumes += 1
    totalBytes += fill.totalBytes
    freeBytes += fill.freeBytes
    if (
      severity === null ||
      SEVERITY_ORDER.indexOf(fill.severity) > SEVERITY_ORDER.indexOf(severity)
    ) {
      severity = fill.severity
    }
  }
  return { knownVolumes, unknownVolumes, totalBytes, freeBytes, severity }
}
