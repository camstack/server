/**
 * Turning a mover's counters into the line an operator reads.
 *
 * Split out of `StorageMigrationSection` because this is the part with rules
 * rather than markup: an unknown denominator must not render as 0 %, and a rate
 * derived from a zero elapsed window must not render as `Infinity MB/s`. Both
 * are testable here and neither is testable through a React tree.
 *
 * Every number comes from the hub — `startedAt` and `observedAt` are both the
 * hub's clock — so nothing here subtracts a browser clock from a server one.
 */
import type { StorageMigrationMoveProgress } from '@camstack/types'
import { formatBytes } from '../../../lib/format-size'

/** What the UI renders for one mover, already worded. */
export interface MoverProgressLine {
  /** `3,588 / 136,885 files` — or `3,588 files` when M is unknown. */
  readonly counted: string
  /** `0 … 1`, or `null` when there is no honest denominator. */
  readonly fraction: number | null
  /** `2.3 GB moved`. */
  readonly moved: string
  /** `4.1 MB/s`, or `null` before any measurable time has passed. */
  readonly rate: string | null
  /** `~5h 12m left`, or `null` when M or the rate is unknown. */
  readonly eta: string | null
}

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60 * MS_PER_SECOND
const MS_PER_HOUR = 60 * MS_PER_MINUTE

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/** `5h 12m`, `12m 30s`, `45s`. Coarse on purpose: an estimate presented to the
 *  second claims a precision a five-hour drain does not have. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms >= MS_PER_HOUR) {
    const hours = Math.floor(ms / MS_PER_HOUR)
    const minutes = Math.round((ms % MS_PER_HOUR) / MS_PER_MINUTE)
    return `${hours.toString()}h ${minutes.toString()}m`
  }
  if (ms >= MS_PER_MINUTE) {
    const minutes = Math.floor(ms / MS_PER_MINUTE)
    const seconds = Math.round((ms % MS_PER_MINUTE) / MS_PER_SECOND)
    return `${minutes.toString()}m ${seconds.toString()}s`
  }
  return `${Math.max(0, Math.round(ms / MS_PER_SECOND)).toString()}s`
}

/**
 * The operator-facing reading of a mover's counters.
 *
 * `filesTotal: null` propagates all the way out as `fraction: null` and
 * `eta: null` — never a 0 % bar and never an estimate. A windowed footage job
 * and a node with no durable ledger both genuinely cannot say M (D295), and
 * inventing one there is how "done" gets believed.
 *
 * The ETA is derived from the FILE rate rather than the byte rate: the
 * denominator is a file count, and a segment's size varies enough that mixing
 * the two produces an estimate that jumps every poll.
 */
export function describeProgress(progress: StorageMigrationMoveProgress): MoverProgressLine {
  const elapsedMs = Math.max(0, progress.observedAt - progress.startedAt)
  const counted =
    progress.filesTotal === null
      ? `${formatCount(progress.filesMoved)} files`
      : `${formatCount(progress.filesMoved)} / ${formatCount(progress.filesTotal)} files`
  const fraction =
    progress.filesTotal === null || progress.filesTotal === 0
      ? null
      : Math.min(1, progress.filesMoved / progress.filesTotal)
  // A rate needs time to have passed AND something to have moved. Reporting
  // `0 B/s` for a mover that has been running for two seconds reads as stalled.
  const measurable = elapsedMs > 0 && progress.filesMoved > 0
  const rate = measurable
    ? `${formatBytes((progress.bytesMoved / elapsedMs) * MS_PER_SECOND)}/s`
    : null
  const remaining = progress.filesTotal === null ? null : progress.filesTotal - progress.filesMoved
  const eta =
    !measurable || remaining === null || remaining <= 0
      ? null
      : `~${formatDuration((remaining * elapsedMs) / progress.filesMoved)} left`
  return { counted, fraction, moved: `${formatBytes(progress.bytesMoved)} moved`, rate, eta }
}

/** One line, already joined — what the status row shows. */
export function progressSummary(progress: StorageMigrationMoveProgress): string {
  const line = describeProgress(progress)
  return [line.counted, line.moved, line.rate, line.eta].filter((part) => part !== null).join(' · ')
}
