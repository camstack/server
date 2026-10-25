/**
 * Home Assistant calendar-source — discovers `calendar.*` entities and
 * fetches events via `calendar.get_events` with `return_response`.
 *
 * `calendar.list_events` was removed in HA 2024.6; calling it rejects with a
 * plain object (not an Error), which previously logged as `[object Object]`
 * and left the admin Calendars page empty.
 */

import type {
  CalendarEvent,
  CalendarInfo,
  CalendarListEventsInput,
  ICalendarSourceProvider,
  IScopedLogger,
} from '@camstack/types'
import type { HaBrokerRegistry } from './ha-broker-registry.js'
import type { PublishTargetHa } from './ha-integration-manager.js'
import { type HaEntityState, HaEntityStateSchema } from './ha-types.js'

export interface HaCalendarSourceDeps {
  readonly brokers: HaBrokerRegistry
  readonly logger: IScopedLogger
  /**
   * Entity ids to import (`calendar.*`). Empty = every calendar entity
   * (legacy default). Connectivity → Calendars settings writes this.
   */
  readonly selectedCalendarIds: () => ReadonlySet<string>
}

function isCalendarEntity(entityId: string): boolean {
  return entityId.startsWith('calendar.')
}

function calendarName(state: HaEntityState): string {
  const friendly = state.attributes['friendly_name']
  if (typeof friendly === 'string' && friendly.trim().length > 0) return friendly.trim()
  return state.entity_id.replace(/^calendar\./, '').replace(/_/g, ' ')
}

/** HA errors from `sendMessagePromise` are plain objects, not `Error`. */
export function formatHaError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const rec = err as Record<string, unknown>
    const message = rec['message']
    if (typeof message === 'string' && message.length > 0) {
      const code = rec['code']
      return typeof code === 'string' || typeof code === 'number'
        ? `${String(code)}: ${message}`
        : message
    }
    try {
      return JSON.stringify(err)
    } catch {
      return Object.prototype.toString.call(err)
    }
  }
  return String(err)
}

export function parseHaDate(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null
  // All-day: `YYYY-MM-DD` is a DATE, kept as UTC midnight whatever the hub's
  // timezone is (see the CalendarEvent time contract). Timed: ISO with `T`,
  // or HA's `YYYY-MM-DD HH:mm:ss`.
  const normalised =
    value.length === 10
      ? `${value}T00:00:00.000Z`
      : value.includes('T')
        ? value
        : value.replace(' ', 'T')
  const ms = Date.parse(normalised)
  return Number.isFinite(ms) ? ms : null
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function asEntityState(raw: unknown): HaEntityState | null {
  const parsed = HaEntityStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * HA's `calendar.get_events` response shape (return_response):
 * `{ response: { [entity_id]: { events: [...] } } }` — also tolerates a
 * bare `{ [entity_id]: { events } }` or a legacy flat `{ events: [...] }`.
 */
export function extractEvents(
  result: unknown,
  entityId: string,
): readonly Record<string, unknown>[] {
  if (!isRecord(result)) return []
  const response = isRecord(result['response']) ? result['response'] : result
  if (isRecord(response)) {
    const forEntity = response[entityId]
    if (isRecord(forEntity) && Array.isArray(forEntity['events'])) {
      return forEntity['events'].filter(isRecord)
    }
    // Multi-entity payload without a matching key — do not steal another
    // calendar's events; the caller iterates entity ids itself.
    if (entityId in response) return []
  }
  if (Array.isArray(result['events'])) {
    return result['events'].filter(isRecord)
  }
  return []
}

export function mapEvent(
  entityId: string,
  raw: Record<string, unknown>,
  index: number,
): CalendarEvent | null {
  const startRaw = raw['start']
  const endRaw = raw['end']
  const startMs = parseHaDate(
    isRecord(startRaw)
      ? (startRaw['dateTime'] ?? startRaw['date'])
      : (raw['start'] ?? raw['start_date_time'] ?? raw['dtstart']),
  )
  const endMs =
    parseHaDate(
      isRecord(endRaw)
        ? (endRaw['dateTime'] ?? endRaw['date'])
        : (raw['end'] ?? raw['end_date_time'] ?? raw['dtend']),
    ) ?? startMs
  if (startMs === null || endMs === null) return null
  const summary = raw['summary'] ?? raw['title']
  const title = typeof summary === 'string' ? summary : '(no title)'
  const uid = raw['uid'] ?? raw['id']
  const id =
    typeof uid === 'string' && uid.length > 0
      ? `${entityId}:${uid}`
      : `${entityId}:${String(startMs)}:${String(index)}`
  const description = raw['description']
  const location = raw['location']
  const allDay =
    (isRecord(startRaw) && typeof startRaw['date'] === 'string') ||
    (typeof raw['start'] === 'string' && (raw['start'] as string).length === 10)
  return {
    id,
    calendarId: entityId,
    title,
    startMs,
    endMs,
    ...(allDay ? { allDay: true } : {}),
    ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
    ...(typeof location === 'string' && location.length > 0 ? { location } : {}),
  }
}

/** One `get_events` call can target many calendars (HA keys the response). */
async function fetchEventsForEntities(
  manager: {
    publish: (target: PublishTargetHa, payload: unknown) => Promise<unknown>
  },
  entityIds: readonly string[],
  startIso: string,
  endIso: string,
): Promise<readonly CalendarEvent[]> {
  if (entityIds.length === 0) return []
  const target: PublishTargetHa = {
    domain: 'calendar',
    service: 'get_events',
    entityId: entityIds.length === 1 ? entityIds[0]! : entityIds,
    returnResponse: true,
  }
  const result = await manager.publish(target, {
    start_date_time: startIso,
    end_date_time: endIso,
  })
  const out: CalendarEvent[] = []
  for (const entityId of entityIds) {
    const rawEvents = extractEvents(result, entityId)
    for (let i = 0; i < rawEvents.length; i += 1) {
      const mapped = mapEvent(entityId, rawEvents[i]!, i)
      if (mapped !== null) out.push(mapped)
    }
  }
  return out
}

/** Empty selection = import nothing (operator must pick calendars explicitly). */
function isSelected(entityId: string, selected: ReadonlySet<string>): boolean {
  return selected.size > 0 && selected.has(entityId)
}

export function createHaCalendarSource(deps: HaCalendarSourceDeps): ICalendarSourceProvider {
  return {
    listCalendars: async (): Promise<readonly CalendarInfo[]> => {
      const selected = deps.selectedCalendarIds()
      const out: CalendarInfo[] = []
      for (const { manager } of deps.brokers.listManagers()) {
        const states = manager.snapshotAllStates()
        for (const [entityId, raw] of Object.entries(states)) {
          if (!isCalendarEntity(entityId)) continue
          if (!isSelected(entityId, selected)) continue
          const state = asEntityState(raw)
          if (state === null) continue
          out.push({
            id: entityId,
            name: calendarName(state),
            source: 'ha',
            enabled: state.state !== 'unavailable',
          })
        }
      }
      return out
    },

    listEvents: async (input: CalendarListEventsInput): Promise<readonly CalendarEvent[]> => {
      const startIso = new Date(input.startMs).toISOString()
      const endIso = new Date(input.endMs).toISOString()
      const selected = deps.selectedCalendarIds()
      const wanted =
        input.calendarIds !== undefined && input.calendarIds.length > 0
          ? new Set(input.calendarIds)
          : null

      const out: CalendarEvent[] = []
      for (const { brokerId, manager } of deps.brokers.listManagers()) {
        const states = manager.snapshotAllStates()
        const entityIds = Object.keys(states).filter((id) => {
          if (!isCalendarEntity(id)) return false
          if (!isSelected(id, selected)) return false
          return wanted === null || wanted.has(id)
        })
        if (entityIds.length === 0) continue
        try {
          const events = await fetchEventsForEntities(manager, entityIds, startIso, endIso)
          for (const ev of events) out.push(ev)
        } catch (err) {
          deps.logger.warn('HA calendar.get_events failed', {
            meta: {
              entityIds,
              brokerId,
              error: formatHaError(err),
            },
          })
        }
      }
      return out.toSorted((a, b) => a.startMs - b.startMs)
    },
  }
}

/** Discover every HA calendar entity (ignores the import filter) — for settings catalog. */
export function listHaCalendarCatalog(
  brokers: HaBrokerRegistry,
): readonly { readonly value: string; readonly label: string }[] {
  const out: { value: string; label: string }[] = []
  const seen = new Set<string>()
  for (const { manager } of brokers.listManagers()) {
    const states = manager.snapshotAllStates()
    for (const [entityId, raw] of Object.entries(states)) {
      if (!isCalendarEntity(entityId) || seen.has(entityId)) continue
      const state = asEntityState(raw)
      if (state === null) continue
      seen.add(entityId)
      out.push({ value: entityId, label: calendarName(state) })
    }
  }
  return out.toSorted((a, b) => a.label.localeCompare(b.label))
}
