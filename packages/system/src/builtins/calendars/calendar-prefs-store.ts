/**
 * Per-user calendar UI preferences (colour override + visibility).
 *
 * One row per `userId`. The calendars builtin owns read/write via records;
 * the browser never talks to `settingsStore` directly.
 */

import {
  CalendarPreferencesSchema,
  type CalendarPreferenceEntry,
  type CalendarPreferences,
  type RecordKindHandle,
  type RecordsAccess,
} from '@camstack/types'
import { z } from 'zod'
import { calendarsRecordKinds, CalendarUserPrefsBodySchema } from './record-kinds.js'

/**
 * @durable class=config owner=calendars
 *   write="`setCalendarPreference` upserts the caller's row"
 *   retention="none — a missing row reads as empty prefs (all visible,
 *     system colours). Losing the table silently resets every operator's
 *     colour/hide choices."
 */
export const CALENDARS_USER_PREFS_COLLECTION = 'calendars:user-prefs'

type PrefsBody = z.infer<typeof CalendarUserPrefsBodySchema>

const StoredRowSchema = z.object({
  calendars: z.record(z.string(), z.unknown()),
  updatedAt: z.number(),
})

export class CalendarPrefsStore {
  constructor(private readonly kind: RecordKindHandle<PrefsBody>) {}

  static of(records: Pick<RecordsAccess, 'kind'>): CalendarPrefsStore {
    return new CalendarPrefsStore(records.kind(calendarsRecordKinds['user-prefs']))
  }

  async load(userId: string): Promise<CalendarPreferences> {
    const row = await this.kind.get(userId)
    if (row === null) return { calendars: {} }
    const parsed = StoredRowSchema.safeParse(row.data)
    if (!parsed.success) return { calendars: {} }
    const prefs = CalendarPreferencesSchema.safeParse({ calendars: parsed.data.calendars })
    return prefs.success ? prefs.data : { calendars: {} }
  }

  async save(userId: string, prefs: CalendarPreferences, nowMs: number): Promise<void> {
    const body: PrefsBody = { calendars: prefs.calendars, updatedAt: nowMs }
    const parsed = calendarsRecordKinds['user-prefs'].schema.safeParse(body)
    if (!parsed.success) return
    await this.kind.put({ id: userId, data: parsed.data })
  }
}

/**
 * Patch one calendar's preference entry. `color: null` clears the override;
 * omitting a field leaves it unchanged. An entry that becomes empty is dropped.
 */
export function patchCalendarPreference(
  current: CalendarPreferences,
  calendarId: string,
  patch: {
    readonly visible?: boolean
    readonly color?: string | null
  },
): CalendarPreferences {
  const existing: CalendarPreferenceEntry = current.calendars[calendarId] ?? {}
  const next: CalendarPreferenceEntry = { ...existing }
  if (patch.visible !== undefined) next.visible = patch.visible
  if (patch.color === null) {
    delete next.color
  } else if (patch.color !== undefined) {
    next.color = patch.color
  }
  const calendars = { ...current.calendars }
  if (next.visible === undefined && next.color === undefined) {
    delete calendars[calendarId]
  } else {
    calendars[calendarId] = next
  }
  return { calendars }
}
