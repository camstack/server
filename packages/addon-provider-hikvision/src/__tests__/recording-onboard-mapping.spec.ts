/**
 * Hikvision → `recording-onboard`, against bytes the cameras actually
 * served.
 *
 * Every fixture in `fixtures/` was fetched read-only on 2026-09-22 from
 * the live fleet: 1436 and 3833 (I91DN, V5.7.1) and 1441 (I91EV,
 * V5.8.10). Nothing here is hand-written XML, because three of the four
 * rules this parser exists for are things the firmware does that its own
 * documentation says it does not:
 *
 *   - it spells the start and the end of the same block two different
 *     ways (`00:00:00` and `24:00`);
 *   - it serves more than one track, with different schedules and
 *     different `LoopEnable`, on a camera an earlier survey recorded as
 *     having one;
 *   - it declares a frame rate that is off by a factor of five.
 *
 * A synthetic fixture would have proved the parser against the parser's
 * own assumptions.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyOnboardPatchToTrackXml,
  buildOnboardOptions,
  buildOnboardStatus,
  parseOnboardStorage,
  parseRecordTracks,
  pickPrimaryTrack,
} from '../recording-onboard-mapping.js'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const STORAGE_1436 = read('storage-1436.xml')
const STORAGE_1441 = read('storage-1441-no-card.xml')
const TRACKS_1436 = read('record-tracks-1436.xml')
const TRACKS_3833 = read('record-tracks-3833.xml')

describe('ContentMgmt/Storage', () => {
  it('reads the card 1436 reports, capacity and free space verbatim', () => {
    expect(STORAGE_1436).toContain('<capacity>238800</capacity>')
    const storage = parseOnboardStorage(STORAGE_1436)
    expect(storage).toEqual({
      kind: 'present',
      volumes: [
        {
          id: '1',
          status: 'ok',
          capacityMb: 238800,
          freeMb: 11776,
          label: 'hdde',
          writable: true,
        },
      ],
    })
  })

  it('reads 1441 — a camera with no card at all — as ABSENT, with a reason', () => {
    expect(STORAGE_1441).toContain('<hddList')
    expect(STORAGE_1441).not.toContain('<hdd ')
    const storage = parseOnboardStorage(STORAGE_1441)
    expect(storage.kind).toBe('absent')
    if (storage.kind === 'absent') expect(storage.reason).toContain('empty hddList')
  })

  it('never reports an unstated capacity as zero', () => {
    const storage = parseOnboardStorage(
      '<storage><hddList><hdd><id>1</id><status>ok</status></hdd></hddList></storage>',
    )
    expect(storage.kind).toBe('present')
    if (storage.kind === 'present') {
      expect(storage.volumes[0]?.capacityMb).toBeNull()
      expect(storage.volumes[0]?.freeMb).toBeNull()
    }
  })

  it('reports a card the camera calls unusable as absent, naming its state', () => {
    const storage = parseOnboardStorage(
      '<storage><hddList><hdd><id>1</id><status>unformatted</status><capacity>1</capacity></hdd></hddList></storage>',
    )
    expect(storage.kind).toBe('absent')
    if (storage.kind === 'absent') expect(storage.reason).toContain('unformatted')
  })
})

describe('ContentMgmt/record/tracks — 1436', () => {
  const tracks = parseRecordTracks(TRACKS_1436)

  it('finds BOTH tracks the camera lists, not the first one', () => {
    expect(tracks.map((entry) => entry.track.id)).toEqual(['101', '103'])
  })

  it('reads the per-track overwrite flag, which differs between them', () => {
    expect(TRACKS_1436).toContain('<LoopEnable>true</LoopEnable>')
    expect(TRACKS_1436).toContain('<LoopEnable>false</LoopEnable>')
    expect(tracks[0]?.track.overwriteWhenFull).toBe(true)
    expect(tracks[1]?.track.overwriteWhenFull).toBe(false)
  })

  it('takes codec and resolution from the description, and NEVER the frame rate', () => {
    expect(TRACKS_1436).toContain('framerate=2.260000 fps')
    expect(tracks[0]?.track).toMatchObject({ codec: 'H.265', resolution: '3840x2160' })
    expect(JSON.stringify(tracks[0]?.track)).not.toContain('2.26')
  })

  it('reads all seven weekday windows of track 101 as WHOLE days', () => {
    expect(TRACKS_1436).toContain('<TimeOfDay>00:00:00</TimeOfDay>')
    expect(TRACKS_1436).toContain('<TimeOfDay>24:00</TimeOfDay>')
    const windows = tracks[0]?.windows ?? []
    expect(windows).toHaveLength(7)
    for (const window of windows) {
      expect(window).toMatchObject({ trigger: 'motion', startMinute: 0, endMinute: 1440 })
    }
    expect(windows.map((w) => w.day)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('reads track 103, whose windows are NOT hour-aligned and are continuous', () => {
    expect(TRACKS_1436).toContain('<TimeOfDay>00:05:00</TimeOfDay>')
    const windows = tracks[1]?.windows ?? []
    expect(windows).toHaveLength(7)
    expect(windows[0]).toEqual({
      trigger: 'continuous',
      day: 0,
      startMinute: 5,
      endMinute: 1437,
    })
  })

  it('reads the pre/post-record seconds out of the CustomExtension block', () => {
    expect(tracks[0]).toMatchObject({ preRecordSec: 10, postRecordSec: 10, scheduleActive: true })
  })

  it('leaves nothing unread — the count is the honest zero, not an assumed one', () => {
    expect(tracks[0]?.unreadableWindows).toBe(0)
    expect(tracks[1]?.unreadableWindows).toBe(0)
  })

  it('counts a window whose trigger it does not know, rather than dropping it', () => {
    const withUnknown = TRACKS_1436.replace(
      '<ActionRecordingMode>MOTION</ActionRecordingMode>',
      '<ActionRecordingMode>SOMETHING_NEW</ActionRecordingMode>',
    )
    const parsed = parseRecordTracks(withUnknown)
    expect(parsed[0]?.windows).toHaveLength(6)
    expect(parsed[0]?.unreadableWindows).toBe(1)
  })
})

describe('ContentMgmt/record/tracks — 3833, the same model, the same shape', () => {
  const tracks = parseRecordTracks(TRACKS_3833)

  it('also lists two tracks', () => {
    expect(tracks.map((entry) => entry.track.id)).toEqual(['101', '103'])
  })

  it('picks the enabled video track, never index 0 by position', () => {
    expect(pickPrimaryTrack(tracks)?.track.id).toBe('101')
  })

  it('picks nothing at all rather than guessing when no track carries video', () => {
    const noVideo = TRACKS_3833.replaceAll('trackType=video', 'trackType=audio')
    expect(pickPrimaryTrack(parseRecordTracks(noVideo))).toBeNull()
  })
})

describe('buildOnboardStatus', () => {
  it('folds 1436 into one honest picture', () => {
    const status = buildOnboardStatus({
      storage: parseOnboardStorage(STORAGE_1436),
      tracks: parseRecordTracks(TRACKS_1436),
      now: 1_700_000_000_000,
    })
    expect(status).toMatchObject({
      primaryTrackId: '101',
      enabled: true,
      overwriteWhenFull: true,
      preRecordSec: 10,
      postRecordSec: 10,
      segmentMinutes: null,
      unreadableWindows: 0,
      recordingToNowhere: false,
      lastFetchedAt: 1_700_000_000_000,
    })
    expect(status.tracks).toHaveLength(2)
    expect(status.windows).toHaveLength(7)
  })

  it('flags a camera scheduled to record onto a card that is not there', () => {
    const status = buildOnboardStatus({
      storage: parseOnboardStorage(STORAGE_1441),
      tracks: parseRecordTracks(TRACKS_1436),
      now: 1,
    })
    expect(status.recordingToNowhere).toBe(true)
  })

  it('does NOT flag a camera with no card that is also not scheduled', () => {
    const idle = TRACKS_1436.replaceAll(
      '<enableSchedule>true</enableSchedule>',
      '<enableSchedule>false</enableSchedule>',
    )
    const status = buildOnboardStatus({
      storage: parseOnboardStorage(STORAGE_1441),
      tracks: parseRecordTracks(idle),
      now: 1,
    })
    expect(status.enabled).toBe(false)
    expect(status.recordingToNowhere).toBe(false)
  })

  it('does not flag a camera whose storage we merely FAILED to read', () => {
    const status = buildOnboardStatus({
      storage: { kind: 'unknown', reason: 'connect ETIMEDOUT' },
      tracks: parseRecordTracks(TRACKS_1436),
      now: 1,
    })
    expect(status.recordingToNowhere).toBe(false)
  })
})

describe('buildOnboardOptions — every field exists, and each false says why', () => {
  const status = buildOnboardStatus({
    storage: parseOnboardStorage(STORAGE_1436),
    tracks: parseRecordTracks(TRACKS_1436),
    now: 1,
  })

  it('offers the writable fields when writes are enabled', () => {
    const options = buildOnboardOptions({
      status,
      writesEnabled: true,
      writeBlockedReason: 'unused',
    })
    expect(options.enabled).toEqual({ readable: true, writable: true })
    expect(options.schedule.support).toEqual({ readable: true, writable: true })
    expect(options.schedule.granularityMinutes).toBe(1)
    expect(options.schedule.supportsOverlappingTriggers).toBe(false)
  })

  it('offers the pre-record values the camera MEASURABLY takes, no-limit included', () => {
    // The camera will not declare this: its own `/capabilities` returns
    // `PreRecordTimeSeconds` bare, where a constrained field carries `opt=`.
    // So it was written and read back, one value at a time, on 1436.
    //
    // Kept: 0, 5, 10, 15, 20, 25, 30, 2147483647. Everything else — 1, 2, 3,
    // 4, 6, 8, 35, 40, 45, 50, 60, 65535 — answers 200/OK and stores 5.
    //
    // My first pass called this `step: 5` and it was wrong: the operator read
    // his own camera's UI and it offers a "no limit" I had not found, which
    // is INT32_MAX and two billion away from its neighbour. No step can say
    // that, which is why the descriptor is a SET.
    const options = buildOnboardOptions({
      status,
      writesEnabled: true,
      writeBlockedReason: 'unused',
    })
    expect(options.preRecordSecAllowed).toEqual({
      values: [0, 5, 10, 15, 20, 25, 30, 2147483647],
      sentinel: { value: 2147483647, meaning: 'no-limit' },
    })
  })

  it('offers the post-record values it takes — which a range cannot express', () => {
    // 5, 10, 30, then one, two, five and ten minutes. The set doubles and
    // then jumps. `{min: 0, max: 60, step: 1}` was wrong in BOTH directions:
    // it forbade the four values above 60 that the camera takes, and
    // permitted the ones below 5 that it silently replaces with 5.
    const options = buildOnboardOptions({
      status,
      writesEnabled: true,
      writeBlockedReason: 'unused',
    })
    expect(options.postRecordSecAllowed).toEqual({ values: [5, 10, 30, 60, 120, 300, 600] })
  })

  it('reports file length unwritable with the firmware reason, never absent', () => {
    const options = buildOnboardOptions({
      status,
      writesEnabled: true,
      writeBlockedReason: 'unused',
    })
    expect(options.segmentMinutes.writable).toBe(false)
    expect(options.segmentMinutes.reason).toContain('ContentMgmt')
  })

  it('carries the block reason onto every field when writes are off', () => {
    const options = buildOnboardOptions({
      status,
      writesEnabled: false,
      writeBlockedReason: 'the camera has not been verified to accept this write',
    })
    expect(options.enabled.reason).toContain('not been verified')
    expect(options.schedule.support.reason).toContain('not been verified')
    // Still readable — read and write are separate facts.
    expect(options.enabled.readable).toBe(true)
  })

  it('refuses the SCHEDULE specifically when some of it could not be read', () => {
    const partial = { ...status, unreadableWindows: 1 }
    const options = buildOnboardOptions({
      status: partial,
      writesEnabled: true,
      writeBlockedReason: 'unused',
    })
    expect(options.schedule.support.writable).toBe(false)
    expect(options.schedule.support.reason).toContain('could not read every window')
    // …but the scalars are untouched by that.
    expect(options.enabled.writable).toBe(true)
  })

  it('says "not read yet" rather than "unsupported" for a camera never reached', () => {
    const options = buildOnboardOptions({
      status: null,
      writesEnabled: true,
      writeBlockedReason: 'unused',
    })
    expect(options.enabled.readable).toBe(false)
    expect(options.enabled.reason).toContain('has not read this camera yet')
  })
})

describe('applyOnboardPatchToTrackXml — bytes to PUT back to the camera', () => {
  const TRACK_101 = read('record-track-101-1436.xml')

  it('changes NOTHING when the patch is empty', () => {
    const out = applyOnboardPatchToTrackXml(TRACK_101, {})
    expect(out.xml).toBe(TRACK_101)
    expect(out.changed).toBe(false)
    expect(out.missingTags).toEqual([])
  })

  it('splices a scalar and leaves the rest of the document byte-identical', () => {
    const out = applyOnboardPatchToTrackXml(TRACK_101, { preRecordSec: 25 })
    expect(out.xml).toContain('<PreRecordTimeSeconds>25</PreRecordTimeSeconds>')
    expect(out.changed).toBe(true)
    expect(out.xml.replace('>25<', '>10<')).toBe(TRACK_101)
  })

  it('writes BOTH halves of the master switch, never one', () => {
    const out = applyOnboardPatchToTrackXml(TRACK_101, { enabled: false })
    expect(out.xml).toContain('<Enable>false</Enable>')
    expect(out.xml).toContain('<enableSchedule>false</enableSchedule>')
  })

  it('does not invent a tag the camera never sent — it reports it instead', () => {
    const stripped = TRACK_101.replace(
      /<PreRecordTimeSeconds>[\s\S]*?<\/PreRecordTimeSeconds>\n?/,
      '',
    )
    const out = applyOnboardPatchToTrackXml(stripped, { preRecordSec: 25 })
    expect(out.xml).not.toContain('PreRecordTimeSeconds')
    expect(out.missingTags).toEqual(['pre-record seconds'])
    expect(out.changed).toBe(false)
  })

  it('replaces the WHOLE schedule and round-trips through its own reader', () => {
    const windows = [
      { trigger: 'continuous' as const, day: 0, startMinute: 0, endMinute: 1440 },
      { trigger: 'motion' as const, day: 5, startMinute: 390, endMinute: 1080 },
    ]
    const out = applyOnboardPatchToTrackXml(TRACK_101, { windows })
    const reread = parseRecordTracks(out.xml)[0]
    expect(reread?.windows).toEqual(windows)
    expect(reread?.unreadableWindows).toBe(0)
  })

  it('writes end-of-day the way THIS firmware writes it', () => {
    const out = applyOnboardPatchToTrackXml(TRACK_101, {
      windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 }],
    })
    expect(out.xml).toContain('<TimeOfDay>24:00</TimeOfDay>')
    expect(out.xml).not.toContain('<TimeOfDay>24:00:00</TimeOfDay>')
    expect(out.xml).toContain('<TimeOfDay>00:00:00</TimeOfDay>')
  })

  it('drops the seven old actions rather than appending to them', () => {
    const before = (TRACK_101.match(/<ScheduleAction>/g) ?? []).length
    expect(before).toBe(7)
    const out = applyOnboardPatchToTrackXml(TRACK_101, {
      windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 }],
    })
    expect((out.xml.match(/<ScheduleAction>/g) ?? []).length).toBe(1)
  })

  it('updates the count the camera states next to the list it states it about', () => {
    expect(TRACK_101).toContain('ScheduleActionSize="8"')
    const out = applyOnboardPatchToTrackXml(TRACK_101, {
      windows: [
        { trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 },
        { trigger: 'motion', day: 1, startMinute: 0, endMinute: 1440 },
      ],
    })
    expect(out.xml).toContain('ScheduleActionSize="2"')
  })

  it('leaves the track identity, source descriptor and codec untouched', () => {
    const out = applyOnboardPatchToTrackXml(TRACK_101, {
      windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 }],
      overwriteWhenFull: false,
    })
    expect(out.xml).toContain('<TrackGUID>e32e6863-ea5e-4ee4-997e-040312b09786</TrackGUID>')
    expect(out.xml).toContain('<SrcUrl>rtsp://localhost/ISAPI/Streaming/channels/101</SrcUrl>')
    expect(out.xml).toContain('codecType=H.265')
    expect(out.xml).toContain('<LoopEnable>false</LoopEnable>')
  })
})
