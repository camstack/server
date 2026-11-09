/**
 * Google Calendar API → calendar-source mapping (aggregates N Google brokers).
 */
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarListEventsInput,
  ICalendarSourceProvider,
  IScopedLogger,
} from '@camstack/types'
import { parseStampedCalendarId, stampCalendarId } from './google-broker-registry.js'
import { GOOGLE_CALENDAR_API } from './google-types.js'

export interface GoogleCalendarApi {
  readonly listCalendars: () => Promise<readonly GoogleCalendarListEntry[]>
  readonly listEvents: (input: {
    readonly calendarId: string
    readonly timeMin: string
    readonly timeMax: string
  }) => Promise<readonly GoogleEventEntry[]>
}

export interface GoogleCalendarListEntry {
  readonly id: string
  readonly summary: string
  readonly selected?: boolean
  readonly accessRole?: string
}

export interface GoogleEventEntry {
  readonly id: string
  readonly summary?: string
  readonly description?: string
  readonly location?: string
  readonly start?: { readonly date?: string; readonly dateTime?: string }
  readonly end?: { readonly date?: string; readonly dateTime?: string }
}

export interface GoogleCalendarAccountView {
  readonly brokerId: string
  readonly connected: boolean
  readonly api: GoogleCalendarApi
}

export interface GoogleCalendarSourceDeps {
  readonly logger: IScopedLogger
  readonly accounts: () => readonly GoogleCalendarAccountView[]
  /**
   * The stamped ids (`brokerId:googleCalendarId`) ONE broker imports, each mapped to the id of
   * the calendar record that imports it: a value of that broker, never of the addon. Empty =
   * import none.
   */
  readonly selectedCalendarIds: (brokerId: string) => ReadonlyMap<string, string>
}

export function parseGoogleInstant(value: string): number | null {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** All-day Google `date` is YYYY-MM-DD (exclusive end). */
export function mapGoogleEvent(calendarId: string, ev: GoogleEventEntry): CalendarEvent | null {
  const startDate = ev.start?.date
  const endDate = ev.end?.date
  const startDt = ev.start?.dateTime
  const endDt = ev.end?.dateTime
  let startMs: number | null = null
  let endMs: number | null = null
  let allDay = false
  if (startDate !== undefined && endDate !== undefined) {
    startMs = Date.parse(`${startDate}T00:00:00.000Z`)
    endMs = Date.parse(`${endDate}T00:00:00.000Z`)
    allDay = true
  } else if (startDt !== undefined && endDt !== undefined) {
    startMs = parseGoogleInstant(startDt)
    endMs = parseGoogleInstant(endDt)
  }
  if (startMs === null || endMs === null || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null
  }
  return {
    id: ev.id,
    calendarId,
    title: ev.summary ?? '(untitled)',
    startMs,
    endMs,
    allDay,
    ...(ev.description !== undefined ? { description: ev.description } : {}),
    ...(ev.location !== undefined ? { location: ev.location } : {}),
  }
}

export function createGoogleCalendarApi(
  getAccessToken: () => Promise<string>,
  http: { fetch: typeof fetch } = { fetch },
): GoogleCalendarApi {
  async function authedGet(url: string): Promise<unknown> {
    const token = await getAccessToken()
    const res = await http.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Google Calendar API ${res.status}: ${text.slice(0, 400)}`)
    }
    return res.json()
  }

  return {
    listCalendars: async () => {
      const raw = (await authedGet(
        `${GOOGLE_CALENDAR_API}/users/me/calendarList?maxResults=250`,
      )) as { items?: GoogleCalendarListEntry[] }
      return raw.items ?? []
    },
    listEvents: async ({ calendarId, timeMin, timeMax }) => {
      const u = new URL(`${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`)
      u.searchParams.set('singleEvents', 'true')
      u.searchParams.set('orderBy', 'startTime')
      u.searchParams.set('timeMin', timeMin)
      u.searchParams.set('timeMax', timeMax)
      u.searchParams.set('maxResults', '2500')
      const raw = (await authedGet(u.toString())) as { items?: GoogleEventEntry[] }
      return raw.items ?? []
    },
  }
}

export function createGoogleCalendarSource(
  deps: GoogleCalendarSourceDeps,
): ICalendarSourceProvider {
  return {
    listCalendars: async (): Promise<readonly CalendarInfo[]> => {
      const out: CalendarInfo[] = []
      for (const account of deps.accounts()) {
        if (!account.connected) continue
        const selected = deps.selectedCalendarIds(account.brokerId)
        if (selected.size === 0) continue
        try {
          const list = await account.api.listCalendars()
          for (const c of list) {
            const stamped = stampCalendarId(account.brokerId, c.id)
            const instanceId = selected.get(stamped)
            if (instanceId === undefined) continue
            out.push({
              id: stamped,
              instanceId,
              name: c.summary,
              source: 'addon',
              enabled: true,
            })
          }
        } catch (err) {
          deps.logger.warn('google calendar listCalendars failed', {
            meta: {
              brokerId: account.brokerId,
              error: err instanceof Error ? err.message : String(err),
            },
          })
        }
      }
      return out
    },
    listEvents: async (input: CalendarListEventsInput): Promise<readonly CalendarEvent[]> => {
      const timeMin = new Date(input.startMs).toISOString()
      const timeMax = new Date(input.endMs).toISOString()
      const accounts = deps.accounts().filter((a) => a.connected)
      const byBroker = new Map(accounts.map((a) => [a.brokerId, a]))

      const requestIds =
        input.calendarIds !== undefined && input.calendarIds.length > 0
          ? input.calendarIds
          : [
              ...new Set(
                deps
                  .accounts()
                  .flatMap((account) =>
                    [...deps.selectedCalendarIds(account.brokerId).keys()].filter(
                      (stamped) => parseStampedCalendarId(stamped)?.brokerId === account.brokerId,
                    ),
                  ),
              ),
            ]

      /** brokerId → google calendar ids to fetch */
      const wanted = new Map<string, string[]>()
      for (const stamped of requestIds) {
        const parsed = parseStampedCalendarId(stamped)
        if (parsed === null) continue
        if (!byBroker.has(parsed.brokerId)) continue
        if (!deps.selectedCalendarIds(parsed.brokerId).has(stamped)) continue
        const list = wanted.get(parsed.brokerId) ?? []
        list.push(parsed.googleCalendarId)
        wanted.set(parsed.brokerId, list)
      }

      const out: CalendarEvent[] = []
      for (const [brokerId, googleIds] of wanted) {
        const account = byBroker.get(brokerId)
        if (account === undefined) continue
        for (const googleCalendarId of googleIds) {
          const stampedId = stampCalendarId(brokerId, googleCalendarId)
          try {
            const events = await account.api.listEvents({
              calendarId: googleCalendarId,
              timeMin,
              timeMax,
            })
            for (const ev of events) {
              const mapped = mapGoogleEvent(stampedId, ev)
              if (mapped) out.push(mapped)
            }
          } catch (err) {
            deps.logger.warn('google calendar listEvents failed', {
              meta: {
                brokerId,
                calendarId: googleCalendarId,
                error: err instanceof Error ? err.message : String(err),
              },
            })
          }
        }
      }
      return out
    },
  }
}
