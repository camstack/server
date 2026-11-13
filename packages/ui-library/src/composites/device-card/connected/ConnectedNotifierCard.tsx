import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { NotifierCard } from '../scenes/notifier/NotifierCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'

/** A notification destination (`notifier`); the test goes through `send`. */
export function ConnectedNotifierCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const status = useDeviceStateSlice(dev?.notifier === undefined ? undefined : dev.state.notifier)
  const cap = dev?.notifier
  if (cap === undefined || status === undefined) return null
  return (
    <NotifierCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        lastSent: sinceText(status.lastSentAt, Date.now(), t) ?? null,
        lastError: status.lastError,
        queued: status.queueDepth,
        testable: card.implements('notifier', 'send'),
      }}
      actions={{
        ...card.actions,
        onTest: () => {
          Promise.resolve(
            cap.send({
              title: 'CamStack', // i18n-ignore: the product name, sent as the notification title
              body: t('uiLibrary.deviceCard.notifier.testBody', 'Test notification from CamStack.'),
            }),
          ).then(card.succeed, card.fail)
        },
      }}
    />
  )
}
