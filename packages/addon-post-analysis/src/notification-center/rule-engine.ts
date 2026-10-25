/**
 * Notification Center rule engine — PURE evaluation (no I/O, no clocks of
 * its own). Every function here is a deterministic mapping from
 * (rule, subject, time) to a decision, so the whole condition surface is
 * unit-testable without stores or timers.
 *
 * Spec: `docs/superpowers/specs/2026-07-22-notification-center-requirements.md`
 * §2.3 (P1 subset) + D-3. A `NcConditions` set is a flat AND of groups —
 * every present group must pass, an absent group passes; membership lists
 * are OR within the list. `evaluateRule` reports the FIRST failing group
 * by its condition id (consumed by `testRule` dry-runs).
 */

import type {
  AudioEvent,
  LabelAttribution,
  MediaFileKind,
  NcAudioCondition,
  NcConditions,
  NcMediaPolicy,
  NcOccupancyCondition,
  NcRule,
  NcRuleInput,
  NcRuleKind,
  NcSystemEventCondition,
  NcSystemEventFilterKey,
  NcSystemEventKind,
  NcThrottleGranularity,
  ObjectEvent,
  SensorEvent,
  Track,
  TrackEnvelope,
  ZoneCrossing,
} from '@camstack/types'
import {
  consumableLowPercentOf,
  isScheduleActive,
  resolveNcMediaImage,
  ruleKindOf,
  sensorRaisedOf,
  ruleBelongsToAlarm as sharedRuleBelongsToAlarm,
  subKindsOf,
  systemEventFilterApplies,
} from '@camstack/types'
import {
  displayLabel,
  type LabelKind,
  labelKindOf,
} from '../pipeline-analytics/pipeline/label-tier.js'
import type { BboxRect } from '../pipeline-analytics/pipeline/zones/geometry.js'
import type { TrackLabelTiers } from '../pipeline-analytics/store/track-store.js'
import { bboxPolygonOverlap } from '../pipeline-analytics/pipeline/zones/overlap.js'
import { type NcSensorEdge, sensorEdgeOf } from './alarm/alarm-opening-edge.js'
import {
  type AudioWindowHit,
  type AudioWindowSpec,
  audioSpecFromCondition,
} from './audio-rule-matcher.js'
import type { NcLinkedStills } from './linked-stills.js'
import type { OccupancyEdge } from './occupancy-watcher.js'
import { type NcSceneObservation, sceneConditionSatisfied } from './scene-state-cache.js'
import { type NcZoneOwnerLookup, scopeZoneIdsForRule } from './zone-ownership.js'

// ── Subject (normalized record view) ────────────────────────────────

/**
 * Detection provenance carried on the subject (record `source`, defaulted).
 * Mirrors `TrackSource` plus `onboard`, which is a DETECTION source and has no
 * track-row equivalent. Every synthetic track source must appear here or a
 * rule filtering on `source` cannot address it — `audio` is the D62 marker.
 */
export type NcSubjectSource = 'pipeline' | 'onboard' | 'sensor' | 'audio'

/** The two package lifecycle phases a package-event subject can carry. */
export type NcPackagePhase = 'delivered' | 'picked-up'

/** The record kind a subject normalizes — one per trigger (D-3). `audio-event`
 *  rides the EXISTING `immediate` delivery (a classified audio episode); it is
 *  gated by the audio-class safety opt-in in {@link evaluateRule}.
 *  `audio-window` is the sustained-sound sibling — a CONFIRMED sampling window
 *  from `audio-rule-matcher.ts` rather than one classified sample — and rides
 *  `immediate` too, gated by the `audio` condition. */
export type NcSubjectKind =
  | 'object-event'
  | 'track-end'
  | 'device-event'
  | 'package-event'
  | 'audio-event'
  | 'audio-window'
  | 'occupancy-event'
  | 'system-event'

/** Reserved outbox/device column value for events with no camera subject. */
export const NC_SYSTEM_DEVICE_ID = 0

/**
 * WHICH rule fired, and on WHAT — the provenance of one match.
 *
 * Handed forward to whatever a match causes (an action sequence, and through it
 * the device that sequence actuates), and frozen onto a durable row when a
 * later delivery has to point back at the match that caused it. That is what
 * makes the COMBINED alarm notification possible: `alarm-panel.trigger` takes
 * nothing but a device id, so without this the alarm can never know which
 * detection set it off, and the operator gets two pushes about one incident.
 *
 * Declared here, beside the subjects, so the durable shape lives in one file:
 * the outbox freezes it, and a row written tonight is read back by whatever the
 * panel and the runner have become next month.
 */
export interface NcRuleFireRef {
  readonly ruleId: string
  readonly ruleName: string
  /** The CAMERA — the media owner and the name the alarm body reads out. */
  readonly deviceId: number
  /**
   * The SENSOR, when the match was about one — a contact, a doorbell, a button.
   *
   * Carried for the same reason `deviceId` is, and for one more: the alarm
   * panel refuses a trigger that came from a sensor it excluded at arm time
   * (arming with a window open), and `alarm-panel.trigger` takes nothing but a
   * device id, so this is the only way the panel can learn WHICH sensor is
   * about to set it off. Absent when the subject is the camera itself.
   */
  readonly sourceDeviceId?: number
  /** The evaluated record id, so the rule's own row can be found again. */
  readonly recordId: string
  readonly trackId?: string
  readonly eventId?: string
  /**
   * Further stills when the match photographed a LINKED SET (`each` mode).
   * Frozen so the combined alarm row can name the same owners the rule's own
   * notification would have — `linkedStills` itself is not durable across the
   * entry delay, and without these the siren arrives text-only.
   */
  readonly extraStills?: readonly {
    readonly ownerId: string
    readonly cameraId: number
  }[]
  readonly timestamp: number
  /**
   * The DETECTION VOCABULARY — what the rule's own notification would have
   * said, carried so the combined alarm row can say exactly that.
   *
   * The combined notification is a rule's notification with `Allarme:` in
   * front of it, which means the body is `detection.body` and `detection.body`
   * asks for a class, an identity and zones. Without them the dispatcher would
   * compose `{{subject}}` from the system event's dedup slot and deliver
   * "alarm:42 su Front door" — the sentence this exists to prevent.
   *
   * Frozen HERE and not re-read at delivery for the usual durable-row reason:
   * the track may be closed, re-labelled or deleted by the time an unreachable
   * target comes back, and the notification is about what happened at 3am.
   *
   * ABSENT on a fire ref from a match with no detection to name (a device
   * event, a system event), and absence is load-bearing: the intake then keeps
   * the alarm's own sentence rather than a `detection.body` with a hole in it.
   */
  readonly className?: string
  /** Identity or plate, when the pipeline resolved one. */
  readonly label?: string
  /** Zone IDs — names are resolved at delivery, like every other body. */
  readonly zones?: readonly string[]
  readonly confidence?: number
}

/** Normalized infrastructure event frozen through evaluation and delivery. */
export interface NcSystemEventSubject {
  readonly kind: NcSystemEventKind
  readonly subject: string
  /**
   * The catalog keys and the params to fill them, frozen at intake.
   *
   * The KEY and not the sentence, because an outbox row is durable: the words
   * a row was born with used to be the words it would forever be delivered
   * with, so re-wording a system notification — or translating one — could
   * never reach a row already queued. Freezing the key freezes the FACTS (which
   * camera, which profile, which version) and leaves the words to the moment of
   * delivery, which is when the reader's language is known.
   *
   * Variant selection happens HERE rather than in the catalog: whether a stream
   * event names a profile, whether a node is an agent or a worker, whether an
   * update is pinned to a node — each picks a different key at intake, where
   * the data is. That is what keeps the catalog a flat list of finished
   * sentences a translator can read.
   */
  readonly titleKey?: string
  readonly bodyKey?: string
  readonly textParams?: Readonly<Record<string, string>>
  /**
   * LEGACY frozen sentences — written before the keys existed, READ forever.
   *
   * Same reasoning as `NcOutboxPayload.artifact` beside `artifacts`: a row
   * enqueued before this deploy is still in SQLite, possibly for days behind an
   * unreachable target, and it carries no key. Dropping these would deliver it
   * blank. New rows carry keys; these disappear on their own once the last old
   * row drains.
   */
  readonly title?: string
  readonly body?: string
  /**
   * The count the sentence pluralises on ("3 cameras armed").
   *
   * Only a handful of system sentences have one, so it is optional rather than
   * a field every intake has to invent a number for. Frozen at intake like the
   * params, for the same reason: the count is a fact about the moment, and a
   * row held for a day must not re-count anything at delivery.
   */
  readonly textCount?: number
  /**
   * `alarm-triggered` only, and only when a RULE's action sequence pressed the
   * button: the rule and the subject that did it.
   *
   * This is the whole of the combined notification. Without it the alarm is a
   * text-only system event and the rule's own notification is a second push
   * about the same incident; with it, ONE row carries the alarm's words and
   * that rule's pictures. Absent on a manual or API trigger, which is exactly
   * the case where there is no picture to combine with.
   */
  readonly alarmSource?: NcRuleFireRef
  /**
   * `alarm-triggered` only, beside `alarmSource`: the other rule matches that
   * pressed the panel during its entry delay (D705), in arrival order. With the
   * source they are the incident's subjects, and the combined row tiles them as
   * one mosaic (`alarm/alarm-incident-group.ts`). Absent when there were none.
   */
  readonly alarmFollowers?: readonly NcRuleFireRef[]
  readonly deviceId?: number
  /**
   * The device's TYPE (`DeviceType` value) at the moment of the event, read
   * from the in-process device mirror — what a `deviceTypes` condition is
   * judged against.
   *
   * Absent when the mirror does not carry the id (a device registered since
   * the last refresh, or a cold directory), and absence FAILS a `deviceTypes`
   * list: "only my cameras" must never be satisfied by a device nobody can
   * name. A rule with no `deviceTypes` is unaffected.
   */
  readonly deviceType?: string
  readonly nodeId?: string
  readonly packageName?: string
  /**
   * Every node / package this subject names, when the intake batched more than
   * one. A `nodeIds` / `packageNames` rule filter matches if ANY overlap.
   */
  readonly nodeIds?: readonly string[]
  readonly packageNames?: readonly string[]
  /**
   * The threshold a consumable BAND was judged at (D642) — the episode this
   * subject belongs to. A rule hears it only when its own
   * `consumableLowPercent` (default 15) is the same number: the hub keeps one
   * episode per threshold, so a rule at 25 and a rule at 10 each hear their
   * own crossing and never the other's. Absent on a subject no band judged
   * (the tester's synthetic event), which no threshold then refuses.
   */
  readonly consumableLowPercent?: number
  readonly data: Readonly<Record<string, unknown>>
}

/** OCCUPANCY-EVENT: the committed ZoneAnalytics count-edge carried on the
 *  subject. The engine matches a rule to the edge whose `threshold` equals the
 *  rule's own `count` (per-threshold keying), so a ≥1 and a ≥3 rule each fire
 *  only on their own crossing — never on the other's edge. */
export interface NcOccupancySubject {
  readonly zoneId?: string
  readonly zoneName?: string
  readonly className?: string
  /** Raw confirmed count at the edge. */
  readonly count: number
  /** Confirmed count before the edge. */
  readonly previousCount: number
  /** `count ≥ threshold` at the edge. */
  readonly occupied: boolean
  /** The capacity threshold of the key this edge belongs to. */
  readonly threshold: number
}

/**
 * AUDIO: the confirmed match carried on the subject, in the mode that produced
 * it (D157 — the two modes share no tuning, so neither does the subject).
 *
 * The spec fields are carried BACK so the engine can pair a rule to the
 * evidence that belongs to it — a hub with two audio rules on one camera runs
 * two specs, and a rule must never be answered with the other's. Mirrors how
 * an occupancy subject carries its key `threshold`.
 */
export type NcAudioWindowSubject =
  | {
      /** LABEL: the classifier put a watched label on ONE frame. */
      readonly mode: 'label'
      /** The labels the rule watches (normalized, sorted) — the pairing key. */
      readonly specLabels: readonly string[]
      /** The watched labels this frame actually matched. */
      readonly labels: readonly string[]
      /** The frame's level, when it carried one. Colour, never a gate. */
      readonly peakDbfs?: number
    }
  | {
      /** LEVEL: a full sampling window cleared the configured hit share. */
      readonly mode: 'level'
      /** MEASURED hit percentage over the window (≥ the watched spec's). */
      readonly hitPercent: number
      /** The window length that produced it. */
      readonly samplingSeconds: number
      /** Samples the window held, and how many of them were hits. */
      readonly samples: number
      readonly hits: number
      /** The dB floor the window was judged with — the pairing key. */
      readonly dbThreshold: number
      /** Loudest hitting sample, when any carried a level. */
      readonly peakDbfs?: number
      /** Labels observed on the hitting samples (normalized) — colour only. */
      readonly labels: readonly string[]
    }

/** The normalized view of a persisted record the engine evaluates. */
export interface NcRuleSubject {
  readonly kind: NcSubjectKind
  readonly recordId: string
  readonly deviceId: number
  /**
   * DEVICE-EVENT: the device whose state actually changed — the contact, the
   * button, the doorbell — when that is not `deviceId`.
   *
   * A sensor event is attributed to a CAMERA at ingest (one row per linked
   * camera), because the camera is where the picture comes from. `deviceId` is
   * therefore the camera and the sensor was, until now, dropped entirely. The
   * consequence was silent and complete: the rule editor's Devices tab offers
   * every device type, an operator picking their front-door contact authored a
   * rule the engine could never match, and nothing anywhere said so.
   *
   * Absent on every other subject kind — a track has no second device.
   */
  readonly sourceDeviceId?: number
  /**
   * DEVICE-EVENT, sensor-level subjects only: every camera that links the
   * sensor, ignoring the tracked-events opt-in. MEDIA only: a device-scoped
   * rule never matches through this list ({@link matchesDeviceScope}) — a
   * linked set matches through {@link rowCameraIds}.
   *
   * Two sensor-level shapes carry it:
   *  - the LINKED SET (ADR 0632, {@link linkedSensorId} set): a sensor linked
   *    to more than one camera is evaluated ONCE. The list holds the linked
   *    cameras that are NOT muted, and `deviceId` is its `[0]`, the PRIMARY
   *    camera — or the sensor itself when every linked camera is muted (`[]`);
   *  - the UNOWNED sensor (D630 §6): no camera takes a timeline row, so the
   *    sensor is its own device (`deviceId` is the sensor, never in this
   *    list): `[]` = linked to no camera; non-empty = linked, but none of those
   *    cameras opted it into tracked events.
   *
   * Absent on a per-camera row (`deviceId` is then the camera) and on every
   * other kind. {@link linkedSensorId} tells the two shapes apart.
   */
  readonly linkedCameraIds?: readonly number[]
  /**
   * DEVICE-EVENT, linked set only (ADR 0632): the SENSOR the one sensor-level
   * evaluation is about. Its presence is what makes a subject a linked set, and
   * the per-device MUTE is judged on it — a camera's mute only drops that
   * camera's tile. Absent on every other subject.
   */
  readonly linkedSensorId?: number
  /**
   * DEVICE-EVENT, linked set only: the cameras that took a TIMELINE ROW for
   * this change — the ones that opted the sensor into tracked events (D630 §6)
   * — and are not muted. With the sensor, these are what a device-scoped rule
   * matches on ({@link matchesDeviceScope}); the primary camera (`deviceId`)
   * matches only when it is one of them.
   */
  readonly rowCameraIds?: readonly number[]
  /**
   * DEVICE-EVENT, linked set only: the cameras that took a timeline row but
   * are MUTED (D62). When there were rows and every one of them is muted, the
   * event is dropped — exactly what each of those rows would have been.
   */
  readonly mutedRowCameraIds?: readonly number[]
  /**
   * DEVICE-EVENT, linked set only: the shelf owners of the photographs taken
   * of every linked camera at the trigger (`linked-stills.ts`) — present only
   * when a capture set was started, i.e. some enabled rule that could fire
   * here wants a picture. Each rule picks its own view of them
   * (`linked-camera-media.ts`).
   */
  readonly linkedStills?: NcLinkedStills
  readonly timestamp: number
  /**
   * WHEN THE CHANGE HAPPENED, when that is knowably EARLIER than
   * {@link timestamp}, which is when the system concluded it.
   *
   * Set by an occupancy edge (`OccupancyEdge.observedAt`) and by a package
   * PICK-UP (the collector's instant / the parcel's last sighting, D682 — the
   * departure is concluded five minutes later — stored on the row, D684). For
   * the occupancy edge the
   * two are separated by the sustain window plus the wait for the next
   * occupancy sample — 6–10 minutes on an on-motion camera like 102, which is
   * why the "posto libero" clip showed an empty space with nothing leaving it.
   * `timestamp` keeps its exact meaning: this is a SECOND fact beside it, not a
   * redefinition, so every consumer reading `timestamp` today reads the same
   * number it did before.
   *
   * ABSENT = UNKNOWN. Nothing may substitute a clock for it — an anchor
   * invented at delivery time is precisely the defect. The media anchor falls
   * back to `timestamp` explicitly and logs that it did
   * (`media-anchor.ts`).
   */
  readonly observedAt?: number
  /** Event: `[className]`; track: `classes ?? [className]`. */
  readonly classNames: readonly string[]
  /** Collapsed label (identity name / plate text / subclass). */
  readonly label?: string
  /**
   * The GALLERY ROW behind {@link label} — a face `Identity.id` or a plate
   * `Vehicle.id`, carried on `LabelAttribution.identityId`.
   *
   * This is what an `identities` condition matches, because it is the half of a
   * recognition that does not change when the operator fixes a spelling.
   * Absent on a subject nobody claimed, on every record written before the
   * field, and on a plate no vehicle owns.
   */
  readonly identityId?: string
  /**
   * WHAT {@link label} is — a recognised person or a read plate — derived from
   * the deciding step (`labelKindOf`). Absent for a sub-class, a species, an
   * unattributed legacy value, and every subject with no label.
   *
   * Two things read it: the "any known face / any readable plate" state of the
   * identity and plate conditions, and the notification's own SENTENCE
   * (`detection.subject.identity` vs `detection.subject.plate` — "Alice è
   * arrivato" and "Veicolo AB123CD" are not the same sentence with a different
   * word in it).
   */
  readonly labelKind?: LabelKind
  /** Event confidence / track best-detection confidence. Absent ⇒ a
   *  `minConfidence` condition FAILS (never guess quality). */
  readonly confidence?: number
  /** Admin zone ids (event `zones` / track `zonesVisited`). */
  readonly zones: readonly string[]
  readonly trackId?: string
  /** Detection provenance; a record with no stamped source is `pipeline`. */
  readonly source?: NcSubjectSource
  /** Server-computed key-event importance [0,1]. Absent ⇒ `minImportance`
   *  FAILS (never guess). */
  readonly importance?: number
  /** Track lifespan in seconds — track-end subjects only. Absent on
   *  object-event subjects (no closed lifespan), so `minDwellSeconds`
   *  never matches immediate delivery. */
  readonly dwellSeconds?: number
  /** Identity/plate MATCH confidence [0,1] — distinct from detection
   *  `confidence`. Carried at track close; absent ⇒ `minLabelConfidence`
   *  FAILS (never guess). */
  readonly labelConfidence?: number
  /** DEVICE-EVENT: the persisted sensor/control taxonomy kind (doorbell /
   *  contact / button / device-event) — the `sensorKinds` discriminator. */
  readonly sensorKind?: string
  /** DEVICE-EVENT: raw device event-type token (`EventFire.eventType`), when
   *  the source is an event-emitter slice. Absent for doorbell-pulse /
   *  passive sensors ⇒ an `eventTypeTokens` condition FAILS. */
  readonly eventType?: string
  /** DEVICE-EVENT: which way an opening moved (`alarm/alarm-opening-edge.ts`).
   *  Absent for kinds with no opening meaning, and for an unreadable slice.
   *  Only rules that belong to the alarm read it ({@link ruleBelongsToAlarm}). */
  readonly sensorEdge?: NcSensorEdge
  /** DEVICE-EVENT: true = a boolean sensor went HIGH (water, smoke, open…),
   *  false = it cleared (D640, `@camstack/types` → `sensorRaisedOf`). Absent
   *  for a kind with no raise and for an unreadable slice — a
   *  `sensorTransition` condition then PASSES (never silence on a bad read). */
  readonly sensorRaised?: boolean
  /** PACKAGE-EVENT: which lifecycle phase this record represents. */
  readonly packagePhase?: NcPackagePhase
  /**
   * PACKAGE-EVENT: the LLM did not confirm the parcel (timeout, unreachable,
   * unparseable, or no crop). The sentence says "possible". Absent means a
   * normal delivery.
   */
  readonly packagePossible?: boolean
  /**
   * Normalized 0..1 detection bbox (top-left origin) for geometric
   * `customZones` eval — the SAME coordinate space as the viewer-drawn
   * polygons. Object-event bbox is PIXEL-space (`ObjectEvent.bbox` +
   * `frameWidth`/`frameHeight`) and is normalized before it lands here;
   * track bbox is the already-normalized `track.envelope`. Absent (no bbox,
   * or no frame dims / envelope to normalize with) ⇒ a `customZones`
   * condition FAILS (fail-closed, per the A1 catalog rationale — a
   * device-event has no bbox either).
   */
  readonly bbox?: BboxRect
  /**
   * OBJECT-EVENT: the confirmed zone crossing this record IS, when it is one.
   * Absent on every other record (a movement-state transition, an appearance,
   * a device event, a closed track), so a rule asking for `exit` fails closed
   * on them. The `zoneId` also joins the `zones` condition — an exit's
   * membership no longer contains the zone it just left, so without it a
   * zone-scoped exit rule could never match.
   */
  readonly crossing?: ZoneCrossing
  /** OCCUPANCY-EVENT: the committed count-edge (present ONLY on an
   *  `occupancy-event` subject). The `evaluateRule` occupancy branch matches
   *  the rule's `occupancy` condition against this; every other subject kind
   *  leaves it absent, so an occupancy condition fails closed on them. */
  readonly occupancy?: NcOccupancySubject
  /** AUDIO-WINDOW: the confirmed sampling window (present ONLY on an
   *  `audio-window` subject). The `evaluateRule` audio branch matches the
   *  rule's `audio` condition against this; every other subject kind leaves it
   *  absent, so an audio condition fails closed on them. */
  readonly audioWindow?: NcAudioWindowSubject
  /** SYSTEM-EVENT: normalized liveness/update event. */
  readonly systemEvent?: NcSystemEventSubject
}

/**
 * Normalize a PIXEL-space detection bbox onto 0..1 using its detection-frame
 * dims. Returns `undefined` when the box or the dims are missing/degenerate
 * (dim ≤ 0) — the caller then omits the subject bbox and `customZones` fails
 * closed rather than testing pixel coords against a 0..1 polygon.
 */
function normalizeBbox(
  bbox: ObjectEvent['bbox'],
  frameWidth: number | undefined,
  frameHeight: number | undefined,
): BboxRect | undefined {
  if (bbox === undefined) return undefined
  if (frameWidth === undefined || frameHeight === undefined) return undefined
  if (frameWidth <= 0 || frameHeight <= 0) return undefined
  return {
    x: bbox.x / frameWidth,
    y: bbox.y / frameHeight,
    w: bbox.w / frameWidth,
    h: bbox.h / frameHeight,
  }
}

/** Build the subject for an `immediate` (object-event) evaluation. */
export function subjectFromObjectEvent(ev: ObjectEvent): NcRuleSubject {
  return {
    kind: 'object-event',
    // `String`, deliberately: an event id is a rowid since D474 but a TRACK id
    // is still a uuid, and `recordId` is the one field that references either.
    // Stringifying a rowid is lossless; widening the notification contract to a
    // union would push the same choice onto every consumer.
    recordId: String(ev.id),
    deviceId: ev.deviceId,
    timestamp: ev.timestamp,
    classNames: [ev.className],
    // 4g: the NC subject carries the DISPLAY label — the finest thing known.
    // Its `labelEquals` / `identities` / `plates` conditions were authored
    // against the pre-tier column, which held exactly that, so collapsing here
    // keeps every live rule matching what it already matched.
    // …and the two things the WORD alone cannot say: which gallery row it is,
    // and whether it is a person or a plate. ONE projection, shared with the
    // grouped window's promotion hook (D692): `subjectLabelFromTiers`.
    ...subjectLabelFromTiers(ev),
    ...(ev.confidence !== undefined ? { confidence: ev.confidence } : {}),
    zones: ev.zones ?? [],
    ...(ev.trackId !== undefined ? { trackId: ev.trackId } : {}),
    // Absent stamped source ⇒ pipeline (schema default).
    source: ev.source ?? 'pipeline',
    ...(ev.importance !== undefined ? { importance: ev.importance } : {}),
    ...(ev.zoneCrossing !== undefined ? { crossing: ev.zoneCrossing } : {}),
    ...bboxPatch(normalizeBbox(ev.bbox, ev.frameWidth, ev.frameHeight)),
  }
}

/** The tiered label columns a subject label is projected from — the SAME shape the
 *  TrackStore reports a label change with (structural: an `ObjectEvent`, a `Track` and an
 *  active track state all satisfy it). */
export type NcLabelTiers = TrackLabelTiers

/** The recognition fields of a subject. */
export interface NcSubjectLabel {
  readonly label?: string
  readonly identityId?: string
  readonly labelKind?: LabelKind
}

/**
 * The subject's label, from the tiers: the DISPLAY label (the finest thing
 * known — 4g) plus the gallery id and the kind of recognition behind it. The
 * one projection the subject builders and the grouped window's promotion hook
 * (D692) share.
 */
export function subjectLabelFromTiers(tiers: NcLabelTiers): NcSubjectLabel {
  const label = displayLabel(tiers)
  return {
    ...(label !== undefined ? { label } : {}),
    ...recognitionPatch(tiers.subLabelMeta),
  }
}

/** Spread an optional normalized bbox onto a subject (present only if set). */
function bboxPatch(bbox: BboxRect | undefined): { bbox?: BboxRect } {
  return bbox !== undefined ? { bbox } : {}
}

/**
 * The recognition half of a subject, read off the tier-2 attribution: WHICH
 * gallery row and WHAT KIND of thing. Both absent on an unattributed label, so
 * every condition that depends on them fails closed for a legacy record — which
 * is why the id/name matcher keeps its name leg.
 */
function recognitionPatch(meta: LabelAttribution | undefined): {
  identityId?: string
  labelKind?: LabelKind
} {
  const kind = labelKindOf(meta)
  return {
    ...(meta?.identityId !== undefined ? { identityId: meta.identityId } : {}),
    ...(kind !== undefined ? { labelKind: kind } : {}),
  }
}

/** Convert a normalized 0..1 track envelope (min/max) into the subject's
 *  top-left+size `BboxRect`. `undefined` in ⇒ `undefined` out (fail closed). */
function envelopeToBbox(envelope: TrackEnvelope | undefined): BboxRect | undefined {
  if (envelope === undefined) return undefined
  return {
    x: envelope.minX,
    y: envelope.minY,
    w: envelope.maxX - envelope.minX,
    h: envelope.maxY - envelope.minY,
  }
}

/**
 * Read the raw device event-type token off a persisted `SensorEvent.value`
 * slice. Only the event-emitter cap carries one (`EventEmitterStatus.lastEvent
 * .eventType`); doorbell-pulse / passive-sensor slices have none. Pure +
 * defensive over the untyped record snapshot.
 */
export function readSensorEventType(value: Record<string, unknown> | null): string | undefined {
  if (value === null) return undefined
  const last = value['lastEvent']
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return undefined
  const eventType = (last as Record<string, unknown>)['eventType']
  return typeof eventType === 'string' && eventType.length > 0 ? eventType : undefined
}

/** The sensor-level extras of {@link subjectFromSensorEvent} (ADR 0632). */
export interface NcSensorLinkedSubject {
  /** The linked cameras the notification shows (not muted), primary first. */
  readonly linkedCameraIds: readonly number[]
  /** The cameras that took a timeline row for the change (not muted) — see
   *  {@link NcRuleSubject.rowCameraIds}. */
  readonly rowCameraIds: readonly number[]
  /** The row cameras that are muted — see {@link NcRuleSubject.mutedRowCameraIds}. */
  readonly mutedRowCameraIds: readonly number[]
  readonly linkedStills?: NcLinkedStills
}

/** A LINKED SET subject (ADR 0632) — see {@link NcRuleSubject.linkedSensorId}. */
export function isLinkedSetSubject(subject: NcRuleSubject): boolean {
  return subject.linkedSensorId !== undefined
}

/**
 * Build the subject for a `device-event` evaluation (a persisted SensorEvent —
 * one row per linked camera; `deviceId` is the CAMERA), or, with `linked`, the
 * ONE sensor-level evaluation of a linked set.
 *
 * BOTH ids ride along. The camera is what the notification shows; the sensor is
 * what the operator named in the rule. Carrying only the camera is what made a
 * sensor-scoped rule unmatched — see {@link NcRuleSubject.sourceDeviceId}.
 */
export function subjectFromSensorEvent(
  ev: SensorEvent,
  markerTrackId?: string,
  linked?: NcSensorLinkedSubject,
): NcRuleSubject {
  const eventType = readSensorEventType(ev.value)
  // Read off THIS row's slice, so every camera row of one change (and the
  // unowned-sensor subject built from this one) answers the same edge.
  const sensorEdge = sensorEdgeOf(ev.kind, ev.value)
  const sensorRaised = sensorRaisedOf(ev.kind, ev.value)
  return {
    kind: 'device-event',
    // `String`, deliberately: an event id is a rowid since D474 but a TRACK id
    // is still a uuid, and `recordId` is the one field that references either.
    // Stringifying a rowid is lossless; widening the notification contract to a
    // union would push the same choice onto every consumer.
    recordId: String(ev.id),
    deviceId: ev.deviceId,
    // The synthetic marker track the SAME press materialised, when one landed.
    // A device event has no detection, so this is the only thing that owns a
    // frame of it — naming it here is what gives a doorbell notification its
    // picture, through the ordinary media-owner ladder and no special branch.
    // Absent when the projection was debounced or failed; the notification is
    // then text-only and the centre says so.
    ...(markerTrackId !== undefined ? { trackId: markerTrackId } : {}),
    // Only when it differs: a sensor that IS the attributed device would
    // otherwise carry a redundant field that reads as a second identity.
    ...(ev.sourceDeviceId !== ev.deviceId ? { sourceDeviceId: ev.sourceDeviceId } : {}),
    timestamp: ev.timestamp,
    // A device event carries no detection class; the discriminator is the kind.
    classNames: [],
    zones: [],
    source: 'sensor',
    sensorKind: ev.kind,
    ...(eventType !== undefined ? { eventType } : {}),
    ...(sensorEdge !== undefined ? { sensorEdge } : {}),
    ...(sensorRaised !== undefined ? { sensorRaised } : {}),
    // ONE evaluation for the whole linked set (ADR 0632): every camera it
    // shows, primary first — the same shape the unowned subject uses.
    ...(linked !== undefined
      ? {
          linkedSensorId: ev.sourceDeviceId,
          linkedCameraIds: [...linked.linkedCameraIds],
          rowCameraIds: [...linked.rowCameraIds],
          mutedRowCameraIds: [...linked.mutedRowCameraIds],
        }
      : {}),
    ...(linked?.linkedStills !== undefined ? { linkedStills: linked.linkedStills } : {}),
  }
}

/**
 * Build the subject for a sensor no camera takes a row for (D630 §6): the
 * sensor is its own device (`deviceId === sourceDeviceId`, so no
 * `sourceDeviceId` field) and there is no marker track — nothing owns a frame
 * of it. `linkedCameraIds` carries every camera linking it (see the field).
 */
export function subjectFromUnownedSensorEvent(
  ev: SensorEvent,
  linkedCameraIds: readonly number[],
): NcRuleSubject {
  return { ...subjectFromSensorEvent(ev), linkedCameraIds: [...linkedCameraIds] }
}

/**
 * Build the subject for an AUDIO evaluation. Audio classification events
 * (`eventStore.insertAudio`) persist on a SEPARATE path from object events and
 * never reach the object-event hook — this normalizes one onto the engine
 * subject so an `immediate` rule that OPTS IN to an `audio-*` class can fire on
 * it. The class id is the SAME namespaced `audio-<macroClass>` id the NC
 * taxonomy exposes (see `nc-taxonomy.ts` audioKinds), so a picker selection
 * matches exactly. `confidence` carries the classification score (so a
 * `minConfidence` condition composes naturally). A level-path audio event (no
 * `classification`) yields NO class ⇒ it can never satisfy the audio opt-in
 * gate, so only classified audio ever notifies (documented boundary). Audio has
 * no zones / bbox / label, so the object-specific conditions all fail closed
 * (see the {@link evaluateRule} audio gate + the matchers below).
 *
 * `stillOwnerId` is the audio still shelf's owner id — the photograph of the
 * camera taken at the match (`still-shelf.ts`). It rides `trackId` because that
 * is the field the attachment ladder reads, exactly as a doorbell press rides
 * its marker track's id; nothing else about the subject is track-scoped, and
 * `buildEntries` keys an audio row on its record id, never on this. Absent when
 * no rule that could fire wants a still.
 */
export function subjectFromAudioEvent(ev: AudioEvent, stillOwnerId?: string): NcRuleSubject {
  const macro = ev.classification?.className
  return {
    kind: 'audio-event',
    // `String`, deliberately: an event id is a rowid since D474 but a TRACK id
    // is still a uuid, and `recordId` is the one field that references either.
    // Stringifying a rowid is lossless; widening the notification contract to a
    // union would push the same choice onto every consumer.
    recordId: String(ev.id),
    deviceId: ev.deviceId,
    timestamp: ev.timestamp,
    classNames: macro !== undefined ? [`audio-${macro}`] : [],
    ...(ev.classification?.score !== undefined ? { confidence: ev.classification.score } : {}),
    zones: [],
    ...(stillOwnerId !== undefined ? { trackId: stillOwnerId } : {}),
    // Audio analysis is a pipeline product (never a linked-sensor slice).
    source: 'pipeline',
  }
}

/**
 * Build the subject for an AUDIO evaluation — a CONFIRMED match from the
 * watcher, in either mode (D157).
 *
 * The difference from {@link subjectFromAudioEvent} is the whole feature: that
 * one is the legacy per-frame classified-audio record, this one is the rule's
 * OWN question — "the classifier heard crying" (label mode) or "over the last
 * N seconds, X% of what this camera heard was above the floor" (level mode).
 *
 * `classNames` carries the labels behind the match, in the SAME namespaced
 * `audio-<macro>` spelling the taxonomy and the legacy path use, so the
 * notification body and the history row read identically whichever path
 * produced them. `confidence` is deliberately ABSENT: the evidence is a
 * classifier decision the analyzer already gated, or a percentage of samples —
 * neither is a score, and lending one to `minConfidence` would let a detection
 * condition silently re-judge an audio rule on a number that means something
 * else.
 *
 * `stillOwnerId` — see {@link subjectFromAudioEvent}. A sound owns no frame, so
 * the only picture it can carry is a photograph of its camera taken at the
 * confirmation, held on the still shelf under this id.
 */
export function subjectFromAudioWindow(hit: AudioWindowHit, stillOwnerId?: string): NcRuleSubject {
  const spec = hit.spec
  // Stable per-match id (device + spec + confirmation instant) so the outbox
  // dedups discrete matches and never collapses two confirmations of the same
  // rule minutes apart.
  const recordId =
    spec.mode === 'label'
      ? `aud:${hit.deviceId}:l${spec.labels.join('+')}:${hit.timestamp}`
      : `aud:${hit.deviceId}:s${spec.samplingSeconds}:h${Math.round(hit.window?.hitPercent ?? 0)}:${hit.timestamp}`
  return {
    kind: 'audio-window',
    recordId,
    deviceId: hit.deviceId,
    timestamp: hit.timestamp,
    classNames: hit.labels.map((l) => `audio-${l}`),
    zones: [],
    ...(stillOwnerId !== undefined ? { trackId: stillOwnerId } : {}),
    source: 'audio',
    audioWindow: audioSubjectFor(hit, spec),
  }
}

/** The mode-shaped half of {@link subjectFromAudioWindow}. */
function audioSubjectFor(hit: AudioWindowHit, spec: AudioWindowSpec): NcAudioWindowSubject {
  if (spec.mode === 'label') {
    return {
      mode: 'label',
      specLabels: spec.labels,
      labels: hit.labels,
      ...(hit.peakDbfs !== undefined ? { peakDbfs: hit.peakDbfs } : {}),
    }
  }
  const window = hit.window
  return {
    mode: 'level',
    // A level confirmation always carries its measurement; the fallbacks keep
    // the shape total rather than inventing evidence — a zero window matches
    // no rule, which is the fail-closed direction.
    hitPercent: window?.hitPercent ?? 0,
    samplingSeconds: window?.samplingSeconds ?? spec.samplingSeconds,
    samples: window?.samples ?? 0,
    hits: window?.hits ?? 0,
    dbThreshold: spec.dbThreshold,
    ...(hit.peakDbfs !== undefined ? { peakDbfs: hit.peakDbfs } : {}),
    labels: hit.labels,
  }
}

/**
 * Build the subject for an OCCUPANCY evaluation. A committed `OccupancyEdge`
 * (ZoneAnalytics count crossing) rides the EXISTING `device-event` delivery via
 * this INTERNAL subject kind (the audio pattern with a device-event landing —
 * `device-event` is already a native `NcHistoryRecordKind`, so no history
 * downgrade is needed). The edge scope + count/threshold ride on `occupancy`;
 * the engine's occupancy branch matches the rule's `occupancy` condition against
 * it. Admin-zone provenance is NOT copied onto `zones` (kept empty) so the admin
 * `zones` condition FAILS CLOSED on occupancy — zone scoping is done inside the
 * occupancy condition (`occupancy.zoneId`). No detection confidence / label /
 * bbox / importance / sensorKind, so those conditions all fail closed too.
 *
 * The edge's `mediaTrackId` — one of the member tracks the count is about, as
 * chosen at commit (`chooseOccupancyMediaOwner`) — rides on `trackId`, and that
 * is the whole of what gives an occupancy notification a picture: the ordinary
 * media-owner ladder resolves it, exactly as it resolves a doorbell's marker
 * track.
 *
 * `stillOwnerId` is the SECOND source of that picture and the only one an
 * emptied scope can have: with no member left to name — "posto libero", where
 * the object whose departure is the news has gone — the trigger site photographs
 * the camera and holds the bytes on the still shelf (`still-shelf.ts`), exactly
 * as an audio match does. The member track always WINS: it is a picture of the
 * counted object, and a photograph is only ever the stand-in for not having one.
 * Neither present (no snapshot cap on this node) ⇒ text-only, as before.
 */
export function subjectFromOccupancyEvent(
  edge: OccupancyEdge,
  stillOwnerId?: string,
): NcRuleSubject {
  const mediaOwner = edge.mediaTrackId ?? stillOwnerId
  return {
    kind: 'occupancy-event',
    // Stable, per-edge id (unique across scope + threshold + time) so the outbox
    // dedups discrete edges, never collapsing a became-occupied and a later
    // became-free of the same key.
    recordId: `occ:${edge.deviceId}:${edge.zoneId ?? '@frame'}:${edge.className ?? '@all'}:t${edge.threshold}:${edge.occupied ? 'occ' : 'free'}:${edge.timestamp}`,
    deviceId: edge.deviceId,
    timestamp: edge.timestamp,
    // The moment the count actually changed, when the edge could date it. The
    // `recordId` above deliberately keeps using `timestamp`: it is an identity,
    // and two edges of one key must stay distinguishable even if they share an
    // observed moment.
    ...(edge.observedAt !== undefined ? { observedAt: edge.observedAt } : {}),
    classNames: [edge.className ?? 'occupancy'],
    zones: [],
    ...(mediaOwner !== undefined ? { trackId: mediaOwner } : {}),
    // Occupancy is a pipeline product (tracked-detection counts), not a linked
    // sensor slice — mirror the audio subject's provenance.
    source: 'pipeline',
    occupancy: occupancySubjectFromEdge(edge),
  }
}

/**
 * The scope + level half of an occupancy subject, ALONE.
 *
 * Split out for one reason: the still-shelf gate must ask `matchesOccupancy`
 * whether a rule would fire on an edge BEFORE the subject that would carry the
 * answer exists (the owner id it mints is an input to that subject). Sharing
 * this keeps the gate reading the same numbers the verdict will.
 */
export function occupancySubjectFromEdge(edge: OccupancyEdge): NcOccupancySubject {
  return {
    ...(edge.zoneId !== undefined ? { zoneId: edge.zoneId } : {}),
    ...(edge.zoneName !== undefined ? { zoneName: edge.zoneName } : {}),
    ...(edge.className !== undefined ? { className: edge.className } : {}),
    count: edge.count,
    previousCount: edge.previousCount,
    occupied: edge.occupied,
    threshold: edge.threshold,
  }
}

/**
 * Build the subject for a `package-event` evaluation (a persisted `package`
 * object-event; `phase` derives from the event `state` at the call site).
 *
 * `observedAt` (D682, D684): a pick-up row's `timestamp` is when the departure
 * was CONCLUDED — five minutes of unseen observed time after the parcel went —
 * so the detector STORES the instant it happened on the row, and the footage is
 * cut around that (`media-anchor.ts`). Read from the row HERE, the one place
 * every path builds a package subject (live hook, boot reconcile, dry-run), so
 * none of them can anchor differently. `timestamp` keeps its meaning; a row
 * written before D684 has none, which the anchor reads as unknown, out loud.
 */
export function subjectFromPackageEvent(ev: ObjectEvent, phase: NcPackagePhase): NcRuleSubject {
  return {
    kind: 'package-event',
    // `String`, deliberately: an event id is a rowid since D474 but a TRACK id
    // is still a uuid, and `recordId` is the one field that references either.
    // Stringifying a rowid is lossless; widening the notification contract to a
    // union would push the same choice onto every consumer.
    recordId: String(ev.id),
    deviceId: ev.deviceId,
    timestamp: ev.timestamp,
    // When the pick-up HAPPENED (D682), as stored on the row (D684) — the
    // footage is cut around it.
    ...(ev.observedAt !== undefined ? { observedAt: ev.observedAt } : {}),
    classNames: [ev.className],
    // 4g: the NC subject carries the DISPLAY label — the finest thing known.
    // Its `labelEquals` / `identities` / `plates` conditions were authored
    // against the pre-tier column, which held exactly that, so collapsing here
    // keeps every live rule matching what it already matched.
    // …and the two things the WORD alone cannot say: which gallery row it is,
    // and whether it is a person or a plate. ONE projection, shared with the
    // grouped window's promotion hook (D692): `subjectLabelFromTiers`.
    ...subjectLabelFromTiers(ev),
    ...(ev.confidence !== undefined ? { confidence: ev.confidence } : {}),
    zones: ev.zones ?? [],
    ...(ev.trackId !== undefined ? { trackId: ev.trackId } : {}),
    source: ev.source ?? 'pipeline',
    ...(ev.importance !== undefined ? { importance: ev.importance } : {}),
    ...bboxPatch(normalizeBbox(ev.bbox, ev.frameWidth, ev.frameHeight)),
    packagePhase: phase,
    ...(ev.packagePossible === true ? { packagePossible: true } : {}),
  }
}

/** Extra close-time info not carried on the persisted Track row. */
export interface NcTrackClosedInfo {
  /** Peak detector confidence over the track's life (best-frame tracker). */
  readonly bestConfidence?: number
  /** Server-computed key-event importance [0,1] as scored at close. The
   *  `Track` clone handed to the close hook is captured by `expireStale`
   *  BEFORE `setImportance` writes the DB row, so it never carries the
   *  freshly-computed value — the closer threads it here explicitly. */
  readonly importance?: number
  /** Identity/plate recognition MATCH confidence at close (from the
   *  recognition result — `TrackDetail.identity.confidence` /
   *  `plateText.confidence`). Absent when no confident label was matched. */
  readonly labelConfidence?: number
  /** Normalized 0..1 trajectory envelope computed at close from the live
   *  `positions` + last-seen frame dims (the SAME `computeTrackEnvelope` the
   *  store persists). The `Track` clone handed to the close hook is captured
   *  by `expireStale` BEFORE persistence and carries NO `envelope` (it lands
   *  only on persisted-row projections), so the closer threads it here — else
   *  a LIVE `track-end` `customZones` rule would fail closed while the
   *  dry-run/reconcile path (persisted rows) matched. Absent when frame dims
   *  were unknown at close ⇒ `customZones` still fails closed. */
  readonly envelope?: TrackEnvelope
}

/** Build the subject for a `track-end` evaluation. */
export function subjectFromTrack(track: Track, info?: NcTrackClosedInfo): NcRuleSubject {
  return {
    kind: 'track-end',
    recordId: track.trackId,
    deviceId: track.deviceId,
    timestamp: track.lastSeen,
    classNames: track.classes && track.classes.length > 0 ? track.classes : [track.className],
    // The closed track carries its final recognition — the same projection as
    // an event's (`subjectLabelFromTiers`).
    ...subjectLabelFromTiers(track),
    ...(info?.bestConfidence !== undefined ? { confidence: info.bestConfidence } : {}),
    zones: track.zonesVisited,
    trackId: track.trackId,
    // Absent stamped source ⇒ pipeline (schema default).
    source: track.source ?? 'pipeline',
    // Prefer the close-time computed importance: the `Track` clone was
    // captured by `expireStale` before `setImportance` wrote the row, so
    // `track.importance` is stale/undefined on the close path — the info
    // carries the value actually scored this close.
    ...((info?.importance ?? track.importance) !== undefined
      ? { importance: info?.importance ?? track.importance }
      : {}),
    dwellSeconds: (track.lastSeen - track.firstSeen) / 1000,
    ...(info?.labelConfidence !== undefined ? { labelConfidence: info.labelConfidence } : {}),
    // The normalized 0..1 envelope is the ONLY box on a track — the
    // per-position `bbox` history is PIXEL-space with no reliable per-row
    // frame dims to normalize by. Prefer the close-time computed envelope:
    // the `Track` clone captured by `expireStale` carries NO `envelope` on
    // the LIVE close path (it lands only on persisted-row projections), so
    // `info.envelope` is what makes a live `track-end` `customZones` rule
    // match — `track.envelope` covers the dry-run/reconcile (persisted-row)
    // path. Absent both (legacy rows / dims-less sources / unknown dims at
    // close) ⇒ no subject bbox ⇒ `customZones` fails closed.
    ...bboxPatch(envelopeToBbox(info?.envelope ?? track.envelope)),
  }
}

// ── Evaluation ──────────────────────────────────────────────────────

/** A rule shape the engine can evaluate — persisted rule or dry-run input. */
export type NcEvaluableRule = NcRuleInput | NcRule

export interface NcEvaluation {
  readonly matched: boolean
  /** Condition id of the FIRST failing group (stable ids from the catalog). */
  readonly failedCondition?: string
  /**
   * On a MATCH (`matched === true`) — the ids of the conditions that were
   * PRESENT on the rule (all of which passed, since evaluation short-circuits
   * on the first failure). A compact "why it fired" summary consumed by the
   * `best-matching` media policy to attach the media that explains the match
   * (`identities` → face crop, `plates` → plate crop). Absent on a non-match.
   */
  readonly matchedOn?: readonly string[]
  /**
   * On a system-event non-match — WHICH narrowing filter excluded the subject,
   * when one did (absent when the rule simply does not list the kind).
   *
   * `failedCondition` says `systemEvent` for both, and the two are opposite
   * facts: "this rule is not about this kind" is routine, while "this rule IS
   * about this kind and your filter dropped it" is the thing an operator asks
   * about at 2am. The caller logs the second one — see D62's sibling rule that
   * an off switch is REPORTED off, and the standing rule that a branch which
   * drops work silently is indistinguishable from a dead pipeline.
   */
  readonly excludedBySystemEventFilter?: NcSystemEventExcludingFilter
  /**
   * On a RELAXED evaluation that passed everything EXCEPT these recognition conditions
   * (D692 §3.2). `matched` is false and `failedCondition` names the first of them, so every
   * existing reader keeps reading a non-match. Absent on every un-relaxed evaluation.
   *
   * NOT by itself a candidate. Relax also marks a FINAL subject that is recognised and out
   * of scope (recognised as someone else, or as an excluded identity) — the engine cannot
   * know whether a recognition is still to come. A grouped rule admits a CANDIDATE only
   * when `pendingOn` is set AND the caller's recognition outlook says the subject is not
   * final (spec §3.2 / §4).
   */
  readonly pendingOn?: readonly NcRecognitionCondition[]
}

/**
 * The conditions that depend on a recognition which may land LATER than the event
 * (D692 §3.2) — exactly the catalog's `label` group, pinned both ways by
 * `rule-engine-relaxed.spec.ts`, so a new label-dependent condition must be classified.
 *
 * `identitiesExclude` is in the set on purpose: an unrecognised person passes the veto
 * today (an absent label passes), and a grouped window's final pass must still drop that
 * person if they are later recognised as the excluded identity. `minLabelConfidence` is
 * `track-end` only in the catalog — on the grouped path only a CLOSED member can carry a
 * label confidence, so only a closed member can satisfy it.
 */
export const NC_RECOGNITION_CONDITIONS = [
  'labelEquals',
  'identities',
  'identitiesExclude',
  'minLabelConfidence',
  'plates',
] as const
export type NcRecognitionCondition = (typeof NC_RECOGNITION_CONDITIONS)[number]

/** Options of {@link evaluateRule}. */
export interface NcEvaluateOptions {
  /**
   * Recognition conditions that answer PENDING instead of failing. The gauntlet and its
   * order are unchanged; only these ids stop short-circuiting (D692 §3.2).
   */
  readonly relax?: readonly NcRecognitionCondition[]
}

/**
 * A condition field that can EXCLUDE a system subject: the four narrowing
 * filters, plus the exclude list. `excludeDeviceIds` is not a fifth
 * `NcSystemEventFilterKey` because it is not a narrowing filter with a family
 * of its own — it rides `deviceIds`' family, and it never fails closed (D636).
 */
export type NcSystemEventExcludingFilter = NcSystemEventFilterKey | 'excludeDeviceIds'

function fail(condition: string): NcEvaluation {
  return { matched: false, failedCondition: condition }
}

/**
 * The condition ids PRESENT on a rule (an empty/absent group contributes
 * nothing). Order follows the catalog. On a matched rule every id returned
 * here passed, so the list is the rule's "matched on" summary.
 */
export function presentConditionIds(c: NcConditions): readonly string[] {
  const ids: string[] = []
  if (c.systemEvent !== undefined) ids.push('systemEvent')
  if (c.devices !== undefined && c.devices.length > 0) ids.push('devices')
  if (c.devicesExclude !== undefined && c.devicesExclude.length > 0) ids.push('devicesExclude')
  if (c.source !== undefined && c.source !== 'any') ids.push('source')
  if (c.classes !== undefined && c.classes.length > 0) ids.push('classes')
  if (c.classesExclude !== undefined && c.classesExclude.length > 0) ids.push('classesExclude')
  if (c.minConfidence !== undefined) ids.push('minConfidence')
  if (c.minImportance !== undefined) ids.push('minImportance')
  if (c.minDwellSeconds !== undefined) ids.push('minDwellSeconds')
  if (c.zones !== undefined) ids.push('zones')
  if (c.zonesExclude !== undefined && c.zonesExclude.length > 0) ids.push('zonesExclude')
  // `enter` is the ABSENT behaviour, so it narrows nothing and does not belong
  // in a "why did this fire?" summary (the `source: 'any'` precedent).
  if (c.crossing !== undefined && c.crossing !== 'enter') ids.push('crossing')
  if (c.labelEquals !== undefined && c.labelEquals.length > 0) ids.push('labelEquals')
  // PRESENT, not non-empty: an empty list is the "only known faces" state and
  // it narrows the rule as much as a named one does. It is also what tells the
  // `best-matching` media policy to attach the face crop.
  if (c.identities !== undefined) ids.push('identities')
  if (c.identitiesExclude !== undefined && c.identitiesExclude.length > 0) {
    ids.push('identitiesExclude')
  }
  if (c.minLabelConfidence !== undefined) ids.push('minLabelConfidence')
  if (c.plates !== undefined) ids.push('plates')
  if (c.sensorKinds !== undefined && c.sensorKinds.length > 0) ids.push('sensorKinds')
  if (c.eventTypeTokens !== undefined && c.eventTypeTokens.length > 0) ids.push('eventTypeTokens')
  if (c.sensorTransition !== undefined) ids.push('sensorTransition')
  if (c.packagePhase !== undefined && c.packagePhase !== 'both') ids.push('packagePhase')
  if (c.customZones !== undefined && c.customZones.length > 0) ids.push('customZones')
  if (c.occupancy !== undefined) ids.push('occupancy')
  if (c.scene !== undefined) ids.push('scene')
  return ids
}

/**
 * Match a rule's occupancy condition against the subject's committed count-edge.
 * The scope (`zoneId`/`className`) must match EXACTLY (fail-closed), then the
 * `op` selects the edge polarity + threshold:
 *  - `became-occupied` / `>=` C → the occupied (false→true) edge of the key
 *    whose threshold is C.
 *  - `became-free` C            → the un-occupied (true→false) edge of key C.
 *  - `<=` C                     → the un-occupied edge of key C+1 (count dropped
 *    from >C to ≤C — the predicate `count ≥ C+1` went false).
 * Per-threshold keying guarantees the subject's `threshold` already equals the
 * key's, so a rule matches only its OWN edge — a ≥1 and a ≥3 rule never
 * cross-fire on a gradual accumulation.
 */
/**
 * Does this confirmed match answer THIS rule's audio condition?
 *
 * The rule's own spec is rebuilt through `audioSpecFromCondition` — the SAME
 * function the watcher is fed with — so the mode and the normalization cannot
 * drift between the two places that decide an audio verdict. Then:
 *
 *  - the match must be the rule's OWN. A hub with two audio rules on one
 *    camera runs two specs, and a match belonging to the other rule fails
 *    closed rather than firing this one on evidence it never asked for. This
 *    is `matchesOccupancy`'s threshold equality, in the audio vocabulary.
 *  - LEVEL mode only: the MEASURED percentage must reach the configured one.
 *    The watcher already judged it against the spec it was keyed with; the
 *    comparison is repeated here because the engine is where a rule's verdict
 *    is decided, and a gate that exists in one place only is a gate that gets
 *    bypassed the first time a second producer appears. LABEL mode has no
 *    such number by design (D157) — the classifier's own confidence floor is
 *    the gate, and it was applied before the frame ever reached the watcher.
 *
 * A condition with NEITHER filter never matches: it would make every sample a
 * trivial hit, so it fires on silence (see `audioSpecFromCondition`).
 */
function matchesAudio(cond: NcAudioCondition, s: NcAudioWindowSubject): boolean {
  const spec = audioSpecFromCondition(cond)
  if (spec === null) return false
  if (spec.mode !== s.mode) return false
  if (spec.mode === 'label' && s.mode === 'label') {
    return (
      spec.labels.length === s.specLabels.length &&
      spec.labels.every((l, i) => s.specLabels[i] === l)
    )
  }
  if (spec.mode === 'level' && s.mode === 'level') {
    if (spec.dbThreshold !== s.dbThreshold) return false
    if (spec.samplingSeconds !== s.samplingSeconds) return false
    return s.hitPercent >= spec.hitPercent
  }
  return false
}

/**
 * Exported for ONE caller: the still-shelf gate in the centre, which must know
 * — before the outbox row exists — whether any enabled rule would fire on THIS
 * edge and wants a picture for it. Sharing the predicate is what keeps that gate
 * from becoming a second, drifting opinion about which edge belongs to which
 * rule. It is pure and reads nothing.
 */
export function matchesOccupancy(occ: NcOccupancyCondition, s: NcOccupancySubject): boolean {
  if ((occ.zoneId ?? undefined) !== (s.zoneId ?? undefined)) return false
  if ((occ.className ?? undefined) !== (s.className ?? undefined)) return false
  switch (occ.op) {
    case 'became-occupied':
    case '>=':
      return s.occupied === true && s.threshold === occ.count
    case 'became-free':
      return s.occupied === false && s.threshold === occ.count
    case '<=':
      return s.occupied === false && s.threshold === occ.count + 1
  }
}

/**
 * The zone ids a `zones` / `zonesExclude` condition tests against: the
 * record's membership PLUS the zone it crossed, when it is a crossing.
 *
 * The union is what makes an EXIT addressable. Membership is computed from the
 * box's current geometry, so on the frame an exit is confirmed the subject is
 * by definition no longer in the zone — a rule scoped to "Uscio" would never
 * see the exit from Uscio. An ENTRY's zone is already in the membership, so
 * this changes nothing for every rule that exists today.
 */
function zonesVisitedBy(subject: NcRuleSubject): ReadonlySet<string> {
  const visited = new Set(subject.zones)
  if (subject.crossing !== undefined) visited.add(subject.crossing.zoneId)
  return visited
}

/**
 * Could this `device-event` rule fire on a sensor change of `sensorKind`?
 * The SAME two refusals {@link evaluateRule} makes before anything else a
 * sensor subject is judged on — an `occupancy` condition (such a rule targets
 * only occupancy edges, which ride the same delivery) and a `sensorKinds` list
 * that excludes the kind — for a caller that must decide from the rules alone,
 * before the subject exists (the linked-camera capture gate). Coarse in one
 * direction only: `true` may still fail later; `false` never would have fired.
 */
export function deviceEventRuleMayFireOnKind(
  rule: NcEvaluableRule,
  sensorKind: string,
  sensorRaised?: boolean,
): boolean {
  const c = rule.conditions
  if (c.occupancy !== undefined) return false
  // The chosen EDGE (D640), with the evaluation's own predicate: an unknown
  // edge (`undefined`) never refuses, so the gate stays coarse the safe way.
  if (sensorTransitionRefuses(c.sensorTransition, sensorRaised)) return false
  if (c.sensorKinds === undefined || c.sensorKinds.length === 0) return true
  return toLowerSet(c.sensorKinds).has(sensorKind.trim().toLowerCase())
}

/**
 * Does a rule's `sensorTransition` refuse this edge? Only a KNOWN edge can be
 * refused: `sensorRaised === undefined` (a kind with no raise, an unreadable
 * slice) always passes — a flood rule never goes silent on a bad read (D640).
 * The ONE predicate {@link evaluateRule} and the capture gate both ask.
 */
function sensorTransitionRefuses(
  transition: NcConditions['sensorTransition'],
  sensorRaised: boolean | undefined,
): boolean {
  if (transition === undefined || sensorRaised === undefined) return false
  return sensorRaised !== (transition === 'raised')
}

function toLowerSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.map((v) => v.trim().toLowerCase()))
}

/**
 * Does the subject's identity appear in `scope`?
 *
 * TWO LEGS, both load-bearing, and the reason is the migration rather than
 * indecision. `scope` holds gallery ids after `NcRuleStore.load` has resolved
 * them; a name it could not resolve is left as it stands (reported, never
 * dropped), and a record written before ids reached `LabelAttribution` carries
 * a name and no id. Matching only the id would silence the first case; matching
 * only the name would re-introduce the rename bug the id exists to fix.
 *
 * The id leg is exact (a uuid has no case); the name leg is the historical
 * trim + lowercase comparison, unchanged, so a rule that matched yesterday
 * matches today.
 */
function matchesIdentityScope(subject: NcRuleSubject, scope: readonly string[]): boolean {
  if (subject.identityId !== undefined && scope.includes(subject.identityId)) return true
  const label = subject.label?.trim().toLowerCase()
  return label !== undefined && toLowerSet(scope).has(label)
}

/**
 * Does this rule's match depend on RECOGNITION — a face identity or a plate
 * read — rather than on the detection alone?
 *
 * Derived from the conditions the rule already carries; nothing stores it.
 * Renamed from `ruleAwaitsRecognition` by D692: on a grouped rule it decides
 * whether a member that never got a name inside the window is DROPPED at close.
 * (The D142 users below go away with the rest of that path.)
 * `identitiesExclude` is deliberately NOT in the set: a veto is satisfied by
 * the ABSENCE of a recognition.
 */
export function ruleHasRecognitionScope(rule: NcEvaluableRule): boolean {
  return rule.conditions.identities !== undefined || rule.conditions.plates !== undefined
}

/**
 * A rule "belongs to the alarm" when its `deviceState` gate names ANY device's
 * `armed_*` word — CamStack's own panel or any other, e.g. an HA-mirrored
 * alarm panel — or when an ENABLED `onTrigger` sequence pulls the panel's
 * trigger itself. Such a rule fires on an opening's OPENING edge only: closing
 * a window while armed is not an intrusion (D630).
 *
 * This is NOT the arm check's coverage predicate (`alarm-mode-coverage.ts`):
 * it ignores which device the gate names, which mode, whether the rule is
 * enabled and what it is scoped to. It answers only "should this rule refuse
 * a closing edge", and erring wide there costs a closing notification nobody
 * gated on an armed word would have wanted anyway.
 *
 * Derived, never a stored flag: both rule editors prune condition keys to the
 * catalog on save, so a new key would be dropped by the first edit.
 */
export function ruleBelongsToAlarm(
  rule: NcEvaluableRule,
  sequenceActionsOf?: (
    sequenceId: string,
  ) => readonly import('@camstack/types').NcRuleAction[] | undefined,
): boolean {
  // The predicate itself lives in `@camstack/types` (`alarm-membership.ts`) so
  // the editors' D640 warning asks the very same question.
  return sharedRuleBelongsToAlarm({
    conditions: rule.conditions,
    ...(rule.actions !== undefined ? { actions: rule.actions } : {}),
    ...(sequenceActionsOf !== undefined ? { sequenceActionsOf } : {}),
  })
}

/**
 * The edge an alarm rule refuses: a close, or a halt/fault (a cover stopped
 * after it already opened would otherwise fire twice; after a close it would
 * fire as if it had opened; a jammed lock is a fault, not an entry).
 */
function isRefusedAlarmEdge(edge: NcSensorEdge | undefined): boolean {
  return edge === 'closing' || edge === 'neither'
}

/**
 * Expand each selected class id to itself PLUS its taxonomy leaf subs, so a
 * MACRO selection (`vehicle`) matches its sub classNames (`car`/`truck`) — the
 * `EVENT_TAXONOMY` tree is the SINGLE source (mirrors the timeline/filter
 * grouping). A leaf id expands to just itself. Applies to the video class
 * matchers (`classes` / `classesExclude`); audio ids (`audio-*`) are leaves so
 * they expand to themselves. Lower-cased for the case-insensitive membership
 * test.
 */
function expandClassSelector(classes: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const raw of classes) {
    const c = raw.trim().toLowerCase()
    if (c.length === 0) continue
    out.add(c)
    for (const subEntry of subKindsOf(c)) out.add(subEntry.kind.trim().toLowerCase())
  }
  return out
}

/**
 * True when a rule's `classes` condition explicitly opts in to at least one
 * audio kind (`audio-*` id). The safety gate for audio subjects: an `immediate`
 * rule fires on an audio subject ONLY when it names an audio class — a rule with
 * no classes, or with only video classes, NEVER fires on audio (preserves
 * today's behavior, where classified audio never reached the engine at all).
 */
export function referencesAudioClass(classes: readonly string[] | undefined): boolean {
  if (classes === undefined) return false
  return classes.some((c) => c.trim().toLowerCase().startsWith('audio-'))
}

/**
 * Evaluate one rule against one subject. The rule's `delivery` must match
 * the subject kind (`immediate` ↔ `object-event`, `track-end` ↔
 * `track-end`) — a mismatch fails with `'delivery'`. Schedule is evaluated
 * at the SUBJECT timestamp (the persist moment), so boot-time reconcile of
 * missed records applies the schedule the record lived under.
 *
 * Throttle/cooldown is deliberately NOT part of this function — cooldown
 * is stateful; see {@link cooldownKey} / {@link isCoolingDown}.
 *
 * `zoneOwners` is the second no-I/O lookup, for the same reason as
 * `deviceState`: it answers "which zones does this camera own?" from a mirror
 * the caller refreshes off the event path, so a multi-camera rule can scope its
 * `zones` condition per camera (see `zone-ownership.ts`). Absent ⇒ the flat,
 * pre-scoping behaviour, unchanged.
 */
/**
 * Reads the CURRENT state of another device, for the `deviceState` gate.
 *
 * A function rather than a map so the caller owns the freshness policy, and so
 * `evaluateRule` stays pure — it runs on the persist hook, per event, and must
 * never do I/O. `undefined` (or an empty list) means "not readable", which
 * never matches.
 *
 * A LIST of words, because one device may truthfully be in two: the alarm
 * panel's `pending`/`triggered` also answers as the armed mode it belongs to
 * (`alarm/alarm-gate-words.ts`, D630). A normal device answers one word. The
 * gate matches when ANY word is among the rule's states.
 */
export type NcDeviceStateLookup = (deviceId: number) => readonly string[] | undefined

/**
 * Reads the CURRENT state of a scene, for the `scene` gate.
 *
 * Same contract and the same reasons as {@link NcDeviceStateLookup}: a function
 * so the caller owns the freshness policy, and so `evaluateRule` stays pure —
 * it runs on the persist hook, per event, and must never do I/O. `undefined`
 * means "not readable", which never matches (D49: the gate reads a mirror
 * refreshed off the event path; a read that fails changes nothing and un-gates
 * nothing).
 */
export type NcSceneStateLookup = (sceneId: string) => NcSceneObservation | undefined

/**
 * Why a system subject was refused — `'kinds'` for the opt-in gate, otherwise
 * the narrowing filter that excluded it.
 *
 * The filter is NAMED rather than folded into a boolean because a legitimate
 * exclusion still has to be explainable: "your rule did not fire because it
 * only covers cameras and this is a switch" is an answer; a silent `false` on
 * a device-scoped kind is the shape of every notification outage this file has
 * had. See {@link NcEvaluation.excludedBySystemEventFilter}.
 */
export type NcSystemEventExclusion = 'kinds' | NcSystemEventExcludingFilter

/**
 * Match one system subject against one rule's system-event condition.
 *
 * EVERY NARROWING FILTER IS SCOPED TO ITS KIND FAMILY, and the scoping is not
 * decided here: `systemEventFilterApplies` (in `@camstack/types`) is the one
 * statement of it, and both rule editors compute their filter visibility from
 * the same predicate. A filter outside a kind's family is IGNORED — never an
 * exclusion. It used to be an exclusion, and that made the operator's
 * eleven-kind rule with `deviceTypes: ['camera']` deliverable for exactly the
 * two kinds that carry a device type; the other nine failed closed and logged
 * nothing for four days.
 *
 * Inside its family a filter still narrows, and still fails CLOSED when the
 * subject cannot produce the identity it tests.
 *
 * Returns `undefined` on a match.
 */
function systemEventExclusion(
  condition: NcSystemEventCondition,
  subject: NcSystemEventSubject,
): NcSystemEventExclusion | undefined {
  if (!condition.kinds.includes(subject.kind)) return 'kinds'
  const applies = (filter: NcSystemEventFilterKey): boolean =>
    systemEventFilterApplies(subject.kind, filter)
  if (condition.deviceIds !== undefined && applies('deviceIds')) {
    if (subject.deviceId === undefined || !condition.deviceIds.includes(subject.deviceId)) {
      return 'deviceIds'
    }
  }
  // INCLUDE FIRST, THEN EXCLUDE. The exclude list rides the include list's
  // family (a node has no device to exclude) and never fails closed: a subject
  // with no device id is simply not in it. A consumable subject
  // (`consumable:<id>:<key>`) carries its DEVICE id here, so one entry mutes
  // every item of that device.
  const excluded = condition.excludeDeviceIds
  if (excluded !== undefined && applies('deviceIds')) {
    if (subject.deviceId !== undefined && excluded.includes(subject.deviceId)) {
      return 'excludeDeviceIds'
    }
  }
  // WHICH DEVICES COUNT AS WORTH HEARING ABOUT — the rule's answer, not the
  // intake's. Liveness is emitted for every device type; a household that only
  // wants cameras says so here. Fails closed on an unknown type: a device the
  // mirror cannot name is not evidence of a camera.
  if (condition.deviceTypes !== undefined && applies('deviceTypes')) {
    if (subject.deviceType === undefined || !condition.deviceTypes.includes(subject.deviceType)) {
      return 'deviceTypes'
    }
  }
  const wantedNodes = condition.nodeIds
  if (wantedNodes !== undefined && applies('nodeIds')) {
    const nodes = subjectNodes(subject)
    if (!nodes.some((id) => wantedNodes.includes(id))) return 'nodeIds'
  }
  const wantedPackages = condition.packageNames
  if (wantedPackages !== undefined && applies('packageNames')) {
    const packages = subjectPackages(subject)
    if (!packages.some((name) => wantedPackages.includes(name))) return 'packageNames'
  }
  // THE RULE'S CONSUMABLE THRESHOLD (D642). Unlike the lists above it is in
  // force even when the rule does not state it (the default, 15): a consumable
  // episode is always judged at SOME threshold, and a rule hears only the
  // episode judged at its own. A subject that carries no judgement is not
  // refused — nothing about it disagrees with the rule.
  if (applies('consumableLowPercent') && subject.consumableLowPercent !== undefined) {
    if (subject.consumableLowPercent !== consumableLowPercentOf(condition)) {
      return 'consumableLowPercent'
    }
  }
  return undefined
}

function subjectNodes(subject: NcSystemEventSubject): readonly string[] {
  const ids = [...(subject.nodeIds ?? [])]
  if (subject.nodeId !== undefined && !ids.includes(subject.nodeId)) ids.push(subject.nodeId)
  return ids
}

function subjectPackages(subject: NcSystemEventSubject): readonly string[] {
  const names = [...(subject.packageNames ?? [])]
  if (subject.packageName !== undefined && !names.includes(subject.packageName)) {
    names.push(subject.packageName)
  }
  return names
}

export function evaluateRule(
  rule: NcEvaluableRule,
  subject: NcRuleSubject,
  deviceState?: NcDeviceStateLookup,
  zoneOwners?: NcZoneOwnerLookup,
  sceneStates?: NcSceneStateLookup,
  options?: NcEvaluateOptions,
): NcEvaluation {
  // No allocation on the hot path: `relax` is absent on every plain evaluation.
  const relax = options?.relax
  const pendingOn: NcRecognitionCondition[] = []
  /**
   * A relaxed recognition condition answers PENDING and the gauntlet goes on; every other
   * condition fails exactly as before. Returns the failure to return, or null to continue.
   */
  const recognitionGate = (id: NcRecognitionCondition): NcEvaluation | null => {
    if (relax?.includes(id) === true) {
      pendingOn.push(id)
      return null
    }
    return fail(id)
  }
  if (subject.kind === 'system-event') {
    if (rule.delivery !== 'system-event') return fail('delivery')
    const condition = rule.conditions.systemEvent
    const systemEvent = subject.systemEvent
    if (condition === undefined || systemEvent === undefined) return fail('systemEvent')
    const excluded = systemEventExclusion(condition, systemEvent)
    if (excluded !== undefined) {
      // The kind gate is the rule saying "not my business"; a FILTER exclusion
      // is the rule saying "mine, and I dropped it" — only the second is worth
      // a line, so only the second is named.
      return excluded === 'kinds'
        ? fail('systemEvent')
        : { matched: false, failedCondition: 'systemEvent', excludedBySystemEventFilter: excluded }
    }
    if (rule.conditions.occupancy !== undefined) return fail('occupancy')
    if (rule.conditions.audio !== undefined) return fail('audio')
  } else if (subject.kind === 'occupancy-event') {
    // Occupancy edges ride the EXISTING `device-event` delivery via an internal
    // subject kind. A non-device-event rule never targets an occupancy subject.
    if (rule.delivery !== 'device-event') return fail('delivery')
    // SAFETY GATE: fire ONLY when the rule declares an `occupancy` condition —
    // a plain device-event (sensor) rule must never fire on an occupancy edge.
    const occ = rule.conditions.occupancy
    if (occ === undefined) return fail('occupancy')
    // The edge is present by construction on an occupancy subject; match its
    // scope + op/threshold. A mismatch fails closed.
    if (subject.occupancy === undefined || !matchesOccupancy(occ, subject.occupancy)) {
      return fail('occupancy')
    }
    if (rule.conditions.systemEvent !== undefined) return fail('systemEvent')
    if (rule.conditions.audio !== undefined) return fail('audio')
    // Falls through to the shared gauntlet: `devices`/`schedule` compose and the
    // object/track/label/zone/package conditions fail closed (no bbox/label/
    // confidence/importance/sensorKind on an occupancy subject).
  } else if (subject.kind === 'audio-window') {
    // Sustained-sound windows ride the EXISTING `immediate` delivery via an
    // internal subject kind (no new delivery enum — the viewer mirrors that one
    // by hand). A non-immediate rule never targets an audio window.
    if (rule.delivery !== 'immediate') return fail('delivery')
    // SAFETY GATE: fire ONLY when the rule declares an `audio` condition — a
    // detection rule, and the LEGACY audio-class rule, must never fire on a
    // window. That is also what keeps this whole path dark until an audio rule
    // exists: no rule declares the condition, so no window can reach a target.
    const audio = rule.conditions.audio
    if (audio === undefined) return fail('audio')
    if (subject.audioWindow === undefined || !matchesAudio(audio, subject.audioWindow)) {
      return fail('audio')
    }
    if (rule.conditions.occupancy !== undefined) return fail('occupancy')
    if (rule.conditions.systemEvent !== undefined) return fail('systemEvent')
    // Falls through to the shared gauntlet: `devices`, `schedule`, `classes`
    // and `deviceState` compose (the window carries `audio-*` class names);
    // every object/track condition fails closed (no bbox, label, importance or
    // dwell on a window).
  } else if (subject.kind === 'audio-event') {
    // Audio classification events ride the EXISTING `immediate` delivery (no
    // new delivery enum). A non-immediate rule never targets an audio subject.
    if (rule.delivery !== 'immediate') return fail('delivery')
    // Checked BEFORE the class opt-in: a rule that asks for ten seconds of
    // barking must not fire on one bark, and saying so is a more useful
    // verdict than "your classes did not overlap".
    if (rule.conditions.audio !== undefined) return fail('audio')
    // SAFETY GATE: fire on audio ONLY when the rule explicitly opts in to an
    // `audio-*` class. A rule with no classes (or only video classes) must
    // never fire on an audio subject — the classNames overlap check below then
    // still requires the SPECIFIC audio id to match (audio-scream ≠ audio-dog).
    if (!referencesAudioClass(rule.conditions.classes)) return fail('classes')
    // A rule carrying an occupancy condition targets ONLY occupancy subjects.
    if (rule.conditions.occupancy !== undefined) return fail('occupancy')
    if (rule.conditions.systemEvent !== undefined) return fail('systemEvent')
  } else {
    // Each (non-audio) delivery value maps 1:1 onto a subject kind (`immediate`
    // is the sole alias — it fires on the object-event persist). A mismatch
    // means the rule does not target this trigger.
    const deliveryKind: NcSubjectKind =
      rule.delivery === 'immediate' ? 'object-event' : rule.delivery
    if (deliveryKind !== subject.kind) return fail('delivery')
    // A rule carrying an occupancy condition targets ONLY occupancy subjects; a
    // sensor / object / track / package subject can never satisfy it (fail closed).
    if (rule.conditions.occupancy !== undefined) return fail('occupancy')
    if (rule.conditions.systemEvent !== undefined) return fail('systemEvent')
    // Same for an audio condition: a detection is not a sound.
    if (rule.conditions.audio !== undefined) return fail('audio')
  }

  const c = rule.conditions

  if (c.deviceState !== undefined) {
    // FAIL CLOSED, in three ways that all mean the same thing: no lookup wired,
    // the device unknown, the cache cold. A gate that fired on "I could not
    // read it" would leave the operator believing a rule is suppressed while it
    // is notifying — strictly worse than having no gate.
    const words = deviceState?.(c.deviceState.deviceId)
    if (words === undefined || words.length === 0) return fail('deviceState')
    // Device vocabularies are not normalised across providers; an alarm that
    // reports `Armed_Away` must still arm a rule written against `armed_away`.
    const wanted = toLowerSet(c.deviceState.states)
    if (!words.some((w) => wanted.has(w.trim().toLowerCase()))) {
      return fail('deviceState')
    }
  }

  // THE OPENING EDGE (D630). Only a rule that belongs to the alarm, and only an
  // edge the slice could name — a kind with no opening meaning (motion,
  // doorbell…) or an unreadable slice leaves `sensorEdge` absent and is not
  // filtered. Every other rule keeps firing on both edges. The intake's
  // `rule did not match` debug line names `sensorEdge` with the deviceId tag.
  // AFTER the `deviceState` gate, so a closing on a DISARMED panel is reported
  // as the gate that really stopped it (`deviceState`), not as an edge.
  if (
    subject.kind === 'device-event' &&
    isRefusedAlarmEdge(subject.sensorEdge) &&
    ruleBelongsToAlarm(rule)
  ) {
    return fail('sensorEdge')
  }

  // SCENE GATE. A gate, not a trigger: it narrows a rule that already has one,
  // and it therefore sits here in the shared gauntlet with `deviceState` rather
  // than in a subject-kind branch above (D159).
  //
  // FAIL CLOSED in every direction that means "I could not read it": no lookup
  // wired, the scene unknown to the mirror, the mirror cold or aged out. And on
  // the LIVE reading `unknown` is not a third answer to fall back on — a scene
  // that cannot judge is not evidence that the bin is out and not evidence that
  // it is back. `sceneConditionSatisfied` owns the whole decision so there is
  // one place it can be wrong.
  if (c.scene !== undefined) {
    const observation = sceneStates?.(c.scene.sceneId)
    if (observation === undefined) return fail('scene')
    if (!sceneConditionSatisfied(c.scene, observation)) return fail('scene')
  }

  if (c.devices !== undefined && c.devices.length > 0 && !matchesDeviceScope(c.devices, subject)) {
    return fail('devices')
  }
  // D641: the same subject ids, at the same place, read the other way.
  if (c.devicesExclude !== undefined && deviceScopeExcludes(c.devicesExclude, subject)) {
    return fail('devicesExclude')
  }

  if (c.source !== undefined && c.source !== 'any') {
    // Absent stamped source ⇒ pipeline (schema default), so an un-sourced
    // subject still matches a `pipeline` filter.
    const src = subject.source ?? 'pipeline'
    if (src !== c.source) return fail('source')
  }

  const subjectClasses = toLowerSet(subject.classNames)
  if (c.classes !== undefined && c.classes.length > 0) {
    // Macro→leaf expansion: selecting `vehicle` matches `car`/`truck` (single
    // source: EVENT_TAXONOMY). Audio ids are leaves (expand to themselves).
    const wanted = expandClassSelector(c.classes)
    let overlap = false
    for (const cls of subjectClasses) {
      if (wanted.has(cls)) {
        overlap = true
        break
      }
    }
    if (!overlap) return fail('classes')
  }
  if (c.classesExclude !== undefined && c.classesExclude.length > 0) {
    // Symmetric macro expansion: excluding `animal` vetoes `dog`/`cat`/…
    const vetoed = expandClassSelector(c.classesExclude)
    for (const cls of subjectClasses) {
      if (vetoed.has(cls)) return fail('classesExclude')
    }
  }

  if (c.minConfidence !== undefined) {
    if (subject.confidence === undefined || subject.confidence < c.minConfidence) {
      return fail('minConfidence')
    }
  }

  if (c.minImportance !== undefined) {
    if (subject.importance === undefined || subject.importance < c.minImportance) {
      return fail('minImportance')
    }
  }

  // Track-end only: an object-event subject carries no dwell, so the
  // condition never matches immediate delivery (documented boundary).
  if (c.minDwellSeconds !== undefined) {
    if (subject.dwellSeconds === undefined || subject.dwellSeconds < c.minDwellSeconds) {
      return fail('minDwellSeconds')
    }
  }

  // Zone-crossing DIRECTION. Absent = `enter`, which is what every rule
  // authored before this condition existed already does: entries and
  // non-crossing records pass, exits do not. `exit` is the mirror and fails
  // closed on a record that is not a crossing at all (a movement-state
  // transition is not an answer to "did it leave?"). `any` filters nothing.
  if (c.crossing !== 'any') {
    const direction = subject.crossing?.direction
    if (c.crossing === 'exit') {
      if (direction !== 'exit') return fail('crossing')
    } else if (direction === 'exit') {
      return fail('crossing')
    }
  }

  if (c.zones !== undefined) {
    // PER-CAMERA scope first (see `zone-ownership.ts`): the id list is flat but
    // a rule that NAMES several cameras is routinely multi-camera, and a zone
    // picked on camera A is an instruction about A — not a filter every other
    // named camera must satisfy with a polygon it does not have. `inert` = this
    // camera owns none of the listed zones ⇒ whole-frame. Unknown ownership,
    // and a rule that names no camera at all, keep the flat list (never a pass
    // on a read that failed, never a widening the operator did not ask for).
    const scope = scopeZoneIdsForRule(
      { ids: c.zones.ids, deviceScope: c.devices, deviceId: subject.deviceId },
      zoneOwners,
    )
    if (scope.kind !== 'inert') {
      const scopedIds = scope.kind === 'scoped' ? scope.ids : c.zones.ids
      const visited = zonesVisitedBy(subject)
      if (c.zones.match === 'all') {
        for (const id of scopedIds) {
          if (!visited.has(id)) return fail('zones')
        }
      } else {
        const hit = scopedIds.some((id) => visited.has(id))
        if (!hit) return fail('zones')
      }
    }
  }
  // `zonesExclude` needs NO scoping and deliberately gets none: zone ids are
  // unique per camera, so excluding a zone of camera A is already a no-op for
  // camera B (B can never visit it). Scoping a veto would also be the unsafe
  // direction — an ownership answer that went missing would drop the veto and
  // notify on exactly what the operator excluded.
  if (c.zonesExclude !== undefined && c.zonesExclude.length > 0) {
    const visited = zonesVisitedBy(subject)
    if (c.zonesExclude.some((id) => visited.has(id))) return fail('zonesExclude')
  }

  // Geometric custom zones (viewer-drawn polygons, normalized 0..1). Mirrors
  // the platform ZoneEngine: any POSITIVE bbox↔polygon overlap = membership
  // (`bboxPolygonOverlap > 0`), OR across the listed polygons. A subject with
  // no normalized bbox (device-event, or a detection whose box couldn't be
  // normalized) fails closed — never guess geometry.
  if (c.customZones !== undefined && c.customZones.length > 0) {
    const bbox = subject.bbox
    const inAny =
      bbox !== undefined && c.customZones.some((poly) => bboxPolygonOverlap(bbox, poly.points) > 0)
    if (!inAny) return fail('customZones')
  }

  const label = subject.label?.trim().toLowerCase()
  if (c.labelEquals !== undefined && c.labelEquals.length > 0) {
    if (label === undefined || !toLowerSet(c.labelEquals).has(label)) {
      const gate = recognitionGate('labelEquals')
      if (gate !== null) return gate
    }
  }
  // KNOWN FACES. Present at all = "only recognised people": a subject the face
  // pipeline never named fails, whatever the list says. An EMPTY list then
  // narrows to nobody in particular, which is every known identity — the same
  // "no selection = no narrowing" reading an absent `devices` list has.
  //
  // The primary key is the GALLERY ID (`identityId`), because a display name is
  // renameable and a rule authored on the old spelling went dark without a
  // word. The name leg is a COMPATIBILITY fallback and is load-bearing during
  // the migration window: a rule whose name could not be resolved to an id
  // (`NcRuleStore.load` reports those) keeps matching exactly what it matched
  // before, and a track labelled before ids reached the record still matches an
  // id-authored rule via its name. Remove one leg and one of those goes silent.
  if (c.identities !== undefined) {
    const scoped =
      c.identities.length > 0
        ? matchesIdentityScope(subject, c.identities)
        : // "Any known face" is only decidable from the label's PROVENANCE, and
          // that only exists on records written after `LabelAttribution.identityId`
          // shipped. Fail-closed on an unattributed label is right here and only
          // here: the empty list cannot have been authored before the field.
          subject.labelKind === 'identity'
    if (!scoped) {
      const gate = recognitionGate('identities')
      if (gate !== null) return gate
    }
  }
  // Mirror of `identities` with notIn semantics: an UNRECOGNISED subject passes
  // (nothing to exclude); a recognised one fails when it is on the list. An
  // empty list excludes nobody.
  if (c.identitiesExclude !== undefined && c.identitiesExclude.length > 0) {
    if (matchesIdentityScope(subject, c.identitiesExclude)) {
      const gate = recognitionGate('identitiesExclude')
      if (gate !== null) return gate
    }
  }
  if (c.minLabelConfidence !== undefined) {
    if (subject.labelConfidence === undefined || subject.labelConfidence < c.minLabelConfidence) {
      const gate = recognitionGate('minLabelConfidence')
      if (gate !== null) return gate
    }
  }
  // KNOWN PLATES — the same three states as `identities`. Present = "only
  // vehicles whose plate was read"; empty list = any readable plate; a list =
  // those, fuzzily.
  if (c.plates !== undefined) {
    const scoped =
      c.plates.values.length > 0
        ? subject.label !== undefined &&
          matchesPlate(subject.label, c.plates.values, c.plates.maxDistance)
        : // Same reasoning as the empty identity list: "any plate" needs the
          // label to SAY it is a plate, and only an attributed label does.
          subject.labelKind === 'plate'
    if (!scoped) {
      const gate = recognitionGate('plates')
      if (gate !== null) return gate
    }
  }

  // Device-event conditions. `sensorKinds` gates the taxonomy kind; a subject
  // with no kind fails. `eventTypeTokens` gates the raw event-emitter token;
  // a subject with no token (doorbell pulse / passive sensor) fails.
  if (c.sensorKinds !== undefined && c.sensorKinds.length > 0) {
    if (
      subject.sensorKind === undefined ||
      !toLowerSet(c.sensorKinds).has(subject.sensorKind.trim().toLowerCase())
    ) {
      return fail('sensorKinds')
    }
  }
  if (c.eventTypeTokens !== undefined && c.eventTypeTokens.length > 0) {
    if (
      subject.eventType === undefined ||
      !toLowerSet(c.eventTypeTokens).has(subject.eventType.trim().toLowerCase())
    ) {
      return fail('eventTypeTokens')
    }
  }
  // WHICH EDGE of a boolean sensor (D640). Only a subject that could name its
  // edge is filtered: a kind with no raise (a doorbell press) and an unreadable
  // slice leave `sensorRaised` absent and PASS — a flood rule must not go
  // silent because one read failed (the `sensorEdge` stance). That pass is
  // visible: the intake's `rule matched` line carries `sensorRaised: null`.
  if (sensorTransitionRefuses(c.sensorTransition, subject.sensorRaised)) {
    return fail('sensorTransition')
  }

  // Package-event phase. `both` matches either phase; a specific phase must
  // equal the subject's (a package subject always carries one).
  if (c.packagePhase !== undefined && c.packagePhase !== 'both') {
    if (subject.packagePhase !== c.packagePhase) return fail('packagePhase')
  }

  if (!isScheduleActive(rule.schedule, subject.timestamp)) return fail('schedule')

  const firstPending = pendingOn[0]
  if (firstPending !== undefined) {
    return { matched: false, failedCondition: firstPending, pendingOn }
  }
  return { matched: true, matchedOn: presentConditionIds(c) }
}

// ── Schedule ────────────────────────────────────────────────────────

/**
 * Schedule evaluation moved to `@camstack/types` when the OSD manager
 * became a second consumer of the same `NcSchedule` vocabulary (addons
 * never import each other, so the only other option was a copy). Re-exported
 * here because callers — including `timelapse/window-machine.ts` — import it
 * from this module.
 */
export { isScheduleActive } from '@camstack/types'

// ── Plate fuzzy matching ────────────────────────────────────────────

/** Normalize a plate string: uppercase, alphanumeric only. */
export function normalizePlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Classic two-row Levenshtein distance (plates are short strings). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) prev[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    const tmp = prev
    prev = curr
    curr = tmp
  }
  return prev[b.length]!
}

/** Fuzzy plate membership: min edit distance over `values` ≤ `maxDistance`. */
export function matchesPlate(
  label: string,
  values: readonly string[],
  maxDistance: number,
): boolean {
  const plate = normalizePlate(label)
  if (plate.length === 0) return false
  for (const v of values) {
    if (levenshtein(plate, normalizePlate(v)) <= maxDistance) return true
  }
  return false
}

// ── Throttle (pure helpers — state lives in the caller) ─────────────

/** The throttle shape the cooldown helpers need. `granularity` is optional
 *  here because a rule persisted before the field carries none — and a Zod
 *  default does not run on the addon cap path. Absent reads as `per-class`
 *  (the operator's default, 2026-10-01 — D36's dated note); only an explicit
 *  `shared` still reads as `shared`. */
export interface NcThrottleSpec {
  readonly cooldownSec: number
  readonly scope: 'rule' | 'rule-device'
  readonly granularity?: NcThrottleGranularity
}

/** A rule shape carrying what the cooldown helpers need. */
export interface NcThrottledRule {
  readonly id: string
  readonly throttle: NcThrottleSpec
}

/**
 * Subject kinds whose `classNames` is a real, operator-meaningful detection
 * class — the ones the `classes` condition can actually scope a rule to.
 * `device-event` and `system-event` carry NO class live (`classNames: []`,
 * always — see `subjectFromSensorEvent`); their OUTBOX `className` is a
 * display placeholder instead (the sensor kind, or the literal `'event'`,
 * `className: subject.classNames[0] ?? subject.sensorKind ?? 'event'`), which
 * `cooldownSubjectFromOutbox` would otherwise reconstruct as if it were a real
 * class. Gating here, not on the reconstructed value, keeps the live path and
 * the boot reseed addressing the SAME key regardless of what a display label
 * happens to say (2026-10-01, caught by `system-event-cooldown-direction.spec.ts`
 * when the default below flipped).
 */
const CLASS_BEARING_SUBJECT_KINDS: ReadonlySet<NcSubjectKind> = new Set([
  'object-event',
  'track-end',
  'package-event',
  'occupancy-event',
  'audio-event',
  'audio-window',
])

/**
 * Should this subject's class be part of the cooldown key?
 *
 * AUDIO is unconditional and predates the setting: a rule opted into several
 * audio classes (dog + scream) must not have a safety-relevant scream
 * swallowed by an unrelated bark's 60 s window.
 *
 * A `device-event` or `system-event` subject never reads a class — see
 * {@link CLASS_BEARING_SUBJECT_KINDS} — so the setting has nothing to key on
 * regardless of `granularity`.
 *
 * Every class-bearing subject gets the same treatment unless the rule
 * explicitly asks for `shared` — cat→dog fires at once, cat→cat still waits.
 * That is the operator's default since 2026-10-01 (D36's dated note): an
 * UNSET rule now reads exactly like an explicit `per-class` one, new rules and
 * existing rules alike. Only a `granularity: 'shared'` actually stored
 * reproduces the old class-agnostic key byte for byte — the one case where an
 * operator asked for one window across every class on purpose.
 */
function keysPerClass(rule: NcThrottledRule, subject: NcRuleSubject): boolean {
  if (subject.kind === 'audio-event' || subject.kind === 'audio-window') return true
  if (!CLASS_BEARING_SUBJECT_KINDS.has(subject.kind)) return false
  return rule.throttle.granularity !== 'shared'
}

/**
 * The cooldown scope of ONE system event — subject AND direction.
 *
 * The `kind` is here because a cooldown is a budget for VOLUME and must never
 * be a budget for a DIRECTION. `Eventi di sistema` (60 s, `rule-device`)
 * covers `device-offline` and `device-online` together, so on 2026-08-13 a
 * camera that came back 13 s after going down had its recovery suppressed:
 * the operator kept a "camera offline" as the last word while the camera was
 * up, and — because the liveness ledger HAD advanced on the suppressed flip —
 * the next outage was a genuine flip again and arrived as what read like a
 * duplicate. Same split D62 made one level up between `device-switch:<id>` and
 * `device:<id>`, for the same reason: two facts must not share a slot and
 * cancel each other out.
 *
 * ONE authority: `cooldownKey` and the boot-time cooldown reseed
 * (`NotificationCenter.seedCooldowns`) both call this. They used to build the
 * string separately, which is how a key format drifts across a restart.
 */
function systemEventCooldownScope(systemEvent: {
  readonly kind: NcSystemEventKind
  readonly subject: string
}): string {
  return `s:${systemEvent.subject}:k:${systemEvent.kind}`
}

/** Stable cooldown key per the rule's throttle scope + class granularity. */
/**
 * Does the rule's device scope cover this subject?
 *
 * EITHER id matches, and both are needed for the same rule to be authorable
 * the two ways an operator thinks about it:
 *
 *  - "when anything happens on the front-door CAMERA" → the camera id, which
 *    is what a sensor row is attributed to;
 *  - "when the front-door CONTACT opens" → the sensor id, which is the device
 *    the operator actually cares about and the one they pick in the Devices
 *    tab. Before this, that rule matched nothing, ever, silently.
 *
 * A sensor linked to MORE than one camera is evaluated once, at the sensor
 * level (ADR 0632), with `deviceId` = the primary camera. That evaluation
 * matches the SENSOR and the cameras that took a timeline row for it
 * (`rowCameraIds`) — exactly the rules the per-camera rows would have matched
 * (D630 §6). The primary is only the camera the notification leads with: one
 * that links the sensor without opting it in keeps its rules silent, and an
 * opted-in camera that is not the primary still fires its own. The other
 * linked cameras ride `linkedCameraIds` for the MEDIA only.
 */
function matchesDeviceScope(scope: readonly number[], subject: NcRuleSubject): boolean {
  if (subject.linkedSensorId !== undefined) {
    return (
      scope.includes(subject.linkedSensorId) ||
      (subject.rowCameraIds ?? []).some((cameraId) => scope.includes(cameraId))
    )
  }
  if (scope.includes(subject.deviceId)) return true
  // `linkedCameraIds` is deliberately NOT consulted: ADR 0632 widens which
  // cameras' stills a sensor notification SHOWS, never which rules fire. A
  // camera that links a sensor without opting it in keeps its rules silent
  // (D630 §6), however many other cameras link the same sensor.
  return subject.sourceDeviceId !== undefined && scope.includes(subject.sourceDeviceId)
}

/** The subject ids a device scope reads — the whole of {@link matchesDeviceScope}'s input. */
export type NcDeviceScopeSubject = Pick<
  NcRuleSubject,
  'deviceId' | 'sourceDeviceId' | 'linkedSensorId' | 'rowCameraIds'
>

/**
 * Does a rule's `devicesExclude` (D641) exclude this subject?
 *
 * The exact complement of {@link matchesDeviceScope}, row by row. A per-camera
 * row is excluded by its camera OR by the sensor that fired, the two ids an
 * include matches on. A linked set stands for the rows it replaced (D630 §6):
 * it is excluded when its SENSOR is, or when EVERY camera that took a row is —
 * one excluded row camera leaves the others firing, as their own rows would
 * have. A camera that only LINKS the sensor excludes nothing, for the reason it
 * includes nothing: ADR 0632 widens the media, never which rules fire.
 */
export function deviceScopeExcludes(
  excluded: readonly number[],
  subject: NcDeviceScopeSubject,
): boolean {
  if (excluded.length === 0) return false
  if (subject.linkedSensorId !== undefined) {
    if (excluded.includes(subject.linkedSensorId)) return true
    const rows = subject.rowCameraIds ?? []
    return rows.length > 0 && rows.every((cameraId) => excluded.includes(cameraId))
  }
  if (excluded.includes(subject.deviceId)) return true
  return subject.sourceDeviceId !== undefined && excluded.includes(subject.sourceDeviceId)
}

export function cooldownKey(rule: NcThrottledRule, subject: NcRuleSubject): string {
  const first = subject.classNames[0]
  const classKey = keysPerClass(rule, subject) && first !== undefined ? `:c:${first}` : ''
  const scopeRef =
    subject.systemEvent !== undefined
      ? systemEventCooldownScope(subject.systemEvent)
      : `d:${subject.deviceId}`
  // A system event carries its direction into BOTH scopes. Under `rule` the
  // operator asked for one notification per window across every device — never
  // for a recovery to be eaten by the outage that preceded it.
  const kindKey = subject.systemEvent !== undefined ? `:k:${subject.systemEvent.kind}` : ''
  // Same reasoning, same shape, for a parcel: delivery and pick-up are two
  // pieces of news about one object, and a shared window means the pick-up is
  // eaten by the delivery that preceded it. At the default 60 s cooldown a
  // parcel snatched within the minute would be notified only as delivered.
  const phaseKey = subject.packagePhase !== undefined ? `:p:${subject.packagePhase}` : ''
  return rule.throttle.scope === 'rule'
    ? `r:${rule.id}${kindKey}${phaseKey}${classKey}`
    : `r:${rule.id}:${scopeRef}${phaseKey}${classKey}`
}

/** True when the rule fired within its cooldown window before `now`. */
export function isCoolingDown(
  rule: NcThrottledRule,
  lastFiredAt: number | undefined,
  now: number,
): boolean {
  if (lastFiredAt === undefined) return false
  return now - lastFiredAt < rule.throttle.cooldownSec * 1000
}

// ── Rule media (D897) ────────────────────────────────────────────────

/**
 * The media policy a delivery is built from: the rule's own, with its picture
 * mode RESOLVED (`resolveNcMediaImage`) — a sensor rule included. Until D897 a
 * sensor rule's stored media was ignored for a fixed one-snapshot policy; it
 * now goes through the same selector and the same render stage as a detection
 * rule, its source frame being the linked camera's.
 */
export function effectiveMediaPolicy(rule: NcRule, kind: NcRuleKind): NcMediaPolicy {
  return { ...rule.media, image: resolveNcMediaImage(rule.media, kind) }
}

/** `effectiveMediaPolicy`, resolving the kind itself — the call-site shortcut. */
export function effectiveMediaPolicyForRule(rule: NcRule): NcMediaPolicy {
  return effectiveMediaPolicy(rule, ruleKindOf(rule))
}

/** True when a rule ships no still at all. */
export function ruleShipsNoStill(rule: NcRule): boolean {
  return effectiveMediaPolicyForRule(rule).image === 'none'
}

/**
 * The media kinds whose stored bytes carry a BURNT-IN detection box.
 *
 * This is the family boundary for {@link cleanSourcePreference} (D897; the retired
 * `framePreference` before it), and it exists as one
 * exported constant because the alternative was tried and failed in production:
 * the `boxed` ladder listed `snapshot` / `lastFrame` / `firstFrame` as *"the
 * kinds that actually carry a burnt-in box today"* while, eleven lines below,
 * the `full` ladder listed the same three as clean-scene fallbacks. Both
 * opinions were in one function and the wrong one shipped.
 *
 * They are annotated because ALL THREE are written by exactly one producer:
 * `event-media-dispatcher.ts#boxedTimelineFrame`, which composites the track's
 * own bbox onto the native frame via `drawBoxedFrame` before storing it under
 * whichever of the three kinds the periodic-media plan asked for. There is no
 * clean variant of them. (`fullFrameBoxed` is the retired legacy kind, kept
 * because stored tracks from before 2026-07-21 still hold it.)
 *
 * ## Why `full` still ends with three of these kinds (D654)
 *
 * The retired `framePreference('full', 'track')` used to reach these kinds as soon as the
 * key frame was out of band, so a rule asking for the clean scene was answered
 * with an annotated one: of 38 `frame:'full'` deliveries sha256-matched back to
 * stored media, **19 (50%) were `firstFrame` / `snapshot` / `lastFrame`**.
 * Deleting the tail was tried and refused on evidence — the still is gated on
 * the trigger instant first (±2 s) and the boxed tiles were the only DENSELY
 * written whole-scene kinds, so a strict ladder took the picture away from
 * 46.7% of those deliveries instead of cleaning it.
 *
 * D654 closes it at the WRITE side: every boxed tile now has a clean twin,
 * {@link SCENE_TWIN_KIND}, encoded from the same decoded surface in the same
 * write (`event-media-dispatcher.ts#boxedTimelineFrame`), so a clean candidate
 * exists at every instant an annotated one does and outranks it. The tail
 * stays as the LAST rung for tracks that hold no clean frame at all (written
 * before the twin, or a twin write that failed), and the dispatcher reports
 * every delivery that reaches it (`clean scene asked — only an annotated frame
 * is stored`, tagged with the camera) — it is never shipped silently.
 *
 * ORDER IS THE LADDER for `boxed`: newest-moment-first per family.
 */
export const ANNOTATED_SCENE_KINDS: readonly MediaFileKind[] = [
  'fullFrameBoxed',
  'snapshot',
  'lastFrame',
  'firstFrame',
]

/**
 * The whole-scene kinds with NOTHING drawn on them, best first.
 *
 * `keyFrame` is the native best-detection full frame and `keyFrameSmall` its
 * 960px twin — both produced by `key-frame-capture.ts` via `drawBoxedFrame(…,
 * [], …)`, i.e. the box-drawer invoked with an EMPTY box list purely to encode.
 * `fullFrame` is the clean original-resolution detection frame.
 *
 * {@link SCENE_TWIN_KIND} is clean too, and deliberately NOT listed here: this
 * list also feeds the AI narration pool (`NC_RULE_AI_TRACK_FRAME_KINDS`), where
 * a twin would sit at the same instant as its boxed tile and spend two of the
 * model's frames on one moment. The ladders name it explicitly.
 */
export const CLEAN_SCENE_KINDS: readonly MediaFileKind[] = [
  'keyFrame',
  'keyFrameSmall',
  'fullFrame',
]

/**
 * The CLEAN twin of a boxed timeline tile (D654): the same decoded surface as
 * the `firstFrame` / `snapshot` / `lastFrame` it accompanies, encoded with no
 * box. The dense clean whole-scene kind the `full` ladder lacked — see
 * {@link ANNOTATED_SCENE_KINDS}.
 */
const SCENE_TWIN_KIND: MediaFileKind = 'sceneFrame'

/**
 * The clean twin of the ROLLING `lastFrame` (D654) — single-instance, so the
 * rolling pair costs one upsert per roll. Ranked right after
 * {@link SCENE_TWIN_KIND}: both are clean, and MOMENT has already filtered the
 * candidates to the trigger instant before the kind order is consulted.
 */
const ROLLING_SCENE_TWIN_KIND: MediaFileKind = 'lastSceneFrame'

/** True when a stored kind carries a burnt-in detection box. */
export function isAnnotatedSceneKind(kind: MediaFileKind): boolean {
  return ANNOTATED_SCENE_KINDS.includes(kind)
}

/**
 * The SOURCE ladder of every notification picture (D897): the clean whole-scene
 * kinds of an owner, best first, then — LAST — the annotated tiles, for a
 * track that holds no clean frame at all (written before the D654 twin, or a
 * twin write that failed). The picture is rendered from what this picks, by
 * mode (`notification-image.ts`), so a rule no longer chooses a stored KIND:
 * `crop` cuts the subject out of the clean frame, `scene-boxes` draws on it.
 *
 * `keyFrame` leads because it is the native best-detection frame — the crop
 * keeps its resolution; the scene modes downscale it once at render. The twins
 * (`sceneFrame` at a boxed tile's instant, `lastSceneFrame` at the rolling
 * one) are what MOMENT finds near the trigger when the best shot is later.
 * A still-shelf photograph holds `keyFrameSmall` / `keyFrame` / `fullFrame`,
 * so a sound or a linked-camera still resolves through the same ladder.
 */
export function cleanSourcePreference(
  // D476: the only event-like media owner a rule's subject ever carries is an
  // OBJECT event — never motion or audio.
  ownerKind: 'object' | 'track',
): readonly MediaFileKind[] {
  return ownerKind === 'track'
    ? [
        'keyFrame',
        'keyFrameSmall',
        SCENE_TWIN_KIND,
        ROLLING_SCENE_TWIN_KIND,
        'fullFrame',
        // The annotated tail, in the order the clean-scene ladders always
        // walked it (the passage's start, its end, a mid snapshot, the retired
        // kind) — the same four kinds as ANNOTATED_SCENE_KINDS, which the spec
        // holds it to.
        'firstFrame',
        'lastFrame',
        'snapshot',
        'fullFrameBoxed',
      ]
    : ['fullFrame', 'keyFrame', 'keyFrameSmall', 'fullFrameBoxed']
}
