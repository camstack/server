/**
 * Hub calendars aggregator — walks `calendar-source` providers and stamps
 * cluster-stable ids (`<providerAddonId>:<localId>`). Owns per-user UI
 * preferences (colour / visibility) via `calendars:user-prefs`.
 */

import {
  BaseAddon,
  calendarsCapability,
  type CalendarEntry,
  type CalendarEvent,
  type CalendarListEventsInput,
  type CalendarPreferences,
  type CapCaller,
  type ICalendarSourceProvider,
  type ICalendarsProvider,
  type ProviderRegistration,
} from '@camstack/types'
import { settleSourcesWithTimeout } from '../shared/settle-sources.js'
import { defaultCalendarColor } from './calendar-color.js'
import { CalendarPrefsStore, patchCalendarPreference } from './calendar-prefs-store.js'
import { calendarsRecordKinds } from './record-kinds.js'

/** Listing calendars is a cache walk; listing events hits HA once per broker. */
const PER_SOURCE_TIMEOUT_MS = 8_000

function stampId(providerAddonId: string, localId: string): string {
  return `${providerAddonId}:${localId}`
}

function localIdOf(stamped: string, providerAddonId: string): string | null {
  const prefix = `${providerAddonId}:`
  if (!stamped.startsWith(prefix)) return null
  return stamped.slice(prefix.length)
}

function withSystemColors(
  entry: Omit<CalendarEntry, 'defaultColor' | 'color' | 'visible'>,
): CalendarEntry {
  const defaultColor = defaultCalendarColor(entry.id)
  return {
    ...entry,
    defaultColor,
    color: defaultColor,
    visible: true,
  }
}

export class CalendarsAddon extends BaseAddon {
  readonly id = 'calendars'
  private prefsStore: CalendarPrefsStore | null = null

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('calendars needs ctx.records on the hub')
    }
    await records.declare(calendarsRecordKinds)
    this.prefsStore = CalendarPrefsStore.of(records)
    const provider: ICalendarsProvider = {
      listCalendars: async () => this.listCalendars(),
      listEvents: async (input) => this.listEvents(input),
      getPreferences: async ({ caller }) => this.getPreferences(caller),
      setCalendarPreference: async ({ caller, calendarId, visible, color }) =>
        this.setCalendarPreference(caller, { calendarId, visible, color }),
    }
    this.ctx.logger.info('Initialized — aggregating calendar-source providers')
    return [{ capability: calendarsCapability, provider }]
  }

  private prefs(): CalendarPrefsStore {
    if (this.prefsStore === null) {
      throw new Error('calendars prefs store not initialized')
    }
    return this.prefsStore
  }

  private sources(): readonly {
    readonly id: string
    readonly provider: ICalendarSourceProvider
  }[] {
    const entries =
      this.capabilities?.getCollectionEntries<ICalendarSourceProvider>('calendar-source') ?? []
    return entries.map(([id, provider]) => ({ id, provider }))
  }

  private async listCalendars(): Promise<readonly CalendarEntry[]> {
    const sources = this.sources()
    const settled = await settleSourcesWithTimeout<CalendarEntry>(
      sources.map(
        (s) =>
          [
            s.id,
            async (): Promise<readonly CalendarEntry[]> => {
              const list = await s.provider.listCalendars()
              return list.map((cal) =>
                withSystemColors({
                  ...cal,
                  id: stampId(s.id, cal.id),
                  providerAddonId: s.id,
                }),
              )
            },
          ] as const,
      ),
      PER_SOURCE_TIMEOUT_MS,
    )
    const out: CalendarEntry[] = []
    for (const [sourceId, result] of settled) {
      if (result.ok) {
        for (const entry of result.value) out.push(entry)
      } else {
        this.ctx.logger.warn('calendar-source provider failed', {
          meta: { sourceId, error: result.error.message },
        })
      }
    }
    return out
  }

  private async listEvents(input: CalendarListEventsInput): Promise<readonly CalendarEvent[]> {
    const sources = this.sources()
    const wanted = input.calendarIds !== undefined ? new Set(input.calendarIds) : null
    const settled = await settleSourcesWithTimeout<CalendarEvent>(
      sources.map((s) => {
        const localIds: readonly string[] | undefined =
          wanted === null
            ? undefined
            : [...wanted].map((id) => localIdOf(id, s.id)).filter((id): id is string => id !== null)
        return [
          s.id,
          async (): Promise<readonly CalendarEvent[]> => {
            if (wanted !== null && localIds !== undefined && localIds.length === 0) {
              return []
            }
            const events = await s.provider.listEvents({
              startMs: input.startMs,
              endMs: input.endMs,
              ...(localIds !== undefined ? { calendarIds: [...localIds] } : {}),
            })
            return events.map(
              (ev): CalendarEvent => ({
                ...ev,
                calendarId: stampId(s.id, ev.calendarId),
                id: stampId(s.id, ev.id),
              }),
            )
          },
        ] as const
      }),
      PER_SOURCE_TIMEOUT_MS,
    )
    const out: CalendarEvent[] = []
    for (const [sourceId, result] of settled) {
      if (result.ok) {
        for (const ev of result.value) out.push(ev)
      } else {
        this.ctx.logger.warn('calendar-source listEvents failed', {
          meta: { sourceId, error: result.error.message },
        })
      }
    }
    return out.toSorted((a, b) => a.startMs - b.startMs)
  }

  private async getPreferences(caller: CapCaller): Promise<CalendarPreferences> {
    return this.prefs().load(caller.userId)
  }

  private async setCalendarPreference(
    caller: CapCaller,
    patch: {
      readonly calendarId: string
      readonly visible?: boolean
      readonly color?: string | null
    },
  ): Promise<CalendarPreferences> {
    const store = this.prefs()
    const current = await store.load(caller.userId)
    const next = patchCalendarPreference(current, patch.calendarId, {
      visible: patch.visible,
      color: patch.color,
    })
    await store.save(caller.userId, next, Date.now())
    return next
  }
}

export default CalendarsAddon
