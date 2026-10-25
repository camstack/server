/**
 * Record kinds owned by calendars (phase 4).
 */
import {
  CalendarPreferencesSchema,
  defineRecordKinds,
  type DefinedRecordKind,
} from '@camstack/types'
import { z } from 'zod'
import type { IsolatedRecordKinds } from '../records-isolated.js'

/** The legacy collection the kind replaced; read only without records. */
export const CALENDARS_USER_PREFS_COLLECTION = 'calendars:user-prefs'

export type CalendarUserPrefsBody = {
  readonly calendars: z.infer<typeof CalendarPreferencesSchema.shape.calendars>
  readonly updatedAt: number
}
const _calendarUserPrefsBody: z.ZodType<CalendarUserPrefsBody> = z.object({
  calendars: CalendarPreferencesSchema.shape.calendars,
  updatedAt: z.number(),
})
export const CalendarUserPrefsBodySchema: z.ZodType<CalendarUserPrefsBody> = _calendarUserPrefsBody

const _calendarsRecordKinds = defineRecordKinds({
  'user-prefs': {
    schema: CalendarUserPrefsBodySchema,
    class: 'config',
    writeTrigger: '`setCalendarPreference` upserts the caller user row',
    device: 'none',
    at: 'none',
    indexes: [{ name: 'updated_at', fields: ['updatedAt'] }],
    retention: {
      none: 'a missing row reads as empty prefs (all visible, system colours)',
    },
  },
}) satisfies IsolatedRecordKinds

export type CalendarsRecordKindsMap = {
  readonly 'user-prefs': DefinedRecordKind<z.ZodType<CalendarUserPrefsBody>>
}

export const calendarsRecordKinds: CalendarsRecordKindsMap = _calendarsRecordKinds

/** Narrow kind for `records.kind()`. */
export const calendarUserPrefsRecordKind: DefinedRecordKind<z.ZodType<CalendarUserPrefsBody>> =
  _calendarsRecordKinds['user-prefs']
