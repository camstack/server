/**
 * The top two rungs of the hydration ladder: which DAYS have footage, and which
 * HOURS of a day — answered from the directory tree, without a segment index.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `getDaysWithRecordings` and `getAvailability` answer from
 * `index.segments(deviceId)`, so the date selector — the first thing an operator
 * sees — cannot resolve until the archive-wide walk has finished. Measured on
 * the live archive (device 104, `low`): that walk is **68,457 ms over 258,449
 * files**, while the questions it is being asked cost
 *
 *   which days of a month   28 entries   1 ms
 *   which hours of a day      8 entries   1 ms
 *
 * The cheapest question in the product was waiting on the most expensive data in
 * it. These read the rung that answers, and nothing below it.
 *
 * THE TRAP, AND WHY IT IS NOT PAID FOR WITH READS
 * ───────────────────────────────────────────────
 * Directory existence is NOT footage: on the real archive **15 of 28 day
 * directories are empty**, because retention deletes files and leaves the tree
 * behind. Trusting existence would put fifteen phantom days in the selector.
 *
 * But the shape of that garbage matters. Measured: those 15 day directories
 * hold NO entries at all — they are shells — and of 261 hour directories
 * exactly ONE is empty. So the answer does not need a read inside every hour;
 * it needs the NAMES one level down, which is a single read per directory:
 *
 *   readdir(month) → day names        1 read
 *   readdir(day)   → hour names       1 read per day
 *
 * 14 reads for a 13-day month, against the 41 an inside-every-hour probe costs,
 * and against 258,449 files for an archive walk.
 *
 * The residual — an hour directory emptied but not removed — is SELF-HEALED
 * rather than worked around: a directory found empty while scanning is deleted
 * on the spot. Retention stops accumulating shells, the existing ones clear as
 * they are visited, and no second code path exists to tolerate them.
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'

/** Segment files are the only evidence; playlists and dotfiles are not. */
const SEGMENT_SUFFIX = '.m4s'

const p2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Preference order for the ONE profile availability is read from.
 *
 * Availability is a single bar: it answers "was anything recorded", not "at
 * what quality". Enumerating every profile triples the reads for an identical
 * answer — measured 75 reads / 16,028 ms against 25 / 1,489 ms for a cold day.
 *
 * Lowest first because it is the smallest and the one always recorded (the
 * scrub reads it too, so its directories are the ones already warm). A device
 * that records only `high` still answers — the pick is over what EXISTS.
 *
 * The trade, stated: a device whose profile set CHANGED mid-history has hours
 * only under a profile this does not pick, and those hours would not show. That
 * is a configuration change, not a recording gap, and reading three profiles
 * for ever is the wrong price for it.
 */
const PROFILE_PREFERENCE = ['low', 'mid', 'high'] as const

/**
 * The lowest profile this device actually RECORDS to, or null when it has none.
 *
 * Non-emptiness, not existence: a `low` directory left behind by a config
 * change would otherwise be picked over the `high` that holds the footage, and
 * the whole camera would read as having none. One shallow read per candidate,
 * at most three, and the answer is stable for a session.
 */
export async function availabilityProfile(root: string, deviceId: number): Promise<string | null> {
  const present = await profilesOf(root, deviceId)
  if (present.length === 0) return null
  const ordered = [
    ...PROFILE_PREFERENCE.filter((p) => present.includes(p)),
    ...present.filter(
      (p) => !PROFILE_PREFERENCE.includes(p as (typeof PROFILE_PREFERENCE)[number]),
    ),
  ]
  for (const p of ordered) {
    if ((await listDir(path.join(root, String(deviceId), p))).length > 0) return p
  }
  return null
}

/** The canonical recording profiles — the ONLY `<deviceId>/` subdirectories
 *  that hold segments. The camera dir also hosts per-camera artifacts that are
 *  NOT profiles (`events/`, plus the `strips/` trees the retired filmstrip tier
 *  left on disk); a walker that trusts readdir would offer them as playable
 *  profiles. */
const KNOWN_PROFILES: ReadonlySet<string> = new Set(['high', 'mid', 'low'])

/** `<root>/<deviceId>/` PROFILE subdirectories. Empty when absent. */
async function profilesOf(root: string, deviceId: number): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(root, String(deviceId)))
    return entries.filter((e) => KNOWN_PROFILES.has(e))
  } catch {
    // No footage for this device on this location. Data, not a failure.
    return []
  }
}

async function listDir(abs: string): Promise<string[]> {
  try {
    return await fs.readdir(abs)
  } catch {
    return []
  }
}

async function hasSegment(abs: string): Promise<boolean> {
  return (await listDir(abs)).some((f) => f.endsWith(SEGMENT_SUFFIX))
}

/**
 * Remove a directory that turned out to be empty. Best-effort by design: it is
 * housekeeping on a read path, so a failure (a racing writer recreating it, a
 * read-only mount) must never affect the answer.
 */
async function reapIfEmpty(abs: string, entries: readonly string[]): Promise<void> {
  if (entries.length > 0) return
  try {
    await fs.rmdir(abs)
  } catch {
    // Raced with a writer, or not ours to remove. Harmless either way.
  }
}

/**
 * Days of `year`/`month` (1-based) that hold footage, ascending.
 *
 * One read for the month's day names, one per day for its hour names. A day
 * with no hour directories is a retention shell: it is reaped and not reported.
 */
export async function daysWithFootage(
  root: string,
  deviceId: number,
  year: number,
  month: number,
): Promise<number[]> {
  const days = new Set<number>()
  const profile = await availabilityProfile(root, deviceId)
  if (profile !== null) {
    const monthDir = path.join(root, String(deviceId), profile, String(year), p2(month))
    for (const day of await listDir(monthDir)) {
      const n = Number(day)
      if (!Number.isInteger(n)) continue
      const dayDir = path.join(monthDir, day)
      const hours = await listDir(dayDir)
      if (hours.length === 0) {
        await reapIfEmpty(dayDir, hours)
        continue
      }
      days.add(n)
    }
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * Hours (0–23) of a day that hold footage, ascending — ONE read per day.
 *
 * The hour directory's NAME is the evidence. Reading inside each one to confirm
 * would cost a read per hour (nine for a typical day, 117 for a month) to
 * correct a case measured at **1 in 261**: an hour emptied by retention whose
 * directory survives.
 *
 * That residual is not tolerated, it is HEALED ONE RUNG DOWN: the segment scan
 * (`hydrateWindowFromStorage`) reads inside an hour when someone actually seeks
 * into it, and reaps it if it is empty. So each rung pays only its own cost, and
 * the garbage clears where a read was happening anyway. A day whose only hour is
 * such a shell shows in the selector until someone opens it — the smallest
 * wrong answer available, and self-correcting.
 */
export async function hoursWithFootage(
  root: string,
  deviceId: number,
  year: number,
  month: number,
  day: number,
  /** Resolved once by the caller. Re-deriving it per day cost ~90 extra reads
   *  for a month — measured as 1,624 ms on a fully WARM date-selector query. */
  knownProfile?: string,
): Promise<number[]> {
  const hours = new Set<number>()
  const profile = knownProfile ?? (await availabilityProfile(root, deviceId))
  if (profile !== null) {
    const dayDir = path.join(root, String(deviceId), profile, String(year), p2(month), p2(day))
    for (const hour of await listDir(dayDir)) {
      const n = Number(hour)
      if (Number.isInteger(n)) hours.add(n)
    }
  }
  return [...hours].sort((a, b) => a - b)
}

/** UTC ms → `YYYY-MM-DD` in the operator's local calendar. */
function localDayKey(epochMs: number, tzOffsetMinutes: number): string {
  const d = new Date(epochMs + tzOffsetMinutes * 60_000)
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/**
 * The operator's LOCAL days in `[fromMs, toMs)` that hold footage, ascending.
 *
 * Paths are UTC and a local day straddles two UTC ones, so the answer needs hour
 * granularity — but only until each local day is CONFIRMED. A day with twenty
 * recorded hours costs one probe, not twenty: the loop stops asking about a
 * local day as soon as one of its hours has a segment. That is what keeps the
 * date selector at tens of milliseconds instead of the 68 s of an archive walk.
 *
 * `onProbe` exists so a test can count the readdirs — the count is the property
 * under test, not an implementation detail.
 */
export async function localDaysWithFootage(
  root: string,
  deviceId: number,
  fromMs: number,
  toMs: number,
  tzOffsetMinutes: number,
  onProbe?: (absHourDir: string) => void,
): Promise<string[]> {
  const confirmed = new Set<string>()
  const profile = await availabilityProfile(root, deviceId)
  if (profile === null) return []

  // Widen by a day each side: a local day at either edge is fed by a UTC day
  // outside the range.
  const firstUtcDay = Math.floor(fromMs / DAY_MS) * DAY_MS - DAY_MS
  const lastUtcDay = Math.floor(toMs / DAY_MS) * DAY_MS + DAY_MS

  for (let utcDay = firstUtcDay; utcDay <= lastUtcDay; utcDay += DAY_MS) {
    const d = new Date(utcDay)
    const y = String(d.getUTCFullYear())
    const mo = p2(d.getUTCMonth() + 1)
    const da = p2(d.getUTCDate())
    {
      const dayDir = path.join(root, String(deviceId), profile, y, mo, da)
      for (const hour of await listDir(dayDir)) {
        const h = Number(hour)
        if (!Number.isInteger(h)) continue
        const at = utcDay + h * HOUR_MS
        if (at < fromMs || at >= toMs) continue
        const key = localDayKey(at, tzOffsetMinutes)
        if (confirmed.has(key)) continue // already answered — do not probe again
        const abs = path.join(dayDir, hour)
        onProbe?.(abs)
        if (await hasSegment(abs)) confirmed.add(key)
      }
    }
  }
  return [...confirmed].sort()
}

/** One segment, as its FILENAME already states it. No file is opened. */
export interface HourSegment {
  readonly startMs: number
  readonly durMs: number
  /** From the filename's third field. The directory route serves it to the
   *  client, whose byte-range URLs embed it — a wrong size is a 404. */
  readonly bytes: number
}

/** `<startMs>-<durMs>-<bytes>.m4s` — the name is the record. */
const SEGMENT_NAME = /^(\d+)-(\d+)-(\d+)\.m4s$/

/**
 * The segments of ONE hour, from their names — one directory read.
 *
 * This is the exact granularity the progressive timeline needs, and it costs
 * what the coarse answer costs: measured on the live archive, a cold hour is
 * **61 ms** and holds ~350 segments. A whole day on one profile is 25 reads,
 * 1,489 ms cold and 19 ms warm.
 *
 * ONE profile, not all three. The timeline draws a single bar, so per-profile
 * detail buys nothing and triples the reads — 75 against 25, measured at
 * 16,028 ms against 1,489 ms.
 *
 * Hour granularity is NOT a substitute for this. A real day on this archive has
 * 88 gaps over a second, including one of **1,011 s**: rendering the hour that
 * contains it as solid would hide seventeen minutes of missing footage.
 */
export async function segmentsOfHour(
  root: string,
  deviceId: number,
  profile: string,
  hourStartMs: number,
): Promise<HourSegment[]> {
  const d = new Date(hourStartMs)
  const dir = path.join(
    root,
    String(deviceId),
    profile,
    String(d.getUTCFullYear()),
    p2(d.getUTCMonth() + 1),
    p2(d.getUTCDate()),
    p2(d.getUTCHours()),
  )
  const entries = await listDir(dir)
  if (entries.length === 0) {
    // An hour emptied by retention. Reaped here, where a read was happening
    // anyway — the rung above trusts directory names and this is what makes
    // that trust converge on the truth.
    await reapIfEmpty(dir, entries)
    return []
  }
  const out: HourSegment[] = []
  for (const name of entries) {
    const m = SEGMENT_NAME.exec(name)
    if (m) out.push({ startMs: Number(m[1]), durMs: Number(m[2]), bytes: Number(m[3]) })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

/**
 * Whether this device records `profile` at all — a shallow non-emptiness check,
 * same contract as {@link availabilityProfile} but for one named profile. Lets
 * the directory route serve the profile the client asked for when it exists,
 * and fall back to the availability pick when it does not.
 */
/**
 * EVERY profile this camera holds footage in, across every root.
 *
 * {@link availabilityProfile} deliberately returns ONE — the timeline is a
 * single bar. That is right for the bar and wrong for the ANSWER: on
 * 2026-09-10 `getAvailability` reported twenty `high` ranges for camera 101
 * and the conclusion drawn was that this deployment records no `low` at all,
 * while `/media-fast/recordingsLow/101/low/` held 14 GB on a different
 * location (D433).
 *
 * Unions across roots for exactly that reason: `high` and `low` do not share a
 * location here, so a per-root answer sees one of them.
 *
 * Non-emptiness, not existence — the same rule {@link availabilityProfile}
 * keeps, so a directory left behind by a config change is not offered. And
 * only {@link KNOWN_PROFILES}: the camera dir also hosts `events/` and the
 * retired `strips/` trees, which a walker that trusts readdir would present as
 * playable.
 *
 * `list` is injectable for the test; production passes the module's own
 * directory read.
 */
export async function profilesWithFootage(
  roots: readonly string[],
  deviceId: number,
  list: (abs: string) => Promise<readonly string[]> = listDir,
): Promise<readonly string[]> {
  const found = new Set<string>()
  for (const root of roots) {
    const entries = await list(path.join(root, String(deviceId)))
    for (const entry of entries) {
      if (!KNOWN_PROFILES.has(entry)) continue
      if (found.has(entry)) continue
      if ((await list(path.join(root, String(deviceId), entry))).length > 0) found.add(entry)
    }
  }
  // Stable order, so a caller can compare two answers.
  return [...found].sort()
}

export async function profileHasFootage(
  root: string,
  deviceId: number,
  profile: string,
): Promise<boolean> {
  return (await listDir(path.join(root, String(deviceId), profile))).length > 0
}
