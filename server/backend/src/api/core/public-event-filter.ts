/**
 * The one predicate every public event procedure applies before an event
 * leaves the hub (D224, D663): an owner-only category — today the native
 * shadow of a claimed cap — is never served, whatever the caller's role or
 * filter. A subscriber that omits `category` gets every PUBLIC category, not
 * every category.
 *
 * `publicRecent` is the history half: it filters BEFORE the limit, so a
 * client asking for N public events gets N — an owner-only row in the window
 * never costs the caller a slot. The ring is bounded (`MAX_RECENT_EVENTS`), so
 * reading it whole and cutting afterwards is one bounded pass.
 */
import { type EventFilter, isOwnerOnlyEventCategory, type SystemEvent } from '@camstack/types'

export function isPublicEvent(evt: Pick<SystemEvent, 'category'>): boolean {
  return !isOwnerOnlyEventCategory(evt.category)
}

/** What a procedure reads history from: the bus, or a service wrapping it. */
export interface RecentEventSource {
  getRecent(filter?: EventFilter, limit?: number): readonly SystemEvent[]
}

/** A per-principal projection (`scopedEventVisibility`), or null for an unfiltered caller. */
export type EventKeep = ((evt: SystemEvent) => boolean) | null

export function publicRecent(
  source: RecentEventSource,
  filter: EventFilter | undefined,
  limit: number | undefined,
  keep: EventKeep,
): readonly SystemEvent[] {
  const visible = source
    .getRecent(filter)
    .filter((evt) => isPublicEvent(evt) && (keep === null || keep(evt)))
  return limit !== undefined ? visible.slice(-limit) : visible
}
