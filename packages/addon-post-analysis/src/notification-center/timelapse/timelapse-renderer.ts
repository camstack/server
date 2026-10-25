/**
 * TimelapseRenderer — turn ONE closed window on ONE camera into ONE export.
 *
 * It renders nothing itself. `recordingExport.createExport` already runs on
 * the node that owns the footage, already builds a source playlist across
 * segments, already drives ffmpeg, already bounds the file's life and already
 * serves a download. Building a second renderer inside the notification centre
 * would mean a second retention policy, a second ffmpeg supervision path and a
 * second way for a timelapse to be wrong.
 *
 * What this module owns is the DECISION: which profile, which cadence, and
 * which seconds deserve the fast cadence — plus the honest reporting of how
 * much footage the window actually had.
 *
 * Order matters and is deliberate: the cheap question comes FIRST. A window
 * with no footage is refused before an export is queued, before tracks are
 * listed, before anything is rendered.
 *
 * Every log line here carries `tags: { deviceId }`. A miss is always asked
 * per-camera ("why is 1441 worse than 101?") and a line without the tag cannot
 * answer it.
 */

import { PRUNE_WINDOW_DEFAULT_DAYS } from '../prune-windows.js'
import type {
  ExportDense,
  ExportRecord,
  IScopedLogger,
  TimelapsePreviewMode,
} from '@camstack/types'
import { CamProfileSchema } from '@camstack/types'
import type { TimelapseArtifactSet } from './artifact-publish.js'
import { resolveDenseCadence } from './dense-cadence.js'
import {
  type DenseRangePlan,
  planDenseRanges,
  type TimelapseTrackInterval,
} from './dense-ranges.js'
import { countDetections, type DetectionCounts } from './detection-counts.js'
import { mergeDetectionIntervals, type TimelapseDetectionEvent } from './detection-intervals.js'
import {
  COVERAGE_COMPLETE_SLACK_MS,
  type FootageCoverage,
  footageCoverage,
} from './footage-coverage.js'
import { readMp4DurationMs } from './mp4-duration.js'
import { checkTimelapsePacing, type PacingVerdict } from './pacing-check.js'
import type { TimelapseArtifactRef } from './timelapse-delivery.js'
import type { ClosedWindow } from './window-bounds.js'

/** `part / whole` to two decimals — the shape a log line is read in. An empty
 *  whole is 0, never NaN: a ratio nobody can compare is not a measurement. */
function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.round((part / whole) * 100) / 100
}

/** Context seconds either side of a track inside a dense range. */
export const DENSE_PAD_SEC = 5
/**
 * How long a scheduled timelapse's file is kept by the export engine, when
 * nothing is configured.
 *
 * DERIVED from `PRUNE_WINDOW_DEFAULT_DAYS`, not restated: the authority is the
 * operator's `timelapseExportDays` and there must be exactly one number behind
 * it. Two defaults over one value is how `embeddingEnabled` came to report the
 * opposite of what the cluster was doing.
 */
export const TIMELAPSE_EXPORT_LIFE_MS = PRUNE_WINDOW_DEFAULT_DAYS.timelapseExportDays * 86_400_000
/** Poll cadence while the export renders. */
const RENDER_POLL_MS = 5_000
/** Hard bound on one render. Past this the pair stays UNSTAMPED and retries. */
export const RENDER_TIMEOUT_MS = 30 * 60_000
/** Bound on the post-render pacing check. The check is best-effort by charter:
 *  a byte read that hangs must delay delivery by at most this, never sink it. */
const PACING_CHECK_TIMEOUT_MS = 20_000
// The dense cadence itself — derivation, the explicit override and the
// `minDwellSec` guarantee — lives in `dense-cadence.ts`, which is pure and
// carries the operator's output-seconds arithmetic.

/**
 * One `recording.getAvailability` answer.
 *
 * `ranges` describes ONE band; `profilesWithFootage` names them all (D433).
 * Without the second field {@link pickProfile} is a lie: the method answers
 * for the PREFERRED profile, which is `high`, so the "take the cheapest band"
 * rule only ever saw `high` and could only ever pick it. That is what read 4K
 * off a spinning disk on 2026-09-03 and cost a power cycle (D435).
 */
export interface TimelapseAvailability {
  readonly ranges: readonly TimelapseAvailabilityRange[]
  readonly profilesWithFootage: readonly string[]
}

/** One `recording.getAvailability` row. */
export interface TimelapseAvailabilityRange {
  readonly profile: string
  readonly startMs: number
  readonly endMs: number
}

export interface TimelapseCreateExportInput {
  readonly deviceId: number
  readonly profile: string
  readonly fromMs: number
  readonly toMs: number
  readonly options: {
    readonly includeAudio: boolean
    readonly maxLifeMs: number
    readonly deleteAfterDownload: boolean
    readonly title: string
    readonly timelapse: {
      readonly everyMs: number
      readonly outputFps: number
      readonly dense?: ExportDense
    }
  }
}

/**
 * Everything this renderer reaches outside itself, as closures.
 *
 * `publishArtifact` stays OPTIONAL because a wiring may legitimately have no
 * public surface, not because it is unfinished: the hub wiring implements it
 * (`artifact-publish.ts`) by reading the export's bytes once and republishing
 * them on the NC artifact plane, which is what gives a url-mode target
 * (Zentik) a video it can actually fetch. Absent — or answering null — the
 * notification still ships, text-only, and the log says which of the two it
 * was.
 */
export interface TimelapseRenderPorts {
  /**
   * How long a rendered export is kept, in ms — the operator's window.
   *
   * A port and not a constant because it is read at RENDER time: an export
   * scheduled before a Save and rendered after it must obey the new number.
   *
   * Always a POSITIVE number, never null. `recording-export`'s `maxLifeMs` is
   * `z.number().int().positive()`, so "keep forever" is not expressible on that
   * capability — the form's minimum for this one window is therefore 1 day, and
   * the wiring resolves a configured 0 back to the default rather than inventing
   * a hundred-year life that would read as a real decision.
   */
  readonly exportLifeMs: () => Promise<number>
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly getAvailability: (input: {
    readonly deviceId: number
    readonly fromMs: number
    readonly toMs: number
    /** Ask about THIS band. Absent = the hub's preferred one (D433). */
    readonly profile?: string
  }) => Promise<TimelapseAvailability>
  readonly listTracks: (input: {
    readonly deviceId: number
    readonly since: number
    readonly until: number
  }) => Promise<readonly TimelapseTrackInterval[]>
  /**
   * The window's object-event rows — the HALF OF THE ANSWER the track store
   * does not have.
   *
   * Not optional, deliberately. A wiring without it plans dense ranges from
   * persisted tracks alone, and the persisted track store is systematically
   * missing the detections a timelapse cares most about: the confirmation gate
   * retracts a suspected false birth, stationary promotion drops a parked car,
   * zero-media suppression cascades a thumbnail-less track away. On the night of
   * 2026-08-13 that left camera 101 with ZERO tracks across ten hours — and a
   * uniform video over the two people who walked past the door at 23:31. See
   * `detection-intervals.ts` for the merge and the measured rates.
   */
  readonly listDetectionEvents: (input: {
    readonly deviceId: number
    readonly since: number
    readonly until: number
  }) => Promise<readonly TimelapseDetectionEvent[]>
  readonly createExport: (input: TimelapseCreateExportInput) => Promise<ExportRecord>
  readonly getExport: (input: { readonly exportId: string }) => Promise<ExportRecord>
  /**
   * Every export row this camera already has — how a retry JOINS the render it
   * already ordered instead of ordering a second one.
   *
   * Not optional, deliberately. A wiring without it produces one duplicate
   * export per attempt, and because renders are serialised one ffmpeg at a time
   * the duplicates outpace the engine: on 2026-08-14 camera 1441 accumulated
   * five exports of the same ten-hour window in forty minutes while camera 101
   * never got a lane at all. That is not a degraded mode worth an `undefined`.
   */
  readonly listExports: (input: { readonly deviceId: number }) => Promise<readonly ExportRecord[]>
  readonly publishArtifact?: (input: {
    readonly exportId: string
    readonly deviceId: number
    readonly previewText?: string
    /** Still or animation. Always concrete when a preview is asked for. */
    readonly previewMode?: TimelapsePreviewMode
    /** What the video is ABOUT — the window's end, for the artefact index. */
    readonly capturedAt?: number
    readonly ruleId?: string
    readonly ruleName?: string
    readonly ownerUserId?: string
  }) => Promise<TimelapseArtifactSet>
  /**
   * The export's own download link, absolute and openable by a HUMAN.
   *
   * Served `access: 'authenticated'`, so it is a tap-through (`clickUrl`) and
   * never an attachment URL — a notifier backend fetching it holds no session
   * and would get a 401. Best-effort: null simply means no tap-through.
   */
  readonly resolveDownloadUrl?: (input: { readonly exportId: string }) => Promise<string | null>
  /**
   * `recordingExport.readExportBytes`, for the post-render PACING CHECK — the
   * finished file's own bytes are the only place its real frame count lives
   * (`ExportRecord` carries no duration, and the plan is what FAILED to reach
   * the file on the night this check was born). Optional: a wiring without it
   * skips the check with a log line; it never skips the render.
   */
  readonly readExportBytes?: (input: { readonly exportId: string }) => Promise<TimelapseExportFile>
  readonly pollMs?: number
  readonly timeoutMs?: number
}

/** The slice of `ExportBytes` the pacing check reads. */
export interface TimelapseExportFile {
  readonly base64: string
}

export interface TimelapseRenderRequest {
  readonly ruleId: string
  readonly ruleName: string
  readonly deviceId: number
  readonly window: ClosedWindow
  readonly cadenceSec: number
  readonly framerate: number
  /**
   * The rule's explicit dense cadence, seconds. Absent ⇒ derived from the base
   * (see `dense-cadence.ts`), which is what a rule written before the field
   * gets — and the reason this is optional rather than defaulted here.
   */
  readonly denseCadenceSec?: number
  /** The rule's per-range output-seconds guarantee. Absent ⇒ no guarantee. */
  readonly minDwellSec?: number
  /**
   * Caption for the notification's preview frame, ALREADY rendered.
   *
   * Resolved by the scheduler and not here, because `{{camera}}` needs the
   * display name — the one thing this module deliberately does not know. Absent
   * ⇒ no preview is produced at all (an older wiring, or a caller that does not
   * want one); an EMPTY string ⇒ a preview with no caption.
   */
  readonly previewText?: string
  /**
   * Still or animation for the preview. Absent ⇒ the still.
   *
   * Absent must mean the still and not "whatever is newest": a rule written
   * before the animation existed would otherwise start paying a dozen ffmpeg
   * seeks per window on the deploy that shipped it.
   */
  readonly previewMode?: TimelapsePreviewMode
  /**
   * Classes the notification reports counts for. Absent/empty ⇒ every class the
   * window contained (see `detection-counts.ts`).
   */
  readonly reportClasses?: readonly string[]
  /**
   * The rule's owner, carried through to the artefact index so a personal
   * rule's timelapses are visible only to their owner — the same visibility
   * rule the rule itself has. Absent ⇒ a global rule, browsable by everyone.
   */
  readonly ownerUserId?: string
  /**
   * The rule's IANA zone (`NcSchedule.timezone`) — what the export TITLE is
   * clocked in. Absent ⇒ the host zone, the same fallback `isScheduleActive`
   * uses for a rule with no zone.
   */
  readonly timezone?: string
}

export interface TimelapseRenderOutcome {
  readonly exportId: string
  readonly profile: string
  readonly coverage: FootageCoverage
  readonly plan: DenseRangePlan
  /**
   * What the window CONTAINED, per class, from the SAME `listTracks` result the
   * dense plan was built from. Always present — a failed track read counts
   * zero, never `undefined`, so a template can never render literal braces.
   */
  readonly detections: DetectionCounts
  /** Null when no reachable link could be minted — never a failure. */
  readonly artifact: TimelapseArtifactRef | null
  /** The captioned still for the notification card, or null. Independent of
   *  {@link TimelapseRenderOutcome.artifact}: either can be absent alone. */
  readonly preview: TimelapseArtifactRef | null
  /** Session-gated tap-through link, or null. Never an attachment URL. */
  readonly downloadUrl: string | null
  readonly fileBytes: number | null
}

export type TimelapseRenderFailure = 'no-footage' | 'export-failed' | 'export-timeout'

export class TimelapseRenderError extends Error {
  readonly reason: TimelapseRenderFailure
  constructor(reason: TimelapseRenderFailure, message: string) {
    super(message)
    this.name = 'TimelapseRenderError'
    this.reason = reason
  }
}

/**
 * Profiles from cheapest to dearest, so the source is chosen by COST.
 *
 * `CamProfileSchema` is declared dearest-first; this is that order reversed.
 * A name the enum does not know sorts after all of them, alphabetically, so the
 * choice stays deterministic for a fleet with a bespoke profile.
 */
const PROFILE_BY_COST: readonly string[] = [...CamProfileSchema.options].reverse()

function profileCost(profile: string): number {
  const i = PROFILE_BY_COST.indexOf(profile)
  return i === -1 ? PROFILE_BY_COST.length : i
}

/**
 * The CHEAPEST profile that has footage over the window.
 *
 * It used to be the profile with the MOST coverage, ties broken by name — and
 * that is a rule which picks `high` almost every time, because the high band is
 * the one that records continuously. On 2026-09-03 it did: a test render of a
 * ten-hour window chose `profile=high` at 97% coverage, which on this hub means
 * 4K read from a USB spinning disk. Decoding it made the machine stop answering
 * SSH and its own web UI for half an hour, and it had to be power-cycled.
 *
 * A timelapse is watched accelerated. Resolution buys nothing at 12 fps over a
 * night, and the cost difference between the bands is one to two orders of
 * magnitude in both bytes read and frames decoded. So there is no trade to
 * weigh: take the cheapest band that has anything, every time.
 *
 * Coverage no longer decides WHICH — only whether a band qualifies at all. A
 * band with less footage is still the right source; the gaps show as a shorter
 * video, not as a reason to read twenty times the bytes.
 */
/**
 * The tag every log line in this file carries — see the module docblock.
 *
 * A type ALIAS, not an interface, and that is load-bearing: `LogTags` has an
 * index signature, and TypeScript grants one implicitly to an object type
 * alias but never to an interface. Declared as `interface` this stops being
 * assignable to the logger's own parameter.
 */
export type DeviceTags = {
  readonly deviceId: number
}

/** What the archive re-read measured, and the rows it measured it from. */
export interface ArchiveMeasurement {
  /** The band's availability rows AFTER the export — what the file was cut from. */
  readonly rows: readonly TimelapseAvailabilityRange[]
  readonly coverage: FootageCoverage
}

/** The band a render was cut from, and what the PLAN saw of it. */
export interface ProfilePick {
  readonly profile: string
  readonly coverage: FootageCoverage
}

export function pickProfile(
  ranges: readonly TimelapseAvailabilityRange[],
  window: ClosedWindow,
): ProfilePick | null {
  const byProfile = new Map<string, TimelapseAvailabilityRange[]>()
  for (const r of ranges) {
    const list = byProfile.get(r.profile)
    if (list === undefined) byProfile.set(r.profile, [r])
    else list.push(r)
  }
  const ordered = [...byProfile].sort(
    (a, b) => profileCost(a[0]) - profileCost(b[0]) || a[0].localeCompare(b[0]),
  )
  for (const [profile, rows] of ordered) {
    const coverage = footageCoverage(rows, window.startMs, window.endMs)
    if (coverage.coveredMs > 0) return { profile, coverage }
  }
  return null
}

/**
 * Is `record` the render this request is about to order?
 *
 * The range, the source profile and the BASE cadence must match exactly — those
 * three decide what the video is. The dense overlay deliberately does NOT: it
 * is derived from the tracks the window happened to hold, and a retry minutes
 * later plans it from a slightly longer list. Refusing to adopt over a moved
 * range boundary would re-order the whole ten hours for a difference nobody can
 * see, which is precisely the loop this exists to break.
 */
function coversTheSameRender(
  record: ExportRecord,
  want: {
    readonly profile: string
    readonly fromMs: number
    readonly toMs: number
    readonly everyMs: number
    readonly outputFps: number
  },
): boolean {
  const timelapse = record.options.timelapse
  if (timelapse === undefined) return false
  return (
    record.profile === want.profile &&
    record.fromMs === want.fromMs &&
    record.toMs === want.toMs &&
    timelapse.everyMs === want.everyMs &&
    timelapse.outputFps === want.outputFps
  )
}

/**
 * Would adopting `record` LOSE the slowdown this render planned?
 *
 * The adoption check deliberately ignores the dense RANGES (a retry plans them
 * from a slightly longer track list, and re-ordering ten hours over a moved
 * boundary is the loop adoption exists to break). It must NOT ignore whether a
 * dense overlay exists at all.
 *
 * The failure this closes: attempt one reads the detections while the store is
 * unreachable, plans nothing, and queues a UNIFORM ten-hour export; every retry
 * then plans ranges correctly, finds that uniform export alive under the same
 * (profile, range, base cadence, fps) key, adopts it, and delivers a video that
 * never slows down — for the whole night, no matter how many retries run. The
 * notification would even caption it "2 persone". A re-order costs ~20 min of
 * ffmpeg ONCE; adopting the wrong product costs the night.
 *
 * Bounded, and that is why it is safe: the verdict is a function of the plan, so
 * the export ordered after a refusal carries the dense overlay and the NEXT
 * retry adopts it. Only a plan that changed direction refuses, never a retry.
 * A candidate DENSER than what we want is adopted — more slowdown than asked is
 * not a defect, and refusing it would re-order for nothing.
 */
function keepsThePlannedSlowdown(record: ExportRecord, want: ExportDense | undefined): boolean {
  if (want === undefined) return true
  const dense = record.options.timelapse?.dense
  if (dense === undefined || dense.ranges.length === 0) return false
  return dense.everyMs <= want.everyMs
}

/** Can this row still become — or already be — a file we can fetch? */
function isAdoptable(record: ExportRecord, nowMs: number): boolean {
  if (record.expiresAt <= nowMs) return false
  if (record.state === 'ready') return record.fileBytes !== null
  return record.state === 'queued' || record.state === 'rendering'
}

/**
 * `HH:MM` in the RULE's timezone, for the export title an operator reads.
 *
 * The zone is not decoration. The hub container runs on UTC while the operator
 * and every one of his schedules run on Europe/Rome, so the host-local
 * derivation this used to do titled a 21:00→07:00 window `19:00→05:00` — two
 * hours off, on the one string whose whole job is to say which night the file
 * is. The window boundaries themselves were always correct: `isScheduleActive`
 * has resolved minutes through `schedule.timezone` from the start, and only the
 * label lied.
 *
 * An absent or unknown IANA name falls back to the host zone, which is exactly
 * what `localDayMinute` does for the same input — one behaviour for a bad
 * zone, not two.
 */
function clockOf(atMs: number, timeZone: string | undefined): string {
  if (timeZone !== undefined) {
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(atMs))
    } catch {
      // fall through to the host zone
    }
  }
  const d = new Date(atMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export class TimelapseRenderer {
  private readonly pollMs: number
  private readonly timeoutMs: number

  constructor(private readonly ports: TimelapseRenderPorts) {
    this.pollMs = ports.pollMs ?? RENDER_POLL_MS
    this.timeoutMs = ports.timeoutMs ?? RENDER_TIMEOUT_MS
  }

  async render(request: TimelapseRenderRequest): Promise<TimelapseRenderOutcome> {
    const { deviceId, window } = request
    const tags = { deviceId }

    // 1. The cheap question first — never load anything for work that cannot run.
    // ASK FOR THE CHEAPEST BAND BY NAME (D435). `getAvailability` answers for
    // the hub's PREFERRED profile, which is `high`; handing those ranges to
    // `pickProfile` let it choose only what it had been given, so its whole
    // reason for existing — never decode 4K for a video watched at 12 fps —
    // was defeated by the read in front of it.
    const first = await this.ports.getAvailability({
      deviceId,
      fromMs: window.startMs,
      toMs: window.endMs,
    })
    const cheapest = [...first.profilesWithFootage].sort(
      (a, b) => profileCost(a) - profileCost(b),
    )[0]
    const describes = first.ranges[0]?.profile
    // A SECOND read only when the hub's preferred band is not the cheapest
    // one — which on this deployment it never is, and which is the whole
    // reason the safety rule below could not fire.
    const availability =
      cheapest !== undefined && cheapest !== describes
        ? (
            await this.ports.getAvailability({
              deviceId,
              fromMs: window.startMs,
              toMs: window.endMs,
              profile: cheapest,
            })
          ).ranges
        : first.ranges
    const chosen = pickProfile(availability, window)
    if (chosen === null || chosen.coverage.coveredMs === 0) {
      // A branch that drops work logs it. Silence reads as "never happened".
      this.ports.logger.warn('timelapse skipped: no footage covers the window', {
        tags,
        meta: {
          ruleId: request.ruleId,
          windowStart: window.startMs,
          windowEnd: window.endMs,
        },
      })
      throw new TimelapseRenderError(
        'no-footage',
        `no footage for ${deviceId} in ${window.startMs}..${window.endMs}`,
      )
    }

    // 2. Which seconds deserve the fast cadence. TWO reads, because neither
    //    store answers the whole question: the track store is authoritative for
    //    what it holds but systematically missing suppressed births, promoted
    //    parked objects and media-less tracks; the object-event rows survive all
    //    three. `detection-intervals.ts` carries the evidence and the merge.
    const [tracks, events] = await Promise.all([
      this.ports
        .listTracks({ deviceId, since: window.startMs, until: window.endMs })
        .catch((err: unknown): readonly TimelapseTrackInterval[] => {
          // A branch that drops work logs it — a half-read dense plan reads
          // exactly like a quiet night from the outside.
          this.ports.logger.warn('timelapse track read failed — dense plan degraded', {
            tags,
            meta: { ruleId: request.ruleId, error: String(err) },
          })
          return []
        }),
      this.ports
        .listDetectionEvents({
          deviceId,
          since: window.startMs,
          until: window.endMs,
        })
        .catch((err: unknown): readonly TimelapseDetectionEvent[] => {
          this.ports.logger.warn('timelapse detection-event read failed — dense plan degraded', {
            tags,
            meta: { ruleId: request.ruleId, error: String(err) },
          })
          return []
        }),
    ])
    const subjects = mergeDetectionIntervals({ tracks, events })
    // The SAME array, counted per class — never a second query (see
    // `detection-counts.ts`): a count from its own read could disagree with the
    // ranges the video was cut from, and nothing outside could tell.
    const detections = countDetections({
      tracks: subjects,
      ...(request.reportClasses !== undefined ? { reportClasses: request.reportClasses } : {}),
    })
    const plan = planDenseRanges({
      tracks: subjects,
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      padSec: DENSE_PAD_SEC,
      baseCadenceSec: request.cadenceSec,
    })
    const everyMs = request.cadenceSec * 1000
    const cadence = resolveDenseCadence({
      cadenceSec: request.cadenceSec,
      ...(request.denseCadenceSec !== undefined
        ? { denseCadenceSec: request.denseCadenceSec }
        : {}),
      ...(request.minDwellSec !== undefined ? { minDwellSec: request.minDwellSec } : {}),
      outputFps: request.framerate,
      ranges: plan.ranges,
    })
    // The `< everyMs` guard stays: upsert refuses a non-denser override, but a
    // rule persisted before that guard existed must still render — degraded to
    // a uniform video — rather than be rejected by the export cap hours after
    // the window closed, with nothing left to retry.
    const dense: ExportDense | undefined =
      plan.ranges.length > 0 && cadence.everyMs < everyMs
        ? { everyMs: cadence.everyMs, ranges: [...plan.ranges] }
        : undefined

    // A dwell the footage could not honour is a QUIET shortfall — the video
    // renders, just not as dense as the operator asked. Silence would read as
    // "the guarantee held".
    if (cadence.dwellFloorCapped) {
      this.ports.logger.info('timelapse minDwell capped by the recording frame interval', {
        tags,
        meta: {
          ruleId: request.ruleId,
          minDwellSec: request.minDwellSec,
          denseEveryMs: cadence.everyMs,
        },
      })
    }

    if (plan.capped) {
      this.ports.logger.info('timelapse dense plan exceeded the range ceiling — uniform cadence', {
        tags,
        meta: { ruleId: request.ruleId, mergedRanges: plan.mergedCount },
      })
    }

    // 3. Hand it to the engine that already knows how to render footage —
    //    unless the engine is already rendering exactly this, in which case
    //    JOIN it rather than ordering the same ten hours a second time.
    const adopted = await this.findAdoptable(
      {
        deviceId,
        profile: chosen.profile,
        fromMs: window.startMs,
        toMs: window.endMs,
      },
      { everyMs, outputFps: request.framerate },
      dense,
      tags,
    )
    const queued =
      adopted ??
      (await this.ports.createExport({
        deviceId,
        profile: chosen.profile,
        fromMs: window.startMs,
        toMs: window.endMs,
        options: {
          includeAudio: false,
          maxLifeMs: await this.ports.exportLifeMs(),
          deleteAfterDownload: false,
          title: `${request.ruleName} ${clockOf(window.startMs, request.timezone)}→${clockOf(window.endMs, request.timezone)}`,
          timelapse: {
            everyMs,
            outputFps: request.framerate,
            ...(dense !== undefined ? { dense } : {}),
          },
        },
      }))
    this.ports.logger.info(
      adopted === null ? 'timelapse export queued' : 'timelapse export adopted',
      {
        tags,
        meta: {
          ruleId: request.ruleId,
          exportId: queued.id,
          profile: chosen.profile,
          everyMs,
          denseEveryMs: dense?.everyMs ?? null,
          denseSource: cadence.source,
          denseDwellApplied: cadence.dwellApplied,
          denseRanges: plan.ranges.length,
          // The three numbers that make an empty dense plan diagnosable in one
          // line: how many the STORE held, how many rows the EVENTS held, and
          // how many subjects the merge made of them. `denseTracks=0
          // denseEvents=2 denseSubjects=1` is the whole 101 story.
          denseTracks: tracks.length,
          denseEvents: events.length,
          denseSubjects: subjects.length,
          coveragePct: chosen.coverage.percent,
          ...(adopted !== null ? { adoptedState: adopted.state } : {}),
        },
      },
    )

    const finished = await this.awaitReady(queued, tags)

    // 4. Two links, two audiences: one a notifier BACKEND can fetch (public,
    //    an attachment) and one the RECIPIENT opens (session-gated, a
    //    tap-through). Both best-effort — a video that exists and cannot be
    //    linked is a degraded notification, never a failed window.
    const published = await this.publish(finished.id, request, tags)
    const downloadUrl = await this.ports
      .resolveDownloadUrl?.({ exportId: finished.id })
      .catch(() => null)

    // 5. The window against the ARCHIVE. The export walks its window verified
    //    (D445), which repairs the index the calendar serves from — so the
    //    availability read AFTER the export is what the file was rendered
    //    from, and the read BEFORE it is what the plan was cut from. Camera
    //    4374's night shipped at 0.20 of its archive with no line saying so.
    const archive = await this.measureArchive(finished.id, request, chosen, tags)
    const deliveredRows = archive?.rows ?? availability.filter((r) => r.profile === chosen.profile)

    // 6. The pacing check: does the FILE match the plan? Same ranges, same
    //    cadences, and the coverage rows the file was actually cut from — one
    //    authority. Best-effort and bounded: it can delay the outcome by at
    //    most PACING_CHECK_TIMEOUT_MS and can never fail the window (see
    //    `pacing-check.ts` for the night it missed).
    await this.verifyPacing({
      exportId: finished.id,
      request,
      dense,
      subjects,
      availability: deliveredRows,
      tags,
    })

    return {
      exportId: finished.id,
      profile: chosen.profile,
      // What the notification claims to cover is what the FILE holds.
      coverage: archive?.coverage ?? chosen.coverage,
      plan,
      detections,
      artifact: published.video,
      preview: published.preview,
      downloadUrl: downloadUrl ?? null,
      fileBytes: finished.fileBytes,
    }
  }

  /**
   * The render this request would order, if the engine already owes it.
   *
   * Never throws: an adoption lookup that fails costs one duplicate export,
   * which is strictly better than costing the window. It says so, though — a
   * branch that silently drops the protection reads as "there was nothing to
   * adopt".
   */
  private async findAdoptable(
    want: {
      readonly deviceId: number
      readonly profile: string
      readonly fromMs: number
      readonly toMs: number
    },
    cadence: { readonly everyMs: number; readonly outputFps: number },
    wantDense: ExportDense | undefined,
    tags: DeviceTags,
  ): Promise<ExportRecord | null> {
    const rows = await this.ports.listExports({ deviceId: want.deviceId }).catch((err: unknown) => {
      this.ports.logger.warn('timelapse could not check for an export already in flight', {
        tags,
        meta: { error: String(err) },
      })
      return null
    })
    if (rows === null) return null
    const now = this.ports.now()
    const sameRender = rows.filter(
      (r) => isAdoptable(r, now) && coversTheSameRender(r, { ...want, ...cadence }),
    )
    const usable = sameRender.filter((r) => keepsThePlannedSlowdown(r, wantDense))
    // A branch that drops work logs it: refusing an adoption spends ~20 min of
    // ffmpeg, and the reason must be readable without a debugger.
    if (usable.length < sameRender.length) {
      this.ports.logger.info('timelapse refused to adopt an export with no dense overlay', {
        tags,
        meta: {
          candidates: sameRender.length,
          refused: sameRender.length - usable.length,
          wantDenseEveryMs: wantDense?.everyMs ?? null,
          wantDenseRanges: wantDense?.ranges.length ?? 0,
        },
      })
    }
    // A finished file beats work still owed — it needs no poll at all. Among
    // unfinished rows the OLDEST is the closest to done.
    const ready = usable.find((r) => r.state === 'ready')
    if (ready !== undefined) return ready
    return usable.toSorted((a, b) => a.createdAt - b.createdAt)[0] ?? null
  }

  /**
   * Poll to a terminal state, under a bound.
   *
   * The bound belongs to the RENDER, not to any single poll of it. A
   * `getExport` that fails on the transport says nothing at all about the
   * ffmpeg on the recording node — and treating it as fatal is how a finished
   * 12.5 MB video was abandoned on 2026-08-14: one `UDS request timed out after
   * 60000ms` at 05:10:47 threw straight out of the wait for an export that
   * reached `ready` at 05:23:47. So a failed poll is retried until the
   * deadline, and only a TERMINAL state the engine actually reported ends the
   * wait early.
   */
  private async awaitReady(queued: ExportRecord, tags: DeviceTags): Promise<ExportRecord> {
    if (queued.state === 'ready') return queued
    const deadline = this.ports.now() + this.timeoutMs
    let current = queued
    let pollFailures = 0
    let lastPollError: string | null = null
    while (this.ports.now() < deadline) {
      await this.ports.sleep(this.pollMs)
      const polled = await this.ports
        .getExport({ exportId: queued.id })
        .catch((err: unknown): null => {
          pollFailures += 1
          lastPollError = String(err)
          // Named once, then quiet: at a 5 s cadence a stalled hub would
          // otherwise write hundreds of identical lines over one render, and
          // the count rides the outcome line anyway.
          const entry = {
            tags,
            meta: { exportId: queued.id, pollFailures, error: lastPollError },
          }
          if (pollFailures === 1) {
            this.ports.logger.warn('timelapse export poll failed — the render is still owed', entry)
          } else {
            this.ports.logger.debug('timelapse export poll failed again', entry)
          }
          return null
        })
      if (polled === null) continue
      current = polled
      if (current.state === 'ready') return current
      if (
        current.state === 'failed' ||
        current.state === 'expired' ||
        current.state === 'deleted'
      ) {
        this.ports.logger.warn('timelapse export did not finish', {
          tags,
          meta: {
            exportId: queued.id,
            state: current.state,
            error: current.error,
          },
        })
        throw new TimelapseRenderError(
          'export-failed',
          current.error ?? `export ${queued.id} ended ${current.state}`,
        )
      }
    }
    this.ports.logger.warn('timelapse export timed out', {
      tags,
      meta: {
        exportId: queued.id,
        timeoutMs: this.timeoutMs,
        lastState: current.state,
        pollFailures,
        ...(lastPollError !== null ? { lastPollError } : {}),
      },
    })
    throw new TimelapseRenderError(
      'export-timeout',
      `export ${queued.id} timed out after ${this.timeoutMs}ms` +
        (pollFailures > 0 ? ` (${pollFailures} poll failures, last: ${lastPollError})` : ''),
    )
  }

  /**
   * The window against the archive, measured AFTER the export and always said.
   *
   * Three figures, one line: the window's length, what the PLAN was cut from
   * (the availability read before the export) and what the ARCHIVE holds (the
   * same read after it — the export's verified walk has repaired the index the
   * calendar serves from by then). `plannedOfArchive` is the ratio D445 found
   * at 0.20 on camera 4374 and nothing reported; a healthy night reads 1.00
   * because both reads return the same rows.
   *
   * WHY THE THRESHOLD IS A SLACK AND NOT A RATIO. The two reads are the SAME
   * query against the SAME index, so on a healthy night they return the same
   * rows and the shortfall is exactly 0 — there is no distribution to pick a
   * percentile out of. It is non-zero only when something CHANGED the index
   * between them, and the export's verified walk is the only thing that does.
   * So the bar is not "how short is too short" (the robot's night was 0.20 and
   * a milder one would be just as wrong); it is only "is this a real change or
   * a boundary artefact". One artefact exists: the window is closed, but a
   * segment straddling its end can finalize while the export runs and extend
   * the last range by its own length. {@link COVERAGE_COMPLETE_SLACK_MS} (30 s)
   * is the slack the coverage figure already allows at exactly those edges,
   * and it is several segments wide. No second constant, and nothing between
   * "unchanged" and "the planner rendered from a short answer".
   *
   * Never throws. A re-read that fails is SAID, the plan's figure stands, and
   * every figure that needed the archive is `null` rather than a stand-in.
   */
  private async measureArchive(
    exportId: string,
    request: TimelapseRenderRequest,
    chosen: ProfilePick,
    tags: DeviceTags,
  ): Promise<ArchiveMeasurement | null> {
    const { window } = request
    const windowSec = Math.round((window.endMs - window.startMs) / 1000)
    const plannedSec = Math.round(chosen.coverage.coveredMs / 1000)
    let rows: readonly TimelapseAvailabilityRange[]
    try {
      rows = (
        await this.ports.getAvailability({
          deviceId: request.deviceId,
          fromMs: window.startMs,
          toMs: window.endMs,
          profile: chosen.profile,
        })
      ).ranges.filter((r) => r.profile === chosen.profile)
    } catch (err: unknown) {
      this.ports.logger.warn(
        'timelapse coverage: archive re-read failed — the window is reported against the plan only',
        {
          tags,
          meta: {
            exportId,
            ruleId: request.ruleId,
            profile: chosen.profile,
            windowSec,
            plannedSec,
            plannedOfWindow: ratio(chosen.coverage.coveredMs, window.endMs - window.startMs),
            // The measurement FAILED, so it is null — never the plan's figure
            // wearing the archive's name (D393). `plannedOfArchive` is the
            // question this line exists to answer and it stays unanswered.
            archiveSec: null,
            plannedOfArchive: null,
            archiveOfWindow: null,
            error: String(err),
          },
        },
      )
      return null
    }
    const coverage = footageCoverage(rows, window.startMs, window.endMs)
    const shortfallMs = coverage.coveredMs - chosen.coverage.coveredMs
    const meta = {
      exportId,
      ruleId: request.ruleId,
      profile: chosen.profile,
      windowSec,
      plannedSec,
      archiveSec: Math.round(coverage.coveredMs / 1000),
      /** What the operator ASKED for against what the file HOLDS — the ratio
       *  the robot's night made someone file a report over: ten hours in,
       *  6.4 s of video out. Low is not by itself a defect (a lazy source is
       *  legitimately idle most of a night), which is why it never gates. */
      plannedOfWindow: ratio(chosen.coverage.coveredMs, window.endMs - window.startMs),
      archiveOfWindow: ratio(coverage.coveredMs, window.endMs - window.startMs),
      /** The one that IS a defect: what the planner saw against what the
       *  export's verified walk found. 0.20 on camera 4374, 1.00 when healthy. */
      plannedOfArchive: ratio(chosen.coverage.coveredMs, coverage.coveredMs),
      shortfallSec: Math.round(shortfallMs / 1000),
    }
    if (shortfallMs > COVERAGE_COMPLETE_SLACK_MS) {
      this.ports.logger.warn(
        'timelapse coverage: the plan was cut from less footage than the archive holds',
        { tags, meta },
      )
    } else {
      this.ports.logger.info('timelapse coverage: the window against the archive', { tags, meta })
    }
    return { rows, coverage }
  }

  /**
   * Run the pacing check against the finished file, and SAY what it found.
   *
   * Never throws and never blocks past its bound: the check is telemetry about
   * a video that already exists, and the window's delivery must not hang on a
   * byte read. Every exit path logs — a check that silently did not run reads
   * exactly like a check that passed.
   */
  private async verifyPacing(input: {
    readonly exportId: string
    readonly request: TimelapseRenderRequest
    readonly dense: ExportDense | undefined
    readonly subjects: readonly TimelapseTrackInterval[]
    readonly availability: readonly TimelapseAvailabilityRange[]
    readonly tags: DeviceTags
  }): Promise<void> {
    const { exportId, request, tags } = input
    const read = this.ports.readExportBytes
    if (read === undefined) {
      this.ports.logger.info('timelapse pacing check skipped — no export byte reader wired', {
        tags,
        meta: { exportId },
      })
      return
    }
    try {
      const file = await Promise.race([
        read({ exportId }),
        this.ports.sleep(PACING_CHECK_TIMEOUT_MS).then((): null => null),
      ])
      if (file === null) {
        this.ports.logger.warn('timelapse pacing check failed — delivery unaffected', {
          tags,
          meta: {
            exportId,
            error: `timed out after ${String(PACING_CHECK_TIMEOUT_MS)}ms`,
          },
        })
        return
      }
      const bytes = Buffer.from(file.base64, 'base64')
      const actualDurationMs = readMp4DurationMs(bytes)
      if (actualDurationMs === null) {
        this.ports.logger.warn('timelapse pacing check failed — delivery unaffected', {
          tags,
          meta: {
            exportId,
            error: 'mp4 duration unreadable',
            bytes: bytes.length,
          },
        })
        return
      }
      const verdict = checkTimelapsePacing({
        windowStartMs: request.window.startMs,
        windowEndMs: request.window.endMs,
        cadenceSec: request.cadenceSec,
        denseEveryMs: input.dense?.everyMs ?? null,
        outputFps: request.framerate,
        ranges: input.dense?.ranges ?? [],
        subjects: input.subjects,
        availability: input.availability,
        actualDurationMs,
      })
      this.reportPacing(verdict, exportId, request, tags)
    } catch (err: unknown) {
      this.ports.logger.warn('timelapse pacing check failed — delivery unaffected', {
        tags,
        meta: { exportId, error: String(err) },
      })
    }
  }

  /** The verdict, as the log line the operator will actually read. */
  private reportPacing(
    verdict: PacingVerdict,
    exportId: string,
    request: TimelapseRenderRequest,
    tags: DeviceTags,
  ): void {
    const meta = {
      exportId,
      ruleId: request.ruleId,
      actualFrames: verdict.actualFrames,
      expectedFrames: verdict.expectedFrames,
      baselineOnlyFrames: verdict.baselineOnlyFrames,
      expectedDenseExtraFrames: verdict.expectedDenseExtraFrames,
      deliveredDenseExtraFrames: verdict.deliveredDenseExtraFrames,
      coveredSec: Math.round(verdict.coveredSec),
      denseCoveredSec: Math.round(verdict.denseCoveredSec),
    }
    if (verdict.anomaly === 'none') {
      this.ports.logger.info('timelapse pacing verified', { tags, meta })
      return
    }
    if (verdict.anomaly === 'no-slowdown') {
      // WHO was skipped and WHEN, clocked in the rule's own zone — the exact
      // question the operator asked ("alle 06:25 c'è stata una detection
      // chiaramente ma non rallenta affatto" [at 06:25 there was clearly a detection but it does not slow down at all]) answered per window. Bounded:
      // a capped-plan night could hold hundreds of ranges.
      this.ports.logger.warn('timelapse pacing check: detection windows received no slowdown', {
        tags,
        meta: {
          ...meta,
          unservedWindowCount: verdict.unservedWindows.length,
          unservedWindows: verdict.unservedWindows.slice(0, 12).map((w) => ({
            at: clockOf(request.window.startMs + w.fromSec * 1000, request.timezone),
            fromSec: Math.round(w.fromSec),
            toSec: Math.round(w.toSec),
            expectedDenseFrames: w.expectedDenseFrames,
            subjects: w.subjects,
            classes: w.classes,
            firstSeen: w.firstSeen,
          })),
        },
      })
      return
    }
    this.ports.logger.warn('timelapse pacing check: delivered frames deviate from the plan', {
      tags,
      meta: { ...meta, anomaly: verdict.anomaly },
    })
  }

  /**
   * Mint the public link, or say why there is none.
   *
   * Never throws: a video that exists and cannot be linked is a degraded
   * notification, not a failed window — and failing here would leave the pair
   * unstamped and re-render the same eight hours on the next tick.
   */
  private async publish(
    exportId: string,
    request: TimelapseRenderRequest,
    tags: DeviceTags,
  ): Promise<TimelapseArtifactSet> {
    const { deviceId, previewText } = request
    const previewMode = request.previewMode ?? 'image'
    const publish = this.ports.publishArtifact
    const none: TimelapseArtifactSet = { video: null, preview: null }
    if (publish === undefined) {
      this.ports.logger.info('timelapse artifact publishing is not wired — link-less delivery', {
        tags,
        meta: { exportId },
      })
      return none
    }
    try {
      const set = await publish({
        exportId,
        deviceId,
        ...(previewText !== undefined ? { previewText, previewMode } : {}),
        // The WINDOW's end, never the render clock: a 06:05 render is about
        // last night, and the artefact library is sorted on this.
        capturedAt: request.window.endMs,
        ruleId: request.ruleId,
        ruleName: request.ruleName,
        ...(request.ownerUserId !== undefined ? { ownerUserId: request.ownerUserId } : {}),
      })
      if (set.video === null) {
        this.ports.logger.warn('timelapse artifact could not be published — link-less delivery', {
          tags,
          meta: { exportId },
        })
      }
      return set
    } catch (err: unknown) {
      this.ports.logger.warn('timelapse artifact publish threw — link-less delivery', {
        tags,
        meta: { exportId, error: String(err) },
      })
      return none
    }
  }
}
