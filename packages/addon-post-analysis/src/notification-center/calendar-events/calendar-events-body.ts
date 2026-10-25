/**
 * Plain-text body for a calendar-events digest.
 *
 * Layout: tomorrow's events first (highlighted), then a delimiter, then
 * every other day in the horizon (today included, chronologically). Words
 * and weekday/month labels come from {@link NcTextCatalog} — the SAME
 * language the rest of the notification centre speaks.
 */

import { calendarEventLocalSpan, type CalendarEvent } from '@camstack/types'
import { ncClockText } from '../clock-text.js'
import type { NcTextCatalog } from '../text-catalog.js'

/** Visual weight on the tomorrow header — Telegram/Zentik plain text. */
export const CALENDAR_EVENTS_TOMORROW_MARK = '★'

/** Separates the tomorrow block from the rest of the horizon. */
export const CALENDAR_EVENTS_DAY_DELIMITER = '────────'

const MAX_EVENT_LINES = 40

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local calendar day key `YYYY-MM-DD`. */
export function localDayKey(atMs: number): string {
  const d = new Date(atMs)
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function startOfLocalDay(atMs: number): number {
  const d = new Date(atMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function addLocalDays(atMs: number, days: number): number {
  const d = new Date(atMs)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

function dayDateLabel(texts: NcTextCatalog, dayStartMs: number): string {
  return new Intl.DateTimeFormat(texts.language, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(dayStartMs))
}

function dayHeadingFor(
  texts: NcTextCatalog,
  dayStartMs: number,
  todayKey: string,
  tomorrowKey: string,
): string {
  const key = localDayKey(dayStartMs)
  const date = dayDateLabel(texts, dayStartMs)
  if (key === todayKey) return texts.text({ key: 'calendar-events.day.today', vars: { date } })
  if (key === tomorrowKey) {
    return texts.text({ key: 'calendar-events.day.tomorrow', vars: { date } })
  }
  return texts.text({ key: 'calendar-events.day.other', vars: { date } })
}

function formatEventLine(texts: NcTextCatalog, event: CalendarEvent): string {
  const where =
    event.location !== undefined && event.location.length > 0
      ? texts.text({
          key: 'calendar-events.where',
          vars: { location: event.location },
        })
      : ''
  if (event.allDay === true) {
    return texts.text({
      key: 'calendar-events.line.allDay',
      vars: { title: event.title, where },
    })
  }
  const when = `${ncClockText(texts.language, event.startMs)}–${ncClockText(texts.language, event.endMs)}`
  return texts.text({
    key: 'calendar-events.line.timed',
    vars: { when, title: event.title, where },
  })
}

interface DayBucket {
  readonly dayKey: string
  readonly dayStartMs: number
  readonly events: CalendarEvent[]
}

function groupByLocalDay(events: readonly CalendarEvent[]): readonly DayBucket[] {
  const map = new Map<string, DayBucket>()
  for (const ev of events) {
    const firstMs = calendarEventLocalSpan(ev).startMs
    const dayKey = localDayKey(firstMs)
    const existing = map.get(dayKey)
    if (existing !== undefined) {
      existing.events.push(ev)
      continue
    }
    map.set(dayKey, {
      dayKey,
      dayStartMs: startOfLocalDay(firstMs),
      events: [ev],
    })
  }
  return [...map.values()].toSorted((a, b) => a.dayStartMs - b.dayStartMs)
}

/**
 * Build the digest body.
 *
 * @param nowMs — fire time; tomorrow is the local calendar day after this.
 */
export function formatCalendarEventsBody(
  texts: NcTextCatalog,
  events: readonly CalendarEvent[],
  nowMs: number,
  horizonDays: number,
): string {
  if (events.length === 0) {
    return texts.text({
      key: 'calendar-events.empty',
      vars: { horizonDays: String(horizonDays) },
    })
  }

  const todayKey = localDayKey(nowMs)
  const tomorrowKey = localDayKey(addLocalDays(startOfLocalDay(nowMs), 1))
  const buckets = groupByLocalDay(events)

  const today = buckets.filter((b) => b.dayKey === todayKey)
  const tomorrow = buckets.filter((b) => b.dayKey === tomorrowKey)
  const later = buckets.filter((b) => b.dayKey !== todayKey && b.dayKey !== tomorrowKey)
  const lead = [...today, ...tomorrow]

  const lines: string[] = []
  let emitted = 0

  const pushBucket = (bucket: DayBucket): void => {
    if (emitted >= MAX_EVENT_LINES) return
    lines.push(dayHeadingFor(texts, bucket.dayStartMs, todayKey, tomorrowKey))
    for (const ev of bucket.events) {
      if (emitted >= MAX_EVENT_LINES) break
      lines.push(formatEventLine(texts, ev))
      emitted += 1
    }
  }

  // Lead: today (if any) then tomorrow ★. Delimiter then subsequent days.
  for (const bucket of lead) pushBucket(bucket)

  if (lead.length > 0 && later.length > 0) {
    lines.push(CALENDAR_EVENTS_DAY_DELIMITER)
  }

  for (const bucket of later) pushBucket(bucket)

  if (events.length > MAX_EVENT_LINES) {
    lines.push(
      texts.text({
        key: 'calendar-events.more',
        vars: { count: String(events.length - MAX_EVENT_LINES) },
      }),
    )
  }

  return lines.join('\n')
}
