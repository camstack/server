import { deriveWorkloadControls, type WorkloadAction } from '@camstack/types'
import type { ReactElement } from 'react'
import { useDeviceQuickDetailOpen } from '../../../contexts/device-quick-detail'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceManagerGetDevice, useWorkloadGetOptions } from '../../../generated/system-hooks'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import { workloadRoleOf } from '../scenes/workload/model'
import { WorkloadCard } from '../scenes/workload/WorkloadCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * A workload (`workload` cap): the state slice, the controls `getOptions`
 * declares through `deriveWorkloadControls`, and the host it runs on. Until
 * `getOptions` answers no control is drawn — an undeclared action never has
 * a button.
 */
export function ConnectedWorkloadCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(dev?.workload === undefined ? undefined : dev.state.workload)
  const display = slice
  const runCommand = useDeviceCommand()
  const options = useWorkloadGetOptions({ deviceId })
  const hostId = display?.hostDeviceId ?? null
  const hostDevice = useDeviceManagerGetDevice(
    { deviceId: hostId ?? 0 },
    { enabled: hostId !== null },
  )
  const openDevice = useDeviceQuickDetailOpen()
  const cap = dev?.workload
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(runCommand, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const derived =
    options.data === undefined || options.data === null
      ? null
      : deriveWorkloadControls(options.data, display.state)
  const run = (action: WorkloadAction): PromiseLike<unknown> => {
    switch (action) {
      case 'start':
        return cap.start({})
      case 'stop':
        return cap.stop({})
      case 'restart':
        return cap.restart({})
      case 'pause':
        return cap.pause({})
      case 'resume':
        return cap.resume({})
      case 'forceStop':
        return cap.forceStop({})
    }
  }
  const onAction = (action: WorkloadAction): void => {
    send(() => run(action))
  }
  return (
    <WorkloadCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        role: workloadRoleOf(card.role),
        state: display.state,
        since: sinceText(display.since, Date.now(), t) ?? null,
        controls: derived?.controls ?? [],
        sections: derived?.sections ?? {
          resources: false,
          ports: false,
          addresses: false,
          autostart: false,
          update: false,
        },
        resources: display.resources,
        image: display.image,
        os: display.os,
        version: display.version,
        autostart: display.autostart,
        ports: display.ports,
        addresses: display.addresses,
        updateAvailable: display.updateAvailable,
        host: hostId === null ? null : { deviceId: hostId, name: hostDevice.data?.name ?? null },
      }}
      actions={{
        ...card.actions,
        onAction,
        ...(openDevice === null ? {} : { onOpenDevice: openDevice }),
      }}
    />
  )
}
