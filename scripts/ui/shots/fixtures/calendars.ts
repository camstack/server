/**
 * System → Calendars (`/system/calendars`): one calendar with the three event
 * shapes the all-day contract has to keep apart — a single all-day event, a
 * three-day all-day run, and a timed event that crosses midnight. All-day
 * events are UTC dates with an exclusive end, exactly as the providers emit.
 */
import { defineFixtures } from './_define'

const CAL = 'ha:calendar.family'
const HOUR = 3_600_000

export default defineFixtures({
  area: 'calendars',
  description: 'Calendars page: all-day single, all-day multi-day, timed across midnight',
  handlers: {
    'calendars.listCalendars': [
      {
        id: CAL,
        name: 'Family',
        source: 'ha',
        enabled: true,
        visible: true,
        defaultColor: '#3B82F6',
        color: '#3B82F6',
      },
    ],
    'addons.listCapabilityProviders': (i: { capName: string }) =>
      i.capName === 'calendar-source' || i.capName === 'integration-instances'
        ? [{ addonId: 'google-services', capName: i.capName, isActive: true }]
        : [],
    'integrationInstances.describe': {
      role: 'services',
      instanceMode: 'multiple',
      kind: 'calendar',
      canTest: false,
      kinds: [
        {
          id: 'calendar',
          label: 'Google calendar',
          functionCap: 'calendar-source',
          role: 'services',
        },
      ],
    },
    'integrationInstances.listInstances': [
      {
        id: 'cal_a1',
        name: 'Family',
        configured: true,
        enabled: true,
        kind: 'calendar',
        formValues: {},
      },
      {
        id: 'cal_b2',
        name: 'Work',
        configured: true,
        enabled: false,
        kind: 'calendar',
        formValues: {},
      },
    ],
    'mut:integrationInstances.setInstanceEnabled': { ok: true },
    'calendars.getPreferences': { calendars: {} },
    'calendars.listEvents': [
      {
        id: `${CAL}:single`,
        calendarId: CAL,
        title: 'Waste: paper',
        startMs: Date.UTC(2026, 9, 15),
        endMs: Date.UTC(2026, 9, 16),
        allDay: true,
      },
      {
        id: `${CAL}:trip`,
        calendarId: CAL,
        title: 'Trip to Lisbon',
        startMs: Date.UTC(2026, 9, 20),
        endMs: Date.UTC(2026, 9, 23),
        allDay: true,
      },
      {
        id: `${CAL}:night`,
        calendarId: CAL,
        title: 'Night shift',
        startMs: new Date(2026, 9, 27, 22, 0).getTime(),
        endMs: new Date(2026, 9, 27, 22, 0).getTime() + 8 * HOUR,
      },
    ],
  },
})
