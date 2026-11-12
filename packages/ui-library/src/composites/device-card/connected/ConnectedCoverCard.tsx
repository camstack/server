import { DeviceFeature } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { CoverCard } from '../scenes/cover/CoverCard'
import { coverRoleSpec } from '../scenes/cover/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'
import { reportedCall } from './use-command-notice'

/**
 * The cover card of a real device, drawn as its role (D1033). It takes a
 * position when the device declares one and binds `setPosition`; the slats
 * when it declares a tilt and binds `setTiltPosition`.
 */
export function ConnectedCoverCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(dev?.cover === undefined ? undefined : dev.state.cover)
  const cap = dev?.cover
  if (cap === undefined || slice === undefined) return null
  const send = reportedCall(card)
  const has = (feature: DeviceFeature): boolean => card.features.includes(feature)
  const setPosition = cap.setPosition
  const setTilt = cap.setTiltPosition
  const stop = cap.stop
  const position = slice?.position ?? null
  const tilt = slice?.tiltPosition ?? null
  return (
    <CoverCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        spec: coverRoleSpec(card.role),
        position,
        state: slice?.state ?? null,
        positionable:
          setPosition !== undefined && (has(DeviceFeature.CoverPositionable) || position !== null),
        stoppable: stop !== undefined,
        tilt: setTilt !== undefined && has(DeviceFeature.CoverTilt) ? (tilt ?? 0) : null,
        since: sinceText(slice.lastChangedAt, Date.now(), t) ?? null,
      }}
      actions={{
        ...card.actions,
        onOpen: () => send(() => cap.open({})),
        onClose: () => send(() => cap.close({})),
        onStop: () => send(() => stop?.({})),
        onPosition: (next) => send(() => setPosition?.({ position: next })),
        onTilt: (next) => send(() => setTilt?.({ tiltPosition: next })),
      }}
    />
  )
}
