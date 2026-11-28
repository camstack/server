/**
 * The periodic availability line (planning#721): every 30 minutes, per
 * recording camera, ONE compact line stating what a reader will see for the
 * last 24 hours next to what the durable hour ledger accounts for.
 *
 * ## Why it exists
 *
 * A camera recorded `high` around the clock, its ledger held every hour, and
 * the viewer drew an empty recording lane for days. Nothing in the log said
 * which side was wrong: the writer logs what it wrote, the ledger logs what it
 * adopted, and no line ever stated what a READER is served. This is that line.
 *
 * ## What it compares
 *
 *  - the READER: the profile availability serves for the camera, and the
 *    segments the calendar answers per hour — the exact call
 *    `recording.getAvailability` makes;
 *  - the LEDGER: the durable hour rows of the same window, per profile and
 *    location.
 *
 * It is `warn` when they disagree on a CLOSED hour (the live tail is
 * write-behind and never judged), when one hour of one profile is accounted
 * under two locations, or when the ledger holds footage and the reader serves
 * no profile at all. A ledger that did not answer is `null`, never zero
 * (D393): the line still goes out, and it claims no disagreement.
 *
 * Read-only: one calendar read per hour of the window, served from the same
 * bounded cache the timeline uses. It writes nothing and repairs nothing.
 */
import type { IScopedLogger } from '@dominevo/types'
import { errMsg } from '@dominevo/types'

const HOUR_MS = 3_600_000

/** How often the line is printed. */
export const AVAILABILITY_REPORT_INTERVAL_MS = 30 * 60_000

/** The window the line describes, ending at the current hour. */
export const AVAILABILITY_REPORT_WINDOW_HOURS = 24

/**
 * Hours at the live edge that are never JUDGED: the ledger is write-behind and
 * a live hour's listing races its writer, so either side may be short there.
 */
export const AVAILABILITY_REPORT_LIVE_TAIL_HOURS = 2

/** One durable hour row, as far as this report reads it. */
export interface AvailabilityLedgerHour {
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly hourStartMs: number
  readonly segments: number
}

export interface AvailabilityReportDeps {
  /** The cameras recording right now. */
  readonly devices: () => readonly number[]
  /** Every durable hour row, or `null` when the ledger has not answered. */
  readonly ledgerHours: () => readonly AvailabilityLedgerHour[] | null
  /** Hours of this camera a writer reported a loss against, or `null` when unknown. */
  readonly refusedHours: (deviceId: number) => number | null
  /** The profile availability serves for this camera, `null` when it has none. */
  readonly servedProfile: (deviceId: number) => Promise<string | null>
  /** Segments a reader is served for one hour of one profile. */
  readonly readerSegments: (
    deviceId: number,
    profile: string,
    hourStartMs: number,
  ) => Promise<number>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  readonly now: () => number
}

/** What the ledger accounts for under one (profile, location) in the window. */
export interface AvailabilityLedgerTotal {
  readonly profile: string
  readonly locationId: string
  readonly hours: number
  readonly segments: number
}

/** What a reader is served in the window. */
export interface AvailabilityReaderTotal {
  readonly hours: number
  readonly segments: number
}

/** One camera's line. */
export interface CameraAvailabilityReport {
  readonly deviceId: number
  readonly windowHours: number
  readonly servedProfile: string | null
  readonly reader: AvailabilityReaderTotal
  /** `null` = the ledger did not answer; nothing is claimed about it. */
  readonly ledger: readonly AvailabilityLedgerTotal[] | null
  readonly refusedHours: number | null
  /** Closed hours the ledger accounts for under the served profile and a reader is served nothing for. */
  readonly ledgerOnlyHours: number
  /** Closed hours a reader is served footage for and no ledger row names. */
  readonly readerOnlyHours: number
  /** (profile, hour) pairs accounted under more than one location. */
  readonly duplicatedHours: number
  readonly mismatch: boolean
}

function windowHoursOf(nowMs: number): readonly number[] {
  const current = Math.floor(nowMs / HOUR_MS) * HOUR_MS
  const hours: number[] = []
  for (let back = AVAILABILITY_REPORT_WINDOW_HOURS - 1; back >= 0; back -= 1) {
    hours.push(current - back * HOUR_MS)
  }
  return hours
}

function ledgerTotalsOf(
  rows: readonly AvailabilityLedgerHour[],
): readonly AvailabilityLedgerTotal[] {
  const totals = new Map<string, AvailabilityLedgerTotal>()
  for (const row of rows) {
    if (row.segments <= 0) continue
    const key = `${row.profile}@${row.locationId}`
    const held = totals.get(key)
    totals.set(key, {
      profile: row.profile,
      locationId: row.locationId,
      hours: (held?.hours ?? 0) + 1,
      segments: (held?.segments ?? 0) + row.segments,
    })
  }
  return [...totals.values()].toSorted((a, b) =>
    `${a.profile}@${a.locationId}`.localeCompare(`${b.profile}@${b.locationId}`),
  )
}

function duplicatedHoursOf(rows: readonly AvailabilityLedgerHour[]): number {
  const locations = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.segments <= 0) continue
    const key = `${row.profile}|${row.hourStartMs}`
    const held = locations.get(key) ?? new Set<string>()
    held.add(row.locationId)
    locations.set(key, held)
  }
  let duplicated = 0
  for (const held of locations.values()) if (held.size > 1) duplicated += 1
  return duplicated
}

/** One camera's comparison. Throws only what a reader throws. */
export async function cameraAvailabilityReport(
  deps: AvailabilityReportDeps,
  deviceId: number,
): Promise<CameraAvailabilityReport> {
  const nowMs = deps.now()
  const hours = windowHoursOf(nowMs)
  const firstHour = hours[0] ?? nowMs
  const closedBefore =
    Math.floor(nowMs / HOUR_MS) * HOUR_MS - (AVAILABILITY_REPORT_LIVE_TAIL_HOURS - 1) * HOUR_MS
  const all = deps.ledgerHours()
  const rows =
    all === null
      ? null
      : all.filter(
          (row) =>
            row.deviceId === deviceId && row.hourStartMs >= firstHour && row.hourStartMs <= nowMs,
        )
  const servedProfile = await deps.servedProfile(deviceId)

  const readerByHour = new Map<number, number>()
  if (servedProfile !== null) {
    for (const hour of hours) {
      readerByHour.set(hour, await deps.readerSegments(deviceId, servedProfile, hour))
    }
  }
  let readerHours = 0
  let readerSegments = 0
  for (const count of readerByHour.values()) {
    if (count <= 0) continue
    readerHours += 1
    readerSegments += count
  }

  let ledgerOnlyHours = 0
  let readerOnlyHours = 0
  let duplicatedHours = 0
  let unservedFootage = false
  if (rows !== null) {
    duplicatedHours = duplicatedHoursOf(rows)
    const servedLedgerHours = new Set<number>()
    for (const row of rows) {
      if (row.segments > 0 && row.profile === servedProfile) servedLedgerHours.add(row.hourStartMs)
    }
    for (const hour of hours) {
      if (hour >= closedBefore) continue
      const reader = readerByHour.get(hour) ?? 0
      const ledger = servedLedgerHours.has(hour)
      if (ledger && reader <= 0) ledgerOnlyHours += 1
      if (!ledger && reader > 0) readerOnlyHours += 1
    }
    // The ledger holds footage and a reader is served no profile at all, or
    // only a profile the ledger holds nothing under.
    unservedFootage =
      rows.some((row) => row.segments > 0 && row.hourStartMs < closedBefore) && readerHours === 0
  }

  return {
    deviceId,
    windowHours: AVAILABILITY_REPORT_WINDOW_HOURS,
    servedProfile,
    reader: { hours: readerHours, segments: readerSegments },
    ledger: rows === null ? null : ledgerTotalsOf(rows),
    refusedHours: deps.refusedHours(deviceId),
    ledgerOnlyHours,
    readerOnlyHours,
    duplicatedHours,
    mismatch: ledgerOnlyHours > 0 || readerOnlyHours > 0 || duplicatedHours > 0 || unservedFootage,
  }
}

/**
 * One pass: a line per recording camera. Never throws — a camera whose reader
 * could not be asked says so on its own line and the others are still reported.
 */
export async function reportAvailability(
  deps: AvailabilityReportDeps,
): Promise<readonly CameraAvailabilityReport[]> {
  const reports: CameraAvailabilityReport[] = []
  for (const deviceId of [...deps.devices()].toSorted((a, b) => a - b)) {
    try {
      const report = await cameraAvailabilityReport(deps, deviceId)
      reports.push(report)
      const meta = {
        windowHours: report.windowHours,
        servedProfile: report.servedProfile,
        reader: report.reader,
        ledger: report.ledger,
        refusedHours: report.refusedHours,
        ledgerOnlyHours: report.ledgerOnlyHours,
        readerOnlyHours: report.readerOnlyHours,
        duplicatedHours: report.duplicatedHours,
      }
      if (report.mismatch) {
        deps.logger.warn(
          'recorder: availability — readers and the hour ledger DISAGREE on the last 24 h',
          { tags: { deviceId }, meta },
        )
      } else {
        deps.logger.info('recorder: availability — what readers see for the last 24 h', {
          tags: { deviceId },
          meta,
        })
      }
    } catch (err: unknown) {
      deps.logger.warn('recorder: availability could not be read for the periodic line', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }
  return reports
}
