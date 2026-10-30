/**
 * Hikvision → the vendor-neutral `recording-onboard` cap.
 *
 * Pure. Takes the two XML bodies the camera serves — `ContentMgmt/Storage`
 * and `ContentMgmt/record/tracks` — and produces the cap's status and
 * options. No I/O, no clock of its own (`now` is passed in).
 *
 * Parsed with regex, namespace-agnostically, like the rest of this addon:
 * these payloads are small flat XML and the firmware emits a `hikvision:`
 * prefix on some of them.
 *
 * Three things measured on 2026-09-22 that this module exists to get right:
 *
 *   - **The clock is spelled two ways in one block.** 1436 track 101
 *     starts at `00:00:00` and ends at `24:00`. A parser that handles
 *     only `HH:MM:SS` reads every whole-day window as ending at midnight,
 *     i.e. as empty.
 *   - **There is more than one track, and they disagree.** 1436 AND 3833
 *     both list 101 and 103, with different schedules and different
 *     `LoopEnable`. Reporting one number for "the schedule" would be
 *     wrong on every Hikvision in the fleet.
 *   - **`framerate` in the track description LIES** (declared 2.26 fps,
 *     measured 12.55). `codecType` and `resolution` from the same string
 *     are right. Only those two are read.
 */
import type {
  OnboardRecordTrack,
  OnboardStorage,
  OnboardStorageVolume,
  RecordingOnboardOptions,
  RecordingOnboardStatus,
  RecordTrigger,
  RecordWindow,
} from '@camstack/types'
import {
  DAY_NAMES,
  dayOfWeekToIndex,
  minutesToTimeOfDay,
  timeOfDayToMinutes,
} from '@camstack/types'

/** Read one tag's text, ignoring attributes and any namespace prefix. */
function tagOf(xml: string, tag: string): string | undefined {
  return new RegExp(`<(?:[\\w.-]+:)?${tag}[^>]*>([^<]*)</`, 'i').exec(xml)?.[1]?.trim()
}

/** Every `<tag>…</tag>` block, whole, in document order. */
function blocksOf(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}[\\s>][\\s\\S]*?</(?:[\\w.-]+:)?${tag}>`, 'gi')
  return [...xml.matchAll(pattern)].map((match) => match[0])
}

/**
 * A number the camera stated, or null when it did not state one.
 *
 * Never 0 for a missing or unparseable value: a measurement that failed
 * is not a measurement (D393), and a card of unknown size must not be
 * reported as a card of size zero.
 */
function numberOf(xml: string, tag: string): number | null {
  const raw = tagOf(xml, tag)
  if (raw === undefined || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

// ── Storage ──────────────────────────────────────────────────────────

const VOLUME_STATUS: Readonly<Record<string, OnboardStorageVolume['status']>> = {
  ok: 'ok',
  unformatted: 'unformatted',
  error: 'error',
  offline: 'offline',
  idle: 'ok',
}

/**
 * Read `/ISAPI/ContentMgmt/Storage`.
 *
 * Returns EVERY row, not the first usable one — an operator asking
 * "what is in this camera" is owed the camera's whole answer, including
 * a second card that is failing. `present` means at least one row the
 * camera calls usable.
 *
 * An empty `<hddList>` is `absent` — measured on 1441 and 3831, both of
 * which are scheduled to record. An unreadable body is `unknown`, never
 * folded into `absent`.
 */
export function parseOnboardStorage(xml: string): OnboardStorage {
  const rows = blocksOf(xml, 'hdd')
  if (rows.length === 0) {
    return { kind: 'absent', reason: 'The camera reports no storage device (empty hddList).' }
  }

  const volumes: OnboardStorageVolume[] = rows.map((row, index) => {
    const rawStatus = (tagOf(row, 'status') ?? '').toLowerCase()
    const label = tagOf(row, 'hddName')
    const property = (tagOf(row, 'property') ?? '').toUpperCase()
    const volume: OnboardStorageVolume = {
      id: tagOf(row, 'id') ?? String(index),
      status: VOLUME_STATUS[rawStatus] ?? 'unknown',
      capacityMb: numberOf(row, 'capacity'),
      freeMb: numberOf(row, 'freeSpace'),
    }
    return {
      ...volume,
      ...(label !== undefined && label !== '' ? { label } : {}),
      ...(property !== '' ? { writable: property.includes('W') } : {}),
    }
  })

  if (volumes.some((volume) => volume.status === 'ok')) return { kind: 'present', volumes }

  const states = volumes.map((volume) => volume.status).join(', ')
  return {
    kind: 'absent',
    reason: `The camera reports ${String(volumes.length)} storage device(s), none of them usable (${states}).`,
  }
}

// ── Tracks ───────────────────────────────────────────────────────────

/**
 * Hikvision's `ActionRecordingMode` → the cap's trigger vocabulary.
 *
 * Only the modes the fleet actually emits are mapped. Anything else is
 * COUNTED as unreadable rather than guessed at — a window mapped to the
 * wrong trigger is worse than a window reported as unread.
 */
const TRIGGER_BY_MODE: Readonly<Record<string, RecordTrigger | undefined>> = {
  CMR: 'continuous',
  MOTION: 'motion',
  ALARM: 'alarmInput',
}

/** The cap's trigger → the mode string to write back. */
export const MODE_BY_TRIGGER: Readonly<Partial<Record<RecordTrigger, string>>> = {
  continuous: 'CMR',
  motion: 'MOTION',
  alarmInput: 'ALARM',
}

/** Triggers a Hikvision camera can be asked to record on. */
export const HIKVISION_TRIGGERS: readonly RecordTrigger[] = ['continuous', 'motion', 'alarmInput']

/** One track, with everything the cap needs from it. */
export interface HikvisionTrackInfo {
  readonly track: OnboardRecordTrack
  /** True when the track is enabled AND its schedule is switched on. */
  readonly scheduleActive: boolean
  readonly windows: readonly RecordWindow[]
  /** Windows the camera described that could not be read. */
  readonly unreadableWindows: number
  readonly preRecordSec: number | null
  readonly postRecordSec: number | null
}

function parseWindows(trackXml: string): {
  windows: RecordWindow[]
  unreadable: number
} {
  const windows: RecordWindow[] = []
  let unreadable = 0

  for (const action of blocksOf(trackXml, 'ScheduleAction')) {
    const startBlock = blocksOf(action, 'ScheduleActionStartTime')[0]
    const endBlock = blocksOf(action, 'ScheduleActionEndTime')[0]
    const actions = blocksOf(action, 'Actions')[0]
    if (!startBlock || !endBlock || !actions) {
      unreadable += 1
      continue
    }

    // `<Record>false</Record>` is a window the camera keeps but does not
    // act on. It is not unreadable — it is simply not a recording window.
    if ((tagOf(actions, 'Record') ?? '').toLowerCase() === 'false') continue

    const mode = tagOf(actions, 'ActionRecordingMode') ?? ''
    const trigger = TRIGGER_BY_MODE[mode.toUpperCase()]
    const day = dayOfWeekToIndex(tagOf(startBlock, 'DayOfWeek') ?? '')
    const startMinute = timeOfDayToMinutes(tagOf(startBlock, 'TimeOfDay') ?? '')
    const endMinute = timeOfDayToMinutes(tagOf(endBlock, 'TimeOfDay') ?? '')

    if (
      trigger === undefined ||
      day === null ||
      startMinute === null ||
      endMinute === null ||
      endMinute <= startMinute
    ) {
      unreadable += 1
      continue
    }
    windows.push({ trigger, day, startMinute, endMinute })
  }

  return { windows, unreadable }
}

/**
 * Read `/ISAPI/ContentMgmt/record/tracks` into one entry per track.
 *
 * `overwriteWhenFull` is per track here — measured on 1436, where 101 is
 * `true` and 103 is `false` on the same camera.
 */
export function parseRecordTracks(xml: string): HikvisionTrackInfo[] {
  const out: HikvisionTrackInfo[] = []

  for (const block of blocksOf(xml, 'Track')) {
    const id = tagOf(block, 'id')
    if (id === undefined || id === '') continue

    const description = tagOf(block, 'Description') ?? ''
    const enabled = (tagOf(block, 'Enable') ?? '').toLowerCase() === 'true'
    const loop = tagOf(block, 'LoopEnable')
    const extension = blocksOf(block, 'CustomExtension')[0] ?? ''
    const scheduleOn = (tagOf(extension, 'enableSchedule') ?? '').toLowerCase() === 'true'
    const { windows, unreadable } = parseWindows(block)

    out.push({
      track: {
        id,
        enabled,
        isVideo: /trackType=video/i.test(description),
        // `codecType` and `resolution` are honest here; `framerate` in the
        // same string is not, so it is never read.
        codec: /codecType=([^,]+)/.exec(description)?.[1]?.trim() ?? null,
        resolution: /resolution=([^,]+)/.exec(description)?.[1]?.trim() ?? null,
        overwriteWhenFull: loop === undefined ? null : loop.toLowerCase() === 'true',
      },
      scheduleActive: enabled && scheduleOn,
      windows,
      unreadableWindows: unreadable,
      preRecordSec: numberOf(extension, 'PreRecordTimeSeconds'),
      postRecordSec: numberOf(extension, 'PostRecordTimeSeconds'),
    })
  }

  return out
}

/**
 * Which track the settings below apply to.
 *
 * The enabled VIDEO one, in the camera's own order. Not "the first" —
 * 3833 lists a track carrying no picture, and taking index 0 reads the
 * schedule of something that records nothing. Null when no track
 * qualifies, which the caller reports as a refusal reason rather than
 * guessing.
 */
export function pickPrimaryTrack(tracks: readonly HikvisionTrackInfo[]): HikvisionTrackInfo | null {
  return (
    tracks.find((entry) => entry.track.enabled && entry.track.isVideo) ??
    tracks.find((entry) => entry.track.isVideo) ??
    null
  )
}

// ── Status ───────────────────────────────────────────────────────────

/**
 * Fold both reads into the cap's status.
 *
 * `recordingToNowhere` is the pair neither read can see on its own: a
 * camera whose schedule is live and whose card is gone. Measured on 1441
 * and 3831, both of which report a perfectly healthy schedule.
 */
export function buildOnboardStatus(input: {
  readonly storage: OnboardStorage
  readonly tracks: readonly HikvisionTrackInfo[]
  readonly now: number
}): RecordingOnboardStatus {
  const primary = pickPrimaryTrack(input.tracks)
  const scheduled = primary !== null && primary.scheduleActive && primary.windows.length > 0

  return {
    storage: input.storage,
    tracks: input.tracks.map((entry) => entry.track),
    primaryTrackId: primary?.track.id ?? null,
    enabled: primary === null ? null : primary.scheduleActive,
    overwriteWhenFull: primary?.track.overwriteWhenFull ?? null,
    preRecordSec: primary?.preRecordSec ?? null,
    postRecordSec: primary?.postRecordSec ?? null,
    // Not exposed anywhere in the ContentMgmt tree on V5.7.1 / V5.8.10.
    segmentMinutes: null,
    windows: [...(primary?.windows ?? [])],
    unreadableWindows: primary?.unreadableWindows ?? 0,
    recordingToNowhere: scheduled && input.storage.kind === 'absent',
    lastFetchedAt: input.now,
  }
}

// ── Options ──────────────────────────────────────────────────────────

const NOT_ON_THIS_FIRMWARE = 'the ISAPI ContentMgmt tree on this firmware exposes no such setting'

/**
 * What THIS Hikvision accepts.
 *
 * The field set never varies — that is the cap's contract. What varies
 * is `writable`, and every `false` carries the reason the UI shows next
 * to the disabled control.
 *
 * The schedule is reported unwritable while any window on the primary
 * track is unreadable: replacing a set we could only partly read would
 * delete the part we could not show (D391).
 */
/** INT32_MAX — what this firmware stores for "no limit". */
const NO_LIMIT_SECONDS = 2147483647

export function buildOnboardOptions(input: {
  readonly status: RecordingOnboardStatus | null
  readonly writesEnabled: boolean
  readonly writeBlockedReason: string
}): RecordingOnboardOptions {
  const reached = input.status !== null
  const unreached = 'CamStack has not read this camera yet'
  const writable = (allowed: boolean, reason: string): RecordingOnboardOptions['enabled'] =>
    allowed && input.writesEnabled
      ? { readable: reached, writable: true }
      : {
          readable: reached,
          writable: false,
          reason: allowed ? input.writeBlockedReason : reason,
        }

  const hasPrimary = input.status?.primaryTrackId !== null && input.status !== null
  const noPrimary = 'this camera exposes no enabled video recording track'
  const partiallyRead =
    'CamStack could not read every window this camera holds, so replacing them would delete the ones it could not show'
  const scheduleReadable = (input.status?.unreadableWindows ?? 0) === 0

  return {
    enabled: writable(hasPrimary, reached ? noPrimary : unreached),
    overwriteWhenFull: writable(hasPrimary, reached ? noPrimary : unreached),
    preRecordSec: writable(hasPrimary, reached ? noPrimary : unreached),
    // MEASURED on 1436 (I91DN, V5.7.1), 2026-09-22, because the camera will
    // not declare it: its own `/capabilities` returns `PreRecordTimeSeconds`
    // as a bare value, where a constrained field carries an `opt=` list
    // (`audioCompressionType` does, so the mechanism exists and this
    // firmware does not use it here). `/record/capabilities`,
    // `/schedule/capabilities` and `/Storage/capabilities` all 403.
    //
    // Written and read back, one value at a time. Kept: 0, 5, 10, 15, 20,
    // 25, 30 and 2147483647. Everything else — 1, 2, 3, 4, 6, 8, 35, 40, 45,
    // 50, 60, 65535 — answers `200 / statusCode 1 / OK` and stores **5**:
    // not the ask, not the previous value, not the nearest.
    //
    // `2147483647` is INT32_MAX and is the camera's "no limit" (`-1` and
    // `4294967295` both land on it). The operator's own UI offers exactly
    // this list, "niente" first and "no limit" last.
    preRecordSecAllowed: {
      values: [0, 5, 10, 15, 20, 25, 30, NO_LIMIT_SECONDS],
      sentinel: { value: NO_LIMIT_SECONDS, meaning: 'no-limit' },
    },
    postRecordSec: writable(hasPrimary, reached ? noPrimary : unreached),
    // Measured the same way, and it is why a range was the wrong shape: the
    // set doubles and then jumps (5, 10, 30, then 1, 2, 5 and 10 minutes).
    // `{min: 0, max: 60, step: 1}` was wrong in BOTH directions — it forbade
    // the four values above 60 that the camera takes, and permitted the ones
    // below 5 that it silently replaces.
    postRecordSecAllowed: { values: [5, 10, 30, 60, 120, 300, 600] },
    segmentMinutes: { readable: false, writable: false, reason: NOT_ON_THIS_FIRMWARE },
    schedule: {
      support: writable(
        hasPrimary && scheduleReadable,
        !reached ? unreached : hasPrimary ? partiallyRead : noPrimary,
      ),
      // 1436 track 103 runs 00:05:00–23:57:00, so the firmware genuinely
      // takes arbitrary minutes.
      granularityMinutes: 1,
      triggers: [...HIKVISION_TRIGGERS],
      // One `ActionRecordingMode` per `ScheduleAction`: two triggers
      // cannot cover the same minutes on one day.
      supportsOverlappingTriggers: false,
    },
  }
}

// ── Writing the track back ───────────────────────────────────────────

/**
 * Replace one tag's text inside `xml`, leaving everything else byte-identical.
 *
 * Splice, never synthesise: the camera's own tree is PUT back with only
 * the target tags changed, which is the pattern every other setter in
 * this addon uses. A tag that is not present is NOT invented — a
 * firmware that does not carry it will not learn it from us, and a PUT
 * carrying a tag the camera never sent is the shape of request these
 * cameras answer with 403.
 */
function spliceTag(xml: string, tag: string, value: string): string {
  const pattern = new RegExp(
    `(<(?:[\\w.-]+:)?${tag}[^>]*>)[\\s\\S]*?(</(?:[\\w.-]+:)?${tag}>)`,
    'i',
  )
  return pattern.test(xml) ? xml.replace(pattern, `$1${value}$2`) : xml
}

function hasTag(xml: string, tag: string): boolean {
  return new RegExp(`<(?:[\\w.-]+:)?${tag}[^>]*>`, 'i').test(xml)
}

/** Render one `<ScheduleAction>` in the shape the camera itself emits. */
function renderScheduleAction(window: RecordWindow): string {
  const day = DAY_NAMES[window.day] ?? 'Monday'
  const mode = MODE_BY_TRIGGER[window.trigger]
  return [
    '<ScheduleAction>',
    '<id>1</id>',
    '<ScheduleActionStartTime>',
    `<DayOfWeek>${day}</DayOfWeek>`,
    `<TimeOfDay>${minutesToTimeOfDay(window.startMinute)}</TimeOfDay>`,
    '</ScheduleActionStartTime>',
    '<ScheduleActionEndTime>',
    `<DayOfWeek>${day}</DayOfWeek>`,
    `<TimeOfDay>${minutesToTimeOfDay(window.endMinute)}</TimeOfDay>`,
    '</ScheduleActionEndTime>',
    '<ScheduleDSTEnable>false</ScheduleDSTEnable>',
    '<Description>nothing</Description>',
    '<Actions>',
    '<Record>true</Record>',
    `<ActionRecordingMode>${mode ?? 'CMR'}</ActionRecordingMode>`,
    '</Actions>',
    '</ScheduleAction>',
  ].join('\n')
}

/** What a patch could not be applied to. Empty means it applied whole. */
export interface TrackPatchOutcome {
  readonly xml: string
  /** Fields the track XML carries no tag for, so nothing was written. */
  readonly missingTags: readonly string[]
  /** True when at least one tag was changed. */
  readonly changed: boolean
}

/**
 * Apply the cap's patch to ONE track's XML, ready to PUT back to
 * `/ISAPI/ContentMgmt/record/tracks/<id>`.
 *
 * Pure: it produces bytes, it does not send them. What it refuses to do
 * is quietly succeed — a field whose tag the camera never sent is
 * reported in `missingTags` so the caller can refuse by name instead of
 * PUTting an unchanged document and reporting success.
 *
 * The schedule is replaced WHOLE, because that is what the cap's
 * `windows` means: a complete set, not a delta. Every action is rendered
 * in the camera's own spelling, including `24:00` for end-of-day, which
 * is how this firmware writes it.
 */
export function applyOnboardPatchToTrackXml(
  xml: string,
  patch: {
    readonly enabled?: boolean
    readonly overwriteWhenFull?: boolean
    readonly preRecordSec?: number
    readonly postRecordSec?: number
    readonly windows?: readonly RecordWindow[]
  },
): TrackPatchOutcome {
  let out = xml
  const missing: string[] = []
  let changed = false

  const scalar = (value: string | undefined, tag: string, label: string): void => {
    if (value === undefined) return
    if (!hasTag(out, tag)) {
      missing.push(label)
      return
    }
    out = spliceTag(out, tag, value)
    changed = true
  }

  if (patch.enabled !== undefined) {
    const flag = patch.enabled ? 'true' : 'false'
    scalar(flag, 'Enable', 'the master recording switch')
    // The schedule switch lives in the CustomExtension block and is the
    // half that actually stops a scheduled recording; writing one
    // without the other leaves the camera in a state neither flag
    // describes.
    scalar(flag, 'enableSchedule', 'the master recording switch')
  }
  if (patch.overwriteWhenFull !== undefined) {
    scalar(patch.overwriteWhenFull ? 'true' : 'false', 'LoopEnable', 'overwrite-when-full')
  }
  if (patch.preRecordSec !== undefined) {
    scalar(String(Math.round(patch.preRecordSec)), 'PreRecordTimeSeconds', 'pre-record seconds')
  }
  if (patch.postRecordSec !== undefined) {
    scalar(String(Math.round(patch.postRecordSec)), 'PostRecordTimeSeconds', 'post-record seconds')
  }

  if (patch.windows !== undefined) {
    const block = blocksOf(out, 'ScheduleBlock')[0]
    if (!block) {
      missing.push('the recording schedule')
    } else {
      const actions = blocksOf(block, 'ScheduleAction')
      const rendered = patch.windows.map(renderScheduleAction).join('\n')
      let next = block
      if (actions.length > 0) {
        // Replace the first action with the whole new list, drop the rest.
        next = next.replace(actions[0] ?? '', rendered)
        for (const action of actions.slice(1)) next = next.replace(action, '')
      } else {
        next = next.replace('</ScheduleBlock>', `${rendered}\n</ScheduleBlock>`)
      }
      // The camera states how many actions the block holds; a stale
      // count next to a new list is a document that contradicts itself.
      next = next.replace(
        /ScheduleActionSize="\d+"/i,
        `ScheduleActionSize="${String(patch.windows.length)}"`,
      )
      out = out.replace(block, next)
      changed = true
    }
  }

  return { xml: out, missingTags: missing, changed }
}
