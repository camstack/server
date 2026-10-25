/**
 * The ADD-only repair: closed hour DIRECTORIES the durable ledger does not fully
 * describe, unioned back into their rows (D521).
 *
 * ## Why this is not `reconcileLedgerAgainstDisk`
 *
 * That pass answers "does my ledger tell the truth?" in both directions, and
 * the FORGET half is what shapes it: it iterates the hours the ledger already
 * CLAIMS (an hour no row ever named is invisible to it), and it refuses
 * `source-writable` (D319) because a listing of a live location is a lower
 * bound, which is exactly the strength a forget rests on. Both are correct
 * there and both make it useless against the damage this module exists for:
 * an hour whose row was never written, or was written short, on the location
 * the recorder is writing to right now.
 *
 * The ADD direction never needed that licence. A file that is there IS there —
 * a live writer can only make a listing SHORT, and a short listing unioned into
 * a row adds fewer paths than it could have, never a wrong one. Nothing here
 * deletes, forgets or renames: the one ledger call it makes is
 * `adoptWalkedHour`, which is union-only (D148) and seals on success.
 *
 * ## What it costs, and the brakes
 *
 * One shallow `readdir` per directory level and one per hour, paced every
 * {@link WALK_HOUR_BATCH} hour listings and bounded at {@link
 * ADOPTION_MAX_HOURS_PER_PASS} hours per pass. The bound is a LIVENESS bound,
 * not a safety one: work it does not reach is carried by the next pass through
 * an in-process cursor, so a cold archive is walked over several passes instead
 * of holding the runner. A recursive `find` over this array once hung an SSH
 * session; nothing here is recursive and nothing here is unbounded.
 *
 * ## What it deliberately does not do
 *
 * It does not touch the LIVE tail ({@link WALK_LIVE_TAIL_HOURS}): a live hour's
 * directory races its writer, so a walk of it is a lower bound AND sealing it
 * would be the very claim D521 forbids. It never deletes an orphan, never
 * re-stats a file for its size (the name IS the size, D307), and it never asks
 * the resident index anything.
 */
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { type RecordingsLocation, locationMayBeRead } from './roots.js'
import { WALK_HOUR_BATCH, WALK_LIVE_TAIL_HOURS } from './ledger-walk-reconcile.js'
import { type WalkedHourOutcome, hourStartMs } from './segment-hour-ledger.js'

const HOUR_MS = 3_600_000

/**
 * Hour directories one pass will LIST.
 *
 * Sized against the live shape: `recordingsLow:default` held ~181 hour
 * directories in D319's measurement and at most ~12 per camera per profile-day,
 * at ~3.6 ms per cold listing (D451). 512 hours is ~2 s of array time in the
 * worst case, and the cursor makes a bigger archive a matter of more passes
 * rather than a longer one.
 */
export const ADOPTION_MAX_HOURS_PER_PASS = 512

/** The profile trees a camera directory is allowed to have. Everything else
 *  under it (`events/`, the retired `strips/`) has no hour tree worth probing. */
const PROFILES = ['high', 'mid', 'low'] as const

/** The one ledger call this pass is allowed to make. Structural, so a future
 *  edit cannot reach a FORGET from here without changing this type. */
export interface HourAdoptionLedger {
  readonly adoptWalkedHour: (
    deviceId: number,
    profile: string,
    locationId: string,
    hourStartMs: number,
    paths: readonly string[],
  ) => Promise<WalkedHourOutcome | null>
}

/** One `adoptWalkedHour`, as a test records it. */
export interface AdoptedHourCall {
  readonly deviceId: number
  readonly profile: string
  readonly locationId: string
  readonly hourStartMs: number
  readonly paths: readonly string[]
}

export interface HourAdoptionSweepDeps {
  /** Read per call, never captured: the ledger is `null` until the collection
   *  declares, and a pass that closed over that null would refuse forever. */
  readonly ledger: () => HourAdoptionLedger | null
  readonly locations: () => readonly RecordingsLocation[]
  /**
   * The names in ONE directory — never `recursive: true`.
   *
   * `null` means the directory is not there: data, not a failure. Anything else
   * THROWS, and a throw decides nothing (D49).
   */
  readonly listDir: (absDir: string) => Promise<readonly string[] | null>
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
  readonly now: () => number
  /** Awaited every {@link WALK_HOUR_BATCH} hour listings. */
  readonly pace: () => Promise<void>
  readonly maxHours?: number
}

export interface HourAdoptionSweepRequest {
  readonly locationId: string
}

export type HourAdoptionRefusal = 'location-unknown' | 'no-ledger' | 'location-unreadable'

export interface HourAdoptionDeviceReport {
  readonly deviceId: number
  readonly hoursAdopted: number
  readonly segmentsAdded: number
  readonly hoursCreated: number
}

export interface HourAdoptionSweepReport {
  readonly locationId: string
  readonly refused: HourAdoptionRefusal | null
  /** Hour directories listed. */
  readonly listings: number
  /** Hours handed to `adoptWalkedHour` that it accepted. */
  readonly hoursAdopted: number
  /** Hours whose row the ledger could not read, so nothing was written. */
  readonly hoursRefusedByLedger: number
  readonly hoursSkippedLive: number
  readonly hoursSkippedEmpty: number
  readonly listingErrors: number
  /** Paths the array held that the hour's row did not — the whole point. */
  readonly segmentsAdded: number
  /** Hours the ledger had never held a row for at all. */
  readonly hoursCreated: number
  readonly bounded: boolean
  readonly byDevice: readonly HourAdoptionDeviceReport[]
}

/** Mutable per-camera tallies. */
interface DeviceTally {
  hoursAdopted: number
  segmentsAdded: number
  hoursCreated: number
}

/** One hour directory this pass could walk. */
interface HourCandidate {
  readonly deviceId: number
  readonly profile: string
  readonly hourStartMs: number
  /** `<deviceId>/<profile>/YYYY/MM/DD/HH` — the cursor, and the path prefix
   *  every adopted path carries. */
  readonly rel: string
}

function isTwoDigit(name: string): boolean {
  return /^\d{2}$/.test(name)
}

/** One directory level in a stable order. Lexicographic, not numeric: it is the
 *  CURSOR's order, and zero-padded path components (`09`, `17`) already sort
 *  chronologically — device ids do not, and do not need to. */
function inCursorOrder(names: readonly string[]): readonly string[] {
  return [...names].toSorted()
}

/**
 * One add-only pass over one location's hour directories.
 *
 * Never throws: a directory that cannot be read is counted and the pass
 * continues; a precondition failure is a named refusal and the pass does
 * nothing at all.
 */
export class HourAdoptionSweeper {
  /** Where the last bounded pass stopped (`rel` of the last hour it walked).
   *  In RAM: a restart re-walks from the top, which costs listings and can
   *  never cost footage. */
  private cursor: string | null = null

  constructor(private readonly deps: HourAdoptionSweepDeps) {}

  async sweep(request: HourAdoptionSweepRequest): Promise<HourAdoptionSweepReport> {
    const location = this.deps.locations().find((candidate) => candidate.id === request.locationId)
    if (location === undefined) return this.refusedReport(request.locationId, 'location-unknown')
    if (!locationMayBeRead(location)) return this.refusedReport(location.id, 'location-unreadable')
    const ledger = this.deps.ledger()
    if (ledger === null) {
      this.deps.logger.warn(
        'recorder: hour adoption REFUSED — this node holds no durable hour ledger, so there is nothing to adopt into',
        { meta: { locationId: location.id } },
      )
      return this.refusedReport(location.id, 'no-ledger')
    }

    const liveTailFrom = hourStartMs(this.deps.now()) - (WALK_LIVE_TAIL_HOURS - 1) * HOUR_MS
    const maxHours = this.deps.maxHours ?? ADOPTION_MAX_HOURS_PER_PASS
    const resume = this.cursor
    const byDevice = new Map<number, DeviceTally>()
    let listings = 0
    let hoursAdopted = 0
    let hoursRefusedByLedger = 0
    let hoursSkippedLive = 0
    let hoursSkippedEmpty = 0
    let listingErrors = 0
    let segmentsAdded = 0
    let hoursCreated = 0
    let bounded = false
    let last: string | null = null

    for await (const candidate of this.candidates(location, () => {
      listingErrors += 1
    })) {
      if (resume !== null && candidate.rel <= resume) continue
      if (candidate.hourStartMs >= liveTailFrom) {
        hoursSkippedLive += 1
        continue
      }
      if (listings >= maxHours) {
        bounded = true
        break
      }
      let names: readonly string[] | null
      try {
        names = await this.deps.listDir(`${location.root}/${candidate.rel}`)
      } catch (err: unknown) {
        // A listing that FAILED is not a listing that came back empty, and it
        // must not move the cursor past an hour nobody looked at.
        listingErrors += 1
        this.deps.logger.debug('recorder: hour adoption could not list an hour directory', {
          tags: { deviceId: candidate.deviceId },
          meta: { locationId: location.id, rel: candidate.rel, error: errMsg(err) },
        })
        continue
      }
      listings += 1
      last = candidate.rel
      if (listings % WALK_HOUR_BATCH === 0) await this.deps.pace()
      const paths = (names ?? [])
        .filter((name) => name.endsWith('.m4s'))
        .map((name) => `${candidate.rel}/${name}`)
      if (paths.length === 0) {
        hoursSkippedEmpty += 1
        continue
      }
      const outcome = await ledger.adoptWalkedHour(
        candidate.deviceId,
        candidate.profile,
        location.id,
        candidate.hourStartMs,
        paths,
      )
      if (outcome === null) {
        // The row is known and its detail could not be read: nothing was
        // written, and the hour stays exactly as it was.
        hoursRefusedByLedger += 1
        continue
      }
      hoursAdopted += 1
      segmentsAdded += outcome.added
      if (outcome.created) hoursCreated += 1
      const tally = byDevice.get(candidate.deviceId) ?? {
        hoursAdopted: 0,
        segmentsAdded: 0,
        hoursCreated: 0,
      }
      tally.hoursAdopted += 1
      tally.segmentsAdded += outcome.added
      if (outcome.created) tally.hoursCreated += 1
      byDevice.set(candidate.deviceId, tally)
      if (outcome.added > 0) {
        // Footage that was on the array and invisible to every reader until
        // now. Per camera, because that is the only way this is ever asked.
        this.deps.logger.warn(
          'recorder: adopted segments the durable hour row did not name — this hour was under-reported to every reader',
          {
            tags: { deviceId: candidate.deviceId },
            meta: {
              locationId: location.id,
              profile: candidate.profile,
              hourStartMs: candidate.hourStartMs,
              added: outcome.added,
              created: outcome.created,
              onDisk: paths.length,
            },
          },
        )
      }
    }

    // A pass that reached the end starts over; one that was cut short resumes.
    this.cursor = bounded ? (last ?? resume) : null

    const report: HourAdoptionSweepReport = {
      locationId: location.id,
      refused: null,
      listings,
      hoursAdopted,
      hoursRefusedByLedger,
      hoursSkippedLive,
      hoursSkippedEmpty,
      listingErrors,
      segmentsAdded,
      hoursCreated,
      bounded,
      byDevice: [...byDevice.entries()]
        .map(([deviceId, tally]) => ({ deviceId, ...tally }))
        .toSorted((a, b) => a.deviceId - b.deviceId),
    }
    this.report(report)
    return report
  }

  /**
   * Every hour directory under this location, in cursor order.
   *
   * Sorted at each level so the cursor is a total order over a tree two passes
   * see differently: a camera added between passes appears in its place rather
   * than at the end, and is picked up by the pass after the cursor resets.
   */
  private async *candidates(
    location: RecordingsLocation,
    onError: () => void,
  ): AsyncGenerator<HourCandidate> {
    const devices = await this.list(location.root, onError)
    for (const device of inCursorOrder(devices.filter((name) => /^\d+$/.test(name)))) {
      const deviceId = Number(device)
      if (!Number.isSafeInteger(deviceId)) continue
      const present = new Set(await this.list(`${location.root}/${device}`, onError))
      for (const profile of PROFILES) {
        if (!present.has(profile)) continue
        const base = `${device}/${profile}`
        for (const year of inCursorOrder(
          (await this.list(`${location.root}/${base}`, onError)).filter((n) => /^\d{4}$/.test(n)),
        )) {
          for (const month of inCursorOrder(
            (await this.list(`${location.root}/${base}/${year}`, onError)).filter(isTwoDigit),
          )) {
            for (const day of inCursorOrder(
              (await this.list(`${location.root}/${base}/${year}/${month}`, onError)).filter(
                isTwoDigit,
              ),
            )) {
              const dayDir = `${base}/${year}/${month}/${day}`
              for (const hour of inCursorOrder(
                (await this.list(`${location.root}/${dayDir}`, onError)).filter(isTwoDigit),
              )) {
                // The path convention is UTC (`hourDirRelPath`), so the hour a
                // directory names is one `Date.UTC`, never a local-time parse.
                const startMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour))
                if (!Number.isFinite(startMs)) continue
                yield { deviceId, profile, hourStartMs: startMs, rel: `${dayDir}/${hour}` }
              }
            }
          }
        }
      }
    }
  }

  /** One directory's names; `[]` for a directory that is not there, and `[]`
   *  plus a counted error for one that could not be read. */
  private async list(absDir: string, onError: () => void): Promise<readonly string[]> {
    try {
      return (await this.deps.listDir(absDir)) ?? []
    } catch (err: unknown) {
      onError()
      this.deps.logger.debug('recorder: hour adoption could not list a directory', {
        meta: { dir: absDir, error: errMsg(err) },
      })
      return []
    }
  }

  private refusedReport(locationId: string, refused: HourAdoptionRefusal): HourAdoptionSweepReport {
    return {
      locationId,
      refused,
      listings: 0,
      hoursAdopted: 0,
      hoursRefusedByLedger: 0,
      hoursSkippedLive: 0,
      hoursSkippedEmpty: 0,
      listingErrors: 0,
      segmentsAdded: 0,
      hoursCreated: 0,
      bounded: false,
      byDevice: [],
    }
  }

  /** One line per camera that gained something, then one for the pass — a pass
   *  that found nothing must still be distinguishable from one that never ran. */
  private report(report: HourAdoptionSweepReport): void {
    for (const device of report.byDevice) {
      if (device.segmentsAdded === 0 && device.hoursCreated === 0) continue
      this.deps.logger.info('recorder: hour adoption — camera summary', {
        tags: { deviceId: device.deviceId },
        meta: {
          locationId: report.locationId,
          hoursAdopted: device.hoursAdopted,
          segmentsAdded: device.segmentsAdded,
          hoursCreated: device.hoursCreated,
        },
      })
    }
    this.deps.logger.info('recorder: hour adoption pass complete', {
      meta: {
        locationId: report.locationId,
        listings: report.listings,
        hoursAdopted: report.hoursAdopted,
        hoursRefusedByLedger: report.hoursRefusedByLedger,
        hoursSkippedLive: report.hoursSkippedLive,
        hoursSkippedEmpty: report.hoursSkippedEmpty,
        listingErrors: report.listingErrors,
        segmentsAdded: report.segmentsAdded,
        hoursCreated: report.hoursCreated,
        bounded: report.bounded,
      },
    })
  }
}
