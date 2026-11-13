import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { CardIcon } from '../../parts/CardIcon'
import { InfoTile } from '../../parts/InfoTile'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardCommon, CardCommonActions, CardOrientation } from '../../shell/model'

export interface EventCardEntry {
  /** The native token, verbatim. */
  readonly id: string
  readonly label: string
}

export interface EventCardModel {
  readonly common: CardCommon
  /** The last event fired, labelled from the vocabulary; null before the first. */
  readonly last: {
    readonly id: string
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

/**
 * An event source (`event-emitter`): the last event it fired, and the events
 * it can fire — its own vocabulary, never a normalised one. It commands nothing.
 */
export function EventCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: EventCardProps): ReactElement {
  const t = useUiText()
  const listed = model.entries.slice(0, EVENT_CARD_ENTRIES)
  return (
    <DeviceCard
      kind="event"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.last === null ? 'idle' : 'fired'}
      state={{
        label: model.last?.label ?? t('uiLibrary.deviceCard.event.none', 'No event yet'),
        since: model.last?.since ?? null,
        tone: model.last === null ? 'muted' : 'primary',
      }}
      scene={{
        image: <CardIcon glyph="event" className="h-20 w-20 text-foreground-muted" />,
        bottom:
          listed.length === 0 ? null : (
            <div className="grid w-full gap-1" data-testid="dc-event-list">
              {listed.map((entry) => {
                const last = model.last?.id === entry.id
                return (
                  <InfoTile
                    key={entry.id}
                    layout="row"
                    glyph={last ? 'event' : undefined}
                    label={entry.label}
                    value={last ? (model.last?.since ?? '') : ''}
                    tone={last ? 'warning' : 'default'}
                    testId={last ? 'dc-event-last' : undefined}
                  />
                )
              })}
            </div>
          ),
      }}
    />
  )
}
