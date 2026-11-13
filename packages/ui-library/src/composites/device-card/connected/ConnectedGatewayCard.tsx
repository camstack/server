import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceManagerGetDevice, useRebootReboot } from '../../../generated/system-hooks'
import { useDeviceAdminLink } from '../../device-item/admin-link-quick-action'
import { GatewayCard, type GatewayFacts } from '../scenes/gateway/GatewayCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'

const fact = (metadata: Readonly<Record<string, unknown>> | null | undefined, key: string) => {
  const value = metadata?.[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** The facts a gateway writes into its device metadata (`firmware`, `ip`, `model`). */
export function gatewayFactsOf(
  metadata: Readonly<Record<string, unknown>> | null | undefined,
): GatewayFacts {
  return {
    model: fact(metadata, 'model'),
    firmware: fact(metadata, 'firmware'),
    address: fact(metadata, 'ip'),
  }
}

/**
 * A gateway: its reachability (`device-status`), the facts it writes into its
 * metadata, `reboot` and `device-admin-link` when it binds them. How many
 * products sit behind it is not reported by any cap, so it is not drawn.
 */
export function ConnectedGatewayCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const client = useTrpcClient()
  const card = useCardCommon({ deviceId, canActuate })
  const device = useDeviceManagerGetDevice({ deviceId })
  const adminLink = useDeviceAdminLink(client, deviceId)
  const reboot = useRebootReboot()
  if (device.data === undefined || device.data === null) return null
  return (
    <GatewayCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        facts: gatewayFactsOf(device.data.metadata),
        rebootable: card.implements('reboot', 'reboot'),
        adminLink: adminLink === null ? null : { url: adminLink.url, label: adminLink.label },
      }}
      actions={{
        ...card.actions,
        onReboot: () =>
          reboot.mutate({ deviceId }, { onSuccess: card.succeed, onError: card.fail }),
      }}
    />
  )
}
