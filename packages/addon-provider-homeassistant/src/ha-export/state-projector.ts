/**
 * Pipeline / notification-center output → `{topic, value}`.
 *
 * Pure. This is where `last_detection`, `last_label` and the per-zone
 * counts become state, and it is the half of the export the operator's
 * requirement lands on: **every value has a listener in the addon that
 * publishes it.** Nothing in Home Assistant polls camstack — each
 * function here is the projection of ONE internal source, and the addon
 * subscribes to that source.
 *
 * Every value is a STRING. The component lowercases binary values
 * verbatim; a JSON number or boolean raises inside its state callback,
 * which it swallows — so the entity silently never updates again.
 */
import { COCO_TO_MACRO } from '@camstack/types'
import {
  CAP_ENTITY_MAP,
  capEntities,
  type CapEntityDescriptor,
  deriveCapValue,
  EXPORTED_MACROS,
  LABELLED_MACROS,
  ZONE_MACROS,
} from './entity-catalog.js'
import { derivedEntityId, stateTopic, toSlug } from './topics.js'
import type { StateValue } from './types.js'

export type { StateValue }

/**
 * A detection class → the macro an operator automates on.
 *
 * Returns `null` rather than a fallback: the executor drops classes with
 * no macro upstream (`preserveOriginal: false`), so one arriving here is
 * a contract break, and inventing a macro for it would put a toothbrush
 * on the person sensor.
 */
export function macroOf(className: string): string | null {
  const lower = className.toLowerCase()
  if (EXPORTED_MACROS.includes(lower)) return lower
  const mapped = COCO_TO_MACRO.mapping[lower]
  return typeof mapped === 'string' ? mapped : null
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString()
}

function bool(value: boolean): string {
  return value ? 'true' : 'false'
}

// ── The derived half: one projector for every mapped capability ─────────

/**
 * The projection succeeded. `values` is empty when the slice carries the
 * field and its value is `null` — "never observed" is a reading Home
 * Assistant renders as `unknown`, which is honest, and publishing `0` or
 * an empty string in its place is what makes an operator distrust the
 * integration.
 */
export interface CapProjectionValues {
  readonly kind: 'values'
  /** The derived entity id, for the caller's log line. */
  readonly entity: string
  readonly values: readonly StateValue[]
  /**
   * EXTRA entities whose field the slice does not carry. Present only when
   * non-empty. An extra the cap declares optional (`day-night.sensitivity`
   * on a vendor without a photocell) must not silence the PRIMARY — it
   * did, and "Camera sala da pranzo" never received a `mode` — but it
   * is still named so the caller can say, once, which entity stays empty.
   */
  readonly missingFields?: readonly string[]
}

/** The capability produces no state entity. Not a drop: there is nothing to send. */
export interface CapProjectionNoEntity {
  readonly kind: 'no-entity'
  readonly capName: string
}

/**
 * The entity EXISTS and the slice does not carry the field it reads.
 *
 * This is dropped work and the caller logs it: an entity in an
 * operator's Home Assistant that can never receive a value is the exact
 * defect this projector was written to end, and the only way to see it
 * from outside is to say so. `sliceFields` names what the slice DID
 * carry, so the fix is one line of a log away.
 */
export interface CapProjectionMissingField {
  readonly kind: 'missing-field'
  readonly capName: string
  readonly field: string
  readonly sliceFields: readonly string[]
}

/** The field is there and its value is not a shape this platform can carry. */
export interface CapProjectionUnrenderable {
  readonly kind: 'unrenderable'
  readonly capName: string
  readonly field: string
  readonly valueType: string
}

export type CapProjection =
  | CapProjectionValues
  | CapProjectionNoEntity
  | CapProjectionMissingField
  | CapProjectionUnrenderable

/**
 * A value → the string Home Assistant's platform expects.
 *
 * Exhaustive over `HaPlatform` so a new platform cannot be added
 * without deciding what its values look like. Every value is a STRING:
 * the component lowercases binary values verbatim and a JSON number or
 * boolean raises inside its state callback, which it swallows — so the
 * entity silently never updates again.
 */
function renderCapValue(mapping: CapEntityDescriptor, raw: unknown): string | null {
  switch (mapping.platform) {
    case 'binary_sensor':
    case 'switch':
      return typeof raw === 'boolean' ? bool(raw) : null
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : null
    case 'sensor':
      // A timestamp sensor is fed a ms epoch by every camstack slice that has
      // one; HA parses ISO-8601 and renders a raw epoch as `unknown`.
      if (mapping.deviceClass === 'timestamp') {
        if (typeof raw === 'number' && Number.isFinite(raw)) return iso(raw)
        return typeof raw === 'string' ? raw : null
      }
      if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null
      if (typeof raw === 'string') return raw
      return typeof raw === 'boolean' ? bool(raw) : null
    case 'select':
    case 'alarm_control_panel':
    case 'image':
    case 'camera':
      return typeof raw === 'string' ? raw : null
    case 'button':
      // A button is write-only; the catalog gives it no `state_topic`.
      return null
    case 'cover':
    case 'climate':
    case 'lock':
    case 'fan':
    case 'vacuum':
    case 'valve':
    case 'humidifier':
    case 'water_heater':
    case 'media_player':
      /**
       * A native platform carries no value of its own. It is built from
       * the topics of the DEGRADED descriptors — which are the ones this
       * function renders — so `CAP_ENTITY_MAP` never names one, and a
       * descriptor that did would be publishing to a topic no entity
       * reads. `null` here is `unrenderable`, which the addon LOGS: the
       * loud failure is the point.
       */
      return null
  }
}

/**
 * One capability slice → the derived entity's value.
 *
 * **This is the push path every derived capability was missing.** The
 * addon used to handle four caps by hand (`device-status`, `battery`,
 * `doorbell`, `motion`) and the other 23 entries in `CAP_ENTITY_MAP` had
 * no push path at all — they moved only on the 300 s reconcile, and the
 * ones whose topics disagreed with the catalog never moved at all. This
 * is descriptor-driven, so a capability T3 adds to `CAP_ENTITY_MAP`
 * arrives with its push path already built.
 */
export function projectCapSlice(
  deviceKey: string,
  capName: string,
  slice: Readonly<Record<string, unknown>>,
): CapProjection {
  const mapping = CAP_ENTITY_MAP[capName]
  if (mapping === undefined) return { kind: 'no-entity', capName }
  const entity = derivedEntityId(capName)
  const values: StateValue[] = []
  /**
   * Every entity the capability produces, not just its primary. A `cover`
   * is a state AND a position, and projecting only the first would leave
   * the second in Home Assistant's registry with nothing arriving on it —
   * which is precisely the defect the descriptor table replaced.
   */
  const missingFields: string[] = []
  for (const ref of capEntities(capName)) {
    // Write-only: the catalog gives a button no state topic.
    if (ref.descriptor.platform === 'button') continue
    if (!Object.prototype.hasOwnProperty.call(slice, ref.descriptor.field)) {
      // The PRIMARY missing is the cap not being what the catalog says it
      // is — dropped work, reported as such. An EXTRA missing is skipped and
      // named: its siblings still publish.
      if (ref.entity === entity) {
        return {
          kind: 'missing-field',
          capName,
          field: ref.descriptor.field,
          sliceFields: Object.keys(slice),
        }
      }
      missingFields.push(ref.descriptor.field)
      continue
    }
    const raw = slice[ref.descriptor.field]
    // "Never observed" is a reading HA renders as `unknown`, which is
    // honest — and it must not stop the SIBLING entities being published.
    if (raw === null || raw === undefined) continue
    const rendered = renderCapValue(ref.descriptor, deriveCapValue(ref.descriptor.derive, raw))
    if (rendered === null) {
      return { kind: 'unrenderable', capName, field: ref.descriptor.field, valueType: typeof raw }
    }
    values.push({ topic: stateTopic(deviceKey, ref.entity), value: rendered })
  }
  if (mapping.platform === 'button' && mapping.extras === undefined) {
    return { kind: 'no-entity', capName }
  }
  return missingFields.length > 0
    ? { kind: 'values', entity, values, missingFields }
    : { kind: 'values', entity, values }
}

// ── device-status ───────────────────────────────────────────────────────

/**
 * Reachability.
 *
 * `device.sleeping` deliberately does NOT feed this: a battery camera in
 * low-power mode is reachable on demand, and marking it unavailable
 * would break every automation that wakes it.
 */
export function projectDeviceStatus(deviceKey: string, online: boolean): readonly StateValue[] {
  return [{ topic: stateTopic(deviceKey, 'online'), value: bool(online) }]
}

// ── motion ──────────────────────────────────────────────────────────────

export interface MotionInput {
  readonly detected: boolean
  /** `null` when the source has no PLAUSIBLE instant to report — a cold
   *  placeholder, or a seeded "known value, unknown change time" stamp
   *  (e.g. Homematic's `HM_SEEDED_CHANGED_AT`). Never fabricate `now()`
   *  here; the caller already made that call once. */
  readonly timestamp: number | null
}

export function projectMotion(deviceKey: string, input: MotionInput): readonly StateValue[] {
  const values: StateValue[] = [
    { topic: stateTopic(deviceKey, 'motion_detected'), value: bool(input.detected) },
    { topic: stateTopic(deviceKey, 'triggered'), value: bool(input.detected) },
  ]
  /**
   * A clearing edge carries no timestamp. `last_detection` answers "when
   * did something last happen", and restamping it when nothing happened
   * makes an idle camera look permanently busy. Same for a detection whose
   * timestamp is unknown or implausible — omitted rather than published as
   * a lie the automation author would trust.
   */
  if (input.detected && input.timestamp !== null) {
    values.push({
      topic: stateTopic(deviceKey, 'motion_last_detection'),
      value: iso(input.timestamp),
    })
  }
  return values
}

// ── track lifecycle ─────────────────────────────────────────────────────

/**
 * The single richest internal event: class, zone, identity, plate and the
 * media key in one payload. One subscription feeds most of a camera's
 * catalog.
 */
export interface TrackLifecycleInput {
  readonly deviceId: number
  readonly trackId: string
  readonly phase: 'start' | 'update' | 'end'
  readonly classes: readonly string[]
  readonly bestClassName?: string
  readonly bestConfidence?: number
  readonly label?: string
  readonly plateText?: string
  readonly lastSeen: number
  readonly zonesVisited?: readonly string[]
  /** D683: set on the `end` of a piece L2 fused into another track — the
   *  subject is still in view under this id. */
  readonly fusedIntoTrackId?: string
}

/**
 * @param mediaUrl a signed, expiring URL for this track's best crop, or
 *   `null` when there is none yet. Images NEVER cross the transport —
 *   camstack mints the URL and HA fetches the bytes on demand.
 */
export function projectTrackLifecycle(
  deviceKey: string,
  track: TrackLifecycleInput,
  mediaUrl: string | null,
): readonly StateValue[] {
  // D683: a fused piece's `end` is not the subject leaving — it continues
  // under `fusedIntoTrackId`, whose own `update`/`end` drive the entities.
  // Publishing it would flip `<macro>_detected` / `triggered` false
  // mid-presence until the survivor's next debounced update.
  if (track.phase === 'end' && track.fusedIntoTrackId !== undefined) return []
  const className = track.bestClassName ?? track.classes[0]
  if (className === undefined) return []
  const macro = macroOf(className)
  if (macro === null) return []

  const active = track.phase !== 'end'
  const values: StateValue[] = [
    { topic: stateTopic(deviceKey, `${macro}_detected`), value: bool(active) },
    { topic: stateTopic(deviceKey, 'triggered'), value: bool(active) },
  ]

  if (active) {
    values.push(
      { topic: stateTopic(deviceKey, `${macro}_last_detection`), value: iso(track.lastSeen) },
      { topic: stateTopic(deviceKey, 'last_detection'), value: iso(track.lastSeen) },
    )
  }

  /**
   * The identification: the recognised face for `person`, the plate for
   * `vehicle`, the sub-class for `animal`. `package`, `motion` and
   * `audio` have no label and the entity does not exist for them — so a
   * label arriving on one of those is dropped rather than published to a
   * topic nothing is subscribed to.
   */
  const label = track.plateText ?? track.label
  if (label !== undefined && label.length > 0 && LABELLED_MACROS.includes(macro)) {
    values.push({ topic: stateTopic(deviceKey, `${macro}_last_label`), value: label })
    /**
     * The occurrence STAMP. A second recognition of the same person is a
     * real occurrence, but it is invisible on `_last_label`: the push
     * client dedups per topic, and an identical value is not a state
     * change in Home Assistant anyway — a state-trigger automation would
     * never re-fire. The stamp is the value that always moves, so an
     * automation binds its trigger HERE and reads `<macro>_last_label`
     * for the name — which is ordered BEFORE the stamp in this array, so
     * it is already applied when the trigger fires. HA's `event` platform
     * would be the native home for this, but no released component builds
     * it (`component-support.ts`): announcing one yields a warning in
     * HA's log and NO entity — the exact D152 zero-entities failure.
     */
    values.push({
      topic: stateTopic(deviceKey, `${macro}_last_label_at`),
      value: iso(track.lastSeen),
    })
  }

  if (mediaUrl !== null) {
    values.push(
      { topic: stateTopic(deviceKey, 'last_image'), value: mediaUrl },
      { topic: stateTopic(deviceKey, `${macro}_last_image`), value: mediaUrl },
    )
  }

  if (ZONE_MACROS.includes(macro)) {
    for (const zoneId of track.zonesVisited ?? []) {
      const slug = toSlug(zoneId)
      values.push({
        topic: stateTopic(deviceKey, `${slug}_${macro}_detected`),
        value: bool(active),
      })
      if (active) {
        values.push({
          topic: stateTopic(deviceKey, `${slug}_${macro}_last_detection`),
          value: iso(track.lastSeen),
        })
      }
      if (mediaUrl !== null) {
        values.push({
          topic: stateTopic(deviceKey, `${slug}_${macro}_last_image`),
          value: mediaUrl,
        })
      }
    }
  }

  return values
}

// ── zone occupancy ──────────────────────────────────────────────────────

export interface ZoneBreakdown {
  readonly zoneId: string
  readonly totalObjects: number
  readonly byClass: Readonly<Record<string, number>>
}

export interface ZoneOccupancyInput {
  readonly zones: readonly ZoneBreakdown[]
  /**
   * The FRAME-WIDE aggregate — everything on camera, in a zone or not, and
   * including confirmed stationary objects (they are still there). Absent on a
   * snapshot that carried no `frame` scope; the scene entities are then left
   * alone rather than published as zero, which would read as "the scene
   * emptied" on a payload that simply did not say.
   */
  readonly scene?: ScopeBreakdown
}

export interface ScopeBreakdown {
  readonly totalObjects: number
  readonly byClass: Readonly<Record<string, number>>
}

/**
 * Per-zone counts.
 *
 * A macro with nobody in the zone publishes `0`, not nothing: an entity
 * that goes silent renders in HA as its last value, so a driveway that
 * emptied would read as still occupied until someone walked through it
 * again.
 */
export function projectZoneOccupancy(
  deviceKey: string,
  input: ZoneOccupancyInput,
): readonly StateValue[] {
  const values: StateValue[] = []
  for (const zone of input.zones) {
    const slug = toSlug(zone.zoneId)
    // The zone TOTAL is not the sum of the macro entities below: a zone holds
    // classes that map to no exported macro, and an operator asking "is anyone
    // in the driveway" wants the honest count, not the count of the three
    // classes this catalog happens to fan out.
    values.push({
      topic: stateTopic(deviceKey, `${slug}_objects`),
      value: String(zone.totalObjects),
    })
    const totals = new Map<string, number>(ZONE_MACROS.map((macro) => [macro, 0]))
    for (const [className, count] of Object.entries(zone.byClass)) {
      const macro = macroOf(className)
      if (macro === null || !totals.has(macro)) continue
      totals.set(macro, (totals.get(macro) ?? 0) + count)
    }
    for (const [macro, count] of totals) {
      values.push({
        topic: stateTopic(deviceKey, `${slug}_${macro}_objects`),
        value: String(count),
      })
    }
  }
  if (input.scene !== undefined) {
    values.push({
      topic: stateTopic(deviceKey, 'objects'),
      value: String(input.scene.totalObjects),
    })
    const totals = new Map<string, number>(EXPORTED_MACROS.map((macro) => [macro, 0]))
    for (const [className, count] of Object.entries(input.scene.byClass)) {
      const macro = macroOf(className)
      if (macro === null || !totals.has(macro)) continue
      totals.set(macro, (totals.get(macro) ?? 0) + count)
    }
    for (const [macro, count] of totals) {
      values.push({
        topic: stateTopic(deviceKey, `${macro}_objects`),
        value: String(count),
      })
    }
  }
  return values
}

// ── battery ─────────────────────────────────────────────────────────────

export interface BatterySliceInput {
  /** `null` = NOT YET KNOWN — publish nothing rather than a made-up 0. */
  readonly percentage: number | null
  readonly charging: string
  readonly sleeping: boolean
  /** The source is a LOW-BATTERY INDICATOR, not a charge level. */
  readonly binary?: boolean
}

export function projectBatterySlice(
  deviceKey: string,
  slice: BatterySliceInput,
): readonly StateValue[] {
  const values: StateValue[] = [
    { topic: stateTopic(deviceKey, 'sleeping'), value: bool(slice.sleeping) },
  ]
  // An UNKNOWN power source publishes no charger state: `!== 'none'` would
  // turn "nobody has read the adapter yet" into a charger plugged in.
  if (slice.charging !== 'unknown') {
    values.push({ topic: stateTopic(deviceKey, 'charger'), value: bool(slice.charging !== 'none') })
  }
  /**
   * `binary: true` means the device reports "low" or "not low" and the
   * percentage is a stand-in. Publishing it would put a fabricated
   * number on a battery gauge, which is worse than an empty one.
   *
   * A `null` percentage is the same judgement for a different reason: the
   * level is NOT YET KNOWN. `String(null)` would publish the text "null" onto
   * that gauge, and coercing it to 0 would publish a flat battery.
   */
  if (slice.binary !== true && slice.percentage !== null) {
    values.push({ topic: stateTopic(deviceKey, 'battery'), value: String(slice.percentage) })
  }
  return values
}

// ── network link ────────────────────────────────────────────────────────

export interface NetworkLinkSliceInput {
  /** `'unknown'` = not read yet — publish nothing rather than a made-up link. */
  readonly type: string
  /** `null` = not known or not applicable (a wired link has no signal). */
  readonly signalPercent: number | null
}

/**
 * The device's own link: which medium it is on and, for a wireless one, how
 * strong. An `unknown` type publishes nothing — it is the absence of a read,
 * and a wire drawn from it would be a lie the same way a 0 % battery was. A
 * `null` signal publishes no signal entity value: wired links have none, and
 * a wireless one not yet read must not sit at 0 %.
 */
export function projectNetworkLinkSlice(
  deviceKey: string,
  slice: NetworkLinkSliceInput,
): readonly StateValue[] {
  if (slice.type === 'unknown') return []
  const values: StateValue[] = [{ topic: stateTopic(deviceKey, 'link'), value: slice.type }]
  if (slice.signalPercent !== null) {
    values.push({
      topic: stateTopic(deviceKey, 'signal'),
      value: String(Math.round(slice.signalPercent)),
    })
  }
  return values
}

// ── camera functions ────────────────────────────────────────────────────

export interface CameraFunctionInput {
  readonly id: string
  readonly label: string
  readonly available: boolean
  readonly enabled: boolean
}

/**
 * The per-camera function switches, mirrored 1:1 from
 * `deriveCameraFunctions` (`camera-functions.ts`) — the pure derivation over
 * the AUTHORITIES that own each function, replacing the deprecated
 * `pipelineOrchestrator.getCameraSwitches` group (D113 phase 4).
 *
 * An UNAVAILABLE function publishes nothing, because `enabled` is
 * meaningless when `available` is false — a source that did not answer
 * must never become a control rendered `on`.
 */
export function projectCameraFunctions(
  deviceKey: string,
  functions: readonly CameraFunctionInput[],
): readonly StateValue[] {
  return functions
    .filter((fn) => fn.available)
    .map((fn) => ({
      topic: stateTopic(deviceKey, toSlug(fn.id)),
      value: bool(fn.enabled),
    }))
}

// ── doorbell ────────────────────────────────────────────────────────────

export interface DoorbellSliceInput {
  /** Ms epoch of the last press. `null` = never observed since the provider started. */
  readonly lastPressedAt: number | null
  readonly pressCountSinceStart: number
}

/**
 * The doorbell slice → its three entities.
 *
 * A press is a PULSE: the slice carries `lastPressedAt`, never a
 * `pressed: true/false`. `doorbell_pressed` is therefore driven by the
 * caller, which knows whether this projection is a fresh press or a
 * reconcile re-read — the same shape `projectMotion` already uses, and the
 * reason the flag is a parameter rather than derived from a timestamp
 * comparison here (a pure function that reads the clock is a pure function
 * that behaves differently in a test).
 *
 * `lastPressedAt: null` publishes NOTHING for the timestamp: HA renders an
 * empty timestamp sensor as `unknown`, which is honest, whereas `0` would
 * render as 1 January 1970 on the operator's dashboard.
 */
export function projectDoorbellSlice(
  deviceKey: string,
  slice: DoorbellSliceInput,
  pressed: boolean,
): readonly StateValue[] {
  const values: StateValue[] = [
    { topic: stateTopic(deviceKey, 'doorbell_pressed'), value: bool(pressed) },
    {
      topic: stateTopic(deviceKey, 'doorbell_press_count'),
      value: String(slice.pressCountSinceStart),
    },
  ]
  if (slice.lastPressedAt !== null) {
    values.push({
      topic: stateTopic(deviceKey, 'doorbell_last_pressed'),
      value: new Date(slice.lastPressedAt).toISOString(),
    })
  }
  return values
}

// ── audio ───────────────────────────────────────────────────────────────

export interface AudioWindowInput {
  /** Classified sounds in this window, strongest first is NOT assumed. */
  readonly detections: readonly { readonly className: string; readonly confidence: number }[]
  /** Window level metrics. Absent when the analyzer reported none. */
  readonly dbfs?: number
  /** Linear RMS amplitude for the same window. */
  readonly rms?: number
}

/**
 * One audio window → the audio entities.
 *
 * This is the source the catalog's `audio_detected` was always missing.
 * It had only the track lifecycle, which rarely carries an audio macro, so
 * the entity existed and effectively never moved — the note in this
 * package's CLAUDE.md said so without naming the event. The event is
 * `pipeline.audio-inference-result`, and it carries both halves an
 * operator asks for: WHAT was heard and HOW LOUD.
 *
 * The label is the HIGHEST-CONFIDENCE detection of the window, not the
 * first: the analyzer's array order is its own business and depending on
 * it would make the exported label change with an unrelated refactor.
 *
 * A window with no detections publishes NO label. It does not publish an
 * empty string: HA renders that as a valid state, so a quiet minute would
 * blank the last thing heard instead of leaving it — and "what was that
 * noise" is asked after the noise has stopped.
 *
 * The level is published on EVERY window, silence included. That is the
 * point of a volume entity: a flat line is a reading, and dBFS is
 * negative-going (0 = full scale), so no value can be mistaken for one.
 */
export function projectAudioWindow(
  deviceKey: string,
  input: AudioWindowInput,
): readonly StateValue[] {
  const values: StateValue[] = []
  if (input.dbfs !== undefined && Number.isFinite(input.dbfs)) {
    values.push({
      topic: stateTopic(deviceKey, 'audio_volume'),
      value: String(Math.round(input.dbfs * 10) / 10),
    })
  }
  // RMS is linear and small — rounding it to one decimal like dBFS would
  // collapse every quiet window to `0`, so it keeps the precision the reading
  // actually has.
  if (input.rms !== undefined && Number.isFinite(input.rms)) {
    values.push({
      topic: stateTopic(deviceKey, 'audio_level_rms'),
      value: String(Math.round(input.rms * 10000) / 10000),
    })
  }
  const best = input.detections.reduce<{ className: string; confidence: number } | null>(
    (top, d) => (top === null || d.confidence > top.confidence ? d : top),
    null,
  )
  /**
   * `audio_detected` — the source it never had. The catalog's comment used
   * to claim this window was already feeding it; it was not (grep found no
   * publisher), and that comment was a leftover describing the right design
   * while being false. This window is the fix: it raises on any window that
   * carries a classification and lowers on a quiet one, WITHOUT clearing
   * `audio_last_sound` — "what was that noise" is asked after the noise has
   * stopped.
   */
  values.push({ topic: stateTopic(deviceKey, 'audio_detected'), value: bool(best !== null) })
  if (best !== null) {
    values.push({ topic: stateTopic(deviceKey, 'audio_last_sound'), value: best.className })
  }
  return values
}

// ── camera status ───────────────────────────────────────────────────────

/** What `state-projector` needs from `CameraStatus` to compose `status`. */
export interface CameraStatusInput {
  /** `CameraStatus.switchedOff` — functions an operator turned off. */
  readonly switchedOff: readonly string[]
  /** The `stage` names of `CameraStatus.degraded`. */
  readonly degradedStages: readonly string[]
  /** `CameraStatus.recording`; `null` = the stage is inactive or unreachable. */
  readonly recording: { readonly active: boolean } | null
}

/**
 * `status` — the entity D62 exists for. A camera an operator switched off and
 * a camera that is genuinely broken must never paint the same picture in Home
 * Assistant: this is what tells the two apart.
 *
 * Order matters: the `switches` stage failing to answer makes the WHOLE
 * badge unknown, because an empty `switchedOff` is only a positive claim when
 * `degraded` does not name `switches` — reporting `ok` here would be the D62
 * failure landing inside the very field written to prevent it.
 */
export function projectCameraStatus(
  deviceKey: string,
  input: CameraStatusInput,
): readonly StateValue[] {
  const values: StateValue[] = [
    { topic: stateTopic(deviceKey, 'status'), value: cameraStatusToken(input) },
  ]
  if (input.recording !== null) {
    values.push({
      topic: stateTopic(deviceKey, 'recording_active'),
      value: bool(input.recording.active),
    })
  } else if (!input.degradedStages.includes('recording')) {
    // No recording block and the stage answered clean: the camera genuinely
    // has no active recording, which is the truth, not a gap.
    values.push({ topic: stateTopic(deviceKey, 'recording_active'), value: bool(false) })
  }
  // Else: the `recording` stage is degraded — publish nothing, so Home
  // Assistant renders `unknown` rather than a guessed `false`.
  return values
}

function cameraStatusToken(input: CameraStatusInput): string {
  if (input.degradedStages.includes('switches')) return 'unknown'
  if (input.switchedOff.length > 0) return 'switched_off'
  if (input.degradedStages.length > 0) return 'degraded'
  return 'ok'
}
