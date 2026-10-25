/**
 * Calendar-events — query key + editor entry for the unified Rules table.
 * The list itself lives on NotificationRules (one table for every kind).
 */

export {
  CALENDAR_EVENTS_QUERY_KEY,
  NC_LIST_CALENDAR_EVENTS_RULES_ACTION,
  parseCalendarEventsRules,
  type CalendarEventsRuleView,
} from './notification-calendar-events.helpers'
export { NotificationCalendarEventsEditor } from './NotificationCalendarEventsEditor'
export { NotificationCalendarEventsPage } from './NotificationCalendarEventsPage'
