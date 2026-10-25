/**
 * Map configured waste sources + cached Collection entries onto calendar-source.
 */
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarListEventsInput,
  ICalendarSourceProvider,
  IScopedLogger,
} from '@camstack/types'
import type { WasteCollectionEntry, WasteSourceConfig } from './waste-types.js'

export interface WasteCalendarSourceDeps {
  readonly logger: IScopedLogger
  readonly listConfigured: () => readonly WasteSourceConfig[]
  /** Cached entries keyed by source config id. */
  readonly getEntries: (sourceId: string) => readonly WasteCollectionEntry[]
}

function startOfUtcDayMs(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map((p) => Number(p))
  return Date.UTC(y!, m! - 1, d!)
}

function endOfUtcDayMs(isoDate: string): number {
  return startOfUtcDayMs(isoDate) + 24 * 60 * 60 * 1000
}

export function collectionsToEvents(
  sourceId: string,
  entries: readonly WasteCollectionEntry[],
  range: { readonly startMs: number; readonly endMs: number },
): readonly CalendarEvent[] {
  const out: CalendarEvent[] = []
  for (const e of entries) {
    const startMs = startOfUtcDayMs(e.date)
    const endMs = endOfUtcDayMs(e.date)
    if (endMs <= range.startMs || startMs >= range.endMs) continue
    out.push({
      id: `${sourceId}:${e.date}:${e.type}`,
      calendarId: sourceId,
      title: e.type,
      startMs,
      endMs,
      allDay: true,
      ...(e.description !== undefined ? { description: e.description } : {}),
      ...(e.location !== undefined ? { location: e.location } : {}),
    })
  }
  return out
}

export function createWasteCalendarSource(deps: WasteCalendarSourceDeps): ICalendarSourceProvider {
  return {
    listCalendars: async (): Promise<readonly CalendarInfo[]> => {
      return deps
        .listConfigured()
        .filter((s) => s.enabled)
        .map(
          (s): CalendarInfo => ({
            id: s.id,
            name: s.label,
            source: 'addon',
            enabled: true,
          }),
        )
    },
    listEvents: async (input: CalendarListEventsInput): Promise<readonly CalendarEvent[]> => {
      const wanted = input.calendarIds !== undefined ? new Set(input.calendarIds) : null
      const configured = deps.listConfigured().filter((s) => s.enabled)
      const out: CalendarEvent[] = []
      for (const s of configured) {
        if (wanted !== null && !wanted.has(s.id)) continue
        const entries = deps.getEntries(s.id)
        out.push(
          ...collectionsToEvents(s.id, entries, {
            startMs: input.startMs,
            endMs: input.endMs,
          }),
        )
      }
      return out
    },
  }
}
