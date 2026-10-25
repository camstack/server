import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import {
  CalendarEventSchema,
  CalendarInfoSchema,
  CalendarListEventsInputSchema,
  CalendarSourceKindSchema,
} from './calendar-source.cap.js'

/**
 * `calendars` — system-scoped singleton. Public surface admin-ui and the
 * notification-center calendar-events producer consume.
 *
 * Walks every `calendar-source` provider, stamps each calendar with a
 * cluster-stable id (`<sourceAddonId>:<localId>`) and the providing
 * addon's id, and fans `listEvents` out the same way.
 *
 * Per-user colour / visibility preferences live here (not on each source):
 * the system assigns a stable default colour from the calendar id; an
 * operator may override colour or hide a calendar via
 * {@link calendarsCapability.methods.setCalendarPreference}.
 */

/** `#RRGGBB` — the only colour form the UI and the palette emit. */
export const CalendarColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'expected #RRGGBB')
export type CalendarColor = z.infer<typeof CalendarColorSchema>

export const CalendarEntrySchema = CalendarInfoSchema.extend({
  /** Cluster-stable id: `<providerAddonId>:<localId>`. */
  id: z.string().min(1),
  /** The addon that registered the calendar-source provider. */
  providerAddonId: z.string().min(1).optional(),
  /** Deterministic system colour for this calendar id. */
  defaultColor: CalendarColorSchema,
  /**
   * Colour to paint in the UI. Equals {@link defaultColor} until the
   * caller overlays their preference (admin-ui merges `getPreferences`).
   */
  color: CalendarColorSchema,
  /**
   * Whether the UI should show this calendar. Defaults to `true`; the
   * caller overlays `getPreferences` for a per-user hide.
   */
  visible: z.boolean(),
})
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>

export const CalendarPreferenceEntrySchema = z.object({
  visible: z.boolean().optional(),
  /** Absent or cleared → fall back to the system {@link CalendarEntry.defaultColor}. */
  color: CalendarColorSchema.optional(),
})
export type CalendarPreferenceEntry = z.infer<typeof CalendarPreferenceEntrySchema>

export const CalendarPreferencesSchema = z.object({
  calendars: z.record(z.string(), CalendarPreferenceEntrySchema),
})
export type CalendarPreferences = z.infer<typeof CalendarPreferencesSchema>

export const CalendarSetPreferenceInputSchema = z.object({
  calendarId: z.string().min(1),
  visible: z.boolean().optional(),
  /**
   * Set a custom colour, or `null` to clear the override (back to
   * {@link CalendarEntry.defaultColor}). Omit to leave colour unchanged.
   */
  color: CalendarColorSchema.nullable().optional(),
})
export type CalendarSetPreferenceInput = z.infer<typeof CalendarSetPreferenceInputSchema>

export const calendarsCapability = {
  name: 'calendars',
  scope: 'system',
  mode: 'singleton',
  methods: {
    listCalendars: method(z.void(), z.array(CalendarEntrySchema).readonly(), {
      auth: 'admin',
    }),
    listEvents: method(CalendarListEventsInputSchema, z.array(CalendarEventSchema).readonly(), {
      auth: 'admin',
    }),
    getPreferences: method(z.object({}), CalendarPreferencesSchema, {
      auth: 'admin',
      caller: 'required',
    }),
    setCalendarPreference: method(CalendarSetPreferenceInputSchema, CalendarPreferencesSchema, {
      auth: 'admin',
      kind: 'mutation',
      caller: 'required',
    }),
  },
} as const satisfies CapabilityDefinition

export type ICalendarsProvider = InferProvider<typeof calendarsCapability>

export {
  CalendarEventSchema,
  CalendarInfoSchema,
  CalendarListEventsInputSchema,
  CalendarSourceKindSchema,
}
