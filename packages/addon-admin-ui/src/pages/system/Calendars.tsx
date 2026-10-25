/**
 * Admin Calendars page — legend (visibility + colour) and Month / Week / Day
 * views over `calendars.listEvents`. Preferences merge client-side from
 * `getPreferences`; sources come from calendar-source addons (no HA import).
 */

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useCalendarsGetPreferences,
  useCalendarsListCalendars,
  useCalendarsListEvents,
  useCalendarsSetCalendarPreference,
} from '@camstack/ui-library'
import {
  calendarEventLocalSpan,
  calendarEventOnLocalDay,
  type CalendarEntry,
  type CalendarEvent,
  type CalendarPreferences,
} from '@camstack/types'
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import { Trans, useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

type ViewMode = 'month' | 'week' | 'day'

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d)
  next.setDate(next.getDate() + n)
  return next
}

/** ISO week — Monday start. */
function startOfWeek(d: Date): Date {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return startOfDay(addDays(d, diff))
}

function visibleWindow(anchor: Date, mode: ViewMode): { startMs: number; endMs: number } {
  if (mode === 'day') {
    const start = startOfDay(anchor)
    return { startMs: start.getTime(), endMs: addDays(start, 1).getTime() }
  }
  if (mode === 'week') {
    const start = startOfWeek(anchor)
    return { startMs: start.getTime(), endMs: addDays(start, 7).getTime() }
  }
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
  const start = startOfWeek(first)
  const end = addDays(startOfWeek(last), 7)
  return { startMs: start.getTime(), endMs: end.getTime() }
}

function periodLabel(anchor: Date, mode: ViewMode): string {
  if (mode === 'day') {
    return anchor.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }
  if (mode === 'week') {
    const start = startOfWeek(anchor)
    const end = addDays(start, 6)
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
    return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, {
      ...opts,
      year: 'numeric',
    })}`
  }
  return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function shiftAnchor(anchor: Date, mode: ViewMode, delta: number): Date {
  if (mode === 'day') return addDays(anchor, delta)
  if (mode === 'week') return addDays(anchor, delta * 7)
  return new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1)
}

function mergeCalendar(cal: CalendarEntry, prefs: CalendarPreferences | undefined): CalendarEntry {
  if (prefs === undefined) return cal
  const pref = prefs.calendars[cal.id]
  if (pref === undefined) return cal
  return {
    ...cal,
    visible: pref.visible ?? cal.visible,
    color: pref.color ?? cal.defaultColor,
  }
}

function providerLabel(cal: CalendarEntry): string {
  if (cal.providerAddonId !== undefined && cal.providerAddonId.length > 0) {
    return cal.providerAddonId
  }
  return cal.source === 'ha' ? 'Home Assistant' : cal.source // i18n-ignore: product name
}

function formatEventTime(ev: CalendarEvent): string {
  if (ev.allDay === true) return i18n.t('systemPage.calendars.allDay')
  const start = new Date(ev.startMs)
  const end = new Date(ev.endMs)
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  return `${start.toLocaleTimeString([], opts)} – ${end.toLocaleTimeString([], opts)}`
}

function formatEventWhen(ev: CalendarEvent): string {
  const span = calendarEventLocalSpan(ev)
  const start = new Date(span.startMs)
  const end = new Date(span.endMs)
  const dateOpts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }
  if (ev.allDay === true) {
    const startDay = startOfDay(start)
    const endExclusive = startOfDay(end)
    const lastDay = addDays(endExclusive, -1)
    if (isSameDay(startDay, lastDay)) {
      return i18n.t('systemPage.calendars.dayAllDay', {
        date: start.toLocaleDateString(undefined, dateOpts),
      })
    }
    return i18n.t('systemPage.calendars.rangeAllDay', {
      from: start.toLocaleDateString(undefined, dateOpts),
      to: lastDay.toLocaleDateString(undefined, dateOpts),
    })
  }
  const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }
  if (isSameDay(start, end)) {
    return `${start.toLocaleDateString(undefined, dateOpts)} · ${start.toLocaleTimeString([], timeOpts)} – ${end.toLocaleTimeString([], timeOpts)}`
  }
  return `${start.toLocaleString(undefined, { ...dateOpts, ...timeOpts })} – ${end.toLocaleString(undefined, { ...dateOpts, ...timeOpts })}`
}

function DetailRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
      <dt className="text-foreground-subtle">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  )
}

function EventDetailDialog({
  ev,
  calendarName,
  color,
  onClose,
}: {
  readonly ev: CalendarEvent
  readonly calendarName: string
  readonly color: string
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        width="md"
        placement="sheet-on-mobile"
        scroll="body"
        data-testid="calendars-event-detail"
      >
        <DialogHeader>
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              className="mt-1.5 h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: color }}
              aria-hidden
            />
            <DialogTitle className="min-w-0 break-words">{ev.title}</DialogTitle>
          </div>
        </DialogHeader>
        <DialogBody>
          <dl className="space-y-3">
            <DetailRow label={t('systemPage.calendars.when', 'When')}>
              {formatEventWhen(ev)}
            </DetailRow>
            <DetailRow label={t('systemPage.calendars.calendar', 'Calendar')}>
              {calendarName}
            </DetailRow>
            {ev.location !== undefined && ev.location.length > 0 ? (
              <DetailRow label={t('systemPage.calendars.location', 'Location')}>
                {ev.location}
              </DetailRow>
            ) : null}
            {ev.description !== undefined && ev.description.length > 0 ? (
              <DetailRow label={t('systemPage.calendars.description', 'Description')}>
                <span className="whitespace-pre-wrap">{ev.description}</span>
              </DetailRow>
            ) : null}
          </dl>
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function eventsOnDay(
  events: readonly CalendarEvent[],
  dayStartMs: number,
): readonly CalendarEvent[] {
  return events.filter((ev) => calendarEventOnLocalDay(ev, dayStartMs))
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function ViewToggle({
  mode,
  onChange,
}: {
  readonly mode: ViewMode
  readonly onChange: (mode: ViewMode) => void
}) {
  const { t } = useTranslation()
  const modes: readonly { readonly id: ViewMode; readonly label: string }[] = [
    { id: 'month', label: t('systemPage.calendars.month', 'Month') },
    { id: 'week', label: t('systemPage.calendars.week', 'Week') },
    { id: 'day', label: t('systemPage.calendars.day', 'Day') },
  ]
  return (
    <div
      className="inline-flex rounded-lg border border-border bg-surface p-0.5"
      role="group"
      aria-label={t('systemPage.calendars.calendarView', 'Calendar view')}
    >
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          className={
            mode === m.id
              ? 'rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground'
              : 'rounded-md px-2.5 py-1 text-xs font-medium text-foreground-subtle hover:text-foreground'
          }
          aria-pressed={mode === m.id}
          onClick={() => onChange(m.id)}
          data-testid={`calendars-view-${m.id}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

function CalendarLegend({
  calendars,
  onToggleVisible,
  onColorChange,
  busy,
}: {
  readonly calendars: readonly CalendarEntry[]
  readonly onToggleVisible: (calendarId: string, visible: boolean) => void
  readonly onColorChange: (calendarId: string, color: string) => void
  readonly busy: boolean
}) {
  const { t } = useTranslation()
  return (
    <aside className="w-full shrink-0 space-y-2 lg:w-56 xl:w-64" data-testid="calendars-legend">
      <h2 className="text-xs font-medium text-foreground-subtle">
        {t('systemPage.calendars.calendars', 'Calendars')}
      </h2>
      <ul className="space-y-1">
        {calendars.map((cal) => (
          <li
            key={cal.id}
            className="flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface"
          >
            <input
              type="checkbox"
              className="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
              checked={cal.visible}
              disabled={busy}
              onChange={(e) => onToggleVisible(cal.id, e.target.checked)}
              aria-label={t('systemPage.calendars.show', 'Show {{name}}', { name: cal.name })}
              data-testid={`calendars-visible-${cal.id}`}
            />
            <input
              type="color"
              className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
              value={cal.color}
              disabled={busy}
              onChange={(e) => onColorChange(cal.id, e.target.value.toUpperCase())}
              aria-label={t('systemPage.calendars.colourFor', 'Colour for {{name}}', {
                name: cal.name,
              })}
              data-testid={`calendars-color-${cal.id}`}
            />
            <div className="min-w-0 flex-1">
              <div
                className={`truncate text-sm font-medium ${cal.visible ? 'text-foreground' : 'text-foreground-subtle'}`}
              >
                {cal.name}
              </div>
              <div className="truncate text-[11px] text-foreground-subtle">
                {providerLabel(cal)}
                {!cal.enabled ? ` · ${t('systemPage.calendars.unavailableAtSource')}` : ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}

function EventChip({
  ev,
  color,
  compact,
  onSelect,
}: {
  readonly ev: CalendarEvent
  readonly color: string
  readonly compact?: boolean
  readonly onSelect: (ev: CalendarEvent) => void
}) {
  return (
    <button
      type="button"
      className={
        compact
          ? 'block w-full truncate rounded px-1 py-0.5 text-left text-[10px] leading-tight text-white hover:brightness-110'
          : 'block w-full rounded-md px-2 py-1.5 text-left text-xs text-white hover:brightness-110'
      }
      style={{ backgroundColor: color }}
      title={ev.title}
      onClick={() => onSelect(ev)}
      data-testid={`calendars-event-${ev.id}`}
    >
      {compact ? (
        ev.title
      ) : (
        <>
          <div className="font-medium">{ev.title}</div>
          <div className="opacity-90">{formatEventTime(ev)}</div>
        </>
      )}
    </button>
  )
}

function MonthGrid({
  anchor,
  events,
  colorById,
  today,
  onSelectEvent,
}: {
  readonly anchor: Date
  readonly events: readonly CalendarEvent[]
  readonly colorById: ReadonlyMap<string, string>
  readonly today: Date
  readonly onSelectEvent: (ev: CalendarEvent) => void
}) {
  const { t } = useTranslation()
  const { startMs, endMs } = visibleWindow(anchor, 'month')
  const days: Date[] = []
  for (let day = new Date(startMs); day.getTime() < endMs; day = addDays(day, 1)) {
    days.push(day)
  }
  const inMonth = anchor.getMonth()

  return (
    <div data-testid="calendars-month">
      <div className="mb-1 grid grid-cols-7 gap-px">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="px-1 py-1 text-center text-[11px] font-medium text-foreground-subtle"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {days.map((day) => {
          const dayStart = startOfDay(day).getTime()
          const dayEvents = eventsOnDay(events, dayStart)
          const muted = day.getMonth() !== inMonth
          const isToday = isSameDay(day, today)
          return (
            <div
              key={dayStart}
              className={`min-h-[5.5rem] bg-background p-1 ${muted ? 'opacity-45' : ''}`}
            >
              <div
                className={
                  isToday
                    ? 'mb-1 inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground'
                    : 'mb-1 text-[11px] font-medium text-foreground-subtle'
                }
              >
                {day.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((ev) => (
                  <EventChip
                    key={ev.id}
                    ev={ev}
                    color={colorById.get(ev.calendarId) ?? '#64748B'}
                    compact
                    onSelect={onSelectEvent}
                  />
                ))}
                {dayEvents.length > 3 ? (
                  <div className="text-[10px] text-foreground-subtle">
                    {t('common.moreCount', { count: dayEvents.length - 3 })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WeekGrid({
  anchor,
  events,
  colorById,
  today,
  onSelectEvent,
}: {
  readonly anchor: Date
  readonly events: readonly CalendarEvent[]
  readonly colorById: ReadonlyMap<string, string>
  readonly today: Date
  readonly onSelectEvent: (ev: CalendarEvent) => void
}) {
  const start = startOfWeek(anchor)
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))

  return (
    <div
      className="grid grid-cols-1 gap-2 sm:grid-cols-7 sm:gap-px sm:overflow-hidden sm:rounded-lg sm:border sm:border-border sm:bg-border"
      data-testid="calendars-week"
    >
      {days.map((day) => {
        const dayStart = startOfDay(day).getTime()
        const dayEvents = eventsOnDay(events, dayStart)
        const isToday = isSameDay(day, today)
        return (
          <div key={dayStart} className="min-h-[8rem] bg-background p-2 sm:min-h-[12rem]">
            <div
              className={
                isToday
                  ? 'mb-2 text-xs font-semibold text-primary'
                  : 'mb-2 text-xs font-medium text-foreground-subtle'
              }
            >
              {day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
            </div>
            <div className="space-y-1">
              {dayEvents.length === 0 ? (
                <p className="text-[11px] text-foreground-subtle">—</p>
              ) : (
                dayEvents.map((ev) => (
                  <EventChip
                    key={ev.id}
                    ev={ev}
                    color={colorById.get(ev.calendarId) ?? '#64748B'}
                    onSelect={onSelectEvent}
                  />
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DayList({
  anchor,
  events,
  colorById,
  calName,
  onSelectEvent,
}: {
  readonly anchor: Date
  readonly events: readonly CalendarEvent[]
  readonly colorById: ReadonlyMap<string, string>
  readonly calName: ReadonlyMap<string, string>
  readonly onSelectEvent: (ev: CalendarEvent) => void
}) {
  const { t } = useTranslation()
  const dayStart = startOfDay(anchor).getTime()
  const dayEvents = eventsOnDay(events, dayStart)

  if (dayEvents.length === 0) {
    return (
      <p className="text-sm text-foreground-subtle" data-testid="calendars-day-empty">
        {t('systemPage.calendars.noEventsOnThisDay', 'No events on this day.')}
      </p>
    )
  }

  return (
    <ul
      className="divide-y divide-border rounded-lg border border-border"
      data-testid="calendars-day"
    >
      {dayEvents.map((ev) => (
        <li key={ev.id}>
          <button
            type="button"
            className="flex w-full items-start gap-3 px-3 py-3 text-left hover:bg-surface"
            onClick={() => onSelectEvent(ev)}
            data-testid={`calendars-event-${ev.id}`}
          >
            <span
              className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colorById.get(ev.calendarId) ?? '#64748B' }}
            />
            <div className="min-w-0">
              <div className="font-medium text-sm text-foreground">{ev.title}</div>
              <div className="text-xs text-foreground-subtle">
                {formatEventTime(ev)} · {calName.get(ev.calendarId) ?? ev.calendarId}
              </div>
              {ev.location !== undefined && ev.location.length > 0 ? (
                <div className="mt-0.5 text-xs text-foreground-subtle">{ev.location}</div>
              ) : null}
            </div>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function CalendarsPage() {
  const { t } = useTranslation()
  const calendarsQuery = useCalendarsListCalendars()
  const prefsQuery = useCalendarsGetPreferences({})
  const setPref = useCalendarsSetCalendarPreference()

  const [mode, setMode] = useState<ViewMode>('month')
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()))
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null)
  const today = useMemo(() => startOfDay(new Date()), [])

  const calendarsAnswered = calendarsQuery.isSuccess
  const prefs = prefsQuery.isSuccess && prefsQuery.data !== undefined ? prefsQuery.data : undefined

  const calendars = useMemo((): readonly CalendarEntry[] => {
    if (!calendarsAnswered || calendarsQuery.data === undefined) return []
    return calendarsQuery.data.map((cal) => mergeCalendar(cal, prefs))
  }, [calendarsAnswered, calendarsQuery.data, prefs])

  // Visibility is the operator's choice; `enabled` is only a source-health
  // badge (HA `unavailable`). An unavailable calendar stays selectable so the
  // legend is never frozen, and we still ask for events — the source no-ops.
  const visibleCalendars = useMemo(() => calendars.filter((c) => c.visible), [calendars])
  const visibleIds = useMemo(() => visibleCalendars.map((c) => c.id), [visibleCalendars])

  const window = useMemo(() => visibleWindow(anchor, mode), [anchor, mode])

  const eventsQuery = useCalendarsListEvents(
    {
      startMs: window.startMs,
      endMs: window.endMs,
      calendarIds: [...visibleIds],
    },
    { enabled: calendarsAnswered && visibleIds.length > 0 },
  )

  const events = eventsQuery.data ?? []
  const colorById = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of calendars) map.set(c.id, c.color)
    return map
  }, [calendars])
  const calName = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of calendars) map.set(c.id, c.name)
    return map
  }, [calendars])

  const onToggleVisible = useCallback(
    (calendarId: string, visible: boolean) => {
      void setPref.mutateAsync({ calendarId, visible }).then(() => prefsQuery.refetch())
    },
    [prefsQuery, setPref],
  )

  const onColorChange = useCallback(
    (calendarId: string, color: string) => {
      if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return
      void setPref.mutateAsync({ calendarId, color }).then(() => prefsQuery.refetch())
    },
    [prefsQuery, setPref],
  )

  const goToday = useCallback(() => setAnchor(startOfDay(new Date())), [])
  const goPrev = useCallback(() => setAnchor((a) => shiftAnchor(a, mode, -1)), [mode])
  const goNext = useCallback(() => setAnchor((a) => shiftAnchor(a, mode, 1)), [mode])

  const navButtonClass =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-foreground hover:bg-primary/5 disabled:opacity-50'
  const todayButtonClass =
    'inline-flex items-center rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-primary/5'

  let body: ReactNode
  if (calendarsQuery.isPending) {
    body = (
      <p className="text-sm text-foreground-subtle">
        {t('systemPage.calendars.loadingCalendars', 'Loading calendars…')}
      </p>
    )
  } else if (calendarsQuery.isError) {
    body = (
      <p className="text-sm text-destructive">
        {t('systemPage.calendars.couldNotListCalendars', 'Could not list calendars:')}{' '}
        {calendarsQuery.error.message}
      </p>
    )
  } else if (calendars.length === 0) {
    body = (
      <p className="text-sm text-foreground-subtle" data-testid="calendars-empty-sources">
        <Trans
          i18nKey="systemPage.calendars.emptySources"
          components={{
            link: (
              <Link
                to="/system/integrations?tab=calendars"
                className="text-accent underline-offset-2 hover:underline"
              />
            ),
          }}
        />
      </p>
    )
  } else if (visibleIds.length === 0) {
    body = (
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <CalendarLegend
          calendars={calendars}
          onToggleVisible={onToggleVisible}
          onColorChange={onColorChange}
          busy={setPref.isPending}
        />
        <p className="text-sm text-foreground-subtle" data-testid="calendars-empty-hidden">
          {t(
            'systemPage.calendars.allCalendarsAreHiddenTurn',
            'All calendars are hidden. Turn one on in the legend to see events.',
          )}
        </p>
      </div>
    )
  } else {
    body = (
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <CalendarLegend
          calendars={calendars}
          onToggleVisible={onToggleVisible}
          onColorChange={onColorChange}
          busy={setPref.isPending}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ViewToggle mode={mode} onChange={setMode} />
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={navButtonClass}
                onClick={goPrev}
                aria-label={t('systemPage.calendars.previous', 'Previous')}
                data-testid="calendars-prev"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                className={todayButtonClass}
                onClick={goToday}
                data-testid="calendars-today"
              >
                {t('systemPage.calendars.today', 'Today')}
              </button>
              <button
                type="button"
                className={navButtonClass}
                onClick={goNext}
                aria-label={t('common.next', 'Next')}
                data-testid="calendars-next"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            <span className="text-sm font-medium text-foreground" data-testid="calendars-period">
              {periodLabel(anchor, mode)}
            </span>
          </div>

          {eventsQuery.isPending ? (
            <p className="text-sm text-foreground-subtle">
              {t('systemPage.calendars.loadingEvents', 'Loading events…')}
            </p>
          ) : eventsQuery.isError ? (
            <p className="text-sm text-destructive">
              {t('systemPage.calendars.couldNotListEvents', 'Could not list events:')}{' '}
              {eventsQuery.error.message}
            </p>
          ) : mode === 'month' ? (
            <MonthGrid
              anchor={anchor}
              events={events}
              colorById={colorById}
              today={today}
              onSelectEvent={setSelectedEvent}
            />
          ) : mode === 'week' ? (
            <WeekGrid
              anchor={anchor}
              events={events}
              colorById={colorById}
              today={today}
              onSelectEvent={setSelectedEvent}
            />
          ) : (
            <DayList
              anchor={anchor}
              events={events}
              colorById={colorById}
              calName={calName}
              onSelectEvent={setSelectedEvent}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <AdminPage
      icon={CalendarIcon}
      title={t('systemPage.calendars.calendars', 'Calendars')}
      subtitle={t(
        'systemPage.calendars.calendarsFromConnectedSourcesUsed',
        'Calendars from connected sources. Used by Calendar events notification rules.',
      )}
    >
      {body}
      {selectedEvent !== null ? (
        <EventDetailDialog
          ev={selectedEvent}
          calendarName={calName.get(selectedEvent.calendarId) ?? selectedEvent.calendarId}
          color={colorById.get(selectedEvent.calendarId) ?? '#64748B'}
          onClose={() => setSelectedEvent(null)}
        />
      ) : null}
    </AdminPage>
  )
}

export default CalendarsPage
