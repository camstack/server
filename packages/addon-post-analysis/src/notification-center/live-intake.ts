/**
 * Extracted from NotificationCenter (onObjectEventPersisted, onTrackClosed, onSensorEventPersisted, onSensorEvent, onAudioEventPersisted, onPackageEventPersisted, observeOpeningEvent, beginLinkedStills, reportLinkedCameraMuted, audioStillOwner, onUnownedSensorEvent, recognitionOutlookFor, consumeNodeLiveness, readNodeDisplayName, announceLiftAfterEvaluation).
 * The class method forwards private state through {@link LiveIntakeHost}.
 */

import { alarmOpeningFromSensorEvent } from './alarm/alarm-openings.js'
import type { NcObserveOpeningResult } from './alarm/alarm-panel-device.js'
import { NO_MATCH_REPORT_INTERVAL_MS } from './build-entries.js'
import { NcDeviceMuteStore } from './device-mute-store.js'
import type { NcIncomingEvent } from './event-intake.js'
import {
  incomingFromAudioEvent,
  incomingFromObjectEvent,
  incomingFromPackageEvent,
  incomingFromSensorEvent,
  incomingFromTrack,
  incomingFromUnownedSensorEvent,
} from './event-intake.js'
import type { NcRecognitionOutlook, NcRecognitionOutlookQuery } from './grouped/grouped-inputs.js'
import type { NcLinkedStills } from './linked-stills.js'
import { NcLinkedStillShelf } from './linked-stills.js'
import type { LivenessTiming } from './liveness-holdoff.js'
import { withNodeLivenessFacts } from './node-liveness-text.js'
import type { NcPackagePhase, NcTrackClosedInfo } from './rule-engine.js'
import {
  deviceEventRuleMayFireOnKind,
  deviceScopeExcludes,
  referencesAudioClass,
  ruleShipsNoStill,
} from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import { NcStateSummaryService } from './state-summary/state-summary-service.js'
import { NcStillShelf } from './still-shelf.js'
import { NcSummaryCollector } from './summary/summary-collector.js'
import type {
  AudioEvent,
  IScopedLogger,
  MediaFileBytes,
  ObjectEvent,
  SensorEvent,
  Track,
} from '@camstack/types'
import type { NcAlarmPanelPort, NotificationCenterDeps } from './index.js'

/** Bound on the post-hold-off `nodes.directory` read that names a node. */
export const NODE_NAME_READ_TIMEOUT_MS = 3_000
/**
 * The className every durable package event carries (mirrors
 * `PackageDropDetector.PACKAGE_EVENT_CLASS` — declared locally so the NC module
 * stays free of a cross-module import into the pipeline). Delivery events use
 * the `idle` state, pick-ups the `left` state.
 */
export const PACKAGE_EVENT_CLASS = 'package'
/** Classify an object-event row as a package delivery / pick-up, or `null` when
 *  it is an ordinary detection. */
export function packagePhaseOf(ev: ObjectEvent): NcPackagePhase | null {
  if (ev.className !== PACKAGE_EVENT_CLASS) return null
  if (ev.state === 'left') return 'picked-up'
  if (ev.state === 'idle') return 'delivered'
  return null
}
/** What {@link NotificationCenter.beginLinkedStills} is asked to photograph. */
export interface NcLinkedStillsRequest {
  readonly sensorId: number
  /** The sensor event kind (`EVENT_KIND_BY_CAP[cap].kind`) — which rules could fire. */
  readonly sensorKind: string
  /** Every camera linking the sensor, primary first — UNFILTERED. */
  readonly cameraIds: readonly number[]
  /** The cameras that take a timeline row for the change (the opt-in). */
  readonly rowCameraIds: readonly number[]
  readonly atMs: number
  /**
   * Which edge the change is (D640): true raised, false cleared. ABSENT = the
   * slice could not say — then every rule counts, exactly as the evaluation
   * lets an unknown edge through, so the gate stays coarse the safe way.
   */
  readonly sensorRaised?: boolean
}
/** One sensor state change, evaluated ONCE at the sensor level (ADR 0632). */
export interface NcSensorEventInput {
  /** `deviceId` = the PRIMARY camera, `sourceDeviceId` = the sensor. */
  readonly event: SensorEvent
  /** Every camera linking the sensor, primary first — UNFILTERED: the centre
   *  applies the mute itself, and says so per camera. */
  readonly linkedCameraIds: readonly number[]
  /**
   * The cameras that took a timeline row for this change (they opted the
   * sensor into tracked events). With the sensor, the device scope a rule
   * matches on (D630 §6) — `[]` when none did.
   */
  readonly rowCameraIds: readonly number[]
  /** The primary camera's marker, when one landed. */
  readonly markerTrackId?: string
  /** The shelf owners {@link NotificationCenter.beginLinkedStills} returned. */
  readonly linkedStills?: NcLinkedStills
}

export interface LiveIntakeHost {
  readonly alarmPanel: NcAlarmPanelPort | null
  announceLiftAfterEvaluation(lifted: NcObserveOpeningResult, event: SensorEvent): void
  audioStillOwner(deviceId: number, atMs: number, mode: 'legacy' | 'condition'): string | undefined
  consumeEvent(event: NcIncomingEvent): void
  readonly deps: NotificationCenterDeps
  readonly deviceMutes: NcDeviceMuteStore
  readonly evaluationActive: boolean
  readonly lastLinkedMutedReportAt: Map<number, number>
  readonly linkedMutedSuppressed: Map<number, number>
  readonly linkedStills: NcLinkedStillShelf | null
  readonly logger: IScopedLogger
  readonly now: () => number
  observeOpeningEvent(event: SensorEvent): NcObserveOpeningResult
  onChain(name: string, run: () => Promise<void>, deviceId: number): Promise<void>
  readNodeDisplayName(nodeId: string | undefined): Promise<string | undefined>
  reportLinkedCameraMuted(cameraId: number, sensorId: number): void
  readonly rules: NcRuleStore
  readonly stateSummary: NcStateSummaryService
  readonly stills: NcStillShelf | null
  readonly summaryCollector: NcSummaryCollector
  unmutedCameras(cameraIds: readonly number[]): readonly number[]
}

/**
 * Called at the object-event persist site, in the SAME moment as the
 * durable insert. Fire-and-forget from the frame path (never blocks the
 * pipeline); the boot reconcile covers a crash between persist and
 * outbox insert.
 */
export function onObjectEventPersisted(
  host: LiveIntakeHost,
  event: ObjectEvent,
  _track?: Track,
): void {
  // Package rows route through the package-event trigger, never the
  // object-event one. Today the PackageDropDetector inserts directly (this
  // hook never sees its rows), but reconcile() and dryRun() already guard —
  // this keeps all three evaluation entry points consistent so a future
  // insert-path refactor cannot double-fire one physical event (review L1).
  if (packagePhaseOf(event) !== null) return
  // MOTION, for the digest windows. Fed here rather than from a bus event
  // because a digest window that opened late would collect the wrong range,
  // and D8 says an event may be dropped — this hook fires in the same moment
  // as the durable insert.
  host.summaryCollector.observeMotion({
    deviceId: event.deviceId,
    atMs: event.timestamp,
    ...(event.trackId !== undefined ? { trackId: event.trackId } : {}),
  })
  // A detection is the only evidence a blind camera sees again (D647).
  if (host.evaluationActive) host.stateSummary.observeDetection(event.deviceId)
  host.consumeEvent(incomingFromObjectEvent(event))
}
/**
 * Called from `TrackCloser.closeExpired` (the ONE close point, D-3) via
 * the injected hook. `ownedMedia` is the close-time media set (kept for
 * observability; attachments re-resolve by owner at send time so
 * post-close promotions are picked up).
 */
export function onTrackClosed(
  host: LiveIntakeHost,
  track: Track,
  _ownedMedia: readonly MediaFileBytes[],
  info?: NcTrackClosedInfo,
): void {
  // The track-close BARRIER's release signal. This is the tracker's one close
  // point, which is exactly what the barrier needs: a digest must not render
  // before the subjects it is about have had their best shot written.
  host.summaryCollector.observeTrackClosed(track.trackId)
  host.consumeEvent(incomingFromTrack(track, info))
}
/**
 * Called for each SensorEvent row (`ingestSensorStateChange` — one per linked
 * camera), once the same state change has had its chance to project a marker
 * track. Feeds the `device-event` trigger (doorbell press / sensor state
 * change). Fire-and-forget from the ingest loop; the outbox owns delivery.
 *
 * `markerTrackId` is that marker — the synthetic track carrying the camera's
 * frame — and it is what gives this notification a picture: the payload
 * freezes it as the media owner and the dispatcher resolves it through the
 * ladder every other attachment uses. Absent means no marker landed, and the
 * notification is text-only; that is logged, per camera, at the enqueue.
 *
 * Delivery-grade boundary (honest): the SensorEventStore is itself fed from
 * the LOSSY `DeviceStateChanged` telemetry bus, and there is no NC crash-gap
 * reconcile for sensor rows in this slice (unlike object events). So a dropped
 * upstream bus event, or a crash in the persist→outbox window, drops the
 * device-event notification — the durable guarantee begins at this hook, not
 * before it.
 */
export function onSensorEventPersisted(
  host: LiveIntakeHost,
  event: SensorEvent,
  markerTrackId?: string,
): void {
  // BEFORE the evaluation, and the order is the whole point: an excluded
  // sensor is re-armed by the OPEN that follows a close, and the rule that
  // fires on that same open reaches the panel through the evaluation below.
  // Lifting after it would leave the first real intrusion refused.
  const lifted = host.observeOpeningEvent(event)
  host.consumeEvent(incomingFromSensorEvent(event, markerTrackId))
  host.announceLiftAfterEvaluation(lifted, event)
}
/**
 * ONE evaluation for one sensor state change (ADR 0632) — replaces the
 * per-camera fan-out when the sensor is linked to more than one camera.
 *
 * The linked cameras widen the MEDIA only — which cameras' stills ship —
 * never which rules fire. Matching is on the SENSOR and the cameras that
 * took a timeline row (`rowCameraIds`, not muted) — D630 §6, whatever the
 * number of linked cameras. The primary is only the camera the notification
 * leads with.
 *
 * The primary is re-derived here as the first linked camera that is NOT
 * muted (D62): a camera's mute drops only its own tile, and its marker is
 * then not the picture. Every linked camera muted ⇒ the sensor is its own
 * device and the notification is text-only. The MUTE of the event itself is
 * judged on the sensor ({@link NcRuleSubject.linkedSensorId}). A
 * `rule-device` cooldown is keyed by the primary. Same lossy boundary as
 * {@link onSensorEventPersisted}.
 */
export function onSensorEvent(host: LiveIntakeHost, input: NcSensorEventInput): void {
  // BEFORE the evaluation, for the reason `onSensorEventPersisted` gives.
  const lifted = host.observeOpeningEvent(input.event)
  const shown = host.unmutedCameras(input.linkedCameraIds)
  const muted = input.linkedCameraIds.filter((id) => !shown.includes(id))
  const primary = shown[0] ?? input.event.sourceDeviceId
  // The marker is the picture of ONE camera — the one the caller called
  // primary. Another primary means another camera, and that marker is not it.
  const marker = primary === input.event.deviceId ? input.markerTrackId : undefined
  host.consumeEvent(
    incomingFromSensorEvent(
      { ...input.event, deviceId: primary },
      marker,
      {
        linkedCameraIds: shown,
        // A muted camera's rules do not fire, as its own row would not have;
        // every row camera muted drops the event (the mute gate).
        rowCameraIds: host.unmutedCameras(input.rowCameraIds),
        mutedRowCameraIds: input.rowCameraIds.filter((id) => host.deviceMutes.isMuted(id)),
        ...(input.linkedStills !== undefined ? { linkedStills: input.linkedStills } : {}),
      },
      muted,
    ),
  )
  host.announceLiftAfterEvaluation(lifted, input.event)
}
/**
 * Called at the AUDIO-event persist site (`eventStore.insertAudio`), in the
 * SAME moment as the durable insert. Feeds an `immediate` rule that OPTS IN
 * to an `audio-*` class (the safety gate in `evaluateRule` — a rule without
 * an audio class never fires here). Fire-and-forget; the outbox owns delivery.
 *
 * Delivery-grade boundary (honest): audio events persist on a SEPARATE store
 * from object events, and there is no NC crash-gap reconcile for audio rows
 * in this slice (unlike object events, which the boot reconcile re-scans). So
 * a crash in the persist→outbox window drops the audio notification — the
 * durable guarantee begins at this hook, matching the device-event boundary.
 */
export function onAudioEventPersisted(host: LiveIntakeHost, event: AudioEvent): void {
  host.consumeEvent(
    incomingFromAudioEvent(event, host.audioStillOwner(event.deviceId, event.timestamp, 'legacy')),
  )
}
/**
 * Called at the package object-event persist site (`PackageDropDetector` —
 * delivered/picked-up), in the SAME moment as the durable insert. Feeds the
 * `package-event` trigger. Package events ARE object-event rows, so the boot
 * crash-gap reconcile re-covers them (routed by className in {@link reconcile}).
 *
 * When a pick-up HAPPENED is on the row (`event.observedAt`, D684), so this
 * hook and the reconcile read it from the same place.
 */
export function onPackageEventPersisted(
  host: LiveIntakeHost,
  event: ObjectEvent,
  phase: NcPackagePhase,
): void {
  host.consumeEvent(incomingFromPackageEvent(event, phase))
}
/**
 * The opening reading a sensor row carries — a contact, a cover or a lock,
 * read with D630's table (`alarmOpeningFromSensorEvent`) — handed to the
 * panel. A row that is not an opening, or whose word is unknown, hands over
 * nothing: an unreadable state must never move an exclusion (D49).
 */
export function observeOpeningEvent(
  host: LiveIntakeHost,
  event: SensorEvent,
): NcObserveOpeningResult {
  const panel = host.alarmPanel
  if (panel === null) return 'unchanged'
  const opening = alarmOpeningFromSensorEvent(event.kind, event.value)
  if (opening.kind !== 'reading') return 'unchanged'
  // D706: the lift is ANNOUNCED after this event's evaluation, not here — see
  // {@link announceLiftAfterEvaluation}.
  const changedAt = event.value?.['lastChangedAt']
  return panel.observeOpening(event.sourceDeviceId, opening.reading, event.timestamp, {
    deferLiftAnnouncement: true,
    // D735: the slice's own change time — whether an excluded sensor really MOVED.
    ...(typeof changedAt === 'number' ? { changedAt } : {}),
  })
}
/**
 * Start photographing every camera that links `sensorId`, and return the
 * owners the sensor-level evaluation names — or `undefined` when there is
 * nothing to photograph (`cameraIds` empty), nothing to show (every linked
 * camera muted), the event will be dropped as muted (the SENSOR is muted,
 * or there were row cameras and every one is muted — see the evaluation's
 * mute gate), or no enabled device-event rule that could fire on this
 * sensor KIND wants a picture (the gate is the RULE's media policy, scope
 * and kind conditions, read from the in-memory mirror — D49, as
 * `audioStillOwner`; an occupancy rule, which rides the same delivery,
 * never fires on a sensor). One linked camera is enough: link alone owns
 * notification media; tracked rows are a separate timeline question. Coarse
 * on purpose, in one direction only: a capture for a rule whose other
 * conditions then fail is one wasted snapshot, a missing capture is a
 * notification without its picture. The kind check is what keeps a chatty
 * multi-linked motion sensor from composing a mosaic on every edge for a
 * doorbell rule.
 *
 * A MUTED camera (D62) is never dialled: its tile is left out, said on that
 * camera (once per window), and the primary is the first linked camera that
 * is not muted — the same derivation {@link onSensorEvent} makes.
 *
 * `cameraIds` is every linking camera, UNFILTERED; `rowCameraIds` the ones
 * that take a timeline row for the change — with the sensor, the device
 * scope the evaluation will match on (`matchesDeviceScope`).
 */
export function beginLinkedStills(
  host: LiveIntakeHost,
  request: NcLinkedStillsRequest,
): NcLinkedStills | undefined {
  const { sensorId, sensorKind, cameraIds, atMs, rowCameraIds, sensorRaised } = request
  const shelf = host.linkedStills
  // One linked camera is enough for a still (link-alone media); zero is not.
  // Multi-camera mosaic is a mode of the shelf, not a gate on photographing.
  if (shelf === null || !host.evaluationActive || cameraIds.length === 0) return undefined
  if (host.deviceMutes.isMuted(sensorId)) return undefined
  const rowShown = host.unmutedCameras(rowCameraIds)
  // Every row camera muted: the evaluation drops the event (D62).
  if (rowCameraIds.length > 0 && rowShown.length === 0) return undefined
  const shown = host.unmutedCameras(cameraIds)
  // The same scope the evaluation matches: the sensor and the cameras that
  // took a row (not muted). A camera that only LINKS the sensor never widens
  // which rules fire (ADR 0632 widens media only), so its rule cannot ask
  // for a capture here.
  const involved = [sensorId, ...rowShown]
  const wanted = host.rules.listEnabled('device-event').some((rule) => {
    // The EFFECTIVE policy: a sensor rule always attaches one snapshot,
    // whatever it stored (operator ruling 2026-10-01).
    if (ruleShipsNoStill(rule)) return false
    // Kind AND edge: a raise-only flood rule wants no mosaic of back-to-dry.
    if (!deviceEventRuleMayFireOnKind(rule, sensorKind, sensorRaised)) return false
    // The evaluation's own exclusion (D641), on the set it will judge: a rule
    // that excludes the sensor, or every row camera, can never use a mosaic.
    const excluded = rule.conditions.devicesExclude
    if (
      excluded !== undefined &&
      deviceScopeExcludes(excluded, {
        deviceId: sensorId,
        linkedSensorId: sensorId,
        rowCameraIds: rowShown,
      })
    ) {
      return false
    }
    const devices = rule.conditions.devices
    return (
      devices === undefined || devices.length === 0 || devices.some((id) => involved.includes(id))
    )
  })
  if (!wanted) return undefined
  for (const cameraId of cameraIds) {
    if (!shown.includes(cameraId)) host.reportLinkedCameraMuted(cameraId, sensorId)
  }
  return shown.length > 0 ? shelf.captureSet(sensorId, shown, atMs) : undefined
}
/**
 * A muted camera left out of a linked set — one INFO line per camera per
 * window, the suppressed count folded into the next one. A chatty contact
 * linked to a muted camera must not write a line on every change.
 */
export function reportLinkedCameraMuted(
  host: LiveIntakeHost,
  cameraId: number,
  sensorId: number,
): void {
  const now = host.now()
  const last = host.lastLinkedMutedReportAt.get(cameraId)
  const suppressed = host.linkedMutedSuppressed.get(cameraId) ?? 0
  if (last !== undefined && now - last < NO_MATCH_REPORT_INTERVAL_MS) {
    host.linkedMutedSuppressed.set(cameraId, suppressed + 1)
    return
  }
  host.lastLinkedMutedReportAt.set(cameraId, now)
  host.linkedMutedSuppressed.set(cameraId, 0)
  host.logger.info('linked camera muted — left out of the sensor notification', {
    tags: { deviceId: cameraId },
    meta: {
      sensorId,
      reason: 'muted',
      ...(suppressed > 0 ? { alsoLeftOutSinceLastReport: suppressed } : {}),
    },
  })
}
/**
 * Start photographing `deviceId` NOW and return the owner id the audio
 * subject should name — or `undefined` when nothing would use it.
 *
 * **The capture is not awaited.** A sound is transient and a notification
 * about a scream must not wait on a camera; the bytes land while the outbox
 * row queues, and the dispatcher's ordinary bounded still-wait picks them up.
 * That is also why this runs BEFORE the cooldown and the mute are consulted:
 * by the time a rule's window has been judged the moment is gone.
 *
 * **The gate is the RULE's media policy, not the trigger.** Photographing a
 * camera on every confirmed window for rules that ship text anyway would be a
 * snapshot at whatever rate the sound happens to occur, for nothing. The rule
 * cache is an in-memory mirror, so this is not a fallible read (D49) — a
 * failed one would look exactly like "no rule wants a picture", which is the
 * direction that DESTROYS the media.
 */
export function audioStillOwner(
  host: LiveIntakeHost,
  deviceId: number,
  atMs: number,
  mode: 'legacy' | 'condition',
): string | undefined {
  const shelf = host.stills
  if (shelf === null || !host.evaluationActive) return undefined
  for (const rule of host.rules.listEnabled('immediate')) {
    if (ruleShipsNoStill(rule)) continue
    // The engine's own symmetric safety gate, read from the same two fields:
    // a rule declaring `audio` fires ONLY on a confirmed match, and a legacy
    // rule ONLY on a classified episode it opted in to by class. Photographing
    // for the other kind would be a snapshot no notification can ever use.
    const wants =
      mode === 'condition'
        ? rule.conditions.audio !== undefined
        : rule.conditions.audio === undefined && referencesAudioClass(rule.conditions.classes)
    if (!wants) continue
    const devices = rule.conditions.devices
    if (devices !== undefined && devices.length > 0 && !devices.includes(deviceId)) continue
    const excluded = rule.conditions.devicesExclude
    if (excluded !== undefined && deviceScopeExcludes(excluded, { deviceId })) continue
    return shelf.capture(deviceId, atMs, 'audio')
  }
  return undefined
}
/**
 * Called for a sensor state change no camera takes a timeline row for
 * (`ingestSensorStateChange`'s `onUnowned`, D630 §6): linked to no camera
 * (`linkedCameraIds` = []), or linked only by cameras that did not opt it
 * into tracked events (`linkedCameraIds` = those cameras). Nothing was
 * persisted, but the event is evaluated exactly like a persisted one, so a
 * contact rule fires and the contact reaches the alarm panel. The sensor is
 * its own device, and the notification is text-only (no marker).
 *
 * A separate door from {@link onSensorEventPersisted} because the SUBJECT
 * differs, not the path: both feed the panel first and then the same
 * evaluation. Same lossy boundary: no row, so no reconcile.
 */
export function onUnownedSensorEvent(
  host: LiveIntakeHost,
  event: SensorEvent,
  linkedCameraIds: readonly number[],
): void {
  const lifted = host.observeOpeningEvent(event)
  host.consumeEvent(incomingFromUnownedSensorEvent(event, linkedCameraIds))
  host.announceLiftAfterEvaluation(lifted, event)
}
/**
 * D692 §4: the recognition outlook of one member, through the wired dep — `unknown`
 * (pending, D49) when nothing is wired or the dep throws. The one read the grouped
 * windows and the rule status use.
 */
export function recognitionOutlookFor(
  host: LiveIntakeHost,
  query: NcRecognitionOutlookQuery,
): NcRecognitionOutlook {
  const outlook = host.deps.recognitionOutlook
  if (outlook === undefined) {
    return { final: false, awaiting: 'unknown', reason: 'outlook-not-wired' }
  }
  try {
    return outlook(query)
  } catch (err) {
    return { final: false, awaiting: 'unknown', reason: `outlook-threw: ${String(err)}` }
  }
}
/**
 * A node liveness flip that survived its hold-off: freeze the node's display
 * name and (on a recovery) the outage length onto it, then consume it.
 *
 * The name read is bounded and best-effort — a slow or failed directory
 * costs the friendly name, never the notification (the intake already froze
 * the id as `nodeName`).
 */
export function consumeNodeLiveness(
  host: LiveIntakeHost,
  event: NcIncomingEvent,
  timing: LivenessTiming,
): void {
  const nodeId = event.subject.systemEvent?.nodeId
  void host.readNodeDisplayName(nodeId).then((nodeName) => {
    host.consumeEvent(
      withNodeLivenessFacts(event, nodeName !== undefined ? { timing, nodeName } : { timing }),
    )
  })
}
export async function readNodeDisplayName(
  host: LiveIntakeHost,
  nodeId: string | undefined,
): Promise<string | undefined> {
  const read = host.deps.readNodeDirectory
  if (nodeId === undefined || read === undefined) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), NODE_NAME_READ_TIMEOUT_MS)
    })
    const answer = await Promise.race([read(), timeout])
    return answer?.nodes.find((node) => node.id === nodeId)?.name
  } catch (err) {
    host.logger.debug('node display name unavailable — notifying with the id', {
      meta: { nodeId, error: String(err) },
    })
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
/**
 * "Watched again", once the event that lifted the sensor has been EVALUATED (D706).
 *
 * On the serialized chain, behind that evaluation: by then the event's alarm rule has
 * pressed the panel (the attribution note is placed synchronously in the evaluation), so
 * the panel can tell whether this very sensor started the entry delay — in which case the
 * entry-delay notification already names it and "watched again" would be its duplicate.
 */
export function announceLiftAfterEvaluation(
  host: LiveIntakeHost,
  lifted: NcObserveOpeningResult,
  event: SensorEvent,
): void {
  if (lifted !== 'lifted') return
  const panel = host.alarmPanel
  if (panel === null) return
  void host.onChain(
    'alarm-lift-announce',
    async () => panel.announceLifted(event.sourceDeviceId, event.timestamp),
    event.sourceDeviceId,
  )
}
