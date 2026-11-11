/**
 * The `device-fired` row's model (D1045): the device's event vocabulary read
 * as "which part" (a button) and "which event", what a pick writes on the row,
 * and the picks the device no longer declares.
 *
 * The editor writes `sourceIds` and `eventIds`, one of each. `kinds` and
 * `match` are written by hand or by a tool: a pick here never drops them.
 */
import type { DeviceFiredLeaf, EventVocabularyEntry, EventVocabularySource } from '@camstack/types'
import { EventEmitterStatusSchema, readEventVocabulary } from '@camstack/types'

/** The cap whose slice carries the vocabulary. */
export const EVENT_EMITTER_CAP = 'event-emitter'

/** What the slice read is known to say. Not-yet-known is never "no events" (D315). */
export type FiredVocabularyState =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known'; readonly vocabulary: readonly EventVocabularyEntry[] }

export interface FiredVocabularyRead {
  readonly status: 'pending' | 'error' | 'success'
  readonly data: unknown
}

export function firedVocabularyOf(read: FiredVocabularyRead): FiredVocabularyState {
  if (read.status === 'pending') return { kind: 'pending' }
  if (read.status === 'error') return { kind: 'unknown' }
  const parsed = EventEmitterStatusSchema.safeParse(read.data)
  if (!parsed.success) return { kind: 'unknown' }
  return { kind: 'known', vocabulary: readEventVocabulary(parsed.data) }
}

/** Each part of the device that fires, once, in declared order. */
export function firedSources(
  vocabulary: readonly EventVocabularyEntry[],
): readonly EventVocabularySource[] {
  const seen = new Map<string, EventVocabularySource>()
  for (const entry of vocabulary) {
    if (entry.source !== undefined && !seen.has(entry.source.id)) {
      seen.set(entry.source.id, entry.source)
    }
  }
  return [...seen.values()]
}

/** The events of one part, or — with none picked — every event token once. */
export function firedEvents(
  vocabulary: readonly EventVocabularyEntry[],
  sourceId: string | undefined,
): readonly EventVocabularyEntry[] {
  const seen = new Map<string, EventVocabularyEntry>()
  for (const entry of vocabulary) {
    if (sourceId !== undefined && entry.source?.id !== sourceId) continue
    if (!seen.has(entry.id)) seen.set(entry.id, entry)
  }
  return [...seen.values()]
}

/** A new device: its buttons and events are not the old one's. */
export function withFiredDevice(leaf: DeviceFiredLeaf, deviceId: number): DeviceFiredLeaf {
  return {
    kind: 'device-fired',
    ...(leaf.id === undefined ? {} : { id: leaf.id }),
    deviceId,
  }
}

export function withFiredSource(
  leaf: DeviceFiredLeaf,
  sourceId: string | undefined,
  vocabulary: readonly EventVocabularyEntry[],
): DeviceFiredLeaf {
  const { sourceIds: _sources, eventIds, ...rest } = leaf
  const offered = new Set(firedEvents(vocabulary, sourceId).map((entry) => entry.id))
  const kept = (eventIds ?? []).filter((id) => offered.has(id))
  return {
    ...rest,
    ...(sourceId === undefined ? {} : { sourceIds: [sourceId] }),
    ...(kept.length === 0 ? {} : { eventIds: kept }),
  }
}

export function withFiredEvent(
  leaf: DeviceFiredLeaf,
  eventId: string | undefined,
): DeviceFiredLeaf {
  const { eventIds: _events, ...rest } = leaf
  return { ...rest, ...(eventId === undefined ? {} : { eventIds: [eventId] }) }
}

export interface StaleFiredPicks {
  readonly sourceIds: readonly string[]
  readonly eventIds: readonly string[]
}

/** What the row names that the device's vocabulary does not. */
export function staleFiredPicks(
  leaf: DeviceFiredLeaf,
  vocabulary: readonly EventVocabularyEntry[],
): StaleFiredPicks {
  const sources = new Set(firedSources(vocabulary).map((source) => source.id))
  const events = new Set(vocabulary.map((entry) => entry.id))
  return {
    sourceIds: (leaf.sourceIds ?? []).filter((id) => !sources.has(id)),
    eventIds: (leaf.eventIds ?? []).filter((id) => !events.has(id)),
  }
}
