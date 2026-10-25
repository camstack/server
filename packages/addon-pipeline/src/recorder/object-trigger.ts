/**
 * The gate between `pipeline-analytics.detection-event` and "open a
 * recording window".
 *
 * Sibling of `recorder/event-capture.ts` and for the same reason: the qualification
 * has branches, and a branch that discards work without saying so is indistinguishable from a
 * function that was never wired. Every negative verdict NAMES the reason, and the caller
 * logs it.
 *
 * Pure: no bus, no clock, no config. The choice of WHICH classes to
 * listen to belongs to the band (`bandTriggerSources`); here we only decide whether
 * the event is a usable detection and which macro class it is.
 *
 * ## Why the shape is DISCRIMINATED on `kind` (2026-08-29)
 *
 * Until 2026-08-29 this file declared ONE flat shape — that
 * of the `object` event — and demanded it from EVERY payload of the topic. But
 * `EventCategory.PipelineAnalyticsDetectionEvent` is a topic shared by three
 * emitters in `addon-post-analysis/src/pipeline-analytics/index.ts`: object
 * (`className`, `source`, `confidence`, `zones`), motion and audio — and motion and
 * audio do not carry `className`, because they have none. The measured result:
 * `malformed` on **394 sampled rows out of 394**, at 3.3–3.9 events/s, for
 * weeks. `malformed` means "the emitter has drifted" and was
 * instead the normal traffic of the topic; the only bucket that could signal
 * a real protocol break was saturated at 100% with healthy events, hence
 * useless — and it was read as "the object trigger never worked".
 *
 * So: first the common ENVELOPE is validated (`deviceId`, `kind`, `timestamp`),
 * then we discriminate on `kind`, and only the `object` branch demands the fields
 * of the object. An `object` without `className` remains a defect and has its own name
 * (`malformed-object`), distinct from an unreadable envelope.
 */
import { isFirstLevelMacroClass, type FirstLevelMacroClass } from '@camstack/types'

/** The `kind` of the only branch of the topic that can open a window. */
const OBJECT_EVENT_KIND = 'object'

/**
 * The ENVELOPE that every payload of the topic carries, whatever the `kind` — the three
 * emitters write it identically. Only the fields this gate reads are
 * declared: the payload carries others (`eventId` on all three) and
 * redeclaring them here would be a second copy of a shape that is not ours.
 */
interface DetectionEventEnvelope {
  readonly deviceId: number
  readonly kind: string
  readonly timestamp: number
}

/**
 * The `kind: 'object'` branch — emitted once per persisted object event
 * (`pipeline-analytics/index.ts`, *"Enriched (flat) so consumers can filter on
 * className / confidence / zones / source WITHOUT re-fetching the persisted
 * event by id"*). `className` and `source` exist ONLY here: motion and audio do not
 * classify anything.
 */
interface ObjectDetectionEventData extends DetectionEventEnvelope {
  readonly className: string
  readonly source?: string
}

/** Why a `detection-event` did not open any window. */
export type ObjectTriggerSkipReason =
  /** The ENVELOPE does not have the expected shape — emitter with a different version. */
  | 'malformed'
  /** Valid envelope, `kind: 'object'`, but without the object fields: real drift,
   *  and unlike `malformed` we know WHICH camera produced it. */
  | 'malformed-object'
  /** Same topic, other `kind` (audio, motion): not an object detection.
   *  NOT discarded work — it is another branch of the same topic. */
  | 'not-object'
  /** `source: 'onboard'` — the camera's AI, which does not go through the executor. */
  /** No longer produced: onboard boxes go through the operator gate at
   *  their entry and qualify like any other. Kept in the union because the
   *  counters already written name it — removing it would make them unreadable. */
  | 'not-pipeline'
  /** A `className` outside the three first-level macros. */
  | 'not-a-macro'

/** The reasons that arrive AFTER the envelope validation, and which can therefore
 *  name the camera. Only `malformed` cannot. */
export type DeviceKnownSkipReason = Exclude<ObjectTriggerSkipReason, 'malformed'>

/** The outcome of the qualification. Discriminated union: the `malformed` case — and only
 *  that one — does NOT carry a `deviceId`, because it is precisely the case in which none
 *  is known. Every other discard names the camera, which is the only thing
 *  that makes "why is 102 worse than 101" readable. */
export type ObjectTriggerVerdict =
  | {
      readonly qualified: true
      readonly deviceId: number
      readonly macroClass: FirstLevelMacroClass
      readonly atMs: number
    }
  | { readonly qualified: false; readonly reason: 'malformed' }
  | {
      readonly qualified: false
      readonly reason: DeviceKnownSkipReason
      readonly deviceId: number
    }

/** Type guard, not cast: `event.data` is `unknown` until it passes through here. */
function isDetectionEventEnvelope(value: unknown): value is DetectionEventEnvelope {
  if (typeof value !== 'object' || value === null) return false
  if (!('deviceId' in value) || typeof value.deviceId !== 'number') return false
  if (!Number.isFinite(value.deviceId)) return false
  if (!('kind' in value) || typeof value.kind !== 'string') return false
  // Non-finite is REJECTED here and no longer downstream: a window opened at `NaN`
  // compares `false` against every segment, forever — `foldDurableTriggers`
  // filters the same rows for the same reason.
  if (!('timestamp' in value) || typeof value.timestamp !== 'number') return false
  if (!Number.isFinite(value.timestamp) || value.timestamp <= 0) return false
  return true
}

/** The fields that ONLY the object branch carries. Called after the envelope. */
function isObjectDetectionEventData(
  value: DetectionEventEnvelope,
): value is ObjectDetectionEventData {
  if (!('className' in value) || typeof value.className !== 'string') return false
  if ('source' in value && value.source !== undefined && typeof value.source !== 'string') {
    return false
  }
  return true
}

export function qualifyObjectTrigger(data: unknown): ObjectTriggerVerdict {
  if (!isDetectionEventEnvelope(data)) return { qualified: false, reason: 'malformed' }
  const deviceId = data.deviceId
  if (data.kind !== OBJECT_EVENT_KIND) return { qualified: false, reason: 'not-object', deviceId }
  if (!isObjectDetectionEventData(data)) {
    return { qualified: false, reason: 'malformed-object', deviceId }
  }
  // `onboard` is the CAMERA's AI, and for months it was rejected here. The reason
  // was good: `nativeDetectionsToFrame` copies the firmware class verbatim
  // and that vocabulary includes `face` and `other`, and not going through the executor
  // `enabledMacroClasses` and the `minConfidence<Macro>` had never run
  // on it. Recording on top of it would have been a SECOND truth about the same
  // detection: the operator's sliders described one and the
  // recording would have followed the other.
  //
  // That premise was removed rather than worked around. Onboard boxes now
  // go through the SAME gate (`macroGateVerdict`, asked by both
  // roots) at the point where they enter — `onboardRootDetections` — so a
  // detection that arrives all the way here has already passed the classes and the thresholds
  // the operator chose. There is no second truth to conflict with.
  //
  // Cost of the rejection, measured on 640 on 2026-09-15: the operator walked
  // in front of the camera, the firmware saw them for ~100 s, and EVERY detection was
  // rejected (`not-pipeline`, 11 out of 11 in two minutes). No
  // recording. The only camera in the fleet with onboard on had
  // no trigger at all, and it was invisible except for a WARN per minute.
  const className = data.className.trim().toLowerCase()
  if (!isFirstLevelMacroClass(className)) {
    return { qualified: false, reason: 'not-a-macro', deviceId }
  }
  return { qualified: true, deviceId, macroClass: className, atMs: data.timestamp }
}
