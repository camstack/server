import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import {
  type CapabilityDefinition,
  type InferNativeProvider,
  method,
} from './capability-definition.js'

/**
 * Vendor-neutral **onboard** recording + storage cap — what the CAMERA
 * writes to the CAMERA's own card, on the camera's own schedule.
 *
 * This is NOT `recording.cap.ts`. That one is CamStack's recorder: our
 * footage ledger, our storage locations, our retention. This one has a
 * different authority — the camera's firmware — and per D62 it stores
 * nothing of its own. Every value here is read from the camera and every
 * write goes back to the camera; there is no CamStack-side mirror that
 * could disagree with the device.
 *
 * ## One shape, two firmwares
 *
 * Measured 2026-09-22 against the live fleet:
 *
 * | fact | Hikvision (ISAPI) | Reolink (Baichuan) |
 * | --- | --- | --- |
 * | storage | `ContentMgmt/Storage` `<hdd>` rows: status, capacity, freeSpace (MB) | `getHddInfoList` (cmd 102): `mount`, `format`, `capacity` GB + `capacityM` MB remainder |
 * | tracks | several (101 **and** 103 on both 1436 and 3833), each with its own schedule | one per channel |
 * | schedule | per track, 7 `ScheduleAction` blocks: DayOfWeek + TimeOfDay range + ONE `ActionRecordingMode` | per trigger type, a 168-char weekly HOUR mask |
 * | triggers | `CMR`, `MOTION` | `Normal`, `MD`, `people`, `vehicle`, `dog_cat`, `crossline`, `intrude`, `loitering` |
 * | pre-record | `PreRecordTimeSeconds` | `preRecordTime` |
 * | post-record | `PostRecordTimeSeconds` | `recordDelayTime` |
 * | overwrite | per track `LoopEnable` | `cycle`, with `cycleList` enumerating the accepted values |
 * | segment length | not exposed on V5.7.1 | `packageTime` (minutes) |
 *
 * The two schedule models look different and are the same thing in
 * different coordinates: both answer "for this trigger, during which
 * weekly windows does the camera record". {@link RecordWindow} is that
 * question in one shape — Hikvision's ranges map straight onto it,
 * Reolink's mask expands into hour-aligned windows.
 *
 * ## Union, not intersection
 *
 * **The same fields exist on every camera.** What differs per device is
 * which VALUES that device accepts, and that is what {@link
 * RecordingOnboardOptions} reports — a `{ readable, writable, reason }`
 * per field plus the schedule's own limits. A control a camera cannot
 * honour is rendered DISABLED WITH ITS REASON, never missing and never
 * dead: disabled must not look like broken.
 *
 * ## Refusal by name
 *
 * A write a camera cannot honour is refused with a sentence the operator
 * can read — never accepted and dropped. Both providers refuse through
 * {@link describeOnboardRefusal}, so the vocabulary is one function and
 * one test, not two hand-written vendor opinions.
 *
 * Follows the D14 `deviceConfig` archetype (see `stream-params.cap.ts`):
 * `getOptions` advertises per-camera availability, `getStatus` (auto-
 * injected from `status`) reports the live values, and a single
 * `setSettings` mutation applies a partial change. No hand-written
 * settings-contribution methods.
 */

// ── Triggers ─────────────────────────────────────────────────────────

/**
 * What makes the camera start recording during a window.
 *
 * The union of both vendors' vocabularies. `continuous` is Hikvision's
 * `CMR` and Reolink's `Normal`; `motion` is `MOTION` / `MD`. The
 * object-class triggers are Reolink-only today and the smart-event ones
 * (`lineCrossing`, `intrusion`, `loitering`) are Reolink-only on the
 * firmwares measured — a camera that cannot record on a trigger simply
 * does not list it in `options.schedule.triggers`, and a window naming
 * it is REFUSED, not dropped.
 */
export const RecordTriggerSchema = z.enum([
  'continuous',
  'motion',
  'person',
  'vehicle',
  'animal',
  'lineCrossing',
  'intrusion',
  'loitering',
  'alarmInput',
])

// ── Weekly windows ───────────────────────────────────────────────────

/**
 * One weekly recording window: "on `day`, from `startMinute` to
 * `endMinute`, record on `trigger`".
 *
 * `day` is 0 = Monday … 6 = Sunday (ISO order, which is also the order
 * both firmwares enumerate). Minutes are local camera time since
 * midnight; `endMinute` may be 1440, meaning end of day — that is
 * Hikvision's literal `24:00` and Reolink's 24th mask slot, and
 * collapsing it to 0 would turn a whole-day window into an empty one.
 */
export const RecordWindowSchema = z.object({
  trigger: RecordTriggerSchema,
  day: z.number().int().min(0).max(6).meta(readingMeta('none')),
  startMinute: z.number().int().min(0).max(1439).meta(readingMeta('none')),
  endMinute: z.number().int().min(1).max(1440).meta(readingMeta('none')),
})

// ── Onboard storage ──────────────────────────────────────────────────

/** Status of one physical volume, as the camera itself describes it. */
export const OnboardStorageVolumeSchema = z.object({
  /** The camera's own id for the volume (`hdd/id`, Reolink `HddInfo/number`). */
  id: z.string(),
  /** The camera's own name for it, when it gives one (`hddName`). */
  label: z.string().optional(),
  status: z.enum(['ok', 'unformatted', 'error', 'offline', 'unknown']),
  /**
   * Total size in MB, or **null when the camera did not say**.
   *
   * Never 0 for an unreadable value: a measurement that failed is not a
   * measurement (D393), and a card whose size is unknown must not be
   * rendered as a card of size zero.
   */
  capacityMb: z.number().nullable(),
  /**
   * Free space in MB, or null when unknown.
   *
   * **Not a proxy for "has footage".** Measured 2026-09-22: 1436 and
   * 1439 both report exactly 11776 MB free — the fixed reserve a looping
   * card converges on once it has wrapped. At loop steady state the
   * number is identical whether the camera recorded yesterday or stopped
   * a month ago.
   */
  freeMb: z.number().nullable(),
  /** True when the camera reports the volume writable (`property` RW). */
  writable: z.boolean().optional(),
})

/**
 * Whether the camera has usable onboard storage.
 *
 * Three states, never two: an unreadable answer is `unknown`, never
 * folded into `absent`. Folding a failed read into "no card" is how a
 * healthy camera gets reported as broken, and the inverse is how a
 * camera with no card reports `ok` and then an empty list (D393).
 */
export const OnboardStorageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('present'), volumes: z.array(OnboardStorageVolumeSchema) }),
  z.object({ kind: z.literal('absent'), reason: z.string() }),
  z.object({ kind: z.literal('unknown'), reason: z.string() }),
])

// ── Tracks ───────────────────────────────────────────────────────────

/**
 * One recording track the camera exposes. Read-only.
 *
 * Hikvision lists several — 1436 and 3833 each list 101 AND 103, with
 * DIFFERENT schedules (101 MOTION all day, 103 CMR 00:05–23:57) — so a
 * cap that reported one number for "the schedule" would be lying on
 * every Hikvision in the fleet. Reolink has exactly one per channel.
 *
 * There is deliberately **no `framerate`**. Hikvision declares it in the
 * track `Description` and it is WRONG: 1436 says `2.260000 fps` while
 * the media measures 12.55 fps. `codec` and `resolution` from the same
 * string ARE right — those are the only two worth surfacing.
 */
export const OnboardRecordTrackSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  isVideo: z.boolean(),
  /** From the camera's own track description. Null when it does not say. */
  codec: z.string().nullable(),
  resolution: z.string().nullable(),
  /** Per-track overwrite flag, where the firmware keeps it per track. */
  overwriteWhenFull: z.boolean().nullable(),
})

// ── Status ───────────────────────────────────────────────────────────

/**
 * What the camera is doing with its own storage, right now.
 *
 * Every scalar is nullable and **null means the camera did not answer**,
 * never a default. A form that seeds `0` from an unanswered read invites
 * the operator to save that 0 back onto the camera.
 */
export const RecordingOnboardStatusSchema = z.object({
  storage: OnboardStorageSchema,
  tracks: z.array(OnboardRecordTrackSchema),
  /**
   * The track the write path targets — the enabled VIDEO one. Null when
   * no track could be identified, which is itself a refusal reason.
   */
  primaryTrackId: z.string().nullable(),
  /** Master "record to the card at all" switch. */
  enabled: z.boolean().nullable(),
  overwriteWhenFull: z.boolean().nullable(),
  preRecordSec: z.number().nullable().meta(readingMeta('duration')),
  postRecordSec: z.number().nullable().meta(readingMeta('duration')),
  /** Length of one recorded file, in minutes. */
  segmentMinutes: z.number().nullable().meta(readingMeta('none')),
  /** The primary track's weekly windows, flattened. */
  windows: z.array(RecordWindowSchema),
  /**
   * How many windows the camera described that CamStack could NOT read —
   * an unrecognised trigger, an unparseable clock, a weekday it does not
   * name.
   *
   * A dropped window is work the reader threw away, and a schedule that
   * silently shows fewer rows than the camera holds is how an operator
   * saves back a schedule shorter than the one they were looking at
   * (D391). Non-zero means the window list is INCOMPLETE and a write
   * that replaces it would delete what was not shown — which is why a
   * provider reporting a non-zero count also reports the schedule as not
   * writable.
   */
  unreadableWindows: z.number().meta(readingMeta('count')),
  /**
   * The camera is scheduled to record and has NO usable storage.
   *
   * A first-class fact because it is the fleet's most common silent
   * defect: measured 2026-09-22, 1441 and 3831 are both motion-recording
   * to a card that is not there. Neither the schedule nor the storage
   * read says anything wrong on its own; only the pair does.
   */
  recordingToNowhere: z.boolean(),
  lastFetchedAt: z.number(),
})

// ── Options: what THIS camera accepts ────────────────────────────────

/** Numeric range descriptor — `{ min, max, step }` per the getOptions convention. */
const RangeSchema = z.object({ min: z.number(), max: z.number(), step: z.number() })

/**
 * The values a camera actually takes for a numeric field, when they are a SET
 * rather than a range.
 *
 * `{min,max,step}` cannot say what these two firmwares do. Measured on 1436
 * (I91DN) on 2026-09-22 by writing each value and reading it back:
 *
 * - pre-record: `0, 5, 10, 15, 20, 25, 30` and `2147483647` (INT32_MAX, the
 *   camera's "no limit" — `-1` and `4294967295` both land on it);
 * - post-record: `5, 10, 30, 60, 120, 300, 600`.
 *
 * Neither is expressible as a step: the first has a sentinel two billion away
 * from its neighbours, the second doubles and then jumps. A range that tried
 * would forbid values the camera takes AND permit values it silently replaces
 * with 5 — wrong in both directions at once.
 *
 * `sentinel` names the member that is not a duration, so a surface can render
 * "no limit" instead of `2147483647` seconds.
 */
const AllowedValuesSchema = z.object({
  values: z.array(z.number()).min(1),
  sentinel: z.object({ value: z.number(), meaning: z.enum(['no-limit', 'disabled']) }).optional(),
})
export type OnboardAllowedValues = z.infer<typeof AllowedValuesSchema>

/**
 * Per-field availability on ONE camera.
 *
 * The field exists on every camera — this says whether this one can be
 * read and whether it can be written, and `reason` says why not when
 * either is false. The UI renders the control DISABLED with the reason
 * rather than hiding it, so a limitation is legible instead of looking
 * like a missing feature.
 */
export const OnboardFieldSupportSchema = z.object({
  readable: z.boolean(),
  writable: z.boolean(),
  /** Required whenever `readable` or `writable` is false. */
  reason: z.string().optional(),
})

/** What this camera's schedule model can express. */
export const OnboardScheduleSupportSchema = z.object({
  support: OnboardFieldSupportSchema,
  /**
   * The smallest time step the camera can express, in minutes.
   *
   * Hikvision takes arbitrary minutes (`00:05:00`–`23:57:00` observed on
   * 1436's track 103). Reolink's schedule is a 7×24 HOUR mask, so 60. A
   * window whose edges are not a multiple of this is REFUSED rather than
   * quietly rounded — rounding is how an operator's 06:30 becomes 06:00
   * and nothing says so.
   */
  granularityMinutes: z.number(),
  /** Triggers this camera can record on. A window naming another is refused. */
  triggers: z.array(RecordTriggerSchema),
  /**
   * False when the camera stores ONE trigger per time range, so two
   * windows overlapping on the same day cannot carry different triggers.
   * True on Reolink, whose mask is per-trigger and independent.
   */
  supportsOverlappingTriggers: z.boolean(),
})

export const RecordingOnboardOptionsSchema = z.object({
  enabled: OnboardFieldSupportSchema,
  overwriteWhenFull: OnboardFieldSupportSchema,
  preRecordSec: OnboardFieldSupportSchema,
  preRecordSecRange: RangeSchema.optional(),
  /** Preferred over the range when the camera takes a SET, not a span. */
  preRecordSecAllowed: AllowedValuesSchema.optional(),
  postRecordSec: OnboardFieldSupportSchema,
  postRecordSecRange: RangeSchema.optional(),
  /** Preferred over the range when the camera takes a SET, not a span. */
  postRecordSecAllowed: AllowedValuesSchema.optional(),
  segmentMinutes: OnboardFieldSupportSchema,
  segmentMinutesRange: RangeSchema.optional(),
  /** Preferred over the range when the camera takes a SET, not a span. */
  segmentMinutesAllowed: AllowedValuesSchema.optional(),
  schedule: OnboardScheduleSupportSchema,
})

// ── Patch ────────────────────────────────────────────────────────────

/**
 * A partial change. Every field optional.
 *
 * Unlike the other `deviceConfig` caps, a provider here does **NOT**
 * silently ignore a field it cannot support — it refuses, by name,
 * through {@link describeOnboardRefusal}. Silence on a recording setting
 * is the failure D62 exists to prevent: the operator believes the camera
 * is recording the way the form says, and it is not.
 */
export const RecordingOnboardPatchSchema = z.object({
  enabled: z.boolean().optional(),
  overwriteWhenFull: z.boolean().optional(),
  preRecordSec: z.number().optional(),
  postRecordSec: z.number().optional(),
  segmentMinutes: z.number().optional(),
  /** The complete new window set for the primary track — not a delta. */
  windows: z.array(RecordWindowSchema).optional(),
})

export type RecordTrigger = z.infer<typeof RecordTriggerSchema>
export type RecordWindow = z.infer<typeof RecordWindowSchema>
export type OnboardStorageVolume = z.infer<typeof OnboardStorageVolumeSchema>
export type OnboardStorage = z.infer<typeof OnboardStorageSchema>
export type OnboardRecordTrack = z.infer<typeof OnboardRecordTrackSchema>
export type OnboardFieldSupport = z.infer<typeof OnboardFieldSupportSchema>
export type OnboardScheduleSupport = z.infer<typeof OnboardScheduleSupportSchema>
export type RecordingOnboardStatus = z.infer<typeof RecordingOnboardStatusSchema>
export type RecordingOnboardOptions = z.infer<typeof RecordingOnboardOptionsSchema>
export type RecordingOnboardPatch = z.infer<typeof RecordingOnboardPatchSchema>

export const recordingOnboardCapability = {
  name: 'recording-onboard',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: { kind: 'derived-form', builderId: 'recording-onboard', tab: 'recording' },
  },
  methods: {
    getOptions: method(z.object({ deviceId: z.number() }), RecordingOnboardOptionsSchema),
    setSettings: method(
      z.object({ deviceId: z.number(), settings: RecordingOnboardPatchSchema }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  status: {
    schema: RecordingOnboardStatusSchema,
    kind: 'poll',
  },
  runtimeState: RecordingOnboardStatusSchema,

  /**
   * Runtime-state durability: **restored** — operator-set camera-side
   * recording config; mutation-driven, and the storage half is the last
   * thing the camera said about its own card.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — SD-card configuration and window inventory; arrays.
   */
  history: 'none',
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IRecordingOnboardProvider = InferNativeProvider<typeof recordingOnboardCapability>
