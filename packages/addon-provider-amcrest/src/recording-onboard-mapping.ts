/**
 * Amcrest / Dahua → the vendor-neutral `recording-onboard` cap.
 *
 * Pure. Takes the flat Dahua tables the CGI serves and produces the cap's
 * status, options and the per-table writes a patch turns into. No I/O, no
 * clock of its own (`now` is passed in).
 *
 * Measured live on 2026-09-23 against device 3836 (IP4M-1041B, firmware
 * `2.800.1ENN001.0.R, build:2024-10-29`), every write restored
 * byte-identical. Five measurements shaped this module rather than
 * decorating it:
 *
 *   - **RPC2 is not needed.** `storageDevice.cgi?action=getDeviceAllInfo`
 *     answers 200 with the same rows `storage.getDeviceAllInfo` returns
 *     over RPC2, so the whole cap rides the addon's existing digest CGI
 *     client. (`storageDevice.cgi?action=getCaps` IS 501 — the caps come
 *     from `recordManager.cgi` and `eventManager.cgi` instead.)
 *   - **A `setConfig` naming TWO config tables answers `OK` and applies
 *     only the FIRST one.** `MediaGlobal.PacketLength=6&Record[0].PreRecord=4`
 *     → `200 OK`, PacketLength 6, PreRecord unchanged; with the operands
 *     swapped, PreRecord changed and PacketLength did not. Within ONE
 *     table a write is atomic (two keys both land; one bad key rejects
 *     the pair and the body reads `Error` under HTTP 200). So a patch
 *     becomes ONE request PER TABLE — {@link AmcrestOnboardWrite} — and
 *     each is verified by re-reading (D610).
 *   - **The camera enforces its own stated limits only sometimes.**
 *     `Record[0].PreRecord=99` (caps say max 5) → HTTP 400. But
 *     `MediaGlobal.PacketLength=99` (caps say 1..20) and
 *     `MotionDetect[0].EventHandler.RecordLatch=999` (caps say 10..300)
 *     were both answered `200 OK` and **stored**. The refusal before the
 *     wire is therefore the only thing protecting the operator from
 *     writing a value the camera's own caps forbid.
 *   - **The schedule trigger is a BITFIELD, and two of its bits have no
 *     name.** See {@link TRIGGER_BY_BIT}.
 *   - **`TimeSection` has EIGHT rows, not seven.** `recordManager.cgi
 *     ?action=getCaps` reports `SupportHoliday=true`; row 7 is the holiday
 *     row and carried its own mask (`6`) on 3836. The cap's
 *     {@link RecordWindow} has no holiday day, so that row is COUNTED as
 *     unreadable rather than dropped (D391).
 */
import type {
  OnboardStorage,
  OnboardStorageVolume,
  RecordingOnboardOptions,
  RecordingOnboardPatch,
  RecordingOnboardStatus,
  RecordTrigger,
  RecordWindow,
} from '@camstack/types'
import { DAY_NAMES, MINUTES_PER_DAY } from '@camstack/types'

/** A flat Dahua table, as `AmcrestCgiClient.parseTable` produces it. */
export type DahuaTable = ReadonlyMap<string, string>

// ── Triggers: the TimeSection bitfield ───────────────────────────────

/**
 * Bit position → the cap's trigger vocabulary.
 *
 * Every `TimeSection` entry is `"<mask> HH:MM:SS-HH:MM:SS"`, and `<mask>`
 * is the SET of triggers that time range records on. 3836 carries
 * `393222` = `0x60006` on all seven weekday rows: bits 1, 2, 17 and 18.
 *
 * Only these three bits are NAMED here, because only these three are
 * defensible from the Dahua CGI specification. Bits 17 and 18 are real
 * on this firmware and this repo cannot say what they mean — most likely
 * two IVS/smart kinds, and "most likely" is exactly the guess D608
 * forbids. An unnamed bit is therefore COUNTED as an unreadable window
 * and the schedule is reported unwritable (D391), which on 3836 it is.
 *
 * To lift that: identify bits 17 and 18 — set one of them alone on a
 * slot, observe which event actually starts a recording — and add them
 * here. Nothing else in this module changes.
 */
export const TRIGGER_BY_BIT: Readonly<Record<number, RecordTrigger | undefined>> = {
  0: 'continuous',
  1: 'motion',
  2: 'alarmInput',
}

/** Triggers an Amcrest schedule can be written with. */
export const AMCREST_TRIGGERS: readonly RecordTrigger[] = ['continuous', 'motion', 'alarmInput']

/** The cap's trigger vocabulary → its bit position. */
const BIT_BY_TRIGGER: Readonly<Partial<Record<RecordTrigger, number>>> = {
  continuous: 0,
  motion: 1,
  alarmInput: 2,
}

// ── Layout constants ─────────────────────────────────────────────────

/**
 * How many `TimeSection` rows are weekdays.
 *
 * Row 7 exists on this firmware and is the HOLIDAY row
 * (`recordManager.cgi?action=getCaps` → `SupportHoliday=true`). It is not
 * a weekday and the cap cannot express it.
 */
export const WEEKDAY_ROWS = 7

/** The holiday row's index, where the firmware has one. */
export const HOLIDAY_ROW = 7

/** How many time slots each row holds. 3836 serves six. */
export const SLOTS_PER_ROW = 6

/**
 * Dahua row index → the cap's day index.
 *
 * **Layout: row 0 is SUNDAY**, which the Dahua CGI specification states
 * and every Dahua/Amcrest UI renders Sunday-first; the cap's day 0 is
 * Monday (ISO). This is an ASSUMPTION in exactly the sense D608 records
 * for Reolink's mask: all seven weekday rows on 3836 are identical, and a
 * uniform schedule reads the same under either layout, so the reads
 * shipped here are exact and the assumption is unfalsifiable from this
 * camera. {@link weekdayRowsAreUniform} names the case. To settle it: set
 * one weekday only from the Amcrest app and re-read `Record`.
 */
export function rowToCapDay(row: number): number {
  return (row + 6) % 7
}

/** The cap's day index → the Dahua row index. Inverse of {@link rowToCapDay}. */
export function capDayToRow(day: number): number {
  return (day + 1) % 7
}

/** True when every weekday row of the table carries identical slots. */
export function weekdayRowsAreUniform(table: DahuaTable, channel: number): boolean {
  const rowText = (row: number): string =>
    Array.from({ length: SLOTS_PER_ROW }, (_unused, slot) =>
      table.get(timeSectionKey(channel, row, slot)),
    ).join('\0')
  const first = rowText(0)
  for (let row = 1; row < WEEKDAY_ROWS; row += 1) if (rowText(row) !== first) return false
  return true
}

/** The Dahua key for one schedule slot. */
export function timeSectionKey(channel: number, row: number, slot: number): string {
  return `Record[${String(channel)}].TimeSection[${String(row)}][${String(slot)}]`
}

// ── Small readers ────────────────────────────────────────────────────

/**
 * A number the camera stated, or null when it did not state one.
 *
 * Never 0 for a missing or unparseable value: a measurement that failed
 * is not a measurement (D393). `TotalBytes` arrives as
 * `134202327040.000000` over CGI, so this parses a float and does not
 * demand an integer spelling.
 */
function numberAt(table: DahuaTable, key: string): number | null {
  const raw = table.get(key)
  if (raw === undefined || raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/** A boolean the camera stated, or null when it did not state one. */
function booleanAt(table: DahuaTable, key: string): boolean | null {
  const raw = table.get(key)
  if (raw === undefined) return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

const BYTES_PER_MB = 1024 * 1024

/** Bytes → whole MB, or null when the byte count was never stated (D393). */
function toMegabytes(bytes: number | null): number | null {
  if (bytes === null) return null
  return Math.round(bytes / BYTES_PER_MB)
}

// ── Storage ──────────────────────────────────────────────────────────

const VOLUME_STATUS_BY_STATE: Readonly<Record<string, OnboardStorageVolume['status']>> = {
  Success: 'ok',
  Running: 'ok',
  Error: 'error',
  Unformatted: 'unformatted',
  NoExist: 'offline',
  Offline: 'offline',
  Sleeping: 'ok',
}

/**
 * Read `storageDevice.cgi?action=getDeviceAllInfo`.
 *
 * Verbatim from 3836 with the card fitted:
 *
 * ```
 * list.info[0].Name=/dev/mmc0
 * list.info[0].State=Success
 * list.info[0].Detail[0].Path=/mnt/sd
 * list.info[0].Detail[0].TotalBytes=134202327040.000000
 * list.info[0].Detail[0].UsedBytes=345309184.000000
 * list.info[0].Detail[0].Type=ReadWrite
 * list.info[0].Detail[0].IsError=false
 * ```
 *
 * EVERY detail row is returned, not the first usable one — an operator
 * asking what is in this camera is owed the camera's whole answer. A
 * table with no `info` row at all is `absent`: that is what a camera with
 * no card answers, and it is the read that turns
 * {@link RecordingOnboardStatus.recordingToNowhere} back on. An
 * unreadable answer is `unknown`, never folded into `absent` (D393).
 */
export function parseOnboardStorage(table: DahuaTable): OnboardStorage {
  const deviceIndices = new Set<number>()
  for (const key of table.keys()) {
    const match = /^list\.info\[(\d+)\]\./.exec(key)
    if (match?.[1] !== undefined) deviceIndices.add(Number(match[1]))
  }
  if (deviceIndices.size === 0) {
    return {
      kind: 'absent',
      reason: 'The camera reports no storage device — there is no card in it.',
    }
  }

  const volumes: OnboardStorageVolume[] = []
  for (const device of [...deviceIndices].toSorted((a, b) => a - b)) {
    const prefix = `list.info[${String(device)}]`
    const name = table.get(`${prefix}.Name`) ?? `device ${String(device)}`
    const state = table.get(`${prefix}.State`)
    const detailIndices = new Set<number>()
    for (const key of table.keys()) {
      const match = new RegExp(`^list\\.info\\[${String(device)}\\]\\.Detail\\[(\\d+)\\]\\.`).exec(
        key,
      )
      if (match?.[1] !== undefined) detailIndices.add(Number(match[1]))
    }
    // A device the camera lists with no Detail row is still a volume it
    // holds — reporting nothing would lose the one row that says the
    // card is broken.
    if (detailIndices.size === 0) {
      volumes.push({
        id: name,
        label: name,
        status: statusOf(state, null),
        capacityMb: null,
        freeMb: null,
      })
      continue
    }
    for (const detail of [...detailIndices].toSorted((a, b) => a - b)) {
      const dPrefix = `${prefix}.Detail[${String(detail)}]`
      const path = table.get(`${dPrefix}.Path`)
      const total = numberAt(table, `${dPrefix}.TotalBytes`)
      const used = numberAt(table, `${dPrefix}.UsedBytes`)
      const type = table.get(`${dPrefix}.Type`)
      const isError = booleanAt(table, `${dPrefix}.IsError`)
      const volume: OnboardStorageVolume = {
        id: path === undefined ? `${name}#${String(detail)}` : `${name}:${path}`,
        ...(path === undefined ? {} : { label: path }),
        status: statusOf(state, isError),
        capacityMb: toMegabytes(total),
        // Free space needs BOTH halves. One of them missing is not a card
        // with zero free bytes (D393).
        freeMb: total === null || used === null ? null : toMegabytes(total - used),
        ...(type === undefined ? {} : { writable: type === 'ReadWrite' }),
      }
      volumes.push(volume)
    }
  }

  if (!volumes.some((volume) => volume.status === 'ok')) {
    return {
      kind: 'absent',
      reason:
        'The camera lists storage, but no volume it can write to — the card is missing, unformatted or failed.',
    }
  }
  return { kind: 'present', volumes }
}

function statusOf(
  state: string | undefined,
  isError: boolean | null,
): OnboardStorageVolume['status'] {
  if (isError === true) return 'error'
  if (state === undefined) return 'unknown'
  return VOLUME_STATUS_BY_STATE[state] ?? 'unknown'
}

// ── Schedule ─────────────────────────────────────────────────────────

/** What {@link parseSchedule} read out of the eight `TimeSection` rows. */
export interface ParsedAmcrestSchedule {
  readonly windows: readonly RecordWindow[]
  /**
   * How many pieces of schedule the camera holds that CamStack could not
   * express: a trigger bit with no name, a holiday row, an unparseable
   * slot, a clock with seconds the cap's minutes cannot carry.
   */
  readonly unreadable: number
  /**
   * True when ANY slot in ANY row carries a non-zero mask — including the
   * ones counted unreadable.
   *
   * This, not `windows.length`, is what says the camera is scheduled to
   * record: a camera whose every trigger bit is unnameable is still
   * recording, and calling it unscheduled would hide
   * {@link RecordingOnboardStatus.recordingToNowhere} on exactly the
   * camera that has it.
   */
  readonly anyCoverage: boolean
}

/** One `"<mask> HH:MM:SS-HH:MM:SS"` slot, taken apart. */
interface ParsedSlot {
  readonly mask: number
  readonly startMinute: number
  readonly endMinute: number
}

/**
 * `"393222 00:00:00-23:59:59"` → its three parts, or null when the slot
 * is not something this reader understands.
 *
 * `23:59:59` is the firmware's spelling of end-of-day and becomes 1440,
 * exactly as Hikvision's `24:00` does — collapsing it to 1439 would shave
 * a minute off every whole-day window, and to 0 would empty it. Any OTHER
 * non-zero seconds value is refused rather than rounded: the cap's
 * resolution is minutes and rounding is how an operator's 06:30:30
 * becomes 06:30 with nothing saying so.
 */
export function parseTimeSectionSlot(raw: string): ParsedSlot | null {
  const match = /^\s*(-?\d+)\s+(\d{2}):(\d{2}):(\d{2})-(\d{2}):(\d{2}):(\d{2})\s*$/.exec(raw)
  if (!match) return null
  const mask = Number(match[1])
  if (!Number.isInteger(mask) || mask < 0) return null
  const start = clockToMinutes(match[2], match[3], match[4])
  const end = clockToMinutes(match[5], match[6], match[7])
  if (start === null || end === null) return null
  return { mask, startMinute: start, endMinute: end }
}

function clockToMinutes(
  hour: string | undefined,
  minute: string | undefined,
  second: string | undefined,
): number | null {
  if (hour === undefined || minute === undefined || second === undefined) return null
  const h = Number(hour)
  const m = Number(minute)
  const s = Number(second)
  if (h > 23 || m > 59 || s > 59) return null
  // The firmware's own end-of-day spelling.
  if (h === 23 && m === 59 && s === 59) return MINUTES_PER_DAY
  if (s !== 0) return null
  return h * 60 + m
}

/** Every bit set in `mask`, low to high. */
function setBits(mask: number): number[] {
  const out: number[] = []
  for (let bit = 0; bit < 32; bit += 1) {
    if ((mask & (1 << bit)) !== 0) out.push(bit)
  }
  return out
}

/**
 * Expand the `Record[ch].TimeSection[row][slot]` grid into windows.
 *
 * One slot can name SEVERAL triggers at once — that is what the bitfield
 * is — so one slot becomes one window per NAMED bit. An unnamed bit, a
 * slot that will not parse, and every bit of the holiday row are counted
 * as unreadable: each is coverage the camera holds and the operator is
 * not being shown, and a schedule that silently shows fewer rows than the
 * camera holds is how a shorter one gets saved back (D391).
 */
export function parseSchedule(table: DahuaTable, channel: number): ParsedAmcrestSchedule {
  const windows: RecordWindow[] = []
  let unreadable = 0
  let anyCoverage = false

  for (let row = 0; row <= HOLIDAY_ROW; row += 1) {
    for (let slot = 0; slot < SLOTS_PER_ROW; slot += 1) {
      const raw = table.get(timeSectionKey(channel, row, slot))
      if (raw === undefined) continue
      const parsed = parseTimeSectionSlot(raw)
      if (parsed === null) {
        // A slot we cannot read might schedule anything. Counting it is
        // the only honest answer; assuming it is empty is not.
        unreadable += 1
        anyCoverage = true
        continue
      }
      if (parsed.mask === 0) continue
      anyCoverage = true
      const bits = setBits(parsed.mask)
      if (row === HOLIDAY_ROW) {
        // Real coverage on a day the cap has no way to name.
        unreadable += bits.length
        continue
      }
      if (parsed.endMinute <= parsed.startMinute) {
        unreadable += bits.length
        continue
      }
      for (const bit of bits) {
        const trigger = TRIGGER_BY_BIT[bit]
        if (trigger === undefined) {
          unreadable += 1
          continue
        }
        windows.push({
          trigger,
          day: rowToCapDay(row),
          startMinute: parsed.startMinute,
          endMinute: parsed.endMinute,
        })
      }
    }
  }

  return { windows, unreadable, anyCoverage }
}

// ── The camera's own statement of what it accepts ────────────────────

/**
 * What `recordManager.cgi?action=getCaps` and
 * `eventManager.cgi?action=getCaps` state.
 *
 * Every member is nullable and null means the camera did not say. A limit
 * CamStack failed to read is NOT a limit of none — it closes the control
 * (D610), because this firmware was measured storing values outside its
 * own stated caps without complaint.
 */
export interface AmcrestRecordLimits {
  /** `recordManager.cgi` → `MaxPreRecordTime`. 5 on 3836. */
  readonly maxPreRecordSec: number | null
  /** `recordManager.cgi` → `PacketLengthRange[0..1]`. 1..20 on 3836. */
  readonly packetLengthMinutes: { readonly min: number; readonly max: number } | null
  /** `eventManager.cgi` → `RecordLatch[0..1]`. 10..300 on 3836. */
  readonly recordLatchSec: { readonly min: number; readonly max: number } | null
}

/** Read both caps tables into {@link AmcrestRecordLimits}. */
export function parseRecordLimits(input: {
  readonly recordCaps: DahuaTable | null
  readonly eventCaps: DahuaTable | null
}): AmcrestRecordLimits {
  const record = input.recordCaps
  const event = input.eventCaps
  const pair = (table: DahuaTable | null, key: string): { min: number; max: number } | null => {
    if (table === null) return null
    const min = numberAt(table, `${key}[0]`)
    const max = numberAt(table, `${key}[1]`)
    if (min === null || max === null || max < min) return null
    return { min, max }
  }
  return {
    maxPreRecordSec: record === null ? null : numberAt(record, 'MaxPreRecordTime'),
    packetLengthMinutes: pair(record, 'PacketLengthRange'),
    recordLatchSec: pair(event, 'RecordLatch'),
  }
}

// ── The two overwrite authorities ────────────────────────────────────

/**
 * The storage group the local card belongs to, by the camera's own name
 * for it. 3836 serves `StorageGroup[0].Name=ReadWrite` (the card) and
 * `StorageGroup[1].Name=Remote` (FTP/NAS).
 */
export const LOCAL_STORAGE_GROUP_NAME = 'ReadWrite'

/** Index of the local storage group, or null when the camera named none. */
export function findLocalStorageGroup(table: DahuaTable): number | null {
  for (const [key, value] of table) {
    const match = /^StorageGroup\[(\d+)\]\.Name$/.exec(key)
    if (match?.[1] !== undefined && value === LOCAL_STORAGE_GROUP_NAME) return Number(match[1])
  }
  return null
}

/**
 * Overwrite-when-full, from BOTH places this firmware keeps it.
 *
 * Measured: `MediaGlobal.OverWrite` and `StorageGroup[0].OverWrite` are
 * INDEPENDENT — setting the first to `false` left the second `true` — and
 * nothing on the camera says which one the recorder honours. The card is
 * 134 GB and settling it by filling it is not an experiment this repo is
 * going to run.
 *
 * So the read is the two authorities' AGREEMENT: equal → that value;
 * different → null, which the status renders as "the camera did not say"
 * rather than picking a winner. The WRITE sets both (one request per
 * table), so a value CamStack wrote can never be the disagreeing case.
 */
export function readOverwriteWhenFull(input: {
  readonly mediaGlobal: DahuaTable | null
  readonly storageGroup: DahuaTable | null
}): boolean | null {
  const global =
    input.mediaGlobal === null ? null : booleanAt(input.mediaGlobal, 'MediaGlobal.OverWrite')
  const groupIndex = input.storageGroup === null ? null : findLocalStorageGroup(input.storageGroup)
  const group =
    input.storageGroup === null || groupIndex === null
      ? null
      : booleanAt(input.storageGroup, `StorageGroup[${String(groupIndex)}].OverWrite`)
  if (global === null) return group
  if (group === null) return global
  return global === group ? global : null
}

// ── Status ───────────────────────────────────────────────────────────

/** The Dahua record-control modes. `RecordMode[ch].Mode`. */
export const RECORD_MODE_AUTO = 0
export const RECORD_MODE_MANUAL = 1
export const RECORD_MODE_OFF = 2

/** Everything one refresh read off the camera. Any member may be null. */
export interface AmcrestOnboardReads {
  readonly storage: OnboardStorage
  readonly record: DahuaTable | null
  readonly recordMode: DahuaTable | null
  readonly mediaGlobal: DahuaTable | null
  readonly storageGroup: DahuaTable | null
  readonly motionDetect: DahuaTable | null
  readonly channel: number
}

/**
 * Post-record seconds, from every event handler that records.
 *
 * Dahua keeps post-record per EVENT HANDLER (`…EventHandler.RecordLatch`),
 * not once per channel. 3836 exposes exactly one — `MotionDetect[0]`;
 * `SmartMotionDetect`, `AlarmLocal`, `VideoBlind` and `VideoLoss` all
 * answer HTTP 400 on this firmware, and its single `VideoAnalyseRule`
 * (`LeTrack`, disabled) carries no `EventHandler`.
 *
 * Where several DO exist and disagree, there is no single number to
 * report: this returns null and the field says why, rather than picking
 * one handler's value and calling it the camera's.
 */
export function readPostRecordSec(motionDetect: DahuaTable | null): {
  readonly value: number | null
  readonly handlers: number
  readonly disagree: boolean
} {
  if (motionDetect === null) return { value: null, handlers: 0, disagree: false }
  const values: number[] = []
  for (const [key, raw] of motionDetect) {
    if (!key.endsWith('.EventHandler.RecordLatch')) continue
    const value = Number(raw)
    if (Number.isFinite(value)) values.push(value)
  }
  if (values.length === 0) return { value: null, handlers: 0, disagree: false }
  const first = values[0] ?? null
  const disagree = values.some((value) => value !== first)
  return { value: disagree ? null : first, handlers: values.length, disagree }
}

/**
 * Fold the reads into the cap's status.
 *
 * `tracks` is empty and `primaryTrackId` null, as on Reolink: a Dahua
 * channel exposes no track list, and inventing one synthetic row would
 * put a fact in the UI the camera never stated.
 *
 * `enabled` is the CONJUNCTION of the two switches that both have to be
 * on for the camera to record on its schedule — `RecordMode[ch].Mode`
 * (0 auto / 1 manual / 2 off) and `Record[ch].Enable`. Either one off
 * means nothing is recorded, so reporting only one of them would call a
 * silent camera enabled.
 */
export function buildOnboardStatus(input: {
  readonly reads: AmcrestOnboardReads
  readonly now: number
}): RecordingOnboardStatus {
  const { reads } = input
  const channel = reads.channel
  const schedule =
    reads.record === null
      ? { windows: [], unreadable: 0, anyCoverage: false }
      : parseSchedule(reads.record, channel)

  const mode =
    reads.recordMode === null
      ? null
      : numberAt(reads.recordMode, `RecordMode[${String(channel)}].Mode`)
  const recordEnable =
    reads.record === null ? null : booleanAt(reads.record, `Record[${String(channel)}].Enable`)
  const enabled =
    mode === null || recordEnable === null ? null : mode !== RECORD_MODE_OFF && recordEnable

  const post = readPostRecordSec(reads.motionDetect)

  return {
    storage: reads.storage,
    tracks: [],
    primaryTrackId: null,
    enabled,
    overwriteWhenFull: readOverwriteWhenFull({
      mediaGlobal: reads.mediaGlobal,
      storageGroup: reads.storageGroup,
    }),
    preRecordSec:
      reads.record === null ? null : numberAt(reads.record, `Record[${String(channel)}].PreRecord`),
    postRecordSec: post.value,
    segmentMinutes:
      reads.mediaGlobal === null ? null : numberAt(reads.mediaGlobal, 'MediaGlobal.PacketLength'),
    windows: [...schedule.windows],
    unreadableWindows: schedule.unreadable,
    // Coverage the reader could not NAME still records. Gating this on
    // `windows.length` would hide the defect on exactly the camera whose
    // every trigger bit is unnameable.
    recordingToNowhere: enabled === true && schedule.anyCoverage && reads.storage.kind === 'absent',
    lastFetchedAt: input.now,
  }
}

// ── Options ──────────────────────────────────────────────────────────

/** Why nothing can be written before CamStack has read the camera. */
export const AMCREST_NOT_READ_REASON = 'CamStack has not read this camera yet'

/** Why a field is closed when the camera never stated its limits. */
export const AMCREST_NO_LIMITS_REASON =
  'this camera did not state the values it accepts for this setting, and it was measured storing values outside its own limits without complaint'

/** Why the schedule is closed when part of it could not be read. */
export const AMCREST_PARTIAL_SCHEDULE_REASON =
  'CamStack could not read every recording window this camera holds — it records on triggers this version cannot name — so replacing them would delete the ones it could not show'

/** Why post-record is closed when the handlers disagree. */
export const AMCREST_POST_RECORD_SPLIT_REASON =
  'this camera keeps post-record separately per event type and they do not agree, so there is no single value to show or write'

/**
 * What THIS Amcrest accepts.
 *
 * Writability comes from the camera's OWN statement, never a vendor
 * default: `recordManager.cgi?action=getCaps` bounds pre-record and
 * segment length, `eventManager.cgi?action=getCaps` bounds post-record.
 * A caps read that failed closes its field, because this firmware was
 * measured answering `200 OK` to `PacketLength=99` and `RecordLatch=999`
 * — values its own caps forbid. Nothing but the refusal before the wire
 * stops those.
 */
export function buildOnboardOptions(input: {
  readonly status: RecordingOnboardStatus | null
  readonly limits: AmcrestRecordLimits
  readonly postRecord: { readonly handlers: number; readonly disagree: boolean }
}): RecordingOnboardOptions {
  const reached = input.status !== null
  const closed = (reason: string): RecordingOnboardOptions['enabled'] => ({
    readable: reached,
    writable: false,
    reason: reached ? reason : AMCREST_NOT_READ_REASON,
  })
  const open: RecordingOnboardOptions['enabled'] = { readable: true, writable: true }
  const gate = (allowed: boolean, reason: string): RecordingOnboardOptions['enabled'] =>
    reached && allowed ? open : closed(reason)

  const limits = input.limits
  const preOk = limits.maxPreRecordSec !== null
  const segmentOk = limits.packetLengthMinutes !== null
  const postOk =
    limits.recordLatchSec !== null && input.postRecord.handlers > 0 && !input.postRecord.disagree

  const scheduleReadable = (input.status?.unreadableWindows ?? 0) === 0

  return {
    enabled: gate(true, AMCREST_NOT_READ_REASON),
    // Written to BOTH authorities, so a value CamStack set can never be
    // the disagreeing case the read reports as null.
    overwriteWhenFull: gate(true, AMCREST_NOT_READ_REASON),
    preRecordSec: gate(preOk, AMCREST_NO_LIMITS_REASON),
    ...(limits.maxPreRecordSec === null
      ? {}
      : { preRecordSecRange: { min: 0, max: limits.maxPreRecordSec, step: 1 } }),
    postRecordSec: gate(
      postOk,
      input.postRecord.disagree ? AMCREST_POST_RECORD_SPLIT_REASON : AMCREST_NO_LIMITS_REASON,
    ),
    ...(limits.recordLatchSec === null
      ? {}
      : {
          postRecordSecRange: {
            min: limits.recordLatchSec.min,
            max: limits.recordLatchSec.max,
            step: 1,
          },
        }),
    segmentMinutes: gate(segmentOk, AMCREST_NO_LIMITS_REASON),
    ...(limits.packetLengthMinutes === null
      ? {}
      : {
          segmentMinutesRange: {
            min: limits.packetLengthMinutes.min,
            max: limits.packetLengthMinutes.max,
            step: 1,
          },
        }),
    schedule: {
      support: gate(scheduleReadable, AMCREST_PARTIAL_SCHEDULE_REASON),
      // `TimeSection` carries `HH:MM:SS`, so the firmware takes arbitrary
      // minutes. Seconds it cannot express are refused, not rounded.
      granularityMinutes: 1,
      triggers: [...AMCREST_TRIGGERS],
      // One slot's mask is a SET of triggers, so two triggers may cover
      // the same minutes on the same day — they share one slot.
      supportsOverlappingTriggers: true,
    },
  }
}

// ── Patch → one request PER CONFIG TABLE ─────────────────────────────

/**
 * One `configManager.cgi?action=setConfig` request.
 *
 * `table` is the config block every key belongs to. A request may name
 * exactly ONE block: measured on 3836, a `setConfig` naming two answers
 * `200 OK` and applies only the first, silently. `verify` says where to
 * read each written key back from, keyed by the cap field it came from,
 * so the verdict can be reported per field (D610).
 */
export interface AmcrestOnboardWrite {
  readonly table: string
  readonly params: Readonly<Record<string, string | number | boolean>>
  /** cap field name → the Dahua key that must read back as the ask. */
  readonly verify: Readonly<Record<string, { readonly key: string; readonly expect: string }>>
}

/** What a cap patch becomes on the wire. Ordered; each entry is one request. */
export type AmcrestOnboardWrites = readonly AmcrestOnboardWrite[]

/**
 * Turn a cap patch into one request per config table.
 *
 * `windows` is the COMPLETE new set, so every weekday row is rewritten —
 * including a day the new set does not mention, whose slots must be
 * written back as `0 00:00:00-23:59:59` or the camera keeps recording on
 * a day the operator just cleared. Slots beyond the new windows are
 * cleared the same way. The HOLIDAY row is never touched: the cap cannot
 * express it, so rewriting it would delete coverage nobody was shown.
 *
 * `enabled` is read-modify-write on `RecordMode`: turning recording back
 * ON restores `auto` only when the camera was `off`, so a camera the
 * operator had put in `manual` stays in `manual`.
 */
export function buildOnboardWrites(
  patch: RecordingOnboardPatch,
  current: {
    readonly channel: number
    readonly recordMode: number | null
    readonly storageGroupIndex: number | null
  },
): AmcrestOnboardWrites {
  const ch = String(current.channel)
  const writes: AmcrestOnboardWrite[] = []

  // ── Record ────────────────────────────────────────────────────────
  const recordParams: Record<string, string | number | boolean> = {}
  const recordVerify: Record<string, { key: string; expect: string }> = {}
  if (patch.enabled !== undefined) {
    recordParams[`Record[${ch}].Enable`] = patch.enabled
    recordVerify['enabled'] = {
      key: `Record[${ch}].Enable`,
      expect: patch.enabled ? 'true' : 'false',
    }
  }
  if (patch.preRecordSec !== undefined) {
    recordParams[`Record[${ch}].PreRecord`] = patch.preRecordSec
    recordVerify['preRecordSec'] = {
      key: `Record[${ch}].PreRecord`,
      expect: String(patch.preRecordSec),
    }
  }
  if (patch.windows !== undefined) {
    const slots = windowsToTimeSections(patch.windows)
    for (let row = 0; row < WEEKDAY_ROWS; row += 1) {
      for (let slot = 0; slot < SLOTS_PER_ROW; slot += 1) {
        const value = slots[row]?.[slot] ?? EMPTY_SLOT
        const key = timeSectionKey(current.channel, row, slot)
        recordParams[key] = value
        recordVerify[`windows[${String(row)}][${String(slot)}]`] = { key, expect: value }
      }
    }
  }
  if (Object.keys(recordParams).length > 0) {
    writes.push({ table: 'Record', params: recordParams, verify: recordVerify })
  }

  // ── RecordMode ────────────────────────────────────────────────────
  if (patch.enabled !== undefined) {
    const mode = patch.enabled
      ? current.recordMode === RECORD_MODE_OFF || current.recordMode === null
        ? RECORD_MODE_AUTO
        : current.recordMode
      : RECORD_MODE_OFF
    writes.push({
      table: 'RecordMode',
      params: { [`RecordMode[${ch}].Mode`]: mode },
      verify: { enabledMode: { key: `RecordMode[${ch}].Mode`, expect: String(mode) } },
    })
  }

  // ── MediaGlobal ───────────────────────────────────────────────────
  const mediaParams: Record<string, string | number | boolean> = {}
  const mediaVerify: Record<string, { key: string; expect: string }> = {}
  if (patch.overwriteWhenFull !== undefined) {
    mediaParams['MediaGlobal.OverWrite'] = patch.overwriteWhenFull
    mediaVerify['overwriteWhenFull'] = {
      key: 'MediaGlobal.OverWrite',
      expect: patch.overwriteWhenFull ? 'true' : 'false',
    }
  }
  if (patch.segmentMinutes !== undefined) {
    mediaParams['MediaGlobal.PacketLength'] = patch.segmentMinutes
    mediaVerify['segmentMinutes'] = {
      key: 'MediaGlobal.PacketLength',
      expect: String(patch.segmentMinutes),
    }
  }
  if (Object.keys(mediaParams).length > 0) {
    writes.push({ table: 'MediaGlobal', params: mediaParams, verify: mediaVerify })
  }

  // ── StorageGroup — the second overwrite authority ─────────────────
  if (patch.overwriteWhenFull !== undefined && current.storageGroupIndex !== null) {
    const key = `StorageGroup[${String(current.storageGroupIndex)}].OverWrite`
    writes.push({
      table: 'StorageGroup',
      params: { [key]: patch.overwriteWhenFull },
      verify: {
        overwriteWhenFullGroup: { key, expect: patch.overwriteWhenFull ? 'true' : 'false' },
      },
    })
  }

  // ── MotionDetect — where post-record lives ────────────────────────
  if (patch.postRecordSec !== undefined) {
    const key = `MotionDetect[${ch}].EventHandler.RecordLatch`
    writes.push({
      table: 'MotionDetect',
      params: { [key]: patch.postRecordSec },
      verify: { postRecordSec: { key, expect: String(patch.postRecordSec) } },
    })
  }

  return writes
}

/** The camera's own spelling of a slot that schedules nothing. */
export const EMPTY_SLOT = '0 00:00:00-23:59:59'

/**
 * Windows → the weekday rows' slots.
 *
 * Windows sharing a day and a time range are MERGED into one slot whose
 * mask carries every trigger — that is what the bitfield is, and emitting
 * one slot per trigger would burn through the six the camera has.
 *
 * A day needing more than {@link SLOTS_PER_ROW} distinct ranges yields
 * only the first six; the caller refuses that case before the wire rather
 * than letting the extra ones fall off here. A trigger with no bit is
 * skipped for the same reason — `describeOnboardRefusal` has already
 * refused it against `options.schedule.triggers`.
 */
export function windowsToTimeSections(windows: readonly RecordWindow[]): readonly string[][] {
  const rows: string[][] = Array.from({ length: WEEKDAY_ROWS }, () => [])
  for (let day = 0; day < WEEKDAY_ROWS; day += 1) {
    const byRange = new Map<string, number>()
    for (const window of windows) {
      if (window.day !== day) continue
      const bit = BIT_BY_TRIGGER[window.trigger]
      if (bit === undefined) continue
      const range = `${minutesToClock(window.startMinute)}-${minutesToClock(window.endMinute)}`
      byRange.set(range, (byRange.get(range) ?? 0) | (1 << bit))
    }
    const row = capDayToRow(day)
    rows[row] = [...byRange.entries()]
      .toSorted((a, b) => a[0].localeCompare(b[0]))
      .map(([range, mask]) => `${String(mask)} ${range}`)
  }
  return rows
}

/**
 * The one refusal `describeOnboardRefusal` cannot make for this vendor.
 *
 * A Dahua weekday row holds {@link SLOTS_PER_ROW} time ranges and no
 * more. A day asking for more would be written as its first six and the
 * rest would vanish into a `200 OK` — the silent drop this whole cap
 * exists to prevent — so it is refused by name, before the wire, with the
 * same voice the shared vocabulary uses.
 *
 * Returns null when the set fits.
 */
export function describeAmcrestScheduleRefusal(windows: readonly RecordWindow[]): string | null {
  for (const [day, needed] of slotsNeededPerDay(windows)) {
    if (needed > SLOTS_PER_ROW) {
      return `this camera holds ${String(SLOTS_PER_ROW)} recording periods per day and ${DAY_NAMES[day] ?? `day ${String(day)}`} asks for ${String(needed)}`
    }
  }
  return null
}

/** How many distinct time ranges a day would need. For the refusal. */
export function slotsNeededPerDay(windows: readonly RecordWindow[]): ReadonlyMap<number, number> {
  const out = new Map<number, number>()
  for (let day = 0; day < WEEKDAY_ROWS; day += 1) {
    const ranges = new Set<string>()
    for (const window of windows) {
      if (window.day !== day) continue
      ranges.add(`${String(window.startMinute)}-${String(window.endMinute)}`)
    }
    out.set(day, ranges.size)
  }
  return out
}

/**
 * `1440` → `23:59:59`, the firmware's own end-of-day; everything else
 * `HH:MM:00`.
 */
export function minutesToClock(minute: number): string {
  if (minute >= MINUTES_PER_DAY) return '23:59:59'
  const hour = Math.floor(minute / 60)
  const rest = minute % 60
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}:00`
}
