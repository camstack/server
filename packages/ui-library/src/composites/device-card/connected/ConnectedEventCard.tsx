import {
  type EventEmitterStatus,
  type EventVocabularyCarrier,
  findVocabularyEntry,
  readEventVocabulary,
} from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { type UiTextFn, useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import type { EventCardEntry, EventCardModel } from '../scenes/event/EventCard'
import { EventCard } from '../scenes/event/EventCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'

/**
 * A slice as a card may meet it. `vocabulary` is absent on a status written
 * before the field existed; `readEventVocabulary` then answers with the tokens.
 */
export interface EventCardStatus extends EventVocabularyCarrier {
  readonly lastEvent: EventEmitterStatus['lastEvent']
}

/**
 * The vocabulary as the card lists it: each declared event, including the
 * part of the device it comes from. A token alone is not an identity.
 */
export function eventEntriesOf(status: EventCardStatus): readonly EventCardEntry[] {
  return readEventVocabulary(status).map((entry) => ({
    id: entry.id,
    label: entry.label,
    ...(entry.source === undefined
      ? {}
      : { source: { id: entry.source.id, label: entry.source.label } }),
  }))
}

export function eventLastOf(
  status: EventCardStatus,
  now: number,
  t: UiTextFn,
): EventCardModel['last'] {
  const fired = status.lastEvent
  if (fired === null) return null
  const entry = findVocabularyEntry(readEventVocabulary(status), fired.eventType, fired.sourceId)
  return {
    id: fired.eventType,
    ...(fired.sourceId === undefined ? {} : { sourceId: fired.sourceId }),
    label: entry?.label ?? fired.eventType,
    since: sinceText(fired.timestamp, now, t) ?? null,
  }
}

/**
 * An event source (`event-emitter`). The status keeps only the LAST event, so
 * the card does not claim when the other entries last fired.
 */
export function ConnectedEventCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const status = useDeviceStateSlice(
    dev?.eventEmitter === undefined ? undefined : dev.state.eventEmitter,
  )
  if (status === undefined) return null
  return (
    <EventCard
      orientation={orientation}
      showName={showName}
      actions={card.actions}
      model={{
        common: card.common,
        last: eventLastOf(status, Date.now(), t),
        entries: eventEntriesOf(status),
      }}
    />
  )
}
