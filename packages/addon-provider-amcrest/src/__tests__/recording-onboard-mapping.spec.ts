/**
 * `recording-onboard` on Amcrest/Dahua, against VERBATIM camera bytes.
 *
 * Every fixture in `fixtures/` is exactly what device 3836 (IP4M-1041B,
 * firmware `2.800.1ENN001.0.R, build:2024-10-29`) served over its digest
 * CGI on 2026-09-23. Nothing here is hand-spelled from a document.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordingOnboardStatus, RecordWindow } from '@camstack/types'
import { describeOnboardRefusal } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AmcrestCgiClient } from '../amcrest-cgi-client.js'
import {
  AMCREST_NO_LIMITS_REASON,
  AMCREST_NOT_READ_REASON,
  AMCREST_PARTIAL_SCHEDULE_REASON,
  AMCREST_POST_RECORD_SPLIT_REASON,
  type AmcrestOnboardReads,
  buildOnboardOptions,
  buildOnboardStatus,
  buildOnboardWrites,
  capDayToRow,
  describeAmcrestScheduleRefusal,
  EMPTY_SLOT,
  findLocalStorageGroup,
  HOLIDAY_ROW,
  minutesToClock,
  parseOnboardStorage,
  parseRecordLimits,
  parseSchedule,
  parseTimeSectionSlot,
  readOverwriteWhenFull,
  readPostRecordSec,
  rowToCapDay,
  SLOTS_PER_ROW,
  TRIGGER_BY_BIT,
  weekdayRowsAreUniform,
  windowsToTimeSections,
} from '../recording-onboard-mapping.js'

function fixture(name: string): Map<string, string> {
  const raw = readFileSync(join(__dirname, 'fixtures', name), 'utf8')
  return AmcrestCgiClient.parseTable(raw)
}

const record = (): Map<string, string> => fixture('3836-record.txt')
const recordMode = (): Map<string, string> => fixture('3836-recordmode.txt')
const mediaGlobal = (): Map<string, string> => fixture('3836-mediaglobal.txt')
const storageGroup = (): Map<string, string> => fixture('3836-storagegroup.txt')
const motionDetect = (): Map<string, string> => fixture('3836-motiondetect-recordlatch.txt')
const storage = (): Map<string, string> => fixture('3836-storage.txt')
const recordCaps = (): Map<string, string> => fixture('3836-recordmanager-caps.txt')
const eventCaps = (): Map<string, string> => fixture('3836-eventmanager-caps.txt')

function liveReads(over: Partial<AmcrestOnboardReads> = {}): AmcrestOnboardReads {
  return {
    storage: parseOnboardStorage(storage()),
    record: record(),
    recordMode: recordMode(),
    mediaGlobal: mediaGlobal(),
    storageGroup: storageGroup(),
    motionDetect: motionDetect(),
    channel: 0,
    ...over,
  }
}

function liveStatus(over: Partial<AmcrestOnboardReads> = {}): RecordingOnboardStatus {
  return buildOnboardStatus({ reads: liveReads(over), now: 1_700_000_000_000 })
}

function liveLimits() {
  return parseRecordLimits({ recordCaps: recordCaps(), eventCaps: eventCaps() })
}

function liveOptions(status: RecordingOnboardStatus | null = liveStatus()) {
  return buildOnboardOptions({
    status,
    limits: liveLimits(),
    postRecord: { handlers: 1, disagree: false },
  })
}

// ── Storage ──────────────────────────────────────────────────────────

describe('parseOnboardStorage — the card the operator just fitted', () => {
  it('reads the fitted card as present, with the camera’s own path as the label', () => {
    const parsed = parseOnboardStorage(storage())
    expect(parsed.kind).toBe('present')
    if (parsed.kind !== 'present') return
    expect(parsed.volumes).toHaveLength(1)
    const volume = parsed.volumes[0]
    expect(volume?.id).toBe('/dev/mmc0:/mnt/sd')
    expect(volume?.label).toBe('/mnt/sd')
    expect(volume?.status).toBe('ok')
    expect(volume?.writable).toBe(true)
  })

  it('reads the float byte spelling the CGI uses (134202327040.000000)', () => {
    const parsed = parseOnboardStorage(storage())
    if (parsed.kind !== 'present') throw new Error('expected present')
    // 134202327040 B / 1 MiB, rounded.
    expect(parsed.volumes[0]?.capacityMb).toBe(127985)
  })

  it('an EMPTY answer is `absent` — which is what a pulled card looks like', () => {
    const parsed = parseOnboardStorage(new Map())
    expect(parsed.kind).toBe('absent')
    if (parsed.kind !== 'absent') return
    expect(parsed.reason).toMatch(/no storage device/i)
  })

  it('a listed device with no usable volume is `absent`, not `present`', () => {
    const table = new Map<string, string>([
      ['list.info[0].Name', '/dev/mmc0'],
      ['list.info[0].State', 'NoExist'],
    ])
    expect(parseOnboardStorage(table).kind).toBe('absent')
  })

  it('a failed byte read is null, NEVER 0 (D393)', () => {
    const table = new Map<string, string>([
      ['list.info[0].Name', '/dev/mmc0'],
      ['list.info[0].State', 'Success'],
      ['list.info[0].Detail[0].Path', '/mnt/sd'],
      // TotalBytes present, UsedBytes missing.
      ['list.info[0].Detail[0].TotalBytes', '134202327040.000000'],
    ])
    const parsed = parseOnboardStorage(table)
    if (parsed.kind !== 'present') throw new Error('expected present')
    expect(parsed.volumes[0]?.capacityMb).toBe(127985)
    expect(parsed.volumes[0]?.freeMb).toBeNull()
  })

  it('`IsError=true` beats a State of Success', () => {
    const table = new Map<string, string>([
      ['list.info[0].Name', '/dev/mmc0'],
      ['list.info[0].State', 'Success'],
      ['list.info[0].Detail[0].Path', '/mnt/sd'],
      ['list.info[0].Detail[0].IsError', 'true'],
    ])
    expect(parseOnboardStorage(table).kind).toBe('absent')
  })
})

// ── The TimeSection bitfield ─────────────────────────────────────────

describe('parseTimeSectionSlot', () => {
  it('takes the live slot apart, mask and clock', () => {
    expect(parseTimeSectionSlot('393222 00:00:00-23:59:59')).toEqual({
      mask: 393222,
      startMinute: 0,
      endMinute: 1440,
    })
  })

  it('23:59:59 is the firmware’s end-of-day and becomes 1440, not 1439 and not 0', () => {
    const parsed = parseTimeSectionSlot('1 00:00:00-23:59:59')
    expect(parsed?.endMinute).toBe(1440)
  })

  it('refuses a clock with seconds the cap’s minutes cannot carry, rather than rounding', () => {
    expect(parseTimeSectionSlot('1 06:30:30-12:00:00')).toBeNull()
  })

  it('refuses a slot it does not understand', () => {
    expect(parseTimeSectionSlot('nonsense')).toBeNull()
    expect(parseTimeSectionSlot('-1 00:00:00-23:59:59')).toBeNull()
  })
})

describe('parseSchedule — 3836’s real grid', () => {
  it('names bits 0, 1 and 2 and NOTHING else', () => {
    expect(TRIGGER_BY_BIT[0]).toBe('continuous')
    expect(TRIGGER_BY_BIT[1]).toBe('motion')
    expect(TRIGGER_BY_BIT[2]).toBe('alarmInput')
    expect(TRIGGER_BY_BIT[17]).toBeUndefined()
    expect(TRIGGER_BY_BIT[18]).toBeUndefined()
  })

  it('reads the two nameable triggers out of mask 393222, on all seven weekdays', () => {
    const parsed = parseSchedule(record(), 0)
    expect(parsed.windows).toHaveLength(14)
    expect(parsed.windows.filter((w) => w.trigger === 'motion')).toHaveLength(7)
    expect(parsed.windows.filter((w) => w.trigger === 'alarmInput')).toHaveLength(7)
    // bit 0 (continuous) is CLEAR on this camera — it records on EVENTS.
    expect(parsed.windows.some((w) => w.trigger === 'continuous')).toBe(false)
    expect(new Set(parsed.windows.map((w) => w.day)).size).toBe(7)
  })

  it('COUNTS the two unnameable bits on every weekday row, and never guesses them', () => {
    const parsed = parseSchedule(record(), 0)
    // 7 weekday rows x bits 17 and 18 = 14, plus the holiday row's mask 6
    // (bits 1 and 2) = 2. Nothing is silently dropped (D391).
    expect(parsed.unreadable).toBe(16)
  })

  it('counts the HOLIDAY row rather than dropping it — the cap has no holiday day', () => {
    const withoutHoliday = new Map(record())
    for (let slot = 0; slot < SLOTS_PER_ROW; slot += 1) {
      withoutHoliday.delete(`Record[0].TimeSection[${String(HOLIDAY_ROW)}][${String(slot)}]`)
    }
    expect(parseSchedule(withoutHoliday, 0).unreadable).toBe(14)
  })

  it('reports coverage even when NOTHING could be named — an unnamed trigger still records', () => {
    const table = new Map<string, string>([
      ['Record[0].TimeSection[0][0]', '393216 00:00:00-23:59:59'],
    ])
    const parsed = parseSchedule(table, 0)
    expect(parsed.windows).toHaveLength(0)
    expect(parsed.unreadable).toBe(2)
    expect(parsed.anyCoverage).toBe(true)
  })

  it('a mask of 0 is an empty slot, not an unreadable one', () => {
    const table = new Map<string, string>([['Record[0].TimeSection[0][0]', EMPTY_SLOT]])
    const parsed = parseSchedule(table, 0)
    expect(parsed.unreadable).toBe(0)
    expect(parsed.anyCoverage).toBe(false)
  })

  it('a slot that will not parse is counted, never assumed empty', () => {
    const table = new Map<string, string>([['Record[0].TimeSection[0][0]', 'garbage']])
    const parsed = parseSchedule(table, 0)
    expect(parsed.unreadable).toBe(1)
    expect(parsed.anyCoverage).toBe(true)
  })
})

describe('day layout', () => {
  it('Dahua row 0 is Sunday, which is the cap’s day 6', () => {
    expect(rowToCapDay(0)).toBe(6)
    expect(rowToCapDay(1)).toBe(0)
    expect(capDayToRow(0)).toBe(1)
    expect(capDayToRow(6)).toBe(0)
  })

  it('round-trips every row', () => {
    for (let row = 0; row < 7; row += 1) expect(capDayToRow(rowToCapDay(row))).toBe(row)
  })

  it('3836’s weekday rows are uniform, so the layout assumption cannot be wrong here', () => {
    expect(weekdayRowsAreUniform(record(), 0)).toBe(true)
  })

  it('names a non-uniform grid as one', () => {
    const table = new Map(record())
    table.set('Record[0].TimeSection[3][0]', '2 08:00:00-09:00:00')
    expect(weekdayRowsAreUniform(table, 0)).toBe(false)
  })
})

// ── Limits ───────────────────────────────────────────────────────────

describe('parseRecordLimits — what the camera itself stated', () => {
  it('reads all three bounds off the two caps endpoints', () => {
    expect(liveLimits()).toEqual({
      maxPreRecordSec: 5,
      packetLengthMinutes: { min: 1, max: 20 },
      recordLatchSec: { min: 10, max: 300 },
    })
  })

  it('a caps read that FAILED is null, never a bound of none', () => {
    expect(parseRecordLimits({ recordCaps: null, eventCaps: null })).toEqual({
      maxPreRecordSec: null,
      packetLengthMinutes: null,
      recordLatchSec: null,
    })
  })
})

// ── The two overwrite authorities ────────────────────────────────────

describe('readOverwriteWhenFull — two independent places', () => {
  it('finds the LOCAL storage group by the camera’s own name for it', () => {
    expect(findLocalStorageGroup(storageGroup())).toBe(0)
  })

  it('agrees with itself on the live camera', () => {
    expect(
      readOverwriteWhenFull({ mediaGlobal: mediaGlobal(), storageGroup: storageGroup() }),
    ).toBe(true)
  })

  it('answers null when the two DISAGREE rather than picking a winner', () => {
    const media = new Map(mediaGlobal())
    media.set('MediaGlobal.OverWrite', 'false')
    expect(readOverwriteWhenFull({ mediaGlobal: media, storageGroup: storageGroup() })).toBeNull()
  })

  it('falls back to whichever one answered when the other did not', () => {
    expect(readOverwriteWhenFull({ mediaGlobal: mediaGlobal(), storageGroup: null })).toBe(true)
    expect(readOverwriteWhenFull({ mediaGlobal: null, storageGroup: storageGroup() })).toBe(true)
    expect(readOverwriteWhenFull({ mediaGlobal: null, storageGroup: null })).toBeNull()
  })
})

// ── Post-record ──────────────────────────────────────────────────────

describe('readPostRecordSec', () => {
  it('reads the one event handler 3836 exposes', () => {
    expect(readPostRecordSec(motionDetect())).toEqual({ value: 10, handlers: 1, disagree: false })
  })

  it('refuses to pick a winner when two handlers disagree', () => {
    const table = new Map<string, string>([
      ['MotionDetect[0].EventHandler.RecordLatch', '10'],
      ['CrossLineDetection[0].EventHandler.RecordLatch', '30'],
    ])
    expect(readPostRecordSec(table)).toEqual({ value: null, handlers: 2, disagree: true })
  })

  it('a camera that stated none reports none', () => {
    expect(readPostRecordSec(null)).toEqual({ value: null, handlers: 0, disagree: false })
  })
})

// ── Status ───────────────────────────────────────────────────────────

describe('buildOnboardStatus — 3836 as it really is', () => {
  it('reports every scalar the camera stated', () => {
    const status = liveStatus()
    expect(status.enabled).toBe(true)
    expect(status.overwriteWhenFull).toBe(true)
    expect(status.preRecordSec).toBe(5)
    expect(status.postRecordSec).toBe(10)
    expect(status.segmentMinutes).toBe(5)
    expect(status.windows).toHaveLength(14)
    expect(status.unreadableWindows).toBe(16)
  })

  it('exposes no track list — a Dahua channel has none, and inventing one would be a lie', () => {
    const status = liveStatus()
    expect(status.tracks).toEqual([])
    expect(status.primaryTrackId).toBeNull()
  })

  it('`enabled` is the conjunction — RecordMode Off alone silences the camera', () => {
    const off = new Map(recordMode())
    off.set('RecordMode[0].Mode', '2')
    expect(liveStatus({ recordMode: off }).enabled).toBe(false)
  })

  it('`enabled` is the conjunction — Record.Enable false alone silences it too', () => {
    const table = new Map(record())
    table.set('Record[0].Enable', 'false')
    expect(liveStatus({ record: table }).enabled).toBe(false)
  })

  it('an unanswered switch is null, not false', () => {
    expect(liveStatus({ recordMode: null }).enabled).toBeNull()
  })

  it('recordingToNowhere is FALSE now that the card is in', () => {
    expect(liveStatus().recordingToNowhere).toBe(false)
  })

  it('recordingToNowhere goes TRUE again the moment the card is pulled', () => {
    const pulled = liveStatus({ storage: parseOnboardStorage(new Map()) })
    expect(pulled.storage.kind).toBe('absent')
    expect(pulled.recordingToNowhere).toBe(true)
  })

  it('a storage read that FAILED is `unknown`, and is NOT recording to nowhere', () => {
    const unknown = liveStatus({
      storage: { kind: 'unknown', reason: 'The camera did not answer the storage read.' },
    })
    expect(unknown.recordingToNowhere).toBe(false)
  })

  it('recordingToNowhere holds even when every trigger bit is unnameable', () => {
    const table = new Map(record())
    for (let row = 0; row <= HOLIDAY_ROW; row += 1) {
      for (let slot = 0; slot < SLOTS_PER_ROW; slot += 1) {
        table.set(
          `Record[0].TimeSection[${String(row)}][${String(slot)}]`,
          slot === 0 ? '393216 00:00:00-23:59:59' : EMPTY_SLOT,
        )
      }
    }
    const status = liveStatus({ record: table, storage: parseOnboardStorage(new Map()) })
    expect(status.windows).toHaveLength(0)
    expect(status.recordingToNowhere).toBe(true)
  })

  it('a camera whose schedule is EMPTY is not recording to nowhere', () => {
    const table = new Map(record())
    for (let row = 0; row <= HOLIDAY_ROW; row += 1) {
      for (let slot = 0; slot < SLOTS_PER_ROW; slot += 1) {
        table.set(`Record[0].TimeSection[${String(row)}][${String(slot)}]`, EMPTY_SLOT)
      }
    }
    const status = liveStatus({ record: table, storage: parseOnboardStorage(new Map()) })
    expect(status.recordingToNowhere).toBe(false)
  })
})

// ── Options ──────────────────────────────────────────────────────────

describe('buildOnboardOptions — what THIS camera accepts', () => {
  it('bounds every numeric field from the camera’s own caps', () => {
    const options = liveOptions()
    expect(options.preRecordSecRange).toEqual({ min: 0, max: 5, step: 1 })
    expect(options.postRecordSecRange).toEqual({ min: 10, max: 300, step: 1 })
    expect(options.segmentMinutesRange).toEqual({ min: 1, max: 20, step: 1 })
  })

  it('CLOSES a field whose limit it could not read — a limit we failed to read is not a limit of none', () => {
    const options = buildOnboardOptions({
      status: liveStatus(),
      limits: { maxPreRecordSec: null, packetLengthMinutes: null, recordLatchSec: null },
      postRecord: { handlers: 1, disagree: false },
    })
    expect(options.preRecordSec).toEqual({
      readable: true,
      writable: false,
      reason: AMCREST_NO_LIMITS_REASON,
    })
    expect(options.segmentMinutes.writable).toBe(false)
    expect(options.postRecordSec.writable).toBe(false)
  })

  it('closes post-record by NAME when the handlers disagree', () => {
    const options = buildOnboardOptions({
      status: liveStatus(),
      limits: liveLimits(),
      postRecord: { handlers: 2, disagree: true },
    })
    expect(options.postRecordSec.reason).toBe(AMCREST_POST_RECORD_SPLIT_REASON)
  })

  it('reports the schedule UNWRITABLE while any window is unreadable (D391)', () => {
    const options = liveOptions()
    expect(options.schedule.support.writable).toBe(false)
    expect(options.schedule.support.reason).toBe(AMCREST_PARTIAL_SCHEDULE_REASON)
  })

  it('opens the schedule once every bit is nameable', () => {
    const table = new Map(record())
    for (let row = 0; row <= HOLIDAY_ROW; row += 1) {
      for (let slot = 0; slot < SLOTS_PER_ROW; slot += 1) {
        table.set(
          `Record[0].TimeSection[${String(row)}][${String(slot)}]`,
          slot === 0 && row < 7 ? '6 00:00:00-23:59:59' : EMPTY_SLOT,
        )
      }
    }
    const options = liveOptions(liveStatus({ record: table }))
    expect(options.schedule.support).toEqual({ readable: true, writable: true })
  })

  it('a camera CamStack has not read yet is neither readable nor writable, and says so (D315)', () => {
    const options = buildOnboardOptions({
      status: null,
      limits: liveLimits(),
      postRecord: { handlers: 0, disagree: false },
    })
    for (const field of [
      options.enabled,
      options.overwriteWhenFull,
      options.preRecordSec,
      options.postRecordSec,
      options.segmentMinutes,
      options.schedule.support,
    ]) {
      expect(field.readable).toBe(false)
      expect(field.writable).toBe(false)
      expect(field.reason).toBe(AMCREST_NOT_READ_REASON)
    }
  })

  it('offers only the triggers this vendor can WRITE', () => {
    expect(liveOptions().schedule.triggers).toEqual(['continuous', 'motion', 'alarmInput'])
  })

  it('takes arbitrary minutes, and says several triggers may share a range', () => {
    const options = liveOptions()
    expect(options.schedule.granularityMinutes).toBe(1)
    expect(options.schedule.supportsOverlappingTriggers).toBe(true)
  })
})

// ── Refusal before the wire ──────────────────────────────────────────

describe('refusing before the wire — the camera will NOT do it for us', () => {
  it('refuses a pre-record above MaxPreRecordTime', () => {
    // Measured: the camera answers HTTP 400 for this one.
    expect(describeOnboardRefusal(liveOptions(), { preRecordSec: 99 })).toMatch(/between 0 and 5/)
  })

  it('refuses a segment length outside PacketLengthRange — which the camera ACCEPTS and stores', () => {
    // Measured: `MediaGlobal.PacketLength=99` answered 200 OK and stored 99,
    // although the camera's own caps say 1..20. The refusal is the only
    // thing between the operator and that.
    expect(describeOnboardRefusal(liveOptions(), { segmentMinutes: 99 })).toMatch(
      /between 1 and 20/,
    )
  })

  it('refuses a post-record outside RecordLatch — which the camera also stores', () => {
    // Measured: `RecordLatch=999` answered 200 OK and stored 999.
    expect(describeOnboardRefusal(liveOptions(), { postRecordSec: 999 })).toMatch(
      /between 10 and 300/,
    )
  })

  it('refuses a schedule write while part of the schedule is unreadable', () => {
    const refusal = describeOnboardRefusal(liveOptions(), {
      windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 }],
    })
    expect(refusal).toContain(AMCREST_PARTIAL_SCHEDULE_REASON)
  })

  it('refuses a day asking for more periods than the camera holds', () => {
    const windows: RecordWindow[] = []
    for (let i = 0; i < SLOTS_PER_ROW + 1; i += 1) {
      windows.push({ trigger: 'motion', day: 0, startMinute: i * 60, endMinute: i * 60 + 30 })
    }
    expect(describeAmcrestScheduleRefusal(windows)).toBe(
      'this camera holds 6 recording periods per day and Monday asks for 7',
    )
  })

  it('accepts a day that fits, and triggers sharing a range do not each cost a slot', () => {
    const windows: RecordWindow[] = []
    for (let i = 0; i < SLOTS_PER_ROW; i += 1) {
      windows.push({ trigger: 'motion', day: 0, startMinute: i * 60, endMinute: i * 60 + 30 })
      windows.push({ trigger: 'alarmInput', day: 0, startMinute: i * 60, endMinute: i * 60 + 30 })
    }
    expect(describeAmcrestScheduleRefusal(windows)).toBeNull()
  })
})

// ── Patch → the wire ─────────────────────────────────────────────────

describe('buildOnboardWrites — one request PER CONFIG TABLE', () => {
  const current = { channel: 0, recordMode: 0, storageGroupIndex: 0 }

  it('never puts two config tables in one request — measured: the camera applies only the first', () => {
    const writes = buildOnboardWrites(
      { preRecordSec: 3, segmentMinutes: 7, postRecordSec: 20, overwriteWhenFull: false },
      current,
    )
    for (const write of writes) {
      const prefixes = new Set(
        Object.keys(write.params).map((key) => /^[A-Za-z]+/.exec(key)?.[0] ?? ''),
      )
      expect([...prefixes]).toEqual([write.table])
    }
    expect(writes.map((w) => w.table).toSorted()).toEqual([
      'MediaGlobal',
      'MotionDetect',
      'Record',
      'StorageGroup',
    ])
  })

  it('writes overwrite-when-full to BOTH authorities, so they cannot disagree afterwards', () => {
    const writes = buildOnboardWrites({ overwriteWhenFull: false }, current)
    expect(writes.find((w) => w.table === 'MediaGlobal')?.params).toEqual({
      'MediaGlobal.OverWrite': false,
    })
    expect(writes.find((w) => w.table === 'StorageGroup')?.params).toEqual({
      'StorageGroup[0].OverWrite': false,
    })
  })

  it('skips the storage-group half when the camera named no local group', () => {
    const writes = buildOnboardWrites(
      { overwriteWhenFull: true },
      { ...current, storageGroupIndex: null },
    )
    expect(writes.some((w) => w.table === 'StorageGroup')).toBe(false)
  })

  it('turning recording OFF sets Mode 2 and Record.Enable false', () => {
    const writes = buildOnboardWrites({ enabled: false }, current)
    expect(writes.find((w) => w.table === 'RecordMode')?.params).toEqual({
      'RecordMode[0].Mode': 2,
    })
    expect(writes.find((w) => w.table === 'Record')?.params).toEqual({
      'Record[0].Enable': false,
    })
  })

  it('turning it back ON restores `auto` only when the camera was OFF', () => {
    const fromOff = buildOnboardWrites({ enabled: true }, { ...current, recordMode: 2 })
    expect(fromOff.find((w) => w.table === 'RecordMode')?.params).toEqual({
      'RecordMode[0].Mode': 0,
    })
    // A camera the operator had put in MANUAL stays in manual.
    const fromManual = buildOnboardWrites({ enabled: true }, { ...current, recordMode: 1 })
    expect(fromManual.find((w) => w.table === 'RecordMode')?.params).toEqual({
      'RecordMode[0].Mode': 1,
    })
  })

  it('a schedule write rewrites EVERY weekday slot, so a cleared day is really cleared', () => {
    const writes = buildOnboardWrites(
      { windows: [{ trigger: 'motion', day: 0, startMinute: 480, endMinute: 1080 }] },
      current,
    )
    const params = writes.find((w) => w.table === 'Record')?.params ?? {}
    // Monday is Dahua row 1.
    expect(params['Record[0].TimeSection[1][0]']).toBe('2 08:00:00-18:00:00')
    expect(params['Record[0].TimeSection[1][1]']).toBe(EMPTY_SLOT)
    // Every other weekday is cleared, not left as it was.
    expect(params['Record[0].TimeSection[2][0]']).toBe(EMPTY_SLOT)
    expect(Object.keys(params)).toHaveLength(7 * SLOTS_PER_ROW)
  })

  it('NEVER touches the holiday row — the cap cannot express it, so it must not delete it', () => {
    const writes = buildOnboardWrites(
      { windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 }] },
      current,
    )
    const params = writes.find((w) => w.table === 'Record')?.params ?? {}
    for (const key of Object.keys(params)) {
      expect(key).not.toContain(`TimeSection[${String(HOLIDAY_ROW)}]`)
    }
  })

  it('merges triggers sharing a range into ONE slot, as the bitfield intends', () => {
    const sections = windowsToTimeSections([
      { trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 },
      { trigger: 'alarmInput', day: 0, startMinute: 0, endMinute: 1440 },
    ])
    expect(sections[capDayToRow(0)]).toEqual(['6 00:00:00-23:59:59'])
  })

  it('round-trips 3836’s own whole-day range through the clock', () => {
    expect(minutesToClock(1440)).toBe('23:59:59')
    expect(minutesToClock(0)).toBe('00:00:00')
    expect(minutesToClock(510)).toBe('08:30:00')
  })

  it('carries a per-field read-back check for everything it writes (D610)', () => {
    const writes = buildOnboardWrites({ preRecordSec: 3, segmentMinutes: 7 }, current)
    expect(writes.find((w) => w.table === 'Record')?.verify['preRecordSec']).toEqual({
      key: 'Record[0].PreRecord',
      expect: '3',
    })
    expect(writes.find((w) => w.table === 'MediaGlobal')?.verify['segmentMinutes']).toEqual({
      key: 'MediaGlobal.PacketLength',
      expect: '7',
    })
  })

  it('an empty patch is no request at all', () => {
    expect(buildOnboardWrites({}, current)).toEqual([])
  })
})
