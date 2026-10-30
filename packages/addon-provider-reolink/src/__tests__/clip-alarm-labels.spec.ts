/**
 * The LABEL source for a day whose files carry no class of their own.
 *
 * `FileInfoList` is the catalog on every topology (D565). On a standalone the
 * file's own `recordType` CSV already carries the class and costs nothing —
 * measured 2026-09-19 on 592: 546 files, `md 498 / dog_cat 118 / people 108 /
 * sched 40`. On a HUB CHILD the same field is `none` on every row (measured
 * 2026-09-16 on 3628: `{"none": 20}`; 2026-09-09: `{"none": 28}`), so the
 * class has to come from somewhere, and `findAlarmVideo` (272/273/274) is
 * where it lives.
 *
 * ## The join key is the file's START STAMP, not its name
 *
 * D555 said the two surfaces "join on `<name>`", and a literal join on what
 * the library hands back scores **0 of 539**: `RecordingFile.fileName` is the
 * full `<Id>` path (`/mnt/sda/Mp4Record/2026-09-19/RecS03_DST20260919_000145…`)
 * while an `AlarmVideoWindow.fileName` is the short `01` + `YYYYMMDDHHMMSS`
 * form (`0120260919000145`). The 14-digit tail is the file's start in the
 * CAMERA's wall clock, and that is the key that really joins. Measured
 * 2026-09-20:
 *
 * | camera / day | `streamType` | names | match a SUB start | a MAIN start |
 * | --- | --- | --- | --- | --- |
 * | 592 / 09-19 | 0 | 539 | 205 | **539** |
 * | 592 / 09-19 | 1 | 539 | **539** | 205 |
 * | 3628 / 09-16 | 0 | 22 | 10 | 20 |
 * | 3628 / 09-16 | 1 | 21 | **20** | 10 |
 *
 * So `streamType` really does select the FILE SET the names come from — `0`
 * the main set, `1` the sub set — exactly as nodelink-js documents and NOT as
 * D555 read it ("both returned the same 28 file names"; they overlap, they are
 * not the same). We ask for `1`, because the catalog row IS the sub file, and
 * we still try the row's MAIN twin's stamp, because one hub name of 21 matched
 * neither and a label is an upgrade rather than the catalog.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ALARM_SEARCH_SUB_FILE_SET,
  type AlarmVideoApi,
  type AlarmVideoWindowLike,
  alarmJoinKey,
  dayNeedsAlarmLabels,
  joinAlarmLabels,
  readAlarmWindows,
} from '../clips/clip-alarm-labels.js'
import type { ReolinkClipRow } from '../clips/clip-catalog.js'

const TZ = 'Europe/Rome'

const row = (over: Partial<ReolinkClipRow> = {}): ReolinkClipRow => ({
  clipKey: 'k',
  channel: 0,
  startMs: Date.parse('2026-09-16T09:21:34+02:00'),
  endMs: Date.parse('2026-09-16T09:21:50+02:00'),
  subFileName: '/mnt/sda/…/RecS04_DST20260916_092134_092150.mp4',
  supportSub: true,
  nativeTypes: ['none'],
  ...over,
})

const window_ = (fileName: string, types: readonly string[]): AlarmVideoWindowLike => ({
  fileName,
  alarmTypes: [...types],
  startTime: new Date('2026-09-16T07:21:36Z'),
  endTime: new Date('2026-09-16T07:21:44Z'),
})

describe('alarmJoinKey', () => {
  it('is the file start in the CAMERA wall clock, 14 digits', () => {
    // 09:21:34 Rome on 2026-09-16 — the tail of `0120260916092134`.
    expect(alarmJoinKey(Date.parse('2026-09-16T09:21:34+02:00'), TZ)).toBe('20260916092134')
  })

  it('is the CAMERA day, not a UTC day', () => {
    // 00:30 Rome on the 17th is 22:30 UTC on the 16th. A UTC-derived key would
    // put this file on the wrong day and join it to nothing.
    expect(alarmJoinKey(Date.parse('2026-09-17T00:30:00+02:00'), TZ)).toBe('20260917003000')
  })
})

describe('dayNeedsAlarmLabels', () => {
  it('is TRUE for a hub child day whose every file says `none`', () => {
    expect(dayNeedsAlarmLabels([row(), row({ nativeTypes: ['none'] })])).toBe(true)
  })

  it('is TRUE for files that carried no recordType at all', () => {
    expect(dayNeedsAlarmLabels([row({ nativeTypes: [] })])).toBe(true)
  })

  it('is FALSE when ANY file carries a class — the free answer wins', () => {
    // 592's own files carry `md,people` etc. Paying 8–9.5 s for 1 271 windows
    // to re-derive what is already on the row is the cheap-question rule
    // inverted (D54).
    expect(
      dayNeedsAlarmLabels([row({ nativeTypes: ['none'] }), row({ nativeTypes: ['md'] })]),
    ).toBe(false)
  })

  it('is FALSE for an empty day — there is nothing to label', () => {
    expect(dayNeedsAlarmLabels([])).toBe(false)
  })
})

type AlarmParams = Parameters<AlarmVideoApi['searchAlarmVideos']>[0]

/** A fake whose call record keeps the PARAMETER type, so the assertions below
 *  read the real shape rather than `never`. */
function alarmApi() {
  return {
    searchAlarmVideos: vi.fn(
      async (_params: AlarmParams): Promise<readonly AlarmVideoWindowLike[]> => [],
    ),
  }
}

describe('readAlarmWindows', () => {
  it('asks for the SUB file set, numerically, and never the FileInfoList string', async () => {
    // `searchAlarmVideos`'s `streamType` is a NUMBER selecting the file set;
    // `getVideoclips`'s is the string `subStream` | `mainStream`. Two
    // different things with one name — unifying them silently asks for the
    // wrong set.
    const api = alarmApi()
    await readAlarmWindows(api, { channel: 0, uid: 'U-CHILD', timeZone: TZ, day: '2026-09-16' })
    const sent = api.searchAlarmVideos.mock.calls[0]?.[0]
    expect(sent?.streamType).toBe(ALARM_SEARCH_SUB_FILE_SET)
    expect(sent?.streamType).toBe(1)
    expect(sent?.uid).toBe('U-CHILD')
  })

  it('asks for ONE camera-local day, because the firmware clamps to one anyway', async () => {
    // Measured: an 18→19 September ask answered 462 windows all dated the
    // 18th. The caller owns the iteration; this asks for the day it was given.
    const api = alarmApi()
    await readAlarmWindows(api, { channel: 0, uid: undefined, timeZone: TZ, day: '2026-09-16' })
    const sent = api.searchAlarmVideos.mock.calls[0]?.[0]
    expect(sent?.start.getTime()).toBe(Date.parse('2026-09-16T00:00:00+02:00'))
    // The SAME `dayBounds` the file listing uses — one day boundary, one
    // authority. A second spelling here would list one window and label
    // another.
    expect(sent?.end.getTime()).toBe(Date.parse('2026-09-17T00:00:00+02:00'))
    expect(sent?.uid).toBeUndefined()
  })
})

describe('joinAlarmLabels', () => {
  it('labels a classless file from the window that names its SUB start', () => {
    const rows = [row()]
    const joined = joinAlarmLabels(rows, [window_('0120260916092134', ['people'])], TZ)
    expect(joined.rows[0]?.nativeTypes).toEqual(['people'])
    expect(joined.matched).toBe(1)
  })

  it('also joins a window that names the MAIN twin instead', () => {
    // On 3628, 20 of 21 sub-set names matched a sub start and 10 matched a
    // main start; which set a firmware answers from is not a constant.
    const rows = [
      row({
        mainFileName: '/mnt/sda/…/RecM04.mp4',
        mainStartMs: Date.parse('2026-09-16T09:21:36+02:00'),
      }),
    ]
    const joined = joinAlarmLabels(rows, [window_('0120260916092136', ['dog_cat'])], TZ)
    expect(joined.rows[0]?.nativeTypes).toEqual(['dog_cat'])
  })

  it('unions every window of one file, in wire order, without duplicates', () => {
    // A file holds 1–13 windows (measured 1 271 windows over 539 files).
    const joined = joinAlarmLabels(
      [row()],
      [
        window_('0120260916092134', ['people']),
        window_('0120260916092134', ['md', 'people']),
        window_('0120260916092134', ['dog_cat']),
      ],
      TZ,
    )
    expect(joined.rows[0]?.nativeTypes).toEqual(['people', 'md', 'dog_cat'])
  })

  it('LEAVES a row the camera already classed alone', () => {
    // The file's own `recordType` is the authority where it exists; an alarm
    // window must not overwrite it with a narrower per-window answer.
    const joined = joinAlarmLabels(
      [row({ nativeTypes: ['md', 'people'] })],
      [window_('0120260916092134', ['dog_cat'])],
      TZ,
    )
    expect(joined.rows[0]?.nativeTypes).toEqual(['md', 'people'])
  })

  it('leaves an unmatched row EXACTLY as it was, and counts the misses', () => {
    // One hub name of 21 matched no file. An unmatched window contributes no
    // label; it never gets attached to a neighbouring file.
    const joined = joinAlarmLabels([row()], [window_('0120260916235959', ['people'])], TZ)
    expect(joined.rows[0]?.nativeTypes).toEqual(['none'])
    expect(joined.matched).toBe(0)
    expect(joined.unmatchedWindows).toBe(1)
  })

  it('returns NEW rows and mutates nothing', () => {
    const rows = [row()]
    const joined = joinAlarmLabels(rows, [window_('0120260916092134', ['people'])], TZ)
    expect(rows[0]?.nativeTypes).toEqual(['none'])
    expect(joined.rows[0]).not.toBe(rows[0])
  })
})
