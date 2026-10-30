/**
 * The `detection` trigger's per-event decision: does this track-lifecycle
 * event start a run, and if not, WHY not.
 *
 * Source: `EventCategory.PipelineAnalyticsTrackLifecycle` — payload
 * {@link PipelineAnalyticsTrackLifecyclePayload} (`deviceId`, `trackId`,
 * `phase` start|update|end, `bestClassName`, `bestConfidence`,
 * `zonesVisited`). The event carries the device in its DATA, not on its
 * `source`, so the filter reads `data.deviceId`.
 *
 * ONE fire per `(deviceId, trackId)`: a track fires the first time it satisfies
 * the subject, score and zone conditions (which may be on an `update`, once its
 * best confidence has risen, or once its face or plate has been resolved — D683
 * decides identity late, so a leaf with a label fires on the update that
 * carries it, never on the first detection), and never again. The fired set is bounded and
 * forgets a track on its `end` or after {@link FIRED_TTL_MS}, so a track whose
 * `end` was dropped (events are telemetry, D8) cannot pin memory.
 */

import { COCO_TO_MACRO } from '../catalogs/coco-classmap.js'
import type { TrackLifecyclePhase } from '../interfaces/event-bus.js'
import {
  type DetectionSubject,
  anySubjectMatches,
  subjectFromClassName,
} from './detection-subject.js'
import type { LegacyDetectionTrigger } from './legacy-recipe.js'
import type { DetectionLeaf } from './when.js'

/** A detection leaf — or the old trigger a block generated before the single tree still hands over. */
export type DetectionTrigger = DetectionLeaf | LegacyDetectionTrigger

/** The subjects a trigger asks for, whichever shape it has. */
function subjectsOf(trigger: DetectionTrigger): readonly DetectionSubject[] {
  return 'subjects' in trigger ? trigger.subjects : trigger.classes.map(subjectFromClassName)
}

/** A track that never ended is forgotten after this long. */
export const FIRED_TTL_MS = 15 * 60_000
/** Hard bound on the fired set. */
export const FIRED_MAX = 512

/** The fields of a track-lifecycle event the trigger reads. */
export interface TrackLifecycleInput {
  readonly deviceId?: unknown
  readonly trackId?: unknown
  readonly phase?: unknown
  readonly bestClassName?: unknown
  readonly classes?: unknown
  /** The display label once resolved: an identity name, a plate text. */
  readonly label?: unknown
  readonly identityId?: unknown
  readonly plateText?: unknown
  readonly bestConfidence?: unknown
  readonly zonesVisited?: unknown
}

/** What a detection run exposes to conditions and actions. */
export interface DetectionVars {
  readonly deviceId: number
  readonly className: string
  readonly trackId: string
  readonly score: number
  /** The label the subject matched (`dog`, a face name, a plate); empty when the leaf names none. */
  readonly label: string
}

export type DetectionDecision =
  /** Not this trigger's business (other device, malformed, an `end`): neither fired nor traced. */
  | { readonly kind: 'ignore'; readonly why: string }
  | {
      readonly kind: 'reject'
      readonly reason: string
      readonly vars: DetectionVars
    }
  | {
      readonly kind: 'fire'
      readonly reason: string
      readonly vars: DetectionVars
    }

const MACRO_NAMES: ReadonlySet<string> = new Set(Object.values(COCO_TO_MACRO.mapping))

function macroOf(className: string): string {
  return COCO_TO_MACRO.mapping[className] ?? className
}

/** `animal` matches a dog; `dog` matches only a dog (a cat is also an animal). */
export function detectionClassMatches(wanted: string, actual: string): boolean {
  const w = wanted.toLowerCase()
  const a = actual.toLowerCase()
  if (w === a) return true
  return MACRO_NAMES.has(w) && macroOf(a) === w
}

function isPhase(value: unknown): value is TrackLifecyclePhase {
  return value === 'start' || value === 'update' || value === 'end'
}

export class DetectionTriggerFilter {
  /** `${deviceId}|${trackId}` → fired at. Insertion-ordered, so the oldest is first. */
  private readonly fired = new Map<string, number>()

  private readonly subjects: readonly DetectionSubject[]

  constructor(private readonly trigger: DetectionTrigger) {
    this.subjects = subjectsOf(trigger)
  }

  get firedCount(): number {
    return this.fired.size
  }

  evaluate(event: TrackLifecycleInput, now: number): DetectionDecision {
    const { deviceId, trackId, phase } = event
    if (typeof deviceId !== 'number' || typeof trackId !== 'string' || !isPhase(phase)) {
      return { kind: 'ignore', why: 'malformed track-lifecycle event' }
    }
    if (!this.trigger.deviceIds.includes(deviceId)) {
      return { kind: 'ignore', why: `device ${deviceId} is not one of the trigger's devices` }
    }
    const key = `${deviceId}|${trackId}`
    if (phase === 'end') {
      this.fired.delete(key)
      return { kind: 'ignore', why: 'track ended' }
    }
    this.expire(now)

    const className = typeof event.bestClassName === 'string' ? event.bestClassName : ''
    const score = typeof event.bestConfidence === 'number' ? event.bestConfidence : 0
    const vars: DetectionVars = { deviceId, className, trackId, score, label: '' }

    if (this.fired.has(key)) {
      return { kind: 'reject', reason: `already fired for track ${trackId}`, vars }
    }
    const verdict = anySubjectMatches(this.subjects, {
      className,
      ...(Array.isArray(event.classes)
        ? { classes: event.classes.filter((c): c is string => typeof c === 'string') }
        : {}),
      ...(typeof event.label === 'string' ? { label: event.label } : {}),
      ...(typeof event.identityId === 'string' ? { identityId: event.identityId } : {}),
      ...(typeof event.plateText === 'string' ? { plateText: event.plateText } : {}),
    })
    if (!verdict.matches) return { kind: 'reject', reason: verdict.reason, vars }
    const matched: DetectionVars = { ...vars, label: verdict.label }
    if (this.trigger.minScore !== undefined && score < this.trigger.minScore) {
      return { kind: 'reject', reason: `score ${score} < ${this.trigger.minScore}`, vars: matched }
    }
    if (this.trigger.zones !== undefined) {
      const visited = Array.isArray(event.zonesVisited)
        ? event.zonesVisited.filter((z): z is string => typeof z === 'string')
        : []
      if (!this.trigger.zones.some((z) => visited.includes(z))) {
        return {
          kind: 'reject',
          reason: `zone mismatch: visited [${visited.join(', ')}], wanted [${this.trigger.zones.join(', ')}]`,
          vars: matched,
        }
      }
    }
    this.remember(key, now)
    return {
      kind: 'fire',
      reason: `${verdict.label === '' ? className : verdict.label} ${score} on device ${deviceId}`,
      vars: matched,
    }
  }

  private remember(key: string, now: number): void {
    this.fired.set(key, now)
    while (this.fired.size > FIRED_MAX) {
      const oldest = this.fired.keys().next()
      if (oldest.done === true) break
      this.fired.delete(oldest.value)
    }
  }

  private expire(now: number): void {
    for (const [key, at] of this.fired) {
      if (now - at < FIRED_TTL_MS) break
      this.fired.delete(key)
    }
  }
}
