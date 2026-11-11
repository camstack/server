import type { ReactElement } from 'react'

export interface CardEvent {
  readonly id: string
  /** Day heading the event is grouped under ("Today"). */
  readonly day: string
  /** Who or what did it: the initial shown in the avatar. */
  readonly actor: string
  readonly text: string
  readonly detail?: string
  readonly time: string
}

export interface EventListProps {
  readonly events: readonly CardEvent[]
  readonly emptyLabel: string
}

/** Interactions of a device, grouped by day. */
export function EventList({ events, emptyLabel }: EventListProps): ReactElement {
  if (events.length === 0) {
    return <p className="py-4 text-center text-xs text-foreground-muted">{emptyLabel}</p>
  }
  const days = [...new Set(events.map((e) => e.day))]
  return (
    <div className="flex flex-col gap-3">
      {days.map((day) => (
        <section key={day} className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">
            {day}
          </h4>
          {events
            .filter((e) => e.day === day)
            .map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-sm">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-hover text-xs font-semibold text-foreground-muted">
                  {e.actor.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {e.text}
                  {e.detail === undefined ? null : (
                    <small className="ml-1 text-foreground-muted">{e.detail}</small>
                  )}
                </span>
                <span className="text-xs tabular-nums text-foreground-muted">{e.time}</span>
              </div>
            ))}
        </section>
      ))}
    </div>
  )
}
