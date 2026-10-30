/**
 * Reolink → `recording-onboard`, against payloads the cameras actually
 * answered.
 *
 * Every fixture below was captured read-only on 2026-09-22 from two
 * MAINS cameras: 107 (E1 Outdoor PoE, v3.1.0.5223_2510172100) and 108
 * (E1 Outdoor Pro, v3.1.0.5714_2511271366). They are inline consts
 * rather than files because that is this package's convention
 * (`osd-mapping.spec.ts`, `clip-catalog.spec.ts`).
 *
 * Two of them exist because the library's TYPES are wrong about them:
 * `HddInfoListConfig` declares `item[{id,size,used}]` and the camera
 * sends `HddInfo{number,capacity,capacityM,format,mount,…}`. A parser
 * written against the declaration finds nothing at all, and — worse —
 * finds it silently.
 */
import { describe, expect, it } from 'vitest'
import {
  buildOnboardOptions,
  buildOnboardStatus,
  buildOnboardWrites,
  parseOnboardStorage,
  parseSchedule,
  REOLINK_MERGED_ROWS_REASON,
  REOLINK_PRE_RECORD_ON_SECONDS,
} from '../recording-onboard-mapping.js'

/** Verbatim `getHddInfoList()` from 592. */
const HDD_592 = {
  body: {
    HddInfoList: {
      HddInfo: {
        number: 0,
        capacity: 238,
        capacityM: 271,
        format: 1,
        mount: 1,
        remainSize: 0,
        remainSizeM: 598,
      },
      '@_version': 1.1,
    },
  },
}

/** Verbatim `getRecordCfg(0)` from 592 and 618 — identical on both. */
const RECORD_CFG = {
  channelId: 0,
  cycle: 1,
  recordDelayTime: 15,
  preRecordTime: 10,
  packageTime: 5,
  cycleList: [0, 1],
}

const ALL_ON = '1'.repeat(168)
const ALL_OFF = '0'.repeat(168)

/** Verbatim `getRecordSchedule(0)` from 592. */
const SCHEDULE_592 = {
  channelId: 0,
  enable: true,
  typeScheduleList: [
    { type: 'MD', valueTable: ALL_ON },
    { type: 'Normal', valueTable: ALL_OFF },
    { type: 'people', valueTable: ALL_ON },
    { type: 'vehicle', valueTable: ALL_ON },
    { type: 'dog_cat', valueTable: ALL_ON },
  ],
}

/** Verbatim `getRecordSchedule(0)` from 618 — note the REPEATED types. */
const SCHEDULE_618 = {
  channelId: 0,
  enable: true,
  typeScheduleList: [
    { type: 'MD', valueTable: ALL_ON },
    { type: 'Normal', valueTable: ALL_OFF },
    { type: 'people', valueTable: ALL_ON },
    { type: 'vehicle', valueTable: ALL_ON },
    { type: 'dog_cat', valueTable: ALL_ON },
    { type: 'crossline', valueTable: ALL_OFF },
    { type: 'crossline', valueTable: ALL_OFF },
    { type: 'crossline', valueTable: ALL_OFF },
    { type: 'intrude', valueTable: ALL_OFF },
    { type: 'intrude', valueTable: ALL_OFF },
    { type: 'intrude', valueTable: ALL_OFF },
    { type: 'loitering', valueTable: ALL_OFF },
    { type: 'loitering', valueTable: ALL_OFF },
    { type: 'loitering', valueTable: ALL_OFF },
    { type: 'legacy', valueTable: ALL_OFF },
  ],
}

describe('getHddInfoList — the reply the library mistypes', () => {
  it('finds the record structurally, where the declared path does not exist', () => {
    expect(HDD_592.body.HddInfoList).not.toHaveProperty('item')
    expect(parseOnboardStorage(HDD_592).kind).toBe('present')
  })

  it('adds the split GB + MB halves, losing neither', () => {
    const storage = parseOnboardStorage(HDD_592)
    if (storage.kind !== 'present') throw new Error('expected present')
    // 238 GB + 271 MB = 243 983 MB ≈ 238.26 GB, which is what the app shows.
    expect(storage.volumes[0]?.capacityMb).toBe(238 * 1024 + 271)
    // 0 GB + 598 MB free: a looping card that has wrapped.
    expect(storage.volumes[0]?.freeMb).toBe(598)
  })

  it('reads mount 0 as no card', () => {
    const storage = parseOnboardStorage({ body: { HddInfoList: { HddInfo: { mount: 0 } } } })
    expect(storage.kind).toBe('absent')
    if (storage.kind === 'absent') expect(storage.reason).toContain('mount 0')
  })

  it('reads an unformatted card as unusable, and says which problem it is', () => {
    const storage = parseOnboardStorage({
      body: { HddInfoList: { HddInfo: { mount: 1, format: 0, capacity: 238 } } },
    })
    expect(storage.kind).toBe('absent')
    if (storage.kind === 'absent') expect(storage.reason).toContain('not formatted')
  })

  it('answers UNKNOWN, never absent, when the reply held nothing it understood', () => {
    expect(parseOnboardStorage({ body: {} }).kind).toBe('unknown')
    expect(parseOnboardStorage(null).kind).toBe('unknown')
  })

  it('never turns an unstated size into zero', () => {
    const storage = parseOnboardStorage({ body: { HddInfoList: { HddInfo: { mount: 1 } } } })
    if (storage.kind !== 'present') throw new Error('expected present')
    expect(storage.volumes[0]?.capacityMb).toBeNull()
    expect(storage.volumes[0]?.freeMb).toBeNull()
  })
})

describe('getRecordSchedule — the 7×24 hour masks', () => {
  it('turns 592 into whole-day windows per trigger, not 168 hourly ones', () => {
    const { windows, unreadable } = parseSchedule(SCHEDULE_592)
    expect(unreadable).toBe(0)
    // motion + person + vehicle + animal, seven days each.
    expect(windows).toHaveLength(28)
    const triggers = new Set(windows.map((w) => w.trigger))
    expect([...triggers].sort()).toEqual(['animal', 'motion', 'person', 'vehicle'])
    for (const window of windows) {
      expect(window.startMinute).toBe(0)
      expect(window.endMinute).toBe(1440)
    }
  })

  it('produces nothing for the all-zero Normal table — an off trigger is not a window', () => {
    const { windows } = parseSchedule(SCHEDULE_592)
    expect(windows.some((w) => w.trigger === 'continuous')).toBe(false)
  })

  it('merges 618’s THREE crossline rules into one line-crossing answer', () => {
    const { windows } = parseSchedule({
      ...SCHEDULE_618,
      typeScheduleList: [
        { type: 'crossline', valueTable: ALL_OFF },
        { type: 'crossline', valueTable: `1${ALL_OFF.slice(1)}` },
        { type: 'crossline', valueTable: ALL_OFF },
      ],
    })
    const crossing = windows.filter((w) => w.trigger === 'lineCrossing')
    expect(crossing).toHaveLength(1)
    expect(crossing[0]).toEqual({
      trigger: 'lineCrossing',
      day: 0,
      startMinute: 0,
      endMinute: 60,
    })
  })

  it('reads 618, whose extra rule types add no windows because they are all off', () => {
    const { windows, unreadable } = parseSchedule(SCHEDULE_618)
    expect(windows).toHaveLength(28)
    expect(unreadable).toBe(0)
  })

  it('counts an unknown type that WOULD have scheduled something', () => {
    const { unreadable } = parseSchedule({
      enable: true,
      typeScheduleList: [{ type: 'something_new', valueTable: ALL_ON }],
    })
    expect(unreadable).toBe(1)
  })

  it('does not count an unknown type that schedules nothing', () => {
    const { unreadable } = parseSchedule({
      enable: true,
      typeScheduleList: [{ type: 'legacy', valueTable: ALL_OFF }],
    })
    expect(unreadable).toBe(0)
  })

  it('counts a table of the wrong length rather than reading fewer days from it', () => {
    const { windows, unreadable } = parseSchedule({
      enable: true,
      typeScheduleList: [{ type: 'MD', valueTable: '1'.repeat(24) }],
    })
    expect(windows).toEqual([])
    expect(unreadable).toBe(1)
  })
})

describe('buildOnboardStatus', () => {
  const status = buildOnboardStatus({
    storage: parseOnboardStorage(HDD_592),
    cfg: RECORD_CFG,
    schedule: SCHEDULE_592,
    now: 1_700_000_000_000,
  })

  it('reads every scalar 592 answered, under the cap’s names', () => {
    expect(status).toMatchObject({
      enabled: true,
      overwriteWhenFull: true,
      preRecordSec: 10,
      // Reolink calls post-record `recordDelayTime`.
      postRecordSec: 15,
      segmentMinutes: 5,
      unreadableWindows: 0,
      recordingToNowhere: false,
    })
  })

  it('reports NO tracks rather than inventing a synthetic one', () => {
    expect(status.tracks).toEqual([])
    expect(status.primaryTrackId).toBeNull()
  })

  it('leaves a scalar the camera did not answer as null, not as zero', () => {
    const sparse = buildOnboardStatus({
      storage: parseOnboardStorage(HDD_592),
      cfg: {},
      schedule: SCHEDULE_592,
      now: 1,
    })
    expect(sparse.preRecordSec).toBeNull()
    expect(sparse.postRecordSec).toBeNull()
    expect(sparse.segmentMinutes).toBeNull()
    expect(sparse.overwriteWhenFull).toBeNull()
  })

  it('flags a scheduled camera whose card is gone', () => {
    const gone = buildOnboardStatus({
      storage: parseOnboardStorage({ body: { HddInfoList: { HddInfo: { mount: 0 } } } }),
      cfg: RECORD_CFG,
      schedule: SCHEDULE_592,
      now: 1,
    })
    expect(gone.recordingToNowhere).toBe(true)
  })

  it('does not flag one whose storage we merely failed to read', () => {
    const unread = buildOnboardStatus({
      storage: parseOnboardStorage({ body: {} }),
      cfg: RECORD_CFG,
      schedule: SCHEDULE_592,
      now: 1,
    })
    expect(unread.storage.kind).toBe('unknown')
    expect(unread.recordingToNowhere).toBe(false)
  })

  it('does not flag one that is not scheduled at all', () => {
    const off = buildOnboardStatus({
      storage: parseOnboardStorage({ body: { HddInfoList: { HddInfo: { mount: 0 } } } }),
      cfg: RECORD_CFG,
      schedule: { enable: false, typeScheduleList: [] },
      now: 1,
    })
    expect(off.recordingToNowhere).toBe(false)
  })
})

/** Verbatim `getRecordCfgLimits(0)` from 592. */
const LIMITS_592 = {
  cycleList: [0, 1],
  recordDelayTimeChoices: [8, 15, 30],
  preRecordSupported: true,
  preRecordSeconds: 10,
}

describe('buildOnboardOptions — writability comes from what the camera SAID', () => {
  const status = buildOnboardStatus({
    storage: parseOnboardStorage(HDD_592),
    cfg: RECORD_CFG,
    schedule: SCHEDULE_592,
    now: 1,
  })
  const options592 = buildOnboardOptions({
    status,
    cfg: RECORD_CFG,
    limits: LIMITS_592,
    schedule: SCHEDULE_592,
  })

  it('opens every field on 592, whose rows are unique and whose cyclelist offers both', () => {
    for (const support of [
      options592.enabled,
      options592.overwriteWhenFull,
      options592.preRecordSec,
      options592.postRecordSec,
      options592.segmentMinutes,
      options592.schedule.support,
    ]) {
      expect(support.readable).toBe(true)
      expect(support.writable).toBe(true)
    }
  })

  it('offers pre-record as the TWO states the firmware really has, not a span', () => {
    expect(options592.preRecordSecAllowed).toEqual({ values: [0, 10] })
    expect(options592.preRecordSecRange).toBeUndefined()
  })

  it('offers the default pre-roll when the camera is currently off and stated none', () => {
    const options = buildOnboardOptions({
      status,
      cfg: RECORD_CFG,
      limits: { ...LIMITS_592, preRecordSeconds: null },
      schedule: SCHEDULE_592,
    })
    expect(options.preRecordSecAllowed?.values).toEqual([0, REOLINK_PRE_RECORD_ON_SECONDS])
  })

  it('constrains post-record with NOTHING, because <timeList> is advisory', () => {
    // Measured: a Home Hub offering 8,15,30 accepted and applied 20.
    // An allowed set here would refuse a value the firmware honours.
    expect(options592.postRecordSecAllowed).toBeUndefined()
    expect(options592.postRecordSecRange).toBeUndefined()
    expect(options592.postRecordSec.writable).toBe(true)
  })

  it('refuses the schedule on 618, which stores three rules per trigger', () => {
    const status618 = buildOnboardStatus({
      storage: parseOnboardStorage(HDD_592),
      cfg: RECORD_CFG,
      schedule: SCHEDULE_618,
      now: 1,
    })
    const options = buildOnboardOptions({
      status: status618,
      cfg: RECORD_CFG,
      limits: LIMITS_592,
      schedule: SCHEDULE_618,
    })
    expect(options.schedule.support.writable).toBe(false)
    expect(options.schedule.support.reason).toBe(REOLINK_MERGED_ROWS_REASON)
    // The scalar knobs are unaffected: one unwritable field must not
    // close the others.
    expect(options.preRecordSec.writable).toBe(true)
  })

  it('refuses pre-record on a camera whose document carries no preRecordTime', () => {
    const options = buildOnboardOptions({
      status,
      cfg: RECORD_CFG,
      limits: { ...LIMITS_592, preRecordSupported: false, preRecordSeconds: null },
      schedule: SCHEDULE_592,
    })
    expect(options.preRecordSec.writable).toBe(false)
    expect(options.preRecordSec.reason).toContain('no pre-record setting')
    expect(options.preRecordSecAllowed).toBeUndefined()
  })

  it('refuses overwrite when the cyclelist cannot express both states', () => {
    const options = buildOnboardOptions({
      status,
      cfg: RECORD_CFG,
      limits: { ...LIMITS_592, cycleList: [1] },
      schedule: SCHEDULE_592,
    })
    expect(options.overwriteWhenFull.writable).toBe(false)
    expect(options.overwriteWhenFull.reason).toContain('1')
  })

  it('declares the HOUR granularity its mask really has', () => {
    expect(options592.schedule.granularityMinutes).toBe(60)
    expect(options592.schedule.supportsOverlappingTriggers).toBe(true)
  })

  it('offers the object-class triggers Hikvision has no idea about', () => {
    expect(options592.schedule.triggers).toContain('person')
    expect(options592.schedule.triggers).toContain('loitering')
  })

  it('says "not read yet" rather than "unsupported" before the camera answers', () => {
    const options = buildOnboardOptions({ status: null, cfg: null, limits: null, schedule: null })
    expect(options.enabled.readable).toBe(false)
    expect(options.enabled.writable).toBe(false)
    expect(options.enabled.reason).toContain('has not read this camera yet')
  })

  it('stays shut when the status arrived but the LIMITS read did not', () => {
    // A limit we failed to read is not a limit of none: opening the
    // controls here would offer values the camera answers 200 to and
    // discards.
    const options = buildOnboardOptions({
      status,
      cfg: RECORD_CFG,
      limits: null,
      schedule: SCHEDULE_592,
    })
    expect(options.overwriteWhenFull.writable).toBe(false)
    expect(options.schedule.support.writable).toBe(false)
  })
})

describe('buildOnboardWrites — one cap patch, two Baichuan documents', () => {
  it('collapses pre-record to the boolean the firmware really has', () => {
    expect(buildOnboardWrites({ preRecordSec: 0 }, SCHEDULE_592).cfg).toEqual({
      preRecordEnabled: false,
    })
    // 5, 15 and 30 all store as 10, so any non-zero ask is "on".
    expect(buildOnboardWrites({ preRecordSec: 5 }, SCHEDULE_592).cfg).toEqual({
      preRecordEnabled: true,
    })
  })

  it('maps overwrite onto cycle and post-record onto recordDelayTime', () => {
    expect(
      buildOnboardWrites({ overwriteWhenFull: false, postRecordSec: 30 }, SCHEDULE_592).cfg,
    ).toEqual({ cycle: 0, recordDelayTime: 30 })
  })

  it('sends NO cfg document when the patch touches only the schedule', () => {
    const writes = buildOnboardWrites({ enabled: false }, SCHEDULE_592)
    expect(writes.cfg).toBeNull()
    expect(writes.schedule).toEqual({ enable: false })
  })

  it('writes a row for every trigger the camera lists, including the ones now EMPTY', () => {
    // `windows` is the complete new set. A trigger the operator removed
    // must be written all-zero, or the camera keeps recording on it.
    const writes = buildOnboardWrites(
      { windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 60 }] },
      SCHEDULE_592,
    )
    const entries = writes.schedule?.entries ?? []
    expect(entries.map((e) => e.type).sort()).toEqual(
      ['MD', 'Normal', 'dog_cat', 'people', 'vehicle'].sort(),
    )
    const md = entries.find((e) => e.type === 'MD')
    expect(md?.valueTable[0]).toBe('1')
    expect(md?.valueTable.slice(1)).toBe('0'.repeat(167))
    for (const entry of entries.filter((e) => e.type !== 'MD')) {
      expect(entry.valueTable).toBe('0'.repeat(168))
    }
  })

  it('never invents a row the camera does not already have', () => {
    // Measured: appending `<type>bogus</type>` was answered 200 and
    // discarded. A row for a trigger this camera never listed would
    // report success for nothing.
    const writes = buildOnboardWrites(
      { windows: [{ trigger: 'lineCrossing', day: 0, startMinute: 0, endMinute: 60 }] },
      SCHEDULE_592,
    )
    expect(writes.schedule?.entries?.some((e) => e.type === 'crossline')).toBe(false)
  })

  it('asks for nothing when the patch asks for nothing', () => {
    expect(buildOnboardWrites({}, SCHEDULE_592)).toEqual({ cfg: null, schedule: null })
  })
})
