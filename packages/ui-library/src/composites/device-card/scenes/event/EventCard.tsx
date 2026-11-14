import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardIcon } from '../../parts/CardIcon'
import { type BottomRow, rowList } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
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

/** The declared events, at most {@link EVENT_CARD_ENTRIES}, grouped when several parts declare them. */
function vocabularyRow(model: EventCardModel, t: UiTextFn): BottomRow {
  const listed = model.entries.slice(0, EVENT_CARD_ENTRIES)
  const grouped = eventSourcesMany(listed)
  return rowList('vocabulary', {
    testId: 'dc-event-list',
    groups: groupEventEntries(listed).map((group) => ({
      id: group.source?.id ?? '',
      title: grouped && group.source !== null ? group.source.label : undefined,
      testId: grouped ? 'dc-event-group' : undefined,
      items: group.entries.map((entry) => {
        const key = eventEntryKey(entry)
        const fired = model.last !== null && sameEvent(model.last, entry)
        return {
          id: key,
          dataKey: key,
          rowTestId: 'dc-event-row',
          glyph: fired ? ('event' as const) : undefined,
          label: eventEntryText(entry, grouped, t),
          value: fired && model.last !== null ? (model.last.since ?? '') : '',
          tone: fired ? ('warning' as const) : ('default' as const),
          testId: fired ? 'dc-event-last' : undefined,
        }
      }),
    })),
  })
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
        columns: {},
        image: <CardIcon glyph="event" className={cn(SCENE_ICON_CLASS, 'text-foreground-muted')} />,
        bottom: model.entries.length === 0 ? [] : [vocabularyRow(model, t)],
      }}
    />
  )
}
