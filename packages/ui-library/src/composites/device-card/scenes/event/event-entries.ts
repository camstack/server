/**
 * How an event card names a declared event. An entry is the token AND the
 * part of the device it comes from: two buttons both declare `PRESS_SHORT`.
 */
import type { UiTextFn } from '../../../../contexts/ui-text'
import type { EventCardEntry, EventCardModel, EventCardSource } from './EventCard'

export interface EventEntryGroup {
  readonly source: EventCardSource | null
  readonly entries: readonly EventCardEntry[]
}

/** Stable identity of one declared event. The token alone collides across parts. */
export function eventEntryKey(entry: EventCardEntry): string {
  return `${entry.source?.id ?? ''}:${entry.id}`
}

export function sameEvent(
  last: NonNullable<EventCardModel['last']>,
  entry: EventCardEntry,
): boolean {
  return last.id === entry.id && last.sourceId === entry.source?.id
}

/** More than one part of the device declares events: the list is grouped under them. */
export function eventSourcesMany(entries: readonly EventCardEntry[]): boolean {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (entry.source !== undefined) ids.add(entry.source.id)
  }
  return ids.size > 1
}

/** Declared order, one group per part, events that name no part last. */
export function groupEventEntries(entries: readonly EventCardEntry[]): readonly EventEntryGroup[] {
  const bySource = new Map<string, EventEntryGroup>()
  const loose: EventCardEntry[] = []
  for (const entry of entries) {
    if (entry.source === undefined) {
      loose.push(entry)
      continue
    }
    const prev = bySource.get(entry.source.id)
    bySource.set(entry.source.id, {
      source: entry.source,
      entries: [...(prev?.entries ?? []), entry],
    })
  }
  return [...bySource.values(), ...(loose.length === 0 ? [] : [{ source: null, entries: loose }])]
}

/**
 * The words on one row. Under a group heading the heading already names the
 * part, so the row is the event alone.
 */
export function eventEntryText(entry: EventCardEntry, grouped: boolean, t: UiTextFn): string {
  if (grouped || entry.source === undefined) return entry.label
  return t('uiLibrary.deviceCard.event.sourced', '{{source}} · {{event}}', {
    source: entry.source.label,
    event: entry.label,
  })
}

/** The last-fired line: the part and the event, even when the list is grouped. */
export function eventLastText(
  last: NonNullable<EventCardModel['last']>,
  entries: readonly EventCardEntry[],
  t: UiTextFn,
): string {
  const entry = entries.find((candidate) => sameEvent(last, candidate))
  if (entry?.source === undefined) return last.label
  return t('uiLibrary.deviceCard.event.sourced', '{{source}} · {{event}}', {
    source: entry.source.label,
    event: entry.label,
  })
}
