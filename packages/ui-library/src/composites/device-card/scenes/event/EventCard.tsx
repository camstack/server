import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { CardIcon } from '../../parts/CardIcon'
import { InfoTile } from '../../parts/InfoTile'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'
import {
  eventEntryKey,
  eventEntryText,
  eventLastText,
  eventSourcesMany,
  groupEventEntries,
  sameEvent,
} from './event-entries'

/** The part of the device an event comes from: a button, a channel. */
export interface EventCardSource {
  readonly id: string
  readonly label: string
}

export interface EventCardEntry {
  /** The native token, verbatim. Shared by every part of the device. */
  readonly id: string
  readonly label: string
  readonly source?: EventCardSource
}

export interface EventCardModel {
  readonly common: CardCommon
  /** The last event fired, labelled from the vocabulary; null before the first. */
  readonly last: {
    readonly id: string
    /** The part that fired, when the fire names one. Matches `entries[].source.id`. */
    readonly sourceId?: string
    readonly label: string
    readonly since: string | null
  } | null
  /** The device's declared vocabulary, in its order. */
  readonly entries: readonly EventCardEntry[]
}

export interface EventCardProps {
  readonly model: EventCardModel
  readonly actions?: CardCommonActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

/** At most this many entries of the vocabulary are listed. */
export const EVENT_CARD_ENTRIES = 6

interface EventEntryRowsProps {
  readonly entries: readonly EventCardEntry[]
  readonly last: EventCardModel['last']
  readonly grouped: boolean
  readonly t: UiTextFn
}

interface EventVocabularyListProps {
  readonly model: EventCardModel
  readonly t: UiTextFn
}

function EventEntryRows({ entries, last, grouped, t }: EventEntryRowsProps): ReactElement {
  return (
    <>
      {entries.map((entry) => {
        const key = eventEntryKey(entry)
        const fired = last !== null && sameEvent(last, entry)
        return (
          <div key={key} data-testid="dc-event-row" data-event-key={key}>
            <InfoTile
              layout="row"
              glyph={fired ? 'event' : undefined}
              label={eventEntryText(entry, grouped, t)}
              value={fired && last !== null ? (last.since ?? '') : ''}
              tone={fired ? 'warning' : 'default'}
              testId={fired ? 'dc-event-last' : undefined}
            />
          </div>
        )
      })}
    </>
  )
}

/** The declared events, at most {@link EVENT_CARD_ENTRIES}, grouped when several parts declare them. */
function EventVocabularyList({ model, t }: EventVocabularyListProps): ReactElement | null {
  const listed = model.entries.slice(0, EVENT_CARD_ENTRIES)
  if (listed.length === 0) return null
  const grouped = eventSourcesMany(listed)
  const groups = groupEventEntries(listed)
  return (
    <div className="grid w-full gap-2" data-testid="dc-event-list">
      {groups.map((group) => (
        <div
          key={group.source?.id ?? ''}
          className="grid gap-1"
          data-testid={grouped ? 'dc-event-group' : undefined}
        >
          {grouped && group.source !== null ? (
            <p className="text-xs font-semibold text-foreground-muted">{group.source.label}</p>
          ) : null}
          <EventEntryRows entries={group.entries} last={model.last} grouped={grouped} t={t} />
        </div>
      ))}
    </div>
  )
}

/**
 * An event source (`event-emitter`): the last event it fired, and the events
 * it can fire — its own vocabulary, never a normalised one. It commands nothing.
 * Two parts that share a token are listed apart, under the part that fires each.
 */
export function EventCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: EventCardProps): ReactElement {
  const t = useUiText()
  const headline =
    model.last === null
      ? t('uiLibrary.deviceCard.event.none', 'No event yet')
      : eventLastText(model.last, model.entries, t)
  return (
    <DeviceCard
      kind="event"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.last === null ? 'idle' : 'fired'}
      state={{
        label: headline,
        since: model.last?.since ?? null,
        tone: model.last === null ? 'muted' : 'primary',
      }}
      scene={{
        image: <CardIcon glyph="event" className="h-20 w-20 text-foreground-muted" />,
        bottom: <EventVocabularyList model={model} t={t} />,
      }}
    />
  )
}
