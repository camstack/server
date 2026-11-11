/**
 * The `device-fired` trigger: does this fire of an `event-emitter` device start
 * a run (D1045).
 *
 * Two doors lead here, and a fire passes exactly one of them:
 *  - the bus event (`EventCategory.EventEmitted`, payload `EventFire`) — the
 *    normal path;
 *  - the reconcile read of the device's `event-emitter` slice — events are
 *    telemetry (D8), so a fire whose event was dropped is still seen as
 *    `lastEvent`, when it is the latest one. Only the LATEST is recoverable.
 *
 * The watch remembers the newest fire it has handled. "Newer" is the fire's
 * timestamp, then its `seq`: `seq` restarts at 1 with the provider, so it
 * orders two fires of one provider run and nothing else.
 *
 * The first reading of the slice only SEEDS (a restart is not a press), and a
 * read that failed changes nothing (D49): the next good one still seeds.
 */
import { EventEmitterStatusSchema, EventFireSchema } from '../capabilities/event-emitter.cap.js'
import type { EventFire } from '../capabilities/event-emitter.cap.js'
import {
  type EventVocabularyEntry,
  type EventVocabularyKind,
  conventionalEventVocabulary,
  findVocabularyEntry,
  readEventVocabulary,
} from '../capabilities/event-vocabulary.js'
import type { DeviceFiredLeaf } from './when.js'

/** What a `device-fired` run exposes to conditions and actions. */
export interface DeviceFiredVars {
  readonly deviceId: number
  readonly eventType: string
  /** The part of the device that fired (a button); empty when the fire names none. */
  readonly sourceId: string
  /**
   * The vocabulary kind of the event (`long-press`); empty when it declares
   * none. Not `kind`: that key of a run's bag already names the trigger row.
   */
  readonly eventKind: string
}

/** A payload value a run variable can hold. */
export type FiredDataScalar = string | number | boolean

/** The fire's payload, flat: `data.<dotted path>` → scalar. */
export type FiredDataVars = Readonly<Record<string, FiredDataScalar>>

export type DeviceFiredDecision =
  | { readonly kind: 'ignore'; readonly why: string }
  | {
      readonly kind: 'reject'
      readonly reason: string
      readonly vars: DeviceFiredVars
      readonly data: FiredDataVars
    }
  | {
      readonly kind: 'fire'
      readonly reason: string
      readonly vars: DeviceFiredVars
      readonly data: FiredDataVars
    }

/** How deep a payload is walked, and how many variables one fire may add. */
const MAX_DATA_DEPTH = 3
const MAX_DATA_VARS = 32

function isScalar(value: unknown): value is FiredDataScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The scalars of a fire's payload as `data.<path>` variables; lists and nulls are left out. */
export function firedDataVars(data: unknown): FiredDataVars {
  const out: Record<string, FiredDataScalar> = {}
  const walk = (value: unknown, path: string, depth: number): void => {
    if (Object.keys(out).length >= MAX_DATA_VARS) return
    if (isScalar(value)) {
      out[path] = value
      return
    }
    if (!isRecord(value) || depth >= MAX_DATA_DEPTH) return
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`, depth + 1)
  }
  if (isRecord(data)) {
    for (const [key, child] of Object.entries(data)) walk(child, `data.${key}`, 1)
  }
  return out
}

function readPath(data: unknown, path: string): unknown {
  let cursor: unknown = data
  for (const part of path.split('.')) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[part]
  }
  return cursor
}

interface FireKey {
  readonly timestamp: number
  readonly seq: number
}

function isNewer(fire: FireKey, than: FireKey | null): boolean {
  if (than === null) return true
  if (fire.timestamp !== than.timestamp) return fire.timestamp > than.timestamp
  return fire.seq > than.seq
}

/** Said in the trace when the reconcile, not the bus event, brought the fire. */
export const FIRED_RECOVERED_NOTE = 'recovered by reconcile'

export class DeviceFiredWatch {
  /** The newest fire handled, by either door. */
  #last: FireKey | null = null
  /** A baseline exists: a slice was read, or a bus event arrived. */
  #seeded = false
  /** The device's vocabulary as last read; `null` until a slice answered. */
  #vocabulary: readonly EventVocabularyEntry[] | null = null

  constructor(private readonly leaf: DeviceFiredLeaf) {}

  /** A bus event (`event.data` of `EventCategory.EventEmitted`). */
  onEvent(data: unknown): DeviceFiredDecision {
    const parsed = EventFireSchema.safeParse(data)
    if (!parsed.success) return { kind: 'ignore', why: 'malformed event' }
    const fire = parsed.data
    if (fire.deviceId !== this.leaf.deviceId) {
      return { kind: 'ignore', why: `device ${fire.deviceId} is not the trigger's device` }
    }
    if (!isNewer(fire, this.#last)) return { kind: 'ignore', why: 'this fire was already handled' }
    this.#last = { timestamp: fire.timestamp, seq: fire.seq }
    this.#seeded = true
    return this.#judge(fire, false)
  }

  /** A reading of the device's `event-emitter` slice (seed, then reconcile). */
  onStatus(status: unknown): DeviceFiredDecision {
    const parsed = EventEmitterStatusSchema.safeParse(status)
    if (!parsed.success) return { kind: 'ignore', why: 'the event-emitter status is unreadable' }
    this.#vocabulary = readEventVocabulary(parsed.data)
    const fire = parsed.data.lastEvent
    const first = !this.#seeded
    this.#seeded = true
    if (fire === null) return { kind: 'ignore', why: 'the device has not fired' }
    if (!isNewer(fire, this.#last)) return { kind: 'ignore', why: 'this fire was already handled' }
    this.#last = { timestamp: fire.timestamp, seq: fire.seq }
    if (first)
      return { kind: 'ignore', why: 'seeded: what fired before the start is not a trigger' }
    if (fire.deviceId !== this.leaf.deviceId) {
      return { kind: 'ignore', why: `device ${fire.deviceId} is not the trigger's device` }
    }
    return this.#judge(fire, true)
  }

  #kindOf(fire: EventFire): EventVocabularyKind | undefined {
    const vocabulary = this.#vocabulary ?? conventionalEventVocabulary([fire.eventType])
    const sourced = findVocabularyEntry(vocabulary, fire.eventType, fire.sourceId)
    return (sourced ?? findVocabularyEntry(vocabulary, fire.eventType))?.kind
  }

  #judge(fire: EventFire, recovered: boolean): DeviceFiredDecision {
    const { eventIds, sourceIds, kinds, match } = this.leaf
    if (eventIds !== undefined && !eventIds.includes(fire.eventType)) {
      return {
        kind: 'ignore',
        why: `event ${fire.eventType} is not one of [${eventIds.join(', ')}]`,
      }
    }
    if (
      sourceIds !== undefined &&
      (fire.sourceId === undefined || !sourceIds.includes(fire.sourceId))
    ) {
      return {
        kind: 'ignore',
        why: `source ${fire.sourceId ?? '(none)'} is not one of [${sourceIds.join(', ')}]`,
      }
    }
    const kind = this.#kindOf(fire)
    if (kinds !== undefined && (kind === undefined || !kinds.includes(kind))) {
      return { kind: 'ignore', why: `kind ${kind ?? '(none)'} is not one of [${kinds.join(', ')}]` }
    }
    const vars: DeviceFiredVars = {
      deviceId: fire.deviceId,
      eventType: fire.eventType,
      sourceId: fire.sourceId ?? '',
      eventKind: kind ?? '',
    }
    const data = firedDataVars(fire.data)
    for (const predicate of match ?? []) {
      const found = readPath(fire.data, predicate.path)
      if (found !== predicate.equals) {
        return {
          kind: 'reject',
          reason: `data.${predicate.path} is ${JSON.stringify(found) ?? 'not set'}, the trigger wants ${JSON.stringify(predicate.equals)}`,
          vars,
          data,
        }
      }
    }
    const what = `${fire.eventType}${fire.sourceId === undefined ? '' : ` from ${fire.sourceId}`}`
    return {
      kind: 'fire',
      reason: recovered ? `${what} — ${FIRED_RECOVERED_NOTE}` : what,
      vars,
      data,
    }
  }
}
