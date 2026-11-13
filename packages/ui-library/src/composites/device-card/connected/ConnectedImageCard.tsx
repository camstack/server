import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { ImageCard } from '../scenes/image/ImageCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'

/** A still image (`image`): its url and when it last changed. */
export function ConnectedImageCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const status = useDeviceStateSlice(dev?.image === undefined ? undefined : dev.state.image)
  if (status === undefined) return null
  return (
    <ImageCard
      orientation={orientation}
      showName={showName}
      actions={card.actions}
      model={{
        common: card.common,
        url: status.url,
        updated: sinceText(status.lastUpdated, Date.now(), t) ?? null,
      }}
    />
  )
}
