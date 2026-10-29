/**
 * The notification path's INTAKE SEAM — one event in, no knowledge of who
 * produced it.
 *
 * Why this file exists at all: until now every producer reached the centre
 * through its own record-shaped door (`onObjectEventPersisted(ObjectEvent)`,
 * `onSensorEventPersisted(SensorEvent)`, …). The doors did nothing but build a
 * subject and schedule an evaluation, yet their SIGNATURES made the notification
 * path look like a function of the pipeline's row types — so "notify about this"
 * was not expressible without first having a persisted row to hand.
 *
 * The split this file draws is between PRODUCING an event and CONSUMING one:
 *
 *   - The producer owns persistence. The tracker persists its tracks, the sensor
 *     ingest persists its rows, and a synthetic producer (the rule tester)
 *     persists NOTHING. Whether a row exists is the producer's business and
 *     never the consumer's.
 *   - The consumer owns match → media → delivery. It receives an
 *     {@link NcIncomingEvent} and cannot tell which producer built it, because
 *     the only thing the matcher can read is `subject`, and `subject` carries no
 *     provenance beyond the detection `source` a real record would carry anyway.
 *
 * {@link NcIncomingEvent.origin} exists for LOGS, and for the outbox row's
 * marker. It is deliberately NOT part of `NcRuleSubject`: a condition cannot
 * reach it, so no rule can be authored that behaves differently for a test. That
 * is the property the tester is worth nothing without — a test that takes a
 * different branch is a test of the branch, not of the rule.
 */

import {
  alertEpisodeKind,
  parseAlertEpisodePayload,
  deviceAttentionKind,
  type AlertEpisodePayload,
  type AudioEvent,
  type ConsumableForm,
  type NcDelivery,
  type NcSystemEventKind,
  type ObjectEvent,
  type SensorEvent,
  type SystemEvent,
  type Track,
} from '@camstack/types'
import type { NcAlarmTransition } from './alarm/alarm-transitions.js'
import type { NcBatteryBand, NcBatteryReading } from './alerts/battery-band.js'
import { consumableSubject, legacyConsumableSubject } from './alerts/consumable-subject.js'
import {
  intrusionDeviceOf,
  intrusionLocations,
  type NcAlarmPushSuppressReason,
} from './alarm/alarm-push-policy.js'
import type { AudioWindowHit } from './audio-rule-matcher.js'
import {
  deviceDisplayName,
  isAccessoryIdentity,
  type NcDeviceIdentity,
  type NcDeviceLookup,
} from './device-directory.js'
import type { OccupancyEdge } from './occupancy-watcher.js'
import {
  NC_SYSTEM_DEVICE_ID,
  type NcPackagePhase,
  type NcRuleFireRef,
  type NcRuleSubject,
  type NcSensorLinkedSubject,
  type NcSubjectKind,
  type NcTrackClosedInfo,
  subjectFromAudioEvent,
  subjectFromAudioWindow,
  subjectFromObjectEvent,
  subjectFromOccupancyEvent,
  subjectFromPackageEvent,
  subjectFromSensorEvent,
  subjectFromUnownedSensorEvent,
  subjectFromTrack,
} from './rule-engine.js'
import type { AddonUpdateComplete } from './update-complete-coalescer.js'

/**
 * Who built the event. Telemetry only — see the module docblock for why this
 * may never become a condition.
 *
 * `pipeline` covers every producer that reads the frame path (object events,
 * closed tracks, package phases, audio episodes, occupancy edges): they differ
 * in which record they hold, not in where they come from. `sensor` is the
 * linked-device ingest. `reconcile` is the boot crash-gap re-scan replaying
 * durable rows — worth telling apart from a live fire when reading a log.
 * `synthetic` is an operator-driven injection that persisted nothing.
 */
export type NcEventOrigin = 'pipeline' | 'sensor' | 'reconcile' | 'synthetic' | 'system'

/** The per-event log context every intake carries (device tag + record meta). */
export interface NcEventLogContext {
  readonly tags: Readonly<Record<string, number>>
  readonly meta: Readonly<Record<string, unknown>>
}

/**
 * Per-event overrides of the centre's SIDE gates.
 *
 * Never read by `evaluateRule` — every field here gates something that happens
 * around a match (the cooldown window, the per-camera mute, the actuation of
 * physical devices), never whether the match itself occurs. A producer that
 * omits this object gets production behaviour, which is what all three live
 * producers do.
 *
 * The one thing worth stating out loud: `runActions` defaults to OFF for a
 * synthetic event on purpose. A rule's `onTrigger` sequence opens gates and
 * unlocks doors, and an operator pressing "Test" to see whether a notification
 * looks right has not asked for the gate to open. It is a switch rather than a
 * hard rule because testing the actuation IS sometimes the point.
 */
export interface NcIntakeControls {
  /** Evaluate ONLY this rule. Absent = every enabled rule for the delivery,
   *  exactly as a live event does. Narrows the candidate set; never changes a
   *  verdict. */
  readonly onlyRuleId?: string
  /** Fire even inside the rule's cooldown window, and do NOT consume the
   *  window. Absent/false = the real cooldown applies and a suppression is
   *  reported as one. */
  readonly bypassCooldown?: boolean
  /**
   * D692 §10: a synthetic producer (the tester) closes a grouped window AT ONCE, as a group
   * of one. Like `bypassCooldown` it gates something AROUND the match, never the match.
   * Only a `synthetic` origin may set it: a live admission carrying it is refused with a
   * WARN, and a synthetic one without it is refused too — a test never joins or opens a
   * window of the shared buffer (C11).
   */
  readonly closeWindowImmediately?: boolean
  /** Evaluate even when the camera's notification mute is on. The mute is
   *  otherwise the first gate, before any rule is looked at. */
  readonly bypassMute?: boolean
  /** Run the matched rule's `onTrigger` sequences. Absent = run them (the live
   *  behaviour); an injection sets it false unless asked otherwise. */
  readonly runActions?: boolean
  /**
   * Extra addressees the PRODUCER named — not a rule. An export's picker
   * (`notifyTargetIds`) is the one caller: the operator chose these on the
   * export screen, so they must fire even when no `export-completed` rule
   * exists. EvaluateAndEnqueue skips ids a matching rule already reached.
   */
  readonly directTargetIds?: readonly string[]
}

/**
 * ONE event, as the notification path consumes it. Every producer builds this
 * and nothing else; the consumer reads nothing else.
 */
export interface NcIncomingEvent {
  readonly subject: NcRuleSubject
  readonly kind: NcSubjectKind
  readonly origin: NcEventOrigin
  /** Built lazily — a log context is assembled only when a line is printed. */
  readonly log: () => NcEventLogContext
  readonly controls?: NcIntakeControls
}

/**
 * What one consumption produced, per candidate rule. Returned by the awaited
 * intake (`consumeEventAndReport`) and thrown away by the fire-and-forget one,
 * so the live path pays nothing for it beyond the object.
 */
export interface NcRuleOutcome {
  readonly ruleId: string
  readonly ruleName: string
  readonly matched: boolean
  /** Condition id of the FIRST failing group (non-match only). */
  readonly failedCondition?: string
  /** Condition ids present on the rule, all of which passed (match only). */
  readonly matchedOn?: readonly string[]
  /** What the cooldown window did to this match. `n/a` on a non-match. */
  readonly cooldown: 'n/a' | 'clear' | 'suppressed' | 'bypassed'
  /** Outbox rows actually inserted (0 when every target was opted out or the
   *  dedup key was already satisfied). */
  readonly enqueued: number
  /** Target ids the rows were addressed to. */
  readonly targetIds: readonly string[]
  /**
   * The rule MATCHED and is a scheduled state-summary rule (D647): it sends
   * nothing now — the state is reported at the end of its window.
   */
  readonly heldForSummary?: true
  /**
   * D692: the rule is grouped and this was its admission's outcome (`opened`, `joined`,
   * `updated`, `cooling-down`, `refused`, `tested`). In-process only — the tester report
   * and the specs read it; nothing is enqueued at admission.
   */
  readonly grouped?: NcGroupedOutcomeKind
  /**
   * D692: a grouped CANDIDATE — in a window, not (yet) a match, waiting for its
   * recognition (`matched` is false). Absent on everything else.
   */
  readonly pending?: true
  /**
   * D706: the ALARM rule matched and its own push was not sent — the alarm notification
   * speaks for it (`alarm-entry-delay-started`), or it is a tile of the triggered
   * notification during an entry delay its mode does not notify (`alarm-entry-delay`), or
   * its sensor is excluded by the current arm (`alarm-sensor-excluded`, D735).
   */
  readonly alarmSuppressed?: NcAlarmPushSuppressReason
}

/** The admission outcomes a grouped rule reports (D692, `grouped-delivery.ts`). */
export type NcGroupedOutcomeKind =
  | 'opened'
  | 'joined'
  | 'updated'
  | 'cooling-down'
  | 'refused'
  | 'tested'

/** The verdict of consuming ONE event. */
export interface NcIntakeReport {
  readonly recordId: string
  readonly kind: NcSubjectKind
  readonly delivery: NcDelivery
  readonly origin: NcEventOrigin
  /** How many enabled rules were candidates for the delivery (before the
   *  `onlyRuleId` narrowing, which is reported through `outcomes`). */
  readonly candidates: number
  readonly outcomes: readonly NcRuleOutcome[]
  /** Set when the whole event was dropped before any rule was looked at. */
  readonly droppedBy?: 'muted' | 'no-candidate-rule' | 'evaluation-inactive'
}

/**
 * The consumer contract, as a producer sees it. One method, two shapes of the
 * same call: the live producers are fire-and-forget (a frame path must never
 * await a notification), the tester awaits the verdict.
 */
export interface NcEventConsumer {
  consumeEvent(event: NcIncomingEvent): void
  consumeEventAndReport(event: NcIncomingEvent): Promise<NcIntakeReport>
}

// ── Producer adapters ───────────────────────────────────────────────
//
// Each is a PURE record → envelope mapping. They live here rather than inline
// at the persist hooks so the shape of an event is stated in one place, and so
// a producer that is not the pipeline (the tester) can be held to the same
// shape by the same types.

/** Object-event insert (movement-state transitions + zone crossings). */
export function incomingFromObjectEvent(event: ObjectEvent): NcIncomingEvent {
  return {
    subject: subjectFromObjectEvent(event),
    kind: 'object-event',
    origin: 'pipeline',
    log: () => ({ tags: { deviceId: event.deviceId }, meta: { eventId: event.id } }),
  }
}

/** `TrackCloser.closeExpired` — the ONE close point. */
export function incomingFromTrack(track: Track, info?: NcTrackClosedInfo): NcIncomingEvent {
  return {
    subject: subjectFromTrack(track, info),
    kind: 'track-end',
    origin: 'pipeline',
    log: () => ({ tags: { deviceId: track.deviceId }, meta: { trackId: track.trackId } }),
  }
}

/**
 * Sensor-event persist (one row per linked camera), or — with `linked` — the
 * ONE sensor-level evaluation of a sensor linked to several cameras (ADR 0632),
 * whose `event.deviceId` is the primary camera.
 *
 * `markerTrackId` is the synthetic marker track the same state change
 * projected onto this camera — the notification's media owner, and the only
 * frame a device event has. Absent when no marker landed.
 *
 * A sensor-level evaluation is a per-EVENT line, so it is tagged with the
 * SENSOR; the primary camera rides in the meta. `mutedCameraIds` are the
 * linked cameras the centre left out (D62) — for the line's counts only.
 */
export function incomingFromSensorEvent(
  event: SensorEvent,
  markerTrackId?: string,
  linked?: NcSensorLinkedSubject,
  mutedCameraIds: readonly number[] = [],
): NcIncomingEvent {
  return {
    subject: subjectFromSensorEvent(event, markerTrackId, linked),
    kind: 'device-event',
    origin: 'sensor',
    log: () => ({
      tags: { deviceId: linked !== undefined ? event.sourceDeviceId : event.deviceId },
      meta: {
        sensorEventId: event.id,
        kind: event.kind,
        ...(markerTrackId !== undefined ? { trackId: markerTrackId } : {}),
        // A linked set: every camera linking the sensor, muted ones included,
        // and the primary only when there IS one — every camera muted makes
        // the sensor its own device, which is not a camera to name.
        ...(linked !== undefined
          ? {
              ...(event.deviceId !== event.sourceDeviceId
                ? { primaryCameraId: event.deviceId }
                : {}),
              linkedCameras: linked.linkedCameraIds.length + mutedCameraIds.length,
              mutedCameras: mutedCameraIds.length,
            }
          : {}),
      },
    }),
  }
}

/**
 * A sensor no camera takes a timeline row for (D630 §6) — evaluated, never
 * persisted. The sensor is its own device and there is no marker: a
 * text-only notification is the design here, not a degradation.
 */
export function incomingFromUnownedSensorEvent(
  event: SensorEvent,
  linkedCameraIds: readonly number[],
): NcIncomingEvent {
  return {
    subject: subjectFromUnownedSensorEvent(event, linkedCameraIds),
    kind: 'device-event',
    origin: 'sensor',
    log: () => ({
      tags: { deviceId: event.deviceId },
      meta: { sensorEventId: event.id, kind: event.kind, linkedCameraIds: [...linkedCameraIds] },
    }),
  }
}

/**
 * Audio-event persist (classified episode).
 *
 * `stillOwnerId` is the audio still shelf's owner id for the photograph taken
 * at this episode (`still-shelf.ts`). Absent when no rule that could fire asked
 * for a picture — the same shape `incomingFromSensorEvent` carries its marker.
 */
export function incomingFromAudioEvent(event: AudioEvent, stillOwnerId?: string): NcIncomingEvent {
  return {
    subject: subjectFromAudioEvent(event, stillOwnerId),
    kind: 'audio-event',
    origin: 'pipeline',
    log: () => ({
      tags: { deviceId: event.deviceId },
      meta: {
        audioEventId: event.id,
        class: event.classification?.className,
        ...(stillOwnerId !== undefined ? { stillOwner: stillOwnerId } : {}),
      },
    }),
  }
}

/**
 * Package object-event persist (delivered / picked-up) — the live hook and the
 * boot reconcile alike. A pick-up's instant is read from the row
 * (`event.observedAt`, D684) inside `subjectFromPackageEvent`.
 */
export function incomingFromPackageEvent(
  event: ObjectEvent,
  phase: NcPackagePhase,
): NcIncomingEvent {
  return {
    subject: subjectFromPackageEvent(event, phase),
    kind: 'package-event',
    origin: 'pipeline',
    log: () => ({
      tags: { deviceId: event.deviceId },
      meta: {
        eventId: event.id,
        phase,
        ...(event.observedAt !== undefined ? { observedAt: event.observedAt } : {}),
      },
    }),
  }
}

/**
 * A CONFIRMED audio match (`audio-rule-matcher.ts`) — a labelled frame or a
 * full sampling window, depending on the rule's mode (D157).
 *
 * Not a persisted record: an audio match is a statement about sound that has
 * already happened, and nothing durable descends from it. That puts it on the
 * same delivery-grade boundary as a device event — the guarantee begins here,
 * and a crash in the confirm→outbox window drops the notification rather than
 * replaying it. Deliberate: a stale match is a claim about a noise that has
 * already stopped.
 *
 * `stillOwnerId` — see {@link incomingFromAudioEvent}.
 */
export function incomingFromAudioWindow(
  hit: AudioWindowHit,
  stillOwnerId?: string,
): NcIncomingEvent {
  return {
    subject: subjectFromAudioWindow(hit, stillOwnerId),
    kind: 'audio-window',
    origin: 'pipeline',
    log: () => ({
      tags: { deviceId: hit.deviceId },
      meta: {
        ...audioHitMeta(hit),
        ...(stillOwnerId !== undefined ? { stillOwner: stillOwnerId } : {}),
      },
    }),
  }
}

/**
 * The log meta of an audio confirmation, in the mode's own vocabulary — a
 * label match has no percentage and no window, and printing zeros for them
 * reads as a window that measured nothing.
 */
export function audioHitMeta(hit: AudioWindowHit): Readonly<Record<string, string | number>> {
  const common = {
    mode: hit.spec.mode,
    labels: hit.labels.join(','),
    ...(hit.peakDbfs !== undefined ? { peakDbfs: hit.peakDbfs } : {}),
  }
  const window = hit.window
  if (window === undefined) return common
  return {
    ...common,
    hitPercent: Math.round(window.hitPercent),
    samplingSeconds: window.samplingSeconds,
    hits: window.hits,
    samples: window.samples,
  }
}

/**
 * A committed ZoneAnalytics occupancy edge.
 *
 * `stillOwnerId` — see {@link subjectFromOccupancyEvent}. An edge whose scope is
 * empty owns no member track, so the only picture it can carry is a photograph
 * of its camera taken at the edge, held on the still shelf under this id.
 */
export function incomingFromOccupancyEdge(
  edge: OccupancyEdge,
  stillOwnerId?: string,
): NcIncomingEvent {
  return {
    subject: subjectFromOccupancyEvent(edge, stillOwnerId),
    kind: 'occupancy-event',
    origin: 'pipeline',
    log: () => ({
      tags: { deviceId: edge.deviceId },
      meta: {
        zoneId: edge.zoneId ?? '@frame',
        className: edge.className ?? '@all',
        count: edge.count,
        threshold: edge.threshold,
        occupied: edge.occupied,
        // See the same pair on the "occupancy edge committed" line: `-1` means
        // the moment is UNKNOWN, never that there was no lag.
        observedAt: edge.observedAt ?? -1,
      },
    }),
  }
}

function stringField(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function stringList(data: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const raw = data[key]
  if (!Array.isArray(raw)) return []
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0 && !ids.includes(item)) ids.push(item)
    if (ids.length >= 20) break
  }
  return ids
}

function numberField(data: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = data[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function recordField(
  data: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = data[key]
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

// ── Stream-health gate ──────────────────────────────────────────────
//
// The stream-broker watchdog reports EVERY health flip of every broker. Only
// one of them is an outage, and the operator contract says which.

/**
 * The ONLY `stream.offline` reason that is an outage.
 *
 * OPERATOR CONTRACT (2026-08-12): a stream-offline notification means the
 * stream has been down for {@link NC_STREAM_OFFLINE_SUSTAINED_MS} — two
 * sustained minutes. A camera that reboots and comes back inside the window
 * must produce NOTHING ("un reboot non ci passa").
 *
 * The two minutes are not enforced here: they are the stream-broker's stale
 * window (`STREAM_STALE_TIMEOUT_MS = 120_000`, swept every 15 s —
 * `addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts`),
 * and `stale-timeout` is the reason that window and only that window produces.
 * That is the whole traceability of the contract: no faster path emits
 * `stream.offline` (the rfc4571 clean-FIN failure edge sets `_status='error'`
 * and reconnects, it does not emit), so accepting `stale-timeout` alone IS the
 * 2-minute rule. If the broker's window ever changes, this contract changes
 * with it — which is why the number is named on both sides.
 */
const NC_STREAM_OFFLINE_REASON = 'stale-timeout'

/**
 * The BATTERY outage reasons (D883). A battery camera's sleep is not an
 * outage and the broker no longer emits one; what it does emit is a failure it
 * has already named — a demanded wake that delivered nothing, a connection
 * error while the camera is awake, silence past the battery refresh window.
 * The 120 s window above is the stale window those share; the extra reasons
 * are only the broker saying WHICH failure, so they pass the same gate.
 */
const NC_STREAM_BATTERY_OFFLINE_REASONS: readonly string[] = [
  'wake-timeout',
  'connection-error',
  'battery-unreachable',
]

/** The recovery that answers a {@link NC_STREAM_OFFLINE_REASON} outage. */
const NC_STREAM_ONLINE_REASON = 'recovered'

/**
 * The sustained-outage window the notification promises, in ms. Documentation
 * of the contract above — the enforcement lives in the broker's stale window,
 * and this constant exists so a reader of the notification path can find the
 * number without reading the pipeline addon.
 */
const NC_STREAM_OFFLINE_SUSTAINED_MS = 120_000

/**
 * One health flip the gate refused, as a log line wants it.
 *
 * A branch that drops work states that it did — silence reads as "never
 * happened". The `deviceId` tag is mandatory because every question about
 * stream noise is asked per-camera.
 */
export interface NcDiscardedSystemEvent {
  readonly category: string
  /** The reason the broker stated, or `unstated` when it stated none. */
  readonly reason: string
  readonly tags: Readonly<Record<string, number>>
  readonly meta: Readonly<Record<string, unknown>>
}

/**
 * Which bus categories carry a device LIVENESS claim. Both of them, always
 * together: `deviceLiveness` is reached from two places and a gate applied to
 * one of them is a gate that is not there. These two copies had already drifted
 * once before they were made one function.
 */
function isDeviceLivenessCategory(
  category: string,
  data: Readonly<Record<string, unknown>>,
): boolean {
  if (category === 'device.online' || category === 'device.offline') return true
  return category === 'device.state-changed' && stringField(data, 'capName') === 'device-status'
}

/**
 * The device id a liveness event is about, or `undefined` when the payload does
 * not carry one.
 */
function livenessDeviceId(event: SystemEvent): number | undefined {
  if (!isDeviceLivenessCategory(event.category, event.data)) return undefined
  return numberField(event.data, 'deviceId')
}

/**
 * LIVENESS IS A FIRST-LEVEL DEVICE FACT — the accessory gate, as a reportable
 * drop.
 *
 * Measured on the live hub 2026-09-01: 100 devices read offline, **96 of them
 * accessories**, 32 of whose 35 distinct parents were themselves ONLINE, and 78
 * of which flipped inside one minute (a provider reconnect, not 78 outages).
 * 39 were HA `button` entities, which are offline by construction — a `button`
 * has no state until it is pressed, and `ha-base-child-device.ts` reads
 * `unknown` as unreachable.
 *
 * The gate is deliberately STRICTER than "a child whose parent is online":
 * `parentDeviceId !== null` is one sentence an operator can hold in their head,
 * and it does not depend on a second device's mirrored state being fresh. The
 * cost is stated rather than hidden — **an accessory that is genuinely dead is
 * never announced** — and the parent still is.
 *
 * It gates LIVENESS only. `device.disabled` / `device.enabled` are the
 * operator's own switch (D62): somebody pressed something and is owed the
 * confirmation at whatever level the device sits.
 */
function discardedAccessoryLiveness(
  event: SystemEvent,
  lookup: NcDeviceLookup | undefined,
): NcDiscardedSystemEvent | null {
  if (lookup === undefined) return null
  const deviceId = livenessDeviceId(event)
  if (deviceId === undefined) return null
  const identity = lookup(deviceId)
  if (!isAccessoryIdentity(identity)) return null
  return {
    category: event.category,
    reason: 'accessory',
    tags: { deviceId },
    meta: {
      reason: 'accessory',
      parentDeviceId: identity?.parentDeviceId ?? null,
      deviceType: identity?.type ?? 'unknown',
    },
  }
}

/** Is this stream-health flip the one the operator asked to hear about? */
function streamHealthAccepted(category: string, reason: string | undefined): boolean {
  return category === 'stream.online'
    ? reason === NC_STREAM_ONLINE_REASON
    : reason === NC_STREAM_OFFLINE_REASON ||
        (reason !== undefined && NC_STREAM_BATTERY_OFFLINE_REASONS.includes(reason))
}

/**
 * Describe a system event the intake's GATE dropped, or `null` when the event
 * was not dropped by it (it was accepted, or its payload is malformed — a
 * shape the intake rejects on its own, not the gate's business).
 *
 * TWO gates report here:
 *
 *  - **stream health** — which flip is an outage;
 *  - **the accessory gate** — liveness is a FIRST-LEVEL device fact, so an
 *    event about a device with a `parentDeviceId` is dropped whole. It needs
 *    the directory to know that, which is why `lookup` is a parameter; a caller
 *    that omits it simply gets no accessory answer (the stream half is
 *    unaffected).
 *
 * WHICH device liveness an operator hears about is still the rule's
 * `deviceTypes` — but WHETHER a liveness event is a change at all is the
 * liveness ledger's verdict, and it reports through
 * {@link discardedLivenessEvent} into this same shape.
 *
 * A branch that drops work silently reads as "never happened", and every
 * question about it is asked per-camera — hence the `deviceId` tag.
 */
export function discardedSystemEvent(
  event: SystemEvent,
  lookup?: NcDeviceLookup,
): NcDiscardedSystemEvent | null {
  const accessory = discardedAccessoryLiveness(event, lookup)
  if (accessory !== null) return accessory
  if (event.category === 'worker.online' || event.category === 'worker.offline') {
    const workerId = stringField(event.data, 'workerId')
    return {
      category: event.category,
      reason: 'a runner is not a node',
      tags: {},
      meta: { reason: 'a runner is not a node', ...(workerId !== undefined ? { workerId } : {}) },
    }
  }
  if (event.category !== 'stream.online' && event.category !== 'stream.offline') return null
  const data = event.data
  const reason = stringField(data, 'reason')
  if (streamHealthAccepted(event.category, reason)) return null
  const deviceId = numberField(data, 'deviceId')
  const camStreamId = stringField(data, 'camStreamId')
  return {
    category: event.category,
    reason: reason ?? 'unstated',
    tags: deviceId !== undefined ? { deviceId } : {},
    meta: {
      reason: reason ?? 'unstated',
      ...(camStreamId !== undefined ? { camStreamId } : {}),
    },
  }
}

/**
 * Describe a liveness event the LEDGER refused, in the same shape as a
 * stream-gate drop, so both drops print through one call site.
 *
 * `reason` is the verdict itself: `seeded` (the first observation of a
 * subject — the state was recorded, nothing was said) or `no-flip` (the
 * subject is already in this state). Both are answers to the operator's
 * question "why did 102 not notify", and neither may be silent — a boot that
 * suppressed fifteen notifications and logged nothing would be
 * indistinguishable from a notification centre that had stopped working.
 */
export function discardedLivenessEvent(
  event: NcIncomingEvent,
  reason: 'seeded' | 'no-flip',
): NcDiscardedSystemEvent {
  const system = event.subject.systemEvent
  const context = event.log()
  return {
    category: stringField(system?.data ?? {}, 'category') ?? 'unstated',
    reason,
    tags: context.tags,
    meta: {
      reason,
      ...(system !== undefined ? { subject: system.subject, kind: system.kind } : {}),
    },
  }
}

/**
 * The four facts {@link systemSubject} needs, separated from the bus envelope
 * that usually carries them.
 *
 * The alarm panel is in this process. Its transitions are not bus events and
 * must not be (D8: a dropped alarm notification is not acceptable telemetry
 * loss), yet they are system events in every sense that matters to a rule — so
 * they build a subject through exactly the same function, without a synthetic
 * `SystemEvent` pretending to have come off the bus.
 */
export interface NcSystemEventFacts {
  readonly eventId: string
  readonly timestamp: number
  readonly category: string
  readonly data: Readonly<Record<string, unknown>>
}

/** The bus envelope, as facts. */
function systemEventFacts(event: SystemEvent): NcSystemEventFacts {
  return {
    eventId: event.id,
    timestamp: event.timestamp.getTime(),
    category: event.category,
    data: event.data,
  }
}

/**
 * Freeze ONE system event as a subject.
 *
 * What is frozen is the catalog KEY and the params that fill it — never the
 * sentence. The words are chosen at DELIVERY, where the reader's language is
 * known; the facts are chosen here, where the event is. That split is what
 * makes a system notification translatable at all: the row that says a camera
 * went offline may sit in the outbox for days behind an unreachable target, and
 * a sentence frozen into it could never be re-worded, corrected or translated.
 *
 * The BODY VARIANT is picked here too (`bodyKey`), for the same reason: whether
 * a stream event names a profile, whether a node is an agent or a worker,
 * whether an update is pinned to a node. Each is a fact about the event, and
 * deciding it here keeps the catalog a flat list of finished sentences rather
 * than a template language with conditionals in it.
 */
function systemSubject(input: {
  readonly facts: NcSystemEventFacts
  readonly kind: NcSystemEventKind
  readonly subject: string
  readonly titleKey: string
  readonly bodyKey: string
  readonly textParams: Readonly<Record<string, string>>
  readonly deviceId?: number
  readonly deviceType?: string
  readonly nodeId?: string
  readonly packageName?: string
  readonly nodeIds?: readonly string[]
  readonly packageNames?: readonly string[]
  /** Set when the sentence pluralises — see {@link NcSystemEventFacts}. */
  readonly textCount?: number
  /** Set only on `alarm-triggered`, and only when a RULE set it off. */
  readonly alarmSource?: NcRuleFireRef
  /** Set only beside `alarmSource` on `alarm-triggered` (D705). */
  readonly alarmFollowers?: readonly NcRuleFireRef[]
  /** Set only on a consumable band: the threshold it was judged at (D642). */
  readonly consumableLowPercent?: number
}): NcIncomingEvent {
  const data = { ...input.facts.data, category: input.facts.category }
  const deviceId = input.deviceId ?? NC_SYSTEM_DEVICE_ID
  const tags: Readonly<Record<string, number>> =
    input.deviceId !== undefined ? { deviceId: input.deviceId } : {}
  return {
    kind: 'system-event',
    origin: 'system',
    subject: {
      kind: 'system-event',
      recordId: input.facts.eventId,
      deviceId,
      timestamp: input.facts.timestamp,
      classNames: [],
      zones: [],
      systemEvent: {
        kind: input.kind,
        subject: input.subject,
        titleKey: input.titleKey,
        bodyKey: input.bodyKey,
        textParams: input.textParams,
        ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
        ...(input.deviceType !== undefined ? { deviceType: input.deviceType } : {}),
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
        ...(input.packageName !== undefined ? { packageName: input.packageName } : {}),
        ...(input.nodeIds !== undefined ? { nodeIds: input.nodeIds } : {}),
        ...(input.packageNames !== undefined ? { packageNames: input.packageNames } : {}),
        ...(input.textCount !== undefined ? { textCount: input.textCount } : {}),
        ...(input.alarmSource !== undefined ? { alarmSource: input.alarmSource } : {}),
        ...(input.alarmFollowers !== undefined && input.alarmFollowers.length > 0
          ? { alarmFollowers: input.alarmFollowers }
          : {}),
        ...(input.consumableLowPercent !== undefined
          ? { consumableLowPercent: input.consumableLowPercent }
          : {}),
        data,
      },
    },
    log: () => ({
      tags,
      meta: {
        eventId: input.facts.eventId,
        category: input.facts.category,
        kind: input.kind,
        subject: input.subject,
      },
    }),
  }
}

/**
 * The two facts a device sentence needs: `{{deviceId}}` (kept, so an operator's
 * older text override still renders) and `{{deviceName}}` — the one the reader
 * actually recognises. "Il dispositivo 2018 è offline" is a row id read out
 * loud; the operator has never seen 2018.
 */
function deviceTextParams(
  deviceId: number,
  identity: NcDeviceIdentity | undefined,
): Readonly<Record<string, string>> {
  return { deviceId: String(deviceId), deviceName: deviceDisplayName(identity, deviceId) }
}

/**
 * A DEVICE going up or down — reached from TWO categories
 * (`device.state-changed` carrying a `device-status` slice, and the explicit
 * `device.online` / `device.offline`), which is why it is a function and not
 * two copies of the same four fields. The copies had already drifted once.
 *
 * Every device type produces this. Which ones an operator hears about is the
 * rule's `deviceTypes` condition, judged against the `deviceType` carried
 * here — the intake states WHAT HAPPENED, the rule decides what is worth
 * saying. (It used to word all of them as cameras; see the kind schema.)
 */
function deviceLiveness(
  facts: NcSystemEventFacts,
  deviceId: number,
  online: boolean,
  identity: NcDeviceIdentity | undefined,
): NcIncomingEvent | null {
  // THE ACCESSORY GATE. One place, reached by both categories — see
  // {@link discardedAccessoryLiveness} for the 100 devices and the 78-in-one-
  // minute flip this keeps off the operator's phone.
  if (isAccessoryIdentity(identity)) return null
  const kind = online ? 'device-online' : 'device-offline'
  return systemSubject({
    facts,
    kind,
    subject: `device:${deviceId}`,
    titleKey: `system.${kind}.title`,
    bodyKey: `system.${kind}.body`,
    textParams: deviceTextParams(deviceId, identity),
    deviceId,
    ...(identity !== undefined ? { deviceType: identity.type } : {}),
  })
}

/** What {@link incomingFromBatteryBand} needs to word one battery band. */
export interface NcBatteryBandSubjectInput {
  readonly facts: NcSystemEventFacts
  readonly deviceId: number
  readonly band: NcBatteryBand
  readonly reading: NcBatteryReading
  readonly identity: NcDeviceIdentity | undefined
}

/**
 * A battery BAND, as a system-event subject.
 *
 * Not reached from {@link incomingFromSystemEvent}: a raw slice write is not a
 * notification and must never become one on its own. The `battery` slice was
 * measured writing 526 times in 25 minutes with zero value changes, so the
 * ledger decides whether anything is worth saying and calls this only for the
 * verdicts that are.
 *
 * Two decisions live here:
 *
 *  - **`battery:<deviceId>` is its own subject family.** Never `device:<id>` —
 *    that is liveness's, and D141 split `device-switch:<id>` off it for exactly
 *    this reason: two facts about one device sharing a cooldown slot cancel
 *    each other out. An operator would lose the outage to the battery.
 *
 *  - **the BODY VARIANT.** A binary indicator has no percentage to say, so it
 *    gets its own finished sentence rather than a template with a stand-in
 *    number in it. `systemSubject` picks variants for the same reason
 *    everywhere else it does.
 *
 * The recovery (`device-battery-normal`) keeps the SAME subject, because it is
 * the same episode ending — a different subject would give it its own cooldown
 * window and its own ledger row.
 */
export function incomingFromBatteryBand(input: NcBatteryBandSubjectInput): NcIncomingEvent {
  const kind = input.band === 'low' ? 'device-battery-low' : 'device-battery-normal'
  const binary = input.reading.binary === true
  const percentage = Math.round(input.reading.percentage)
  return systemSubject({
    facts: input.facts,
    kind,
    subject: `battery:${input.deviceId}`,
    titleKey: `system.${kind}.title`,
    bodyKey: binary ? `system.${kind}.body.binary` : `system.${kind}.body`,
    textParams: {
      ...deviceTextParams(input.deviceId, input.identity),
      // A stand-in is not a reading, so it is never rendered. `ha-container-
      // device.ts` writes 15/100 for a LOW_BAT indicator and the UI is already
      // required to show "Normal"/"Low" instead of those numbers.
      ...(binary ? {} : { percentage: String(percentage) }),
    },
    deviceId: input.deviceId,
    ...(input.identity !== undefined ? { deviceType: input.identity.type } : {}),
  })
}

/** A low battery whose reading has not arrived — no percentage, not binary (D393). */
export interface NcUnmeasuredBatteryInput {
  readonly facts: NcSystemEventFacts
  readonly deviceId: number
  readonly identity: NcDeviceIdentity | undefined
}

/**
 * The summary sentence for a battery episode whose slice has not been read
 * since boot. It names the device and nothing else: a missing level is not
 * 0%, and it is not the binary indicator's sentence.
 */
export function incomingFromUnmeasuredBattery(input: NcUnmeasuredBatteryInput): NcIncomingEvent {
  const kind = 'device-battery-low'
  return systemSubject({
    facts: input.facts,
    kind,
    subject: `battery:${input.deviceId}`,
    titleKey: `system.${kind}.title`,
    bodyKey: `system.${kind}.body.unmeasured`,
    textParams: deviceTextParams(input.deviceId, input.identity),
    deviceId: input.deviceId,
    ...(input.identity !== undefined ? { deviceType: input.identity.type } : {}),
  })
}

/** One consumable item, as the notification needs to word it. */
export interface NcConsumableItemReading {
  readonly key: string
  readonly label: string
  readonly level: number | null
  readonly status: 'ok' | 'replace' | null
}

/** What {@link incomingFromConsumableBand} needs to word one consumable. */
export interface NcConsumableBandSubjectInput {
  readonly facts: NcSystemEventFacts
  readonly deviceId: number
  readonly band: 'low' | 'normal'
  readonly item: NcConsumableItemReading
  /** The threshold this episode is judged at — the RULE's (D642). */
  readonly thresholdPercent: number
  readonly identity: NcDeviceIdentity | undefined
}

/**
 * A consumable BAND, as a system-event subject.
 *
 * Built exactly like {@link incomingFromBatteryBand} — the operator asked for
 * these to be treated as the battery notifications are — with two differences
 * that come from the subject and not from taste:
 *
 *  - **the subject carries the ITEM.** `consumable@<threshold>:<deviceId>:<key>`,
 *    because a vacuum has a brush AND a filter AND a mop pad, and one subject
 *    for all three would let the brush's alert cancel the filter's. It carries
 *    the THRESHOLD too (D642): each rule's threshold is its own episode, and
 *    the engine pairs a rule with the episode judged at its own number.
 *  - **the body variant follows what is KNOWN.** An item with no percentage
 *    gets a finished sentence rather than a template with a stand-in number in
 *    it, for the same reason a binary battery does.
 *
 * The recovery keeps the SAME subject: it is the same episode ending.
 */
export function incomingFromConsumableBand(input: NcConsumableBandSubjectInput): NcIncomingEvent {
  const kind = input.band === 'low' ? 'device-consumable-low' : 'device-consumable-normal'
  const level = input.item.level
  const percentage = level !== null && Number.isFinite(level) ? Math.round(level) : null
  const measured = percentage !== null
  return systemSubject({
    facts: input.facts,
    kind,
    subject: consumableSubject(input.thresholdPercent, input.deviceId, input.item.key),
    titleKey: `system.${kind}.title`,
    bodyKey: measured ? `system.${kind}.body` : `system.${kind}.body.unmeasured`,
    textParams: {
      ...deviceTextParams(input.deviceId, input.identity),
      item: input.item.label,
      form: 'part',
      ...(percentage !== null ? { percentage: String(percentage) } : {}),
    },
    deviceId: input.deviceId,
    consumableLowPercent: input.thresholdPercent,
    ...(input.identity !== undefined ? { deviceType: input.identity.type } : {}),
  })
}

/** Provider verdict wording — low/empty vs full (D934). */
export type NcProviderConsumableAttention = 'low' | 'full'

/** What {@link incomingFromProviderConsumableBand} needs. */
export interface NcProviderConsumableBandSubjectInput {
  readonly facts: NcSystemEventFacts
  readonly deviceId: number
  readonly band: 'low' | 'normal'
  readonly item: { readonly key: string; readonly label: string; readonly form: ConsumableForm }
  readonly attention: NcProviderConsumableAttention
  readonly identity: NcDeviceIdentity | undefined
}

/** Instant body keys for a consumable form (D934). */
export function consumableLowBodyKey(
  form: ConsumableForm,
  attention: NcProviderConsumableAttention,
  measured: boolean,
): string {
  if (form === 'part') {
    return measured
      ? 'system.device-consumable-low.body'
      : 'system.device-consumable-low.body.unmeasured'
  }
  if (form === 'tank') {
    return attention === 'full'
      ? 'system.device-consumable-low.body.tank-full'
      : 'system.device-consumable-low.body.tank'
  }
  if (form === 'product') return 'system.device-consumable-low.body.product'
  return 'system.device-consumable-low.body.bin'
}

/**
 * A supply / waste item judged on the provider's verdict (D934).
 *
 * Subject `consumable:<deviceId>:<key>` — no `consumableLowPercent` so rules
 * at 15 % still hear salt and water.
 */
export function incomingFromProviderConsumableBand(
  input: NcProviderConsumableBandSubjectInput,
): NcIncomingEvent {
  const kind = input.band === 'low' ? 'device-consumable-low' : 'device-consumable-normal'
  const measured = false
  const bodyKey =
    input.band === 'low'
      ? consumableLowBodyKey(input.item.form, input.attention, measured)
      : 'system.device-consumable-normal.body.unmeasured'
  return systemSubject({
    facts: input.facts,
    kind,
    subject: legacyConsumableSubject(input.deviceId, input.item.key),
    titleKey: `system.${kind}.title`,
    bodyKey,
    textParams: {
      ...deviceTextParams(input.deviceId, input.identity),
      item: input.item.label,
      form: input.item.form,
      attention: input.attention,
    },
    deviceId: input.deviceId,
    ...(input.identity !== undefined ? { deviceType: input.identity.type } : {}),
  })
}

/**
 * Normalize the infrastructure categories consumed by Notification Center.
 * Malformed payloads are rejected instead of guessing an identity.
 *
 * `lookup` is the mirrored device directory (`device-directory.ts`). It
 * supplies the two facts a device event carries beyond its id: the NAME the
 * sentence uses, and the TYPE a rule's `deviceTypes` condition is judged
 * against. Required rather than optional so every caller states where those
 * come from — a subject built without a type silently fails every
 * type-narrowed rule.
 */
export function incomingFromSystemEvent(
  event: SystemEvent,
  lookup: NcDeviceLookup,
): NcIncomingEvent | null {
  const data = event.data
  const facts = systemEventFacts(event)
  switch (event.category) {
    case 'device.state-changed': {
      const deviceId = numberField(data, 'deviceId')
      const capName = stringField(data, 'capName')
      const slice = recordField(data, 'slice')
      const online = slice?.['online']
      if (deviceId === undefined || capName !== 'device-status' || typeof online !== 'boolean') {
        return null
      }
      return deviceLiveness(facts, deviceId, online, lookup(deviceId))
    }
    case 'device.online':
    case 'device.offline': {
      const deviceId = numberField(data, 'deviceId')
      if (deviceId === undefined) return null
      return deviceLiveness(facts, deviceId, event.category === 'device.online', lookup(deviceId))
    }
    case 'device.disabled':
    case 'device.enabled': {
      // The operator's switch, NOT liveness. D62: a device someone turned off
      // is reported off; it is never worded as offline or broken, and it gets
      // its own subject family so the switch and the liveness of the same
      // device do not share a dedup slot and cancel each other out.
      const deviceId = numberField(data, 'deviceId')
      if (deviceId === undefined) return null
      const identity = lookup(deviceId)
      const kind = event.category === 'device.disabled' ? 'device-disabled' : 'device-enabled'
      return systemSubject({
        facts,
        kind,
        subject: `device-switch:${deviceId}`,
        titleKey: `system.${kind}.title`,
        bodyKey: `system.${kind}.body`,
        textParams: deviceTextParams(deviceId, identity),
        deviceId,
        ...(identity !== undefined ? { deviceType: identity.type } : {}),
      })
    }
    case 'stream.online':
    case 'stream.offline': {
      // The gate FIRST — see {@link NC_STREAM_OFFLINE_REASON}. A suspend, a
      // resume, a first packet and a released broker are all health flips and
      // none of them is an outage. `discardedSystemEvent` describes the drop
      // for the caller's log line.
      if (!streamHealthAccepted(event.category, stringField(data, 'reason'))) return null
      const deviceId = numberField(data, 'deviceId')
      if (deviceId === undefined) return null
      const online = event.category === 'stream.online'
      // A device outage that covers several streams is not "the high stream":
      // the profiled sentence is only for an event about exactly one.
      const coveredStreams = stringList(data, 'camStreamIds').length
      const profile = coveredStreams > 1 ? undefined : stringField(data, 'profile')
      const kind = online ? 'stream-online' : 'stream-offline'
      return systemSubject({
        facts,
        kind,
        // One subject per DEVICE (D883): main and sub dropping together is one
        // outage and its recovery must close the one row.
        subject: `stream:${String(deviceId)}`,
        titleKey: `system.${kind}.title`,
        // The profile is not always known, and "Stream for camera 101" is a
        // different sentence from " stream for camera 101" — a variant, not a
        // blank placeholder.
        bodyKey: profile !== undefined ? `system.${kind}.body.profiled` : `system.${kind}.body`,
        // Named, like every other camera sentence. NOT gated on the directory:
        // only a camera ever has a stream broker, and a cold directory must
        // never swallow a two-minute outage.
        textParams: {
          ...deviceTextParams(deviceId, lookup(deviceId)),
          ...(profile !== undefined ? { profile } : {}),
        },
        deviceId,
      })
    }
    // A RUNNER (a forked child process) restarting is not a node going away:
    // no notification subject, so no `node-*` push, no liveness-ledger row and
    // no state-summary line — the node kinds stay agent-only, as 1.2.430
    // delivered them. The events became real on 2026-10-02 (the UDS registry
    // emits them for the D696 gates); folded into `node-*` they pushed for every
    // decoder respawn and update under the seeded system rule, and could spend
    // the cooldown of the rule that reports a real agent outage (R1-H1). A
    // runner that really dies is `addon.runner-failed` (the D6 breaker).
    // `discardedSystemEvent` says the drop.
    case 'worker.online':
    case 'worker.offline':
      return null
    case 'agent.online':
    case 'agent.offline': {
      const nodeId = stringField(data, 'agentId')
      if (nodeId === undefined) return null
      const online = event.category.endsWith('.online')
      const kind = online ? 'node-online' : 'node-offline'
      // `nodeName` defaults to the id; the node hold-off swaps in the
      // directory's display name before the row is enqueued. `reason` is the
      // hub's Moleculer verdict (`connection-lost` = heartbeat/socket gone,
      // `shutdown` = the agent said goodbye) — absent from an older hub.
      const reason = online ? undefined : stringField(data, 'reason')
      return systemSubject({
        facts,
        kind,
        subject: `node:${nodeId}`,
        titleKey: `system.${kind}.title`,
        bodyKey:
          reason === 'connection-lost' || reason === 'shutdown'
            ? `system.${kind}.body.agent.${reason}`
            : `system.${kind}.body.agent`,
        textParams: { nodeId, nodeName: stringField(data, 'nodeName') ?? nodeId },
        nodeId,
      })
    }
    case 'pipeline.node-inference-unavailable': {
      // A node that is ONLINE and cannot infer. Node-scoped, exactly like
      // `node-offline`, so an operator already filtering by `nodeIds` catches
      // it with the filter they have.
      const nodeId = stringField(data, 'nodeId')
      if (nodeId === undefined) return null
      const keys = data['unavailableDeviceKeys']
      const devices = Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : []
      return systemSubject({
        facts,
        kind: 'node-inference-unavailable',
        // Its OWN subject family: a node whose accelerators died is not the
        // same fact as a node that went away, and sharing a dedup slot would
        // let one suppress the other.
        subject: `node-inference:${nodeId}`,
        titleKey: 'system.node-inference-unavailable.title',
        bodyKey: 'system.node-inference-unavailable.body',
        textParams: { nodeId, devices: devices.join(', ') },
        nodeId,
      })
    }
    case 'addon.runner-failed': {
      // THE D6 CRASH CIRCUIT-BREAKER HAVING GIVEN UP — terminal, and until
      // 2026-08-18 completely silent. The recorder runner died of three
      // unhandled ffmpeg spawn errors, the breaker correctly stopped
      // respawning it, and the fleet lost recording for 3h15 while `/health`
      // answered 200. This is the notification that outage did not have.
      //
      // Node-scoped and device-LESS on purpose: a runner is not a camera. The
      // addons it hosted are named in the sentence rather than filtered on,
      // because an operator narrows this by "where", not by "which addon".
      const nodeId = stringField(data, 'nodeId')
      const runnerId = stringField(data, 'runnerId')
      const crashes = numberField(data, 'crashesInWindow')
      if (nodeId === undefined || runnerId === undefined || crashes === undefined) return null
      const ids = data['addonIds']
      const addons = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
      return systemSubject({
        facts,
        kind: 'addon-crash-loop',
        // Its OWN subject family, per RUNNER: a group runner that dies takes
        // every addon in it down at once (one outage, one row), and a runner
        // that will not come back must never share a dedup slot with the node
        // going away — one would suppress the other.
        subject: `addon-crash:${nodeId}:${runnerId}`,
        titleKey: 'system.addon-crash-loop.title',
        bodyKey: 'system.addon-crash-loop.body',
        textParams: {
          nodeId,
          // The runner id when the payload named no addons: a sentence with a
          // hole in it is how "La camera è offline" shipped.
          addons: addons.length > 0 ? addons.join(', ') : runnerId,
          count: String(crashes),
        },
        nodeId,
      })
    }
    case 'pipeline.detection-blind': {
      // Per-CAMERA, so the rule's `deviceIds` / `deviceTypes` filters work and
      // the notification names the camera the operator recognises.
      const deviceId = numberField(data, 'deviceId')
      const blindForMs = numberField(data, 'blindForMs')
      if (deviceId === undefined || blindForMs === undefined) return null
      const identity = lookup(deviceId)
      // D907: the sentence is about MOTION (session time), not wall time. A
      // payload from a node still on the old emitter has neither field and
      // falls back to the wall minutes it always carried.
      const motionMs = numberField(data, 'motionMs') ?? blindForMs
      const sessions = numberField(data, 'sessions') ?? 1
      const minutes = Math.max(1, Math.round(motionMs / 60_000))
      return systemSubject({
        facts,
        kind: 'detection-blind',
        subject: `detection-blind:${deviceId}`,
        titleKey: 'system.detection-blind.title',
        bodyKey: 'system.detection-blind.body',
        textParams: {
          ...deviceTextParams(deviceId, identity),
          minutes: String(minutes),
          sessions: String(sessions),
        },
        // The sentence pluralises on the minute count.
        textCount: minutes,
        deviceId,
        ...(identity !== undefined ? { deviceType: identity.type } : {}),
      })
    }
    case 'pipeline.motion-noisy':
    case 'pipeline.motion-calm': {
      // One subject for both edges: the paired class (D906) is one condition
      // on one camera, and the calm edge must supersede the noisy one.
      const deviceId = numberField(data, 'deviceId')
      const dutyPct = numberField(data, 'dutyPct')
      const sessions = numberField(data, 'sessions')
      const windowMs = numberField(data, 'windowMs')
      if (
        deviceId === undefined ||
        dutyPct === undefined ||
        sessions === undefined ||
        windowMs === undefined
      ) {
        return null
      }
      const noisy = event.category === 'pipeline.motion-noisy'
      const identity = lookup(deviceId)
      return systemSubject({
        facts,
        kind: noisy ? 'motion-noisy' : 'motion-calm',
        subject: `motion-noise:${deviceId}`,
        titleKey: noisy ? 'system.motion-noisy.title' : 'system.motion-calm.title',
        bodyKey: noisy ? 'system.motion-noisy.body' : 'system.motion-calm.body',
        textParams: {
          ...deviceTextParams(deviceId, identity),
          minutes: String(Math.max(1, Math.round(windowMs / 60_000))),
          duty: String(dutyPct),
          sessions: String(sessions),
        },
        deviceId,
        ...(identity !== undefined ? { deviceType: identity.type } : {}),
      })
    }
    case 'pipeline.package-llm-silent':
    case 'pipeline.package-llm-answered': {
      // One subject for both edges so the answer supersedes the silence.
      const deviceId = numberField(data, 'deviceId')
      if (deviceId === undefined) return null
      const silent = event.category === 'pipeline.package-llm-silent'
      const reason = stringField(data, 'reason')
      const latencyMs = numberField(data, 'latencyMs')
      if (silent && (reason === undefined || latencyMs === undefined)) return null
      const identity = lookup(deviceId)
      return systemSubject({
        facts,
        kind: silent ? 'package-llm-silent' : 'package-llm-answered',
        subject: `package-llm:${deviceId}`,
        titleKey: silent ? 'system.package-llm-silent.title' : 'system.package-llm-answered.title',
        bodyKey: silent ? 'system.package-llm-silent.body' : 'system.package-llm-answered.body',
        textParams: {
          ...deviceTextParams(deviceId, identity),
          ...(reason !== undefined ? { reason } : {}),
          ...(latencyMs !== undefined ? { message: String(latencyMs) } : {}),
        },
        deviceId,
        ...(identity !== undefined ? { deviceType: identity.type } : {}),
      })
    }
    case 'recording.health.stalled': {
      const deviceId = numberField(data, 'deviceId')
      const idleMs = numberField(data, 'idleMs')
      if (deviceId === undefined || idleMs === undefined) return null
      const identity = lookup(deviceId)
      const minutes = Math.max(1, Math.round(idleMs / 60_000))
      return systemSubject({
        facts,
        kind: 'recording-stalled',
        subject: `recording:${deviceId}`,
        titleKey: 'system.recording-stalled.title',
        bodyKey: 'system.recording-stalled.body',
        textParams: {
          ...deviceTextParams(deviceId, identity),
          minutes: String(minutes),
        },
        textCount: minutes,
        deviceId,
        ...(identity !== undefined ? { deviceType: identity.type } : {}),
      })
    }
    case 'recording.health.ok': {
      const deviceId = numberField(data, 'deviceId')
      if (deviceId === undefined) return null
      const identity = lookup(deviceId)
      return systemSubject({
        facts,
        kind: 'recording-healthy',
        subject: `recording:${deviceId}`,
        titleKey: 'system.recording-healthy.title',
        bodyKey: 'system.recording-healthy.body',
        textParams: deviceTextParams(deviceId, identity),
        deviceId,
        ...(identity !== undefined ? { deviceType: identity.type } : {}),
      })
    }
    case 'recording.health.degraded': {
      const deviceId = numberField(data, 'deviceId')
      if (deviceId === undefined) return null
      const identity = lookup(deviceId)
      const message = stringField(data, 'message') ?? 'writer restart budget exhausted'
      return systemSubject({
        facts,
        kind: 'recording-degraded',
        subject: `recording-degraded:${deviceId}`,
        titleKey: 'system.recording-degraded.title',
        bodyKey: 'system.recording-degraded.body',
        textParams: {
          ...deviceTextParams(deviceId, identity),
          message,
        },
        deviceId,
        ...(identity !== undefined ? { deviceType: identity.type } : {}),
      })
    }
    case 'storage.location.low':
    case 'storage.location.critical':
    case 'storage.location.ok': {
      const locationId = stringField(data, 'locationId')
      if (locationId === undefined) return null
      const nodeId = stringField(data, 'nodeId')
      const kind: NcSystemEventKind =
        event.category === 'storage.location.low'
          ? 'storage-location-low'
          : event.category === 'storage.location.critical'
            ? 'storage-location-critical'
            : 'storage-location-ok'
      const freePercent = numberField(data, 'freePercent')
      const reason = stringField(data, 'reason') ?? kind
      const locationName = stringField(data, 'locationName') ?? locationId
      return systemSubject({
        facts,
        kind,
        subject: `storage-location:${locationId}`,
        titleKey: `system.${kind}.title`,
        bodyKey: `system.${kind}.body`,
        textParams: {
          locationId,
          locationName,
          reason,
          ...(freePercent !== undefined ? { freePercent: String(freePercent) } : {}),
          ...(nodeId !== undefined ? { nodeId } : {}),
        },
        ...(nodeId !== undefined ? { nodeId } : {}),
      })
    }
    case 'notification.rule-broken':
    case 'notification.rule-repaired': {
      // D905 — one subject per RULE, so a broken and its repair share a slot.
      const ruleId = stringField(data, 'ruleId')
      if (ruleId === undefined) return null
      const broken = event.category === 'notification.rule-broken'
      const kind: NcSystemEventKind = broken ? 'rule-broken' : 'rule-repaired'
      const ruleName = stringField(data, 'ruleName') ?? ruleId
      const reason = stringField(data, 'reason') ?? 'unknown'
      const ids = data['offendingIds']
      const offendingIds = Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string').join(', ')
        : ''
      return systemSubject({
        facts,
        kind,
        subject: `rule-health:${ruleId}`,
        titleKey: `system.${kind}.title`,
        bodyKey: broken ? `system.rule-broken.body.${reason}` : 'system.rule-repaired.body',
        textParams: broken
          ? { ruleId, ruleName, brokenReason: reason, offendingIds }
          : { ruleId, ruleName },
      })
    }
    case 'update.available': {
      return incomingFromUpdateAvailable(facts, data)
    }
    case 'addon.updated': {
      const update = parseAddonUpdateComplete(data)
      return update === null ? null : incomingFromAddonUpdates(facts, [update])
    }
    case 'system.restart-completed': {
      return incomingFromServerUpdated(facts, data)
    }
    case 'system.restarting': {
      return incomingFromNodeRestarting(facts, data)
    }
    case 'recording.export.completed': {
      return incomingFromExportCompleted(facts, data)
    }
    case 'backup.run-completed': {
      return incomingFromBackupCompleted(facts, data)
    }
    case 'alert.episode': {
      return incomingFromAlertEpisode(facts, lookup)
    }
    default:
      return null
  }
}

/**
 * An alert episode edge (`alert-critical`, `alert-error`, `alert-critical-resolved`).
 *
 * The WORDS are the alert's own: the alert centre composed the title and the
 * message when it opened the alert, and a rule's template may reword them with
 * `{{title}}`, `{{message}}`, `{{severity}}`, `{{category}}`, `{{source}}`,
 * `{{node}}` and `{{actionUrl}}`. The subject is the EPISODE, so the dedup slot
 * of a new episode is never the one a previous, resolved, episode held.
 *
 * Whether an edge is notified at all (once per episode, reconciled from the
 * alerts store) is decided before this point, by `NcAlertEpisodeLedger`.
 */
function incomingFromAlertEpisode(
  facts: NcSystemEventFacts,
  lookup?: NcDeviceLookup,
): NcIncomingEvent | null {
  const payload = parseAlertEpisodePayload(facts.data)
  if (payload === null) return null
  const attention = incomingFromDeviceAttention(facts, payload, lookup)
  if (attention !== null) return attention
  const kind = alertEpisodeKind(payload.severity, payload.phase)
  if (kind === null) return null
  return systemSubject({
    facts,
    kind,
    subject: `alert:${payload.episodeId}`,
    titleKey: `system.${kind}.title`,
    bodyKey: `system.${kind}.body`,
    textParams: {
      title: payload.title,
      message: payload.message,
      severity: payload.severity,
      category: payload.category,
      source: payload.sourceId ?? '',
      nodeId: payload.nodeId ?? '',
      actionUrl: payload.actionUrl ?? '',
    },
    ...(payload.nodeId !== undefined ? { nodeId: payload.nodeId } : {}),
  })
}

/**
 * A CRITICAL alert whose source is a DEVICE (D911) is announced in the devices
 * family — `device-attention-required` / `-resolved`, carrying the device id so
 * a rule's device filters apply — and NOT as `alert-critical`, so one alert
 * never notifies twice through two families. A device source whose id is not a
 * device id falls through to the generic alert kinds.
 */
function incomingFromDeviceAttention(
  facts: NcSystemEventFacts,
  payload: AlertEpisodePayload,
  lookup: NcDeviceLookup | undefined,
): NcIncomingEvent | null {
  if (payload.sourceType !== 'device' || payload.sourceId === undefined) return null
  const kind = deviceAttentionKind(payload.severity, payload.phase)
  if (kind === null) return null
  const deviceId = Number(payload.sourceId)
  if (!Number.isInteger(deviceId)) return null
  const identity = lookup?.(deviceId)
  return systemSubject({
    facts,
    kind,
    subject: `alert:${payload.episodeId}`,
    titleKey: `system.${kind}.title`,
    bodyKey: `system.${kind}.body`,
    textParams: {
      ...deviceTextParams(deviceId, identity),
      title: payload.title,
      message: payload.message,
      category: payload.category,
      actionUrl: payload.actionUrl ?? '',
    },
    deviceId,
    ...(identity !== undefined ? { deviceType: identity.type } : {}),
    ...(payload.nodeId !== undefined ? { nodeId: payload.nodeId } : {}),
  })
}

export type UpdatePackageRow = {
  readonly packageName: string
  readonly currentVersion: string
  readonly latestVersion: string
  readonly nodeId?: string
}

/** The shells whose update has its own sentence. Anything else gets the plain
 *  one: a body that names a shell nobody observed is worse than a vague body. */
const WRAPPER_BODY_KINDS: ReadonlySet<string> = new Set(['docker', 'electron', 'native'])

/**
 * The SHELL announcement (D437) — the container / app bundle a node runs
 * inside is behind the release contract.
 *
 * It is deliberately NOT folded into `server-update-available`: the versions
 * here are the shell's (a seed closure, an app bundle), not the running code's,
 * and on 2026-08-02 the running code was perfectly current on a hub whose image
 * was 13 days old from a repository nothing rebuilt. It also mints no button —
 * no process can replace the shell it is running inside — so the BODY is the
 * whole delivery, and it is chosen by `wrapperKind` so a docker operator is
 * handed the exact command instead of a button that cannot exist.
 */
function incomingFromWrapperUpdate(
  facts: NcSystemEventFacts,
  data: Readonly<Record<string, unknown>>,
): NcIncomingEvent | null {
  const packages = updatePackages(data)
  if (packages.length === 0) return null
  const head = packages[0]!
  const nodeId = head.nodeId ?? stringField(data, 'nodeId')
  const wrapperKind = stringField(data, 'wrapperKind')
  const bodySuffix =
    wrapperKind !== undefined && WRAPPER_BODY_KINDS.has(wrapperKind) ? wrapperKind : null
  return systemSubject({
    facts,
    kind: 'wrapper-update-available',
    // One shell per node, so the node IS the dedup slot — a second sweep that
    // finds the same divergence must not announce it twice.
    subject: `wrapper:${nodeId ?? 'hub'}`,
    titleKey: 'system.wrapper-update-available.title',
    bodyKey:
      bodySuffix === null
        ? 'system.wrapper-update-available.body'
        : `system.wrapper-update-available.body.${bodySuffix}`,
    textParams: {
      currentVersion: head.currentVersion,
      latestVersion: head.latestVersion,
      ...(nodeId !== undefined ? { nodeId } : {}),
    },
    textCount: 1,
    packageName: head.packageName,
    packageNames: [head.packageName],
    ...(nodeId !== undefined ? { nodeId, nodeIds: [nodeId] } : {}),
  })
}

function incomingFromUpdateAvailable(
  facts: NcSystemEventFacts,
  data: Readonly<Record<string, unknown>>,
): NcIncomingEvent | null {
  const target = stringField(data, 'target')
  if (target === 'wrapper') return incomingFromWrapperUpdate(facts, data)
  if (target !== 'addon' && target !== 'server') return null
  const packages = updatePackages(data)
  if (packages.length === 0) return null
  const addon = target === 'addon'
  const kind = addon ? 'addon-update-available' : 'server-update-available'
  const nodeIds = unique(
    packages.map((pkg) => pkg.nodeId).filter((id): id is string => id !== undefined),
  )
  const packageNames = unique(packages.map((pkg) => pkg.packageName))
  const signature = packages
    .map((pkg) => `${pkg.nodeId ?? ''}:${pkg.packageName}@${pkg.latestVersion}`)
    .toSorted()
    .join(',')
  const head = packages[0]!
  const oneNode = nodeIds.length === 1 ? nodeIds[0] : undefined
  // The node is named ONCE. When every row belongs to the same node the TITLE
  // carries it ("2 aggiornamenti addon disponibili su agent-a") and the
  // lines under it are just the packages; a list spanning nodes names each one
  // per line, because there is no single answer to put in the title.
  const list = packages.map((pkg) => formatAvailableLine(pkg, oneNode !== undefined)).join('\n')
  const nodes = nodeIds.join(', ')
  return systemSubject({
    facts,
    kind,
    subject: addon ? `packages:addon:${signature}` : `packages:server:${signature}`,
    titleKey:
      addon && oneNode !== undefined ? `system.${kind}.title.onNode` : `system.${kind}.title`,
    bodyKey:
      !addon && oneNode !== undefined
        ? `system.${kind}.body.onNode`
        : !addon && nodeIds.length > 1
          ? `system.${kind}.body.onNodes`
          : `system.${kind}.body`,
    textParams: {
      list,
      packageName: head.packageName,
      currentVersion: head.currentVersion,
      latestVersion: head.latestVersion,
      nodes,
      count: String(addon ? packages.length : nodeIds.length > 0 ? nodeIds.length : 1),
      ...(oneNode !== undefined ? { nodeId: oneNode } : {}),
    },
    textCount: addon ? packages.length : nodeIds.length > 0 ? nodeIds.length : 1,
    packageName: head.packageName,
    packageNames,
    ...(oneNode !== undefined ? { nodeId: oneNode } : {}),
    ...(nodeIds.length > 0 ? { nodeIds } : {}),
  })
}

/**
 * Version-bearing `addon.updated` only — a settings save carries no versions
 * at all (`BaseAddon.updateGlobalSettings`).
 *
 * `toVersion` IS the discriminator, and `fromVersion` is not: the emitter
 * omits the predecessor when it cannot read what was installed (a first
 * install, an unreadable tree). Requiring both dropped those updates on the
 * floor entirely — the operator got no notification for an update that
 * happened — which is the price that was being paid to keep `'0.0.0'`
 * out. Report the half that is known; say nothing about the half that is not.
 */
export function parseAddonUpdateComplete(
  data: Readonly<Record<string, unknown>>,
): AddonUpdateComplete | null {
  const packageName = stringField(data, 'packageName')
  const fromVersion = stringField(data, 'fromVersion')
  const toVersion = stringField(data, 'toVersion')
  if (packageName === undefined || toVersion === undefined) {
    return null
  }
  const nodeId = stringField(data, 'agent') ?? stringField(data, 'nodeId')
  return {
    packageName,
    ...(fromVersion !== undefined ? { fromVersion } : {}),
    toVersion,
    ...(nodeId !== undefined ? { nodeId } : {}),
  }
}

export function incomingFromAddonUpdates(
  facts: NcSystemEventFacts,
  updates: readonly AddonUpdateComplete[],
): NcIncomingEvent | null {
  if (updates.length === 0) return null
  const packageNames = unique(updates.map((update) => update.packageName))
  const nodeIds = unique(
    updates.map((update) => update.nodeId).filter((id): id is string => id !== undefined),
  )
  const signature = updates
    .map((update) => `${update.nodeId ?? ''}:${update.packageName}@${update.toVersion}`)
    .toSorted()
    .join(',')
  // "0.1.47 → 0.1.51" when the predecessor is known, "→ 0.1.51" when it is
  // not. The arrow stays either way: the line still says an update LANDED and
  // names where it landed. Printing an unknown predecessor as a number is the
  // defect this replaced — "@camstack/addon-terminal 0.0.0 → latest" was read
  // as two versions, and neither existed.
  const list = updates
    .map((update) => {
      const transition =
        update.fromVersion !== undefined
          ? `${update.fromVersion} → ${update.toVersion}`
          : `→ ${update.toVersion}`
      return update.nodeId !== undefined
        ? `${update.packageName} ${transition} (${update.nodeId})`
        : `${update.packageName} ${transition}`
    })
    .join('\n')
  const head = updates[0]!
  return systemSubject({
    facts,
    kind: 'addon-updated',
    subject: `packages:addon-updated:${signature}`,
    titleKey: 'system.addon-updated.title',
    bodyKey: 'system.addon-updated.body',
    textParams: { list, count: String(packageNames.length) },
    textCount: packageNames.length,
    packageName: head.packageName,
    packageNames,
    ...(head.nodeId !== undefined ? { nodeId: head.nodeId } : {}),
    ...(nodeIds.length > 0 ? { nodeIds } : {}),
  })
}

function incomingFromServerUpdated(
  facts: NcSystemEventFacts,
  data: Readonly<Record<string, unknown>>,
): NcIncomingEvent | null {
  const kind = stringField(data, 'kind')
  const requestedBy = stringField(data, 'requestedBy')
  const packageName = stringField(data, 'packageName') ?? '@camstack/server'
  const fromVersion = stringField(data, 'fromVersion')
  const toVersion = stringField(data, 'toVersion') ?? versionFromRequestedBy(requestedBy)
  if (!restartIsUpdate(kind, requestedBy, toVersion)) return null
  const nodeId = stringField(data, 'nodeId') ?? 'hub'
  // Three sentences, not two: a marker written before the update engine
  // forwarded `fromVersion` still KNOWS where it landed, and dropping that
  // because the other half is missing is how "@camstack/server sul nodo hub è
  // stato aggiornato" [@camstack/server on the hub node has been updated] became the only thing the operator ever read.
  const bodyKey =
    toVersion === undefined
      ? 'system.server-updated.body.plain'
      : fromVersion === undefined
        ? 'system.server-updated.body.toOnly'
        : 'system.server-updated.body'
  return systemSubject({
    facts,
    kind: 'server-updated',
    subject: `server-updated:${nodeId}:${toVersion ?? 'unknown'}`,
    titleKey: 'system.server-updated.title',
    bodyKey,
    textParams: {
      packageName,
      nodeId,
      ...(fromVersion !== undefined ? { fromVersion } : {}),
      ...(toVersion !== undefined ? { toVersion } : {}),
    },
    packageName,
    nodeId,
    nodeIds: [nodeId],
  })
}

/**
 * Is this restart marker (`PendingRestartMarkerPayload`) an UPDATE?
 *
 * A PLAIN node restart travels under the same `server-update:` reason prefix
 * (`RootUpdateService.restartNode` → `server-update: manual restart`), so the
 * prefix alone is not evidence of an update — it needs a version, or a kind
 * that says so. Announcing "Server aggiornato" for a restart is a lie the
 * operator cannot check. ONE predicate for both halves of a restart (D723): the
 * `system.restarting` announcement and the `system.restart-completed` landing
 * must never disagree about whether the same marker was an update.
 */
function restartIsUpdate(
  kind: string | undefined,
  requestedBy: string | undefined,
  toVersion: string | undefined,
): boolean {
  return (
    kind === 'framework-update' ||
    kind === 'framework-bulk-update' ||
    (requestedBy !== undefined &&
      requestedBy.startsWith('server-update:') &&
      toVersion !== undefined)
  )
}

/**
 * A node announcing its OWN restart, before it exits (D723).
 *
 * The same `system.restarting` payload becomes one of two kinds, split by
 * {@link restartIsUpdate}: `node-updating` names the node and both versions
 * (when known), `node-restarting` names only the node — a plain restart comes
 * back as it was. A payload without `nodeId` is the hub's own (the hub's
 * emit predates the field, exactly as `system.restart-completed` defaults).
 *
 * The `node-updating` subject is keyed like `server-updated`'s
 * (`<node>:<toVersion>`): it is what the delivery gate compares to decide that
 * an announcement which drained only AFTER the landing is stale
 * (`restart-supersede.ts`).
 */
function incomingFromNodeRestarting(
  facts: NcSystemEventFacts,
  data: Readonly<Record<string, unknown>>,
): NcIncomingEvent {
  const kind = stringField(data, 'kind')
  const requestedBy = stringField(data, 'requestedBy')
  const nodeId = stringField(data, 'nodeId') ?? 'hub'
  const toVersion = stringField(data, 'toVersion') ?? versionFromRequestedBy(requestedBy)
  if (!restartIsUpdate(kind, requestedBy, toVersion)) {
    return systemSubject({
      facts,
      kind: 'node-restarting',
      // One per restart: two restarts of one node are two facts, and a shared
      // slot would let the first one's cooldown swallow the second.
      subject: `node-restart:${nodeId}:${numberField(data, 'requestedAt') ?? facts.timestamp}`,
      titleKey: 'system.node-restarting.title',
      bodyKey: 'system.node-restarting.body',
      textParams: { nodeId },
      nodeId,
      nodeIds: [nodeId],
    })
  }
  const packageName = stringField(data, 'packageName') ?? '@camstack/server'
  const what = stringField(data, 'what')
  const fromVersion = stringField(data, 'fromVersion')
  const bodyKey =
    toVersion === undefined
      ? 'system.node-updating.body.plain'
      : fromVersion === undefined
        ? 'system.node-updating.body.toOnly'
        : 'system.node-updating.body'
  return systemSubject({
    facts,
    kind: 'node-updating',
    // The closure keeps the slot `server-updated` shares; the shell and the
    // container image get their own, or one update would swallow the other.
    subject:
      what === undefined || what === 'server'
        ? `node-updating:${nodeId}:${toVersion ?? 'unknown'}`
        : `node-updating:${nodeId}:${what}:${toVersion ?? 'unknown'}`,
    titleKey: 'system.node-updating.title',
    bodyKey,
    textParams: {
      packageName,
      nodeId,
      ...(fromVersion !== undefined ? { fromVersion } : {}),
      ...(toVersion !== undefined ? { toVersion } : {}),
    },
    packageName,
    nodeId,
    nodeIds: [nodeId],
  })
}

/**
 * A finished backup RUN.
 *
 * Subject is the run, not the destination: `backup.completed` fires once per
 * destination and an operator with three of them would be told three times.
 * The counts travel in the text because a PARTIAL run must not read as a clean
 * one — two destinations of three is news, and a bare "backup completed" would
 * hide it.
 */
function incomingFromBackupCompleted(
  facts: NcSystemEventFacts,
  data: Readonly<Record<string, unknown>>,
): NcIncomingEvent | null {
  const ok = numberField(data, 'destinationsOk')
  const total = numberField(data, 'destinationsTotal')
  if (ok === undefined || total === undefined) return null
  const failed = numberField(data, 'destinationsFailed') ?? Math.max(0, total - ok)
  const sizeMB = numberField(data, 'sizeMB')
  const backupId = stringField(data, 'backupId')
  return systemSubject({
    facts,
    kind: 'backup-completed',
    // One subject per RUN. `backupId` when the run produced one; otherwise the
    // event timestamp, so two runs are never folded into one episode — which
    // an episode-keyed kind would do if the subject were constant.
    subject: `backup:${backupId ?? facts.timestamp}`,
    titleKey: 'system.backup-completed.title',
    // A partial run says so in its own sentence rather than in a number the
    // reader has to compare.
    bodyKey: failed > 0 ? 'system.backup-completed.body.partial' : 'system.backup-completed.body',
    textParams: {
      destinationsOk: String(ok),
      destinationsTotal: String(total),
      destinationsFailed: String(failed),
      ...(sizeMB !== undefined ? { sizeMB: String(sizeMB) } : {}),
      ...(backupId !== undefined ? { backupId } : {}),
    },
  })
}

function incomingFromExportCompleted(
  facts: NcSystemEventFacts,
  data: Readonly<Record<string, unknown>>,
): NcIncomingEvent | null {
  const exportId = stringField(data, 'exportId')
  if (exportId === undefined) return null
  const deviceId = numberField(data, 'deviceId')
  const title = stringField(data, 'title')
  const bytes = numberField(data, 'fileBytes')
  const notifyTargetIds = stringList(data, 'notifyTargetIds')
  const incoming = systemSubject({
    facts,
    kind: 'export-completed',
    subject: `export:${exportId}`,
    titleKey: 'system.export-completed.title',
    bodyKey:
      title !== undefined ? 'system.export-completed.body.titled' : 'system.export-completed.body',
    textParams: {
      exportId,
      ...(title !== undefined ? { title } : {}),
      ...(bytes !== undefined ? { bytes: String(bytes) } : {}),
      ...(deviceId !== undefined ? { deviceId: String(deviceId) } : {}),
    },
    ...(deviceId !== undefined ? { deviceId } : {}),
  })
  if (notifyTargetIds.length === 0) return incoming
  return {
    ...incoming,
    controls: { directTargetIds: notifyTargetIds, bypassMute: true },
  }
}

export function updatePackages(
  data: Readonly<Record<string, unknown>>,
): readonly UpdatePackageRow[] {
  const raw = data['packages']
  if (Array.isArray(raw) && raw.length > 0) {
    const rows: UpdatePackageRow[] = []
    for (const item of raw) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      const row = item as Record<string, unknown>
      const packageName = stringField(row, 'packageName')
      const currentVersion = stringField(row, 'currentVersion')
      const latestVersion = stringField(row, 'latestVersion')
      if (
        packageName === undefined ||
        currentVersion === undefined ||
        latestVersion === undefined
      ) {
        continue
      }
      const nodeId = stringField(row, 'nodeId')
      rows.push({
        packageName,
        currentVersion,
        latestVersion,
        ...(nodeId !== undefined ? { nodeId } : {}),
      })
    }
    if (rows.length > 0) return rows
  }
  const packageName = stringField(data, 'packageName')
  const currentVersion = stringField(data, 'currentVersion')
  const latestVersion = stringField(data, 'latestVersion')
  if (packageName === undefined || currentVersion === undefined || latestVersion === undefined) {
    return []
  }
  const nodeId = stringField(data, 'nodeId')
  return [
    {
      packageName,
      currentVersion,
      latestVersion,
      ...(nodeId !== undefined ? { nodeId } : {}),
    },
  ]
}

/**
 * One line of an availability list — the SAME shape the completed-update list
 * uses (`incomingFromAddonUpdates`), and deliberately word-free: the list is a
 * frozen param, so any English in it ("current") is delivered verbatim to an
 * Italian household. An arrow is not a language.
 */
function formatAvailableLine(pkg: UpdatePackageRow, nodeNamedInTitle: boolean): string {
  const line = `${pkg.packageName} ${pkg.currentVersion} → ${pkg.latestVersion}`
  return pkg.nodeId !== undefined && !nodeNamedInTitle ? `${line} (${pkg.nodeId})` : line
}

function versionFromRequestedBy(requestedBy: string | undefined): string | undefined {
  if (requestedBy === undefined) return undefined
  const match = /@([^@\s]+)$/.exec(requestedBy)
  return match?.[1]
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

/**
 * The COMBINED row's two keys, or null when this transition is not one.
 *
 * D706 (2026-10-06) changed the BODY: a rule-caused trigger now says WHERE the intrusion
 * went — `alarm.intrusion.body`, "Intrusion: Front door, Hallway, Hall", the locations of
 * the source and of every follower (D705), frozen as `{{locations}}`. The paragraphs below
 * describe the D126 title, which stands; the detection sentence they defend is now the
 * body of the alarm rules' own INTRUSION pushes (titled with the location) instead.
 *
 * A rule that trips the alarm produces ONE notification, and the operator has
 * to be able to read it: the title is the severity marker over the camera
 * (`alarm.combined.title`, shipped as `Alarm: {{deviceName}}` and re-wordable
 * per rule or in the Texts tab), and the body is `detection.body` — the exact
 * sentence that rule's ordinary notification would have carried, with its own
 * class, identity and zones.
 *
 * The alarm used to write its own prose here ("The alarm was triggered by
 * Person at gate on Front door"), which made the one notification that matters
 * the only one in the system that did not look like the rule's others: no
 * identity, no zone, a different subject. The prefix carries the severity; the
 * familiar line carries the meaning.
 *
 * **Gated on the detection vocabulary, not on the source.** `detection.body`
 * renders `{{subject}}`, and a fire ref with no class composes it from the
 * system event's dedup slot — "alarm:42 su Front door". A source without a class
 * therefore keeps the alarm's own sentence, which is also what every row
 * enqueued before this deploy carries.
 */
function combinedAlarmText(
  kind: NcAlarmTransition['kind'],
  source: NcRuleFireRef | undefined,
): { readonly titleKey: string; readonly bodyKey: string } | null {
  // Only the TRIGGER combines. An entry delay started by the same rule is a
  // countdown, and its own notification is the one push about that match (D706).
  if (kind !== 'alarm-triggered' || source === undefined) return null
  // D706: the body names WHERE the intrusion went — the locations of the source and of
  // every follower, frozen as `{{locations}}` — not one camera's detection sentence.
  return {
    titleKey:
      source.className !== undefined ? 'alarm.combined.title' : 'system.alarm-triggered.title',
    bodyKey: 'alarm.intrusion.body',
  }
}

/**
 * The title and body keys an alarm row carries — ONE function, so the
 * catalog spec (`alarm-texts.spec.ts`) enumerates exactly what the intake can
 * select.
 *
 * VARIANT SELECTION AT INTAKE, like every other system sentence: the mode is
 * part of the words ("Away armed"), not a fragment substituted into them,
 * because the catalog renders in ONE pass and a `{{mode}}` filled with `away`
 * would deliver the enum value to a person.
 */
function alarmTextKeys(
  transition: NcAlarmTransition,
  body:
    | {
        readonly bodyKey: string
        readonly titleKeySuffix?: 'all'
      }
    | undefined,
): { readonly titleKey: string; readonly bodyKey: string } {
  const { kind, source } = transition
  const combined = combinedAlarmText(kind, source)
  if (combined !== null) return combined
  const baseTitle =
    transition.mode !== undefined
      ? `system.${kind}.title.${transition.mode}`
      : `system.${kind}.title`
  const titleKey =
    body?.titleKeySuffix !== undefined ? `${baseTitle}.${body.titleKeySuffix}` : baseTitle
  if (body !== undefined) return { titleKey, bodyKey: body.bodyKey }
  if (kind === 'alarm-sensor-bypass' && transition.sensor !== undefined) {
    return { titleKey, bodyKey: `system.${kind}.body.${transition.sensor.event}` }
  }
  // Auto-disarm after a bounded `disableAfter` window — distinct from a human
  // disarming while the alarm was triggered.
  if (kind === 'alarm-disarmed' && transition.autoCleared === true) {
    return { titleKey, bodyKey: `system.${kind}.body.autoCleared` }
  }
  // A disarm that cancelled an entry delay or a triggered alarm says WHICH: "disarmed"
  // alone reads the same as an ordinary evening disarm, and "during an alarm" could
  // not tell the operator whether the alarm had actually gone off. (The bare
  // `.defused` key stays in the catalog for rows frozen before the split.)
  if (kind === 'alarm-disarmed' && transition.previous === 'pending') {
    return { titleKey, bodyKey: `system.${kind}.body.defused.pending` }
  }
  if (kind === 'alarm-disarmed' && transition.previous === 'triggered') {
    return { titleKey, bodyKey: `system.${kind}.body.defused.triggered` }
  }
  // A triggered or pending alarm the pipeline set off NAMES what set it off;
  // a manual one has nothing to name.
  const named = source !== undefined && (kind === 'alarm-triggered' || kind === 'alarm-pending')
  return { titleKey, bodyKey: named ? `system.${kind}.body.rule` : `system.${kind}.body` }
}

/** Whose event the row is — see {@link incomingFromAlarmTransition}. */
function alarmSubjectDevice(transition: NcAlarmTransition, panelDeviceId: number): number {
  if (transition.kind === 'alarm-sensor-bypass' && transition.sensor !== undefined) {
    return transition.sensor.deviceId
  }
  return transition.source?.deviceId ?? panelDeviceId
}

/**
 * The panel's own transition, as a system-event subject.
 *
 * IN-PROCESS, not off the bus. The alarm and the Notification Center live in
 * the same process, and D8 says an event may be dropped — which is fine for
 * telemetry and unacceptable for "the alarm went off". So the panel hands the
 * transition over directly and it builds a subject through the same
 * `systemSubject` every bus category uses; nothing downstream has an alarm
 * branch, and a rule authors `kinds: ['alarm-triggered']` exactly as it authors
 * `kinds: ['node-offline']`.
 *
 * **WHOSE event it is.** With no attribution the event is about the PANEL —
 * an operator pressed a button, and the panel is the only device involved.
 * With one, it is about the CAMERA that set it off: that is the media owner,
 * the name the body reads out ("ALLARME — Front door"), and the device a rule
 * scoping `deviceIds` means. One sentence, and both halves of it are testable.
 * A SENSOR BYPASS is about the sensor — its name is the title.
 */
export function incomingFromAlarmTransition(input: {
  readonly transition: NcAlarmTransition
  readonly panelDeviceId: number
  readonly lookup: NcDeviceLookup
  /**
   * Body variant + params for an ARM or an ARMING, composed by the caller from
   * the mode's coverage — which rules and devices it actually arms (Active /
   * Skipped / Bypassed lists), and the seconds left when it is still arming —
   * and for a REFUSAL (the open devices, and the Arm anyway line). Absent for
   * every other transition. The catalog shells `system.alarm-armed.body` /
   * `system.alarm-arming.body` exist so a missing composed body never renders
   * blank, but arm/arming must not rely on them: the centre always composes.
   */
  readonly body?: {
    readonly bodyKey: string
    readonly textParams: Readonly<Record<string, string>>
    readonly textCount: number
    readonly titleKeySuffix?: 'all'
  }
}): NcIncomingEvent {
  const { transition, panelDeviceId } = input
  const source = transition.source
  const deviceId = alarmSubjectDevice(transition, panelDeviceId)
  const identity = input.lookup(deviceId)
  const kind = transition.kind
  const keys = alarmTextKeys(transition, input.body)
  const sensor = transition.sensor
  // PENDING and TRIGGERED both carry the rule that pressed the button: the
  // entry-delay push is the first alarm notification the operator sees, and
  // without the source it is text-only even when the sensor already owns a
  // snapshot. The COMBINED sentence (detection body) stays siren-only — see
  // {@link combinedAlarmText}.
  const alarmSource =
    (kind === 'alarm-triggered' || kind === 'alarm-pending') && source !== undefined
      ? source
      : undefined
  // The incident's other subjects ride alarm-triggered only (D705): the entry-delay push
  // is sent when the countdown starts, before any of them happened.
  const alarmFollowers =
    kind === 'alarm-triggered' && alarmSource !== undefined ? transition.followers : undefined
  // D706: where the intrusion went, in arrival order — the source, then every follower.
  const intrusionWords =
    kind === 'alarm-triggered' && alarmSource !== undefined
      ? intrusionLocations(
          [alarmSource, ...(alarmFollowers ?? [])].map(intrusionDeviceOf),
          (id) => {
            const known = input.lookup(id)
            return {
              ...(known?.location !== undefined ? { location: known.location } : {}),
              ...(known !== undefined ? { name: known.name } : {}),
            }
          },
        )
      : undefined
  const facts: NcSystemEventFacts = {
    // Unique per transition, so two arms an hour apart are two rows and a
    // re-delivery of the same one is deduped. `at` is the transition instant,
    // never "when somebody looked" — `settle` may report it a tick late. A
    // bypass is per SENSOR, and a refusal per REFUSAL: two of either inside
    // one millisecond are two facts.
    eventId: `alarm:${kind}:${String(transition.at)}${
      sensor !== undefined ? `:${String(sensor.deviceId)}` : ''
    }${transition.refusalId !== undefined ? `:${transition.refusalId}` : ''}`,
    timestamp: transition.at,
    category: `alarm.${kind.slice('alarm-'.length)}`,
    data: {
      panelDeviceId,
      state: transition.state,
      previous: transition.previous,
      ...(transition.mode !== undefined ? { mode: transition.mode } : {}),
      ...(source !== undefined ? { sourceRuleId: source.ruleId } : {}),
      // FROZEN on the row: the Arm anyway button is minted from the ROW, so a
      // notification drained minutes late still offers the refusal it reports
      // — never whatever the panel refused last.
      ...(transition.refusalId !== undefined ? { refusalId: transition.refusalId } : {}),
      ...(sensor !== undefined ? { sensorDeviceId: sensor.deviceId, event: sensor.event } : {}),
    },
  }
  const deviceParams = deviceTextParams(deviceId, identity)
  return systemSubject({
    facts,
    kind,
    // The panel's OWN subject line, always — `alarm:<panel>` is one dedup slot
    // for the whole lifecycle, so an arm and the disarm that follows it cannot
    // collide with the camera's liveness slot.
    subject: `alarm:${String(panelDeviceId)}`,
    // A COMBINED row is the exception to the alarm's own keys, deliberately:
    // its title is the severity marker over the camera's name, and its body is
    // the sentence the triggering rule's own notification would have carried.
    // See {@link combinedAlarmText}.
    titleKey: keys.titleKey,
    bodyKey: keys.bodyKey,
    textParams: {
      ...deviceParams,
      // A sensor the directory cannot name yet, named by whoever reported it.
      ...(sensor?.name !== undefined && identity === undefined ? { deviceName: sensor.name } : {}),
      ...(transition.mode !== undefined ? { mode: transition.mode } : {}),
      ...(source !== undefined ? { rule: source.ruleName } : {}),
      // The countdown the ARMING and PENDING TITLES render. Frozen here rather
      // than only in the coverage body, because a transition whose coverage
      // could not be derived composes no body at all — and the title would
      // then render "Inserimento Casa — s".
      ...(kind === 'alarm-arming' || kind === 'alarm-pending'
        ? { seconds: `${transition.seconds ?? 0}` }
        : {}),
      ...(intrusionWords !== undefined ? { locations: intrusionWords.join(', ') } : {}),
      ...input.body?.textParams,
    },
    deviceId,
    ...(identity !== undefined ? { deviceType: identity.type } : {}),
    ...(input.body !== undefined ? { textCount: input.body.textCount } : {}),
    ...(alarmSource !== undefined ? { alarmSource } : {}),
    ...(alarmFollowers !== undefined ? { alarmFollowers } : {}),
  })
}

/** Re-stamp a live-producer envelope as a boot-reconcile replay of the same
 *  record — same subject, honest origin in the log. */
export function asReconcile(event: NcIncomingEvent): NcIncomingEvent {
  return { ...event, origin: 'reconcile' }
}

/**
 * The delivery an intake kind rides. `object-event`, `audio-event` and
 * `audio-window` all ride `immediate` (audio has no delivery of its own — the
 * first is gated by the audio-class opt-in, the second by the `audio`
 * condition); `occupancy-event` rides `device-event`.
 *
 * Extracted from the centre so the tester can tell an operator which rules a
 * given simulated trigger will even be considered against, without evaluating.
 */
export function deliveryForKind(kind: NcSubjectKind): NcDelivery {
  if (kind === 'object-event' || kind === 'audio-event' || kind === 'audio-window') {
    return 'immediate'
  }
  if (kind === 'occupancy-event') return 'device-event'
  return kind
}
