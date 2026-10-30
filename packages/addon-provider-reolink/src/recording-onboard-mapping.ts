/**
 * Reolink → the vendor-neutral `recording-onboard` cap.
 *
 * Pure. Takes the three Baichuan reads — `getRecordCfg` (cmd 54),
 * `getRecordSchedule` and `getHddInfoList` (cmd 102) — and produces the
 * cap's status and options. No I/O, no clock of its own.
 *
 * Measured read-only on 592 (E1 Outdoor PoE, v3.1.0.5223) and 618 (E1
 * Outdoor Pro, v3.1.0.5714) on 2026-09-22. Three things that shaped this
 * module:
 *
 *   - **The library's declared `HddInfoListConfig` does not match the
 *     wire.** It says `body.HddInfoList.item[{ id, size, used }]`; the
 *     camera sends `body.HddInfoList.HddInfo` with `number`, `capacity`,
 *     `capacityM`, `remainSize`, `remainSizeM`, `format`, `mount`. The
 *     record is found STRUCTURALLY, by the key that identifies it, for
 *     the same reason `clips/clip-catalog.ts` does it that way.
 *   - **Size is split across two fields**: whole GB plus an MB
 *     remainder. 592 reports 238 + 271, i.e. 238.26 GB — reading only
 *     `capacity` loses a quarter of a gigabyte, and reading only
 *     `capacityM` loses the card.
 *   - **A trigger can appear more than once.** 618 lists `crossline`,
 *     `intrude` and `loitering` three times each — one entry per
 *     configured rule. Their masks are merged, because the cap's
 *     question is "does this camera record on line-crossing", not "on
 *     which of three line-crossing rules".
 */
import type {
  OnboardStorage,
  RecordingOnboardOptions,
  RecordingOnboardPatch,
  RecordingOnboardStatus,
  RecordTrigger,
  RecordWindow,
} from '@camstack/types'
import { WEEKLY_MASK_LENGTH, weeklyMaskToWindows, windowsToWeeklyMask } from '@camstack/types'

/** `getRecordCfg` (cmd 54), as the cameras answer it. */
export interface ReolinkRecordCfgLike {
  readonly cycle?: number
  readonly recordDelayTime?: number
  readonly preRecordTime?: number
  readonly packageTime?: number
  readonly cycleList?: readonly number[]
}

/** `getRecordSchedule`, as the cameras answer it. */
export interface ReolinkRecordScheduleLike {
  readonly enable?: boolean
  readonly typeScheduleList?: ReadonlyArray<{ readonly type: string; readonly valueTable: string }>
}

/**
 * `getRecordCfgLimits` — the camera's own statement of what it accepts.
 *
 * Mirrors `BaichuanRecordCfgLimits` structurally rather than importing
 * it, for the same reason the two `*Like` types above do: this module is
 * pure and its tests must be able to state a camera that does not exist.
 */
export interface ReolinkRecordLimitsLike {
  /** `<cyclelist>` — ENFORCED by the firmware. */
  readonly cycleList: readonly number[]
  /** `<timeList>` — the vendor app's offer, NOT enforced. */
  readonly recordDelayTimeChoices: readonly number[]
  readonly preRecordSupported: boolean
  readonly preRecordSeconds: number | null
}

/**
 * Reolink's schedule `type` → the cap's trigger vocabulary.
 *
 * `legacy` is deliberately absent: it appears on 618 and names nothing
 * an operator would recognise, so a window carrying it is COUNTED as
 * unread rather than mapped onto a guess.
 */
const TRIGGER_BY_TYPE: Readonly<Record<string, RecordTrigger | undefined>> = {
  MD: 'motion',
  Normal: 'continuous',
  people: 'person',
  vehicle: 'vehicle',
  dog_cat: 'animal',
  crossline: 'lineCrossing',
  intrude: 'intrusion',
  loitering: 'loitering',
}

/** Triggers a Reolink camera's schedule can name. */
export const REOLINK_TRIGGERS: readonly RecordTrigger[] = [
  'continuous',
  'motion',
  'person',
  'vehicle',
  'animal',
  'lineCrossing',
  'intrusion',
  'loitering',
]

// ── Storage ──────────────────────────────────────────────────────────

/**
 * Find the first record anywhere in the reply that carries `key`.
 *
 * Structural, not path-based, because the library's declared shape for
 * this reply is wrong and a path written against it finds nothing.
 */
function findRecordWithKey(node: unknown, key: string): Record<string, unknown> | null {
  if (typeof node !== 'object' || node === null) return null
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findRecordWithKey(item, key)
      if (found) return found
    }
    return null
  }
  const record: Record<string, unknown> = { ...node }
  if (key in record) return record
  for (const value of Object.values(record)) {
    const found = findRecordWithKey(value, key)
    if (found) return found
  }
  return null
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number') return null
  return Number.isFinite(value) ? value : null
}

/**
 * Total size in MB from Reolink's split pair.
 *
 * Null when the camera stated NEITHER half — a size we did not read is
 * not a size of zero (D393). A stated 0 GB with a stated MB remainder is
 * a real, small number, and survives as one.
 */
function megabytes(whole: unknown, remainder: unknown): number | null {
  const gb = finiteNumber(whole)
  const mb = finiteNumber(remainder)
  if (gb === null && mb === null) return null
  return (gb ?? 0) * 1024 + (mb ?? 0)
}

/**
 * Read `getHddInfoList`.
 *
 * `mount === 0` is a camera with no card — the same signal
 * `clips/clip-catalog.ts` keys off. `format === 0` is a card present but
 * not usable, which is `absent` with a reason that says so rather than
 * `present` with a card nothing can be written to.
 */
export function parseOnboardStorage(reply: unknown): OnboardStorage {
  const record = findRecordWithKey(reply, 'mount')
  if (!record) {
    return {
      kind: 'unknown',
      reason: 'The camera answered, but with nothing this reader recognised as storage info.',
    }
  }

  const mounted = finiteNumber(record.mount)
  if (mounted === 0) {
    return { kind: 'absent', reason: 'The camera reports no mounted storage (HddInfo mount 0).' }
  }

  const formatted = finiteNumber(record.format)
  const id = finiteNumber(record.number)
  const volume = {
    id: id === null ? '0' : String(id),
    status: formatted === 0 ? ('unformatted' as const) : ('ok' as const),
    capacityMb: megabytes(record.capacity, record.capacityM),
    freeMb: megabytes(record.remainSize, record.remainSizeM),
  }

  if (formatted === 0) {
    return {
      kind: 'absent',
      reason: 'The camera reports a card that is not formatted, so it cannot record to it.',
    }
  }
  return { kind: 'present', volumes: [volume] }
}

// ── Schedule ─────────────────────────────────────────────────────────

interface ParsedSchedule {
  readonly windows: readonly RecordWindow[]
  readonly unreadable: number
}

/**
 * Expand every `typeScheduleList` entry into windows.
 *
 * Entries sharing a trigger are merged slot-wise before expansion, so
 * three `crossline` rules produce one set of line-crossing windows
 * rather than three overlapping copies.
 *
 * An entry whose `type` is unknown, or whose table is not 168 characters,
 * is counted as unread. A table of the wrong length is not a schedule of
 * fewer days.
 */
export function parseSchedule(schedule: ReolinkRecordScheduleLike | null): ParsedSchedule {
  const entries = schedule?.typeScheduleList ?? []
  const merged = new Map<RecordTrigger, string[]>()
  let unreadable = 0

  for (const entry of entries) {
    const trigger = TRIGGER_BY_TYPE[entry.type]
    if (trigger === undefined || entry.valueTable.length !== WEEKLY_MASK_LENGTH) {
      // An all-zero table for a type nobody recognises is not lost work:
      // it schedules nothing either way. Only a table that would have
      // produced windows counts as unread.
      if (entry.valueTable.includes('1')) unreadable += 1
      continue
    }
    const existing = merged.get(trigger)
    if (!existing) {
      merged.set(trigger, [...entry.valueTable])
      continue
    }
    for (let i = 0; i < existing.length; i += 1) {
      if (entry.valueTable[i] === '1') existing[i] = '1'
    }
  }

  const windows: RecordWindow[] = []
  for (const [trigger, slots] of merged) {
    windows.push(...weeklyMaskToWindows(slots.join(''), trigger))
  }
  return { windows, unreadable }
}

// ── Status ───────────────────────────────────────────────────────────

/**
 * Fold the three reads into the cap's status.
 *
 * `tracks` is empty and `primaryTrackId` null on purpose: a Reolink
 * channel exposes no track list, and inventing one synthetic row would
 * put a fact in the UI that the camera never stated. The form renders
 * "the camera reports no recording track", which is true.
 */
export function buildOnboardStatus(input: {
  readonly storage: OnboardStorage
  readonly cfg: ReolinkRecordCfgLike | null
  readonly schedule: ReolinkRecordScheduleLike | null
  readonly now: number
}): RecordingOnboardStatus {
  const { windows, unreadable } = parseSchedule(input.schedule)
  const masterOn = input.schedule?.enable ?? null
  const scheduled = masterOn === true && windows.length > 0
  const cycle = input.cfg?.cycle

  return {
    storage: input.storage,
    tracks: [],
    primaryTrackId: null,
    enabled: masterOn,
    overwriteWhenFull: cycle === undefined ? null : cycle !== 0,
    preRecordSec: input.cfg?.preRecordTime ?? null,
    // Reolink's name for post-record is `recordDelayTime`: how long it
    // keeps recording after the trigger clears.
    postRecordSec: input.cfg?.recordDelayTime ?? null,
    segmentMinutes: input.cfg?.packageTime ?? null,
    windows: [...windows],
    unreadableWindows: unreadable,
    recordingToNowhere: scheduled && input.storage.kind === 'absent',
    lastFetchedAt: input.now,
  }
}

// ── Options ──────────────────────────────────────────────────────────

/**
 * The pre-roll a `true` write restores when the camera never stated one.
 *
 * Mirrors `DEFAULT_PRE_RECORD_SECONDS` in `@apocaliss92/nodelink-js`, which
 * is what actually goes on the wire; it is repeated here so the value the
 * form OFFERS is the value the library WRITES. If the two ever disagree the
 * operator picks a number the camera never stores, which is the silent
 * substitution this whole cap exists to prevent.
 */
export const REOLINK_PRE_RECORD_ON_SECONDS = 10

/** Why a Reolink camera cannot be written until CamStack has read it. */
export const REOLINK_NOT_READ_REASON = 'CamStack has not read this camera yet'

/**
 * Why the schedule is unwritable when one trigger occupies several rows.
 *
 * An E1 Outdoor Pro lists `crossline`, `intrude` and `loitering` three times
 * each — one row per configured rule. The status READ merges them, because
 * the cap's question is "does this camera record on line-crossing". A write
 * cannot un-merge them: addressed by type alone it rewrites all three rules
 * with one mask (measured — `replaceItemValueTable` matches every row of a
 * type when no index is given), and the cap's patch carries no room to say
 * which rule an operator meant. So the schedule is REPORTED unwritable on
 * such a camera rather than writable and destructive.
 */
export const REOLINK_MERGED_ROWS_REASON =
  'this camera stores several rules of the same kind (one row per configured rule) and CamStack cannot tell them apart, so writing the schedule would overwrite all of them with one mask'

/** How many rows each trigger occupies, from the camera's own list. */
function rowsPerTrigger(
  schedule: ReolinkRecordScheduleLike | null,
): ReadonlyMap<RecordTrigger, number> {
  const counts = new Map<RecordTrigger, number>()
  for (const entry of schedule?.typeScheduleList ?? []) {
    const trigger = TRIGGER_BY_TYPE[entry.type]
    if (trigger === undefined) continue
    counts.set(trigger, (counts.get(trigger) ?? 0) + 1)
  }
  return counts
}

/**
 * What THIS Reolink accepts.
 *
 * Writability is decided per field from the camera's OWN statement, never
 * from a vendor default:
 *
 *   - `overwriteWhenFull` needs `<cyclelist>` to offer both 0 and 1; the
 *     cap's field is a boolean and a camera offering one value cannot be
 *     set both ways. `<cyclelist>` IS enforced by the firmware (writing 7
 *     was answered 200 and dropped), so it is a real refusal.
 *   - `preRecordSec` is a two-member SET, not a span. The wire field is
 *     seconds and the firmware honours exactly two states: 0 is off, and
 *     5, 15 and 30 all read back as 10 — identically on two firmwares. A
 *     slider here would move and change nothing.
 *   - `postRecordSec` carries NO allowed set although the camera states
 *     `<timeList>`: that list is advisory, and a Home Hub offering
 *     `8,15,30` accepted and applied 20. Refusing against it would block a
 *     value the firmware honours, so the write goes through unconstrained
 *     and the read-back diff is what reports a value the camera dropped.
 *   - `segmentMinutes` likewise carries no bound, because no camera states
 *     one and an invented maximum refuses values the firmware may take.
 */
export function buildOnboardOptions(input: {
  readonly status: RecordingOnboardStatus | null
  readonly cfg: ReolinkRecordCfgLike | null
  readonly limits: ReolinkRecordLimitsLike | null
  readonly schedule: ReolinkRecordScheduleLike | null
}): RecordingOnboardOptions {
  const reached = input.status !== null
  const notRead: RecordingOnboardOptions['enabled'] = {
    readable: false,
    writable: false,
    reason: REOLINK_NOT_READ_REASON,
  }
  const writable: RecordingOnboardOptions['enabled'] = { readable: true, writable: true }
  const refuse = (reason: string): RecordingOnboardOptions['enabled'] => ({
    readable: true,
    writable: false,
    reason,
  })

  if (!reached || input.limits === null) {
    return {
      enabled: notRead,
      overwriteWhenFull: notRead,
      preRecordSec: notRead,
      postRecordSec: notRead,
      segmentMinutes: notRead,
      schedule: {
        support: notRead,
        granularityMinutes: 60,
        triggers: [...REOLINK_TRIGGERS],
        supportsOverlappingTriggers: true,
      },
    }
  }

  const limits = input.limits
  const cycleChoices = limits.cycleList
  const overwrite =
    cycleChoices.includes(0) && cycleChoices.includes(1)
      ? writable
      : refuse(
          cycleChoices.length === 0
            ? 'this camera did not say which overwrite settings it accepts'
            : `this camera accepts only ${cycleChoices.join(', ')} for overwrite, so it cannot be switched both ways`,
        )

  const preRecord = limits.preRecordSupported
    ? writable
    : refuse('this camera reports no pre-record setting, so writing one would do nothing')

  const merged = [...rowsPerTrigger(input.schedule).entries()].filter(([, count]) => count > 1)
  const unreadable = input.status?.unreadableWindows ?? 0
  const scheduleSupport =
    unreadable > 0
      ? refuse(
          `CamStack could not read ${String(unreadable)} of this camera's schedule rows, and a write would replace what it could not show`,
        )
      : merged.length > 0
        ? refuse(REOLINK_MERGED_ROWS_REASON)
        : writable

  return {
    enabled: writable,
    overwriteWhenFull: overwrite,
    preRecordSec: preRecord,
    ...(limits.preRecordSupported
      ? {
          preRecordSecAllowed: {
            values: [0, limits.preRecordSeconds ?? REOLINK_PRE_RECORD_ON_SECONDS],
          },
        }
      : {}),
    postRecordSec: writable,
    segmentMinutes: writable,
    schedule: {
      support: scheduleSupport,
      // The weekly table is 7 × 24 — one slot per HOUR. A window this
      // camera cannot express is refused rather than rounded.
      granularityMinutes: 60,
      triggers: [...REOLINK_TRIGGERS],
      // One independent mask per trigger: two triggers may cover the
      // same hour.
      supportsOverlappingTriggers: true,
    },
  }
}

// ── Patch → the two Baichuan writes ──────────────────────────────────

/** A `setRecordCfg` patch, as `@apocaliss92/nodelink-js` takes it. */
export interface ReolinkRecordCfgPatchOut {
  readonly cycle?: number
  readonly recordDelayTime?: number
  readonly preRecordEnabled?: boolean
  readonly packageTime?: number
}

/** One `setRecordSchedule` row. */
export interface ReolinkRecordScheduleEntryOut {
  readonly type: string
  readonly valueTable: string
}

/** A `setRecordSchedule` patch. */
export interface ReolinkRecordSchedulePatchOut {
  readonly enable?: boolean
  readonly entries?: readonly ReolinkRecordScheduleEntryOut[]
}

/** Both writes a cap patch turns into. Either half may be absent. */
export interface ReolinkOnboardWrites {
  readonly cfg: ReolinkRecordCfgPatchOut | null
  readonly schedule: ReolinkRecordSchedulePatchOut | null
}

/** The cap's trigger vocabulary → Reolink's schedule `type`. */
const TYPE_BY_TRIGGER: Readonly<Record<RecordTrigger, string | undefined>> = Object.fromEntries(
  Object.entries(TRIGGER_BY_TYPE)
    .filter((pair): pair is [string, RecordTrigger] => pair[1] !== undefined)
    .map(([type, trigger]) => [trigger, type]),
) as Readonly<Record<RecordTrigger, string | undefined>>

/**
 * Turn a cap patch into the two Baichuan writes.
 *
 * `windows` is the COMPLETE new set, so every trigger the camera lists gets
 * a row — including one the new set does not mention, which must be written
 * as an all-zero mask or the camera keeps recording on a trigger the
 * operator just removed. A trigger the camera does NOT list is skipped: a
 * row the camera never had is answered 200 and discarded, so sending it
 * would report success for nothing.
 *
 * `preRecordSec` collapses to the boolean the firmware really has: any
 * non-zero ask is "on", because 5, 15 and 30 all store as 10.
 */
export function buildOnboardWrites(
  patch: RecordingOnboardPatch,
  schedule: ReolinkRecordScheduleLike | null,
): ReolinkOnboardWrites {
  const cfg: {
    cycle?: number
    recordDelayTime?: number
    preRecordEnabled?: boolean
    packageTime?: number
  } = {}
  if (patch.overwriteWhenFull !== undefined) cfg.cycle = patch.overwriteWhenFull ? 1 : 0
  if (patch.postRecordSec !== undefined) cfg.recordDelayTime = patch.postRecordSec
  if (patch.preRecordSec !== undefined) cfg.preRecordEnabled = patch.preRecordSec !== 0
  if (patch.segmentMinutes !== undefined) cfg.packageTime = patch.segmentMinutes

  const scheduleOut: { enable?: boolean; entries?: ReolinkRecordScheduleEntryOut[] } = {}
  if (patch.enabled !== undefined) scheduleOut.enable = patch.enabled
  if (patch.windows !== undefined) {
    const present = new Set<string>((schedule?.typeScheduleList ?? []).map((e) => e.type))
    const entries: ReolinkRecordScheduleEntryOut[] = []
    for (const trigger of REOLINK_TRIGGERS) {
      const type = TYPE_BY_TRIGGER[trigger]
      if (type === undefined || !present.has(type)) continue
      entries.push({ type, valueTable: windowsToWeeklyMask(patch.windows, trigger) })
    }
    scheduleOut.entries = entries
  }

  return {
    cfg: Object.keys(cfg).length > 0 ? cfg : null,
    schedule: Object.keys(scheduleOut).length > 0 ? scheduleOut : null,
  }
}
