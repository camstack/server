import { z } from 'zod'
import { CamProfileSchema, type CamProfile } from '../capabilities/schemas/streaming-shared.js'
import { FIRST_LEVEL_MACRO_CLASSES } from '../types/labels.js'

/**
 * THE canonical event-clip pad: the time window a single-timestamp analytics
 * event expands to when joined with footage (clip window = `[timestamp - preMs,
 * timestamp + postMs]`). Matches the admin-ui clip window (−5s/+10s).
 *
 * Every consumer derives from this ONE constant so event↔footage boundaries
 * agree everywhere (C1): today that is the `videoclips` default provider
 * (addon-post-analysis), which pads its clip windows with it. The recorder used
 * to pad in-RAM playback markers with it too; those markers had no reader
 * anywhere in the repo and were deleted on 2026-08-29.
 *
 * NOTE: this is a UI/JOIN convention, NOT the `events`-band keep/discard gate —
 * that uses the per-device `preBufferSec`/`postBufferSec` config.
 */
export const EVENT_PAD_MS = { preMs: 5_000, postMs: 10_000 } as const
export type EventPadMs = typeof EVENT_PAD_MS

/**
 * Numeric day-of-week: 0 = Sunday … 6 = Saturday (matches `Date.getDay`).
 * Named `RecordingWeekday` to avoid collision with the string-union
 * `Weekday` exported from `interfaces/timezones.ts`.
 */
export const RecordingWeekdaySchema = z.number().int().min(0).max(6)
export type RecordingWeekday = z.infer<typeof RecordingWeekdaySchema>

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * DERIVED per-camera storage summary — the single field cheap consumers read
 * (the viewer's status dot, the camera list) instead of walking `bands`:
 *  - `off`               — no band covers the camera (or it is disabled).
 *  - `events`            — every band records around triggers only.
 *  - `continuous`        — at least one band records continuously.
 *  - `on-device-decision`— the DEVICE decides: recording runs for as long as the
 *    camera raises its own `recording-signal` level (a robot that cleans). There
 *    is no schedule to author, because there is no hour to program — see
 *    {@link RecordingConfigSchema}`.deviceDecision`.
 *
 * NEVER authored: the recorder stamps it from the authoritative intent
 * (`bands` + `deviceDecision`) on every save (`activeModeForConfig`). Writing it
 * has no effect.
 *
 * `on-device-decision` is named for WHO decides, not for how the recording is
 * requested. `on-demand` was rejected: in this repo's vocabulary a "demand" is
 * something the operator makes (the live gate is the recorder's own "demand
 * window"), and a knob whose name suggests the operator starts it while the
 * device actually does is the D62 shape — a control nobody can predict.
 */
export const RecordingStorageModeSchema = z.enum([
  'off',
  'events',
  'continuous',
  'on-device-decision',
])
export type RecordingStorageMode = z.infer<typeof RecordingStorageModeSchema>

/**
 * The macro classes that can open a recording window — the same
 * three offered by the `object-detection` step, from ONE list
 * ({@link FIRST_LEVEL_MACRO_CLASSES}).
 */
export const RecordingObjectTriggerClassSchema = z.enum(FIRST_LEVEL_MACRO_CLASSES)
export type RecordingObjectTriggerClass = z.infer<typeof RecordingObjectTriggerClassSchema>

/**
 * True when `values` does not repeat an element.
 *
 * A duplicate is not harmless: every entry of `objectClasses` / `sensorDeviceIds`
 * becomes a SOURCE in `bandTriggerSources`, and the same source twice
 * would count its windows twice in `segmentMissedByMs`.
 */
const noDuplicates = <T>(values: readonly T[]): boolean => new Set(values).size === values.length

/**
 * How many source devices a single band can listen to.
 *
 * It is not a whim: every source is a KEY in the recorder's `TriggerState`, and
 * the per-key limit (`MAX_TRIGGER_WINDOWS = 32`) without a limit on the
 * keys would let the map grow with the operator's inventory. 16
 * sensors on ONE camera is already beyond any installation observed.
 */
export const MAX_SENSOR_TRIGGER_DEVICES = 16

/**
 * What the bands editor OFFERS when an operator first ticks "audio above
 * threshold" on a band. Not a schema default: an absent `audioThresholdDbfs`
 * means the audio source is not listened to at all, and it stays absent until
 * asked for.
 *
 * It lived as a bare `-30` inline in `RecordingBandsEditor.tsx`, which is how
 * a calibration hides: unnamed, unexplained, and invisible to any guard. D460
 * gave it a name so the claim below can be read and disagreed with.
 *
 * **Not shifted at the D459 epoch.** `-30 dBFS is loud enough to be worth
 * recording` is a statement about the scale, not a number anybody read off the
 * pre-epoch decoder — there is no recorded measurement behind it, and absent
 * evidence of measurement the provenance test says a scale statement stays put
 * (the reasoning is D460's, and the same answer `SILENCE_FLOOR_DBFS` gets).
 *
 * As with `audioMarkerMinDbfs`, the epoch makes this seed START working rather
 * than become too permissive: on the old scale a PCMU camera had to reach a
 * true -18 dBFS to read -30, so the trigger was nearly dead on 19 of 25
 * cameras. A band seeded with it now fires roughly as the editor implies.
 *
 * @dbfs-era itu
 */
export const RECORDING_AUDIO_TRIGGER_OFFERED_DBFS = -30

/** Which detectors trigger an `events`-mode band. */
// @authored-by-ui
export const RecordingTriggersSchema = z.object({
  motion: z.boolean().optional(),
  audioThresholdDbfs: z.number().optional(),
  /**
   * The macro classes whose detection opens a window. ABSENT = the source
   * is not listened to; an EMPTY array is rejected, because "events band, object
   * trigger on, no class" is the same shape "enabled and records
   * nothing, forever" that `eventsBandCanEverDemand` is written against.
   *
   * The signal read is ALREADY FILTERED: only `source: 'pipeline'` detections, i.e.
   * those that went through `enabledMacroClasses`, the
   * `minConfidence<Macro>` and the full-frame guard. The camera's onboard AI
   * (`source: 'onboard'`) goes through none of those gates and does NOT open
   * windows — see `recorder/object-trigger.ts`.
   */
  objectClasses: z
    .array(RecordingObjectTriggerClassSchema)
    .min(1)
    .refine(noDuplicates, { message: 'objectClasses must not repeat a class' })
    .optional(),
  /**
   * The LINKED devices whose RISING EDGE opens a window. Absent = the source
   * is not listened to; an empty array is rejected for the same reason as
   * `objectClasses`.
   *
   * These are SOURCE device ids, not cameras: the band names them, so the
   * hot path (`DeviceStateChanged`, at bus rate across the whole fleet)
   * does no RPC. The OFFER from which the operator picks them is another question, and
   * is resolved with `deviceManager.getLinkedDevices` + `getBindingsBatch` per
   * device (D12) — never a global list of caps.
   *
   * What "high" means depends on the device TYPE and is not decided here:
   * `SOURCE_CAP_ACTIVE_FIELD` (`catalogs/sensor-active-state.ts`) is THE table,
   * the same one as the composite doorbell (D671). And it is the EDGE, not
   * the level: a contact found already open at runner restart does not
   * record.
   */
  sensorDeviceIds: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_SENSOR_TRIGGER_DEVICES)
    .refine(noDuplicates, { message: 'sensorDeviceIds must not repeat a device' })
    .optional(),
})
// RETIRED 2026-09-07 (D380): `deviceSignal: z.boolean().optional()`, the key
// with which D371 had brought the device signal INSIDE a band. A
// band is a SCHEDULE, and for this function there is no schedule to
// program: the device decides. It became the top-level mode
// `on-device-decision` (`RecordingConfig.deviceDecision`), migrated in
// code by `migrateLegacyDeviceSignalConfig`.
export type RecordingTriggers = z.infer<typeof RecordingTriggersSchema>

/**
 * Mode of a single recording band — the recorder per-band vocabulary.
 *
 * Distinct from `RecordingStorageModeSchema` (which carries `off`): a band is
 * only ever `continuous` or `events`; "off" is expressed by the absence of a
 * covering band, not by a band value.
 */
export const RecordingBandModeSchema = z.enum(['continuous', 'events'])
export type RecordingBandMode = z.infer<typeof RecordingBandModeSchema>

/**
 * Triggers for an `events`-mode band. Identical shape to
 * `RecordingTriggersSchema` — reuse that schema as the band trigger type so the
 * two never drift.
 */
export const RecordingBandTriggersSchema = RecordingTriggersSchema
export type RecordingBandTriggers = z.infer<typeof RecordingBandTriggersSchema>

/**
 * A single mode-per-band window — the canonical recorder band shape, the
 * single source of truth re-used by `addon-pipeline/recorder`.
 *
 * `days` lists the weekdays the band covers (empty = every day, matching the
 * band engine's `applies` rule). `start`/`end` are `HH:MM`; an `end <= start`
 * span wraps past midnight (handled by the band engine).
 */
/**
 * Whether a band's footage carries sound.
 *
 * The recorder has always attached with `audio: 'aac'`, so every band of every
 * camera recorded sound whether anyone wanted it or not. The broker already
 * serves the other answer — `audio: 'none'` takes the video-only `/muted`
 * restream — so this was a choice the product could always have offered.
 *
 * It belongs on the BAND rather than the camera because one camera can want
 * both: silent across the shop floor during opening hours, sound overnight.
 * And it applies to BOTH modes — an events band firing on motion has the same
 * question to answer as a continuous one.
 */
export const RecordingBandAudioSchema = z.enum(['on', 'muted'])
export type RecordingBandAudio = z.infer<typeof RecordingBandAudioSchema>

export const RecordingBandSchema = z.object({
  days: z.array(RecordingWeekdaySchema),
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
  mode: RecordingBandModeSchema,
  /**
   * Sound, or silence. OPTIONAL and absent-means-`on`: every recording
   * written before this existed carried sound, and a band whose key is
   * missing must keep meaning what it meant. See {@link RecordingBandAudioSchema}.
   */
  audio: RecordingBandAudioSchema.optional(),
  triggers: RecordingBandTriggersSchema.optional(),
  /**
   * RETIRED (D381). A band no longer carries a pre-buffer of its own.
   *
   * It was the retroactive KEEP bound — which already-written segments survive
   * a trigger — and it had to be at least as wide as the widest pre-roll the
   * broker could serve, or the gate would delete the seconds the ring had just
   * handed the writer. That "at least as wide as" is the tell: it was a second
   * expression of the broker's retention, in different units, in a different
   * addon, with an invariant the operator had to maintain by hand. The keep
   * bound is now derived from the one prebuffer ceiling and there is nothing
   * left to configure here.
   *
   * The key survives in the SHAPE so a config written before that record still
   * parses and can be migrated deliberately — `RecordingBandSchema` is not
   * strict, so simply deleting it would strip an operator's value in silence on
   * the next save (the failure D380 came one commit from shipping). Nothing
   * reads it: {@link stripRetiredBandPreBufferSec} removes it on load.
   */
  preBufferSec: z.number().min(0).optional(),
  postBufferSec: z.number().min(0).optional(),
})
export type RecordingBand = z.infer<typeof RecordingBandSchema>

/**
 * The buffers an `events` band uses when it carries NONE — i.e. what the Basic
 * recording form persists whenever the operator leaves the pre/post inputs
 * blank, which is the overwhelmingly common case.
 *
 * A zero default is NOT a neutral one, and reading the absent field as `0` is
 * what made two cameras record nothing for weeks: `postBufferSec` is the LIVE
 * demand window, so `0` means the window is already shut by the time the
 * trigger is evaluated. There is no instant at which such a band can attach a
 * writer.
 *
 * `postBufferSec` must therefore exceed one segment length plus the attach
 * latency (ffmpeg spawn + RTSP dial), or the window closes before the first
 * segment is ever finalized and the camera records nothing anyway. At the 10 s
 * default segment length, 30 s leaves room for two full segments.
 *
 * ## There is no `preBufferSec` here any more (D381)
 *
 * There used to be, at 15 s, and its whole justification was that it had to
 * cover the widest pre-roll the broker could serve. A number whose only
 * correct value is another subsystem's ceiling is not a setting; it is that
 * ceiling, restated where it can drift. The keep bound is derived from the
 * prebuffer ceiling directly now, in `band-decision.ts`, so an operator
 * raising the prebuffer cannot walk past the gate at all rather than merely
 * being warned not to.
 */
export const DEFAULT_EVENTS_BAND_BUFFER_SEC = {
  postBufferSec: 30,
} as const
export type DefaultEventsBandBufferSec = typeof DEFAULT_EVENTS_BAND_BUFFER_SEC

/**
 * Drop the RETIRED band `preBufferSec` from a persisted recording config.
 *
 * Explicit, and it reports what it removed, because the alternative is a
 * silent strip: `RecordingBandSchema` is a plain `z.object`, so the key
 * survives a parse and disappears on the next save with no line anywhere. An
 * operator who had typed a number would find it gone and nothing would say
 * when or why.
 *
 * Nothing is carried forward: the value it held was always required to be at
 * least the broker's widest pre-roll, and the gate is now derived from exactly
 * that ceiling. Every configuration that was legal therefore keeps a keep-gate
 * at least as wide as the one it had — including an explicit `0`, which widens.
 * That is deliberate and it is the only behaviour change: a band that kept
 * nothing before its trigger now keeps up to the prebuffer ceiling of
 * already-written footage, which is media that exists either way.
 */
export function stripRetiredBandPreBufferSec(config: RecordingConfig): {
  readonly config: RecordingConfig
  /** Index of every band a value was removed from. Empty = nothing to do. */
  readonly strippedBands: readonly number[]
} {
  const strippedBands: number[] = []
  const bands = config.bands.map((band, index) => {
    if (band.preBufferSec === undefined) return band
    strippedBands.push(index)
    const { preBufferSec: _retired, ...rest } = band
    return rest
  })
  if (strippedBands.length === 0) return { config, strippedBands }
  return { config: { ...config, bands }, strippedBands }
}

/**
 * Adjacent recorded ranges closer than this belong to the SAME videoclip visit.
 *
 * This is NOT the recorder calendar merge (`RANGE_MERGE_GAP_MS = 5s`). That
 * threshold is for the timeline bar, which must show exact holes — including
 * the ~8s GOP/keyframe rolls measured on events-mode cameras (dispensa 1438,
 * 2026-08-16). A videoclip is the events-mode keep-window (writer session),
 * whose idle bound is `postBufferSec`. Using that default (30s) glues those
 * intra-visit holes without joining visits hours apart.
 *
 * Segments stay the source of truth on disk (`startMs-durMs-bytes.m4s`); a
 * visit is derived, not a second copy of the files.
 */
export const VISIT_MERGE_GAP_MS = DEFAULT_EVENTS_BAND_BUFFER_SEC.postBufferSec * 1000
export type VisitMergeGapMs = typeof VISIT_MERGE_GAP_MS

/**
 * Per-device retention overrides. Every field is optional; an unset or `0`
 * value inherits the node-wide recorder default. Only footage-lifetime limits
 * live per-camera: `maxAgeDays` and `maxSizeGb`. The disk-occupancy threshold
 * (when the volume is too full to keep recording) is NOT a per-camera concern —
 * it belongs to the StorageLocation (`StorageLocation.config.minFreePercent`),
 * shared by every camera writing to that volume.
 */
export const RecordingRetentionSchema = z.object({
  maxAgeDays: z.number().min(0).optional(),
  maxSizeGb: z.number().min(0).optional(),
})
export type RecordingRetention = z.infer<typeof RecordingRetentionSchema>

/**
 * The full per-camera recording intent — the wire shape of a RecordingTarget.
 *
 * `bands` is the ONLY authored recording intent: what to record, when, and on
 * which trigger. `mode` is a derived summary the recorder stamps on save; every
 * other field is a storage knob (profiles, segment length, retention, scrub).
 *
 * STRICT on purpose: the legacy authoring surface (`schedule`/`schedules`/
 * `triggers`/`preBufferSec`/`postBufferSec`/`rules`) was retired 2026-07-30,
 * and `scrubThumbnails` — a five-step fidelity knob for a sprite tier that was
 * deleted on 2026-07-24 and had ZERO consumers in the recorder — on 2026-08-25
 * (D62: a switch that writes a store nobody reads is worse than no switch).
 * Stored rows keep loading: the READ schema is `.strip()` (config-store.ts).
 * A stale caller must fail loudly — silently stripping its legacy intent would
 * persist a band-less config, i.e. silently stop recording the camera.
 */
export const RecordingConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** DERIVED summary of `bands`, stamped by the recorder on every save.
     *  Authoring it has no effect — see {@link RecordingStorageModeSchema}. */
    mode: RecordingStorageModeSchema.optional(),
    /**
     * Which assigned broker slots to record. Absent / empty = {@link
     * DEFAULT_RECORDING_PROFILES} (`high`+`low`) intersected with the
     * camera's currently assigned slots — never `mid` unless the operator
     * picks it, and never a slot the broker has not assigned.
     */
    profiles: z.array(CamProfileSchema).optional(),
    segmentSeconds: z.number().int().positive().optional(),
    /**
     * AUTHORITATIVE mode-per-band recording model — the single source of truth
     * the recorder's band engine consumes. An empty array = record nothing;
     * "off" is the absence of a covering band, never a band value.
     */
    bands: z.array(RecordingBandSchema).default([]),
    /**
     * THE device-decided intent: record for as long as the camera itself raises
     * `recording-signal` (`active: true` while the device is in function — a
     * robot that cleans). AUTHORED, unlike `mode`, and the only authored
     * recording intent that is not a band.
     *
     * It carries NO schedule on purpose. A band is an HOUR, and this feature has
     * no hour to program: the device decides. What it costs the operator is one
     * flag — "this camera can record on its own" — and what it buys is the same
     * hold/release the recorder already implements (D371, `holdTrigger` /
     * `releaseTrigger`): the window opens on the rise, stays open for the whole
     * job however long it is, and closes one pad after the fall.
     *
     * EXCLUSIVE with `bands` (below): two authorities deciding when the same
     * camera records is the D62 failure. `off` remains `enabled: false`, so an
     * operator switching this camera off is REPORTED off, never as broken.
     */
    deviceDecision: z.boolean().optional(),
    retention: RecordingRetentionSchema.optional(),
  })
  .strict()
  .refine((config) => config.deviceDecision !== true || config.bands.length === 0, {
    message:
      'deviceDecision is a whole-config mode and carries no schedule: it cannot be combined with bands',
    path: ['bands'],
  })
export type RecordingConfig = z.infer<typeof RecordingConfigSchema>

/** The authored intent a mode is derived from — all {@link deriveRecordingMode} reads. */
export type RecordingModeSource = Pick<RecordingConfig, 'enabled' | 'bands' | 'deviceDecision'>

/**
 * Derive the {@link RecordingStorageModeSchema} summary from the authoritative
 * bands: `continuous` when any band records continuously, `events` when a band
 * exists at all, else `off`. Pure.
 *
 * THE one definition: the recorder stamps `config.mode` with it on save and
 * reports it as the cap's `activeMode`, and the settings UI reads it back to
 * highlight the Off/Events/Continuous shortcut. Two copies would drift, and the
 * symptom (a status dot disagreeing with what is being recorded) is exactly the
 * bug this field was added to fix.
 */
export function deriveRecordingMode(config: RecordingModeSource): RecordingStorageMode {
  if (!config.enabled) return 'off'
  // Checked BEFORE the band count, because this mode's whole point is that it
  // has none: reading a band-less device-decision config as `off` is exactly
  // the "disabled must never look like broken" inversion D62 forbids.
  if (config.deviceDecision === true) return 'on-device-decision'
  if (config.bands.length === 0) return 'off'
  if (config.bands.some((band) => band.mode === 'continuous')) return 'continuous'
  return 'events'
}

/**
 * Default recorded slots when a config omits `profiles`: high + low.
 * `mid` is opt-in — it is usually a second native encode the operator
 * did not ask to store twice.
 */
export const DEFAULT_RECORDING_PROFILES: readonly CamProfile[] = ['high', 'low']

/**
 * Pick which assigned broker slots to record. `assigned` is already the
 * broker's assigned∩deduped set (see `selectAssignedProfileSlots`).
 *
 * An operator `override` DISABLES unselected assigned slots (assigned ∩
 * selection). A selection matching none of the assigned sources, or an
 * absent/empty override, falls through: prefer {@link DEFAULT_RECORDING_PROFILES}
 * among assigned, else every assigned slot (a camera with only `mid`
 * still records something). Empty assigned → empty result.
 */
export function resolveRecordingProfiles(
  assigned: readonly CamProfile[],
  override: readonly CamProfile[] | undefined,
): CamProfile[] {
  if (override !== undefined && override.length > 0) {
    const selected = assigned.filter((profile) => override.includes(profile))
    return selected.length > 0 ? selected : [...assigned]
  }
  const preferred = assigned.filter((profile) => DEFAULT_RECORDING_PROFILES.includes(profile))
  return preferred.length > 0 ? preferred : [...assigned]
}

// ── D371 → D380 migration: `triggers.deviceSignal` becomes a MODE ────────────

/** What {@link migrateLegacyDeviceSignalConfig} did to one stored row. */
export interface LegacyDeviceSignalMigration {
  /** The row to persist/parse. The SAME reference when nothing was legacy. */
  readonly value: unknown
  /** The config now says `deviceDecision: true` — the mode was recovered. */
  readonly migrated: boolean
  /**
   * The legacy key was on a band that ALSO listened to something else (motion,
   * a sensor …), so the key was dropped and the band kept. The camera keeps its
   * other triggers and LOSES the device signal until an operator picks the new
   * mode — the honest outcome: folding a mixed band into a mode would silently
   * delete a schedule the operator authored.
   */
  readonly strippedOnly: boolean
}

/** Trigger keys that survive D380 — a band carrying one of these is a real band. */
const SURVIVING_TRIGGER_KEYS: readonly string[] = [
  'motion',
  'audioThresholdDbfs',
  'objectClasses',
  'sensorDeviceIds',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function listensToLegacySignal(band: unknown): boolean {
  return isRecord(band) && isRecord(band.triggers) && band.triggers.deviceSignal === true
}

function hasSurvivingTrigger(band: Record<string, unknown>): boolean {
  const triggers = band.triggers
  if (!isRecord(triggers)) return false
  return SURVIVING_TRIGGER_KEYS.some((key) => triggers[key] !== undefined)
}

function withoutLegacySignal(band: Record<string, unknown>): Record<string, unknown> {
  const triggers = band.triggers
  if (!isRecord(triggers)) return band
  const { deviceSignal: _retired, ...rest } = triggers
  return { ...band, triggers: rest }
}

/**
 * Turn a config stored under D371 (`bands[].triggers.deviceSignal: true`) into
 * a D380 one (`deviceDecision: true`, no bands). Pure, total and IDEMPOTENT —
 * a row with no legacy key comes back as the SAME reference, `migrated: false`.
 *
 * ## Why the schema cannot be left to do this
 *
 * `RecordingTriggersSchema` is a non-strict `z.object`, so the retired key is
 * SILENTLY STRIPPED on read. The camera whose only trigger it was would parse
 * cleanly into an `events` band that lists nothing — "enabled, and records
 * nothing, forever", the exact shape `eventsBandCanEverDemand` exists to shout
 * about, reached without a single line in the log. On the reference hub that is
 * camera 4374, the one camera an operator had configured by hand.
 *
 * `enabled` is carried through untouched: a camera the operator had switched
 * OFF comes out of a migration still off (D62).
 */
export function migrateLegacyDeviceSignalConfig(raw: unknown): LegacyDeviceSignalMigration {
  const unchanged: LegacyDeviceSignalMigration = {
    value: raw,
    migrated: false,
    strippedOnly: false,
  }
  if (!isRecord(raw) || !Array.isArray(raw.bands)) return unchanged
  if (!raw.bands.some(listensToLegacySignal)) return unchanged
  const kept: unknown[] = []
  for (const band of raw.bands) {
    if (!listensToLegacySignal(band) || !isRecord(band)) {
      kept.push(band)
      continue
    }
    // A band that existed ONLY to carry the signal becomes the mode; one that
    // also listened to something else stays a band, minus the retired key.
    if (hasSurvivingTrigger(band)) kept.push(withoutLegacySignal(band))
  }
  if (kept.length > 0) {
    return { value: { ...raw, bands: kept }, migrated: false, strippedOnly: true }
  }
  // `mode` is dropped rather than recomputed here: it is derived on save, and a
  // stale `"events"` read back by a cheap consumer is exactly the disagreement
  // between the status dot and the footage this field was added to end.
  const { mode: _derived, ...rest } = raw
  return {
    value: { ...rest, bands: [], deviceDecision: true },
    migrated: true,
    strippedOnly: false,
  }
}
